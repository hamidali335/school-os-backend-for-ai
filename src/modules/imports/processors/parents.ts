import type { SchoolContext } from '../../../types/context';
import { campusScope, oid, scope } from '../../../utils/tenant';
import { audit } from '../../audit/audit.service';
import { Parent, Student } from '../../students/student.models';
import { fieldLabel } from '../import-fields';
import { nameKey, parseCnic, parseEmail, parsePhone, parseRelation, parseText, phoneKey } from '../import-values';
import { atomic, inTransaction } from '../../../database/transactions';
import { conflict } from '../../../utils/errors';
import { ParentInline } from '../../students/student.schemas';
import { RowReader, show, type Change, type Processor, type RowPlan, breathe } from './types';

interface Payload {
  data: {
    name: string;
    phone: string;
    relation?: 'father' | 'mother' | 'guardian' | 'other';
    cnic?: string;
    email?: string;
    whatsapp?: string;
    occupation?: string;
    address?: string;
  };
  /** Students to link to this parent (not yet linked). */
  link: Array<{ studentId: string; admissionNo: string; hasGuardians: boolean }>;
}

const label = (f: string) => fieldLabel('parents', f);
const UPDATABLE = ['name', 'relation', 'cnic', 'email', 'whatsapp', 'occupation', 'address'] as const;

/** The admission form allows at most four parents or guardians per student. */
const MAX_GUARDIANS = 4;

/**
 * Parents import. A parent is recognised by phone number in any common format (03…, +92…, 92…),
 * as in admissions where siblings share one parent record; several parents with the same number
 * and no single name match are refused for review. Rows are checked with the Parents form's
 * schema. Children are linked by admission number: only students the user can see, only with
 * permission to edit students, and never beyond four guardians. Parent records created here have
 * no login, like parents added on the Parents page; logins are created at admission.
 */
