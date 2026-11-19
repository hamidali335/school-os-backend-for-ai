import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ROLE_LABELS, type SchoolRole } from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { AppError, conflict, forbidden, notFound, tooMany, unavailable } from '../../utils/errors';
import { oid, scope, type LeanDoc } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { notifyUsers } from '../communications/communications.service';
import { Conversation } from '../messaging/messaging.models';
import { assertMessagingRole, isLeader } from '../messaging/messaging.service';
import { School } from '../schools/school.model';
import { pushReachableUsers, pushToUsers } from '../push/push.service';
import { callHub, callStarts, callTimers, type SignalingConnection } from './calls.hub';
import { iceServersFor } from './calls.ice';
import { CallSession, LIVE_CALL_STATUSES, type CallStatus } from './calls.model';
import { resolveCall, stillAuthorized, type CallTarget } from './calls.policy';

/**
 * Call lifecycle (docs/VOICE_CALLS.md). Every change of state is one conditional update on the
 * call's own document (`status` in the filter), so two answers, an answer racing a cancel or a
 * timeout racing a hang-up record exactly one outcome. Nothing here is global: each call has
 * its own document, timers and two bound connections, and one call ending never touches another.
 */

type CallDoc = LeanDoc<typeof CallSession>;

/**
 * In-process lifecycle events, the seam for later stages (e.g. recipient outcome reporting):
 * subscribe here instead of changing the lifecycle. `finished` carries metadata only (no
 * audio, no content). Listeners must not throw or block.
 */
export const callEvents = new EventEmitter();
export type CallFinishedEvent = {
  schoolId: string;
  callId: string;
  kind: string;
  status: string;
  reason: string;
  durationSec: number;
};

const LIVE = [...LIVE_CALL_STATUSES] as CallStatus[];
const ANSWERED: CallStatus[] = ['connecting', 'active'];
/** Answered calls must reach "active" (audio flowing) within this time. */
export const CONNECT_TIMEOUT_MS = 45_000;
export const FAIL_REASONS = ['media_failed', 'ice_failed', 'permission_denied', 'network', 'app_closed'] as const;

const roleLabel = (role: string) => ROLE_LABELS[role as SchoolRole] ?? 'Staff';
const newCallId = () => crypto.randomBytes(24).toString('base64url');
const same = (a: unknown, b: unknown) => a != null && b != null && String(a) === String(b);

function assertCallsEnabled() {
  if (!env.CALLS_ENABLED) throw unavailable('Calls are turned off on this server.', 'CALLS_DISABLED');
}

/** What one user sees of a call. No ids of other people, no connection ids. */
export function viewFor(c: CallDoc, viewerId: string) {
  const outgoing = same(c.callerUserId, viewerId);
  const declinedByMe = !outgoing && (c.declinedUserIds ?? []).some((u) => same(u, viewerId));
  let outcome: string = c.status;
  if (!outgoing) {
    if (c.answeredByUserId && !same(c.answeredByUserId, viewerId)) outcome = 'answered_elsewhere';
    else if (declinedByMe) outcome = 'declined';
    else if (['missed', 'cancelled', 'unreachable', 'busy'].includes(c.status)) outcome = 'missed';
  }
  return {
    callId: c.callId,
    kind: c.kind as 'direct' | 'office' | 'ai',
    /** An AI voice conversation: the recipient is told they are speaking with an AI assistant. */
    ai: c.kind === 'ai',
    direction: outgoing ? ('outgoing' as const) : ('incoming' as const),
    status: c.status as CallStatus,
    outcome,
    studentId: String(c.studentId),
    studentName: c.studentName,
    peerName: outgoing ? c.calleeName : c.callerName,
    peerRole: outgoing ? c.calleeRole : c.kind === 'ai' ? 'AI assistant for the school' : roleLabel(c.callerRole),
    startedAt: (c as { createdAt: Date }).createdAt.toISOString(),
    ringExpiresAt: c.ringExpiresAt.toISOString(),
    answeredAt: c.answeredAt?.toISOString() ?? null,
    connectedAt: c.connectedAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    durationSec: c.durationSec ?? 0,
    endReason: c.endReason ?? null,
  };
}
export type CallView = ReturnType<typeof viewFor>;

/** Everyone who should hear about a change: the caller and every account that was rung. */
function audience(c: CallDoc): string[] {
  return [...new Set([String(c.callerUserId), ...(c.ringUserIds ?? []).map(String)])];
}

/**
 * Tell each device of each person about the new state. `onThisDevice` tells a device whether
 * the call's audio is bound to it (a parent's second phone stops ringing but shows no call).
 */
