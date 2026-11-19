import { callHub } from '../calls/calls.hub';
import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import { assertChannelsEnabled, isChannelEnabled, pausedChannels, pausedMessage } from '../../config/features';
import { STAFF_ROLES, type SchoolRole } from '../../config/permissions';
import { getAdapter } from '../../services/messaging/adapters';
import type { SchoolContext, SystemContext } from '../../types/context';
import { conflict, notFound } from '../../utils/errors';
import { assertManyRefs, findOwned, oid, scope } from '../../utils/tenant';
import { SchoolClass, Section } from '../academics/academics.models';
import { visibleStudentIds } from '../academics/access.service';
import { createApprovalRequest } from '../approvals/approvals.service';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { School } from '../schools/school.model';
import { Parent, Student } from '../students/student.models';
import { getSchoolLimits } from '../subscriptions/limits.service';
import { User } from '../users/user.model';
import { pushNotifications } from '../push/push.service';
import { Announcement, MessageLog, Notification, type Channel, type ExternalChannel } from './communications.models';

type Actor = SchoolContext | SystemContext;

// ───────────────────────────── In-app notifications ─────────────────────────────

export async function notifyUsers(
  actor: Actor,
  userIds: Array<string | Types.ObjectId>,
  n: { title: string; body: string; category?: string; link?: string; data?: Record<string, unknown> },
) {
  const unique = [...new Set(userIds.map(String))];
  if (!unique.length) return 0;
  const docs = await Notification.insertMany(
    unique.map((u) => ({
      schoolId: oid(actor.schoolId),
      userId: oid(u),
      title: n.title,
      body: n.body,
      category: n.category ?? 'general',
      link: n.link,
      data: n.data,
    })),
  );
  // Open devices refresh their bell now; the notification itself is read through the API.
  for (const u of unique)
    callHub.toUserDevices(String(actor.schoolId), u, { type: 'notification.new', category: n.category ?? 'general' });
  // Phones where the app is in the background or closed: the same notification by push, to each
  // recipient's own devices in this school only. Never delays or fails the caller.
  void pushNotifications(
    String(actor.schoolId),
    docs.map((d) => ({
      notificationId: String(d._id),
      userId: String(d.userId),
      title: n.title,
      body: n.body,
      category: n.category ?? 'general',
      link: n.link,
    })),
  );
  return unique.length;
}

/** Parent user accounts linked to the given students (for in-app notifications). */
export async function parentUserIdsForStudents(actor: Actor, studentIds: Array<string | Types.ObjectId>) {
  const students = await Student.find(scope(actor, { _id: { $in: studentIds.map((s) => oid(s)) } }))
    .select('guardians')
    .lean();
  const parentIds = students.flatMap((s) => s.guardians.map((g) => g.parentId));
  if (!parentIds.length) return [];
  const users = await User.find(scope(actor, { parentId: { $in: parentIds }, status: 'active' }))
    .select('_id')
    .lean();
  return users.map((u) => u._id.toString());
}

// ───────────────────────────── External messages ─────────────────────────────

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

export async function externalMessagesThisMonth(schoolId: string) {
  return MessageLog.countDocuments({ schoolId: oid(schoolId), status: 'sent', createdAt: { $gte: monthStart() } });
}

export interface DispatchInput {
  channel: ExternalChannel;
  to: string;
  body: string;
  subject?: string;
  recipientName?: string;
  recipientParentId?: string | Types.ObjectId;
  recipientUserId?: string | Types.ObjectId;
  relatedType?: string;
  relatedId?: string;
}

/**
 * Send one external message and log its real outcome. Never records `sent` unless the
 * provider accepted the message; unconfigured channels are logged as `not_configured`.
 */
