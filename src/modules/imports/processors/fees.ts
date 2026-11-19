import { atomic } from '../../../database/transactions';
import type { SchoolContext } from '../../../types/context';
import { parseDateOnly, todayInTz } from '../../../utils/dates';
import { campusScope, oid, scope } from '../../../utils/tenant';
import { audit } from '../../audit/audit.service';
import { FeeHead, FeeStructure, Invoice } from '../../fees/fees.models';
import { allocateNumbers, feeSettings } from '../../fees/fees.service';
import { Parent, Student } from '../../students/student.models';
import { fieldLabel } from '../import-fields';
import { nameKey, parseFeeAmount, parseText, personNameKey, phoneKey } from '../import-values';
import { SchoolRefs } from './school-refs';
import { RowReader, type Change, type ImportOptions, type Processor, type RowPlan, breathe } from './types';

interface Payload {
  studentId: string;
  /** The monthly fee head to set (absent: create the default "Monthly Fee" head first). */
  feeHeadId?: string;
  monthlyFee?: number;
  /** Previous dues: create the opening invoice, or change the unpaid one that exists. */
  dues?: { amount: number; existingId?: string };
  duesUpTo: string;
  notes?: string;
}

const label = (f: string) => fieldLabel('fees', f);
const rs = (n: number) => `Rs ${n.toLocaleString('en-PK')}`;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (period: string) => `${MONTH_NAMES[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
/** Default code of the monthly fee head created when a school has none yet. */
const DEFAULT_HEAD = { code: 'MONTHLY', name: 'Monthly Fee' };

type StudentRef = {
  id: string;
  name: string;
  admissionNo: string;
  classId: string;
  sectionId: string;
  campusId: string;
  status: string;
  parentIds: string[];
  customFees: Array<{ feeHeadId: string; amount: number }>;
  concession?: { type?: string | null; value?: number | null } | null;
};

/** The previous month in the school's time zone: the usual "dues up to" month. */
export function previousMonth(today: string) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The monthly fee head the Monthly Fee column sets: the chosen one, else the school's tuition head. */
async function resolveHead(ctx: SchoolContext, options: ImportOptions) {
  const heads = await FeeHead.find(scope(ctx, { isActive: true, frequency: 'monthly' }))
    .select('name code concessionApplies')
    .lean();
  if (options.feeHeadId) {
    const chosen = heads.find((h) => String(h._id) === options.feeHeadId);
    return chosen
      ? { head: chosen }
      : { problem: 'The chosen fee head is not an active monthly fee head of this school.' };
  }
  const head =
    heads.find((h) => /tuition|monthly/i.test(h.name) && h.concessionApplies) ??
    heads.find((h) => /tuition|monthly/i.test(h.name)) ??
    heads.find((h) => h.concessionApplies) ??
    heads[0];
  if (head) return { head };
  // A school with no monthly head yet gets one; refused if the code is taken by another kind of head.
  const taken = await FeeHead.exists(scope(ctx, { code: DEFAULT_HEAD.code }));
  return taken
    ? {
        problem: `Choose the monthly fee head: the fee head "${DEFAULT_HEAD.code}" exists but is not an active monthly head.`,
      }
    : { head: null };
}

/**
 * Student fees: each student's own monthly fee and the dues they bring from before School OS.
 * Students are found (by admission number, or by name within the class, told apart by the
 * father's name or phone) and never created or renamed. Previous dues become one "opening"
 * invoice per student (unique), so importing the same file again cannot add them twice.
 * "Add new" fills only what is not set yet; "update" also changes an own fee or unpaid previous
 * dues. Previous dues with a payment against them are never changed by an import.
 */
export const feesProcessor: Processor<Payload> = {
  async plan(ctx, rows, options) {
    const settings = await feeSettings(ctx.schoolId);
    const today = todayInTz(settings.timezone);
    const duesUpTo = options.duesUpTo ?? previousMonth(today);
    const warnings: string[] = [];
    const [refs, headInfo, students] = await Promise.all([
      SchoolRefs.load(ctx),
      resolveHead(ctx, options),
      Student.find(scope(ctx, { ...campusScope(ctx), status: { $ne: 'archived' } }))
        .select('firstName lastName admissionNo classId sectionId campusId status guardians customFees feeConcession')
        .lean(),
    ]);
    const parentIds = [...new Set(students.flatMap((s) => (s.guardians ?? []).map((g) => String(g.parentId))))];
    const studentIds = students.map((s) => s._id);
    const [parents, openings, open, structures] = await Promise.all([
      Parent.find(scope(ctx, { _id: { $in: parentIds.map(oid) } }))
        .select('name phone')
        .lean(),
      Invoice.find(scope(ctx, { kind: 'opening', studentId: { $in: studentIds } }))
        .select('studentId total paid status period')
        .lean(),
      Invoice.aggregate<{ _id: unknown; balance: number; count: number; lastPeriod: string }>([
        {
          $match: scope(ctx, {
            kind: { $ne: 'opening' },
            status: { $in: ['unpaid', 'partial'] },
            studentId: { $in: studentIds },
          }),
        },
        {
          $group: {
            _id: '$studentId',
            balance: { $sum: '$balance' },
            count: { $sum: 1 },
            lastPeriod: { $max: '$period' },
          },
        },
      ]),
      FeeStructure.find(scope(ctx, { isActive: true }))
        .select('classId sessionId items')
        .lean(),
    ]);
    const head = headInfo.head;
    if (headInfo.problem) warnings.push(headInfo.problem);
    else if (!head && rows.some((r) => r.cells.monthlyFee?.trim()))
      warnings.push(
        `Note · Your school has no monthly fee head yet: "${DEFAULT_HEAD.name}" (code ${DEFAULT_HEAD.code}) will be created for the monthly fees.`,
      );
    else if (head && rows.some((r) => r.cells.monthlyFee?.trim()))
      warnings.push(`Note · Monthly Fee sets the fee head "${head.name}".`);
    if (duesUpTo > today.slice(0, 7))
      warnings.push(`Previous dues cannot be up to ${monthLabel(duesUpTo)}: that month has not started yet.`);
    else if (rows.some((r) => r.cells.arrears?.trim()))
      warnings.push(
        `Note · Previous dues are recorded as owed up to the end of ${monthLabel(duesUpTo)}. Generate invoices from ${monthLabel(nextMonth(duesUpTo))} on.`,
      );
    if (options.mode === 'create')
      warnings.push(
        'Note · Students who already have an own fee or previous dues keep them (choose "update" to change them).',
      );

    const parentById = new Map(parents.map((p) => [String(p._id), p]));
    const openingBy = new Map(openings.map((o) => [String(o.studentId), o]));
    const openBy = new Map(open.map((o) => [String(o._id), o]));
    const classAmount = (classId: string) => {
      const items = structures.filter((s) => String(s.classId) === classId).flatMap((s) => s.items);
      return head ? items.find((i) => String(i.feeHeadId) === String(head._id))?.amount : undefined;
    };
    const refsOf = (s: (typeof students)[number]): StudentRef => ({
      id: String(s._id),
      name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
      admissionNo: s.admissionNo,
      classId: String(s.classId),
      sectionId: String(s.sectionId),
      campusId: String(s.campusId),
      status: s.status,
      parentIds: (s.guardians ?? []).map((g) => String(g.parentId)),
      customFees: (s.customFees ?? []).map((c) => ({ feeHeadId: String(c.feeHeadId), amount: c.amount })),
      concession: s.feeConcession,
    });
    const all = students.map(refsOf);
    const byAdmission = new Map(all.map((s) => [nameKey(s.admissionNo), s]));
    const className = (id: string) => refs.classes.find((c) => c.id === id)?.name ?? 'another class';
    const parentsOf = (s: StudentRef) => s.parentIds.map((id) => parentById.get(id)).filter(Boolean) as typeof parents;
    const seen = new Map<string, number>();
    const totals = new Map<
      string,
      { students: number; fees: number; feeRows: number; dues: number; dueRows: number }
    >();
    const out: RowPlan<Payload>[] = [];

    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      const name = r.req('studentName', (v) => parseText(v, 100));
      const classRaw = r.req('className', (v) => parseText(v, 40));
      const admissionNo = r.opt('admissionNo', (v) => parseText(v, 40));
      const father = r.opt('fatherName', (v) => parseText(v, 100));
      const phone = r.has('parentPhone') ? phoneKey(r.raw('parentPhone')) : '';
      const section = r.opt('sectionName', (v) => parseText(v, 20));
      const monthlyFee = r.opt('monthlyFee', (v) => parseFeeAmount(v, 1_000_000));
      const dues = r.opt('arrears', (v) => parseFeeAmount(v));
      const notes = r.opt('notes', (v) => parseText(v, 300));
      const plan: RowPlan<Payload> = { rowNo: row.rowNo, check: 'create', issues: r.issues, changes: [] };
      if (monthlyFee === undefined && dues === undefined && !r.failed)
        r.error(undefined, 'Enter a Monthly Fee or Previous Dues (both are empty)');
      if (headInfo.problem && monthlyFee !== undefined) r.error('monthlyFee', headInfo.problem);
      if (dues && duesUpTo > today.slice(0, 7))
        r.error('arrears', `the month ${monthLabel(duesUpTo)} has not started yet`);
      if (r.failed || !name || !classRaw) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }

      // ── Find the student ──
      const classes = refs.classes.filter((c) => nameKey(c.name) === nameKey(classRaw));
      let student: StudentRef | undefined;
      if (admissionNo) {
        student = byAdmission.get(nameKey(admissionNo));
        if (!student) r.error('admissionNo', `no student with admission number "${admissionNo}"`);
        else {
          if (!classes.some((c) => c.id === student!.classId))
            r.warn(
              'className',
              `"${classRaw}" in the file; in School OS ${student.name} is in ${className(student.classId)}`,
            );
          if (nameKey(student.name) !== nameKey(name) && personNameKey(student.name) !== personNameKey(name))
            r.warn('studentName', `"${name}" in the file; in School OS this admission number is ${student.name}`);
        }
      } else if (!classes.length) {
        const names = refs.classes.map((c) => c.name);
        r.error(
          'className',
          `"${classRaw}" is not a class in School OS${names.length ? ` (classes: ${[...new Set(names)].slice(0, 15).join(', ')})` : ''}`,
        );
      } else {
        const inClass = all.filter((s) => classes.some((c) => c.id === s.classId));
        let pool = inClass;
        if (section) {
          const sectionIds = new Set(
            refs.sections
              .filter((x) => classes.some((c) => c.id === x.classId) && nameKey(x.name) === nameKey(section))
              .map((x) => x.id),
          );
          if (!sectionIds.size) r.error('sectionName', `"${section}" is not a section of ${classRaw}`);
          pool = inClass.filter((s) => sectionIds.has(s.sectionId));
        }
        let found = pool.filter((s) => nameKey(s.name) === nameKey(name));
        if (!found.length) {
          found = pool.filter((s) => personNameKey(s.name) === personNameKey(name));
          if (found.length === 1) r.info('studentName', `"${name}" matched to ${found[0].name}`);
        }
        if (found.length > 1) {
          // Same name in the class: the father's name, then the phone, tells them apart.
          const byFather = father
            ? found.filter((s) => parentsOf(s).some((p) => personNameKey(p.name) === personNameKey(father)))
            : [];
          const byPhone = phone ? found.filter((s) => parentsOf(s).some((p) => phoneKey(p.phone) === phone)) : [];
          const narrowed = byFather.length === 1 ? byFather : byPhone.length === 1 ? byPhone : [];
          if (narrowed.length === 1) {
            r.info(
              undefined,
              `${found.length} students named ${name} in ${classRaw}: told apart by the ${byFather.length === 1 ? 'father’s name' : 'phone'}`,
            );
            found = narrowed;
          } else {
            // Siblings or cousins linked to one parent record: only the admission number helps.
            const shared = found.every((s) => s.parentIds.some((id) => found[0].parentIds.includes(id)));
            r.error(
              undefined,
              `${found.length} students named ${name} in ${classRaw} (admission no ${found.map((s) => s.admissionNo).join(', ')}). ${
                shared
                  ? 'They have the same parent in School OS, so only the Admission No tells them apart: add it'
                  : 'Add the Admission No, or a father’s name or phone that tells them apart'
              }`,
            );
          }
        }
        if (found.length === 1) student = found[0];
        else if (!found.length && !r.failed) {
          const elsewhere = all.filter(
            (s) => nameKey(s.name) === nameKey(name) || personNameKey(s.name) === personNameKey(name),
          );
          r.error(
            'studentName',
            elsewhere.length
              ? `no ${name} in ${classRaw}${section ? ` ${section}` : ''}; School OS has ${elsewhere
                  .slice(0, 3)
                  .map((s) => `${s.name} in ${className(s.classId)} (${s.admissionNo})`)
                  .join(', ')}. Check the class`
              : `no student named ${name} in ${classRaw}. Import or admit the student first`,
          );
        }
      }
      if (!student || r.failed) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      plan.existingId = student.id;
      plan.key = student.admissionNo;
      const first = seen.get(student.id);
      if (first) {
        plan.issues.push({
          level: 'error',
          message: `${student.name} (${student.admissionNo}) is also on row ${first}`,
        });
        out.push({ ...plan, check: 'duplicate' });
        continue;
      }
      seen.set(student.id, row.rowNo);

      // The father's name and phone only help find the student: a difference is shown, not changed.
      const ps = parentsOf(student);
      if (father && ps.length && !ps.some((p) => personNameKey(p.name) === personNameKey(father)))
        r.warn('fatherName', `"${father}" in the file; in School OS: ${ps.map((p) => p.name).join(', ')}`);
      if (phone && ps.length && !ps.some((p) => phoneKey(p.phone) === phone))
        r.warn(
          'parentPhone',
          `${r.raw('parentPhone')} in the file; in School OS: ${ps.map((p) => p.phone).join(', ')}`,
        );
      if (student.status !== 'active')
        r.warn(
          undefined,
          `${student.name} is ${student.status.replace('_', ' ')}: no monthly invoices are generated for them`,
        );

      // ── What changes ──
      const changes: Change[] = [];
      let creates = false;
      let updates = false;
      let kept = false;
      const payload: Payload = { studentId: student.id, duesUpTo, ...(notes ? { notes } : {}) };
      if (monthlyFee !== undefined) {
        const current = head ? student.customFees.find((c) => c.feeHeadId === String(head._id))?.amount : undefined;
        const classFee = classAmount(student.classId);
        if (current === monthlyFee) r.info('monthlyFee', `already ${rs(monthlyFee)}`);
        else if (current !== undefined && options.mode === 'create') {
          kept = true;
          r.info('monthlyFee', `already has an own fee of ${rs(current)}; kept`);
        } else {
          if (current === undefined) creates = true;
          else updates = true;
          payload.monthlyFee = monthlyFee;
          payload.feeHeadId = head ? String(head._id) : undefined;
          changes.push({
            field: label('monthlyFee'),
            from: current !== undefined ? rs(current) : classFee !== undefined ? `class fee ${rs(classFee)}` : '—',
            to: rs(monthlyFee),
          });
          if (monthlyFee === 0) r.info('monthlyFee', 'Rs 0: no monthly fee is billed for this student');
          const c = student.concession;
          if (c?.type && c.type !== 'none' && c.value)
            r.warn(
              'monthlyFee',
              `${student.name} also has a standing concession (${c.type === 'percent' ? `${c.value}%` : rs(c.value)}); it is still taken off this fee`,
            );
        }
      }
      if (dues !== undefined) {
        const existing = openingBy.get(student.id);
        const live = existing && existing.status !== 'cancelled' ? existing : undefined;
        if (live && live.total === dues) r.info('arrears', `already ${rs(dues)}`);
        else if (live && options.mode === 'create') {
          kept = true;
          r.info('arrears', `previous dues of ${rs(live.total)} already recorded; kept`);
        } else if (live && (live.paid > 0 || live.status !== 'unpaid')) {
          r.error(
            'arrears',
            `${rs(live.paid)} has already been paid against the previous dues of ${rs(live.total)}; they cannot be changed by an import (use a waiver or a new charge)`,
          );
        } else if (!live && dues === 0) {
          // Nothing owed and nothing recorded: nothing to do.
        } else if (live && dues === 0) {
          r.error(
            'arrears',
            `0 in the file, but previous dues of ${rs(live.total)} are recorded. Cancel that invoice to remove them`,
          );
        } else if (existing && !live) {
          r.error(
            'arrears',
            `the previous dues invoice of this student was cancelled; add new dues as a charge instead`,
          );
        } else {
          if (live) updates = true;
          else creates = true;
          payload.dues = { amount: dues, ...(live ? { existingId: String(live._id) } : {}) };
          changes.push({ field: label('arrears'), from: live ? rs(live.total) : '—', to: rs(dues) });
          const o = openBy.get(student.id);
          if (o)
            r.warn(
              'arrears',
              `School OS already has ${rs(o.balance)} due on ${o.count} invoice${o.count > 1 ? 's' : ''} (up to ${monthLabel(o.lastPeriod)}); the previous dues are added on top. Make sure they do not include the same months`,
            );
        }
      }
      if (r.failed) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      plan.changes = changes;
      plan.check = updates ? 'update' : creates ? 'create' : kept ? 'exists' : 'unchanged';
      if (updates || creates) {
        plan.payload = payload;
        const t = totals.get(student.classId) ?? { students: 0, fees: 0, feeRows: 0, dues: 0, dueRows: 0 };
        t.students++;
        if (payload.monthlyFee !== undefined) {
          t.fees += payload.monthlyFee;
          t.feeRows++;
        }
        if (payload.dues) {
          t.dues += payload.dues.amount;
          t.dueRows++;
        }
        totals.set(student.classId, t);
      }
      out.push(plan);
    }

    // Totals to compare with the school's own register before confirming.
    const all_ = [...totals.values()].reduce(
      (a, t) => ({
        fees: a.fees + t.fees,
        feeRows: a.feeRows + t.feeRows,
        dues: a.dues + t.dues,
        dueRows: a.dueRows + t.dueRows,
      }),
      { fees: 0, feeRows: 0, dues: 0, dueRows: 0 },
    );
    if (totals.size) {
      warnings.push(
        `Totals · All classes: monthly fees for ${all_.feeRows} students (together ${rs(all_.fees)} a month), previous dues for ${all_.dueRows} students (together ${rs(all_.dues)}).`,
      );
      const order = (id: string) => refs.classes.find((c) => c.id === id)?.level ?? 99;
      for (const [classId, t] of [...totals].sort(
        ([a], [b]) => order(a) - order(b) || className(a).localeCompare(className(b)),
      ))
        warnings.push(
          `Totals · ${className(classId)}: ${t.students} students; monthly fees ${rs(t.fees)} (${t.feeRows}); previous dues ${rs(t.dues)} (${t.dueRows}).`,
        );
    }
    return { rows: out, warnings };
  },

  async apply(ctx, plan) {
    const p = plan.payload!;
    const settings = await feeSettings(ctx.schoolId);
    const today = parseDateOnly(todayInTz(settings.timezone));
    let feeHeadId = p.feeHeadId;
    if (p.monthlyFee !== undefined && !feeHeadId) {
      // The school's first monthly fee head (shared by all rows; created once).
      const headDoc = await FeeHead.findOneAndUpdate(
        scope(ctx, { code: DEFAULT_HEAD.code }),
        {
          $setOnInsert: {
            name: DEFAULT_HEAD.name,
            frequency: 'monthly',
            concessionApplies: true,
            isActive: true,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      if (headDoc!.frequency !== 'monthly' || !headDoc!.isActive)
        throw new Error(`Fee head ${DEFAULT_HEAD.code} is not an active monthly head`);
      feeHeadId = String(headDoc!._id);
    }
    return atomic(async () => {
      const student = await Student.findOne(scope(ctx, { _id: oid(p.studentId) }))
        .select('firstName lastName campusId classId sectionId sessionId customFees status')
        .lean();
      if (!student) return { result: 'skipped' as const, message: 'The student no longer exists' };
      const done: string[] = [];
      let changed = false;
      if (p.monthlyFee !== undefined && feeHeadId) {
        const others = (student.customFees ?? []).filter((c) => String(c.feeHeadId) !== feeHeadId);
        await Student.updateOne(scope(ctx, { _id: student._id }), {
          $set: {
            customFees: [
              ...others,
              {
                feeHeadId: oid(feeHeadId),
                amount: p.monthlyFee,
                source: 'import',
                setAt: new Date(),
                setBy: oid(ctx.userId),
              },
            ],
          },
        });
        done.push(`monthly fee ${rs(p.monthlyFee)}`);
        changed = true;
      }
      let invoiceId: unknown;
      if (p.dues) {
        const item = { name: `Previous dues (up to ${monthLabel(p.duesUpTo)})`, amount: p.dues.amount };
        if (p.dues.existingId) {
          // Only while nothing has been paid against it (checked again here, atomically).
          const updated = await Invoice.findOneAndUpdate(
            scope(ctx, { _id: oid(p.dues.existingId), kind: 'opening', paid: 0, status: 'unpaid' }),
            {
              $set: {
                items: [item],
                subtotal: p.dues.amount,
                total: p.dues.amount,
                balance: p.dues.amount,
                period: p.duesUpTo,
                ...(p.notes ? { notes: p.notes } : {}),
              },
            },
            { returnDocument: 'after' },
          ).lean();
          if (!updated) throw new Error('The previous dues were paid or changed meanwhile; check this student again');
          invoiceId = updated._id;
        } else if (p.dues.amount > 0) {
          const seq = await allocateNumbers(ctx.schoolId, 'invoice', 1);
          const [doc] = await Invoice.create(
            [
              {
                schoolId: ctx.schoolId,
                campusId: student.campusId,
                studentId: student._id,
                sessionId: student.sessionId,
                classId: student.classId,
                sectionId: student.sectionId,
                invoiceNo: `${settings.fees.invoicePrefix ?? 'INV-'}${p.duesUpTo.replace('-', '')}-${String(seq).padStart(6, '0')}`,
                kind: 'opening',
                period: p.duesUpTo,
                issueDate: today,
                dueDate: today,
                items: [item],
                subtotal: p.dues.amount,
                concession: 0,
                waiver: 0,
                lateFee: 0,
                total: p.dues.amount,
                paid: 0,
                balance: p.dues.amount,
                status: 'unpaid',
                notes: p.notes,
                createdBy: ctx.userId,
              },
            ],
            { ordered: true },
          );
          invoiceId = doc._id;
        }
        done.push(`previous dues ${rs(p.dues.amount)}`);
        changed = true;
      }
      await audit(ctx, {
        action: 'fees.import_student',
        entityType: 'Student',
        entityId: student._id,
        summary: `Fee import: ${done.join(', ')}`,
        metadata: {
          source: 'import',
          monthlyFee: p.monthlyFee,
          feeHeadId,
          previousDues: p.dues?.amount,
          duesUpTo: p.duesUpTo,
          invoiceId: invoiceId ? String(invoiceId) : undefined,
        },
      });
      return {
        result: (plan.check === 'update' ? 'updated' : 'created') as 'updated' | 'created',
        entityId: String(student._id),
        message: changed ? done.join(', ') : undefined,
      };
    });
  },
};

/** The month after a YYYY-MM period. */
function nextMonth(period: string) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
