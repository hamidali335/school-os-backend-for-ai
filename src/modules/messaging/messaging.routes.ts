import type { Api } from '../../utils/api';
import { idParams, objectId, paginationQuery, queryBool, z } from '../../utils/zod';
import * as svc from './messaging.service';

const ConversationSummary = z
  .object({
    _id: objectId(),
    studentId: objectId(),
    studentName: z.string(),
    parentName: z.string(),
    staffName: z.string(),
    withName: z.string(),
    lastMessageAt: z.string(),
    lastMessagePreview: z.string(),
    unread: z.boolean(),
    participant: z.boolean().openapi({ description: 'False when leadership is viewing for oversight' }),
    callTo: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('parent'), parentId: z.string() }),
        z.object({ type: z.literal('staff'), userId: z.string() }),
      ])
      .nullable()
      .openapi({ description: 'Target for POST /calls (with studentId) from this conversation; null for oversight' }),
  })
  .openapi('ConversationSummary');

const ClientMessageId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .optional()
  .openapi({ description: 'Device-made id of this message (8–64 letters, digits, - or _); repeats are ignored' });

const ConversationDetail = ConversationSummary.extend({
  canSend: z.boolean(),
  messages: z.array(
    z.object({
      _id: objectId(),
      body: z.string(),
      senderName: z.string(),
      senderRole: z.string(),
      mine: z.boolean(),
      createdAt: z.string(),
      readByOther: z.boolean(),
      clientMessageId: z.string().optional(),
    }),
  ),
}).openapi('ConversationDetail');

const Body = z.string().trim().min(1).max(2000);

export function registerMessagingRoutes(api: Api) {
  const tags = ['Messages'];
  // Messages are part of the communications feature; parents and teachers both hold this permission.
  const permission = 'communications:read' as const;

  api.route({
    method: 'get',
    path: '/messages/contacts',
    tags,
    auth: 'school',
    permission,
    summary: 'Who you can message: parents of students you teach, or your children’s teachers',
    description:
      'Teachers see students in sections they teach (class teacher, subject teacher or current substitute) with their parents; leadership can search every student. ' +
      'Parents see each of their children with that child’s teachers and the school office (Office Administrator, Principal, Admin with access to the child’s campus). A parent without an active app account (`userId: null`) cannot receive messages yet.',
    query: z.object({ q: z.string().max(100).optional() }),
    response: z.object({
      kind: z.enum(['parents', 'teachers']),
      students: z.array(
        z.object({
          studentId: objectId(),
          name: z.string(),
          admissionNo: z.string(),
          className: z.string().nullable(),
          parents: z.array(
            z.object({ parentId: objectId(), name: z.string(), relation: z.string(), userId: z.string().nullable() }),
          ),
          teachers: z.array(z.object({ userId: z.string(), name: z.string(), roles: z.array(z.string()) })),
          office: z
            .array(z.object({ userId: z.string(), name: z.string(), roles: z.array(z.string()) }))
            .openapi({ description: "Parents only: the school office for this child's campus (empty for staff)" }),
        }),
      ),
    }),
    handler: ({ ctx, query }) => svc.contacts(ctx, query.q),
  });

  api.route({
    method: 'get',
    path: '/messages/conversations',
    tags,
    auth: 'school',
    permission,
    summary: 'Your conversations, newest first (leadership: `all=true` for every conversation in the school)',
    query: paginationQuery.extend({ all: queryBool() }),
    response: ConversationSummary,
    paginated: true,
    handler: ({ ctx, query }) => svc.listConversations(ctx, { all: query.all, page: query.page, limit: query.limit }),
  });

  api.route({
    method: 'get',
    path: '/messages/unread-count',
    tags,
    auth: 'school',
    permission,
    summary: 'Conversations with messages you have not read',
    response: z.object({ unread: z.number() }),
    handler: ({ ctx }) => svc.unreadCount(ctx),
  });

  api.route({
    method: 'post',
    path: '/messages/conversations',
    tags,
    auth: 'school',
    permission,
    summary: 'Start (or continue) a conversation about a student, with a first message',
    description:
      'Staff give `studentId` and optionally `parentId` (default: the primary guardian); parents give `studentId` and `teacherUserId` (one of the child’s teachers or the school office). ' +
      'An existing conversation between the same two people about the same student is reused. The recipient gets an in-app notification.',
    body: z.object({
      studentId: objectId(),
      parentId: objectId().optional(),
      teacherUserId: objectId().optional(),
      body: Body,
      clientMessageId: ClientMessageId,
    }),
    response: ConversationDetail,
    status: 201,
    handler: ({ ctx, body }) => svc.startConversation(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/messages/conversations/:id',
    tags,
    auth: 'school',
    permission,
    summary: 'A conversation with its latest messages (marks it read for a participant)',
    params: idParams,
    response: ConversationDetail,
    handler: ({ ctx, params }) => svc.getConversation(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/messages/conversations/:id/messages',
    tags,
    auth: 'school',
    permission,
    summary: 'Send a message (participants only; a teacher only while they still teach the student)',
    params: idParams,
    description:
      'Give `clientMessageId` (a random id the device makes for this message) so a retry after a lost answer is not saved twice: ' +
      'the same id answers with the conversation, the message once. Both people get a live `message.new` event on open connections.',
    body: z.object({ body: Body, clientMessageId: ClientMessageId }),
    response: ConversationDetail,
    status: 201,
    handler: ({ ctx, params, body }) => svc.sendMessage(ctx, params.id, body.body, body.clientMessageId),
  });

  api.route({
    method: 'post',
    path: '/messages/conversations/:id/read',
    tags,
    auth: 'school',
    permission,
    allowInactiveSubscription: true,
    summary: 'Mark a conversation read',
    params: idParams,
    status: 204,
    handler: ({ ctx, params }) => svc.markConversationRead(ctx, params.id),
  });
}