export async function dispatchMessage(actor: Actor, input: DispatchInput, quota?: { remaining: number }) {
  const adapter = getAdapter(input.channel);
  const base = {
    schoolId: oid(actor.schoolId),
    channel: input.channel,
    to: input.to,
    recipientName: input.recipientName,
    recipientParentId: input.recipientParentId,
    recipientUserId: input.recipientUserId,
    subject: input.subject,
    body: input.body.slice(0, 4000),
    provider: adapter.provider,
    relatedType: input.relatedType,
    relatedId: input.relatedId,
    sentBy: actor.kind === 'school' ? oid(actor.userId) : undefined,
  };
  // Last line of defence: a paused channel never reaches the provider, whatever the caller.
  if (!isChannelEnabled(input.channel)) {
    return MessageLog.create({ ...base, status: 'paused', error: pausedMessage([input.channel]) });
  }
  if (!adapter.isConfigured()) {
    return MessageLog.create({
      ...base,
      status: 'not_configured',
      error: `${input.channel} provider credentials are not configured`,
    });
  }
  if (quota && quota.remaining <= 0) {
    return MessageLog.create({
      ...base,
      status: 'limit_reached',
      error: 'Monthly messaging limit of the subscription plan reached',
    });
  }
  try {
    const result = await adapter.send({ to: input.to, body: input.body, subject: input.subject });
    if (quota) quota.remaining--;
    return MessageLog.create({
      ...base,
      status: 'sent',
      providerMessageId: result.providerMessageId,
      costPkr: adapter.costPerMessagePkr(),
      sentAt: new Date(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provider error';
    logger.warn({ channel: input.channel, err: message }, 'Message send failed');
    return MessageLog.create({ ...base, status: 'failed', error: message.slice(0, 500) });
  }
}

export async function messagingQuota(schoolId: string) {
  const [limits, used] = await Promise.all([getSchoolLimits(schoolId), externalMessagesThisMonth(schoolId)]);
  return { remaining: Math.max(0, limits.messagesPerMonth - used), limit: limits.messagesPerMonth, used };
}

// Background dispatch tracking (no external queue required).
const inFlight = new Set<Promise<unknown>>();
export function runInBackground(task: () => Promise<unknown>) {
  const p = task()
    .catch((err) => logger.error({ err }, 'Background task failed'))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  return p;
}
/** Wait for background deliveries (used by graceful shutdown and tests). */
export async function flushBackground() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

// ───────────────────────────── Audience resolution ─────────────────────────────

export interface Audience {
  roles: SchoolRole[];
  campusIds?: string[];
  classIds?: string[];
  sectionIds?: string[];
}

interface Recipient {
  userId?: string;
  parentId?: string;
  name: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
}

export async function resolveAudience(actor: Actor, audience: Audience): Promise<Recipient[]> {
  const recipients = new Map<string, Recipient>();
  const staffRoles = audience.roles.filter((r) => STAFF_ROLES.has(r));
  if (staffRoles.length) {
    const filter: Record<string, unknown> = scope(actor, { role: { $in: staffRoles }, status: 'active' });
    if (audience.campusIds?.length)
      filter.$or = [{ campusIds: { $size: 0 } }, { campusIds: { $in: audience.campusIds.map(oid) } }];
    const staff = await User.find(filter).select('name email phone').lean();
    for (const u of staff)
      recipients.set(`u:${u._id}`, {
        userId: u._id.toString(),
        name: u.name,
        email: u.email ?? undefined,
        phone: u.phone ?? undefined,
      });
  }
  if (audience.roles.includes('parent')) {
    const sFilter: Record<string, unknown> = scope(actor, { status: 'active' });
    if (audience.campusIds?.length) sFilter.campusId = { $in: audience.campusIds.map(oid) };
    if (audience.classIds?.length) sFilter.classId = { $in: audience.classIds.map(oid) };
    if (audience.sectionIds?.length) sFilter.sectionId = { $in: audience.sectionIds.map(oid) };
    const students = await Student.find(sFilter).select('guardians').lean();
    const parentIds = [...new Set(students.flatMap((s) => s.guardians.map((g) => g.parentId.toString())))];
    const parents = await Parent.find(scope(actor, { _id: { $in: parentIds.map(oid) } }))
      .select('name phone whatsapp email userId')
      .lean();
    for (const p of parents) {
      recipients.set(`p:${p._id}`, {
        parentId: p._id.toString(),
        userId: p.userId?.toString(),
        name: p.name,
        email: p.email ?? undefined,
        phone: p.phone,
        whatsapp: p.whatsapp ?? p.phone,
      });
    }
  }
  return [...recipients.values()];
}

// ───────────────────────────── Announcement visibility ─────────────────────────────

/** `field` is empty (everyone in the role) or contains one of `values`. */
const targets = (field: string, values: Types.ObjectId[]) => ({
  $or: [{ [field]: { $exists: false } }, { [field]: { $size: 0 } }, { [field]: { $in: values } }],
});

/**
 * Which announcements a user may list or open, as a Mongo filter fragment (tenant scope is
 * added by the caller). Mirrors `resolveAudience`, so a user can read exactly what would be
 * delivered to them:
 *
 * - Senders (`communications:send`): every status. Approvers (`approvals:decide`) also see
 *   announcements waiting for approval. Everyone else: published only.
 * - Staff: the audience must include their role, and their campuses when they are restricted.
 * - Parents: the audience must include `parent`, and every class / section / campus target
 *   must match at least one of their active children.
 */
export async function announcementVisibility(ctx: SchoolContext): Promise<Record<string, unknown>> {
  const send = ctx.permissions.has('communications:send');
  if (send) return {};
  const statusFilter = ctx.permissions.has('approvals:decide')
    ? { status: { $in: ['published', 'pending_approval'] } }
    : { status: 'published' };
  const and: Record<string, unknown>[] = [statusFilter, { 'audience.roles': ctx.role }];
  if (ctx.role === 'parent') {
    const ids = ((await visibleStudentIds(ctx)) ?? []).map(oid);
    const kids = ids.length
      ? await Student.find(scope(ctx, { _id: { $in: ids }, status: 'active' }))
          .select('classId sectionId campusId')
          .lean()
      : [];
    if (!kids.length) return { _id: { $in: [] } };
    and.push(
      targets(
        'audience.classIds',
        kids.map((k) => k.classId as Types.ObjectId),
      ),
      targets(
        'audience.sectionIds',
        kids.map((k) => k.sectionId as Types.ObjectId),
      ),
      targets(
        'audience.campusIds',
        kids.map((k) => k.campusId as Types.ObjectId),
      ),
    );
  } else if (STAFF_ROLES.has(ctx.role) && ctx.campusIds.length) {
    and.push(targets('audience.campusIds', ctx.campusIds.map(oid)));
  }
  return { $and: and };
}

// ───────────────────────────── Announcements ─────────────────────────────

export async function createAnnouncement(
  ctx: SchoolContext,
  input: { title: string; body: string; audience: Audience; channels: Channel[]; aiGenerated?: boolean },
) {
  assertChannelsEnabled(input.channels);
  if (input.audience.campusIds?.length) await assertManyRefs(ctx, Campus, input.audience.campusIds, 'campus');
  if (input.audience.classIds?.length) await assertManyRefs(ctx, SchoolClass, input.audience.classIds, 'class');
  if (input.audience.sectionIds?.length) await assertManyRefs(ctx, Section, input.audience.sectionIds, 'section');
  const doc = await Announcement.create({
    ...input,
    schoolId: ctx.schoolId,
    channels: [...new Set<Channel>(['in_app', ...input.channels])],
    status: 'draft',
    createdBy: ctx.userId,
    createdByName: ctx.name,
  });
  await audit(ctx, {
    action: 'announcement.create',
    entityType: 'Announcement',
    entityId: doc._id,
    viaAi: input.aiGenerated,
  });
  return doc.toObject();
}

/**
 * Publish an announcement. In-app delivery is immediate. External delivery (email/SMS/
 * WhatsApp) to a large audience, or of AI-generated text, requires approval first.
 */
export async function requestPublish(ctx: SchoolContext, id: string) {
  const ann = await findOwned(Announcement, ctx, id, 'Announcement');
  if (ann.status !== 'draft' && ann.status !== 'rejected') throw conflict(`Announcement is already ${ann.status}`);
  const recipients = await resolveAudience(ctx, ann.audience as unknown as Audience);
  // Paused channels (SMS/WhatsApp/email coming soon) are skipped, so they never need approval.
  const paused = pausedChannels(ann.channels);
  const external = ann.channels.filter((c) => c !== 'in_app' && !paused.includes(c as never));
  const school = await School.findById(ctx.schoolId).select('settings.approvals').lean();
  const threshold = school?.settings?.approvals?.bulkMessageThreshold ?? 20;
  const needsApproval = external.length > 0 && (recipients.length >= threshold || ann.aiGenerated);

  if (needsApproval) {
    const approval = await createApprovalRequest(ctx, {
      type: 'announcement_publish',
      title: `Send "${ann.title}" to ${recipients.length} recipients via ${external.join(', ')}`,
      entityType: 'Announcement',
      entityId: ann._id,
      source: ann.aiGenerated ? 'ai' : 'user',
      payload: { announcementId: ann._id.toString() },
      data: { recipients: recipients.length, channels: ann.channels, threshold, aiGenerated: ann.aiGenerated },
      analysis: ann.aiGenerated
        ? 'Text was drafted by AI and must be reviewed by a person before external delivery.'
        : `Audience of ${recipients.length} meets the bulk-message threshold of ${threshold}.`,
      recommendation: 'Review the wording and audience, then approve to send.',
    });
    await Announcement.updateOne(scope(ctx, { _id: ann._id }), {
      $set: { status: 'pending_approval', approvalId: approval._id },
    });
    return {
      status: 'pending_approval' as const,
      approvalId: approval._id,
      recipients: recipients.length,
      pausedChannels: paused,
    };
  }
  const result = await publishNow(ctx, ann._id.toString());
  return { status: 'published' as const, recipients: recipients.length, ...result };
}

export async function publishNow(actor: Actor, id: string) {
  const ann = await Announcement.findOneAndUpdate(
    scope(actor, { _id: oid(id), status: { $in: ['draft', 'pending_approval', 'rejected'] } }),
    { $set: { status: 'published', publishedAt: new Date(), 'delivery.status': 'in_progress' } },
    { returnDocument: 'after' },
  ).lean();
  if (!ann) throw notFound('Announcement');
  const recipients = await resolveAudience(actor, ann.audience as unknown as Audience);
  const inApp = await notifyUsers(
    actor,
    recipients.map((r) => r.userId).filter((u): u is string => Boolean(u)),
    { title: ann.title, body: ann.body, category: 'announcement', link: `/announcements/${ann._id}` },
  );
  await Announcement.updateOne(scope(actor, { _id: ann._id }), {
    $set: { 'delivery.recipients': recipients.length, 'delivery.inApp': inApp },
  });
  await audit(actor, {
    action: 'announcement.published',
    entityType: 'Announcement',
    entityId: ann._id,
    metadata: { recipients: recipients.length },
  });

  const paused = pausedChannels(ann.channels);
  const external = ann.channels.filter((c): c is ExternalChannel => c !== 'in_app' && !paused.includes(c as never));
  if (!external.length) {
    await Announcement.updateOne(scope(actor, { _id: ann._id }), { $set: { 'delivery.status': 'completed' } });
    return { inApp, externalQueued: 0, pausedChannels: paused };
  }
  let queued = 0;
  const jobs: DispatchInput[] = [];
  for (const r of recipients) {
    for (const channel of external) {
      const to = channel === 'email' ? r.email : channel === 'sms' ? r.phone : r.whatsapp;
      if (!to) continue;
      jobs.push({
        channel,
        to,
        subject: ann.title,
        body: channel === 'email' ? ann.body : `${ann.title}\n${ann.body}`,
        recipientName: r.name,
        recipientParentId: r.parentId,
        recipientUserId: r.userId,
        relatedType: 'Announcement',
        relatedId: ann._id.toString(),
      });
      queued++;
    }
  }
  runInBackground(async () => {
    const quota = await messagingQuota(actor.schoolId);
    const counts: Record<string, Record<string, number>> = {};
    const CONCURRENCY = 5;
    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      const logs = await Promise.all(jobs.slice(i, i + CONCURRENCY).map((j) => dispatchMessage(actor, j, quota)));
      for (const l of logs) {
        counts[l.channel] ??= {};
        counts[l.channel][l.status] = (counts[l.channel][l.status] ?? 0) + 1;
      }
    }
    await Announcement.updateOne(scope(actor, { _id: ann._id }), {
      $set: { 'delivery.status': 'completed', 'delivery.external': counts },
    });
  });
  return { inApp, externalQueued: queued, pausedChannels: paused };
}

export async function rejectAnnouncement(actor: Actor, id: string) {
  await Announcement.updateOne(scope(actor, { _id: oid(id), status: 'pending_approval' }), {
    $set: { status: 'rejected' },
  });
}
