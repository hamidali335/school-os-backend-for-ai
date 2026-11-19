import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import { atomic } from '../../database/transactions';
import type { SchoolContext, SystemContext } from '../../types/context';
import { badRequest, conflict, forbidden } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { findOwned, oid, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { ApprovalRequest, type ApprovalType } from './approval.model';
import { notifyApprovalDecided, notifyApprovalRequested } from './approval-notifications';

type ApprovalDoc = Awaited<ReturnType<typeof findOwned<any>>>;

export interface ApprovalHandler {
  /** Executes the approved action using normal application code. Returns a result summary. */
  execute: (approver: SchoolContext, request: ApprovalDoc) => Promise<Record<string, unknown>>;
  /** Optional cleanup when the request is rejected or cancelled. */
  onReject?: (approver: SchoolContext, request: ApprovalDoc) => Promise<void>;
  /**
   * Run claim + execute + status update in one MongoDB transaction (when available). Only for
   * handlers whose effects are database writes: a transaction may be retried.
   */
  transactional?: boolean;
}

class ClaimLost extends Error {}
function rethrowClaimLost(err: unknown): never | void {
  if (err instanceof ClaimLost) throw conflict('This request was decided by someone else');
}

const handlers = new Map<ApprovalType, ApprovalHandler>();

export function registerApprovalHandler(type: ApprovalType, handler: ApprovalHandler) {
  handlers.set(type, handler);
}

export interface NewApproval {
  type: ApprovalType;
  title: string;
  payload: Record<string, unknown>;
  data?: Record<string, unknown>;
  analysis?: string;
  recommendation?: string;
  entityType?: string;
  entityId?: string | Types.ObjectId;
  amount?: number;
  source?: 'user' | 'ai' | 'automation';
}

export async function createApprovalRequest(actor: SchoolContext | SystemContext, input: NewApproval) {
  if (input.entityType && input.entityId) {
    const open = await ApprovalRequest.exists(
      scope(actor, {
        type: input.type,
        entityType: input.entityType,
        entityId: String(input.entityId),
        status: 'pending',
      }),
    );
    if (open) throw conflict('An approval request for this item is already pending', undefined, 'APPROVAL_PENDING');
  }
  const doc = await ApprovalRequest.create({
    schoolId: actor.schoolId,
    type: input.type,
    title: input.title,
    source: input.source ?? (actor.kind === 'system' ? 'automation' : 'user'),
    requestedBy: actor.kind === 'school' ? actor.userId : undefined,
    requestedByName: actor.kind === 'school' ? actor.name : actor.label,
    data: input.data ?? {},
    analysis: input.analysis,
    recommendation: input.recommendation,
    payload: input.payload,
    entityType: input.entityType,
    entityId: input.entityId?.toString(),
    amount: input.amount,
  });
  await audit(actor, {
    action: 'approval.requested',
    entityType: 'ApprovalRequest',
    entityId: doc._id,
    summary: input.title,
    metadata: { type: input.type, source: doc.source },
    viaAi: input.source === 'ai',
  });
  await notifyApprovalRequested(actor, doc);
  return doc.toObject();
}

export async function listApprovals(
  ctx: SchoolContext,
  q: { page: number; limit: number; status?: string; type?: string; mine?: boolean },
) {
  const filter: Record<string, unknown> = scope(ctx);
  if (q.status) filter.status = q.status;
  if (q.type) filter.type = q.type;
  if (q.mine) filter.requestedBy = oid(ctx.userId);
  return paginate(ApprovalRequest, filter, { page: q.page, limit: q.limit, sort: { createdAt: -1 } });
}

export async function getApproval(ctx: SchoolContext, id: string) {
  return findOwned(ApprovalRequest, ctx, id, 'Approval request');
}

/**
 * Approve or reject. Approval immediately executes the action through the registered
 * handler; the outcome (executed / failed) and result are stored and audited.
 */
/** Decide a request, then tell the requester the outcome (approved, rejected or failed). */
export async function decideApproval(ctx: SchoolContext, id: string, decision: 'approve' | 'reject', note?: string) {
  const result = await decide(ctx, id, decision, note);
  if (result) await notifyApprovalDecided(ctx, result as never);
  return result;
}

async function decide(ctx: SchoolContext, id: string, decision: 'approve' | 'reject', note?: string) {
  if (!ctx.permissions.has('approvals:decide')) throw forbidden();
  const request = await findOwned(ApprovalRequest, ctx, id, 'Approval request');
  if (request.status !== 'pending') throw conflict(`This request is already ${request.status}`);
  const selfApproval = request.requestedBy?.toString() === ctx.userId;
  if (selfApproval && ctx.role !== 'school_owner') {
    throw forbidden('You cannot decide on your own request. Another approver must review it.');
  }
  const handler = handlers.get(request.type as ApprovalType);
  if (!handler) throw badRequest(`No handler registered for approval type ${request.type}`);

  const decided = {
    decidedBy: oid(ctx.userId),
    decidedByName: ctx.name,
    decidedAt: new Date(),
    decisionNote: note,
  };
  // Claim atomically so two approvers cannot both act on the same request.
  const claim = async () => {
    const claimed = await ApprovalRequest.findOneAndUpdate(
      scope(ctx, { _id: request._id, status: 'pending' }),
      { $set: { status: decision === 'approve' ? 'approved' : 'rejected', ...decided } },
      { returnDocument: 'after' },
    ).lean();
    if (!claimed) throw new ClaimLost();
    await audit(ctx, {
      action: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
      entityType: 'ApprovalRequest',
      entityId: request._id,
      summary: request.title,
      metadata: { type: request.type, selfApproval },
    });
    return claimed;
  };
  const execute = async (claimed: unknown) => {
    const result = await handler.execute(ctx, claimed as ApprovalDoc);
    const done = await ApprovalRequest.findOneAndUpdate(
      scope(ctx, { _id: request._id }),
      { $set: { status: 'executed', executedAt: new Date(), result } },
      { returnDocument: 'after' },
    ).lean();
    await audit(ctx, {
      action: 'approval.executed',
      entityType: 'ApprovalRequest',
      entityId: request._id,
      summary: request.title,
      metadata: { type: request.type, result },
    });
    return done;
  };

  if (decision === 'reject') {
    const claimed = await claim().catch(rethrowClaimLost);
    if (handler.onReject)
      await handler.onReject(ctx, claimed as ApprovalDoc).catch((err) => logger.error({ err }, 'onReject failed'));
    return claimed;
  }

  try {
    // Database-only effects (waivers, reversals, ...): claim, effect and "executed" commit
    // together, so a crash can never leave money moved without the request marked executed,
    // or a request marked approved whose effect never happened. Handlers with external side
    // effects (messages) must not be retried, so they keep the claim-then-execute sequence.
    if (handler.transactional) return await atomic(async () => execute(await claim()));
    const claimed = await claim();
    return await execute(claimed);
  } catch (err) {
    rethrowClaimLost(err);
    const message = err instanceof Error ? err.message : 'Execution failed';
    // 'pending' when the transaction rolled the claim back; 'approved' otherwise.
    const failed = await ApprovalRequest.findOneAndUpdate(
      scope(ctx, { _id: request._id, status: { $in: ['pending', 'approved'] } }),
      { $set: { status: 'failed', error: message.slice(0, 500), ...decided } },
      { returnDocument: 'after' },
    ).lean();
    if (!failed) throw conflict('This request was decided by someone else');
    await audit(ctx, {
      action: 'approval.execution_failed',
      entityType: 'ApprovalRequest',
      entityId: request._id,
      outcome: 'failure',
      metadata: { type: request.type, error: message.slice(0, 200) },
    });
    return failed;
  }
}

export async function cancelApproval(ctx: SchoolContext, id: string) {
  const request = await findOwned(ApprovalRequest, ctx, id, 'Approval request');
  if (request.requestedBy?.toString() !== ctx.userId && !ctx.permissions.has('approvals:decide')) throw forbidden();
  if (request.status !== 'pending') throw conflict(`This request is already ${request.status}`);
  const updated = await ApprovalRequest.findOneAndUpdate(
    scope(ctx, { _id: request._id, status: 'pending' }),
    { $set: { status: 'cancelled', decidedBy: oid(ctx.userId), decidedByName: ctx.name, decidedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  const handler = handlers.get(request.type as ApprovalType);
  if (updated && handler?.onReject) await handler.onReject(ctx, updated as ApprovalDoc).catch(() => undefined);
  await audit(ctx, { action: 'approval.cancelled', entityType: 'ApprovalRequest', entityId: request._id });
  return updated;
}

export async function pendingApprovalCount(ctx: Pick<SchoolContext, 'schoolId'>) {
  return ApprovalRequest.countDocuments(scope(ctx, { status: 'pending' }));
}
