import type { Message } from 'firebase-admin/messaging';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { oid, scope } from '../../utils/tenant';
import {
  adminMessaging,
  FcmAdminSender,
  PushConfigError,
  resolvePushConfig,
  type PushConfig,
  type SendStats,
  type TokenOutcome,
} from './fcm-admin';
import { PushDevice } from './push.model';

/**
 * Push to the Android app (docs/PUSH_NOTIFICATIONS.md) through Firebase Cloud Messaging with the
 * Firebase Admin SDK. Two kinds:
 *   - call:         high-priority data message; the app shows its own incoming-call
 *                   notification (Answer / Decline, checked by the server) or removes it;
 *   - notification: normal priority; Android shows it when the app is in the background
 *                   (the same in-app notification the user sees on the Updates screen).
 * Only devices registered by the recipient, in the same school, receive anything. Push is best
 * effort: it never blocks or fails the action that caused it, and "accepted" means FCM took the
 * message, not that the phone showed it.
 */

export interface OutgoingPush {
  kind: 'call' | 'notification';
  /** Data for the app (strings only). Never tokens, ids of other people or secrets. */
  data: Record<string, string>;
  /** Seconds the message is worth delivering (an incoming call is useless after it stops ringing). */
  ttlSeconds: number;
  /** Shown by Android itself while the app is not in front (school notifications only). */
  notification?: { title: string; body: string; channelId: string; tag: string };
}

export interface PushSender {
  readonly configured: boolean;
  send(messages: Message[]): Promise<TokenOutcome[]>;
}

export interface PushSummary {
  devices: number;
  accepted: number;
  invalidRemoved: number;
  failed: number;
}

// ───────────────────────────── Sender set-up ─────────────────────────────

let config: PushConfig = { mode: 'none' };
let configError: string | null = null;
let sender: PushSender = { configured: false, send: async (m) => m.map(() => 'failed' as const) };
let adminSender: FcmAdminSender | null = null;
let lastConfigAlarm = 0;

function onConfigError(code: string) {
  // At most once a minute: the same cause fails every message.
  if (Date.now() - lastConfigAlarm < 60_000) return;
  lastConfigAlarm = Date.now();
  logger.error(
    { code, project: config.mode === 'none' ? null : config.projectId },
    'Push refused by FCM: check the server credentials and that the app uses the same Firebase project (docs/PUSH_NOTIFICATIONS.md)',
  );
}

/**
 * Validates the configuration and builds the sender. Called at start-up (server.ts); throws a
 * PushConfigError with what to fix when the configuration is wrong, so a broken setup is seen
 * at once rather than as silently missing notifications.
 */
export function initPush(e = env) {
  config = resolvePushConfig(e);
  configError = null;
  if (config.mode === 'none') {
    sender = { configured: false, send: async (m) => m.map(() => 'failed' as const) };
    adminSender = null;
    return pushStatus();
  }
  adminSender = new FcmAdminSender(adminMessaging(config), { dryRun: e.FCM_DRY_RUN, onConfigError });
  const s = adminSender;
  sender = { configured: true, send: (m) => s.send(m) };
  return pushStatus();
}

/** Lazily, for scripts and tests that do not run server.ts: a wrong setup only disables push. */
let initialised = false;
function current(): PushSender {
  if (!initialised) {
    initialised = true;
    try {
      initPush();
    } catch (err) {
      configError = err instanceof PushConfigError ? err.message : 'Push configuration could not be read';
      logger.error(configError);
    }
  }
  return sender;
}

/** Tests only: replace the sender (null restores the configured one). */
export function setPushSenderForTests(s: PushSender | null) {
  initialised = true;
  if (s) sender = s;
  else {
    initialised = false;
    current();
  }
}

export const pushConfigured = () => current().configured;

