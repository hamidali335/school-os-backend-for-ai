import { Types } from 'mongoose';
import { Counter } from '../../database/counter.model';
import {
  atomic,
  detectTopology,
  inTransaction,
  mongoTopology,
  transactionsSupported,
} from '../../database/transactions';
import type { SchoolContext, SystemContext } from '../../types/context';
import { addDays, formatDateOnly, localDayRange, parseDateOnly, todayInTz } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { badRequest, conflict, notFound, setupRequired, unprocessable } from '../../utils/errors';
import { paginate, searchRegex } from '../../utils/pagination';
import { studentIdsMatching } from '../students/student-search';
import { assertCampusAccess, assertRefs, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { assertStudentVisible, visibleStudentIds } from '../academics/access.service';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { createApprovalRequest } from '../approvals/approvals.service';
import { audit } from '../audit/audit.service';
import { School } from '../schools/school.model';
import { Student, StudentEnrollment } from '../students/student.models';
import { notifyUsers, parentUserIdsForStudents } from '../communications/communications.service';
import type { PaymentMethod } from '../accounts/accounts.models';
import {
  allocatePayment,
  billableItems,
  computeTotals,
  autoAllocate,
  headBreakdown,
  receiptLines,
  installmentStatus,
  splitInstallments,
  validateHeadAllocation,
} from './fee-calc';
import { FeeHead, FeeStructure, Invoice, Payment } from './fees.models';
import { recordChange } from '../sync/sync.service';

type Ctx = SchoolContext;
type AnyCtx = SchoolContext | SystemContext;

/** Mongoose 9 requires explicit opt-in for aggregation-pipeline updates. */
const PIPELINE = { updatePipeline: true } as Record<string, unknown>;

/** Recompute status from total/paid/waiver inside an update pipeline (atomic). */
const STATUS_STAGE = {
  $set: {
    status: {
      $cond: [
        { $eq: ['$status', 'cancelled'] },
        'cancelled',
        {
          $cond: [
            { $lte: ['$balance', 0] },
            { $cond: [{ $and: [{ $eq: ['$paid', 0] }, { $gt: ['$waiver', 0] }] }, 'waived', 'paid'] },
            { $cond: [{ $gt: ['$paid', 0] }, 'partial', 'unpaid'] },
          ],
        },
      ],
    },
  },
};

export async function allocateNumbers(schoolId: string, key: string, count: number): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { schoolId: oid(schoolId), key },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return doc!.seq - count + 1;
}

export async function feeSettings(schoolId: string) {
  const school = await School.findById(schoolId)
    .select('settings.fees settings.timezone settings.currentSessionId')
    .lean();
  if (!school) throw notFound('School');
  return {
    fees: (school.settings?.fees ?? {}) as {
      invoiceDueDay?: number;
      invoicePrefix?: string;
      receiptPrefix?: string;
      lateFeeAmount?: number;
    },
    timezone: school.settings?.timezone ?? 'Asia/Karachi',
    currentSessionId: school.settings?.currentSessionId?.toString(),
  };
}

// ───────────────────────────── Fee structures ─────────────────────────────

