import type { SchoolContext } from '../../types/context';
import { parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, conflict, setupRequired, unprocessable } from '../../utils/errors';
import { assertCampusAccess, findOwned, oid, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Student } from '../students/student.models';
import { billableItems, computeTotals } from './fee-calc';
import { FeeHead, FeeStructure, Invoice } from './fees.models';
import { allocateNumbers, feeSettings } from './fees.service';

type Ctx = SchoolContext;

/**
 * One student's invoice for a billing period: what the class fee structure bills this month
 * (the same rules as class-wide generation), plus optional per-student charges such as
 * transport. Discounts follow the existing rules: the standing concession applies
 * automatically; any other reduction is a waiver request, which needs approval.
 */
export async function studentInvoicePreview(ctx: Ctx, studentId: string, period: string) {
  const student = await findOwned(Student, ctx, studentId, 'Student');
  assertCampusAccess(ctx, student.campusId);
  const settings = await feeSettings(ctx.schoolId);
  const [cls, section, session, existing, prior, structure, heads] = await Promise.all([
    SchoolClass.findOne(scope(ctx, { _id: student.classId }))
      .select('name')
      .lean(),
    Section.findOne(scope(ctx, { _id: student.sectionId }))
      .select('name')
      .lean(),
    AcademicSession.findOne(scope(ctx, { _id: student.sessionId }))
      .select('name')
      .lean(),
    Invoice.findOne(scope(ctx, { studentId: student._id, period, kind: 'regular' }))
      .select('invoiceNo status total balance')
      .lean(),
    Invoice.exists(scope(ctx, { studentId: student._id, kind: 'regular' })),
    FeeStructure.findOne(scope(ctx, { sessionId: student.sessionId, classId: student.classId, isActive: true })).lean(),
    FeeHead.find(scope(ctx, { isActive: true })).lean(),
  ]);
  const headById = new Map(heads.map((h) => [h._id.toString(), h]));
  const enriched = (structure?.items ?? [])
    .map((i) => ({ ...i, head: headById.get(i.feeHeadId.toString()) }))
    .filter((i) => i.head && i.head.billing !== 'per_student')
    .map((i) => ({
      feeHeadId: i.feeHeadId.toString(),
      name: i.head!.name,
      amount: i.amount,
      concessionApplies: i.head!.concessionApplies,
      frequency: i.head!.frequency,
      billingMonths: i.billingMonths,
    }));
  const items = billableItems(enriched, period, !prior).map(({ frequency: _f, billingMonths: _b, ...rest }) => rest);
  const totals = computeTotals({ items, concession: student.feeConcession as never });
  const dueDay = Math.min(settings.fees.invoiceDueDay ?? 10, 28);
  const notCurrentSession = settings.currentSessionId !== student.sessionId.toString();
  return {
    student: {
      _id: student._id.toString(),
      name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
      admissionNo: student.admissionNo,
      status: student.status,
      className: cls?.name ?? null,
      sectionName: section?.name ?? null,
      sessionName: session?.name ?? null,
      concession: student.feeConcession?.type && student.feeConcession.type !== 'none' ? student.feeConcession : null,
    },
    period,
    defaultDueDate: `${period}-${String(dueDay).padStart(2, '0')}`,
    existingInvoice: existing
      ? {
          _id: existing._id.toString(),
          invoiceNo: existing.invoiceNo,
          status: existing.status,
          total: existing.total,
          balance: existing.balance,
        }
      : null,
    structure: structure ? { _id: structure._id.toString(), name: structure.name } : null,
    firstInvoice: !prior,
    items,
    totals,
    perStudentHeads: heads
      .filter((h) => h.billing === 'per_student')
      .map((h) => ({ _id: h._id.toString(), name: h.name, frequency: h.frequency })),
    problems: [
      ...(student.status !== 'active' ? [`The student is ${student.status}; only active students are invoiced.`] : []),
      ...(notCurrentSession ? ['The student is not in the current academic session.'] : []),
      ...(!structure ? [`${cls?.name ?? 'This class'} has no fee structure for this session yet.`] : []),
    ],
  };
}

