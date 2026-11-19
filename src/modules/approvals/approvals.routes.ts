import type { Api } from '../../utils/api';
import { docBase, idParams, objectId, paginationQuery, queryBool, z } from '../../utils/zod';
import { APPROVAL_STATUSES, APPROVAL_TYPES } from './approval.model';
import * as svc from './approvals.service';

export const ApprovalRes = z
  .object({
    ...docBase,
    type: z.enum(APPROVAL_TYPES),
    title: z.string(),
    status: z.enum(APPROVAL_STATUSES),
    source: z.enum(['user', 'ai', 'automation']),
    requestedBy: objectId().optional(),
    requestedByName: z.string().optional(),
    data: z.record(z.string(), z.any()).openapi({ description: 'DATA: facts snapshot computed by application code' }),
    analysis: z.string().optional().openapi({ description: 'ANALYSIS' }),
    recommendation: z.string().optional().openapi({ description: 'RECOMMENDATION' }),
    payload: z.record(z.string(), z.any()).openapi({ description: 'Parameters of the ACTION executed on approval' }),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    amount: z.number().optional(),
    decidedByName: z.string().optional(),
    decidedAt: z.string().optional(),
    decisionNote: z.string().optional(),
    executedAt: z.string().optional(),
    result: z.record(z.string(), z.any()).optional().openapi({ description: 'RESULT of the executed action' }),
    error: z.string().optional(),
  })
  .openapi('ApprovalRequest');

export function registerApprovalRoutes(api: Api) {
  const tags = ['Approvals'];

  api.route({
    method: 'get',
    path: '/approvals',
    tags,
    auth: 'school',
    permission: 'approvals:read',
    summary: 'Approval queue',
    query: paginationQuery.extend({
      status: z.enum(APPROVAL_STATUSES).optional(),
      type: z.enum(APPROVAL_TYPES).optional(),
      mine: queryBool(),
    }),
    response: ApprovalRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listApprovals(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/approvals/:id',
    tags,
    auth: 'school',
    permission: 'approvals:read',
    summary: 'Get an approval request with its data, analysis, recommendation and result',
    params: idParams,
    response: ApprovalRes,
    handler: ({ ctx, params }) => svc.getApproval(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/approvals/:id/decision',
    tags,
    auth: 'school',
    permission: 'approvals:decide',
    summary: 'Approve or reject a pending request',
    description:
      'Approving executes the action immediately via application code; the response shows status `executed` (with `result`) or `failed` (with `error`). ' +
      'Requesters cannot approve their own requests (school owners excepted; such decisions are flagged in the audit log).',
    params: idParams,
    body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }),
    response: ApprovalRes,
    handler: ({ ctx, params, body }) => svc.decideApproval(ctx, params.id, body.decision, body.note),
  });

  api.route({
    method: 'post',
    path: '/approvals/:id/cancel',
    tags,
    auth: 'school',
    permission: 'approvals:read',
    summary: 'Cancel a pending request (requester or approver)',
    params: idParams,
    response: ApprovalRes,
    handler: ({ ctx, params }) => svc.cancelApproval(ctx, params.id),
  });
}