export async function upsertFeeStructure(
  ctx: Ctx,
  input: {
    sessionId: string;
    classId: string;
    name: string;
    items: Array<{ feeHeadId: string; amount: number; billingMonths?: number[] }>;
  },
) {
  await assertRefs(ctx, [
    [AcademicSession, input.sessionId, 'sessionId'],
    [SchoolClass, input.classId, 'classId'],
  ]);
  await checkStructureItems(ctx, input.items);
  const doc = await FeeStructure.findOneAndUpdate(
    scope(ctx, { sessionId: oid(input.sessionId), classId: oid(input.classId) }),
    { $set: { name: input.name, items: input.items, isActive: true } },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  await audit(ctx, { action: 'fee_structure.upsert', entityType: 'FeeStructure', entityId: doc!._id });
  return doc;
}

/**
 * The rules every class fee structure (and the school's default template) follows: each head once,
 * heads of this school, a month for annual and term heads, and no per-student heads (those go on
 * individual invoices).
 */
export async function checkStructureItems(
  ctx: Ctx,
  items: Array<{ feeHeadId: string; amount: number; billingMonths?: number[] }>,
) {
  const headIds = [...new Set(items.map((i) => i.feeHeadId))];
  if (headIds.length !== items.length) throw badRequest('Each fee head may appear only once in a structure');
  const heads = await FeeHead.find(scope(ctx, { _id: { $in: headIds.map(oid) } })).lean();
  if (heads.length !== headIds.length)
    throw badRequest('One or more fee heads do not exist in this school', undefined, 'INVALID_REFERENCE');
  for (const item of items) {
    const head = heads.find((h) => h._id.toString() === item.feeHeadId)!;
    if ((head.frequency === 'annual' || head.frequency === 'term') && !item.billingMonths?.length) {
      throw badRequest(`"${head.name}" is billed in chosen months: pick at least one month`);
    }
    if (head.billing === 'per_student')
      throw badRequest(
        `"${head.name}" is charged per student, not to the whole class. Add it to individual invoices instead.`,
        [{ path: 'body.items', message: `${head.name} is a per-student fee` }],
        'VALIDATION_ERROR',
      );
  }
}

// ───────────────────────────── Invoice generation ─────────────────────────────

async function prepareInvoiceDrafts(
  ctx: Ctx,
  input: { period: string; sessionId?: string; classId?: string; sectionId?: string; studentIds?: string[]; dueDate?: string },
) {
  const settings = await feeSettings(ctx.schoolId);
  const sessionId = input.sessionId ?? settings.currentSessionId;
  if (!sessionId)
    throw setupRequired(
      'Invoices cannot be generated because no academic session was specified and the school has no current academic session. Set the current session in Academics → Sessions, then try again.',
      'current_session',
    );
  await assertRefs(ctx, [
    [SchoolClass, input.classId, 'classId'],
    [Section, input.sectionId, 'sectionId'],
  ]);
  const session = await AcademicSession.findOne(scope(ctx, { _id: oid(sessionId) }))
    .select('name')
    .lean();
  if (!session)
    throw setupRequired(
      'Invoices cannot be generated because the specified academic session no longer exists. Choose the session in Academics → Sessions, then try again.',
      'current_session',
    );

  // Student resolution:
  // First check if StudentEnrollment records exist for this session
  const enrollmentFilter: Record<string, unknown> = scope(ctx, {
    sessionId: oid(sessionId),
    status: { $in: ['active', 'repeating'] },
    ...campusScope(ctx),
  });
  if (input.classId) enrollmentFilter.classId = oid(input.classId);
  if (input.sectionId) enrollmentFilter.sectionId = oid(input.sectionId);
  if (input.studentIds?.length) enrollmentFilter.studentId = { $in: input.studentIds.map(oid) };

  const sessionEnrollments = await StudentEnrollment.find(enrollmentFilter).lean();

  let students: Array<{
    _id: Types.ObjectId;
    campusId: Types.ObjectId;
    classId: Types.ObjectId;
    sectionId: Types.ObjectId;
    sessionId: Types.ObjectId;
    feeConcession?: any;
    customFees?: any;
  }> = [];

  let skippedExcluded = 0;
  const selection: Record<string, unknown> = scope(ctx, { status: 'active', ...campusScope(ctx) });
  if (input.classId) selection.classId = oid(input.classId);
  if (input.sectionId) selection.sectionId = oid(input.sectionId);
  if (input.studentIds?.length) selection._id = { $in: input.studentIds.map(oid) };

  if (sessionEnrollments.length > 0) {
    const studentIds = sessionEnrollments.map((e) => e.studentId);
    const activeStudentDocs = await Student.find(
      scope(ctx, {
        _id: { $in: studentIds },
        status: { $nin: ['left', 'graduated', 'transferred', 'archived'] },
      }),
    )
      .select('campusId classId sectionId sessionId feeConcession customFees status')
      .lean();

    const activeMap = new Map(activeStudentDocs.map((s) => [s._id.toString(), s]));
    for (const e of sessionEnrollments) {
      const sDoc = activeMap.get(e.studentId.toString());
      if (!sDoc) {
        skippedExcluded++;
        continue;
      }
      students.push({
        _id: sDoc._id as Types.ObjectId,
        campusId: (e.campusId ?? sDoc.campusId) as Types.ObjectId,
        classId: e.classId as Types.ObjectId,
        sectionId: e.sectionId as Types.ObjectId,
        sessionId: e.sessionId as Types.ObjectId,
        feeConcession: sDoc.feeConcession,
        customFees: sDoc.customFees,
      });
    }
  } else {
    // Fallback for legacy setups without StudentEnrollment records
    students = (await Student.find({ ...selection, sessionId: oid(sessionId) })
      .select('campusId classId sectionId sessionId feeConcession customFees')
      .lean()) as any;
  }

  const explained = {
    session: { _id: String(session._id), name: session.name },
    skippedOtherSession: await Student.countDocuments({ ...selection, sessionId: { $ne: oid(sessionId) } }),
    skippedExcluded,
    skippedNothingDue: 0,
    classesWithoutStructure: [] as Array<{ classId: string; name: string; students: number }>,
  };

  if (!students.length) {
    return {
      settings,
      session,
      students,
      drafts: [],
      explained,
      skippedExisting: 0,
      skippedNoStructure: 0,
      missingByClass: new Map<string, number>(),
    };
  }

  const [structures, heads, existing, priorBilled] = await Promise.all([
    FeeStructure.find(scope(ctx, { sessionId: oid(sessionId), isActive: true })).lean(),
    FeeHead.find(scope(ctx)).lean(),
    Invoice.find(scope(ctx, { period: input.period, kind: 'regular', studentId: { $in: students.map((s) => s._id) } }))
      .select('studentId')
      .lean(),
    Invoice.distinct('studentId', scope(ctx, { kind: 'regular', studentId: { $in: students.map((s) => s._id) } })),
  ]);
  const structureByClass = new Map(structures.map((s) => [s.classId.toString(), s]));
  const headById = new Map(heads.map((h) => [h._id.toString(), h]));
  const already = new Set(existing.map((i) => i.studentId.toString()));
  const hasPrior = new Set(priorBilled.map((id: Types.ObjectId) => id.toString()));

  const dueDay = Math.min(settings.fees.invoiceDueDay ?? 10, 28);
  const dueDate = input.dueDate
    ? parseDateOnly(input.dueDate)
    : parseDateOnly(`${input.period}-${String(dueDay).padStart(2, '0')}`);
  const issueDate = parseDateOnly(todayInTz(settings.timezone));

  let skippedNoStructure = 0;
  const missingByClass = new Map<string, number>();
  const drafts: Array<Record<string, unknown>> = [];
  for (const st of students) {
    if (already.has(st._id.toString())) continue;
    const structure = structureByClass.get(st.classId.toString());
    const own = new Map<string, number>(
      (st.customFees ?? []).map((c: any) => [c.feeHeadId.toString(), Number(c.amount)]),
    );
    if (!structure && !own.size) {
      skippedNoStructure++;
      missingByClass.set(st.classId.toString(), (missingByClass.get(st.classId.toString()) ?? 0) + 1);
      continue;
    }
    const lines = [
      ...(structure?.items ?? []).map((i) => ({
        feeHeadId: i.feeHeadId,
        amount: own.get(i.feeHeadId.toString()) ?? i.amount,
        billingMonths: i.billingMonths,
      })),
      // The student's own fees for heads the class structure does not have (or no structure).
      ...[...own]
        .filter(([headId]) => !structure?.items.some((i) => i.feeHeadId.toString() === headId))
        .map(([headId, amount]) => ({ feeHeadId: new Types.ObjectId(headId), amount: Number(amount), billingMonths: [] as number[] })),
    ];
    const enriched = lines
      .map((i) => ({ ...i, head: headById.get(i.feeHeadId.toString()) }))
      .filter((i) => i.head && i.head.isActive && i.head.billing !== 'per_student')
      .map((i) => ({
        feeHeadId: i.feeHeadId,
        name: i.head!.name,
        amount: i.amount,
        concessionApplies: i.head!.concessionApplies,
        frequency: i.head!.frequency,
        billingMonths: i.billingMonths,
      }));
    const items = billableItems(enriched, input.period, !hasPrior.has(st._id.toString())).map(
      ({ frequency: _f, billingMonths: _b, ...rest }) => rest,
    );
    if (!items.length) {
      explained.skippedNothingDue++; // nothing in the structure is billed this month
      continue;
    }
    const totals = computeTotals({ items, concession: st.feeConcession as any });
    drafts.push({
      schoolId: oid(ctx.schoolId),
      campusId: st.campusId,
      studentId: st._id,
      sessionId: st.sessionId,
      classId: st.classId,
      sectionId: st.sectionId,
      kind: 'regular',
      period: input.period,
      issueDate,
      dueDate,
      items,
      ...totals,
      paid: 0,
      balance: totals.total,
      status: totals.total === 0 ? 'paid' : 'unpaid',
      createdBy: oid(ctx.userId),
    });
  }

  return {
    settings,
    session,
    students,
    drafts,
    explained,
    skippedExisting: already.size,
    skippedNoStructure,
    missingByClass,
  };
}

export async function generateInvoices(
  ctx: Ctx,
  input: { period: string; sessionId?: string; classId?: string; sectionId?: string; studentIds?: string[]; dueDate?: string },
) {
  const prepared = await prepareInvoiceDrafts(ctx, input);
  const { settings, drafts, explained, skippedExisting, skippedNoStructure, missingByClass } = prepared;

  let created: Array<{ _id: Types.ObjectId }> = [];
  if (drafts.length) {
    const start = await allocateNumbers(ctx.schoolId, 'invoice', drafts.length);
    const prefix = settings.fees.invoicePrefix ?? 'INV-';
    drafts.forEach(
      (d, i) => (d.invoiceNo = `${prefix}${input.period.replace('-', '')}-${String(start + i).padStart(6, '0')}`),
    );
    try {
      created = await Invoice.insertMany(drafts, { ordered: false });
    } catch (err: any) {
      // Concurrent generation for the same period: keep the ones that were inserted.
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      created = (err.insertedDocs ?? []) as Array<{ _id: Types.ObjectId }>;
    }
  }
  await audit(ctx, {
    action: 'invoice.generate',
    entityType: 'Invoice',
    summary: `Generated ${created.length} invoices for ${input.period}`,
    metadata: { period: input.period, created: created.length, skippedExisting, skippedNoStructure },
  });
  if (missingByClass.size) {
    const names = await SchoolClass.find(scope(ctx, { _id: { $in: [...missingByClass.keys()].map(oid) } }))
      .select('name')
      .lean();
    const nameOf = new Map(names.map((c) => [c._id.toString(), c.name]));
    explained.classesWithoutStructure = [...missingByClass].map(([classId, n]) => ({
      classId,
      name: nameOf.get(classId) ?? 'Unknown class',
      students: n,
    }));
  }
  return {
    period: input.period,
    created: created.length,
    skippedExisting,
    skippedNoStructure,
    ...explained,
    invoiceIds: created.map((c) => c._id.toString()),
  };
}

export async function previewInvoiceGeneration(
  ctx: Ctx,
  input: { period: string; sessionId?: string; classId?: string; sectionId?: string; studentIds?: string[]; dueDate?: string },
) {
  const prepared = await prepareInvoiceDrafts(ctx, input);
  const { session, students, drafts, explained, skippedExisting, skippedNoStructure, missingByClass } = prepared;

  if (missingByClass.size) {
    const names = await SchoolClass.find(scope(ctx, { _id: { $in: [...missingByClass.keys()].map(oid) } }))
      .select('name')
      .lean();
    const nameOf = new Map(names.map((c) => [c._id.toString(), c.name]));
    explained.classesWithoutStructure = [...missingByClass].map(([classId, n]) => ({
      classId,
      name: nameOf.get(classId) ?? 'Unknown class',
      students: n,
    }));
  }

  // Tally by class for summary breakdown
  const classSummaryMap = new Map<string, { classId: string; studentCount: number; projectedAmount: number }>();
  for (const d of drafts) {
    const cid = String(d.classId);
    const existing = classSummaryMap.get(cid) ?? { classId: cid, studentCount: 0, projectedAmount: 0 };
    existing.studentCount++;
    existing.projectedAmount += (d.total as number) ?? 0;
    classSummaryMap.set(cid, existing);
  }

  const classIds = [...classSummaryMap.keys()].map(oid);
  const classDocs = await SchoolClass.find(scope(ctx, { _id: { $in: classIds } }))
    .select('name level')
    .sort({ level: 1 })
    .lean();
  const classDocMap = new Map(classDocs.map((c) => [c._id.toString(), c]));

  const classesSummary = [...classSummaryMap.values()]
    .map((s) => ({
      classId: s.classId,
      className: classDocMap.get(s.classId)?.name ?? 'Unknown class',
      level: classDocMap.get(s.classId)?.level ?? 0,
      studentCount: s.studentCount,
      projectedAmount: s.projectedAmount,
    }))
    .sort((a, b) => a.level - b.level);

  const totalProjectedAmount = drafts.reduce((sum, d) => sum + ((d.total as number) ?? 0), 0);

  // Fetch sample student names for up to 10 drafts
  const sampleStudentIds = drafts.slice(0, 10).map((d) => d.studentId);
  const sampleStudents = await Student.find(scope(ctx, { _id: { $in: sampleStudentIds } }))
    .select('firstName lastName admissionNo rollNo')
    .lean();
  const sampleMap = new Map(sampleStudents.map((s) => [s._id.toString(), s]));

  const sampleDrafts = drafts.slice(0, 10).map((d) => {
    const st = sampleMap.get(String(d.studentId));
    return {
      studentId: String(d.studentId),
      studentName: st ? `${st.firstName} ${st.lastName ?? ''}`.trim() : 'Student',
      admissionNo: st?.admissionNo,
      className: classDocMap.get(String(d.classId))?.name ?? 'Class',
      subtotal: d.subtotal,
      concession: d.concession,
      total: d.total,
      items: d.items,
    };
  });

  return {
    period: input.period,
    totalEligibleStudents: students.length,
    billableStudents: drafts.length,
    skippedExisting,
    skippedNoStructure,
    totalProjectedAmount,
    classesSummary,
    sampleDrafts,
    ...explained,
  };
}

export async function createAdhocInvoice(
  ctx: Ctx,
  input: {
    studentId: string;
    period: string;
    dueDate: string;
    items: Array<{ name: string; amount: number; feeHeadId?: string }>;
    notes?: string;
    idempotencyKey?: string;
  },
) {
  /** The invoice this request key already created (a retry after a lost answer), if any. */
  const prior = async () => {
    if (!input.idempotencyKey) return null;
    const found = await Invoice.findOne(scope(ctx, { kind: 'adhoc', idempotencyKey: input.idempotencyKey })).lean();
    if (found && found.studentId.toString() !== input.studentId)
      throw conflict('This request key was already used for another invoice', undefined, 'IDEMPOTENCY_MISMATCH');
    return found;
  };
  const before = await prior();
  if (before) return before;
  const student = await findOwned(Student, ctx, input.studentId, 'Student');
  assertCampusAccess(ctx, student.campusId);
  for (const i of input.items) if (i.feeHeadId) await assertRefs(ctx, [[FeeHead, i.feeHeadId, 'feeHeadId']]);
  const totals = computeTotals({ items: input.items });
  if (totals.total <= 0)
    throw badRequest(
      'Invoice not created: enter an amount above Rs 0 for at least one charge.',
      [{ path: 'body.items', message: 'At least one charge needs an amount above Rs 0' }],
      'VALIDATION_ERROR',
    );
  const settings = await feeSettings(ctx.schoolId);
  const seq = await allocateNumbers(ctx.schoolId, 'invoice', 1);
  let doc;
  const result = await atomic(async () => {
    let createdDoc: any;
    try {
      createdDoc = await Invoice.create({
        schoolId: ctx.schoolId,
        campusId: student.campusId,
        studentId: student._id,
        sessionId: student.sessionId,
        classId: student.classId,
        sectionId: student.sectionId,
        invoiceNo: `${settings.fees.invoicePrefix ?? 'INV-'}${input.period.replace('-', '')}-${String(seq).padStart(6, '0')}`,
        kind: 'adhoc',
        period: input.period,
        issueDate: parseDateOnly(todayInTz(settings.timezone)),
        dueDate: parseDateOnly(input.dueDate),
        items: input.items,
        ...totals,
        paid: 0,
        balance: totals.total,
        status: totals.total === 0 ? 'paid' : 'unpaid',
        notes: input.notes,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        createdBy: ctx.userId,
      });
    } catch (err) {
      // The same request arrived twice at the same moment: the unique key let one through.
      const e = err as { code?: number; keyPattern?: Record<string, unknown> };
      if (e?.code === 11000 && e.keyPattern?.idempotencyKey) {
        const winner = await prior();
        if (winner) return winner;
      }
      throw err;
    }
    await audit(ctx, {
      action: 'invoice.create_adhoc',
      entityType: 'Invoice',
      entityId: createdDoc._id,
      metadata: { total: totals.total },
    });
    await recordChange(
      ctx.schoolId,
      'INVOICE',
      createdDoc._id.toString(),
      'INSERT',
      1,
      createdDoc.toObject(),
      { originDeviceId: 'web_portal' },
    );
    return createdDoc.toObject();
  });
  return result;
}

// ───────────────────────────── Queries ─────────────────────────────

export async function listInvoices(
  ctx: Ctx,
  q: {
    page: number;
    limit: number;
    period?: string;
    status?: string;
    studentId?: string;
    classId?: string;
    sectionId?: string;
    overdue?: boolean;
    q?: string;
  },
) {
  const filter: Record<string, unknown> = scope(ctx, campusScope(ctx));
  const rx = searchRegex(q.q);
  if (rx) {
    // Challan number, or the student (name, admission no, parent name or phone).
    const ids = await studentIdsMatching(ctx, q.q);
    filter.$and = [{ $or: [{ invoiceNo: rx }, { studentId: { $in: ids } }] }];
  }
  const visible = await visibleStudentIds(ctx);
  if (visible) filter.studentId = { $in: visible.map(oid) };
  if (q.studentId) {
    if (visible && !visible.includes(q.studentId))
      return { items: [], meta: { page: q.page, limit: q.limit, total: 0, totalPages: 1 } };
    filter.studentId = oid(q.studentId);
  }
  if (q.period) filter.period = q.period;
  if (q.status) filter.status = q.status;
  if (q.classId) filter.classId = oid(q.classId);
  if (q.sectionId) filter.sectionId = oid(q.sectionId);
  if (q.overdue) {
    const { timezone } = await feeSettings(ctx.schoolId);
    filter.status = { $in: ['unpaid', 'partial'] };
    filter.dueDate = { $lt: parseDateOnly(todayInTz(timezone)) };
  }
  const page = await paginate(Invoice, filter, {
    page: q.page,
    limit: q.limit,
    sort: { dueDate: -1, invoiceNo: -1 },
    populate: [{ path: 'studentId', select: 'firstName lastName admissionNo' }],
  });
  const { timezone } = await feeSettings(ctx.schoolId);
  const today = parseDateOnly(todayInTz(timezone));
  return { ...page, items: page.items.map((i: any) => ({ ...i, isOverdue: invoiceIsOverdue(i, today) })) };
}

/** Open (unpaid or partly paid) with a balance, and the due date has passed in school time. */
export function invoiceIsOverdue(inv: { balance: number; status: string; dueDate: Date }, today: Date): boolean {
  return inv.balance > 0 && ['unpaid', 'partial'].includes(inv.status) && inv.dueDate < today;
}

export async function getInvoice(ctx: Ctx, id: string) {
  const invoice = await Invoice.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) }))
    .populate('studentId', 'firstName lastName admissionNo classId sectionId guardians')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .lean();
  if (!invoice) throw notFound('Invoice');
  await assertStudentVisible(ctx, (invoice.studentId as any)._id.toString());
  const { timezone } = await feeSettings(ctx.schoolId);
  const today = parseDateOnly(todayInTz(timezone));
  const payments = await Payment.find(scope(ctx, { invoiceId: invoice._id }))
    .select('receiptNo amount method receivedAt status reference headAllocations')
    .sort({ receivedAt: 1 })
    .lean();
  return {
    ...invoice,
    isOverdue: invoiceIsOverdue(invoice, today),
    installments: installmentStatus(invoice.installments as any, invoice.paid, today),
    payments,
    breakdown:
      invoice.status === 'cancelled'
        ? []
        : headBreakdown(invoice as never, payments.filter((x) => x.status === 'valid') as never),
  };
}