export async function createStudentInvoice(
  ctx: Ctx,
  studentId: string,
  input: { period: string; dueDate?: string; extraItems?: Array<{ feeHeadId: string; amount: number }> },
) {
  const preview = await studentInvoicePreview(ctx, studentId, input.period);
  if (preview.existingInvoice)
    throw conflict(
      `${preview.student.name} already has invoice ${preview.existingInvoice.invoiceNo} for this month. Open it instead of creating another.`,
      { invoiceId: preview.existingInvoice._id, invoiceNo: preview.existingInvoice.invoiceNo },
      'DUPLICATE',
    );
  if (preview.student.status !== 'active') throw unprocessable(preview.problems[0]);
  const settings = await feeSettings(ctx.schoolId);
  if (!settings.currentSessionId)
    throw setupRequired('Set the current academic session in Academics → Sessions first.', 'current_session');
  if (
    settings.currentSessionId !==
    (
      await Student.findOne(scope(ctx, { _id: oid(studentId) }))
        .select('sessionId')
        .lean()
    )?.sessionId?.toString()
  )
    throw unprocessable('The student is not in the current academic session, so a monthly invoice cannot be created.');

  const extra = input.extraItems ?? [];
  const ids = extra.map((e) => e.feeHeadId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each extra charge may appear only once');
  const allowed = new Map(preview.perStudentHeads.map((h) => [h._id, h]));
  const extraItems = extra.map((e) => {
    const head = allowed.get(e.feeHeadId);
    if (!head)
      throw badRequest(
        'Extra charges must be active per-student fee heads (for example transport)',
        undefined,
        'INVALID_REFERENCE',
      );
    if (!Number.isInteger(e.amount) || e.amount < 1) throw badRequest(`Enter an amount for ${head.name}`);
    return { feeHeadId: oid(e.feeHeadId), name: head.name, amount: e.amount, concessionApplies: false };
  });
  const items = [...preview.items.map((i) => ({ ...i, feeHeadId: oid(i.feeHeadId) })), ...extraItems];
  if (!items.length)
    throw unprocessable(
      preview.problems[0] ?? 'Nothing is billed to this student for this month. Add a charge or choose another month.',
      undefined,
      'NOTHING_DUE',
    );
  const student = await Student.findOne(scope(ctx, { _id: oid(studentId) }))
    .select('campusId sessionId classId sectionId feeConcession')
    .lean();
  const totals = computeTotals({ items, concession: student!.feeConcession as never });
  const seq = await allocateNumbers(ctx.schoolId, 'invoice', 1);
  let doc;
  try {
    doc = await Invoice.create({
      schoolId: ctx.schoolId,
      campusId: student!.campusId,
      studentId: student!._id,
      sessionId: student!.sessionId,
      classId: student!.classId,
      sectionId: student!.sectionId,
      invoiceNo: `${settings.fees.invoicePrefix ?? 'INV-'}${input.period.replace('-', '')}-${String(seq).padStart(6, '0')}`,
      kind: 'regular',
      period: input.period,
      issueDate: parseDateOnly(todayInTz(settings.timezone)),
      dueDate: parseDateOnly(input.dueDate ?? preview.defaultDueDate),
      items,
      ...totals,
      paid: 0,
      balance: totals.total,
      status: totals.total === 0 ? 'paid' : 'unpaid',
      createdBy: ctx.userId,
    });
  } catch (err) {
    // Two requests for the same student and month at the same moment: the index let one through.
    if ((err as { code?: number }).code === 11000) {
      const winner = await Invoice.findOne(
        scope(ctx, { studentId: student!._id, period: input.period, kind: 'regular' }),
      )
        .select('invoiceNo')
        .lean();
      throw conflict(
        `An invoice for this month was just created (${winner?.invoiceNo ?? 'reload to see it'}).`,
        winner ? { invoiceId: winner._id.toString(), invoiceNo: winner.invoiceNo } : undefined,
        'DUPLICATE',
      );
    }
    throw err;
  }
  await audit(ctx, {
    action: 'invoice.create_for_student',
    entityType: 'Invoice',
    entityId: doc._id,
    metadata: { period: input.period, total: totals.total, extraCharges: extraItems.length },
  });
  return doc.toObject();
}
