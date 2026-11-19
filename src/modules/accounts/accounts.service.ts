import type { SchoolContext, SystemContext } from '../../types/context';
import { addDays, localDayRange, parseDateOnly } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { conflict } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { assertRefs, findOwned, oid, scope } from '../../utils/tenant';
import { createApprovalRequest } from '../approvals/approvals.service';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { Payment } from '../fees/fees.models';
import { School } from '../schools/school.model';
import { Expense, Income, type ExpenseCategory, type PaymentMethod } from './accounts.models';

type Ctx = SchoolContext;

export async function createExpense(
  ctx: Ctx,
  input: {
    category: ExpenseCategory;
    amount: number;
    date: string;
    vendor?: string;
    description?: string;
    paymentMethod?: PaymentMethod;
    reference?: string;
    campusId?: string;
  },
) {
  await assertRefs(ctx, [[Campus, input.campusId, 'campusId']]);
  const school = await School.findById(ctx.schoolId).select('settings.approvals').lean();
  const threshold = school?.settings?.approvals?.expenseThreshold ?? 50_000;
  const needsApproval = input.amount >= threshold;
  const expense = await Expense.create({
    ...input,
    schoolId: ctx.schoolId,
    date: parseDateOnly(input.date),
    status: needsApproval ? 'pending_approval' : 'approved',
    createdBy: ctx.userId,
  });
  let approval = null;
  if (needsApproval) {
    approval = await createApprovalRequest(ctx, {
      type: 'expense',
      title: `Expense Rs ${input.amount} — ${input.category}${input.vendor ? ` (${input.vendor})` : ''}`,
      entityType: 'Expense',
      entityId: expense._id,
      amount: input.amount,
      payload: { expenseId: expense._id.toString() },
      data: { ...input, threshold },
      analysis: `Amount Rs ${input.amount} is at or above the approval threshold of Rs ${threshold}.`,
    });
    await Expense.updateOne(scope(ctx, { _id: expense._id }), { $set: { approvalId: approval._id } });
  }
  await audit(ctx, {
    action: 'expense.create',
    entityType: 'Expense',
    entityId: expense._id,
    metadata: { amount: input.amount, needsApproval },
  });
  return { expense: { ...expense.toObject(), approvalId: approval?._id }, approvalRequired: needsApproval, approval };
}

export async function setExpenseStatus(ctx: Ctx, expenseId: string, status: 'approved' | 'rejected') {
  const res = await Expense.updateOne(scope(ctx, { _id: oid(expenseId), status: 'pending_approval' }), {
    $set: { status },
  });
  if (!res.matchedCount) throw new Error('Expense is not pending approval');
  return { expenseId, status };
}

export async function deleteExpense(ctx: Ctx, id: string) {
  const expense = await findOwned(Expense, ctx, id, 'Expense');
  if (expense.source === 'payroll') throw conflict('Payroll expenses are managed from payroll');
  if (expense.status === 'pending_approval') throw conflict('Cancel the pending approval request first');
  await Expense.deleteOne(scope(ctx, { _id: expense._id }));
  await audit(ctx, {
    action: 'expense.delete',
    entityType: 'Expense',
    entityId: expense._id,
    metadata: { amount: expense.amount },
  });
}

export async function listExpenses(
  ctx: Ctx,
  q: { page: number; limit: number; from?: string; to?: string; category?: string; status?: string },
) {
  const filter: Record<string, unknown> = scope(ctx);
  if (q.category) filter.category = q.category;
  if (q.status) filter.status = q.status;
  if (q.from || q.to)
    filter.date = {
      ...(q.from ? { $gte: parseDateOnly(q.from) } : {}),
      ...(q.to ? { $lte: parseDateOnly(q.to) } : {}),
    };
  return paginate(Expense, filter, { page: q.page, limit: q.limit, sort: { date: -1 } });
}

/**
 * Financial summary for a date range. Fee collections come from valid payments; other
 * income from Income; expenses count only once approved.
 */
export async function financialSummary(actor: Ctx | SystemContext, from: string, to: string) {
  // Income and expense `date` are calendar dates (UTC midnight of the local day).
  const range = { $gte: parseDateOnly(from), $lt: addDays(parseDateOnly(to), 1) };
  // Payment `receivedAt` is a real timestamp, so the days are bounded in the school's timezone.
  const tz = await schoolTimezone(actor.schoolId);
  const local = localDayRange(from, to, tz);
  const paidRange = { $gte: local.start, $lt: local.end };
  const [fees, feesByMethod, income, expenses, monthlyFees, monthlyIncome, monthlyExpenses] = await Promise.all([
    Payment.aggregate([
      { $match: scope(actor, { status: 'valid', receivedAt: paidRange }) },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: scope(actor, { status: 'valid', receivedAt: paidRange }) },
      { $group: { _id: '$method', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    Income.aggregate([
      { $match: scope(actor, { date: range }) },
      { $group: { _id: '$category', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    Expense.aggregate([
      { $match: scope(actor, { date: range, status: 'approved' }) },
      { $group: { _id: '$category', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    Payment.aggregate([
      { $match: scope(actor, { status: 'valid', receivedAt: paidRange }) },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$receivedAt', timezone: tz } },
          total: { $sum: '$amount' },
        },
      },
    ]),
    Income.aggregate([
      { $match: scope(actor, { date: range }) },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, total: { $sum: '$amount' } } },
    ]),
    Expense.aggregate([
      { $match: scope(actor, { date: range, status: 'approved' }) },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, total: { $sum: '$amount' } } },
    ]),
  ]);
  const feeTotal = fees[0]?.total ?? 0;
  const otherIncome = income.reduce((s, r) => s + r.total, 0);
  const expenseTotal = expenses.reduce((s, r) => s + r.total, 0);
  const months = new Map<
    string,
    { month: string; feeCollections: number; otherIncome: number; expenses: number; net: number }
  >();
  const row = (m: string) => {
    if (!months.has(m)) months.set(m, { month: m, feeCollections: 0, otherIncome: 0, expenses: 0, net: 0 });
    return months.get(m)!;
  };
  monthlyFees.forEach((r) => (row(r._id).feeCollections = r.total));
  monthlyIncome.forEach((r) => (row(r._id).otherIncome = r.total));
  monthlyExpenses.forEach((r) => (row(r._id).expenses = r.total));
  for (const m of months.values()) m.net = m.feeCollections + m.otherIncome - m.expenses;
  return {
    from,
    to,
    feeCollections: feeTotal,
    feePaymentsCount: fees[0]?.count ?? 0,
    feeCollectionsByMethod: feesByMethod.map((r) => ({ method: r._id, total: r.total })),
    otherIncome,
    incomeByCategory: income.map((r) => ({ category: r._id, total: r.total })),
    totalIncome: feeTotal + otherIncome,
    expenses: expenseTotal,
    expensesByCategory: expenses.map((r) => ({ category: r._id, total: r.total })),
    net: feeTotal + otherIncome - expenseTotal,
    monthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}
