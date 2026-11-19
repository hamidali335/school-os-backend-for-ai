import type { SchoolContext } from '../../types/context';
import { forbidden, notFound } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import { visibleStudentIds } from '../academics/access.service';
import { School } from '../schools/school.model';
import { Parent, Student } from '../students/student.models';
import { challanFigures, type ChallanData } from '../../services/pdf';
import { pickInstallment } from './fee-calc';
import { Invoice } from './fees.models';
import { getInvoice } from './fees.service';

type Ctx = SchoolContext;

/**
 * Everything a challan prints for one invoice (and one installment of it, when it is split).
 * The single source for the challan PDF and the family voucher, so both show the same figures.
 */
export async function challanData(
  ctx: Ctx,
  invoiceId: string,
  installmentNo?: number,
  opts: { withPreviousDues?: boolean } = {},
): Promise<ChallanData> {
  const inv: any = await getInvoice(ctx, invoiceId);
  const previous = opts.withPreviousDues ? await previousDues(ctx, inv) : undefined;
  const school = await School.findById(ctx.schoolId).select('settings.fees.bankDetails').lean();
  const installment = pickInstallment(inv.installments ?? [], installmentNo);
  const primary = (inv.studentId.guardians ?? []).find((g: any) => g.isPrimary) ?? inv.studentId.guardians?.[0];
  const guardian = primary
    ? await Parent.findOne(scope(ctx, { _id: primary.parentId }))
        .select('name')
        .lean()
    : null;
  return {
    bankDetails: school?.settings?.fees?.bankDetails ?? undefined,
    invoiceNo: inv.invoiceNo,
    period: inv.period,
    issueDate: inv.issueDate,
    dueDate: installment?.dueDate ?? inv.dueDate,
    studentName: `${inv.studentId.firstName} ${inv.studentId.lastName ?? ''}`.trim(),
    admissionNo: inv.studentId.admissionNo,
    fatherName: guardian?.name,
    className: inv.classId?.name,
    sectionName: inv.sectionId?.name,
    items: inv.items,
    subtotal: inv.subtotal,
    concession: inv.concession,
    waiver: inv.waiver,
    lateFee: inv.lateFee,
    total: inv.total,
    paid: inv.paid,
    balance: inv.balance,
    status: inv.status,
    installment,
    ...(previous?.amount ? { previousDues: previous } : {}),
  };
}

/**
 * What the student still owes on their other open invoices of this month or earlier (unpaid
 * months, previous dues brought in by the fee import): printed on a single challan as
 * "Previous dues" so the voucher shows everything payable. Later months are not included.
 */
export async function previousDues(ctx: Ctx, inv: { _id: unknown; studentId: any; period: string }) {
  const studentId = inv.studentId?._id ?? inv.studentId;
  const rows = await Invoice.find(
    scope(ctx, {
      studentId,
      _id: { $ne: inv._id },
      status: { $in: ['unpaid', 'partial'] },
      balance: { $gt: 0 },
      period: { $lte: inv.period },
    }),
  )
    .select('invoiceNo period balance')
    .sort({ period: 1, invoiceNo: 1 })
    .lean();
  return {
    amount: rows.reduce((s, r) => s + r.balance, 0),
    invoices: rows.map((r) => ({ invoiceNo: r.invoiceNo, period: r.period, balance: r.balance })),
  };
}

export interface FamilyChild {
  studentId: string;
  name: string;
  admissionNo: string;
  className: string | null;
  sectionName: string | null;
  relation: string;
  invoices: Array<ChallanData & { invoiceId: string; payableNow: number }>;
  payable: number;
}

/**
 * A parent's children (in this school, visible to the user) with their open invoices. Each
 * invoice stays a separate liability with its own number and balance: the family voucher only
 * presents them together; payments are still recorded against each invoice.
 */
export async function familyAccount(ctx: Ctx, parentId: string) {
  if (ctx.role === 'parent' && ctx.parentId !== parentId) throw forbidden('You can only see your own family’s fees');
  const parent = await Parent.findOne(scope(ctx, { _id: oid(parentId) }))
    .select('name phone cnic')
    .lean();
  if (!parent) throw notFound('Parent');
  const visible = await visibleStudentIds(ctx);
  const students = await Student.find(
    scope(ctx, {
      'guardians.parentId': parent._id,
      status: { $ne: 'archived' },
      ...(visible ? { _id: { $in: visible.map(oid) } } : campusScope(ctx)),
    }),
  )
    .select('firstName lastName admissionNo classId sectionId guardians status')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .sort({ firstName: 1 })
    .lean();
  const open = await Invoice.find(
    scope(ctx, {
      studentId: { $in: students.map((s) => s._id) },
      status: { $in: ['unpaid', 'partial'] },
      balance: { $gt: 0 },
      ...campusScope(ctx),
    }),
  )
    .select('_id studentId dueDate')
    .sort({ dueDate: 1 })
    .lean();
  const children: FamilyChild[] = [];
  for (const s of students) {
    const invoices: FamilyChild['invoices'] = [];
    for (const i of open.filter((x) => String(x.studentId) === String(s._id))) {
      const data = await challanData(ctx, String(i._id));
      invoices.push({ ...data, invoiceId: String(i._id), payableNow: challanFigures(data).payableNow });
    }
    const g = s.guardians.find((x) => String(x.parentId) === String(parent._id));
    children.push({
      studentId: String(s._id),
      name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
      admissionNo: s.admissionNo,
      className: (s.classId as { name?: string } | null)?.name ?? null,
      sectionName: (s.sectionId as { name?: string } | null)?.name ?? null,
      relation: g?.relation ?? 'guardian',
      invoices,
      payable: invoices.reduce((sum, x) => sum + x.payableNow, 0),
    });
  }
  return {
    parent: { _id: String(parent._id), name: parent.name, phone: parent.phone },
    children,
    total: children.reduce((sum, c) => sum + c.payable, 0),
  };
}

/** A stable reference printed on a family voucher (not an invoice number). */
export const familyReference = (parentId: string, date: Date) =>
  `FAM-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${parentId.slice(-6).toUpperCase()}`;
