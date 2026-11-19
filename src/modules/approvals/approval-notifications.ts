import { logger } from '../../config/logger';
import { ROLE_PERMISSIONS, STAFF_ROLES, type SchoolRole } from '../../config/permissions';
import type { SchoolContext, SystemContext } from '../../types/context';
import { oid, scope } from '../../utils/tenant';
import { notifyUsers } from '../communications/communications.service';
import { StaffRole, User } from '../users/user.model';

type Actor = SchoolContext | SystemContext;

/** Active accounts in this school that may decide approval requests. */
export async function approverUserIds(actor: Actor): Promise<string[]> {
  const builtIn = [...STAFF_ROLES].filter(
    (r) => r !== 'staff' && ROLE_PERMISSIONS[r as SchoolRole]?.has('approvals:decide'),
  );
  const customRoles = await StaffRole.find(scope(actor, { permissions: 'approvals:decide' }))
    .select('_id')
    .lean();
  const users = await User.find(
    scope(actor, {
      status: 'active',
      $or: [{ role: { $in: builtIn } }, { role: 'staff', customRoleId: { $in: customRoles.map((r) => r._id) } }],
    }),
  )
    .select('_id')
    .lean();
  return users.map((u) => u._id.toString());
}

/** Tell the approvers a request is waiting. Never fails the request itself. */
export async function notifyApprovalRequested(
  actor: Actor,
  request: { _id: unknown; title: string; requestedBy?: unknown },
) {
  try {
    const recipients = (await approverUserIds(actor)).filter((id) => id !== String(request.requestedBy ?? ''));
    await notifyUsers(actor, recipients, {
      title: 'Approval needed',
      body: request.title,
      category: 'approval',
      link: `/approvals/${String(request._id)}`,
      data: { approvalId: String(request._id) },
    });
  } catch (err) {
    logger.error({ err }, 'Could not notify approvers');
  }
}

/** Tell the person who asked what was decided. Never fails the decision itself. */
export async function notifyApprovalDecided(
  ctx: SchoolContext,
  request: { _id: unknown; title: string; requestedBy?: unknown; status?: string; decisionNote?: string | null },
) {
  const requester = request.requestedBy ? String(request.requestedBy) : null;
  if (!requester || requester === ctx.userId) return;
  const outcome =
    request.status === 'rejected'
      ? 'rejected'
      : request.status === 'failed'
        ? 'approved, but carrying it out failed'
        : 'approved';
  try {
    await notifyUsers(ctx, [oid(requester)], {
      title: `Request ${request.status === 'rejected' ? 'rejected' : request.status === 'failed' ? 'failed' : 'approved'}`,
      body: `${request.title}: ${outcome} by ${ctx.name}.${request.decisionNote ? ` Note: ${request.decisionNote}` : ''}`,
      category: 'approval',
      link: `/approvals/${String(request._id)}`,
      data: { approvalId: String(request._id) },
    });
  } catch (err) {
    logger.error({ err }, 'Could not notify the requester');
  }
}