// ───────────────────────────── Payments ─────────────────────────────

/**
 * Records a payment: invoice balance, receipt number, payment and audit entry. On a replica set
 * these commit together or not at all (also if the process dies half-way); on standalone
 * MongoDB a thrown error is compensated, but a crash between the writes is not (see atomic()).
 */
export async function recordPayment(
  ctx: Ctx,
  invoiceId: string,
  input: {
    amount: number;
    method: PaymentMethod;
    reference?: string;
    receivedAt?: string;
    idempotencyKey?: string;
    headAllocations?: Array<{ line: string; amount: number }>;
  },
) {
  const result = await withPaymentLock(ctx, invoiceId, () => atomic(() => recordPaymentOnce(ctx, invoiceId, input)));
  // After the payment is committed (and never for a replayed request): tell the parents.
  if (!result.replayed) await notifyParentsOfPayment(ctx, result.payment as never, result.invoice as never);
  return result;
}

/** A payment lock older than this belongs to a process that stopped; it may be taken over. */
const PAYMENT_LOCK_STALE_MS = 30_000;
/** How long a payment waits for another one on the same invoice before asking to retry. */
const PAYMENT_LOCK_WAIT_MS = 5_000;

/**
 * One payment at a time per invoice. A payment reads what each fee line still owes (from the
 * payments already recorded), checks its allocation against it, then updates the invoice and
 * saves itself; two payments doing that at the same moment could both allocate the same fee
 * (the invoice balance alone does not prevent it). The lock is held from before that reading
 * until the payment is saved, so the second payment reads the first one. Another payment on the
 * same invoice waits a moment, then gets 409 PAYMENT_IN_PROGRESS. Payments on different invoices
 * never wait for each other.
 *
 * Only on a standalone server. On a replica set both payments write the same invoice inside their
 * transactions: the second one hits a write conflict and is retried, reading the first one. No lock
 * there also means a process killed mid-payment leaves nothing behind to wait for.
 */