/** Configuration and counters since start-up, without secrets (platform integrations page). */
export function pushStatus() {
  const stats: SendStats | null = adminSender?.stats ?? null;
  return {
    configured: sender.configured,
    credentials: config.mode,
    projectId: config.mode === 'none' ? null : config.projectId,
    dryRun: Boolean(env.FCM_DRY_RUN),
    configError,
    sinceStart: {
      accepted: stats?.accepted ?? 0,
      invalidDevicesRemoved: stats?.invalidTokens ?? 0,
      failed: stats?.failed ?? 0,
      lastSuccessAt: stats?.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: stats?.lastFailureAt?.toISOString() ?? null,
      lastErrorCode: stats?.lastErrorCode ?? null,
    },
  };
}

// ───────────────────────────── Devices ─────────────────────────────

/**
 * Register this device for the signed-in user. A token belongs to one account: when another
 * account signs in on the phone it moves. A new token from the same app installation replaces
 * the old one (FCM rotates tokens; a changed Firebase project issues new ones).
 */
export async function registerDevice(ctx: SchoolContext, token: string, installationId?: string) {
  await PushDevice.deleteMany({
    $or: [
      { token, $or: [{ schoolId: { $ne: oid(ctx.schoolId) } }, { userId: { $ne: oid(ctx.userId) } }] },
      ...(installationId ? [{ installationId, token: { $ne: token } }] : []),
    ],
  }).setOptions({ crossTenant: true });
  await PushDevice.updateOne(
    scope(ctx, { token }),
    {
      $set: {
        userId: oid(ctx.userId),
        platform: 'android',
        lastSeenAt: new Date(),
        ...(installationId ? { installationId } : {}),
      },
    },
    { upsert: true },
  );
  return { pushConfigured: current().configured };
}

export async function unregisterDevice(ctx: SchoolContext, token: string) {
  await PushDevice.deleteMany(scope(ctx, { token, userId: oid(ctx.userId) }));
}

/** A device not seen for this long is not counted as reachable for a call (the app re-registers on each start). */
const CALL_DEVICE_FRESH_MS = 30 * 86_400_000;
/** Notifications still go to devices used in the last 90 days. */
const NOTIFY_DEVICE_FRESH_MS = 90 * 86_400_000;

async function devicesOf(schoolId: string, userIds: string[], freshMs: number) {
  return PushDevice.find({
    schoolId: oid(schoolId),
    userId: { $in: userIds.map((u) => oid(u)) },
    lastSeenAt: { $gte: new Date(Date.now() - freshMs) },
  })
    .select('token userId')
    .lean();
}

// ───────────────────────────── Sending ─────────────────────────────

function toMessage(token: string, p: OutgoingPush): Message {
  return {
    token,
    data: p.data,
    android: {
      priority: p.kind === 'call' ? 'high' : 'normal',
      ttl: Math.max(1, Math.round(p.ttlSeconds)) * 1000,
      ...(p.notification
        ? {
            notification: {
              title: p.notification.title,
              body: p.notification.body,
              channelId: p.notification.channelId,
              // Same tag = the same notification on the phone: a repeat replaces, never doubles.
              tag: p.notification.tag,
              // Content hidden on a secure lock screen until unlocked.
              visibility: 'private' as const,
              defaultSound: true,
            },
          }
        : {}),
    },
  };
}

/** Send to every device of the given users in this school; removes tokens FCM says are invalid. */
async function deliver(schoolId: string, batches: Array<{ userIds: string[]; push: OutgoingPush }>, freshMs: number) {
  const summary: PushSummary = { devices: 0, accepted: 0, invalidRemoved: 0, failed: 0 };
  const s = current();
  if (!s.configured) return summary;
  const users = [...new Set(batches.flatMap((b) => b.userIds))];
  if (!users.length) return summary;
  const devices = await devicesOf(schoolId, users, freshMs);
  const byUser = new Map<string, Array<(typeof devices)[number]>>();
  for (const d of devices) byUser.set(String(d.userId), [...(byUser.get(String(d.userId)) ?? []), d]);
  const items = batches.flatMap((b) =>
    [...new Set(b.userIds)].flatMap((u) => (byUser.get(u) ?? []).map((d) => ({ device: d, push: b.push }))),
  );
  summary.devices = items.length;
  if (!items.length) return summary;
  const outcomes = await s.send(items.map((i) => toMessage(i.device.token, i.push)));
  const invalid = items.filter((_, i) => outcomes[i] === 'invalid_token').map((i) => i.device._id);
  if (invalid.length) await PushDevice.deleteMany({ _id: { $in: invalid }, schoolId: oid(schoolId) });
  summary.invalidRemoved = invalid.length;
  summary.accepted = outcomes.filter((o) => o === 'accepted').length;
  summary.failed = outcomes.filter((o) => o === 'failed').length;
  if (summary.failed)
    logger.warn(
      { kind: batches[0]?.push.kind, failed: summary.failed, devices: summary.devices },
      'Some push messages were not accepted by FCM',
    );
  return summary;
}