function broadcast(c: CallDoc) {
  const schoolId = String(c.schoolId);
  for (const u of audience(c)) {
    const call = viewFor(c, u);
    for (const conn of callHub.connsOf(schoolId, u)) {
      conn.send({
        type: 'call.updated',
        call,
        onThisDevice: conn.id === c.callerConnId || conn.id === c.calleeConnId,
      });
    }
  }
}

/**
 * Users among `userIds` already taken by another live call: placing a call, in a call, or being
 * rung (and not having declined). With `before`, only calls created earlier than that one count:
 * of two simultaneous attempts the earlier keeps the recipient, deterministically.
 */
async function engagedUsers(schoolId: string, userIds: Types.ObjectId[], before?: Types.ObjectId) {
  const rows = await CallSession.find({
    schoolId: oid(schoolId),
    ...(before ? { _id: { $lt: before } } : {}),
    $or: [
      // Staff running AI calls are not busy for ordinary calls (the AI agent is the participant).
      { status: { $in: LIVE }, callerUserId: { $in: userIds }, kind: { $ne: 'ai' } },
      { status: { $in: ANSWERED }, answeredByUserId: { $in: userIds } },
      { status: 'ringing', ringUserIds: { $in: userIds } },
    ],
  })
    .select('status callerUserId answeredByUserId ringUserIds declinedUserIds')
    .lean();
  const wanted = new Set(userIds.map(String));
  const taken = new Map<string, 'participant' | 'ringing'>();
  for (const r of rows) {
    if (wanted.has(String(r.callerUserId))) taken.set(String(r.callerUserId), 'participant');
    if (r.answeredByUserId && ANSWERED.includes(r.status as CallStatus) && wanted.has(String(r.answeredByUserId)))
      taken.set(String(r.answeredByUserId), 'participant');
    if (r.status === 'ringing') {
      const declined = new Set((r.declinedUserIds ?? []).map(String));
      for (const u of r.ringUserIds ?? [])
        if (wanted.has(String(u)) && !declined.has(String(u)) && !taken.has(String(u))) taken.set(String(u), 'ringing');
    }
  }
  return taken;
}

const UNANSWERED = new Set(['missed', 'cancelled', 'unreachable', 'busy']);

/** In-app "missed call" notice for recipients who did not answer or decline. */
async function notifyMissed(c: CallDoc) {
  if (!UNANSWERED.has(c.status) || c.answeredByUserId) return;
  const declined = new Set((c.declinedUserIds ?? []).map(String));
  const to = (c.ringUserIds ?? []).map(String).filter((u) => !declined.has(u));
  if (!to.length) return;
  await notifyUsers({ kind: 'system', schoolId: String(c.schoolId), label: 'calls' }, to, {
    title: `Missed call from ${c.callerName}`,
    body: `About ${c.studentName}`,
    category: 'call',
    link: '/calls',
    data: { callId: c.callId },
  }).catch((err) => logger.error({ err }, 'Could not record a missed-call notification'));
}

/**
 * Move a call from one of `from` to a final status, once. Returns the final document, or null
 * when the call was not in one of those states (someone else already finished it).
 */
/** How long a device that acknowledges rings has to do so before it counts as frozen. */
export const RING_ACK_MS = 6000;
const awaitingAck = new Map<string, NodeJS.Timeout>();
const ackKey = (callId: string, connId: string) => `${callId}:${connId}`;

/**
 * After a ring went out: each connection that promised acknowledgements must confirm within
 * RING_ACK_MS. One that does not is a frozen app (Android suspends background apps but keeps their
 * socket open, so the server would think they are online). It is closed; if then nobody can be
 * reached (no live device, no push), the call ends as unreachable at once, so the caller's screen
 * never shows "Ringing" for a phone that cannot ring.
 */
function expectAcks(schoolId: string, callId: string, userIds: string[], byPush: Set<string>) {
  for (const u of userIds) {
    for (const conn of callHub.connsOf(schoolId, u)) {
      if (!conn.acks || conn.virtual) continue;
      const key = ackKey(callId, conn.id);
      const timer = setTimeout(() => {
        awaitingAck.delete(key);
        conn.close(4408, 'Did not acknowledge the incoming call');
        callHub.remove(conn.id);
        const reachable = userIds.some((x) => callHub.isOnline(schoolId, x) || byPush.has(x));
        if (!reachable)
          void finalize(schoolId, callId, ['ringing'], 'unreachable', 'unreachable').catch((err) =>
            logger.error({ err }, 'Could not end a call nobody could receive'),
          );
      }, RING_ACK_MS);
      timer.unref();
      awaitingAck.set(key, timer);
    }
  }
}

