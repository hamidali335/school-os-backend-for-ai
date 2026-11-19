import type { Types } from 'mongoose';
import { STAFF_ROLES } from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { conflict, notFound } from '../../utils/errors';
import { assertCampusAccess, campusScope, oid, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { revokeAllForSubject } from '../auth/tokens';
import { Employee } from '../employees/employee.model';
import { atomic } from '../../database/transactions';
import { Student } from '../students/student.models';
import { assertActiveStudentRoom } from '../students/students.service';
import { getSchoolLimits, planLimitError } from '../subscriptions/limits.service';
import { User } from './user.model';

/**
 * Archiving keeps a student or staff record (and all its history) but takes it out of daily
 * use: it disappears from active lists, counts and invoice runs, and its sign-in is suspended.
 * Restoring puts everything back exactly as it was, including each login's previous status.
 * Archive is the alternative to deletion once a record has real history (for example a
 * portal account that has been used).
 */
const ARCHIVE_REASON = 'Archived';

async function suspendLogins(ctx: SchoolContext, userIds: Types.ObjectId[]) {
  const users = await User.find(scope(ctx, { _id: { $in: userIds }, status: { $in: ['active', 'pending'] } }))
    .select('_id status')
    .lean();
  for (const u of users) {
    await User.updateOne(scope(ctx, { _id: u._id }), {
      $set: { status: 'suspended', statusReason: ARCHIVE_REASON, statusBeforeArchive: u.status },
      $inc: { tokenVersion: 1 },
    });
    await revokeAllForSubject('user', u._id.toString(), 'archived');
  }
  return users.length;
}

/** Only logins that the archive suspended are restored; ones suspended for other reasons stay so. */
async function restoreLogins(ctx: SchoolContext, userIds: Types.ObjectId[]) {
  const users = await User.find(
    scope(ctx, { _id: { $in: userIds }, status: 'suspended', statusReason: ARCHIVE_REASON }),
  )
    .select('_id statusBeforeArchive')
    .lean();
  for (const u of users) {
    await User.updateOne(scope(ctx, { _id: u._id }), {
      $set: { status: u.statusBeforeArchive ?? 'active' },
      $unset: { statusReason: 1, statusBeforeArchive: 1 },
    });
  }
  return users.length;
}

/** Parent logins whose children are now all archived (a parent with another current child keeps access). */
async function parentLoginsToSuspend(
  ctx: SchoolContext,
  parentIds: Types.ObjectId[],
  excludingStudent: Types.ObjectId,
) {
  const out: Types.ObjectId[] = [];
  for (const pid of parentIds) {
    const otherChild = await Student.exists(
      scope(ctx, { 'guardians.parentId': pid, _id: { $ne: excludingStudent }, status: { $ne: 'archived' } }),
    );
    if (otherChild) continue;
    const login = await User.findOne(scope(ctx, { parentId: pid }))
      .select('_id')
      .lean();
    if (login) out.push(login._id);
  }
  return out;
}

async function loadStudent(ctx: SchoolContext, id: string) {
  const s = await Student.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) })).lean();
  if (!s) throw notFound('Student');
  assertCampusAccess(ctx, s.campusId);
  return s;
}

export async function archiveStudent(ctx: SchoolContext, id: string, reason: string) {
  const s = await loadStudent(ctx, id);
  if (s.status === 'archived') throw conflict('This student is already archived');
  const parentIds = s.guardians.map((g) => g.parentId);
  const studentLogin = await User.findOne(scope(ctx, { studentId: s._id }))
    .select('_id')
    .lean();
  await Student.updateOne(scope(ctx, { _id: s._id }), {
    $set: {
      status: 'archived',
      statusChangedAt: new Date(),
      archive: { previousStatus: s.status, archivedAt: new Date(), archivedBy: oid(ctx.userId), reason },
    },
  });
  const suspended = await suspendLogins(ctx, [
    ...(studentLogin ? [studentLogin._id] : []),
    ...(await parentLoginsToSuspend(ctx, parentIds, s._id)),
  ]);
  await audit(ctx, {
    action: 'student.archived',
    entityType: 'Student',
    entityId: s._id,
    summary: `${[s.firstName, s.lastName].filter(Boolean).join(' ')} (${s.admissionNo}): ${reason}`,
    metadata: { reason, previousStatus: s.status, loginsSuspended: suspended },
  });
  return { ...(await Student.findOne(scope(ctx, { _id: s._id })).lean()), loginsSuspended: suspended };
}

