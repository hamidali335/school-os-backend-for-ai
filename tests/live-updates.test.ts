import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { callHub } from '../src/modules/calls/calls.hub';
import { attachCallSignaling, SIGNALING_PATH } from '../src/modules/calls/calls.socket';
import { Notification } from '../src/modules/communications/communications.models';
import { Message } from '../src/modules/messaging/messaging.models';
import { auth, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * Live updates without a reload: any signed-in user may open the socket for events only (no call
 * permission or plan needed). New notifications and messages arrive as "fetch now" events; the
 * events carry no private content and never reach another user or school. Messages sent with a
 * clientMessageId are saved once however often they are retried.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let server: http.Server;
let url: string;
const sockets: WebSocket[] = [];

type Ev = Record<string, any>;
async function connect(token: string, purpose?: 'events') {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const events: Ev[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  ws.send(JSON.stringify({ type: 'auth', token, ...(purpose ? { purpose } : {}) }));
  const until = async (pred: (e: Ev) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = events.find(pred);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no event in ${JSON.stringify(events)}`);
  };
  const ready = await until((e) => e.type === 'ready' || e.type === 'error');
  return { ws, events, until, ready, take: () => events.splice(0) };
}

const call = (token: string, method: 'get' | 'post', path: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${path}`).set(auth(token)).send(body);

beforeAll(async () => {
  // Neither school has calls in its plan.
  f = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
  server = http.createServer(t.app);
  attachCallSignaling(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SIGNALING_PATH}`;
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.terminate();
});

afterAll(async () => {
  callHub.reset();
  await new Promise((r) => server.close(r));
});

describe('events-only connections', () => {
  it('any signed-in user may open one; a calls connection still needs calls in the plan', async () => {
    const live = await connect(f.parentToken, 'events');
    expect(live.ready.type).toBe('ready');
    const calls = await connect(f.parentToken);
    expect(calls.ready).toMatchObject({ type: 'error', code: 'FEATURE_NOT_IN_PLAN' });
  });

  it('can never be used for a call: not bound, not reachable, no signals relayed', async () => {
    const live = await connect(f.parentToken, 'events');
    expect(callHub.isOnline(f.schoolId, (await call(f.parentToken, 'get', '/auth/me')).body.data.user._id)).toBe(false);
    expect(callHub.owned(live.ready.connectionId, f.schoolId, 'x')).toBeUndefined();
    live.ws.send(JSON.stringify({ type: 'signal', callId: 'a'.repeat(32), signal: { kind: 'answer', sdp: 'v=0' } }));
    expect((await live.until((e) => e.type === 'error')).code).toBe('NOT_IN_CALL');
  });
});

describe('messages arrive without a reload', () => {
  let conversationId: string;

  it('the parent gets message.new and notification.new; nobody else does', async () => {
    const parent = await connect(f.parentToken, 'events');
    const outsider = await connect(other.parentToken, 'events');
    const otherTeacher = await connect(f.otherTeacherToken, 'events');
    const res = await call(f.teacherToken, 'post', '/messages/conversations', {
      studentId: f.students[0],
      body: 'Ali did very well in the maths test today.',
      clientMessageId: 'first-message-0001',
    });
    expect(res.status).toBe(201);
    conversationId = res.body.data._id;
    const msg = await parent.until((e) => e.type === 'message.new');
    expect(msg).toEqual({ type: 'message.new', conversationId });
    expect(await parent.until((e) => e.type === 'notification.new')).toEqual({
      type: 'notification.new',
      category: 'message',
    });
    // Events say "fetch now"; they carry no message text.
    expect(JSON.stringify(parent.events)).not.toContain('maths test');
    await new Promise((r) => setTimeout(r, 200));
    expect(outsider.events.filter((e) => e.type !== 'ready')).toEqual([]);
    expect(otherTeacher.events.filter((e) => e.type !== 'ready')).toEqual([]);
  });

  it('a retried send (same clientMessageId) is saved and notified once', async () => {
    const before = await Notification.countDocuments({ schoolId: f.schoolId, category: 'message' });
    const send = () =>
      call(f.teacherToken, 'post', `/messages/conversations/${conversationId}/messages`, {
        body: 'Please sign the diary.',
        clientMessageId: 'retry-message-0002',
      });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await send()).status).toBe(201);
    expect(
      await Message.countDocuments({ schoolId: f.schoolId, conversationId, clientMessageId: 'retry-message-0002' }),
    ).toBe(1);
    expect(await Notification.countDocuments({ schoolId: f.schoolId, category: 'message' })).toBe(before + 1);
    const detail = (await call(f.teacherToken, 'get', `/messages/conversations/${conversationId}`)).body.data;
    expect(detail.messages.filter((m: { body: string }) => m.body === 'Please sign the diary.')).toHaveLength(1);
    expect(detail.messages.at(-1).clientMessageId).toBe('retry-message-0002');
  });

  it('the same id from someone else, or in a bad format, is not mixed up', async () => {
    const bad = await call(f.teacherToken, 'post', `/messages/conversations/${conversationId}/messages`, {
      body: 'x',
      clientMessageId: 'no spaces allowed',
    });
    expect(bad.status).toBe(400);
    const parentReply = await call(f.parentToken, 'post', `/messages/conversations/${conversationId}/messages`, {
      body: 'Will do, thank you.',
      clientMessageId: 'retry-message-0002',
    });
    expect(parentReply.status).toBe(201);
    expect(parentReply.body.data.messages.at(-1).body).toBe('Will do, thank you.');
  });

  it('reading tells the writer once ("Seen"); viewing again sends nothing (no ping-pong)', async () => {
    await call(f.teacherToken, 'post', `/messages/conversations/${conversationId}/messages`, {
      body: 'One more thing.',
    });
    const teacher = await connect(f.teacherToken, 'events');
    await call(f.parentToken, 'get', `/messages/conversations/${conversationId}`);
    expect(await teacher.until((e) => e.type === 'message.read')).toEqual({ type: 'message.read', conversationId });
    teacher.take();
    await call(f.parentToken, 'get', `/messages/conversations/${conversationId}`);
    await call(f.teacherToken, 'get', `/messages/conversations/${conversationId}`);
    await new Promise((r) => setTimeout(r, 200));
    expect(teacher.events.filter((e) => e.type === 'message.read')).toEqual([]);
  });
});

describe('other notifications', () => {
  it('a leave decision reaches the parent live', async () => {
    const parent = await connect(f.parentToken, 'events');
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    const leave = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: day,
      to: day,
      reason: 'Family wedding',
    });
    expect(leave.status).toBe(201);
    parent.take();
    await call(f.principalToken, 'post', `/leave-requests/${leave.body.data._id}/decision`, { decision: 'approve' });
    expect(await parent.until((e) => e.type === 'notification.new')).toMatchObject({ category: 'leave' });
  });
});
