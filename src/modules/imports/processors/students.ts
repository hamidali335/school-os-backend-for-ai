import { nextNumber, reserveNumbers } from '../../../database/counter.model';
import { atomic } from '../../../database/transactions';
import type { SchoolContext } from '../../../types/context';
import { formatDateOnly, todayInTz } from '../../../utils/dates';
import { oid, scope } from '../../../utils/tenant';
import { School } from '../../schools/school.model';
import { StudentBody } from '../../students/student.schemas';
import { Parent, Student } from '../../students/student.models';
import { recordChanges, type RecordChangeItem } from '../../sync/sync.service';
import {
  admissionAccountSettings,
  createStudent,
  placementKey,
  placementSection,
  placementSections,
  LIMIT_GUARD_MARGIN,
  SaveAlone,
  SavingInLanes,
  updateStudent,
  type AdmissionPrefetch,
  type GuardianInput,
  type PlacedSection,
  type StudentInput,
} from '../../students/students.service';
import { getSchoolLimits } from '../../subscriptions/limits.service';
import { normalisePhoneUsername } from '../../users/users.service';
import { fieldLabel } from '../import-fields';
import { KeyedLocks } from '../import-lanes';
import {
  nameKey,
  numberKey,
  parseBirthDate,
  parseCnic,
  parseDate,
  parseEmail,
  parseGender,
  parsePhone,
  parseRelation,
  parseStudentStatus,
  parseText,
  phoneKey,
} from '../import-values';
import { SchoolRefs } from './school-refs';
import {
  RowReader,
  show,
  splitName,
  type ApplyResult,
  type Change,
  type ImportOptions,
  type Processor,
  type RowIn,
  type RowPlan,
  type RunHelper,
  breathe,
} from './types';

type Payload = StudentInput & { status?: 'active' | 'left' | 'graduated' | 'suspended' };

/** Fields that "Add and update" may change on an existing student (never class, section or parents). */
const UPDATABLE = [
  'firstName',
  'lastName',
  'gender',
  'dateOfBirth',
  'rollNo',
  'bFormNo',
  'bloodGroup',
  'address',
  'phone',
  'previousSchool',
] as const;

const label = (f: string) => fieldLabel('students', f);

type ParentRef = { _id: unknown; name: string; phone: string; cnic?: string | null };
type ExistingStudent = {
  _id: unknown;
  admissionNo: string;
  firstName: string;
  lastName?: string | null;
  dateOfBirth?: Date | null;
  campusId: unknown;
  classId: unknown;
  sectionId: unknown;
  guardians: Array<{ parentId: unknown }>;
  [k: string]: unknown;
};

/**
 * Students import: each row is one admission through createStudent(), so placement checks,
 * plan limits and parent logins follow exactly the same rules as the admission form, and each
 * row is checked with the form's own schema (StudentBody). No messages are sent.
 *
 * Identity rules (nothing is merged on an uncertain match):
 * - A parent is recognised by phone number in any common format (03…, +92…, 92…, with dashes):
 *   the existing record is reused, so one parent keeps one login. If several parents in the
 *   system share the number, the row is refused for review unless exactly one has the same name.
 * - A student is "already in the system" when the admission number is the same. A row is a
 *   "likely duplicate" (skipped unless the user chooses to import anyway) when an existing
 *   student has the same name and the same date of birth or a parent with the same phone, or the
 *   same admission number apart from leading zeros (00123 / 123). Leading-zero matches with a
 *   different name are refused for review.
 */