export async function unarchiveStudent(ctx: SchoolContext, id: string) {
  const s = await loadStudent(ctx, id);
  if (s.status !== 'archived') throw conflict('This student is not archived');
  const restoreTo = (s.archive?.previousStatus as string | undefined) ?? 'active';
  // Restored as active: the limit is counted and the status saved in one transaction.
  await atomic(async () => {
    if (restoreTo === 'active') await assertActiveStudentRoom(ctx);
    await Student.updateOne(scope(ctx, { _id: s._id }), {
      $set: { status: restoreTo, statusChangedAt: new Date() },
      $unset: { archive: 1 },
    });
  });
  const studentLogin = await User.findOne(scope(ctx, { studentId: s._id }))
    .select('_id')
    .lean();
  const parentLogins = await User.find(scope(ctx, { parentId: { $in: s.guardians.map((g) => g.parentId) } }))
    .select('_id')
    .lean();
  const restored = await restoreLogins(ctx, [
    ...(studentLogin ? [studentLogin._id] : []),
    ...parentLogins.map((p) => p._id),
  ]);
  await audit(ctx, {
    action: 'student.unarchived',
    entityType: 'Student',
    entityId: s._id,
    metadata: { restoredStatus: restoreTo, loginsRestored: restored },
  });
  return { ...(await Student.findOne(scope(ctx, { _id: s._id })).lean()), loginsRestored: restored };
}

async function loadEmployee(ctx: SchoolContext, id: string) {
  const e = await Employee.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) })).lean();
  if (!e) throw notFound('Employee');
  assertCampusAccess(ctx, e.campusId);
  return e;
}

export async function archiveEmployee(ctx: SchoolContext, id: string, reason: string) {
  const e = await loadEmployee(ctx, id);
  if (e.status === 'archived') throw conflict('This staff member is already archived');
  const login = await User.findOne(scope(ctx, { employeeId: e._id }))
    .select('_id role')
    .lean();
  if (login?.role === 'school_owner') throw conflict('The school owner account cannot be archived');
  if (login && login._id.toString() === ctx.userId) throw conflict('You cannot archive your own staff record');
  await Employee.updateOne(scope(ctx, { _id: e._id }), {
    $set: {
      status: 'archived',
      archive: { previousStatus: e.status, archivedAt: new Date(), archivedBy: oid(ctx.userId), reason },
    },
  });
  const suspended = login ? await suspendLogins(ctx, [login._id]) : 0;
  await audit(ctx, {
    action: 'employee.archived',
    entityType: 'Employee',
    entityId: e._id,
    summary: `${[e.firstName, e.lastName].filter(Boolean).join(' ')} (${e.employeeNo}): ${reason}`,
    metadata: { reason, previousStatus: e.status, loginsSuspended: suspended },
  });
  return { ...(await Employee.findOne(scope(ctx, { _id: e._id })).lean()), loginsSuspended: suspended };
}

export async function unarchiveEmployee(ctx: SchoolContext, id: string) {
  const e = await loadEmployee(ctx, id);
  if (e.status !== 'archived') throw conflict('This staff member is not archived');
  const restoreTo = (e.archive?.previousStatus as string | undefined) ?? 'active';
  const login = await User.findOne(scope(ctx, { employeeId: e._id }))
    .select('_id role statusReason')
    .lean();
  // A restored login counts toward the plan's staff limit again.
  if (login && login.statusReason === ARCHIVE_REASON && STAFF_ROLES.has(login.role as never)) {
    const [limits, count] = await Promise.all([
      getSchoolLimits(ctx.schoolId),
      User.countDocuments(scope(ctx, { role: { $in: [...STAFF_ROLES] }, status: { $in: ['active', 'pending'] } })),
    ]);
    if (count >= limits.maxStaffUsers) throw planLimitError('active staff accounts', limits.maxStaffUsers);
  }
  await Employee.updateOne(scope(ctx, { _id: e._id }), { $set: { status: restoreTo }, $unset: { archive: 1 } });
  const restored = login ? await restoreLogins(ctx, [login._id]) : 0;
  await audit(ctx, {
    action: 'employee.unarchived',
    entityType: 'Employee',
    entityId: e._id,
    metadata: { restoredStatus: restoreTo, loginsRestored: restored },
  });
  return { ...(await Employee.findOne(scope(ctx, { _id: e._id })).lean()), loginsRestored: restored };
}
