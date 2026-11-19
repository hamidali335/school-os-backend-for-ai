import { nextNumber } from '../../database/counter.model';
import { atomic, inTransaction } from '../../database/transactions';
import type { Api } from '../../utils/api';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { endOfMonthUtc, parseDateOnly } from '../../utils/dates';
import { paginate, textSearchFilter } from '../../utils/pagination';
import { assertCampusAccess, assertRefs, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import {
  amountPkr,
  billingPeriod,
  docBase,
  email,
  idParams,
  isoDate,
  objectId,
  paginationQuery,
  phonePk,
  z,
} from '../../utils/zod';
import { Expense, PAYMENT_METHODS } from '../accounts/accounts.models';
import { audit } from '../audit/audit.service';
import { revokeAllForSubject } from '../auth/tokens';
import { Campus } from '../campuses/campus.model';
import { User } from '../users/user.model';
import { AccountSummaryRes, ProvisionedAccountRes } from '../users/account-schemas';
import { accountFor, provisionEmployeeAccount, type ProvisionedAccount } from '../users/users.service';
import { checkEmployeeDeletion, deleteEmployee } from './employee-deletion';
import { createEmployee } from './employees.service';
import { phoneRegex } from '../students/student-search';
import { CreateEmployeeBody, EmployeeBody } from './employee.schemas';
import { archiveEmployee, unarchiveEmployee } from '../users/archive.service';
import { EMPLOYEE_STATUSES, Employee, Payslip, SETTABLE_EMPLOYEE_STATUSES } from './employee.model';

const EmployeeRes = z
  .object({
    ...docBase,
    campusId: objectId(),
    employeeNo: z.string(),
    firstName: z.string(),
    lastName: z.string().optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    designation: z.string(),
    department: z.string().optional(),
    staffType: z.enum(['teaching', 'non_teaching']),
    qualification: z.string().optional(),
    joiningDate: z.string().optional(),
    status: z.enum(EMPLOYEE_STATUSES),
    archive: z
      .object({ previousStatus: z.string(), archivedAt: z.string(), reason: z.string().optional() })
      .optional()
      .openapi({ description: 'Present while archived' }),
    userId: objectId().optional(),
    cnic: z
      .string()
      .optional()
      .openapi({ description: 'Only returned to users with employees:manage or payroll:manage' }),
    salary: z
      .object({ basic: z.number(), allowances: z.number(), deductions: z.number() })
      .optional()
      .openapi({ description: 'Only returned to users with employees:manage or payroll:manage' }),
    bankAccount: z.string().optional(),
  })
  .openapi('Employee');

const PayslipRes = z
  .object({
    ...docBase,
    employeeId: z.any(),
    period: z.string(),
    basic: z.number(),
    allowances: z.number(),
    deductions: z.number(),
    bonus: z.number(),
    net: z.number(),
    status: z.enum(['draft', 'paid', 'cancelled']),
    paidAt: z.string().optional(),
    paymentMethod: z.string().optional(),
    expenseId: objectId().optional(),
    notes: z.string().optional(),
  })
  .openapi('Payslip');

const canSeeSensitive = (ctx: SchoolContext) =>
  ctx.permissions.has('employees:manage') || ctx.permissions.has('payroll:manage');
const SENSITIVE = '-cnic -salary -bankAccount';

const netPay = (p: { basic: number; allowances: number; deductions: number; bonus: number }) =>
  Math.max(0, p.basic + p.allowances + p.bonus - p.deductions);

export function registerEmployeeRoutes(api: Api) {
  const tags = ['Employees'];

  api.route({
    method: 'get',
    path: '/employees',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'List employees and staff',
    query: paginationQuery.extend({
      q: z.string().max(100).optional(),
      campusId: objectId().optional(),
      staffType: z.enum(['teaching', 'non_teaching']).optional(),
      status: z.enum(EMPLOYEE_STATUSES).optional(),
      department: z.string().max(60).optional(),
    }),
    response: EmployeeRes,
    paginated: true,
    handler: ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx, campusScope(ctx));
      if (query.campusId) filter.campusId = oid(query.campusId);
      if (query.staffType) filter.staffType = query.staffType;
      // Archived staff are hidden unless asked for (?status=archived).
      filter.status = query.status ?? { $ne: 'archived' };
      if (query.department) filter.department = query.department;
      const match = textSearchFilter(
        query.q,
        ['firstName', 'lastName'],
        // CNIC only for those allowed to see it.
        ['employeeNo', 'designation', 'department', 'email', ...(canSeeSensitive(ctx) ? ['cnic'] : [])],
      );
      if (match) {
        const phone = phoneRegex(query.q);
        filter.$or = [...match.$or, ...(phone ? [{ phone }] : [])];
      }
      return paginate(Employee, filter, {
        page: query.page,
        limit: query.limit,
        sort: { firstName: 1 },
        select: canSeeSensitive(ctx) ? undefined : SENSITIVE,
      });
    },
  });

  api.route({
    method: 'get',
    path: '/employees/:id',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Get an employee',
    params: idParams,
    response: EmployeeRes,
    handler: async ({ ctx, params }) => {
      const emp = await Employee.findOne(scope(ctx, { _id: oid(params.id), ...campusScope(ctx) }))
        .select(canSeeSensitive(ctx) ? '' : SENSITIVE)
        .lean();
      if (!emp) throw notFound('Employee');
      return emp;
    },
  });

  api.route({
    method: 'post',
    path: '/employees',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Add an employee (teachers get a login automatically)',
    description:
      'Teaching staff: a teacher login is provisioned in the same request (status `pending`; the activation token is returned once in `account.activation`). ' +
      'Non-teaching staff: no login unless `login.create` is true, with a staff role (and `customRoleId` for custom roles). ' +
      'If the login cannot be created the employee record is rolled back, so no orphaned records remain. Requires `users:manage` to create logins; ' +
      'without it the employee is saved and `accountSkipped` explains why.',
    body: CreateEmployeeBody,
    response: EmployeeRes.extend({
      account: ProvisionedAccountRes.nullable(),
      accountSkipped: z.string().optional(),
    }),
    status: 201,
    handler: ({ ctx, body }) => createEmployee(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/employees/:id/account',
    tags,
    auth: 'school',
    permission: ['employees:read', 'users:manage'],
    summary: 'Create the login for an existing staff member (idempotent)',
    description:
      'Returns the existing login (`created: false`) instead of creating a duplicate. New logins are `pending` until the activation link is used.',
    params: idParams,
    body: z.object({
      role: z.enum(['teacher', 'principal', 'school_admin', 'accountant', 'staff']).optional(),
      customRoleId: objectId().optional(),
    }),
    response: ProvisionedAccountRes,
    handler: async ({ ctx, params, body }) => {
      const emp = await Employee.findOne(scope(ctx, { _id: oid(params.id), ...campusScope(ctx) })).lean();
      if (!emp) throw notFound('Employee');
      if (!body.role && emp.staffType !== 'teaching')
        throw badRequest('Choose the account role for this staff member', { field: 'role' });
      return provisionEmployeeAccount(ctx, emp._id.toString(), {
        role: body.role,
        customRoleId: body.customRoleId,
        provisionedBy: 'manual',
      });
    },
  });

  api.route({
    method: 'get',
    path: '/employees/:id/account',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Login account linked to a staff member (null when none)',
    params: idParams,
    response: AccountSummaryRes.nullable(),
    handler: async ({ ctx, params }) => {
      const emp = await Employee.findOne(scope(ctx, { _id: oid(params.id), ...campusScope(ctx) }))
        .select('_id')
        .lean();
      if (!emp) throw notFound('Employee');
      return accountFor(ctx, 'employeeId', emp._id);
    },
  });

  api.route({
    method: 'get',
    path: '/employees/:id/deletion-check',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Can this staff record be deleted? (records added by mistake only)',
    description:
      'Lists what blocks deletion (payslips, homework, documents, substitutions, a used login) and what setup would be removed with it.',
    params: idParams,
    response: z.object({
      canDelete: z.boolean(),
      blockers: z.array(z.object({ kind: z.string(), count: z.number(), label: z.string() })),
      willRemove: z.object({
        teachingAssignments: z.number(),
        timetablePeriods: z.number(),
        classTeacherOf: z.array(z.string()),
        login: z.string().nullable(),
      }),
    }),
    handler: ({ ctx, params }) => checkEmployeeDeletion(ctx, params.id),
  });

  api.route({
    method: 'delete',
    path: '/employees/:id',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Permanently delete a staff record added by mistake',
    description:
      'Only allowed when the record has no history and its login was never used (otherwise 409 `IN_USE`: mark the person resigned or terminated instead). ' +
      'Also removes their unused login, teaching assignments and timetable periods, and clears the class-teacher slot.',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    status: 204,
    handler: ({ ctx, params, body }) => deleteEmployee(ctx, params.id, body.reason),
  });

  api.route({
    method: 'patch',
    path: '/employees/:id',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Update an employee (use status resigned/terminated instead of deleting)',
    params: idParams,
    body: EmployeeBody.partial(),
    response: EmployeeRes,
    handler: async ({ ctx, params, body }) => {
      const emp = await findOwned(Employee, ctx, params.id, 'Employee');
      assertCampusAccess(ctx, emp.campusId);
      if (emp.status === 'archived' && body.status)
        throw conflict('This staff member is archived. Restore them from the archive first.');
      await assertRefs(ctx, [[Campus, body.campusId, 'campusId']]);
      const set: Record<string, unknown> = { ...body };
      if (body.joiningDate) set.joiningDate = parseDateOnly(body.joiningDate);
      if (
        body.status &&
        ['resigned', 'terminated'].includes(body.status) &&
        !['resigned', 'terminated'].includes(emp.status)
      ) {
        set.leftAt = new Date();
      }
      if (body.salary) {
        set['salary.basic'] = body.salary.basic;
        if (body.salary.allowances !== undefined) set['salary.allowances'] = body.salary.allowances;
        if (body.salary.deductions !== undefined) set['salary.deductions'] = body.salary.deductions;
        delete set.salary;
      }
      const updated = await Employee.findOneAndUpdate(
        scope(ctx, { _id: emp._id }),
        { $set: set },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      // Staff who leave must not keep access: disable their login and end their sessions.
      if (set.leftAt) {
        const login = await User.findOneAndUpdate(scope(ctx, { employeeId: emp._id, status: { $ne: 'disabled' } }), {
          $set: { status: 'disabled', statusReason: `Employee ${body.status}` },
          $inc: { tokenVersion: 1 },
        }).lean();
        if (login) {
          await revokeAllForSubject('user', login._id.toString(), 'employee_left');
          await audit(ctx, {
            action: 'user.status_disabled',
            entityType: 'User',
            entityId: login._id,
            metadata: { reason: 'employee_left' },
          });
        }
      }
      await audit(ctx, {
        action: 'employee.update',
        entityType: 'Employee',
        entityId: emp._id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    },
  });

  api.route({
    method: 'post',
    path: '/employees/:id/archive',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Archive a staff member (keeps all history; hides from active lists; suspends their login)',
    description:
      'For staff records with history that should no longer be in use. Restore with `POST /employees/{id}/unarchive`. List archived staff with `GET /employees?status=archived`.',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    response: EmployeeRes.extend({ loginsSuspended: z.number() }),
    handler: ({ ctx, params, body }) => archiveEmployee(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/employees/:id/unarchive',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Restore an archived staff member (previous status and login come back as they were)',
    params: idParams,
    response: EmployeeRes.extend({ loginsRestored: z.number() }),
    handler: ({ ctx, params }) => unarchiveEmployee(ctx, params.id),
  });

  // ─────────────────────────── Payroll ───────────────────────────
  const ptags = ['Payroll'];

  api.route({
    method: 'post',
    path: '/payroll/generate',
    tags: ptags,
    auth: 'school',
    permission: 'payroll:manage',
    summary: 'Generate draft payslips for all active employees for a month',
    description: 'Idempotent: employees who already have a payslip for the period are skipped.',
    body: z.object({ period: billingPeriod() }),
    response: z.object({ period: z.string(), created: z.number(), skipped: z.number() }),
    handler: async ({ ctx, body }) => {
      const monthEnd = endOfMonthUtc(body.period);
      const employees = await Employee.find(
        scope(ctx, {
          status: { $in: ['active', 'on_leave'] },
          $or: [{ joiningDate: null }, { joiningDate: { $lte: monthEnd } }],
        }),
      ).lean();
      const existing = new Set(
        (
          await Payslip.find(scope(ctx, { period: body.period }))
            .select('employeeId')
            .lean()
        ).map((p) => p.employeeId.toString()),
      );
      const docs = employees
        .filter((e) => !existing.has(e._id.toString()))
        .map((e) => {
          const p = {
            basic: e.salary?.basic ?? 0,
            allowances: e.salary?.allowances ?? 0,
            deductions: e.salary?.deductions ?? 0,
            bonus: 0,
          };
          return {
            schoolId: oid(ctx.schoolId),
            employeeId: e._id,
            period: body.period,
            ...p,
            net: netPay(p),
            status: 'draft',
          };
        });
      if (docs.length)
        await Payslip.insertMany(docs, { ordered: false }).catch((err) => {
          if (err?.code !== 11000 && !err?.writeErrors) throw err;
        });
      await audit(ctx, {
        action: 'payroll.generate',
        entityType: 'Payslip',
        metadata: { period: body.period, created: docs.length },
      });
      return { period: body.period, created: docs.length, skipped: existing.size };
    },
  });

  api.route({
    method: 'get',
    path: '/payroll/payslips',
    tags: ptags,
    auth: 'school',
    permission: 'payroll:manage',
    summary: 'List payslips',
    query: paginationQuery.extend({
      period: billingPeriod().optional(),
      status: z.enum(['draft', 'paid', 'cancelled']).optional(),
      employeeId: objectId().optional(),
    }),
    response: PayslipRes,
    paginated: true,
    handler: ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      if (query.period) filter.period = query.period;
      if (query.status) filter.status = query.status;
      if (query.employeeId) filter.employeeId = oid(query.employeeId);
      return paginate(Payslip, filter, {
        page: query.page,
        limit: query.limit,
        sort: { period: -1 },
        populate: { path: 'employeeId', select: 'firstName lastName employeeNo designation' },
      });
    },
  });

  api.route({
    method: 'patch',
    path: '/payroll/payslips/:id',
    tags: ptags,
    auth: 'school',
    permission: 'payroll:manage',
    summary: 'Adjust a draft payslip (bonus, deductions, notes); net pay is recomputed',
    params: idParams,
    body: z
      .object({ allowances: amountPkr(), deductions: amountPkr(), bonus: amountPkr(), notes: z.string().max(300) })
      .partial(),
    response: PayslipRes,
    handler: async ({ ctx, params, body }) => {
      const slip = await findOwned(Payslip, ctx, params.id, 'Payslip');
      if (slip.status !== 'draft') throw conflict('Only draft payslips can be changed');
      const next = {
        basic: slip.basic,
        allowances: slip.allowances,
        deductions: slip.deductions,
        bonus: slip.bonus,
        ...body,
      };
      const updated = await Payslip.findOneAndUpdate(
        scope(ctx, { _id: slip._id, status: 'draft' }),
        { $set: { ...body, net: netPay(next as any) } },
        { returnDocument: 'after' },
      ).lean();
      await audit(ctx, {
        action: 'payslip.update',
        entityType: 'Payslip',
        entityId: slip._id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    },
  });

  api.route({
    method: 'post',
    path: '/payroll/payslips/:id/pay',
    tags: ptags,
    auth: 'school',
    permission: 'payroll:manage',
    summary: 'Mark a payslip as paid (records a salary expense)',
    params: idParams,
    body: z.object({
      paymentMethod: z.enum(PAYMENT_METHODS),
      paidOn: isoDate(),
      reference: z.string().max(100).optional(),
    }),
    response: PayslipRes,
    handler: async ({ ctx, params, body }) => {
      const slip = await findOwned(Payslip, ctx, params.id, 'Payslip');
      if (slip.status !== 'draft') throw conflict(`Payslip is already ${slip.status}`);
      const claimed = await Payslip.findOneAndUpdate(
        scope(ctx, { _id: slip._id, status: 'draft' }),
        { $set: { status: 'paid', paidAt: parseDateOnly(body.paidOn), paymentMethod: body.paymentMethod } },
        { returnDocument: 'after' },
      ).lean();
      if (!claimed) throw conflict('Payslip was changed concurrently');
      const emp = await Employee.findOne(scope(ctx, { _id: slip.employeeId }))
        .select('firstName lastName employeeNo campusId')
        .lean();
      if (slip.net > 0) {
        const expense = await Expense.create({
          schoolId: ctx.schoolId,
          campusId: emp?.campusId,
          category: 'salaries',
          amount: slip.net,
          date: parseDateOnly(body.paidOn),
          vendor: emp ? `${emp.firstName} ${emp.lastName ?? ''} (${emp.employeeNo})`.trim() : undefined,
          description: `Salary ${slip.period}`,
          paymentMethod: body.paymentMethod,
          reference: body.reference,
          status: 'approved',
          source: 'payroll',
          createdBy: ctx.userId,
        });
        await Payslip.updateOne(scope(ctx, { _id: slip._id }), { $set: { expenseId: expense._id } });
      }
      await audit(ctx, {
        action: 'payslip.paid',
        entityType: 'Payslip',
        entityId: slip._id,
        metadata: { net: slip.net },
      });
      return Payslip.findOne(scope(ctx, { _id: slip._id })).lean();
    },
  });
}