export const studentsProcessor: Processor<Payload> = {
  async plan(ctx, rows, options) {
    const refs = await SchoolRefs.load(ctx);
    const warnings = refs.defaultsProblems(
      options,
      rows.some((r) => r.cells.campusName),
    );
    const school = await School.findById(ctx.schoolId).select('settings.timezone').lean();
    const today = todayInTz(school?.settings?.timezone ?? 'Asia/Karachi');
    const canSeeParents = ctx.permissions.has('parents:read');

    // The school's students and parents (small projections), so identity checks do not depend
    // on how numbers, names or phones happen to be written.
    const [students, parents] = await Promise.all([
      Student.find(scope(ctx))
        .select(
          'admissionNo firstName lastName gender dateOfBirth rollNo bFormNo bloodGroup address phone previousSchool classId sectionId campusId status guardians',
        )
        .lean() as unknown as Promise<ExistingStudent[]>,
      Parent.find(scope(ctx)).select('name phone cnic').lean() as unknown as Promise<ParentRef[]>,
    ]);
    const byAdmission = new Map(students.map((s) => [s.admissionNo.toLowerCase(), s]));
    const byNumber = new Map<string, ExistingStudent[]>();
    const byName = new Map<string, ExistingStudent[]>();
    for (const s of students) {
      const nk = numberKey(s.admissionNo);
      if (nk) byNumber.set(nk, [...(byNumber.get(nk) ?? []), s]);
      const k = nameKey(`${s.firstName} ${s.lastName ?? ''}`);
      byName.set(k, [...(byName.get(k) ?? []), s]);
    }
    const parentsByPhone = new Map<string, ParentRef[]>();
    for (const p of parents) {
      const k = phoneKey(p.phone);
      parentsByPhone.set(k, [...(parentsByPhone.get(k) ?? []), p]);
    }
    const parentPhoneKey = new Map(parents.map((p) => [String(p._id), phoneKey(p.phone)]));
    const parentByCnic = new Map(parents.filter((p) => p.cnic).map((p) => [p.cnic!, p]));
    const visibleCampus = (campusId: unknown) => !ctx.campusIds.length || ctx.campusIds.includes(String(campusId));

    const [limits, activeNow] = await Promise.all([
      getSchoolLimits(ctx.schoolId),
      Student.countDocuments(scope(ctx, { status: 'active' })),
    ]);
    const enrolled = new Map<string, number>();
    for (const s of await Student.aggregate([
      { $match: { schoolId: oid(ctx.schoolId), status: 'active' } },
      { $group: { _id: '$sectionId', n: { $sum: 1 } } },
    ]))
      enrolled.set(String(s._id), s.n);

    const seenAdmission = new Map<string, number>();
    /** New parents in this file, by phone key: the first spelling of the number is used for all rows. */
    const newParents = new Map<string, { name: string; phone: string; rowNo: number }>();
    const seenCnic = new Map<string, string>();
    const seenPerson = new Map<string, number>();
    let newActive = 0;
    const out: RowPlan<Payload>[] = [];

    /** Resolve a parent by phone: an existing record (reused), a new one, or a conflict for review. */
    const resolveParent = (r: RowReader, field: 'parentPhone' | 'motherPhone', name: string, phone: string) => {
      const key = phoneKey(phone);
      const candidates = parentsByPhone.get(key) ?? [];
      if (candidates.length) {
        const sameName = candidates.filter((p) => nameKey(p.name) === nameKey(name));
        const chosen = candidates.length === 1 ? candidates[0] : sameName.length === 1 ? sameName[0] : null;
        if (!chosen) {
          r.error(
            field,
            `${candidates.length} parents in the system have this phone number; add this student by hand and choose the right parent`,
          );
          return null;
        }
        if (nameKey(chosen.name) !== nameKey(name))
          r.warn(
            field,
            canSeeParents
              ? `this number belongs to ${chosen.name} in the system; the student is linked to that parent (the file says "${name}")`
              : `this number belongs to a parent already in the system under a different name; the student is linked to that parent`,
          );
        else
          r.info(
            field,
            canSeeParents
              ? `linked to the parent already in the system, ${chosen.name}`
              : 'linked to a parent already in the system',
          );
        return { existingId: String(chosen._id), key, login: normalisePhoneUsername(chosen.phone) };
      }
      const prev = newParents.get(key);
      if (prev) {
        if (nameKey(prev.name) !== nameKey(name))
          r.warn(
            field,
            `row ${prev.rowNo} has the same number with the name "${prev.name}"; both students are linked to one parent record`,
          );
        return { newPhone: prev.phone, key, login: normalisePhoneUsername(prev.phone) };
      }
      newParents.set(key, { name, phone, rowNo: r.rowNo });
      return { newPhone: phone, key, login: normalisePhoneUsername(phone) };
    };

    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      // Name
      let firstName: string | undefined;
      let lastName: string | undefined;
      if (r.has('fullName')) {
        const full = r.opt('fullName', (v) => parseText(v, 120));
        if (full) ({ firstName, lastName } = splitName(full));
      } else {
        firstName = r.req('firstName', (v) => parseText(v, 60), 'Student Name is required');
        lastName = r.opt('lastName', (v) => parseText(v, 60));
      }
      const gender = r.req('gender', parseGender);
      const dateOfBirth = r.opt('dateOfBirth', (v) => parseBirthDate(v, today));
      const admissionDate = r.opt('admissionDate', parseDate);
      const status = r.opt('status', parseStudentStatus) ?? 'active';
      const admissionNo = r.opt('admissionNo', (v) => parseText(v, 30)) ?? row.assignedKey;
      const rollNo = r.opt('rollNo', (v) => parseText(v, 20));
      const bFormNo = r.opt('bFormNo', (v) => parseText(v, 20));
      const bloodGroup = r.opt('bloodGroup', (v) => parseText(v, 5));
      const address = r.opt('address', (v) => parseText(v, 300));
      const phone = r.opt('studentPhone', parsePhone);
      const previousSchool = r.opt('previousSchool', (v) => parseText(v, 120));

      // Placement
      const campus = refs.campus(r, 'campusName', options);
      if (!campus && !r.has('campusName')) r.error(undefined, 'Choose the campus for this import');
      const session = refs.session(r, 'sessionName', options);
      const className = r.req('className', (v) => parseText(v, 40));
      let classId: string | undefined;
      let sectionId: string | undefined;
      if (campus && className) {
        const cls = refs.findClass(campus.id, className);
        if (!cls) {
          const names = refs.classNamesIn(campus.id);
          r.error(
            'className',
            `"${className}" does not exist in ${campus.name}. Create it in Academics → Classes, or import Classes and sections first${names.length ? ` (existing: ${names.slice(0, 12).join(', ')})` : ''}`,
          );
        } else classId = cls.id;
      }
      if (classId && session) {
        const sections = refs.sectionsOf(classId, session.id);
        const wanted = r.raw('sectionName') || options.sectionName || '';
        if (wanted) {
          const sec = sections.find((s) => nameKey(s.name) === nameKey(wanted));
          if (!sec)
            r.error(
              r.has('sectionName') ? 'sectionName' : undefined,
              `Section "${wanted}" does not exist for ${className} in ${session.name}${sections.length ? ` (sections: ${sections.map((s) => s.name).join(', ')})` : '. Create it in Academics → Sections'}`,
            );
          else sectionId = sec.id;
        } else if (sections.length === 1) {
          sectionId = sections[0].id;
          r.info('sectionName', `none given; using the only section, ${sections[0].name}`);
        } else
          r.error(
            'sectionName',
            sections.length
              ? `is required: ${className} has sections ${sections.map((s) => s.name).join(', ')}`
              : `${className} has no sections in ${session.name}. Create one in Academics → Sections`,
          );
      }

      // Parents
      const guardians: GuardianInput[] = [];
      const parentKeys = new Set<string>();
      /** Parent records and logins this row may create or link (see RowPlan.groupKeys). */
      const groupKeys: string[] = [];
      const touches = (resolved: { key: string; login: string }) =>
        groupKeys.push(`phone:${resolved.key}`, `login:${resolved.login}`);
      const pName = r.opt('parentName', (v) => parseText(v, 100, 2));
      const pPhone = r.opt('parentPhone', parsePhone);
      if (r.has('parentName') !== r.has('parentPhone')) {
        if (!r.has('parentPhone')) r.error('parentPhone', 'is required when a parent name is given');
        else r.error('parentName', 'is required when a parent phone is given');
      }
      const relationGiven = r.opt('parentRelation', parseRelation);
      const pCnic = r.opt('parentCnic', parseCnic);
      const pEmail = r.opt('parentEmail', parseEmail);
      const pOccupation = r.opt('parentOccupation', (v) => parseText(v, 80));
      if (pName && pPhone) {
        const relation =
          relationGiven ?? (row.cells.__parentHeader?.toLowerCase().includes('father') ? 'father' : 'guardian');
        const resolved = resolveParent(r, 'parentPhone', pName, pPhone);
        if (resolved) {
          parentKeys.add(resolved.key);
          touches(resolved);
          if (pCnic) groupKeys.push(`cnic:${pCnic}`);
          if (pEmail) groupKeys.push(`email:${pEmail.toLowerCase()}`);
          if (pCnic) {
            const owner = parentByCnic.get(pCnic);
            if (owner && phoneKey(owner.phone) !== resolved.key)
              r.error('parentCnic', 'already belongs to another parent in the system (with a different phone number)');
            const other = seenCnic.get(pCnic);
            if (other && other !== resolved.key)
              r.error('parentCnic', 'is given for a different phone number earlier in the file');
            seenCnic.set(pCnic, resolved.key);
          }
          if ('existingId' in resolved && resolved.existingId)
            guardians.push({ parentId: resolved.existingId, relation, isPrimary: true });
          else
            guardians.push({
              parent: {
                name: pName,
                phone: resolved.newPhone!,
                relation,
                ...(pCnic ? { cnic: pCnic } : {}),
                ...(pEmail ? { email: pEmail } : {}),
                ...(pOccupation ? { occupation: pOccupation } : {}),
              },
              relation,
              isPrimary: true,
            });
        }
      } else if (!r.has('parentName') && !r.has('parentPhone')) {
        r.warn(undefined, 'No parent: the student is added without a parent or guardian');
      }
      const mName = r.opt('motherName', (v) => parseText(v, 100, 2));
      const mPhone = r.opt('motherPhone', parsePhone);
      const samePhone = (p?: string) => Boolean(p && pPhone && phoneKey(p) === phoneKey(pPhone));
      if (mName && mPhone) {
        if (samePhone(mPhone))
          r.warn(
            'motherPhone',
            'is the same number as the parent phone, so the mother was not added as a separate guardian',
          );
        else {
          const resolved = resolveParent(r, 'motherPhone', mName, mPhone);
          if (resolved && !parentKeys.has(resolved.key)) {
            parentKeys.add(resolved.key);
            touches(resolved);
            guardians.push(
              'existingId' in resolved && resolved.existingId
                ? { parentId: resolved.existingId, relation: 'mother' }
                : { parent: { name: mName, phone: resolved.newPhone!, relation: 'mother' }, relation: 'mother' },
            );
          }
        }
      } else if (mPhone && !mName) {
        if (samePhone(mPhone)) r.info('motherPhone', 'same number as the parent phone');
        else r.warn('motherPhone', 'not saved: a Mother Name is needed to add the mother as a guardian');
      } else if (mName && !mPhone && !r.issues.some((i) => i.field === 'motherPhone')) {
        r.warn('motherName', 'not saved: a Mother Phone is needed to add the mother as a guardian');
      }

      const payload: Payload | undefined =
        firstName && gender && campus && session && classId && sectionId
          ? {
              campusId: campus.id,
              sessionId: session.id,
              classId,
              sectionId,
              admissionNo,
              firstName,
              lastName,
              gender,
              dateOfBirth,
              admissionDate,
              rollNo,
              bFormNo,
              bloodGroup,
              address,
              phone,
              previousSchool,
              guardians,
              status,
            }
          : undefined;

      // The admission form's own rules (lengths, formats, at most four guardians).
      if (payload && !r.failed) {
        const { status: _status, ...input } = payload;
        const parsed = StudentBody.safeParse(stripUndefined(input));
        if (!parsed.success)
          for (const i of parsed.error.issues) {
            const f = String(i.path[0] ?? '');
            const shown = f === 'firstName' || f === 'lastName' ? 'fullName' : f;
            r.error(r.has(shown) ? shown : undefined, `${formLabel(f)}: ${i.message}`);
          }
      }

      const plan: RowPlan<Payload> = {
        rowNo: row.rowNo,
        check: 'create',
        issues: r.issues,
        changes: [],
        key: admissionNo,
        groupKeys,
      };
      if (r.failed || !payload) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      // Same admission number twice in the file.
      if (admissionNo) {
        const k = admissionNo.toLowerCase();
        const first = seenAdmission.get(k);
        if (first) {
          plan.issues.push({
            level: 'error',
            field: 'admissionNo',
            message: `Admission No ${admissionNo} also appears on row ${first}`,
          });
          out.push({ ...plan, check: 'duplicate' });
          continue;
        }
        seenAdmission.set(k, row.rowNo);
      }
      const match = admissionNo ? byAdmission.get(admissionNo.toLowerCase()) : undefined;
      if (match && !visibleCampus(match.campusId)) {
        plan.issues.push({
          level: 'error',
          field: 'admissionNo',
          message: `Admission No ${admissionNo} is already used in another campus`,
        });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      if (match) {
        const changes = studentChanges(match, payload);
        const placementDiffers = String(match.classId) !== classId || String(match.sectionId) !== sectionId;
        if (placementDiffers)
          plan.issues.push({
            level: 'info',
            field: 'className',
            message: 'Class/section differs from the system; imports never move students (use Promote students)',
          });
        if (options.mode === 'upsert' && changes.length)
          out.push({
            ...plan,
            check: 'update',
            changes,
            existingId: String(match._id),
            payload: { ...payload, admissionNo },
          });
        else
          out.push({
            ...plan,
            check: options.mode === 'upsert' ? 'unchanged' : 'exists',
            changes: options.mode === 'upsert' ? [] : changes,
            existingId: String(match._id),
            issues: [
              ...plan.issues,
              {
                level: 'info',
                message:
                  options.mode === 'upsert'
                    ? `Already in the system with the same details (Admission No ${match.admissionNo})`
                    : `Already in the system (Admission No ${match.admissionNo}); skipped`,
              },
            ],
          });
        continue;
      }

      // Likely duplicates: never updated, skipped unless the user chose to import anyway.
      const fullKey = nameKey(`${firstName} ${lastName ?? ''}`);
      const describe = (s: ExistingStudent) =>
        visibleCampus(s.campusId)
          ? `${s.firstName} ${s.lastName ?? ''}`.trim() + ` (${s.admissionNo})`
          : 'a student in another campus';
      const nk = admissionNo ? numberKey(admissionNo) : null;
      const zeroMatch = nk ? (byNumber.get(nk) ?? []).filter((s) => s.admissionNo !== admissionNo) : [];
      if (zeroMatch.length && !zeroMatch.some((s) => nameKey(`${s.firstName} ${s.lastName ?? ''}`) === fullKey)) {
        plan.issues.push({
          level: 'error',
          field: 'admissionNo',
          message: `Admission No ${admissionNo} matches ${zeroMatch.map((s) => s.admissionNo).join(', ')} in the system apart from leading zeros, but that is ${describe(zeroMatch[0])}. Check the number`,
        });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const likely =
        zeroMatch.find((s) => nameKey(`${s.firstName} ${s.lastName ?? ''}`) === fullKey) ??
        (byName.get(fullKey) ?? []).find(
          (s) =>
            (dateOfBirth && s.dateOfBirth && formatDateOnly(s.dateOfBirth) === dateOfBirth) ||
            s.guardians.some((g) => parentKeys.has(parentPhoneKey.get(String(g.parentId)) ?? '')),
        );
      const personKey = dateOfBirth ? `${fullKey}|${dateOfBirth}` : [...parentKeys].map((k) => `${fullKey}|${k}`)[0];
      const twin = personKey ? seenPerson.get(personKey) : undefined;
      if (likely || twin) {
        const why = likely
          ? `Likely already in the system: ${describe(likely)} has the same ${
              zeroMatch.includes(likely)
                ? 'admission number apart from leading zeros'
                : dateOfBirth
                  ? 'name and date of birth'
                  : 'name and parent phone'
            }`
          : `Likely the same student as row ${twin} (same name and ${dateOfBirth ? 'date of birth' : 'parent phone'})`;
        if (options.skipPossibleDuplicates) {
          out.push({
            ...plan,
            check: 'duplicate',
            issues: [...plan.issues, { level: 'warning', message: `${why}; skipped` }],
            ...(likely ? { existingId: String(likely._id) } : {}),
          });
          continue;
        }
        plan.issues.push({ level: 'warning', message: `${why}; imported anyway as you chose` });
      }
      if (personKey && !seenPerson.has(personKey)) seenPerson.set(personKey, row.rowNo);

      // Capacity and plan limit, counting the rows before this one.
      if (status === 'active') {
        if (activeNow + newActive >= limits.maxStudents) {
          plan.issues.push({
            level: 'error',
            message: `Your plan allows ${limits.maxStudents} active students; this row would exceed it`,
          });
          out.push({ ...plan, check: 'invalid' });
          continue;
        }
        const section = refs.sections.find((s) => s.id === sectionId);
        const filled = enrolled.get(sectionId!) ?? 0;
        if (section?.capacity && filled >= section.capacity) {
          plan.issues.push({
            level: 'error',
            field: 'sectionName',
            message: `Section ${section.name} is full (capacity ${section.capacity})`,
          });
          out.push({ ...plan, check: 'invalid' });
          continue;
        }
        enrolled.set(sectionId!, filled + 1);
        newActive++;
      }
      out.push({ ...plan, payload });
    }
    // Students to add, by the status they are saved with: only Active ones count as active
    // students (dashboard, student list, plan limit); left, graduated and suspended are kept as
    // records. Said before confirming, so "added" is never read as "active".
    const statusBreakdown: Record<string, number> = {};
    for (const p of out)
      if (p.check === 'create' && p.payload) {
        const st = p.payload.status ?? 'active';
        statusBreakdown[st] = (statusBreakdown[st] ?? 0) + 1;
      }
    const notActive = Object.entries(statusBreakdown)
      .filter(([st]) => st !== 'active')
      .reduce((n, [, c]) => n + c, 0);
    if (notActive)
      warnings.push(
        `${notActive} student(s) will be added with the status ${Object.keys(statusBreakdown)
          .filter((st) => st !== 'active')
          .map((st) => STATUS_WORDS[st] ?? st)
          .join(
            ', ',
          )} from the Status column: they are saved as records but not counted as active students (dashboard, student list, plan limit).`,
      );
    return { rows: out, warnings, summary: { statusBreakdown } };
  },

  /** The added students as saved, by status (read back when the import ends). */
  async resultBreakdown(ctx, ids) {
    const out: Record<string, number> = {};
    for (let i = 0; i < ids.length; i += 1000)
      for (const g of await Student.aggregate<{ _id: string; n: number }>([
        { $match: { schoolId: oid(ctx.schoolId), _id: { $in: ids.slice(i, i + 1000) } } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]))
        out[g._id] = (out[g._id] ?? 0) + g.n;
    return out;
  },

  async assignKey(ctx, plan) {
    if (plan.payload?.admissionNo) return undefined;
    return nextNumber(ctx.schoolId, 'admission', 'ADM-', 5);
  },

  reserveKeys: (ctx, count) => reserveNumbers(ctx.schoolId, 'admission', 'ADM-', 5, count),

  apply: (ctx, plan) => applyStudent(ctx, plan),

  /**
   * Several lanes: rows that share a parent (phone, login name, email, CNIC) or an admission
   * number are saved in file order in one lane (see RunHelper). The login settings and each
   * checked section are read once and re-read with every heartbeat. The plan limit, the
   * active-student count and the section count are read for every row inside its transaction,
   * as for an admission.
   *
   * Limits under parallel saving: a row that counts towards the plan limit or a section's
   * capacity holds a shared lock on it while it is saved. When its own count finds fewer places
   * left than there are lanes, it is saved again holding the lock alone (SaveAlone): after every
   * other row using that limit has finished, and before any new one starts. Far from a limit,
   * the at most one-row-per-lane being saved at once all fit; near it, rows are counted and saved
   * one at a time, as without lanes. A limit can therefore not be exceeded by the lanes.
   */
  async startRun(ctx, plans, { lanes }): Promise<RunHelper<Payload>> {
    const locks = new KeyedLocks();
    // Within LIMIT_GUARD_MARGIN of a limit the database serialises saves anyway (see
    // takeLimitGuard): save those rows one at a time instead of letting them conflict and retry.
    const margin = Math.max(lanes, LIMIT_GUARD_MARGIN);
    /** Limits found close: their rows are saved alone from the first try (places only go down). */
    const near = new Set<string>();
    // Every placement in the file, checked together (a few queries) and again with each refresh.
    const placements = [
      ...new Map(
        plans.filter((p) => p.check === 'create' && p.payload).map((p) => [placementKey(p.payload!), p.payload!]),
      ).values(),
    ];
    let accountSettings = await admissionAccountSettings(ctx);
    let sections = await placementSections(ctx, placements);

    /** The row's checked section; one that failed the check is checked again, to report why. */
    const sectionFor = (input: Payload): Promise<PlacedSection> | PlacedSection =>
      sections.get(placementKey(input)) ?? placementSection(ctx, input);

    const pendingChanges: RecordChangeItem[] = [];
    const BATCH_SIZE = 50;
    const flushBatch = async () => {
      if (!pendingChanges.length) return;
      const batch = pendingChanges.splice(0, pendingChanges.length);
      await atomic(() => recordChanges(ctx.schoolId, batch));
    };

    const onCreated = async (item: RecordChangeItem) => {
      pendingChanges.push(item);
      if (pendingChanges.length >= BATCH_SIZE) {
        await flushBatch();
      }
    };

    return {
      async apply(plan) {
        if (plan.check !== 'create') return applyStudent(ctx, plan);
        const prefetched = { accountSettings, section: await sectionFor(plan.payload!) };
        if ((plan.payload!.status ?? 'active') !== 'active')
          return applyStudent(ctx, plan, { prefetched, onCreated });
        const limitKeys = ['limit', `section:${plan.payload!.sectionId}`];
        const alone = new Set(limitKeys.filter((key) => near.has(key)));
        for (;;) {
          try {
            return await locks.run(
              limitKeys.map((key) => ({ key, exclusive: alone.has(key) })),
              () => applyStudent(ctx, plan, { prefetched, lanes: new SavingInLanes(margin, alone), onCreated }),
            );
          } catch (err) {
            if (!(err instanceof SaveAlone) || alone.has(err.key)) throw err;
            alone.add(err.key); // nothing was written: save it again, alone for this limit
            near.add(err.key);
          }
        }
      },
      async refresh() {
        accountSettings = await admissionAccountSettings(ctx);
        sections = await placementSections(ctx, placements);
        await flushBatch();
      },
      async finish() {
        await flushBatch();
      },
    };
  },
};

async function applyStudent(
  ctx: SchoolContext,
  plan: RowPlan<Payload>,
  opts: {
    prefetched?: AdmissionPrefetch;
    lanes?: SavingInLanes;
    onCreated?: (item: RecordChangeItem) => Promise<void>;
  } = {},
): Promise<ApplyResult> {
  const { status, ...input } = plan.payload!;
  if (plan.check === 'update') {
    const set: Partial<StudentInput> = {};
    for (const c of plan.changes)
      (set as Record<string, unknown>)[c.field] = (input as unknown as Record<string, unknown>)[c.field];
    await updateStudent(ctx, plan.existingId!, set);
    return { result: 'updated', entityId: plan.existingId };
  }
  // Saved with its own status from the start: a left or graduated student is never active,
  // so it does not count towards the plan limit or section capacity (as the preview assumed).
  const skipRecordChange = Boolean(opts.onCreated);
  const created = await createStudent(
    ctx,
    { ...input, admissionNo: input.admissionNo ?? plan.key },
    {
      status: status ?? 'active',
      statusReason: status && status !== 'active' ? 'Imported' : undefined,
      ...opts,
      skipRecordChange,
    },
  );
  if (opts.onCreated) {
    await opts.onCreated({
      entityType: 'STUDENT',
      entityId: created._id.toString(),
      operation: 'INSERT',
      payload: {
        id: created._id.toString(),
        schoolId: ctx.schoolId.toString(),
        admissionNumber: created.admissionNo,
        admissionNo: created.admissionNo,
        fullName: `${created.firstName} ${created.lastName || ''}`.trim(),
        firstName: created.firstName,
        lastName: created.lastName,
        gender: created.gender,
        dateOfBirth: created.dateOfBirth ? new Date(created.dateOfBirth).toISOString().split('T')[0] : null,
        status: created.status,
        campusId: created.campusId?.toString(),
        sessionId: created.sessionId?.toString(),
        classId: created.classId?.toString(),
        sectionId: created.sectionId?.toString(),
      },
    });
  }
  const id = String(created._id);
  const accounts = created.accounts?.filter((a) => a.created).length ?? 0;
  return {
    result: 'created',
    entityId: id,
    message: `Admission No ${created.admissionNo}${status && status !== 'active' ? `; saved as ${STATUS_WORDS[status] ?? status} (not counted as an active student)` : ''}${accounts ? `; ${accounts} parent login(s) waiting for activation` : ''}`,
  };
}

const STATUS_WORDS: Record<string, string> = {
  left: 'Left',
  graduated: 'Graduated',
  suspended: 'Suspended',
  archived: 'Archived',
};

const FORM_LABELS: Record<string, string> = {
  firstName: 'Student name (first part)',
  lastName: 'Student name (last word)',
  guardians: 'Parents',
};
const formLabel = (f: string) => FORM_LABELS[f] ?? label(f);

function stripUndefined(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function studentChanges(current: Record<string, any>, next: Payload): Change[] {
  const changes: Change[] = [];
  for (const f of UPDATABLE) {
    const to = next[f];
    if (to === undefined || to === '') continue; // empty cells never erase existing data
    const fromRaw = current[f];
    const from = fromRaw instanceof Date ? formatDateOnly(fromRaw) : (fromRaw ?? '');
    if (String(from) !== String(to)) changes.push({ field: f, from: show(from), to: show(to) });
  }
  return changes;
}

export type { RowIn, ImportOptions };
