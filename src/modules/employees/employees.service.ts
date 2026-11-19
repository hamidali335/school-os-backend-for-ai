import { nextNumber } from '../../database/counter.model';
import { atomic, inTransaction } from '../../database/transactions';
import type { SchoolContext } from '../../types/context';
import { parseDateOnly } from '../../utils/dates';
import { badRequest } from '../../utils/errors';
import { assertCampusAccess, assertRefs, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { provisionEmployeeAccount, type ProvisionedAccount } from '../users/users.service';
import type { CreateEmployeeInput } from './employee.schemas';
import { Employee } from './employee.model';

/**
 * Add a staff member; teaching staff get a login (activation link) unless `login.create` is
 * false. Used by POST /employees and by the staff import.
 */
export async function createEmployee(ctx: SchoolContext, body: CreateEmployeeInput) {
  const { login, ...data } = body;
  await assertRefs(ctx, [[Campus, data.campusId, 'campusId']]);
  assertCampusAccess(ctx, data.campusId);
  const wantLogin = login?.create ?? data.staffType === 'teaching';
  const loginRole = login?.role ?? (data.staffType === 'teaching' ? 'teacher' : undefined);
  if (wantLogin && !loginRole)
    throw badRequest('Choose the account role for this staff member', { field: 'login.role' });
  if (wantLogin && loginRole === 'staff' && !login?.customRoleId)
    throw badRequest('Choose a custom role for this account', { field: 'login.customRoleId' });
  const canCreateLogin = ctx.permissions.has('users:manage');
  const employeeNo = data.employeeNo ?? (await nextNumber(ctx.schoolId, 'employee', 'EMP-', 4));
  const created = await atomic(async () => {
    const emp = await Employee.create({
      ...data,
      schoolId: ctx.schoolId,
      employeeNo,
      joiningDate: data.joiningDate ? parseDateOnly(data.joiningDate) : undefined,
    });
    let account: ProvisionedAccount | null = null;
    if (wantLogin && canCreateLogin) {
      try {
        account = await provisionEmployeeAccount(ctx, emp._id.toString(), {
          role: loginRole,
          customRoleId: login?.customRoleId,
        });
      } catch (err) {
        if (inTransaction()) throw err; // the abort removes the employee too
        // Roll back so a retry does not hit a duplicate employee number or leave an orphan.
        await Employee.deleteOne(scope(ctx, { _id: emp._id }));
        throw err;
      }
    }
    return { emp, account };
  });
  const { emp, account } = created;
  await audit(ctx, {
    action: 'employee.create',
    entityType: 'Employee',
    entityId: emp._id,
    metadata: { staffType: data.staffType, login: account ? account.role : null },
  });
  const saved = await Employee.findOne(scope(ctx, { _id: emp._id })).lean();
  return {
    ...saved,
    account,
    ...(wantLogin && !canCreateLogin
      ? { accountSkipped: 'You do not have permission to create login accounts. Ask the school Admin.' }
      : {}),
  };
}
