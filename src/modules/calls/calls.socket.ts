import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import jwt from 'jsonwebtoken';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';
import { isLocalDevOrigin } from '../../app';
import { env, isProd } from '../../config/env';
import { logger } from '../../config/logger';
import { schoolContextFromToken } from '../../middleware/authenticate';
import { AppError } from '../../utils/errors';
import { callHub, type CallEvent, type SignalingConnection } from './calls.hub';
import { acknowledgeIncoming, onConnectionClosed, relaySignal, ringingFor } from './calls.service';

/**
 * Call signaling over WebSocket (docs/VOICE_CALLS.md). It carries only events and WebRTC
 * negotiation (SDP offers/answers, ICE candidates); call actions (start, answer, hang up) are
 * REST requests with the usual authentication, permissions and plan checks.
 *
 * Protocol (JSON text frames):
 *   client → { type: 'auth', token, client?: 'mobile' }   first message, within 10 s; again
 *            before the access token expires (same user only)
 *   server → { type: 'ready', connectionId }              give connectionId to call requests
 *   client → { type: 'signal', callId, signal }            relayed only to the other device bound
 *                                                          to that call, never to anyone else
 *   client → { type: 'ping' } / server → { type: 'pong' }
 *   server → call.incoming, call.updated, call.peer_disconnected, call.peer_rejoined, signal,
 *            error { code }
 * The token travels in a message, never in the URL, so it does not reach access logs.
 */

export const SIGNALING_PATH = '/api/v1/calls/socket';

const AUTH_TIMEOUT_MS = 10_000;
const RECHECK_MS = 60_000;
const HEARTBEAT_MS = 25_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CONNECTIONS_PER_USER = 5;
const BAD_MESSAGES_BEFORE_CLOSE = 10;
/** Token bucket per connection: bursts of ICE candidates are fine, floods are not. */
const BUCKET_CAPACITY = 120;
const BUCKET_REFILL_PER_SEC = 15;
const UPGRADES_PER_IP_PER_MINUTE = 60;

const CallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const SignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(20_000), restart: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(20_000) }).strict(),
  z
    .object({
      kind: z.literal('candidate'),
      candidate: z.string().max(1024),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    })
    .strict(),
]);
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('auth'),
      token: z.string().min(10).max(4096),
      client: z.string().max(40).optional(),
      /** 'events': live updates only (any signed-in school user); default: calls. */
      purpose: z.enum(['calls', 'events']).optional(),
      /** The client acknowledges every call.incoming at once ({ type: 'ack', callId }). */
      acks: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('ack'), callId: CallIdSchema }).strict(),
  z.object({ type: z.literal('signal'), callId: CallIdSchema, signal: SignalSchema }).strict(),
]);

function originAllowed(origin: string | undefined) {
  // Native apps send no Origin. Browsers must come from the configured website.
  if (!origin) return true;
  if (env.CORS_ORIGINS.includes(origin)) return true;
  return !isProd && isLocalDevOrigin(origin);
}

function clientIp(req: IncomingMessage) {
  if (env.TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (fwd.length) return fwd[Math.max(0, fwd.length - Number(env.TRUST_PROXY))] ?? fwd[0];
  }
  return req.socket.remoteAddress ?? '';
}

const upgrades = new Map<string, number[]>();
function upgradeAllowed(ip: string, now = Date.now()) {
  const recent = (upgrades.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= UPGRADES_PER_IP_PER_MINUTE) {
    upgrades.set(ip, recent);
    return false;
  }
  recent.push(now);
  upgrades.set(ip, recent);
  if (upgrades.size > 10_000) upgrades.clear();
  return true;
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function tokenExpiry(token: string): number | null {
  const claims = jwt.decode(token) as { exp?: number } | null;
  return claims?.exp ? claims.exp * 1000 : null;
}

export function attachCallSignaling(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== SIGNALING_PATH) return refuse(socket, 404, 'Not Found');
    if (!originAllowed(req.headers.origin)) return refuse(socket, 403, 'Forbidden');
    const ip = clientIp(req);
    if (!upgradeAllowed(ip)) return refuse(socket, 429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws, ip));
  });
  return wss;
}