async function withPaymentLock<T>(ctx: Ctx, invoiceId: string, fn: () => Promise<T>): Promise<T> {
  if (mongoTopology() === 'unknown') await detectTopology();
  if (transactionsSupported()) return fn();
  // An invalid or unknown invoice: nothing to lock; recording it reports why.
  if (!Types.ObjectId.isValid(invoiceId) || !(await Invoice.exists(scope(ctx, { _id: oid(invoiceId) })))) return fn();
  const token = new Types.ObjectId().toString();
  const until = Date.now() + PAYMENT_LOCK_WAIT_MS;
  for (let wait = 20; ; wait = Math.min(wait * 2, 250)) {
    const taken = await Invoice.updateOne(
      scope(ctx, {
        _id: oid(invoiceId),
        $or: [{ paymentLock: null }, { 'paymentLock.at': { $lt: new Date(Date.now() - PAYMENT_LOCK_STALE_MS) } }],
      }),
      { $set: { paymentLock: { token, at: new Date() } } },
    );
    if (taken.matchedCount) break;
    if (Date.now() > until)
      throw conflict(
        'Another payment is being recorded on this invoice right now. Reload the invoice and try again.',
        undefined,
        'PAYMENT_IN_PROGRESS',
      );
    await new Promise((r) => setTimeout(r, wait));
  }
  try {
    return await fn();
  } finally {
    await Invoice.updateOne(scope(ctx, { _id: oid(invoiceId), 'paymentLock.token': token }), {
      $unset: { paymentLock: 1 },
    }).catch(() => undefined); // if this fails, the lock expires on its own
  }
}

/**
 * One amount received for a student (e.g. the "total payable" of a voucher with previous dues),
 * settled oldest first: previous dues, then each unpaid month in order. Each invoice it reaches
 * gets its own payment and receipt number, all recorded together (one transaction on a replica
 * set; on standalone MongoDB a failure part-way keeps the parts already recorded, each with its
 * own receipt, and the rest can be paid again). Refuses more than the student owes. A retried request with the same `idempotencyKey`
 * returns the payments already recorded.
 */