/** A device confirmed it received the ring. */
export function acknowledgeIncoming(conn: SignalingConnection, callId: string) {
  const key = ackKey(callId, conn.id);
  const timer = awaitingAck.get(key);
  if (timer) {
    clearTimeout(timer);
    awaitingAck.delete(key);
  }
}

export async function finalize(
  schoolId: string,
  callId: string,
  from: CallStatus[],
  status: CallStatus,
  reason: string,
  byUserId?: string,
): Promise<CallDoc | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await CallSession.findOne({ schoolId: oid(schoolId), callId, status: { $in: from } }).lean();
    if (!cur) return null;
    const now = new Date();
    const durationSec = cur.connectedAt
      ? Math.max(0, Math.round((now.getTime() - cur.connectedAt.getTime()) / 1000))
      : 0;
    const done = await CallSession.findOneAndUpdate(
      { schoolId: oid(schoolId), _id: cur._id, status: cur.status },
      {
        $set: {
          status,
          endReason: reason,
          endedAt: now,
          durationSec,
          ...(byUserId ? { endedByUserId: oid(byUserId) } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!done) continue; // Changed state in between: read it again.
    callTimers.clear(callId);
    broadcast(done);
    if (cur.status === 'ringing') pushEnded(done);
    await notifyMissed(done);
    const event: CallFinishedEvent = { schoolId, callId, kind: done.kind, status, reason, durationSec };
    callEvents.emit('finished', event);
    return done;
  }
  return null;
}

/** The incoming-call push: only what the recipient may see (caller, role, student, school). */
function pushIncoming(schoolId: string, c: CallDoc, schoolName: string) {
  for (const u of c.ringUserIds ?? []) {
    const v = viewFor(c, String(u));
    void pushToUsers(schoolId, [String(u)], {
      kind: 'call',
      data: {
        type: 'call.incoming',
        callId: c.callId,
        caller: v.peerName,
        detail: [v.peerRole, `About ${v.studentName}`, schoolName].filter(Boolean).join(' · '),
        expiresAt: String(c.ringExpiresAt.getTime()),
        ai: c.kind === 'ai' ? '1' : '0',
      },
      ttlSeconds: Math.max(1, (c.ringExpiresAt.getTime() - Date.now()) / 1000),
    });
  }
}

function pushEnded(c: CallDoc) {
  void pushToUsers(String(c.schoolId), (c.ringUserIds ?? []).map(String), {
    kind: 'call',
    data: { type: 'call.ended', callId: c.callId },
    ttlSeconds: 60,
  });
}

function notRinging(c: CallDoc | null, viewerId: string) {
  return new AppError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.', {
    outcome: c ? viewFor(c, viewerId).outcome : 'ended',
  });
}

function boundConnection(ctx: SchoolContext, connectionId: string): SignalingConnection {
  const conn = callHub.owned(connectionId, ctx.schoolId, ctx.userId);
  if (!conn)
    throw conflict(
      'This device is not connected to calling. Check your internet connection and try again.',
      undefined,
      'SIGNALING_NOT_CONNECTED',
    );
  return conn;
}

function withIce(ctx: SchoolContext, c: CallDoc) {
  return { call: viewFor(c, ctx.userId), ...iceServersFor(ctx) };
}

export async function startCall(
  ctx: SchoolContext,
  input: { studentId: string; to: CallTarget; connectionId: string },
) {
  assertCallsEnabled();
  assertMessagingRole(ctx);
  const conn = boundConnection(ctx, input.connectionId);
  if (!callStarts.take(ctx.schoolId, ctx.userId, env.CALL_START_PER_MINUTE))
    throw tooMany('You have started too many calls. Please wait a minute and try again.');
  return placeCall(ctx, input.studentId, input.to, conn);
}

/**
 * Ring a parent for an AI voice conversation (src/modules/ai-calls), with the AI agent's virtual
 * connection as the caller's side. Same authorization, busy rules and race handling as any call;
 * the AI module applies its own limits.
 */
export async function startAiCall(ctx: SchoolContext, studentId: string, parentId: string, agent: SignalingConnection) {
  assertCallsEnabled();
  assertMessagingRole(ctx);
  if (!agent.virtual || agent.schoolId !== ctx.schoolId || agent.userId !== ctx.userId) throw forbidden();
  return placeCall(ctx, studentId, { type: 'parent', parentId }, agent, { ai: true });
}