function handleSocket(ws: WebSocket, ip: string) {
  let conn: SignalingConnection | null = null;
  let token = '';
  let client = '';
  let tokens = BUCKET_CAPACITY;
  let lastRefill = Date.now();
  let bad = 0;
  let alive = true;
  let expiryTimer: NodeJS.Timeout | null = null;

  const send = (event: CallEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  const close = (code: number, reason: string) => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
  };
  const authTimer = setTimeout(() => close(4401, 'Authentication required'), AUTH_TIMEOUT_MS);

  const take = () => {
    const now = Date.now();
    tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * BUCKET_REFILL_PER_SEC);
    lastRefill = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };

  /** Verify the token like any request (user, session, school, plan, mobile policy, permission). */
  const verify = async (t: string, c: string, eventsOnly = conn?.eventsOnly ?? false) => {
    const ctx = await schoolContextFromToken(t, { method: 'GET', headers: { 'x-client-app': c }, ip });
    if (eventsOnly) return ctx;
    if (!env.CALLS_ENABLED) throw new AppError(503, 'CALLS_DISABLED', 'Calls are switched off on this server');
    if (!ctx.permissions.has('calls:use')) throw new AppError(403, 'FORBIDDEN', 'Your account cannot use calls');
    if (!ctx.entitlements.has('calls.voice'))
      throw new AppError(403, 'FEATURE_NOT_IN_PLAN', "Calls are not part of your school's plan", {
        feature: 'calls.voice',
      });
    return ctx;
  };

  const armExpiry = (t: string) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const exp = tokenExpiry(t);
    if (!exp) return;
    // A little leeway for clock skew; the client re-authenticates before this with a fresh token.
    expiryTimer = setTimeout(() => close(4401, 'Session expired'), Math.max(0, exp - Date.now()) + 30_000);
    expiryTimer.unref();
  };

  const recheck = setInterval(() => {
    if (!conn || !token) return;
    verify(token, client).catch(() => close(4401, 'Session is no longer valid'));
  }, RECHECK_MS);
  recheck.unref();

  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);
  heartbeat.unref();
  ws.on('pong', () => {
    alive = true;
  });

  const onAuth = async (msg: { token: string; client?: string; purpose?: 'calls' | 'events'; acks?: boolean }) => {
    const c = (msg.client ?? '').trim().toLowerCase();
    const eventsOnly = conn ? Boolean(conn.eventsOnly) : msg.purpose === 'events';
    try {
      const ctx = await verify(msg.token, c, eventsOnly);
      if (conn && (conn.userId !== ctx.userId || conn.schoolId !== ctx.schoolId)) {
        return close(4403, 'A connection cannot change user');
      }
      token = msg.token;
      client = c;
      armExpiry(msg.token);
      if (conn) return send({ type: 'auth.ok' });
      clearTimeout(authTimer);
      conn = {
        id: crypto.randomBytes(24).toString('base64url'),
        schoolId: ctx.schoolId,
        userId: ctx.userId,
        send,
        close,
        ...(eventsOnly ? { eventsOnly: true } : {}),
        ...(msg.acks && !eventsOnly ? { acks: true } : {}),
      };
      // Keep at most a few devices or tabs per user: the oldest connection gives way.
      const existing = callHub.connsOf(ctx.schoolId, ctx.userId, { includeEventsOnly: true }).filter((c) => !c.virtual);
      for (const old of existing.slice(0, Math.max(0, existing.length - MAX_CONNECTIONS_PER_USER + 1)))
        old.close(4409, 'Too many connections');
      callHub.add(conn);
      send({ type: 'ready', connectionId: conn.id });
      if (eventsOnly) return;
      for (const r of await ringingFor(ctx.schoolId, ctx.userId)) send({ type: 'call.incoming', ...r });
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      send({ type: 'error', code: e?.code ?? 'UNAUTHORIZED', message: e?.message ?? 'Authentication failed' });
      close(e?.code === 'TOKEN_EXPIRED' ? 4401 : 4403, e?.code ?? 'Unauthorized');
    }
  };

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) return close(4400, 'Text frames only');
    if (!take()) {
      send({ type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' });
      if (tokens < -BUCKET_CAPACITY) close(4429, 'Too many messages');
      tokens -= 1;
      return;
    }
    let parsed: z.infer<typeof ClientMessageSchema>;
    try {
      const r = ClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (!r.success) throw new Error('invalid');
      parsed = r.data;
    } catch {
      bad += 1;
      send({ type: 'error', code: 'BAD_MESSAGE', message: 'Message not understood' });
      if (bad >= BAD_MESSAGES_BEFORE_CLOSE) close(4400, 'Too many invalid messages');
      return;
    }
    if (parsed.type === 'auth') return void onAuth(parsed);
    if (!conn) return send({ type: 'error', code: 'UNAUTHORIZED', message: 'Authenticate first' });
    if (parsed.type === 'ping') return send({ type: 'pong' });
    if (parsed.type === 'ack') return void acknowledgeIncoming(conn, parsed.callId);
    if (conn.eventsOnly) return send({ type: 'error', code: 'NOT_IN_CALL', callId: parsed.callId });
    const from = conn;
    const { callId, signal } = parsed;
    void relaySignal(from, callId, signal)
      .then((ok) => {
        if (!ok) send({ type: 'error', code: 'NOT_IN_CALL', callId });
      })
      .catch((err) => {
        logger.error({ err }, 'Could not relay a call signal');
        send({ type: 'error', code: 'INTERNAL_ERROR', callId });
      });
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    clearInterval(recheck);
    clearInterval(heartbeat);
    if (expiryTimer) clearTimeout(expiryTimer);
    if (conn) {
      const gone = conn;
      callHub.remove(gone.id);
      void onConnectionClosed(gone).catch((err) => logger.error({ err }, 'Could not handle a closed call connection'));
    }
  });
  ws.on('error', () => ws.terminate());
}