export async function recordStudentPayment(
  ctx: Ctx,
  studentId: string,
  input: { amount: number; method: PaymentMethod; reference?: string; receivedAt?: string; idempotencyKey?: string },
) {
  const student = await findOwned(Student, ctx, studentId, 'Student', 'firstName lastName campusId');
  assertCampusAccess(ctx, student.campusId);
  const partKey = (i: number) => (input.idempotencyKey ? `${input.idempotencyKey}#${i + 1}` : undefined);
  if (input.idempotencyKey) {
    const prior = await Payment.find(
      scope(ctx, { studentId: student._id, idempotencyKey: { $in: Array.from({ length: 50 }, (_, i) => partKey(i)) } }),
    )
      .sort({ receiptNo: 1 })
      .lean();
    if (prior.length) {
      if (prior.reduce((s, p) => s + p.amount, 0) !== input.amount)
        throw conflict('idempotencyKey was already used for a different payment');
      return { payments: prior, ...(await studentDuesAfter(ctx, student._id)), replayed: true };
    }
  }
  const openInvoices = () =>
    Invoice.find(
      scope(ctx, {
        studentId: student._id,
        status: { $in: ['unpaid', 'partial'] },
        balance: { $gt: 0 },
        ...campusScope(ctx),
      }),
    )
      .select('_id balance period issueDate invoiceNo')
      .sort({ period: 1, issueDate: 1, invoiceNo: 1 })
      .lean();
  // The same per-invoice locks as a single payment (standalone MongoDB), taken in a fixed order.
  const lockIds = (await openInvoices()).map((i) => String(i._id)).sort();
  const locked = lockIds.reduceRight<() => Promise<unknown[]>>(
    (inner, id) => () => withPaymentLock(ctx, id, inner),
    () => atomic(() => settle()),
  );
  const settle = async () => {
    const open = await openInvoices();
    const due = open.reduce((s, i) => s + i.balance, 0);
    if (!due) throw conflict('This student has nothing to pay');
    if (input.amount > due)
      throw unprocessable(`Payment exceeds what the student owes (Rs ${due})`, { balance: due }, 'OVERPAYMENT');
    const payments = [];
    let left = input.amount;
    for (const [i, inv] of open.entries()) {
      if (left <= 0) break;
      const amount = Math.min(left, inv.balance);
      const { payment } = await recordPaymentOnce(ctx, String(inv._id), {
        ...input,
        amount,
        idempotencyKey: partKey(i),
      });
      payments.push(payment);
      left -= amount;
    }
    return payments;
  };
  const result = (await locked()) as Array<{ receiptNo: string }>;
  const after = await studentDuesAfter(ctx, student._id);
  try {
    const name = `${student.firstName} ${student.lastName ?? ''}`.trim();
    await notifyUsers(ctx, await parentUserIdsForStudents(ctx, [student._id as never]), {
      title: 'Fee payment received',
      body: `Rs ${input.amount.toLocaleString('en-PK')} received for ${name} (receipt ${result.map((p) => p.receiptNo).join(', ')}). Remaining balance: Rs ${after.remaining.toLocaleString('en-PK')}.`,
      category: 'fees',
      link: `/fees/students/${String(student._id)}`,
    });
  } catch {
    // A notification problem never affects a recorded payment.
  }
  return { payments: result, ...after, replayed: false };
}

async function studentDuesAfter(ctx: Ctx, studentId: unknown) {
  const open = await Invoice.find(
    scope(ctx, { studentId, status: { $in: ['unpaid', 'partial'] }, balance: { $gt: 0 } }),
  )
    .select('balance')
    .lean();
  return { remaining: open.reduce((s, i) => s + i.balance, 0) };
}

async function notifyParentsOfPayment(
  ctx: Ctx,
  payment: { amount: number; receiptNo: string; studentId: unknown; _id: unknown },
  invoice: { invoiceNo: string; balance: number } | null,
) {
  try {
    const student = await Student.findOne(scope(ctx, { _id: payment.studentId }))
      .select('firstName lastName')
      .lean();
    const name = student ? `${student.firstName} ${student.lastName ?? ''}`.trim() : 'your child';
    await notifyUsers(ctx, await parentUserIdsForStudents(ctx, [payment.studentId as never]), {
      title: 'Fee payment received',
      body: `Rs ${payment.amount.toLocaleString('en-PK')} received for ${name} (challan ${invoice?.invoiceNo ?? ''}, receipt ${payment.receiptNo}).${invoice ? ` Remaining balance: Rs ${invoice.balance.toLocaleString('en-PK')}.` : ''}`,
      category: 'fees',
      link: `/fees/students/${String(payment.studentId)}`,
    });
  } catch {
    // A notification problem never affects a recorded payment.
  }
}

async function recordPaymentOnce(
  ctx: Ctx,
  invoiceId: string,
  input: {
    amount: number;
    method: PaymentMethod;
    reference?: string;
    receivedAt?: string;
    idempotencyKey?: string;
    headAllocations?: Array<{ line: string; amount: number }>;
  },
) {
  if (input.idempotencyKey) {
    const prior = await Payment.findOne(scope(ctx, { idempotencyKey: input.idempotencyKey })).lean();
    if (prior) {
      if (prior.invoiceId.toString() !== invoiceId || prior.amount !== input.amount) {
        throw conflict('idempotencyKey was already used for a different payment');
      }
      return {
        payment: prior,
        invoice: await Invoice.findOne(scope(ctx, { _id: prior.invoiceId })).lean(),
        replayed: true,
      };
    }
  }
  const invoice = await findOwned(Invoice, ctx, invoiceId, 'Invoice');
  assertCampusAccess(ctx, invoice.campusId);
  if (invoice.status === 'cancelled') throw conflict('Cannot record a payment on a cancelled invoice');
  if (invoice.balance <= 0) throw conflict('This invoice is already fully settled');
  if (input.amount > invoice.balance) {
    throw unprocessable(
      `Payment exceeds the outstanding balance of Rs ${invoice.balance}`,
      { balance: invoice.balance },
      'OVERPAYMENT',
    );
  }
  // Staff may say which fees this payment settles; it must fit what is outstanding on each.
  // Otherwise it settles what is outstanding in invoice order. Either way the result is recorded,
  // so the receipt shows exactly which fees were paid (never inferred from the amount later).
  const prior = await Payment.find(scope(ctx, { invoiceId: invoice._id, status: 'valid' }))
    .select('amount headAllocations')
    .lean();
  const linesNow = headBreakdown(invoice as never, prior as never);
  const allocationSource = input.headAllocations?.length ? ('chosen' as const) : ('automatic' as const);
  const headAllocations =
    allocationSource === 'chosen'
      ? validateHeadAllocation(linesNow, input.headAllocations!, input.amount)
      : autoAllocate(linesNow, input.amount);

  return atomic(async () => {
    // Atomic: only succeeds while the balance still covers this payment.
    const updated = await Invoice.findOneAndUpdate(
      scope(ctx, { _id: invoice._id, status: { $in: ['unpaid', 'partial'] }, balance: { $gte: input.amount } }),
      [
        { $set: { paid: { $add: ['$paid', input.amount] }, balance: { $subtract: ['$balance', input.amount] } } },
        STATUS_STAGE,
      ],
      { returnDocument: 'after', ...PIPELINE },
    ).lean();
    if (!updated) throw conflict('The invoice changed while recording the payment; please reload and retry');

    try {
      const settings = await feeSettings(ctx.schoolId);
      const seq = await allocateNumbers(ctx.schoolId, 'receipt', 1);
      const payment = await Payment.create({
        schoolId: ctx.schoolId,
        campusId: invoice.campusId,
        invoiceId: invoice._id,
        studentId: invoice.studentId,
        receiptNo: `${settings.fees.receiptPrefix ?? 'RCP-'}${String(seq).padStart(7, '0')}`,
        amount: input.amount,
        method: input.method,
        reference: input.reference,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        receivedBy: ctx.userId,
        receivedByName: ctx.name,
        allocations: allocatePayment(invoice.installments as any, invoice.paid, input.amount),
        headAllocations,
        allocationSource,
        balanceAfter: updated.balance,
        idempotencyKey: input.idempotencyKey,
      });
      await audit(ctx, {
        action: 'payment.record',
        entityType: 'Payment',
        entityId: payment._id,
        metadata: { invoiceId: invoice._id.toString(), amount: input.amount, method: input.method },
      });
      await recordChange(
        ctx.schoolId,
        'PAYMENT',
        payment._id.toString(),
        'INSERT',
        1,
        payment.toObject(),
        { originDeviceId: 'web_portal' },
      );
      await recordChange(
        ctx.schoolId,
        'INVOICE',
        invoice._id.toString(),
        'UPDATE',
        1,
        updated,
        { originDeviceId: 'web_portal' },
      );
      return { payment: payment.toObject(), invoice: updated, replayed: false };
    } catch (err) {
      if (inTransaction()) throw err;
      // Standalone MongoDB: compensate so balances never drift from recorded payments.
      await Invoice.updateOne(
        scope(ctx, { _id: invoice._id }),
        [
          { $set: { paid: { $subtract: ['$paid', input.amount] }, balance: { $add: ['$balance', input.amount] } } },
          STATUS_STAGE,
        ],
        PIPELINE,
      ).catch(() => undefined);
      throw err;
    }
  });
}