/** Best effort: never throws, never logs tokens or payloads. */
export async function pushToUsers(schoolId: string, userIds: string[], push: OutgoingPush): Promise<PushSummary> {
  try {
    return await deliver(
      schoolId,
      [{ userIds, push }],
      push.kind === 'call' ? CALL_DEVICE_FRESH_MS : NOTIFY_DEVICE_FRESH_MS,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, kind: push.kind }, 'Push not sent');
    return { devices: 0, accepted: 0, invalidRemoved: 0, failed: 0 };
  }
}

/** Of `userIds`, those with a recently used push device (none when push is not configured). */
export async function pushReachableUsers(schoolId: string, userIds: string[]): Promise<Set<string>> {
  if (!current().configured || !userIds.length) return new Set();
  const rows = await devicesOf(schoolId, userIds, CALL_DEVICE_FRESH_MS);
  return new Set(rows.map((r) => String(r.userId)));
}

// ───────────────────────────── School notifications ─────────────────────────────

export interface NotificationPushItem {
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  category: string;
  link?: string;
}

/** Missed calls get their own Android channel (the user can mute school updates and keep these). */
export const channelFor = (category: string) => (category === 'call' ? 'missed_calls' : 'school_updates');

const MINIMAL_TITLES: Record<string, string> = {
  call: 'Missed call',
  message: 'New message',
  fees: 'Fees update',
  attendance: 'Attendance update',
  homework: 'Homework update',
  results: 'Results update',
  leave: 'Leave request update',
  announcement: 'New announcement',
};

/** Recently pushed notification ids: the same notification is never pushed twice by this process. */
const recent = new Set<string>();
function firstTime(id: string) {
  if (recent.has(id)) return false;
  recent.add(id);
  if (recent.size > 20_000) recent.delete(recent.values().next().value as string);
  return true;
}

/**
 * Push for in-app notifications (called by notifyUsers for every feature). Each recipient gets
 * their own notification on their own devices only. With PUSH_NOTIFICATION_CONTENT=minimal the
 * push says only what kind of update it is; the details stay in the app.
 */
export async function pushNotifications(schoolId: string, items: NotificationPushItem[]): Promise<PushSummary> {
  const fresh = items.filter((n) => firstTime(n.notificationId));
  if (!fresh.length || !current().configured) return { devices: 0, accepted: 0, invalidRemoved: 0, failed: 0 };
  const minimal = env.PUSH_NOTIFICATION_CONTENT === 'minimal';
  try {
    return await deliver(
      schoolId,
      fresh.map((n) => ({
        userIds: [n.userId],
        push: {
          kind: 'notification' as const,
          data: {
            type: 'notification',
            notificationId: n.notificationId,
            category: n.category,
            ...(n.link ? { link: n.link } : {}),
          },
          ttlSeconds: 7 * 86_400,
          notification: {
            title: minimal ? (MINIMAL_TITLES[n.category] ?? 'New update') : n.title.slice(0, 120),
            body: minimal ? 'Open School OS to see it.' : n.body.slice(0, 400),
            channelId: channelFor(n.category),
            tag: n.notificationId,
          },
        },
      })),
      NOTIFY_DEVICE_FRESH_MS,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Notification push not sent');
    return { devices: 0, accepted: 0, invalidRemoved: 0, failed: 0 };
  }
}
