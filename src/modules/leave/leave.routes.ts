import type { Api } from '../../utils/api';
import { docBase, idParams, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { LEAVE_ACTIONS, LEAVE_STATUSES } from './leave.model';
import * as svc from './leave.service';

const LeaveRes = z
  .object({
    ...docBase,
    studentId: z.any().openapi({ description: 'Populated {_id, firstName, lastName, admissionNo}' }),
    campusId: objectId(),
    classId: z.any().openapi({ description: 'Populated {_id, name}' }),
    sectionId: z.any().openapi({ description: 'Populated {_id, name}' }),
    from: z.string(),
    to: z.string(),
    days: z.number(),
    reason: z.string(),
    status: z.enum(LEAVE_STATUSES),
    requestedBy: objectId(),
    requestedByName: z.string(),
    decidedBy: objectId().optional(),
    decidedByName: z.string().optional(),
    decidedAt: z.string().optional(),
    decisionNote: z.string().optional(),
    history: z.array(
      z.object({
        action: z.enum(LEAVE_ACTIONS),
        byUserId: objectId(),
        byName: z.string(),
        byRole: z.string(),
        note: z.string().optional(),
        at: z.string(),
      }),
    ),
  })
  .openapi('LeaveRequest');

const Note = z.string().trim().max(500);

export function registerLeaveRoutes(api: Api) {
  const tags = ['Leave'];

  api.route({
    method: 'post',
    path: '/leave-requests',
    tags,
    auth: 'school',
    permission: 'leave:request',
    roles: ['parent'],
    summary: 'Request leave for one of your children',
    description:
      'Dates are inclusive school-calendar dates (YYYY-MM-DD): at most 30 days, starting no earlier than 7 days ago and at most 120 days ahead. ' +
      'An overlapping pending or approved request for the same child is refused with 409 `LEAVE_OVERLAP`. The class teacher and administrators get an in-app notification.',
    body: z.object({
      studentId: objectId(),
      from: isoDate(),
      to: isoDate(),
      reason: z.string().trim().min(5).max(500),
    }),
    response: LeaveRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createLeave(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/leave-requests',
    tags,
    auth: 'school',
    permission: 'leave:read',
    summary: 'Leave requests you may see',
    description:
      'Parents: their own children. Teachers: students of the sections they are class teacher of. Administrators: every request (within their campuses). Newest first.',
    query: paginationQuery.extend({
      status: z.enum(LEAVE_STATUSES).optional(),
      studentId: objectId().optional(),
      classId: objectId().optional(),
      sectionId: objectId().optional(),
      from: isoDate().optional().openapi({ description: 'Requests ending on or after this date' }),
      to: isoDate().optional().openapi({ description: 'Requests starting on or before this date' }),
    }),
    response: LeaveRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listLeave(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/leave-requests/:id',
    tags,
    auth: 'school',
    permission: 'leave:read',
    summary: 'A leave request with its history (404 if it is not yours to see)',
    params: idParams,
    response: LeaveRes,
    handler: ({ ctx, params }) => svc.getLeave(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/leave-requests/:id/review',
    tags,
    auth: 'school',
    permission: 'leave:read',
    roles: ['teacher'],
    summary: 'Class teacher: add a review note to a pending request (not a decision)',
    params: idParams,
    body: z.object({ note: Note.min(2) }),
    response: LeaveRes,
    handler: ({ ctx, params, body }) => svc.reviewLeave(ctx, params.id, body.note),
  });

  api.route({
    method: 'post',
    path: '/leave-requests/:id/decision',
    tags,
    auth: 'school',
    permission: 'leave:decide',
    summary: 'Approve or reject a pending request (administrators; never your own)',
    description:
      'Only one decision is ever recorded: a second attempt gets 409 `LEAVE_NOT_PENDING`. Attendance is not changed.',
    params: idParams,
    body: z.object({ decision: z.enum(['approve', 'reject']), note: Note.optional() }),
    response: LeaveRes,
    handler: ({ ctx, params, body }) => svc.decideLeave(ctx, params.id, body.decision, body.note),
  });

  api.route({
    method: 'post',
    path: '/leave-requests/:id/cancel',
    tags,
    auth: 'school',
    permission: 'leave:read',
    summary: 'Withdraw a pending request (the parent who asked, or an administrator)',
    params: idParams,
    body: z.object({ note: Note.optional() }),
    response: LeaveRes,
    handler: ({ ctx, params, body }) => svc.cancelLeave(ctx, params.id, body.note),
  });
}