export async function listPayments(
  ctx: Ctx,
  q: { page: number; limit: number; from?: string; to?: string; studentId?: string; method?: string; q?: string },
) {
  const filter: Record<string, unknown> = scope(ctx, campusScope(ctx));
  const rx = searchRegex(q.q);
  if (rx) {
    const ids = await studentIdsMatching(ctx, q.q);
    filter.$and = [{ $or: [{ receiptNo: rx }, { reference: rx }, { studentId: { $in: ids } }] }];
  }
  const visible = await visibleStudentIds(ctx);
  if (visible) filter.studentId = { $in: visible.map(oid) };
  if (q.studentId) {
    if (visible && !visible.includes(q.studentId))
      return { items: [], meta: { page: q.page, limit: q.limit, total: 0, totalPages: 1 } };
    filter.studentId = oid(q.studentId);
  }
  if (q.method) filter.method = q.method;
  if (q.from || q.to) {
    const tz = await schoolTimezone(ctx.schoolId);
    filter.receivedAt = {
      ...(q.from ? { $gte: localDayRange(q.from, q.from, tz).start } : {}),
      ...(q.to ? { $lt: localDayRange(q.to, q.to, tz).end } : {}),
    };
  }
  return paginate(Payment, filter, {
    page: q.page,
    limit: q.limit,
    sort: { receivedAt: -1 },
    populate: [
      { path: 'studentId', select: 'firstName lastName admissionNo' },
      { path: 'invoiceId', select: 'invoiceNo period' },
    ],
  });
}

export async function getPayment(ctx: Ctx, id: string) {
  const payment = await Payment.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) }))
    .populate('studentId', 'firstName lastName admissionNo')
    .populate('invoiceId', 'invoiceNo period total paid balance status')
    .lean();
  if (!payment) throw notFound('Payment');
  await assertStudentVisible(ctx, (payment.studentId as any)._id.toString());
  return payment;
}

/**
 * What a payment paid for, for its receipt: per fee, due before it, paid now, remaining after.
 * Only from what was recorded with the payment; a payment recorded before allocations were kept
 * says so (available: false) instead of guessing from the amount or the month.
 */
export async function paymentBreakdown(
  ctx: Ctx,
  payment: {
    _id: unknown;
    invoiceId: unknown;
    amount: number;
    createdAt?: Date;
    allocationSource?: string | null;
    headAllocations?: Array<{ line: string; amount: number }>;
  },
) {
  if (!payment.allocationSource) return { available: false as const, source: null, lines: [], unallocated: 0 };
  const invoiceId = (payment.invoiceId as { _id?: unknown })?._id ?? payment.invoiceId;
  const [invoice, earlier] = await Promise.all([
    Invoice.findOne(scope(ctx, { _id: invoiceId }))
      .select('items concession lateFee waiver')
      .lean(),
    Payment.find(
      scope(ctx, {
        invoiceId,
        status: 'valid',
        _id: { $ne: payment._id },
        createdAt: { $lt: payment.createdAt ?? new Date() },
      }),
    )
      .select('amount headAllocations')
      .lean(),
  ]);
  if (!invoice) return { available: false as const, source: null, lines: [], unallocated: 0 };
  const r = receiptLines(invoice as never, earlier as never, {
    amount: payment.amount,
    headAllocations: payment.headAllocations ?? [],
  });
  return { available: true as const, source: payment.allocationSource as 'chosen' | 'automatic', ...r };
}

// ───────────────────── Approval-gated adjustments ─────────────────────

export async function requestWaiver(ctx: Ctx, invoiceId: string, input: { amount: number; reason: string }) {
  const invoice = await findOwned(Invoice, ctx, invoiceId, 'Invoice');
  assertCampusAccess(ctx, invoice.campusId);
  if (!['unpaid', 'partial'].includes(invoice.status))
    throw conflict(`Cannot waive an invoice that is ${invoice.status}`);
  if (input.amount > invoice.balance)
    throw unprocessable(`Waiver exceeds the outstanding balance of Rs ${invoice.balance}`);
  const student = await Student.findOne(scope(ctx, { _id: invoice.studentId }))
    .select('firstName lastName admissionNo')
    .lean();
  return createApprovalRequest(ctx, {
    type: 'invoice_waiver',
    title: `Waive Rs ${input.amount} on ${invoice.invoiceNo} (${student?.firstName} ${student?.lastName ?? ''})`.trim(),
    entityType: 'Invoice',
    entityId: invoice._id,
    amount: input.amount,
    payload: { invoiceId: invoice._id.toString(), amount: input.amount, reason: input.reason },
    data: {
      invoiceNo: invoice.invoiceNo,
      total: invoice.total,
      paid: invoice.paid,
      balance: invoice.balance,
      admissionNo: student?.admissionNo,
    },
    analysis: `Outstanding balance is Rs ${invoice.balance}. Waiving Rs ${input.amount} leaves Rs ${invoice.balance - input.amount}.`,
    recommendation: input.reason,
  });
}

export async function executeWaiver(ctx: Ctx, payload: { invoiceId: string; amount: number }) {
  const updated = await Invoice.findOneAndUpdate(
    scope(ctx, {
      _id: oid(payload.invoiceId),
      status: { $in: ['unpaid', 'partial'] },
      balance: { $gte: payload.amount },
    }),
    [
      {
        $set: {
          waiver: { $add: ['$waiver', payload.amount] },
          total: { $subtract: ['$total', payload.amount] },
          balance: { $subtract: ['$balance', payload.amount] },
        },
      },
      STATUS_STAGE,
    ],
    { returnDocument: 'after', ...PIPELINE },
  ).lean();
  if (!updated) throw new Error('Invoice balance no longer covers the waiver; nothing was changed');
  return { invoiceId: payload.invoiceId, waived: payload.amount, newBalance: updated.balance, status: updated.status };
}

export async function requestCancel(ctx: Ctx, invoiceId: string, reason: string) {
  const invoice = await findOwned(Invoice, ctx, invoiceId, 'Invoice');
  assertCampusAccess(ctx, invoice.campusId);
  if (invoice.status === 'cancelled') throw conflict('Invoice is already cancelled');
  if (invoice.paid > 0) throw conflict('Invoices with payments cannot be cancelled. Reverse the payments first.');
  return createApprovalRequest(ctx, {
    type: 'invoice_cancel',
    title: `Cancel invoice ${invoice.invoiceNo}`,
    entityType: 'Invoice',
    entityId: invoice._id,
    amount: invoice.total,
    payload: { invoiceId: invoice._id.toString(), reason },
    data: { invoiceNo: invoice.invoiceNo, period: invoice.period, total: invoice.total },
    recommendation: reason,
  });
}