async function placeCall(
  ctx: SchoolContext,
  studentId: string,
  to: CallTarget,
  conn: SignalingConnection,
  opts: { ai?: boolean } = {},
) {
  const r = await resolveCall(ctx, studentId, to);
  const me = oid(ctx.userId);
  const ring = r.ringUserIds.filter((u) => !same(u, ctx.userId));
  const engaged = await engagedUsers(ctx.schoolId, [me, ...ring]);
  if (!opts.ai && engaged.get(ctx.userId) === 'participant')
    throw conflict('You are already in a call. End it before starting another.', undefined, 'ALREADY_IN_CALL');

  const free = ring.filter((u) => !engaged.has(String(u)));
  // Reachable: the app is connected now, or it can be woken by push (docs/INCOMING_CALLS.md).
  const byPush = await pushReachableUsers(ctx.schoolId, free.map(String));
  const available = free.filter((u) => callHub.isOnline(ctx.schoolId, String(u)) || byPush.has(String(u)));
  const status: CallStatus = available.length ? 'ringing' : free.length < ring.length ? 'busy' : 'unreachable';
  const now = new Date();
  const created = await CallSession.create({
    schoolId: ctx.schoolId,
    callId: newCallId(),
    kind: opts.ai ? 'ai' : r.kind,
    studentId: r.studentId,
    studentName: r.studentName,
    callerUserId: me,
    callerName: opts.ai ? 'AI assistant' : ctx.name,
    callerRole: ctx.role,
    parentId: r.parentId,
    parentUserId: r.parentUserId,
    staffUserId: r.staffUserId,
    ringUserIds: status === 'ringing' ? available : ring,
    calleeName: r.calleeName,
    calleeRole: r.calleeRole,
    callerConnId: conn.id,
    status,
    ringExpiresAt: new Date(now.getTime() + env.CALL_RING_TIMEOUT_SECONDS * 1000),
    ...(status === 'ringing' ? {} : { endedAt: now, durationSec: 0, endReason: status }),
  });
  let call = created.toObject() as CallDoc;

  if (status === 'ringing') {
    // Simultaneous attempts: an earlier call that already holds a recipient keeps them.
    const lost = await engagedUsers(ctx.schoolId, available, created._id);
    if (lost.size) {
      const keep = available.filter((u) => !lost.has(String(u)));
      if (!keep.length) {
        call = (await finalize(ctx.schoolId, call.callId, ['ringing'], 'busy', 'busy')) ?? call;
      } else {
        call =
          (await CallSession.findOneAndUpdate(
            scope(ctx, { _id: created._id, status: 'ringing' }),
            { $set: { ringUserIds: keep } },
            { new: true },
          ).lean()) ?? call;
      }
    }
  } else {
    await notifyMissed(call);
    const event: CallFinishedEvent = {
      schoolId: ctx.schoolId,
      callId: call.callId,
      kind: r.kind,
      status,
      reason: status,
      durationSec: 0,
    };
    callEvents.emit('finished', event);
  }

  if (call.status === 'ringing') {
    const school = await School.findById(ctx.schoolId).select('name').lean();
    for (const u of call.ringUserIds ?? []) {
      callHub.toUser(ctx.schoolId, String(u), {
        type: 'call.incoming',
        call: viewFor(call, String(u)),
        schoolName: school?.name ?? '',
      });
    }
    // Devices where the app is not running ring through push (best effort, never blocks the call).
    pushIncoming(ctx.schoolId, call, school?.name ?? '');
    expectAcks(ctx.schoolId, call.callId, (call.ringUserIds ?? []).map(String), byPush);
    const callId = call.callId;
    callTimers.set(callId, 'ring', env.CALL_RING_TIMEOUT_SECONDS * 1000, () => {
      void finalize(ctx.schoolId, callId, ['ringing'], 'missed', 'no_answer').catch((err) =>
        logger.error({ err }, 'Could not end an unanswered call'),
      );
    });
  }
  await audit(ctx, {
    action: 'call.started',
    entityType: 'CallSession',
    entityId: created._id,
    summary: `${opts.ai ? 'AI assistant for ' : ''}${ctx.name} called ${r.calleeName} about ${r.studentName}`,
    metadata: { kind: r.kind, result: call.status },
  });
  return withIce(ctx, call);
}

/** A call the signed-in user placed or was rung for; anything else is 404 (no enumeration). */
async function ownCall(ctx: SchoolContext, callId: string) {
  const me = oid(ctx.userId);
  const c = await CallSession.findOne(scope(ctx, { callId, $or: [{ callerUserId: me }, { ringUserIds: me }] })).lean();
  if (!c) throw notFound('Call');
  return c;
}

const isParticipant = (c: CallDoc, userId: string) => same(c.callerUserId, userId) || same(c.answeredByUserId, userId);

