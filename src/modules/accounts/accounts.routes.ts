import type { Api } from '../../utils/api';
import { crudRoutes } from '../../utils/crud';
import { badRequest } from '../../utils/errors';
import { parseDateOnly } from '../../utils/dates';
import { findOwned } from '../../utils/tenant';
import { amountPkr, docBase, idParams, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { ApprovalRes } from '../approvals/approvals.routes';
import { Campus } from '../campuses/campus.model';
import { EXPENSE_CATEGORIES, Expense, INCOME_CATEGORIES, Income, PAYMENT_METHODS } from './accounts.models';
import * as svc from './accounts.service';

const IncomeRes = z
  .object({
    ...docBase,
    campusId: objectId().optional(),
    category: z.enum(INCOME_CATEGORIES),
    amount: z.number(),
    date: z.string(),
    description: z.string().optional(),
    payer: z.string().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    reference: z.string().optional(),
  })
  .openapi('Income');

const ExpenseRes = z
  .object({
    ...docBase,
    campusId: objectId().optional(),
    category: z.enum(EXPENSE_CATEGORIES),
    amount: z.number(),
    date: z.string(),
    vendor: z.string().optional(),
    description: z.string().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    reference: z.string().optional(),
    status: z.enum(['pending_approval', 'approved', 'rejected']),
    approvalId: objectId().optional(),
    source: z.enum(['manual', 'payroll']),
  })
  .openapi('Expense');

const dateRange = z
  .object({ from: isoDate(), to: isoDate() })
  .refine((v) => v.from <= v.to, { message: 'from must be on or before to', path: ['to'] });

export function registerAccountRoutes(api: Api) {
  const tag = 'Accounts';
  const tags = [tag];

  crudRoutes(api, {
    path: '/accounts/income',
    tag,
    label: 'income entry',
    model: Income,
    read: 'accounts:read',
    write: 'accounts:manage',
    createSchema: z.object({
      category: z.enum(INCOME_CATEGORIES),
      amount: amountPkr().min(1),
      date: isoDate(),
      description: z.string().trim().max(300).optional(),
      payer: z.string().trim().max(100).optional(),
      paymentMethod: z.enum(PAYMENT_METHODS).optional(),
      reference: z.string().trim().max(100).optional(),
      campusId: objectId().optional(),
    }),
    response: IncomeRes,
    filters: {
      schema: z.object({
        category: z.enum(INCOME_CATEGORIES).optional(),
        from: isoDate().optional(),
        to: isoDate().optional(),
      }),
      toFilter: (q) => ({
        ...(q.category ? { category: q.category } : {}),
        ...(q.from || q.to
          ? {
              date: {
                ...(q.from ? { $gte: parseDateOnly(q.from) } : {}),
                ...(q.to ? { $lte: parseDateOnly(q.to) } : {}),
              },
            }
          : {}),
      }),
    },
    sort: { date: -1 },
    searchFields: ['description', 'payer'],
    refs: (b) => [[Campus, b.campusId, 'campusId']],
    prepare: (ctx, body) => ({
      ...body,
      ...(body.date ? { date: parseDateOnly(body.date) } : {}),
      createdBy: ctx.userId,
    }),
  });

  api.route({
    method: 'get',
    path: '/accounts/expenses',
    tags,
    auth: 'school',
    permission: 'accounts:read',
    summary: 'List expenses',
    query: paginationQuery.extend({
      from: isoDate().optional(),
      to: isoDate().optional(),
      category: z.enum(EXPENSE_CATEGORIES).optional(),
      status: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
    }),
    response: ExpenseRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listExpenses(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/accounts/expenses/:id',
    tags,
    auth: 'school',
    permission: 'accounts:read',
    summary: 'Get an expense',
    params: idParams,
    response: ExpenseRes,
    handler: ({ ctx, params }) => findOwned(Expense, ctx, params.id, 'Expense'),
  });

  api.route({
    method: 'post',
    path: '/accounts/expenses',
    tags,
    auth: 'school',
    permission: 'accounts:manage',
    summary: 'Record an expense',
    description:
      'Expenses at or above `settings.approvals.expenseThreshold` are created with status `pending_approval` and an approval request; ' +
      'they are excluded from financial totals until approved.',
    body: z.object({
      category: z.enum(EXPENSE_CATEGORIES),
      amount: amountPkr().min(1),
      date: isoDate(),
      vendor: z.string().trim().max(100).optional(),
      description: z.string().trim().max(300).optional(),
      paymentMethod: z.enum(PAYMENT_METHODS).optional(),
      reference: z.string().trim().max(100).optional(),
      campusId: objectId().optional(),
    }),
    response: z.object({ expense: ExpenseRes, approvalRequired: z.boolean(), approval: ApprovalRes.nullable() }),
    status: 201,
    handler: ({ ctx, body }) => {
      if (body.category === 'salaries') throw badRequest('Record salaries through payroll');
      return svc.createExpense(ctx, body);
    },
  });

  api.route({
    method: 'delete',
    path: '/accounts/expenses/:id',
    tags,
    auth: 'school',
    permission: 'accounts:manage',
    summary: 'Delete a manual expense',
    params: idParams,
    status: 204,
    handler: ({ ctx, params }) => svc.deleteExpense(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/accounts/summary',
    tags,
    auth: 'school',
    permission: 'accounts:read',
    summary: 'Income, expenses and net for a date range, with monthly breakdown',
    query: dateRange,
    response: z.object({
      from: z.string(),
      to: z.string(),
      feeCollections: z.number(),
      feePaymentsCount: z.number(),
      feeCollectionsByMethod: z.array(z.object({ method: z.string(), total: z.number() })),
      otherIncome: z.number(),
      incomeByCategory: z.array(z.object({ category: z.string(), total: z.number() })),
      totalIncome: z.number(),
      expenses: z.number(),
      expensesByCategory: z.array(z.object({ category: z.string(), total: z.number() })),
      net: z.number(),
      monthly: z.array(
        z.object({
          month: z.string(),
          feeCollections: z.number(),
          otherIncome: z.number(),
          expenses: z.number(),
          net: z.number(),
        }),
      ),
    }),
    handler: ({ ctx, query }) => svc.financialSummary(ctx, query.from, query.to),
  });
}
