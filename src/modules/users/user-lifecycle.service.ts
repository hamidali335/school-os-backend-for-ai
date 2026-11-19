import type { SchoolRole } from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { conflict } from '../../utils/errors';
import { scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { revokeAllForSubject } from '../auth/tokens';
import { Employee } from '../employees/employee.model';
import { Parent } from '../students/student.models';
import { AccountToken, User, USER_PUBLIC_FIELDS } from './user.model';
import { findUserForManagement, updateUser } from './users.service';

/**
 * The life of a login after it is created:
 * - suspend: access stops at once (sessions and refresh tokens revoked); reactivate restores it;
 * - archive: the person has left; access stops and the account leaves the normal user list,
 *   but every record linked to it (payments received, attendance marked, audit history) stays;
 * - delete: only for an account created by mistake that was never used, so no record can
 *   point to it. Anything else must be archived.
 * The school always keeps at least one active Admin, and nobody can act on their own account.
 */

/** Refuse a change that would leave the school without an active Admin. */
export async function assertAdminRemains(ctx: SchoolContext, target: { _id: unknown; role: string; status: string }) {
  if (target.role !== 'school_owner' || target.status !== 'active') return;
  const others = await User.countDocuments(
    scope(ctx, { role: 'school_owner', status: 'active', _id: { $ne: target._id } }),
  );
  if (!others) throw conflict('The school must keep at least one active Admin account', undefined, 'LAST_ADMIN');
}

function assertNotSelf(ctx: SchoolContext, id: unknown, what: string) {
  if (String(id) === ctx.userId) throw conflict(`You cannot ${what} your own account`, undefined, 'SELF_ACTION');
}

export async function suspendUser(ctx: SchoolContext, id: string, reason?: string) {
  return updateUser(ctx, id, { status: 'suspended', ...(reason ? { statusReason: reason } : {}) });
}

export async function reactivateUser(ctx: SchoolContext, id: string) {
  const target = await findUserForManagement(ctx, id);
  if (target.archivedAt) throw conflict('Restore this account from the archive first', undefined, 'ARCHIVED');
  return updateUser(ctx, id, { status: 'active' });
}

export async function archiveUser(ctx: SchoolContext, id: string, reason: string) {
  const target = await findUserForManagement(ctx, id);
  assertNotSelf(ctx, target._id, 'archive');
  if (target.archivedAt) throw conflict('This account is already archived');
  await assertAdminRemains(ctx, target);
  // Disabling first revokes every session and refresh token straight away.
  if (target.status !== 'disabled') await updateUser(ctx, id, { status: 'disabled', statusReason: reason });
  await User.updateOne(scope(ctx, { _id: target._id }), {
    $set: { archivedAt: new Date(), archivedReason: reason, status: 'disabled' },
    $inc: { tokenVersion: 1 },
  });
  await revokeAllForSubject('user', target._id.toString(), 'archived');
  await AccountToken.updateMany(scope(ctx, { userId: target._id, usedAt: null }), {
    $set: { usedAt: new Date(), expiresAt: new Date() },
  });
  await audit(ctx, {
    action: 'user.archived',
    entityType: 'User',
    entityId: target._id,
    summary: `${target.name}: ${reason}`,
    metadata: { reason, role: target.role, previousStatus: target.status },
  });
  return User.findOne(scope(ctx, { _id: target._id }))
    .select(USER_PUBLIC_FIELDS)
    .lean();
}

/** Back to the user list as a disabled account; reactivating it is a separate, deliberate step. */
export async function unarchiveUser(ctx: SchoolContext, id: string) {
  const target = await findUserForManagement(ctx, id);
  if (!target.archivedAt) throw conflict('This account is not archived');
  await User.updateOne(scope(ctx, { _id: target._id }), { $unset: { archivedAt: 1, archivedReason: 1 } });
  await audit(ctx, { action: 'user.unarchived', entityType: 'User', entityId: target._id, summary: target.name });
  return User.findOne(scope(ctx, { _id: target._id }))
    .select(USER_PUBLIC_FIELDS)
    .lean();
}

/** Deletion is only for logins that were never used; anything with history is archived. */
export async function checkUserDeletion(ctx: SchoolContext, id: string) {
  const target = await findUserForManagement(ctx, id);
  const blockers: Array<{ kind: string; label: string }> = [];
  if (String(target._id) === ctx.userId) blockers.push({ kind: 'self', label: 'this is your own account' });
  if (target.activatedAt || target.lastLoginAt)
    blockers.push({ kind: 'used', label: 'the account has been used to sign in, so records may refer to it' });
  if (target.role === 'school_owner')
    blockers.push({ kind: 'admin', label: 'Admin accounts are archived, not deleted' });
  return { canDelete: blockers.length === 0, blockers };
}

export async function deleteUser(ctx: SchoolContext, id: string, reason: string) {
  const target = await findUserForManagement(ctx, id);
  const check = await checkUserDeletion(ctx, id);
  if (!check.canDelete)
    throw conflict(
      `This account cannot be deleted (${check.blockers.map((b) => b.label).join('; ')}). Archive it instead.`,
      check.blockers.map((b) => ({ path: b.kind, message: b.label })),
      'IN_USE',
    );
  await User.updateOne(scope(ctx, { _id: target._id }), { $set: { status: 'disabled' }, $inc: { tokenVersion: 1 } });
  await revokeAllForSubject('user', target._id.toString(), 'deleted');
  await AccountToken.deleteMany(scope(ctx, { userId: target._id }));
  // The staff or parent record stays; only its link to this login is removed.
  if (target.employeeId)
    await Employee.updateOne(scope(ctx, { _id: target.employeeId, userId: target._id }), { $unset: { userId: 1 } });
  if (target.parentId)
    await Parent.updateOne(scope(ctx, { _id: target.parentId, userId: target._id }), { $unset: { userId: 1 } });
  await User.deleteOne(scope(ctx, { _id: target._id }));
  await audit(ctx, {
    action: 'user.deleted',
    entityType: 'User',
    entityId: target._id,
    summary: `${target.name} (${target.email ?? target.username ?? ''}): ${reason}`,
    metadata: { reason, role: target.role as SchoolRole },
  });
}