export async function executeCancel(ctx: Ctx, payload: { invoiceId: string; reason: string }) {
  const updated = await Invoice.findOneAndUpdate(
    scope(ctx, { _id: oid(payload.invoiceId), paid: 0, status: { $ne: 'cancelled' } }),
    { $set: { status: 'cancelled', balance: 0, cancelledReason: payload.reason } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw new Error('Invoice can no longer be cancelled (payments recorded or already cancelled)');
  return { invoiceId: payload.invoiceId, status: 'cancelled' };
}

export async function requestReversal(ctx: Ctx, paymentId: string, reason: string) {
  const payment = await findOwned(Payment, ctx, paymentId, 'Payment');
  if (payment.status === 'reversed') throw conflict('Payment is already reversed');
  return createApprovalRequest(ctx, {
    type: 'payment_reversal',
    title: `Reverse payment ${payment.receiptNo} (Rs ${payment.amount})`,
    entityType: 'Payment',
    entityId: payment._id,
    amount: payment.amount,
    payload: { paymentId: payment._id.toString(), reason },
    data: { receiptNo: payment.receiptNo, amount: payment.amount, method: payment.method },
    recommendation: reason,
  });
}

export async function executeReversal(ctx: Ctx, payload: { paymentId: string; reason: string }) {
  const payment = await Payment.findOneAndUpdate(
    scope(ctx, { _id: oid(payload.paymentId), status: 'valid' }),
    { $set: { status: 'reversed', reversedAt: new Date(), reversalReason: payload.reason } },
    { returnDocument: 'after' },
  ).lean();
  if (!payment) throw new Error('Payment is not reversible (not found or already reversed)');
  const invoice = await Invoice.findOneAndUpdate(
    scope(ctx, { _id: payment.invoiceId }),
    [
      { $set: { paid: { $subtract: ['$paid', payment.amount] }, balance: { $add: ['$balance', payment.amount] } } },
      STATUS_STAGE,
    ],
    { returnDocument: 'after', ...PIPELINE },
  ).lean();
  return { paymentId: payload.paymentId, invoiceBalance: invoice?.balance, invoiceStatus: invoice?.status };
}

/**
 * Set, change or remove a student's own monthly fee (instead of the class fee). Applies to
 * invoices generated from now on; existing invoices are not changed. Recorded in the audit log
 * with the old and new amount and the reason.
 */
export async function setOwnFee(
  ctx: Ctx,
  studentId: string,
  input: { feeHeadId: string; amount: number | null; reason: string },
) {
  const student = await findOwned(Student, ctx, studentId, 'Student', 'firstName lastName campusId customFees');
  assertCampusAccess(ctx, student.campusId);
  const head = await FeeHead.findOne(scope(ctx, { _id: oid(input.feeHeadId) }))
    .select('name frequency isActive')
    .lean();
  if (!head)
    throw badRequest('This fee head does not exist in your school', { field: 'feeHeadId' }, 'INVALID_REFERENCE');
  if (head.frequency !== 'monthly' || !head.isActive)
    throw badRequest('Choose an active monthly fee head', { field: 'feeHeadId' }, 'VALIDATION_ERROR');
  const others = (student.customFees ?? []).filter(
    (c: { feeHeadId: unknown }) => String(c.feeHeadId) !== input.feeHeadId,
  );
  const before = (student.customFees ?? []).find(
    (c: { feeHeadId: unknown }) => String(c.feeHeadId) === input.feeHeadId,
  ) as { amount: number } | undefined;
  const next =
    input.amount === null
      ? others
      : [
          ...others,
          {
            feeHeadId: oid(input.feeHeadId),
            amount: input.amount,
            source: 'manual',
            setAt: new Date(),
            setBy: oid(ctx.userId),
          },
        ];
  await Student.updateOne(scope(ctx, { _id: student._id }), { $set: { customFees: next } });
  await audit(ctx, {
    action: input.amount === null ? 'fees.own_fee_removed' : 'fees.own_fee_set',
    entityType: 'Student',
    entityId: student._id,
    summary: `${head.name}: ${before ? `Rs ${before.amount}` : 'class fee'} → ${input.amount === null ? 'class fee' : `Rs ${input.amount}`}`,
    metadata: { feeHeadId: input.feeHeadId, from: before?.amount ?? null, to: input.amount, reason: input.reason },
  });
  return {
    studentId,
    feeHeadId: input.feeHeadId,
    from: before?.amount ?? null,
    to: input.amount,
    appliesTo: 'invoices generated from now on',
  };
}

export async function requestConcession(
  ctx: Ctx,
  studentId: string,
  input: { type: 'percent' | 'fixed' | 'none'; value: number; reason: string },
) {
  const student = await findOwned(Student, ctx, studentId, 'Student');
  assertCampusAccess(ctx, student.campusId);
  if (input.type === 'percent' && input.value > 100) throw badRequest('Percent concession cannot exceed 100');
  return createApprovalRequest(ctx, {
    type: 'fee_concession',
    title: `Fee concession for ${student.firstName} ${student.lastName ?? ''} (${input.type === 'percent' ? `${input.value}%` : `Rs ${input.value}`})`,
    entityType: 'Student',
    entityId: student._id,
    payload: { studentId: student._id.toString(), ...input },
    data: { admissionNo: student.admissionNo, currentConcession: student.feeConcession },
    recommendation: input.reason,
  });
}

export async function executeConcession(
  ctx: Ctx,
  approvalId: string,
  payload: { studentId: string; type: string; value: number; reason: string },
) {
  const res = await Student.updateOne(scope(ctx, { _id: oid(payload.studentId) }), {
    $set: {
      feeConcession: {
        type: payload.type,
        value: payload.type === 'none' ? 0 : payload.value,
        reason: payload.reason,
        approvalId: oid(approvalId),
      },
    },
  });
  if (!res.matchedCount) throw new Error('Student not found');
  return {
    studentId: payload.studentId,
    concession: { type: payload.type, value: payload.value },
    appliesTo: 'invoices generated from now on',
  };
}

// ───────────────────────────── Installments ─────────────────────────────

export async function setInstallments(
  ctx: Ctx,
  invoiceId: string,
  input: {
    count?: number;
    firstDueDate?: string;
    intervalDays?: number;
    plan?: Array<{ amount: number; dueDate: string }>;
  },
) {
  const invoice = await findOwned(Invoice, ctx, invoiceId, 'Invoice');
  assertCampusAccess(ctx, invoice.campusId);
  if (!['unpaid', 'partial'].includes(invoice.status))
    throw conflict(`Cannot set installments on a ${invoice.status} invoice`);
  let installments: Array<{ no: number; amount: number; dueDate: Date }>;
  if (input.plan?.length) {
    const sum = input.plan.reduce((s, p) => s + p.amount, 0);
    if (sum !== invoice.total)
      throw unprocessable(`Installments must add up to the invoice total of Rs ${invoice.total} (got Rs ${sum})`);
    installments = input.plan.map((p, i) => ({ no: i + 1, amount: p.amount, dueDate: parseDateOnly(p.dueDate) }));
  } else {
    if (!input.count || !input.firstDueDate) throw badRequest('Provide either plan[] or count + firstDueDate');
    installments = splitInstallments(
      invoice.total,
      input.count,
      parseDateOnly(input.firstDueDate),
      input.intervalDays ?? 30,
    );
  }
  const last = installments[installments.length - 1];
  const updated = await Invoice.findOneAndUpdate(
    scope(ctx, { _id: invoice._id }),
    { $set: { installments, dueDate: last.dueDate } },
    { returnDocument: 'after' },
  ).lean();
  await audit(ctx, {
    action: 'invoice.installments_set',
    entityType: 'Invoice',
    entityId: invoice._id,
    metadata: { count: installments.length },
  });
  const { timezone } = await feeSettings(ctx.schoolId);
  return {
    ...updated,
    installments: installmentStatus(installments, updated!.paid, parseDateOnly(todayInTz(timezone))),
  };
}

// ───────────────────────────── Late fees ─────────────────────────────

export async function applyLateFees(actor: AnyCtx) {
  const school = await School.findById(actor.schoolId).select('settings.fees settings.timezone').lean();
  const amount = school?.settings?.fees?.lateFeeAmount ?? 0;
  if (!amount) return { applied: 0, lateFeeAmount: 0, note: 'Late fee amount is 0 in school settings' };
  const grace = school?.settings?.fees?.lateFeeGraceDays ?? 0;
  const today = parseDateOnly(todayInTz(school?.settings?.timezone ?? 'Asia/Karachi'));
  const cutoff = addDays(today, -grace);
  const res = await Invoice.updateMany(
    // Not on brought-forward dues: they were overdue before the school used School OS.
    scope(actor, {
      status: { $in: ['unpaid', 'partial'] },
      dueDate: { $lt: cutoff },
      lateFeeAppliedAt: null,
      kind: { $ne: 'opening' },
    }),
    [
      {
        $set: {
          lateFee: { $add: ['$lateFee', amount] },
          total: { $add: ['$total', amount] },
          balance: { $add: ['$balance', amount] },
          lateFeeAppliedAt: '$$NOW',
        },
      },
    ],
    PIPELINE,
  );
  await audit(actor, {
    action: 'invoice.late_fees_applied',
    entityType: 'Invoice',
    metadata: { applied: res.modifiedCount, amount },
  });
  return { applied: res.modifiedCount, lateFeeAmount: amount };
}

// ───────────────────────────── Balances ─────────────────────────────

export async function outstanding(
  ctx: Ctx,
  q: { classId?: string; sectionId?: string; minBalance?: number; overdueOnly?: boolean; limit: number },
) {
  const { timezone } = await feeSettings(ctx.schoolId);
  const today = parseDateOnly(todayInTz(timezone));
  const match: Record<string, unknown> = scope(ctx, { status: { $in: ['unpaid', 'partial'] }, ...campusScope(ctx) });
  if (q.classId) match.classId = oid(q.classId);
  if (q.sectionId) match.sectionId = oid(q.sectionId);
  if (q.overdueOnly) match.dueDate = { $lt: today };
  const rows = await Invoice.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$studentId',
        balance: { $sum: '$balance' },
        invoices: { $sum: 1 },
        oldestDueDate: { $min: '$dueDate' },
        overdueBalance: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$balance', 0] } },
      },
    },
    { $match: { balance: { $gte: q.minBalance ?? 1 } } },
    { $sort: { balance: -1 } },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              students: { $sum: 1 },
              balance: { $sum: '$balance' },
              overdueBalance: { $sum: '$overdueBalance' },
            },
          },
        ],
        rows: [
          { $limit: q.limit },
          { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 'student' } },
          { $unwind: '$student' },
          {
            $project: {
              _id: 0,
              studentId: '$_id',
              balance: 1,
              overdueBalance: 1,
              invoices: 1,
              oldestDueDate: 1,
              admissionNo: '$student.admissionNo',
              name: {
                $trim: { input: { $concat: ['$student.firstName', ' ', { $ifNull: ['$student.lastName', ''] }] } },
              },
              classId: '$student.classId',
              sectionId: '$student.sectionId',
            },
          },
        ],
      },
    },
  ]);
  const totals = rows[0]?.totals[0] ?? { students: 0, balance: 0, overdueBalance: 0 };
  return {
    totals: { students: totals.students, balance: totals.balance, overdueBalance: totals.overdueBalance },
    students: rows[0]?.rows ?? [],
  };
}