export async function acceptCall(ctx: SchoolContext, callId: string, connectionId: string) {
  assertCallsEnabled();
  const conn = boundConnection(ctx, connectionId);
  const cur = await ownCall(ctx, callId);
  const me = oid(ctx.userId);
  if (same(cur.callerUserId, ctx.userId)) throw forbidden('You cannot answer your own call');
  if (cur.status !== 'ringing' || (cur.declinedUserIds ?? []).some((u) => same(u, ctx.userId)))
    throw notRinging(cur, ctx.userId);
  if (cur.ringExpiresAt.getTime() <= Date.now()) {
    const ended = await finalize(ctx.schoolId, callId, ['ringing'], 'missed', 'no_answer');
    throw notRinging(ended ?? cur, ctx.userId);
  }
  if ((await engagedUsers(ctx.schoolId, [me])).get(ctx.userId) === 'participant')
    throw conflict('You are already in a call. End it before answering another.', undefined, 'ALREADY_IN_CALL');
  // Re-check the relationship now, from the database: it may have changed since the call rang.
  if (!(await stillAuthorized(ctx.schoolId, cur, ctx.userId))) {
    await finalize(ctx.schoolId, callId, ['ringing'], 'failed', 'not_authorized');
    throw forbidden('This call is no longer allowed.');
  }
  const office = cur.kind === 'office';
  const call = await CallSession.findOneAndUpdate(
    scope(ctx, { callId, status: 'ringing', ringUserIds: me, declinedUserIds: { $ne: me } }),
    {
      $set: {
        status: 'connecting',
        answeredByUserId: me,
        calleeConnId: conn.id,
        answeredAt: new Date(),
        ...(office
          ? { staffUserId: me, calleeName: ctx.name, calleeRole: `${roleLabel(ctx.role)} · School office` }
          : {}),
      },
    },
    { new: true },
  ).lean();
  if (!call) throw notRinging(await CallSession.findOne(scope(ctx, { callId })).lean(), ctx.userId);
  callTimers.clear(callId, 'ring');
  // Every other device that was ringing stops (the answering one already did).
  pushEnded(call);
  callTimers.set(callId, 'connect', CONNECT_TIMEOUT_MS, () => {
    void finalize(ctx.schoolId, callId, ['connecting'], 'failed', 'connect_timeout').catch((err) =>
      logger.error({ err }, 'Could not end a call that never connected'),
    );
  });
  broadcast(call);
  return withIce(ctx, call);
}

export async function declineCall(ctx: SchoolContext, callId: string) {
  const cur = await ownCall(ctx, callId);
  if (same(cur.callerUserId, ctx.userId)) throw forbidden('Cancel your own call instead');
  if (cur.status !== 'ringing') throw notRinging(cur, ctx.userId);
  if (cur.kind === 'direct') {
    const done = await finalize(ctx.schoolId, callId, ['ringing'], 'declined', 'declined', ctx.userId);
    if (!done) throw notRinging(await ownCall(ctx, callId), ctx.userId);
    return { call: viewFor(done, ctx.userId) };
  }
  // School office: one member declining stops their ringing; the call ends when all have.
  const me = oid(ctx.userId);
  const upd = await CallSession.findOneAndUpdate(
    scope(ctx, { callId, status: 'ringing' }),
    { $addToSet: { declinedUserIds: me } },
    { new: true },
  ).lean();
  if (!upd) throw notRinging(await ownCall(ctx, callId), ctx.userId);
  if ((upd.declinedUserIds ?? []).length >= (upd.ringUserIds ?? []).length) {
    const done = await finalize(ctx.schoolId, callId, ['ringing'], 'declined', 'declined', ctx.userId);
    return { call: viewFor(done ?? upd, ctx.userId) };
  }
  for (const c of callHub.connsOf(ctx.schoolId, ctx.userId))
    c.send({ type: 'call.updated', call: viewFor(upd, ctx.userId), onThisDevice: false });
  return { call: viewFor(upd, ctx.userId) };
}

/**
 * Hang up, whatever the state: the caller cancels a ringing call, a recipient declines it, and
 * either participant ends an answered call. Calling it on a finished call changes nothing.
 */
export async function hangUp(ctx: SchoolContext, callId: string): Promise<{ call: CallView }> {
  const cur = await ownCall(ctx, callId);
  if (cur.status === 'ringing') {
    if (same(cur.callerUserId, ctx.userId)) {
      const done = await finalize(ctx.schoolId, callId, ['ringing'], 'cancelled', 'cancelled', ctx.userId);
      if (done) return { call: viewFor(done, ctx.userId) };
    } else {
      return declineCall(ctx, callId).catch(async (err): Promise<{ call: CallView }> => {
        if (err instanceof AppError && err.code === 'CALL_NOT_RINGING') return hangUp(ctx, callId);
        throw err;
      });
    }
  }
  if (ANSWERED.includes(cur.status as CallStatus) && isParticipant(cur, ctx.userId)) {
    const done = await finalize(ctx.schoolId, callId, ANSWERED, 'completed', 'hangup', ctx.userId);
    if (done) return { call: viewFor(done, ctx.userId) };
  }
  return { call: viewFor(await ownCall(ctx, callId), ctx.userId) };
}

