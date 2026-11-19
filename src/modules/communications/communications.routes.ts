import { SCHOOL_ROLES, STAFF_ROLES } from '../../config/permissions';
import { assertChannelsEnabled, channelAvailability, isChannelEnabled } from '../../config/features';
import { channelStatus } from '../../services/messaging/adapters';
import type { Api } from '../../utils/api';
import { addDays, localDayRange, parseDateOnly } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { findOwned, oid, scope } from '../../utils/tenant';
import { docBase, email, idParams, isoDate, objectId, paginationQuery, phonePk, queryBool, z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { Parent } from '../students/student.models';
import {
  Announcement,
  CHANNELS,
  EXTERNAL_CHANNELS,
  MESSAGE_STATUSES,
  MessageLog,
  Notification,
} from './communications.models';
import * as svc from './communications.service';

const AudienceSchema = z
  .object({
    roles: z.array(z.enum(SCHOOL_ROLES)).min(1),
    campusIds: z.array(objectId()).max(20).optional(),
    classIds: z.array(objectId()).max(50).optional(),
    sectionIds: z.array(objectId()).max(100).optional(),
  })
  .openapi('Audience');

const AnnouncementRes = z
  .object({
    ...docBase,
    title: z.string(),
    body: z.string(),
    audience: z.any(),
    channels: z.array(z.enum(CHANNELS)),
    status: z.enum(['draft', 'pending_approval', 'published', 'rejected']),
    aiGenerated: z.boolean(),
    approvalId: objectId().optional(),
    publishedAt: z.string().optional(),
    createdByName: z.string().optional(),
    delivery: z.object({
      status: z.enum(['none', 'in_progress', 'completed']),
      recipients: z.number(),
      inApp: z.number(),
      external: z
        .record(z.string(), z.record(z.string(), z.number()))
        .openapi({ description: 'Per channel → per status counts' }),
    }),
  })
  .openapi('Announcement');

const NotificationRes = z
  .object({
    ...docBase,
    title: z.string(),
    body: z.string(),
    category: z.string(),
    link: z.string().optional(),
    readAt: z.string().optional(),
  })
  .openapi('Notification');

const MessageLogRes = z
  .object({
    ...docBase,
    channel: z.enum(EXTERNAL_CHANNELS),
    to: z.string(),
    recipientName: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    status: z.enum(MESSAGE_STATUSES).openapi({
      description:
        '`sent` = accepted by the provider. `not_configured` = provider credentials missing; `paused` = channel temporarily switched off (coming soon). In both cases nothing was sent.',
    }),
    provider: z.string().optional(),
    providerMessageId: z.string().optional(),
    error: z.string().optional(),
    costPkr: z.number(),
    relatedType: z.string().optional(),
    relatedId: z.string().optional(),
    sentAt: z.string().optional(),
  })
  .openapi('MessageLog');

export function registerCommunicationRoutes(api: Api) {
  const tags = ['Communications'];

  api.route({
    method: 'get',
    path: '/communications/announcements',
    tags,
    auth: 'school',
    permission: 'communications:read',
    summary: 'List announcements',
    description:
      'Senders (`communications:send`) see every status. Everyone else sees published announcements whose audience includes them: ' +
      'their role, and for parents the class, section and campus of one of their children (approvers also see those awaiting approval).',
    query: paginationQuery.extend({
      status: z.enum(['draft', 'pending_approval', 'published', 'rejected']).optional(),
    }),
    response: AnnouncementRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      // The status filter narrows what the caller may see; it never widens it.
      const filter: Record<string, unknown> = scope(ctx, await svc.announcementVisibility(ctx));
      if (query.status) filter.$and = [...((filter.$and as unknown[]) ?? []), { status: query.status }];
      return paginate(Announcement, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
    },
  });

  api.route({
    method: 'get',
    path: '/communications/announcements/:id',
    tags,
    auth: 'school',
    permission: 'communications:read',
    summary: 'Get an announcement',
    params: idParams,
    response: AnnouncementRes,
    handler: async ({ ctx, params }) => {
      // 404 (not 403) when it exists but is not for this user, so ids reveal nothing.
      const ann = await Announcement.findOne(
        scope(ctx, { _id: oid(params.id), ...(await svc.announcementVisibility(ctx)) }),
      ).lean();
      if (!ann) throw notFound('Announcement');
      return ann;
    },
  });

  api.route({
    method: 'post',
    path: '/communications/announcements',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Create a draft announcement',
    description: '`in_app` is always included. Nothing is sent until the announcement is published.',
    body: z.object({
      title: z.string().trim().min(3).max(150),
      body: z.string().trim().min(3).max(5000),
      audience: AudienceSchema,
      channels: z.array(z.enum(CHANNELS)).max(4).default(['in_app']),
    }),
    response: AnnouncementRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createAnnouncement(ctx, body),
  });

  api.route({
    method: 'patch',
    path: '/communications/announcements/:id',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Edit a draft announcement',
    params: idParams,
    body: z.object({
      title: z.string().trim().min(3).max(150).optional(),
      body: z.string().trim().min(3).max(5000).optional(),
      audience: AudienceSchema.optional(),
      channels: z.array(z.enum(CHANNELS)).max(4).optional(),
    }),
    response: AnnouncementRes,
    handler: async ({ ctx, params, body }) => {
      const ann = await findOwned(Announcement, ctx, params.id, 'Announcement');
      if (!['draft', 'rejected'].includes(ann.status)) throw conflict('Only drafts can be edited');
      const set: Record<string, unknown> = { ...body, status: 'draft' };
      if (body.channels) {
        // Only newly added channels must be available; channels the draft already had are kept.
        assertChannelsEnabled(body.channels.filter((c) => !(ann.channels as string[]).includes(c)));
        set.channels = [...new Set(['in_app', ...body.channels])];
      }
      const doc = await Announcement.findOneAndUpdate(
        scope(ctx, { _id: ann._id }),
        { $set: set },
        { returnDocument: 'after' },
      ).lean();
      await audit(ctx, { action: 'announcement.update', entityType: 'Announcement', entityId: ann._id });
      return doc;
    },
  });

  api.route({
    method: 'delete',
    path: '/communications/announcements/:id',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Delete a draft announcement',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const ann = await findOwned(Announcement, ctx, params.id, 'Announcement');
      if (ann.status === 'published' || ann.status === 'pending_approval')
        throw conflict(`Cannot delete a ${ann.status} announcement`);
      await Announcement.deleteOne(scope(ctx, { _id: ann._id }));
      await audit(ctx, { action: 'announcement.delete', entityType: 'Announcement', entityId: ann._id });
    },
  });

  api.route({
    method: 'post',
    path: '/communications/announcements/:id/publish',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Publish an announcement',
    description:
      'In-app notifications are created immediately. External channels to an audience at/above `bulkMessageThreshold`, or AI-drafted text, ' +
      'return `pending_approval` and are only sent after approval. External delivery runs in the background; poll the announcement `delivery` field ' +
      'or the message log for real per-message statuses. Channels that are paused (coming soon) are skipped and listed in `pausedChannels`; ' +
      'the in-app announcement is still published.',
    params: idParams,
    response: z.object({
      status: z.enum(['published', 'pending_approval']),
      recipients: z.number(),
      approvalId: objectId().optional(),
      inApp: z.number().optional(),
      externalQueued: z.number().optional(),
      pausedChannels: z
        .array(z.enum(EXTERNAL_CHANNELS))
        .optional()
        .openapi({ description: 'Channels that were NOT sent because they are temporarily paused (coming soon).' }),
    }),
    handler: ({ ctx, params }) => svc.requestPublish(ctx, params.id),
  });

  // ───────── In-app notifications (own) ─────────
  api.route({
    method: 'get',
    path: '/notifications',
    tags,
    auth: 'school',
    summary: "The signed-in user's notifications",
    query: paginationQuery.extend({ unread: queryBool() }),
    response: NotificationRes,
    paginated: true,
    handler: ({ ctx, query }) =>
      paginate(Notification, scope(ctx, { userId: oid(ctx.userId), ...(query.unread ? { readAt: null } : {}) }), {
        page: query.page,
        limit: query.limit,
        sort: { createdAt: -1 },
      }),
  });

  api.route({
    method: 'get',
    path: '/notifications/unread-count',
    tags,
    auth: 'school',
    summary: 'Unread notification count',
    response: z.object({ unread: z.number() }),
    handler: async ({ ctx }) => ({
      unread: await Notification.countDocuments(scope(ctx, { userId: oid(ctx.userId), readAt: null })),
    }),
  });

  api.route({
    method: 'post',
    path: '/notifications/:id/read',
    tags,
    auth: 'school',
    allowInactiveSubscription: true,
    summary: 'Mark a notification as read',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const res = await Notification.updateOne(scope(ctx, { _id: oid(params.id), userId: oid(ctx.userId) }), {
        $set: { readAt: new Date() },
      });
      if (!res.matchedCount) throw notFound('Notification');
    },
  });

  api.route({
    method: 'post',
    path: '/notifications/read-all',
    tags,
    auth: 'school',
    allowInactiveSubscription: true,
    summary: 'Mark all notifications as read',
    response: z.object({ updated: z.number() }),
    handler: async ({ ctx }) => {
      const res = await Notification.updateMany(scope(ctx, { userId: oid(ctx.userId), readAt: null }), {
        $set: { readAt: new Date() },
      });
      return { updated: res.modifiedCount };
    },
  });

  // ───────── External messaging ─────────
  api.route({
    method: 'get',
    path: '/communications/channels',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Which external channels are configured, and the plan’s monthly quota',
    response: z.object({
      channels: z.array(
        z.object({
          channel: z.string(),
          provider: z.string(),
          configured: z.boolean(),
          costPerMessagePkr: z.number(),
          enabled: z
            .boolean()
            .openapi({ description: 'False while the channel is paused (coming soon); nothing can be sent.' }),
          status: z.enum(['available', 'coming_soon']),
        }),
      ),
      quota: z.object({ limit: z.number(), used: z.number(), remaining: z.number() }),
    }),
    handler: async ({ ctx }) => ({
      channels: channelStatus().map((c) => ({
        ...c,
        enabled: isChannelEnabled(c.channel),
        status: isChannelEnabled(c.channel) ? ('available' as const) : ('coming_soon' as const),
      })),
      quota: await svc.messagingQuota(ctx.schoolId),
    }),
  });

  api.route({
    method: 'get',
    path: '/communications/availability',
    tags,
    auth: 'school',
    summary: 'Which outbound channels (SMS, WhatsApp, email) are available or coming soon',
    description:
      'Available to every signed-in user so any screen can show "Coming soon" labels. In-app notifications are always available.',
    response: z.array(
      z.object({
        channel: z.enum(EXTERNAL_CHANNELS),
        label: z.string(),
        enabled: z.boolean(),
        status: z.enum(['available', 'coming_soon']),
      }),
    ),
    handler: () => channelAvailability(),
  });

  api.route({
    method: 'post',
    path: '/communications/messages',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Send a single message to a parent or a number/email',
    description:
      'Returns the message log entry with the real outcome (`sent`, `failed`, `not_configured`, `limit_reached`). ' +
      'A paused channel (coming soon) is rejected with 503 `CHANNEL_PAUSED`; nothing is sent or logged.',
    body: z
      .object({
        channel: z.enum(EXTERNAL_CHANNELS),
        parentId: objectId().optional(),
        to: z.string().trim().max(254).optional(),
        subject: z.string().trim().max(150).optional(),
        body: z.string().trim().min(1).max(2000),
      })
      .refine((v) => v.parentId || v.to, { message: 'Provide parentId or to' }),
    response: MessageLogRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      assertChannelsEnabled([body.channel]);
      let to = body.to;
      let recipientName: string | undefined;
      if (body.parentId) {
        const p = await findOwned(Parent, ctx, body.parentId, 'Parent');
        to =
          body.channel === 'email'
            ? (p.email ?? undefined)
            : body.channel === 'whatsapp'
              ? (p.whatsapp ?? p.phone)
              : p.phone;
        recipientName = p.name;
        if (!to) throw badRequest(`Parent has no ${body.channel === 'email' ? 'email address' : 'phone number'}`);
      } else if (body.channel === 'email') {
        if (!email().safeParse(to).success) throw badRequest('Invalid email address');
      } else if (!phonePk().safeParse(to).success) throw badRequest('Invalid phone number');
      const quota = await svc.messagingQuota(ctx.schoolId);
      const log = await svc.dispatchMessage(
        ctx,
        {
          channel: body.channel,
          to: to!,
          subject: body.subject,
          body: body.body,
          recipientName,
          recipientParentId: body.parentId,
          relatedType: 'Direct',
        },
        quota,
      );
      await audit(ctx, {
        action: 'message.send',
        entityType: 'MessageLog',
        entityId: log._id,
        metadata: { channel: body.channel, status: log.status },
      });
      return log.toObject();
    },
  });

  api.route({
    method: 'get',
    path: '/communications/messages',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Message history (delivery log)',
    query: paginationQuery.extend({
      channel: z.enum(EXTERNAL_CHANNELS).optional(),
      status: z.enum(MESSAGE_STATUSES).optional(),
      relatedType: z.string().max(40).optional(),
      relatedId: z.string().max(40).optional(),
    }),
    response: MessageLogRes,
    paginated: true,
    handler: ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      for (const k of ['channel', 'status', 'relatedType', 'relatedId'] as const) if (query[k]) filter[k] = query[k];
      return paginate(MessageLog, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
    },
  });

  api.route({
    method: 'get',
    path: '/communications/costs',
    tags,
    auth: 'school',
    permission: 'communications:send',
    summary: 'Messaging costs by channel (tracked separately from AI costs)',
    query: z.object({ from: isoDate(), to: isoDate() }),
    response: z.object({
      from: z.string(),
      to: z.string(),
      totalPkr: z.number(),
      byChannel: z.array(
        z.object({
          channel: z.string(),
          sent: z.number(),
          failed: z.number(),
          notConfigured: z.number(),
          costPkr: z.number(),
        }),
      ),
    }),
    handler: async ({ ctx, query }) => {
      const { start, end } = localDayRange(query.from, query.to, await schoolTimezone(ctx.schoolId));
      const rows = await MessageLog.aggregate([
        { $match: scope(ctx, { createdAt: { $gte: start, $lt: end } }) },
        {
          $group: {
            _id: '$channel',
            sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            notConfigured: { $sum: { $cond: [{ $eq: ['$status', 'not_configured'] }, 1, 0] } },
            costPkr: { $sum: '$costPkr' },
          },
        },
      ]);
      const byChannel = rows.map((r) => ({
        channel: r._id,
        sent: r.sent,
        failed: r.failed,
        notConfigured: r.notConfigured,
        costPkr: r.costPkr,
      }));
      return { from: query.from, to: query.to, totalPkr: byChannel.reduce((s, r) => s + r.costPkr, 0), byChannel };
    },
  });
}