export async function studentLedger(ctx: Ctx, studentId: string) {
  const student = await findOwned(
    Student,
    ctx,
    studentId,
    'Student',
    'firstName lastName admissionNo campusId classId sectionId feeConcession customFees',
  );
  await assertStudentVisible(ctx, studentId);
  if (ctx.role !== 'parent') assertCampusAccess(ctx, student.campusId);
  const [invoices, payments, heads] = await Promise.all([
    Invoice.find(scope(ctx, { studentId: student._id, status: { $ne: 'cancelled' } }))
      .select(
        'invoiceNo kind period issueDate dueDate items subtotal total paid balance status waiver concession lateFee',
      )
      .sort({ issueDate: 1 })
      .lean(),
    Payment.find(scope(ctx, { studentId: student._id, status: 'valid' }))
      .select('receiptNo amount method reference receivedAt invoiceId headAllocations')
      .sort({ receivedAt: 1 })
      .lean(),
    FeeHead.find(
      scope(ctx, { _id: { $in: (student.customFees ?? []).map((c: { feeHeadId: unknown }) => c.feeHeadId) } }),
    )
      .select('name')
      .lean(),
  ]);
  const { timezone } = await feeSettings(ctx.schoolId);
  const today = parseDateOnly(todayInTz(timezone));
  const invoiceNoById = new Map(invoices.map((i) => [i._id.toString(), i.invoiceNo]));
  const paymentsByInvoice = new Map<string, typeof payments>();
  for (const pay of payments) {
    const k = pay.invoiceId.toString();
    paymentsByInvoice.set(k, [...(paymentsByInvoice.get(k) ?? []), pay]);
  }
  /** The student's own fees (instead of the class fee), e.g. from the fee import. */
  const ownFees = (student.customFees ?? []).map((c: { feeHeadId: unknown; amount: number; source?: string }) => ({
    feeHeadId: String(c.feeHeadId),
    name: heads.find((h) => String(h._id) === String(c.feeHeadId))?.name ?? 'Fee',
    amount: c.amount,
    source: c.source ?? 'manual',
  }));
  type Entry = {
    date: Date;
    type: 'invoice' | 'payment';
    ref: string;
    /** What the entry is: "Previous dues", "Fee for 2026-11", "Payment (cash)"… */
    label: string;
    debit: number;
    credit: number;
    balance?: number;
  };
  const entries: Entry[] = [
    ...invoices.map((i) => ({
      date: i.issueDate,
      type: 'invoice' as const,
      ref: i.invoiceNo,
      label: i.kind === 'opening' ? 'Previous dues' : i.kind === 'adhoc' ? 'Charge' : `Fee for ${i.period}`,
      debit: i.total,
      credit: 0,
    })),
    ...payments.map((p) => ({
      date: p.receivedAt,
      type: 'payment' as const,
      ref: p.receiptNo,
      label: `Payment (${p.method.replace('_', ' ')})`,
      debit: 0,
      credit: p.amount,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || (a.type === 'invoice' ? -1 : 1));
  let running = 0;
  for (const e of entries) {
    running += e.debit - e.credit;
    e.balance = running;
  }
  const totalBilled = invoices.reduce((s, i) => s + i.total, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const withDetail = invoices.map((i) => ({
    ...i,
    isOverdue: invoiceIsOverdue(i, today),
    breakdown: headBreakdown(i as never, (paymentsByInvoice.get(i._id.toString()) ?? []) as never),
  }));
  return {
    student,
    summary: {
      totalBilled,
      totalPaid,
      outstanding: invoices.reduce((s, i) => s + i.balance, 0),
      overdue: withDetail.filter((i) => i.isOverdue).reduce((s, i) => s + i.balance, 0),
    },
    ownFees,
    invoices: withDetail,
    payments: payments.map((pay) => ({ ...pay, invoiceNo: invoiceNoById.get(pay.invoiceId.toString()) ?? null })),
    entries: entries.map((e) => ({ ...e, date: formatDateOnly(e.date) })),
  };
}