/** A participant reports that audio is flowing (WebRTC connected). */
export async function markConnected(ctx: SchoolContext, callId: string) {
  const cur = await ownCall(ctx, callId);
  if (!isParticipant(cur, ctx.userId)) throw notFound('Call');
  if (cur.status === 'active') return { call: viewFor(cur, ctx.userId) };
  if (cur.status !== 'connecting') throw conflict('This call has ended.', undefined, 'CALL_ENDED');
  const call = await CallSession.findOneAndUpdate(
    scope(ctx, { callId, status: 'connecting' }),
    { $set: { status: 'active', connectedAt: new Date() } },
    { new: true },
  ).lean();
  if (!call) return { call: viewFor(await ownCall(ctx, callId), ctx.userId) };
  callTimers.clear(callId, 'connect');
  callTimers.set(callId, 'max', env.CALL_MAX_MINUTES * 60_000, () => {
    void finalize(ctx.schoolId, callId, ['active'], 'completed', 'max_duration').catch((err) =>
      logger.error({ err }, 'Could not end a call at its maximum length'),
    );
  });
  broadcast(call);
  return { call: viewFor(call, ctx.userId) };
}

/**
 * The AI agent reports that audio is flowing (connecting → active), like markConnected for a
 * device. Only for AI calls.
 */
export async function markAiCallConnected(schoolId: string, callId: string) {
  const call = await CallSession.findOneAndUpdate(
    { schoolId: oid(schoolId), callId, kind: 'ai', status: 'connecting' },
    { $set: { status: 'active', connectedAt: new Date() } },
    { new: true },
  ).lean();
  if (!call) return null;
  callTimers.clear(callId, 'connect');
  broadcast(call);
  return call;
}

/** A participant reports that the call could not continue (no microphone, media failure...). */
export async function failCall(ctx: SchoolContext, callId: string, reason: (typeof FAIL_REASONS)[number]) {
  const cur = await ownCall(ctx, callId);
  if (!isParticipant(cur, ctx.userId)) throw notFound('Call');
  const done = await finalize(ctx.schoolId, callId, LIVE, 'failed', reason, ctx.userId);
  return { call: viewFor(done ?? (await ownCall(ctx, callId)), ctx.userId) };
}

/**
 * After a dropped signaling connection: bind the participant's new connection to the call (the
 * same user only) and tell the other side, which then restarts ICE.
 */
export async function rejoinCall(ctx: SchoolContext, callId: string, connectionId: string) {
  const conn = boundConnection(ctx, connectionId);
  const cur = await ownCall(ctx, callId);
  const caller = same(cur.callerUserId, ctx.userId);
  if (!isParticipant(cur, ctx.userId)) throw notFound('Call');
  const states = caller ? LIVE : ANSWERED;
  if (!states.includes(cur.status as CallStatus)) throw conflict('This call has ended.', undefined, 'CALL_ENDED');
  const field = caller ? 'callerConnId' : 'calleeConnId';
  const call = await CallSession.findOneAndUpdate(
    scope(ctx, { callId, status: { $in: states } }),
    { $set: { [field]: conn.id } },
    { new: true },
  ).lean();
  if (!call) throw conflict('This call has ended.', undefined, 'CALL_ENDED');
  callTimers.clear(callId, `grace:${caller ? 'caller' : 'callee'}`);
  callHub.toConn(caller ? call.calleeConnId : call.callerConnId, { type: 'call.peer_rejoined', callId });
  return withIce(ctx, call);
}

/**
 * A signaling connection closed. Calls bound to it get a grace period to rejoin from a new
 * connection; after that they are recorded as failed. The other side is told at once.
 */
export async function onConnectionClosed(conn: SignalingConnection) {
  const calls = await CallSession.find({
    schoolId: oid(conn.schoolId),
    status: { $in: LIVE },
    $or: [{ callerConnId: conn.id }, { calleeConnId: conn.id }],
  })
    .select('callId callerConnId calleeConnId')
    .lean();
  for (const c of calls) {
    const side = c.callerConnId === conn.id ? 'caller' : 'callee';
    callHub.toConn(side === 'caller' ? c.calleeConnId : c.callerConnId, {
      type: 'call.peer_disconnected',
      callId: c.callId,
    });
    callTimers.set(c.callId, `grace:${side}`, env.CALL_RECONNECT_GRACE_SECONDS * 1000, () => {
      void (async () => {
        const still = await CallSession.exists({
          schoolId: oid(conn.schoolId),
          callId: c.callId,
          [`${side}ConnId`]: conn.id,
          status: { $in: LIVE },
        });
        if (still) await finalize(conn.schoolId, c.callId, LIVE, 'failed', 'connection_lost');
      })().catch((err) => logger.error({ err }, 'Could not end a call after a lost connection'));
    });
  }
}

