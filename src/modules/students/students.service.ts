import { Types } from 'mongoose';
import { Counter, nextNumber } from '../../database/counter.model';
import { atomic, inTransaction } from '../../database/transactions';
import type { SchoolContext } from '../../types/context';
import { parseDateOnly } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { paginate, searchRegex } from '../../utils/pagination';
import { assertCampusAccess, assertManyRefs, assertRefs, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { assertStudentVisible, studentVisibilityFilter, visibleStudentIds } from '../academics/access.service';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { ROLE_GRANTS } from '../../config/permissions';
import { School } from '../schools/school.model';
import { getSchoolLimits, planLimitError } from '../subscriptions/limits.service';
import { User } from '../users/user.model';
import { provisionParentAccount, rollbackCreatedUser, type ProvisionedAccount } from '../users/users.service';
import { Parent, SETTABLE_STUDENT_STATUSES, Student, StudentEnrollment } from './student.models';
import { parentIdsMatching, studentTextFilter } from './student-search';
import { recordChange } from '../sync/sync.service';

type Ctx = SchoolContext;

const canSeeSensitive = (ctx: Ctx) => ctx.permissions.has('students:manage');
const SENSITIVE_PROJECTION = '-bFormNo -medicalNotes -feeConcession.approvalId';

export interface GuardianInput {
  parentId?: string;
  parent?: {
    name: string;
    phone: string;
    relation?: string;
    cnic?: string;
    email?: string;
    whatsapp?: string;
    occupation?: string;
    address?: string;
  };
  relation?: string;
  isPrimary?: boolean;
}

export interface StudentInput {
  campusId: string;
  admissionNo?: string;
  rollNo?: string;
  firstName: string;
  lastName?: string;
  gender: 'male' | 'female' | 'other';
  dateOfBirth?: string;
  bFormNo?: string;
  bloodGroup?: string;
  medicalNotes?: string;
  address?: string;
  phone?: string;
  sessionId: string;
  classId: string;
  sectionId: string;
  admissionDate?: string;
  previousSchool?: string;
  guardians?: GuardianInput[];
}

/**
 * Section must belong to the given class and session; capacity must not be exceeded. Capacity
 * counts active students only, so it is skipped for a student who will not be active
 * (`checkCapacity: false`, e.g. a left or graduated student recorded by an import).
 */
export { assertActiveStudentRoom };

export async function assertPlacement(
  ctx: Ctx,
  input: Placement,
  excludeStudentId?: string,
  opts: { checkCapacity?: boolean } = {},
) {
  const section = await placementSection(ctx, input);
  if (opts.checkCapacity === false) return;
  await assertSectionRoom(ctx, section, excludeStudentId);
}

type Placement = { campusId: string; classId: string; sectionId: string; sessionId: string };
/** A section as checked by placementSection(). */
export type PlacedSection = { _id: Types.ObjectId; name: string; capacity?: number | null } & Record<string, unknown>;

/** The section, after checking that the campus, session, class and section exist and belong together. */
export async function placementSection(ctx: Ctx, input: Placement): Promise<PlacedSection> {
  await assertRefs(ctx, [
    [Campus, input.campusId, 'campusId'],
    [AcademicSession, input.sessionId, 'sessionId'],
    [SchoolClass, input.classId, 'classId'],
    [Section, input.sectionId, 'sectionId'],
  ]);
  const section = await Section.findOne(scope(ctx, { _id: oid(input.sectionId) })).lean();
  if (!section) throw badRequest('Section not found');
  if (section.classId.toString() !== input.classId) throw badRequest('Section does not belong to the selected class');
  if (section.sessionId.toString() !== input.sessionId)
    throw badRequest('Section does not belong to the selected session');
  if (section.campusId.toString() !== input.campusId)
    throw badRequest('Section does not belong to the selected campus');
  return section as unknown as PlacedSection;
}

/**
 * placementSection() for many placements at once (an import: one query per collection instead
 * of five per student). Returns the section for each placement that passes the same checks,
 * keyed by placementKey(); a placement missing from the result fails them (check it with
 * placementSection() to get the reason).
 */
export async function placementSections(ctx: Ctx, placements: Placement[]): Promise<Map<string, PlacedSection>> {
  const out = new Map<string, PlacedSection>();
  const valid = placements.filter((p) =>
    [p.campusId, p.sessionId, p.classId, p.sectionId].every((id) => Types.ObjectId.isValid(id)),
  );
  if (!valid.length) return out;
  const ids = (field: keyof Placement) => [...new Set(valid.map((p) => p[field]))].map(oid);
  const existing = async (model: typeof Campus | typeof AcademicSession | typeof SchoolClass, field: keyof Placement) =>
    new Set(
      (
        await (model as typeof Campus)
          .find(scope(ctx, { _id: { $in: ids(field) } }))
          .select('_id')
          .lean()
      ).map((d) => String(d._id)),
    );
  const campuses = await existing(Campus, 'campusId');
  const sessions = await existing(AcademicSession, 'sessionId');
  const classes = await existing(SchoolClass, 'classId');
  const sections = new Map(
    (await Section.find(scope(ctx, { _id: { $in: ids('sectionId') } })).lean()).map((s) => [String(s._id), s]),
  );
  for (const p of valid) {
    const section = sections.get(p.sectionId);
    if (
      section &&
      campuses.has(p.campusId) &&
      sessions.has(p.sessionId) &&
      classes.has(p.classId) &&
      section.classId.toString() === p.classId &&
      section.sessionId.toString() === p.sessionId &&
      section.campusId.toString() === p.campusId
    )
      out.set(placementKey(p), section as unknown as PlacedSection);
  }
  return out;
}

export const placementKey = (p: Placement) => [p.campusId, p.sessionId, p.classId, p.sectionId].join('|');

/** Capacity: active students in the section, counted now (a section without a capacity has no limit). */
async function assertSectionRoom(ctx: Ctx, section: PlacedSection, excludeStudentId?: string, lanes?: SavingInLanes) {
  if (!section.capacity) return;
  const enrolled = await Student.countDocuments(
    scope(ctx, {
      sectionId: section._id,
      status: 'active',
      ...(excludeStudentId ? { _id: { $ne: oid(excludeStudentId) } } : {}),
    }),
  );
  if (section.capacity && enrolled >= section.capacity) {
    throw conflict(
      `Section ${section.name} is full (capacity ${section.capacity})`,
      { capacity: section.capacity },
      'SECTION_FULL',
    );
  }
  if (section.capacity - enrolled <= LIMIT_GUARD_MARGIN) await takeLimitGuard(ctx, `section:${String(section._id)}`);
  lanes?.check(`section:${String(section._id)}`, section.capacity - enrolled);
}

/**
 * How close to a limit (places left) concurrent saves are serialised: see takeLimitGuard(). Far
 * from a limit, saves run in parallel; at most this many could be in flight at once (import lanes
 * plus people admitting at the same moment) without one of them noticing the others.
 */
export const LIMIT_GUARD_MARGIN = 50;

/**
 * Counting active students and then saving one is not atomic: two saves can each count the same
 * total and both succeed, one more than the limit. Near a limit, every save that uses it writes
 * the same guard document inside its transaction: two such transactions then conflict, MongoDB
 * aborts the later one and it is retried, counting again with the first one's student included.
 * Needs a transaction (a replica set, as required in production); without one this does nothing.
 */
async function takeLimitGuard(ctx: Ctx, limit: string) {
  await Counter.updateOne(
    { schoolId: oid(ctx.schoolId), key: `limit-guard:${limit}` },
    { $inc: { seq: 1 } },
    { upsert: true },
  );
}

/**
 * The active-student limit for one more active student, counted now. Call it inside the
 * transaction that makes the student active (see takeLimitGuard).
 */
async function assertActiveStudentRoom(ctx: Ctx, lanes?: SavingInLanes) {
  const limits = await getSchoolLimits(ctx.schoolId);
  const active = await Student.countDocuments(scope(ctx, { status: 'active' }));
  if (active >= limits.maxStudents) throw planLimitError('active students', limits.maxStudents);
  if (limits.maxStudents - active <= LIMIT_GUARD_MARGIN) await takeLimitGuard(ctx, 'active-students');
  lanes?.check('limit', limits.maxStudents - active);
}

async function resolveGuardians(ctx: Ctx, guardians: GuardianInput[] = [], createdParentIds: string[] = []) {
  const out: Array<{ parentId: unknown; relation: string; isPrimary: boolean }> = [];
  for (const g of guardians) {
    let parentId = g.parentId;
    if (!parentId && g.parent) {
      // Reuse an existing parent record with the same phone to keep siblings linked.
      const existing = await Parent.findOne(scope(ctx, { phone: g.parent.phone }))
        .select('_id')
        .lean();
      if (existing) parentId = existing._id.toString();
      else {
        parentId = (await Parent.create({ ...g.parent, schoolId: ctx.schoolId }))._id.toString();
        createdParentIds.push(parentId);
      }
    }
    if (!parentId) throw badRequest('Each guardian needs parentId or parent details');
    await assertRefs(ctx, [[Parent, parentId, 'parentId']]);
    if (out.some((o) => String(o.parentId) === parentId)) continue; // same guardian listed twice
    out.push({
      parentId: oid(parentId),
      relation: g.relation ?? g.parent?.relation ?? 'guardian',
      isPrimary: !!g.isPrimary,
    });
  }
  if (out.length && !out.some((g) => g.isPrimary)) out[0].isPrimary = true;
  return out;
}

/**
 * Parent logins for a newly admitted student, according to school settings. A parent who
 * already has a login (a sibling is enrolled) keeps that one login. Students do not get a login
 * of their own: the parent portal shows everything about each of the parent's children.
 */
async function provisionAdmissionAccounts(
  ctx: Ctx,
  parentIds: string[],
  accounts: ProvisionedAccount[],
  prefetched?: AdmissionPrefetch,
): Promise<string[]> {
  const prefs = prefetched ? prefetched.accountSettings : await admissionAccountSettings(ctx);
  const skipped: string[] = [];
  const canParents = ROLE_GRANTS[ctx.role].includes('parent');
  if (prefs?.autoCreateParentLogins !== false) {
    if (canParents) for (const pid of parentIds) accounts.push(await provisionParentAccount(ctx, pid));
    else if (parentIds.length) skipped.push('Parent logins were not created: your role cannot create parent accounts.');
  }
  return skipped;
}

/** The school's login settings for admissions (Settings → Accounts). */
export async function admissionAccountSettings(ctx: Ctx) {
  const school = await School.findById(ctx.schoolId).select('settings.accounts').lean();
  return school?.settings?.accounts ?? undefined;
}

export type InitialStudentStatus = (typeof SETTABLE_STUDENT_STATUSES)[number];

/**
 * Values that an import reads once for many students instead of once per student, and re-reads
 * every few seconds (see the students import): the login settings and the checked section (that
 * the campus, session, class and section exist and belong together). Plan limits and the live
 * counts (active students, students in the section) are never reused: they are read for each
 * student, as for an admission. A section that does not match the student's placement is
 * ignored and checked as usual.
 */
export interface AdmissionPrefetch {
  accountSettings: Awaited<ReturnType<typeof admissionAccountSettings>>;
  section: PlacedSection;
}

/**
 * Thrown (before anything is written) when an import saving rows in parallel lanes reaches the
 * last few places of a limit: fewer places are left than rows may be saved at once, so this row
 * must be checked and saved alone, while no other row that uses the limit is being saved.
 */
export class SaveAlone extends Error {
  constructor(readonly key: string) {
    super(`Save alone: ${key}`);
  }
}

/**
 * An import saving up to `margin` rows at once (see the students import). `alone` holds the
 * limits this row is already being saved alone for.
 */
export class SavingInLanes {
  constructor(
    readonly margin: number,
    readonly alone: ReadonlySet<string>,
  ) {}

  /** `left` places remain for `key`; with fewer than one per lane, save this row alone. */
  check(key: string, left: number) {
    if (left < this.margin && !this.alone.has(key)) throw new SaveAlone(key);
  }
}

const prefetchedSection = (input: Placement, p?: AdmissionPrefetch) =>
  p &&
  String(p.section._id) === input.sectionId &&
  String(p.section.classId) === input.classId &&
  String(p.section.sessionId) === input.sessionId &&
  String(p.section.campusId) === input.campusId
    ? p.section
    : undefined;

/**
 * Student, new parent records and their logins: one transaction on a replica set (see atomic()).
 *
 * `status` (default active) is saved as the student's first status. Only active students count
 * towards the plan's student limit and a section's capacity (`status: 'active'`, as everywhere),
 * so those checks apply only when the new student is active: a left or graduated student can be
 * recorded at the limit, and is never active, not even for a moment. Admissions pass no status.
 */
export async function createStudent(ctx: Ctx, input: StudentInput, opts: CreateStudentOptions = {}) {
  return atomic(() => createStudentOnce(ctx, input, opts));
}

type CreateStudentOptions = {
  status?: InitialStudentStatus;
  statusReason?: string;
  prefetched?: AdmissionPrefetch;
  lanes?: SavingInLanes;
  skipRecordChange?: boolean;
};

async function createStudentOnce(ctx: Ctx, input: StudentInput, opts: CreateStudentOptions) {
  assertCampusAccess(ctx, input.campusId);
  const status = opts.status ?? 'active';
  const countsAsActive = status === 'active';
  // Sequential on purpose: this runs inside a transaction, which cannot run operations in parallel.
  if (countsAsActive) {
    await assertActiveStudentRoom(ctx, opts.lanes);
  }
  const section = prefetchedSection(input, opts.prefetched) ?? (await placementSection(ctx, input));
  if (countsAsActive) await assertSectionRoom(ctx, section, undefined, opts.lanes);
  const createdParentIds: string[] = [];
  let studentId: Types.ObjectId | undefined;
  const accounts: ProvisionedAccount[] = [];
  let skipped: string[] = [];
  try {
    const guardians = await resolveGuardians(ctx, input.guardians, createdParentIds);
    const admissionNo = input.admissionNo ?? (await nextNumber(ctx.schoolId, 'admission', 'ADM-', 5));
    const student = await Student.create({
      ...input,
      schoolId: ctx.schoolId,
      admissionNo,
      guardians,
      dateOfBirth: input.dateOfBirth ? parseDateOnly(input.dateOfBirth) : undefined,
      admissionDate: input.admissionDate ? parseDateOnly(input.admissionDate) : new Date(),
      status,
      ...(countsAsActive ? {} : { statusChangedAt: new Date(), leavingReason: opts.statusReason }),
    });
    studentId = student._id;
    await StudentEnrollment.create({
      schoolId: ctx.schoolId,
      studentId: student._id,
      sessionId: student.sessionId,
      classId: student.classId,
      sectionId: student.sectionId,
      campusId: student.campusId,
      rollNo: student.rollNo,
      enrollmentDate: student.admissionDate ?? new Date(),
      status: status === 'active' ? 'active' : (status as any),
      ...(countsAsActive ? {} : { statusChangedAt: new Date(), statusReason: opts.statusReason }),
      createdBy: ctx.userId ? oid(ctx.userId) : undefined,
    });
    skipped = await provisionAdmissionAccounts(
      ctx,
      guardians.map((g) => String(g.parentId)),
      accounts,
      opts.prefetched,
    );
  } catch (err) {
    if (inTransaction()) throw err; // the transaction abort undoes every write below
    // No multi-document transactions on standalone MongoDB: undo what this admission created
    // so a retry starts clean (no orphaned parents, logins or half-admitted students). Logins
    // that already existed (a sibling's parent) are reused, not created, and are left alone.
    for (const a of accounts.filter((x) => x.created)) await rollbackCreatedUser(ctx, oid(a.userId));
    if (studentId) {
      await StudentEnrollment.deleteMany(scope(ctx, { studentId })).catch(() => undefined);
      await Student.deleteOne(scope(ctx, { _id: studentId }));
    }
    for (const pid of createdParentIds) {
      const login = await User.findOne(scope(ctx, { parentId: oid(pid) }))
        .select('_id')
        .lean();
      if (login) await rollbackCreatedUser(ctx, login._id);
      await Parent.deleteOne(scope(ctx, { _id: oid(pid) }));
    }
    throw err;
  }
  const saved = await Student.findOne(scope(ctx, { _id: studentId })).lean();
  await audit(ctx, {
    action: 'student.create',
    entityType: 'Student',
    entityId: studentId,
    metadata: {
      admissionNo: saved?.admissionNo,
      ...(countsAsActive ? {} : { status }),
      accountsCreated: accounts.filter((a) => a.created).map((a) => a.role),
    },
  });

  // Emit incremental sync change for desktop clients
  if (saved && !opts.skipRecordChange) {
    await recordChange(
      saved.schoolId,
      'STUDENT',
      saved._id.toString(),
      'INSERT',
      (saved as any).version ?? 1,
      {
        id: saved._id.toString(),
        schoolId: saved.schoolId.toString(),
        admissionNumber: saved.admissionNo,
        admissionNo: saved.admissionNo,
        fullName: `${saved.firstName} ${saved.lastName || ''}`.trim(),
        firstName: saved.firstName,
        lastName: saved.lastName,
        gender: saved.gender,
        dateOfBirth: saved.dateOfBirth ? new Date(saved.dateOfBirth).toISOString().split('T')[0] : null,
        phone: saved.phone,
        address: saved.address,
        status: saved.status,
      },
      {
        originDeviceId: 'web_portal',
        actorId: ctx.userId,
      },
    );
  }

  return { ...saved!, accounts, accountsSkipped: skipped };
}

export async function listStudents(
  ctx: Ctx,
  q: {
    page: number;
    limit: number;
    q?: string;
    classId?: string;
    sectionId?: string;
    campusId?: string;
    sessionId?: string;
    status?: string;
    gender?: string;
  },
) {
  const filter: Record<string, unknown> = scope(ctx);
  // Parents/students see their family; teachers only the students of their (covered) sections.
  const visible = await visibleStudentIds(ctx);
  const restriction = await studentVisibilityFilter(ctx);
  // In $and so caller-supplied filters (sectionId, classId...) can only narrow it, never replace it.
  if (restriction) filter.$and = [restriction];
  if (!visible) Object.assign(filter, campusScope(ctx));
  if (q.classId) filter.classId = oid(q.classId);
  if (q.sectionId) filter.sectionId = oid(q.sectionId);
  if (q.campusId) filter.campusId = oid(q.campusId);
  if (q.sessionId) filter.sessionId = oid(q.sessionId);
  if (q.status) filter.status = q.status;
  else if (!visible) filter.status = 'active';
  if (q.gender) filter.gender = q.gender;
  // Also by a parent's name or phone ("search by father's number").
  const match = studentTextFilter(q.q, q.q?.trim() ? await parentIdsMatching(ctx, q.q) : []);
  if (match) filter.$or = match.$or;
  return paginate(Student, filter, {
    page: q.page,
    limit: q.limit,
    sort: { firstName: 1, lastName: 1 },
    select: canSeeSensitive(ctx) ? undefined : SENSITIVE_PROJECTION,
    populate: [
      { path: 'classId', select: 'name level' },
      { path: 'sectionId', select: 'name' },
    ],
  });
}

export async function getStudent(ctx: Ctx, id: string) {
  await assertStudentVisible(ctx, id);
  const filter: Record<string, unknown> = scope(ctx, { _id: oid(id) });
  if (!(await visibleStudentIds(ctx))) Object.assign(filter, campusScope(ctx));
  const student = await Student.findOne(filter)
    .select(canSeeSensitive(ctx) ? '' : SENSITIVE_PROJECTION)
    .populate('classId', 'name level')
    .populate('sectionId', 'name room')
    .populate('sessionId', 'name')
    .populate(
      'guardians.parentId',
      canSeeSensitive(ctx) || ctx.permissions.has('parents:read')
        ? 'name phone whatsapp email relation occupation'
        : 'name relation',
    )
    .lean();
  if (!student) throw notFound('Student');
  return student;
}

export async function updateStudent(ctx: Ctx, id: string, input: Partial<StudentInput>) {
  return atomic(async () => {
    const student = await findOwned(Student, ctx, id, 'Student');
    assertCampusAccess(ctx, student.campusId);
    const placementChanged = ['campusId', 'classId', 'sectionId', 'sessionId'].some(
      (k) => (input as any)[k] !== undefined,
    );
    if (placementChanged) {
      await assertPlacement(
        ctx,
        {
          campusId: input.campusId ?? student.campusId.toString(),
          classId: input.classId ?? student.classId.toString(),
          sectionId: input.sectionId ?? student.sectionId.toString(),
          sessionId: input.sessionId ?? student.sessionId.toString(),
        },
        id,
      );
    }
    const { guardians, ...rest } = input;
    const set: Record<string, unknown> = { ...rest };
    if (input.dateOfBirth) set.dateOfBirth = parseDateOnly(input.dateOfBirth);
    if (input.admissionDate) set.admissionDate = parseDateOnly(input.admissionDate);
    if (guardians) set.guardians = await resolveGuardians(ctx, guardians);
    const updated = await Student.findOneAndUpdate(
      scope(ctx, { _id: student._id }),
      { $set: set },
      { returnDocument: 'after', runValidators: true },
    ).lean();
    if (placementChanged || input.rollNo !== undefined) {
      const targetSessionId = input.sessionId ? oid(input.sessionId) : student.sessionId;
      await StudentEnrollment.updateOne(
        scope(ctx, { studentId: student._id, sessionId: targetSessionId }),
        {
          $set: {
            classId: input.classId ? oid(input.classId) : student.classId,
            sectionId: input.sectionId ? oid(input.sectionId) : student.sectionId,
            campusId: input.campusId ? oid(input.campusId) : student.campusId,
            ...(input.rollNo !== undefined ? { rollNo: input.rollNo } : {}),
          },
          $setOnInsert: {
            schoolId: ctx.schoolId,
            studentId: student._id,
            sessionId: targetSessionId,
            status: student.status === 'active' ? 'active' : student.status,
            enrollmentDate: new Date(),
          },
        },
        { upsert: true },
      );
    }
    await audit(ctx, {
      action: 'student.update',
      entityType: 'Student',
      entityId: student._id,
      metadata: { fields: Object.keys(input) },
    });

    // Emit incremental sync change for desktop clients
    if (updated) {
      await recordChange(
        student.schoolId,
        'STUDENT',
        student._id.toString(),
        'UPDATE',
        (updated as any).version ?? 1,
        {
          id: student._id.toString(),
          schoolId: student.schoolId.toString(),
          admissionNumber: updated.admissionNo,
          admissionNo: updated.admissionNo,
          fullName: `${updated.firstName} ${updated.lastName || ''}`.trim(),
          phone: updated.phone,
          address: updated.address,
          status: updated.status,
        },
        {
          originDeviceId: 'web_portal',
          actorId: ctx.userId,
        },
      );
    }

    return updated;
  });
}

export async function changeStatus(ctx: Ctx, id: string, status: string, reason?: string) {
  const student = await findOwned(Student, ctx, id, 'Student');
  assertCampusAccess(ctx, student.campusId);
  if (student.status === 'archived')
    throw conflict('This student is archived. Restore the student from the archive first.');
  // Becoming active: the limit is counted and the status saved in one transaction.
  const updated = await atomic(async () => {
    if (status === 'active' && student.status !== 'active') await assertActiveStudentRoom(ctx);
    const upd = await Student.findOneAndUpdate(
      scope(ctx, { _id: student._id }),
      { $set: { status, statusChangedAt: new Date(), leavingReason: reason } },
      { returnDocument: 'after' },
    ).lean();
    await StudentEnrollment.updateOne(
      scope(ctx, { studentId: student._id, sessionId: student.sessionId }),
      {
        $set: {
          status: status === 'active' ? 'active' : status,
          statusChangedAt: new Date(),
          statusReason: reason,
        },
      },
    );
    return upd;
  });
  await audit(ctx, {
    action: 'student.status_changed',
    entityType: 'Student',
    entityId: student._id,
    metadata: { from: student.status, to: status },
  });
  return updated;
}

/** Move students into a section of the next session (end-of-year promotion). */
export async function promoteStudents(
  ctx: Ctx,
  input: { fromSectionId: string; toSectionId: string; studentIds?: string[] },
) {
  await assertRefs(ctx, [
    [Section, input.fromSectionId, 'fromSectionId'],
    [Section, input.toSectionId, 'toSectionId'],
  ]);
  if (input.studentIds?.length) await assertManyRefs(ctx, Student, input.studentIds, 'student');
  const from = await Section.findOne(scope(ctx, { _id: oid(input.fromSectionId) })).lean();
  const to = await Section.findOne(scope(ctx, { _id: oid(input.toSectionId) })).lean();
  const filter: Record<string, unknown> = scope(ctx, { sectionId: oid(input.fromSectionId), status: 'active' });
  if (input.studentIds?.length) filter._id = { $in: input.studentIds.map(oid) };

  const students = await Student.find(filter).select('_id rollNo campusId').lean();

  for (const st of students) {
    if (from) {
      await StudentEnrollment.updateOne(
        scope(ctx, { studentId: st._id, sessionId: from.sessionId }),
        {
          $set: {
            status: 'promoted',
            statusChangedAt: new Date(),
            statusReason: `Promoted from ${from.name} to ${to!.name}`,
          },
        },
      );
    }
    await StudentEnrollment.updateOne(
      scope(ctx, { studentId: st._id, sessionId: to!.sessionId }),
      {
        $set: {
          classId: to!.classId,
          sectionId: to!._id,
          campusId: to!.campusId,
          rollNo: st.rollNo,
          status: 'active',
          promotionDetails: {
            fromSectionId: from?._id,
            fromClassId: from?.classId,
            fromSessionId: from?.sessionId,
            promotedAt: new Date(),
            promotedBy: ctx.userId ? oid(ctx.userId) : undefined,
            remarks: `Promoted from ${from?.name} to ${to!.name}`,
          },
        },
        $setOnInsert: {
          schoolId: ctx.schoolId,
          studentId: st._id,
          sessionId: to!.sessionId,
          enrollmentDate: new Date(),
        },
      },
      { upsert: true },
    );
  }

  const res = await Student.updateMany(filter, {
    $set: { sectionId: to!._id, classId: to!.classId, sessionId: to!.sessionId, campusId: to!.campusId },
  });
  await audit(ctx, {
    action: 'student.promote',
    entityType: 'Section',
    entityId: to!._id,
    metadata: { from: input.fromSectionId, to: input.toSectionId, count: res.modifiedCount },
  });
  return { promoted: res.modifiedCount, toSectionId: input.toSectionId };
}

/** Fetch all historical and current session enrollments for a student. */
export async function getStudentEnrollments(ctx: Ctx, studentId: string) {
  await findOwned(Student, ctx, studentId, 'Student');
  await assertStudentVisible(ctx, studentId);
  return StudentEnrollment.find(scope(ctx, { studentId: oid(studentId) }))
    .populate('sessionId', 'name startDate endDate isCurrent status')
    .populate('classId', 'name level')
    .populate('sectionId', 'name room')
    .populate('campusId', 'name')
    .sort({ createdAt: -1 })
    .lean();
}

/* ───────────────────────────── Linking parents and students ───────────────────────────── */

export const MAX_GUARDIANS = 4;
export const GUARDIAN_RELATIONS = ['father', 'mother', 'guardian', 'other'] as const;
type GuardianLink = { parentId: unknown; relation?: string | null; isPrimary?: boolean | null };

/**
 * Change one student's guardians with `change` (given the current list, returns the new one).
 * The student's guardians are the only record of who is whose parent: the parent portal, family
 * fees and messaging all read them. The write only lands if the list is still as it was read
 * (otherwise it is read again and retried), so two people linking at the same time never undo
 * each other. Student and parent records are never created or deleted here.
 */
async function changeGuardians(ctx: Ctx, studentId: string, change: (current: GuardianLink[]) => GuardianLink[]) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const st = await Student.findOne(scope(ctx, { _id: oid(studentId), ...campusScope(ctx) }))
      .select('guardians campusId')
      .lean();
    if (!st) throw notFound('Student');
    assertCampusAccess(ctx, st.campusId);
    const current = (st.guardians ?? []) as GuardianLink[];
    const next = change(current);
    if (next.length && !next.some((g) => g.isPrimary)) next[0] = { ...next[0], isPrimary: true };
    const res = await Student.updateOne(scope(ctx, { _id: st._id, guardians: current }), {
      $set: { guardians: next },
    });
    if (res.matchedCount) return { studentId: st._id, before: current, after: next };
  }
  throw conflict('This student’s parents changed meanwhile. Reload and try again.', undefined, 'STUDENT_CHANGED');
}