export const parentsProcessor: Processor<Payload> = {
  async plan(ctx, rows, options) {
    const admissionNos = new Set<string>();
    for (const r of rows) for (const a of splitList(r.cells.childAdmissionNos ?? '')) admissionNos.add(a);
    const existing = await Parent.find(scope(ctx))
      .select('name phone relation cnic email whatsapp occupation address')
      .lean();
    const byKey = new Map<string, typeof existing>();
    for (const p of existing) byKey.set(phoneKey(p.phone), [...(byKey.get(phoneKey(p.phone)) ?? []), p]);
    const byCnic = new Map(existing.filter((p) => p.cnic).map((p) => [p.cnic!, p]));
    const canLinkChildren = ctx.permissions.has('students:manage');
    /** Guardians each student will have after the links planned so far. */
    const guardianCount = new Map<string, number>();
    const students = await Student.find(scope(ctx, { admissionNo: { $in: [...admissionNos] }, ...campusScope(ctx) }))
      .select('admissionNo guardians')
      .lean();
    const studentByNo = new Map(students.map((s) => [s.admissionNo, s]));
    const seenPhone = new Map<string, number>();
    const seenCnic = new Map<string, number>();
    const out: RowPlan<Payload>[] = [];

    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      const name = r.req('name', (v) => parseText(v, 100, 2));
      const phone = r.req('phone', parsePhone);
      const relation = r.opt('relation', parseRelation);
      const cnic = r.opt('cnic', parseCnic);
      const email = r.opt('email', parseEmail);
      const whatsapp = r.opt('whatsapp', parsePhone);
      const occupation = r.opt('occupation', (v) => parseText(v, 80));
      const address = r.opt('address', (v) => parseText(v, 300));
      const kids = splitList(r.raw('childAdmissionNos'));
      const kidRecords = kids.map((no) => ({ no, s: studentByNo.get(no) }));
      const unknown = kidRecords.filter((k) => !k.s).map((k) => k.no);
      if (unknown.length)
        r.error('childAdmissionNos', `no student with Admission No ${unknown.join(', ')} (that you can access)`);
      if (kids.length && !canLinkChildren)
        r.error('childAdmissionNos', 'linking children needs permission to edit students (students:manage)');
      if (name && phone) {
        const fields = { name, phone, relation, cnic, email, whatsapp, occupation, address };
        const parsed = ParentInline.safeParse(
          Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
        );
        if (!parsed.success) for (const i of parsed.error.issues) r.error(String(i.path[0] ?? ''), i.message);
      }
      const plan: RowPlan<Payload> = { rowNo: row.rowNo, check: 'create', issues: r.issues, changes: [], key: phone };
      if (r.failed || !name || !phone) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const key = phoneKey(phone);
      const firstRow = seenPhone.get(key);
      if (firstRow) {
        plan.issues.push({
          level: 'error',
          field: 'phone',
          message: `The same phone number also appears on row ${firstRow}`,
        });
        out.push({ ...plan, check: 'duplicate' });
        continue;
      }
      seenPhone.set(key, row.rowNo);
      const candidates = byKey.get(key) ?? [];
      const sameName = candidates.filter((c) => nameKey(c.name) === nameKey(name));
      const match = candidates.length === 1 ? candidates[0] : sameName.length === 1 ? sameName[0] : undefined;
      if (candidates.length > 1 && !match) {
        plan.issues.push({
          level: 'error',
          field: 'phone',
          message: `${label('phone')}: ${candidates.length} parents in the system have this number; update the right one by hand`,
        });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      if (cnic) {
        const owner = byCnic.get(cnic);
        if (owner && phoneKey(owner.phone) !== key) {
          plan.issues.push({
            level: 'error',
            field: 'cnic',
            message: `${label('cnic')}: already belongs to another parent in the system (with a different phone number)`,
          });
          out.push({ ...plan, check: 'invalid' });
          continue;
        }
        const other = seenCnic.get(cnic);
        if (other) {
          plan.issues.push({ level: 'error', field: 'cnic', message: `${label('cnic')}: also given on row ${other}` });
          out.push({ ...plan, check: 'invalid' });
          continue;
        }
        seenCnic.set(cnic, row.rowNo);
      }
      // An existing parent keeps the number as stored.
      const data: Payload['data'] = {
        name,
        phone: match?.phone ?? phone,
        relation,
        cnic,
        email,
        whatsapp,
        occupation,
        address,
      };
      const link = kidRecords
        .filter((k) => k.s && !(match && k.s.guardians.some((g) => String(g.parentId) === String(match._id))))
        .map((k) => ({ studentId: String(k.s!._id), admissionNo: k.no, hasGuardians: k.s!.guardians.length > 0 }));
      const countNow = (l: (typeof link)[number]) =>
        guardianCount.get(l.studentId) ?? kidRecords.find((k) => k.no === l.admissionNo)!.s!.guardians.length;
      const full = link.filter((l) => countNow(l) >= MAX_GUARDIANS);
      if (full.length) {
        plan.issues.push({
          level: 'error',
          field: 'childAdmissionNos',
          message: `${label('childAdmissionNos')}: ${full.map((f) => f.admissionNo).join(', ')} already has ${MAX_GUARDIANS} parents or guardians`,
        });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const countLinks = () => {
        for (const l of link) guardianCount.set(l.studentId, countNow(l) + 1);
      };
      if (!match) {
        countLinks();
        out.push({ ...plan, payload: { data, link } });
        continue;
      }
      const changes: Change[] = [];
      for (const f of UPDATABLE) {
        const to = data[f];
        if (to === undefined || to === '') continue;
        const from = (match as Record<string, unknown>)[f] ?? '';
        if (String(from) !== String(to)) changes.push({ field: f, from: show(from), to: show(to) });
      }
      for (const l of link) changes.push({ field: 'childAdmissionNos', from: '—', to: `link ${l.admissionNo}` });
      if (options.mode === 'upsert' && changes.length) {
        countLinks();
        out.push({ ...plan, check: 'update', changes, existingId: String(match._id), payload: { data, link } });
      } else {
        out.push({
          ...plan,
          check: options.mode === 'upsert' ? 'unchanged' : 'exists',
          existingId: String(match._id),
          changes: options.mode === 'upsert' ? [] : changes,
          issues: [
            ...plan.issues,
            {
              level: 'info',
              message:
                options.mode === 'upsert'
                  ? 'Already in the system with the same details'
                  : `Already in the system (phone ${match.phone}); skipped${link.length ? '. Choose "Add and update" to link the children' : ''}`,
            },
          ],
        });
      }
    }
    return { rows: out, warnings: [] };
  },

  async apply(ctx, plan) {
    const { data, link } = plan.payload!;
    const relation = data.relation ?? 'guardian';
    // Checked before anything is written: a student filled up since the check fails the row
    // without creating the parent. linkChild() re-checks atomically for concurrent changes.
    await assertRoomForGuardian(ctx, link, plan.existingId);
    const set: Record<string, unknown> = {};
    if (plan.check === 'update')
      for (const c of plan.changes)
        if (c.field !== 'childAdmissionNos') set[c.field] = data[c.field as keyof Payload['data']];
    // Parent and its links: one transaction on a replica set (see atomic()), so a failed link
    // never leaves a new parent record behind or an update half-applied. Audits come after.
    const { parentId, linked } = await atomic(async () => {
      let id = plan.existingId;
      let createdId: string | undefined;
      const added: string[] = [];
      try {
        if (!id) {
          const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
          const doc = await Parent.create({ ...clean, schoolId: ctx.schoolId });
          id = createdId = String(doc._id);
        }
        for (const l of link) if (await linkChild(ctx, l.studentId, id, relation)) added.push(l.studentId);
        // After the links on purpose: on standalone MongoDB nothing is changed if a link fails.
        if (Object.keys(set).length)
          await Parent.updateOne(scope(ctx, { _id: oid(id) }), { $set: set }, { runValidators: true });
        return { parentId: id, linked: added };
      } catch (err) {
        if (inTransaction()) throw err; // the transaction abort undoes every write above
        // No multi-document transactions on standalone MongoDB: undo this row's links and the
        // parent it created, so a failed row leaves the data as it was.
        for (const sid of added)
          await Student.updateOne(scope(ctx, { _id: oid(sid) }), { $pull: { guardians: { parentId: oid(id!) } } });
        if (createdId) await Parent.deleteOne(scope(ctx, { _id: oid(createdId) }));
        throw err;
      }
    });
    if (plan.check === 'update') {
      if (Object.keys(set).length)
        await audit(ctx, {
          action: 'parent.update',
          entityType: 'Parent',
          entityId: parentId,
          metadata: { fields: Object.keys(set), source: 'import' },
        });
    } else {
      await audit(ctx, {
        action: 'parent.create',
        entityType: 'Parent',
        entityId: parentId,
        metadata: { source: 'import' },
      });
    }
    for (const sid of linked)
      await audit(ctx, {
        action: 'student.update',
        entityType: 'Student',
        entityId: sid,
        metadata: { guardianAdded: parentId, source: 'import' },
      });
    const linkedText = link.length ? `; linked ${link.map((l) => l.admissionNo).join(', ')}` : '';
    return {
      result: plan.check === 'update' ? 'updated' : 'created',
      entityId: parentId,
      message: `Phone ${data.phone}${linkedText}`,
    };
  },
};

function tooManyGuardians(admissionNo?: string) {
  return conflict(
    `${admissionNo ?? 'This student'} already has ${MAX_GUARDIANS} parents or guardians`,
    undefined,
    'TOO_MANY_GUARDIANS',
  );
}

/** Every student to link (that does not already have this parent) has room for one more guardian. */
async function assertRoomForGuardian(ctx: SchoolContext, link: Payload['link'], parentId?: string) {
  if (!link.length) return;
  const students = await Student.find(
    scope(ctx, { _id: { $in: link.map((l) => oid(l.studentId)) }, ...campusScope(ctx) }),
  )
    .select('guardians admissionNo')
    .lean();
  for (const st of students) {
    if (parentId && st.guardians.some((g) => String(g.parentId) === parentId)) continue;
    if (st.guardians.length >= MAX_GUARDIANS) throw tooManyGuardians(st.admissionNo);
  }
}

/**
 * Add the parent to a student's guardians (once). The first guardian of a student is primary.
 * Returns whether a link was added (false when already linked or the student is not visible).
 */
async function linkChild(ctx: SchoolContext, studentId: string, parentId: string, relation: string) {
  const student = await Student.findOne(scope(ctx, { _id: oid(studentId), ...campusScope(ctx) }))
    .select('guardians')
    .lean();
  if (!student || student.guardians.some((g) => String(g.parentId) === parentId)) return false;
  // Atomic: never a duplicate link and never more than four guardians, even under concurrency.
  const res = await Student.updateOne(
    scope(ctx, {
      _id: student._id,
      'guardians.parentId': { $ne: oid(parentId) },
      [`guardians.${MAX_GUARDIANS - 1}`]: { $exists: false },
    }),
    { $push: { guardians: { parentId: oid(parentId), relation, isPrimary: student.guardians.length === 0 } } },
  );
  if (!res.modifiedCount) {
    const now = await Student.findOne(scope(ctx, { _id: student._id }))
      .select('guardians admissionNo')
      .lean();
    if (now?.guardians.some((g) => String(g.parentId) === parentId)) return false;
    throw tooManyGuardians(now?.admissionNo);
  }
  return true;
}

function splitList(raw: string) {
  return [
    ...new Set(
      raw
        .split(/[,;|\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