/** Relay one WebRTC message to the other connection bound to the call, and nowhere else. */
export async function relaySignal(conn: SignalingConnection, callId: string, signal: unknown): Promise<boolean> {
  const c = await CallSession.findOne({
    schoolId: oid(conn.schoolId),
    callId,
    status: { $in: ANSWERED },
    $or: [{ callerConnId: conn.id }, { calleeConnId: conn.id }],
  })
    .select('callerConnId calleeConnId callerUserId answeredByUserId')
    .lean();
  if (!c) return false;
  const fromCaller = c.callerConnId === conn.id;
  // Defence in depth: the connection must still belong to that participant.
  if (!same(fromCaller ? c.callerUserId : c.answeredByUserId, conn.userId)) return false;
  return callHub.toConn(fromCaller ? c.calleeConnId : c.callerConnId, { type: 'signal', callId, signal });
}

/** Calls still ringing for this user (re-sent when a device connects). */
export async function ringingFor(schoolId: string, userId: string) {
  const me = oid(userId);
  const rows = await CallSession.find({
    schoolId: oid(schoolId),
    status: 'ringing',
    ringUserIds: me,
    declinedUserIds: { $ne: me },
    ringExpiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  if (!rows.length) return [];
  const school = await School.findById(schoolId).select('name').lean();
  return rows.map((c) => ({ call: viewFor(c, userId), schoolName: school?.name ?? '' }));
}

export async function getCall(ctx: SchoolContext, callId: string) {
  const c = await ownCall(ctx, callId);
  // Connection statistics are shown to the call's participants only.
  const diagnostics = isParticipant(c, ctx.userId) ? (c.diagnostics ?? null) : null;
  return { call: viewFor(c, ctx.userId), diagnostics };
}

export const DIAGNOSTIC_MOMENTS = ['connected', 'ended', 'failed'] as const;
export interface CallDiagnostics {
  moment: (typeof DIAGNOSTIC_MOMENTS)[number];
  client: 'web' | 'mobile';
  iceState: string;
  localCandidate: string | null;
  remoteCandidate: string | null;
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
  packetsLost: number;
  roundTripMs: number | null;
  audioLevelIn: number | null;
  audioLevelOut: number | null;
  localTrack: string;
}

/**
 * A participant's connection statistics for the call record and the server log (call id and
 * numbers only). Accepted while the call is live and for ten minutes after it ended.
 */
export async function recordDiagnostics(ctx: SchoolContext, callId: string, d: CallDiagnostics) {
  const c = await ownCall(ctx, callId);
  if (!isParticipant(c, ctx.userId)) throw notFound('Call');
  if (c.endedAt && Date.now() - c.endedAt.getTime() > 10 * 60_000)
    throw conflict('This call ended too long ago.', undefined, 'CALL_ENDED');
  const side = same(c.callerUserId, ctx.userId) ? 'caller' : 'callee';
  await CallSession.updateOne(scope(ctx, { _id: c._id }), {
    $set: { [`diagnostics.${side}`]: { ...d, at: new Date() } },
  });
  logger.info(
    {
      call: callId.slice(0, 8),
      side,
      moment: d.moment,
      client: d.client,
      ice: d.iceState,
      pair: `${d.localCandidate ?? '?'}/${d.remoteCandidate ?? '?'}`,
      sent: d.bytesSent,
      recv: d.bytesReceived,
      lost: d.packetsLost,
      rttMs: d.roundTripMs,
      mic: d.localTrack,
      levelOut: d.audioLevelOut,
      levelIn: d.audioLevelIn,
    },
    'Call media diagnostics',
  );
}

/** The user's live call, if any (to restore the call screen after the app restarts). */
export async function currentCall(ctx: SchoolContext) {
  const me = oid(ctx.userId);
  const c = await CallSession.findOne(
    scope(ctx, {
      $or: [
        { status: { $in: LIVE }, callerUserId: me },
        { status: { $in: ANSWERED }, answeredByUserId: me },
      ],
    }),
  )
    .sort({ createdAt: -1 })
    .lean();
  return { call: c ? viewFor(c, ctx.userId) : null };
}

/**
 * Call history of the signed-in user, newest first. With `conversationId`, only the calls
 * between that conversation's two people about its student.
 */
export async function listCalls(ctx: SchoolContext, q: { page: number; limit: number; conversationId?: string }) {
  assertMessagingRole(ctx);
  const me = oid(ctx.userId);
  let filter: Record<string, unknown> = { $or: [{ callerUserId: me }, { ringUserIds: me }] };
  if (q.conversationId) {
    const conv = await Conversation.findOne(scope(ctx, { _id: oid(q.conversationId) }))
      .select('studentId parentUserId staffUserId')
      .lean();
    const mine = conv && (same(conv.parentUserId, ctx.userId) || same(conv.staffUserId, ctx.userId));
    if (!conv || (!mine && !isLeader(ctx))) throw notFound('Conversation');
    filter = {
      studentId: conv.studentId,
      parentUserId: conv.parentUserId,
      staffUserId: conv.staffUserId,
      ...(mine ? filter : {}),
    };
    // Leadership oversight sees that a call happened, never more than its participants do.
    if (!mine) filter = { ...filter, $or: [{ callerUserId: conv.parentUserId }, { callerUserId: conv.staffUserId }] };
  }
  const [rows, total] = await Promise.all([
    CallSession.find(scope(ctx, filter))
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    CallSession.countDocuments(scope(ctx, filter)),
  ]);
  // Link each call to its conversation, when the two people have one.
  const pairs = rows.filter((r) => r.staffUserId);
  const convs = pairs.length
    ? await Conversation.find(
        scope(ctx, {
          $or: pairs.map((r) => ({ studentId: r.studentId, parentUserId: r.parentUserId, staffUserId: r.staffUserId })),
        }),
      )
        .select('studentId parentUserId staffUserId')
        .lean()
    : [];
  const convOf = new Map(convs.map((c) => [`${c.studentId}|${c.parentUserId}|${c.staffUserId}`, String(c._id)]));
  return {
    items: rows.map((r) => ({
      ...viewFor(r, ctx.userId),
      conversationId: r.staffUserId ? (convOf.get(`${r.studentId}|${r.parentUserId}|${r.staffUserId}`) ?? null) : null,
      callBack: callBackTarget(r, ctx.userId),
    })),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

/** Whom "call back" would ring from a history entry (the server checks it again). */
function callBackTarget(c: CallDoc, viewerId: string): CallTarget | null {
  const viewerIsParent = same(c.parentUserId, viewerId);
  if (viewerIsParent) {
    if (c.kind === 'office' && !c.answeredByUserId) return { type: 'office' };
    return c.staffUserId ? { type: 'staff', userId: String(c.staffUserId) } : { type: 'office' };
  }
  return { type: 'parent', parentId: String(c.parentId) };
}

export function iceServers(ctx: SchoolContext) {
  assertCallsEnabled();
  return iceServersFor(ctx);
}

/**
 * Database sweeper, independent of in-memory timers (which a restart loses): ends calls that
 * rang too long, never connected, or passed the maximum length.
 */
export async function sweepCalls(now = new Date()) {
  const rows = await CallSession.find({
    $or: [
      { status: 'ringing', ringExpiresAt: { $lt: now } },
      { status: 'connecting', answeredAt: { $lt: new Date(now.getTime() - CONNECT_TIMEOUT_MS) } },
      { status: 'active', connectedAt: { $lt: new Date(now.getTime() - env.CALL_MAX_MINUTES * 60_000) } },
    ],
  })
    .setOptions({ crossTenant: true })
    .select('schoolId callId status')
    .limit(200)
    .lean();
  for (const r of rows) {
    const [status, reason]: [CallStatus, string] =
      r.status === 'ringing'
        ? ['missed', 'no_answer']
        : r.status === 'connecting'
          ? ['failed', 'connect_timeout']
          : ['completed', 'max_duration'];
    await finalize(String(r.schoolId), r.callId, [r.status as CallStatus], status, reason);
  }
  return rows.length;
}

/**
 * At startup: calls left live by a previous run cannot continue (their connections are gone).
 * Single-instance assumption; with several instances this must only touch calls owned by the
 * instance that is starting (docs/VOICE_CALLS.md).
 */
export async function recoverInterruptedCalls() {
  const res = await CallSession.updateMany(
    { status: { $in: LIVE } },
    { $set: { status: 'failed', endReason: 'server_restart', endedAt: new Date() } },
  ).setOptions({ crossTenant: true });
  if (res.modifiedCount) logger.warn({ calls: res.modifiedCount }, 'Calls interrupted by a restart were closed');
}

let sweeper: NodeJS.Timeout | null = null;
export function startCallSweeper(intervalMs = 15_000) {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepCalls().catch((err) => logger.error({ err }, 'Call sweeper failed'));
  }, intervalMs);
  sweeper.unref();
}
export function stopCallSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
