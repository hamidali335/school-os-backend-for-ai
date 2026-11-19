import type { SchoolContext } from '../../types/context';
import { conflict, notFound } from '../../utils/errors';
import { assertCampusAccess, campusScope, oid, scope } from '../../utils/tenant';
import { Section, SubstituteAssignment, TeachingAssignment } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { revokeAllForSubject } from '../auth/tokens';
import { FileObject } from '../certificates/files.model';
import { Homework } from '../homework/homework.models';
import { TimetableEntry } from '../timetable/timetable.model';
import { AccountToken, User } from '../users/user.model';
import { Employee, Payslip } from './employee.model';

/**
 * Permanent deletion is only for staff records added by mistake. A record with history (payroll,
 * homework, documents, substitutions, or a login that has been used) must be kept: mark the
 * person resigned or terminated instead, which also disables their login.
 *
 * Setup made together with the mistaken record (teaching assignments, timetable periods, the
 * class-teacher slot) is not history, so it is removed with the record. The admin sees exactly
 * what will be removed before confirming.
 */
export type DeletionCheck = {
  canDelete: boolean;
  /** Reasons the record must be kept. Empty when it can be deleted. */
  blockers: Array<{ kind: string; count: number; label: string }>;
  /** Setup that will be removed together with the record. */
  willRemove: { teachingAssignments: number; timetablePeriods: number; classTeacherOf: string[]; login: string | null };
};

async function load(ctx: SchoolContext, id: string) {
  const emp = await Employee.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) })).lean();
  if (!emp) throw notFound('Employee');
  assertCampusAccess(ctx, emp.campusId);
  const login = await User.findOne(scope(ctx, { employeeId: emp._id }))
    .select('_id name email username status lastLoginAt activatedAt')
    .lean();
  return { emp, login };
}

export async function checkEmployeeDeletion(ctx: SchoolContext, id: string): Promise<DeletionCheck> {
  const { emp, login } = await load(ctx, id);
  const e = emp._id;
  const [payslips, homework, files, substitutions, assignments, periods, sections] = await Promise.all([
    Payslip.countDocuments(scope(ctx, { employeeId: e })),
    Homework.countDocuments(scope(ctx, { teacherId: e })),
    FileObject.countDocuments(scope(ctx, { employeeId: e })),
    SubstituteAssignment.countDocuments(scope(ctx, { $or: [{ originalTeacherId: e }, { substituteTeacherId: e }] })),
    TeachingAssignment.countDocuments(scope(ctx, { teacherId: e })),
    TimetableEntry.countDocuments(scope(ctx, { teacherId: e })),
    Section.find(scope(ctx, { classTeacherId: e }))
      .select('name')
      .lean(),
  ]);

  const blockers: DeletionCheck['blockers'] = [];
  const add = (kind: string, count: number, label: string) => count > 0 && blockers.push({ kind, count, label });
  add('payslips', payslips, `${payslips} payslip${payslips === 1 ? '' : 's'}`);
  add('homework', homework, `${homework} homework assignment${homework === 1 ? '' : 's'}`);
  add('documents', files, `${files} uploaded document${files === 1 ? '' : 's'}`);
  add('substitutions', substitutions, `${substitutions} substitution${substitutions === 1 ? '' : 's'}`);
  // A login that has been used may have marked attendance, entered marks or taken fees.
  if (login && (login.lastLoginAt || login.activatedAt)) add('login_used', 1, 'their login has already been used');

  return {
    canDelete: blockers.length === 0,
    blockers,
    willRemove: {
      teachingAssignments: assignments,
      timetablePeriods: periods,
      classTeacherOf: sections.map((s) => s.name),
      login: login ? (login.email ?? login.username ?? 'login') : null,
    },
  };
}

export async function deleteEmployee(ctx: SchoolContext, id: string, reason: string) {
  const check = await checkEmployeeDeletion(ctx, id);
  if (!check.canDelete) {
    throw conflict(
      `This staff record has history (${check.blockers.map((b) => b.label).join(', ')}). Mark them as resigned or terminated instead.`,
      check.blockers.map((b) => ({ path: b.kind, message: b.label })),
      'IN_USE',
    );
  }
  const { emp, login } = await load(ctx, id);

  // Remove access first, so a half-finished delete can never leave a working login behind.
  if (login) {
    await User.updateOne(scope(ctx, { _id: login._id }), { $set: { status: 'disabled' }, $inc: { tokenVersion: 1 } });
    await revokeAllForSubject('user', login._id.toString(), 'employee_deleted');
    await AccountToken.deleteMany(scope(ctx, { userId: login._id }));
  }
  await Promise.all([
    TeachingAssignment.deleteMany(scope(ctx, { teacherId: emp._id })),
    TimetableEntry.deleteMany(scope(ctx, { teacherId: emp._id })),
    Section.updateMany(scope(ctx, { classTeacherId: emp._id }), { $unset: { classTeacherId: 1 } }),
  ]);
  if (login) await User.deleteOne(scope(ctx, { _id: login._id }));
  await Employee.deleteOne(scope(ctx, { _id: emp._id }));

  await audit(ctx, {
    action: 'employee.deleted',
    entityType: 'Employee',
    entityId: emp._id,
    summary: `${[emp.firstName, emp.lastName].filter(Boolean).join(' ')} (${emp.employeeNo}): ${reason}`,
    metadata: { reason, removed: check.willRemove },
  });
}