/**
 * Link an existing parent to an existing student, or change an existing link (relation,
 * primary). Both must belong to the caller's school (and the student to their campuses). A
 * parent can have any number of children; a student up to MAX_GUARDIANS parents/guardians.
 */
export async function linkGuardian(
  ctx: Ctx,
  studentId: string,
  parentId: string,
  input: { relation?: (typeof GUARDIAN_RELATIONS)[number]; isPrimary?: boolean },
) {
  const parent = await findOwned(Parent, ctx, parentId, 'Parent');
  let linked = false;
  const { after } = await changeGuardians(ctx, studentId, (current) => {
    const existing = current.find((g) => String(g.parentId) === String(parent._id));
    linked = !existing;
    if (!existing && current.length >= MAX_GUARDIANS)
      throw conflict(
        `A student can have at most ${MAX_GUARDIANS} parents or guardians. Unlink one first.`,
        undefined,
        'GUARDIAN_LIMIT',
      );
    const relation = input.relation ?? existing?.relation ?? parent.relation ?? 'guardian';
    const isPrimary = input.isPrimary ?? existing?.isPrimary ?? current.length === 0;
    const mine = { parentId: parent._id, relation, isPrimary };
    // One primary guardian: making this one primary makes the others not primary. Order is kept.
    const next = current.map((g) =>
      g === existing ? mine : { ...g, isPrimary: isPrimary ? false : Boolean(g.isPrimary) },
    );
    return existing ? next : [...next, mine];
  });
  await audit(ctx, {
    action: linked ? 'student.guardian_linked' : 'student.guardian_updated',
    entityType: 'Student',
    entityId: studentId,
    metadata: {
      parentId: String(parent._id),
      relation: after.find((g) => String(g.parentId) === String(parent._id))?.relation,
    },
  });
  return getStudent(ctx, studentId);
}

/**
 * Remove the link between a parent and a student. Only the link goes: the parent record, its
 * login and the student stay. If the primary guardian is unlinked, the next one becomes primary.
 */
export async function unlinkGuardian(ctx: Ctx, studentId: string, parentId: string) {
  await changeGuardians(ctx, studentId, (current) => {
    if (!current.some((g) => String(g.parentId) === parentId)) throw notFound('Link between this parent and student');
    return current.filter((g) => String(g.parentId) !== parentId);
  });
  await audit(ctx, {
    action: 'student.guardian_unlinked',
    entityType: 'Student',
    entityId: studentId,
    metadata: { parentId },
  });
  return getStudent(ctx, studentId);
}

export async function parentChildren(ctx: Ctx, parentId: string) {
  await findOwned(Parent, ctx, parentId, 'Parent');
  return Student.find(scope(ctx, { 'guardians.parentId': oid(parentId) }))
    .select('firstName lastName admissionNo classId sectionId status guardians')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .lean();
}

export * from './promotion.service';
export * from './student-journey.service';
