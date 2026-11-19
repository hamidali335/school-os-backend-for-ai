import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AuditLog } from '../src/modules/audit/audit.model';
import { callHub, callStarts, callTimers } from '../src/modules/calls/calls.hub';
import { iceServersFor } from '../src/modules/calls/calls.ice';
import { CallSession } from '../src/modules/calls/calls.model';
import { callEvents, sweepCalls, type CallFinishedEvent } from '../src/modules/calls/calls.service';
import { attachCallSignaling, SIGNALING_PATH } from '../src/modules/calls/calls.socket';
import { Notification } from '../src/modules/communications/communications.models';
import { School } from '../src/modules/schools/school.model';
import { User } from '../src/modules/users/user.model';
import { activateAndLogin, auth, PASSWORD, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * App voice calls: authenticated signaling, exact recipient routing, tenant isolation,
 * lifecycle, concurrency and the relay of WebRTC messages between the two bound devices only.
 * Real HTTP server + WebSocket clients; no audio (that needs two devices, see docs/VOICE_CALLS.md).
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let parent1: string; // parent of Student1 (section A)
let parent2: string; // parent of Student2 (section B)
let server: http.Server;
let url: string;

type Event = Record<string, any>;
interface Sock {
  ws: WebSocket;
  id: string;
  events: Event[];
  waitFor(type: string, pred?: (e: Event) => boolean, ms?: number): Promise<Event>;
  none(type: string, ms?: number, pred?: (e: Event) => boolean): Promise<void>;
  send(msg: unknown): void;
  close(): Promise<void>;
}
const open: Sock[] = [];

function socket(): { ws: WebSocket; events: Event[]; waiters: Array<() => void> } {
  const ws = new WebSocket(url);
  const events: Event[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    events.push(JSON.parse(raw.toString()));
    for (const w of waiters.splice(0)) w();
  });
  return { ws, events, waiters };
}

function wrap(s: ReturnType<typeof socket>, id: string): Sock {
  const sock: Sock = {
    ws: s.ws,
    id,
    events: s.events,
    waitFor: (type, pred = () => true, ms = 3000) =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        const check = () => {
          const i = s.events.findIndex((e) => e.type === type && pred(e));
          if (i >= 0) {
            clearTimeout(deadline);
            resolve(s.events.splice(i, 1)[0]);
          } else s.waiters.push(check);
        };
        check();
      }),
    none: async (type, ms = 300, pred = () => true) => {
      await new Promise((r) => setTimeout(r, ms));
      expect(s.events.filter((e) => e.type === type && pred(e))).toEqual([]);
    },
    send: (msg) => s.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    close: () =>
      new Promise((resolve) => {
        if (s.ws.readyState === WebSocket.CLOSED) return resolve();
        s.ws.once('close', () => resolve());
        s.ws.close();
      }),
  };
  open.push(sock);
  return sock;
}

/** Connect and authenticate; resolves with the ready connection. */
async function connect(token: string, client?: string): Promise<Sock> {
  const s = socket();
  await new Promise((r, j) => {
    s.ws.once('open', r);
    s.ws.once('error', j);
  });
  s.ws.send(JSON.stringify({ type: 'auth', token, ...(client ? { client } : {}) }));
  const sock = wrap(s, '');
  const ready = await sock.waitFor('ready');
  sock.id = ready.connectionId;
  return sock;
}

/** Connect and expect authentication to be refused; resolves with the error and close code. */
async function refused(token: string, client?: string): Promise<{ code: string; close: number }> {
  const s = socket();
  await new Promise((r) => s.ws.once('open', r));
  const closed = new Promise<number>((r) => s.ws.once('close', (c) => r(c)));
  s.ws.send(JSON.stringify({ type: 'auth', token, ...(client ? { client } : {}) }));
  const close = await closed;
  return { code: s.events.find((e) => e.type === 'error')?.code, close };
}

const call = (token: string, method: 'get' | 'post', path: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${path}`).set(auth(token)).send(body);

const start = (token: string, sock: Sock, studentId: string, to: object) =>
  call(token, 'post', '/calls', { studentId, to, connectionId: sock.id });

async function grantCalls(schoolId: string) {
  await School.updateOne(
    { _id: schoolId },
    { $push: { 'subscription.featureOverrides': { feature: 'calls.voice', mode: 'grant' } } },
  );
}

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 4 }); // 0,1 in section A (teacherToken = class teacher); 2,3 in B
  other = await buildSchool(t.app, { students: 1 });
  await grantCalls(f.schoolId);
  await grantCalls(other.schoolId);
  const acc = (i: number) => f.admissionAccounts[i].find((a: { role: string }) => a.role === 'parent');
  parent1 = await activateAndLogin(t.app, acc(1), PASSWORD, f.code);
  parent2 = await activateAndLogin(t.app, acc(2), PASSWORD, f.code);
  server = http.createServer(t.app);
  attachCallSignaling(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SIGNALING_PATH}`;
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  // Every test starts with no live call and fresh counters.
  await CallSession.updateMany(
    { status: { $in: ['ringing', 'connecting', 'active'] } },
    { $set: { status: 'failed', endReason: 'test_cleanup', endedAt: new Date() } },
  ).setOptions({ crossTenant: true });
  callTimers.clearAll();
  callStarts.reset();
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  callHub.closeAll(1001, 'done');
  await new Promise((r) => server.close(r));
});

describe('signaling authentication', () => {
  it('a valid session gets a connection id; garbage tokens are refused', async () => {
    const s = await connect(f.parentToken);
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const bad = await refused('not.a.valid.token');
    expect(bad.close).toBeGreaterThanOrEqual(4401);
  });

  it('roles without calls and schools without the plan feature are refused', async () => {
    expect((await refused(f.accountantToken)).code).toBe('FORBIDDEN');
    await School.updateOne(
      { _id: f.schoolId },
      { $set: { 'subscription.featureOverrides.$[o].mode': 'revoke' } },
      { arrayFilters: [{ 'o.feature': 'calls.voice' }] },
    );
    try {
      expect((await refused(f.parentToken)).code).toBe('FEATURE_NOT_IN_PLAN');
      const res = await call(f.ownerToken, 'get', '/calls/ice-servers');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    } finally {
      await School.updateOne(
        { _id: f.schoolId },
        { $set: { 'subscription.featureOverrides.$[o].mode': 'grant' } },
        { arrayFilters: [{ 'o.feature': 'calls.voice' }] },
      );
    }
  });

  it('the mobile policy applies to the socket: staff other than teachers are refused as mobile', async () => {
    expect((await refused(f.ownerToken, 'mobile')).code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    expect((await refused(f.adminToken, 'mobile')).code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    // The same account on the website (no client value) is fine.
    expect((await connect(f.ownerToken)).id).toBeTruthy();
  });

  it('messages are validated: unknown types, oversize SDP and bad call ids are rejected', async () => {
    const s = await connect(f.parentToken);
    s.send({ type: 'shout', text: 'hi' });
    expect((await s.waitFor('error')).code).toBe('BAD_MESSAGE');
    s.send({ type: 'signal', callId: 'x'.repeat(32), signal: { kind: 'offer', sdp: 'v'.repeat(25_000) } });
    expect((await s.waitFor('error')).code).toBe('BAD_MESSAGE');
    s.send({ type: 'signal', callId: '../../etc', signal: { kind: 'answer', sdp: 'v=0' } });
    expect((await s.waitFor('error')).code).toBe('BAD_MESSAGE');
    s.send({ type: 'signal', callId: 'a'.repeat(32), signal: { kind: 'answer', sdp: 'v=0', extra: 1 } });
    expect((await s.waitFor('error')).code).toBe('BAD_MESSAGE');
    s.send('{not json');
    expect((await s.waitFor('error')).code).toBe('BAD_MESSAGE');
  });

  it('too many invalid messages close the connection', async () => {
    const s = await connect(f.parentToken);
    const closed = new Promise<number>((r) => s.ws.once('close', (c) => r(c)));
    for (let i = 0; i < 12; i++) s.send('nope');
    expect(await closed).toBe(4400);
  });

  it('a connection cannot switch to another user', async () => {
    const s = await connect(f.parentToken);
    const closed = new Promise<number>((r) => s.ws.once('close', (c) => r(c)));
    s.send({ type: 'auth', token: f.teacherToken });
    expect(await closed).toBe(4403);
  });
});

describe('exact recipient routing', () => {
  it('an administrator calls Parent A: only Parent A rings, and only the two bound devices exchange signals', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const pA2 = await connect(f.parentToken); // Parent A's second device
    const p1 = await connect(parent1);
    const teacher = await connect(f.teacherToken);
    const outsider = await connect(other.parentToken);

    const res = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    expect(res.status).toBe(201);
    expect(res.body.data.call).toMatchObject({ status: 'ringing', direction: 'outgoing', peerRole: 'Parent' });
    const callId = res.body.data.call.callId;
    expect(callId).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const ring = await pA.waitFor('call.incoming');
    expect(ring.call).toMatchObject({ callId, direction: 'incoming', peerRole: 'Admin', studentName: 'Student0 Test' });
    expect(ring.schoolName).toBeTruthy();
    // No ids of people or connections in the payload.
    const payload = JSON.stringify(ring);
    const ownerUser = await User.findOne({ schoolId: f.schoolId, role: 'school_owner' }).lean();
    for (const secret of [admin.id, pA.id, String(ownerUser!._id)]) expect(payload).not.toContain(secret);
    await pA2.waitFor('call.incoming');
    for (const s of [p1, teacher, outsider]) await s.none('call.incoming', 100);

    const acc = await call(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: pA.id });
    expect(acc.status).toBe(200);
    const upd = await admin.waitFor('call.updated', (e) => e.call.status === 'connecting');
    expect(upd.onThisDevice).toBe(true);
    // The second device stops ringing and is not bound to the call.
    expect((await pA2.waitFor('call.updated')).onThisDevice).toBe(false);

    admin.send({ type: 'signal', callId, signal: { kind: 'offer', sdp: 'v=0 offer' } });
    expect((await pA.waitFor('signal')).signal).toEqual({ kind: 'offer', sdp: 'v=0 offer' });
    pA.send({ type: 'signal', callId, signal: { kind: 'answer', sdp: 'v=0 answer' } });
    expect((await admin.waitFor('signal')).signal.sdp).toBe('v=0 answer');
    await pA2.none('signal', 100);

    // Not bound to the call: the parent's other device, an unrelated user, another school.
    for (const s of [pA2, p1, outsider]) {
      s.send({
        type: 'signal',
        callId,
        signal: { kind: 'candidate', candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host' },
      });
      expect((await s.waitFor('error')).code).toBe('NOT_IN_CALL');
    }
    await admin.none('signal', 150);
    await pA.none('signal', 50);

    expect((await call(f.parentToken, 'post', `/calls/${callId}/connected`)).body.data.call.status).toBe('active');
    const end = await call(f.ownerToken, 'post', `/calls/${callId}/hangup`);
    expect(end.body.data.call.status).toBe('completed');
    expect((await pA.waitFor('call.updated', (e) => e.call.status === 'completed')).call.outcome).toBe('completed');
  });

  it('Parent A calls the school office: every free office account rings, the first to answer takes it', async () => {
    const pA = await connect(f.parentToken);
    const owner = await connect(f.ownerToken);
    const principal = await connect(f.principalToken);
    const office = await connect(f.adminToken);
    const teacher = await connect(f.teacherToken);
    const outsider = await connect(other.ownerToken);

    const res = await start(f.parentToken, pA, f.students[0], { type: 'office' });
    expect(res.body.data.call).toMatchObject({ status: 'ringing', kind: 'office', peerName: 'School office' });
    const callId = res.body.data.call.callId;
    for (const s of [owner, principal, office]) await s.waitFor('call.incoming');
    await teacher.none('call.incoming', 100);
    await outsider.none('call.incoming', 50);

    // Two office members answer at the same moment: exactly one wins.
    const [a, b] = await Promise.all([
      call(f.adminToken, 'post', `/calls/${callId}/accept`, { connectionId: office.id }),
      call(f.principalToken, 'post', `/calls/${callId}/accept`, { connectionId: principal.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('CALL_NOT_RINGING');
    const winner = a.status === 200 ? a : b;
    expect(winner.body.data.call.peerName).not.toBe('School office');
    expect((await owner.waitFor('call.updated')).call.outcome).toBe('answered_elsewhere');
    const forParent = await call(f.parentToken, 'get', `/calls/${callId}`);
    expect(forParent.body.data.call.peerRole).toMatch(/School office/);
  });

  it('Parent A calls their child’s class teacher; not a teacher who does not teach the child', async () => {
    const pA = await connect(f.parentToken);
    const teacher = await connect(f.teacherToken);
    const otherTeacher = await connect(f.otherTeacherToken);
    const contacts = await call(f.parentToken, 'get', '/messages/contacts');
    const kid = contacts.body.data.students.find((s: { studentId: string }) => s.studentId === f.students[0]);
    const classTeacher = kid.teachers[0];
    expect(kid.office.length).toBeGreaterThanOrEqual(3);

    const res = await start(f.parentToken, pA, f.students[0], { type: 'staff', userId: classTeacher.userId });
    expect(res.body.data.call.status).toBe('ringing');
    await teacher.waitFor('call.incoming');
    await otherTeacher.none('call.incoming', 100);
    await call(f.parentToken, 'post', `/calls/${res.body.data.call.callId}/hangup`);

    const otherUser = await User.findOne({
      schoolId: f.schoolId,
      role: 'teacher',
      _id: { $ne: classTeacher.userId },
    }).lean();
    const no = await start(f.parentToken, pA, f.students[0], { type: 'staff', userId: String(otherUser!._id) });
    expect(no.status).toBe(403);
    // Another family's child looks like a student that does not exist.
    expect((await start(f.parentToken, pA, f.students[2], { type: 'office' })).status).toBe(404);
  });

  it('a teacher calls parents of students they teach only', async () => {
    const tc = await connect(f.teacherToken);
    const p1 = await connect(parent1);
    const ok = await start(f.teacherToken, tc, f.students[1], { type: 'parent' });
    expect(ok.body.data.call.status).toBe('ringing');
    await p1.waitFor('call.incoming');
    await call(f.teacherToken, 'post', `/calls/${ok.body.data.call.callId}/hangup`);
    expect((await start(f.teacherToken, tc, f.students[2], { type: 'parent' })).status).toBe(403);
    // A parent cannot pose as staff, and staff cannot use parent targets.
    expect((await start(f.teacherToken, tc, f.students[1], { type: 'office' })).status).toBe(400);
  });

  it('School B never receives or joins School A calls', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const bAdmin = await connect(other.ownerToken);
    const bParent = await connect(other.parentToken);
    const res = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    const callId = res.body.data.call.callId;
    await pA.waitFor('call.incoming');
    await bParent.none('call.incoming', 100);
    for (const [tok, sock] of [
      [other.parentToken, bParent],
      [other.ownerToken, bAdmin],
    ] as const) {
      expect((await call(tok, 'post', `/calls/${callId}/accept`, { connectionId: sock.id })).status).toBe(404);
      expect((await call(tok, 'get', `/calls/${callId}`)).status).toBe(404);
      expect((await call(tok, 'post', `/calls/${callId}/hangup`)).status).toBe(404);
    }
    // School A ids sent to School B's API are not found either.
    expect((await start(other.ownerToken, bAdmin, f.students[0], { type: 'parent' })).status).toBe(404);
    // Someone else's connection id cannot be used.
    const stolen = await call(other.ownerToken, 'post', '/calls', {
      studentId: other.students[0],
      to: { type: 'parent' },
      connectionId: admin.id,
    });
    expect(stolen.body.error.code).toBe('SIGNALING_NOT_CONNECTED');
    expect(
      (await call(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: admin.id })).body.error.code,
    ).toBe('SIGNALING_NOT_CONNECTED');
    expect((await call(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: pA.id })).status).toBe(200);
  });
});

describe('lifecycle', () => {
  it('decline, cancel and no answer record the right outcome for each side, with missed-call notices', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const declined = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    await pA.waitFor('call.incoming');
    const d = await call(f.parentToken, 'post', `/calls/${declined.body.data.call.callId}/decline`);
    expect(d.body.data.call).toMatchObject({ status: 'declined', outcome: 'declined' });
    expect((await admin.waitFor('call.updated')).call.outcome).toBe('declined');

    const cancelled = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    await pA.waitFor('call.incoming');
    const c = await call(f.ownerToken, 'post', `/calls/${cancelled.body.data.call.callId}/hangup`);
    expect(c.body.data.call.status).toBe('cancelled');
    const cancelledId = cancelled.body.data.call.callId;
    expect((await pA.waitFor('call.updated', (e) => e.call.callId === cancelledId)).call.outcome).toBe('missed');

    const unanswered = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    await pA.waitFor('call.incoming');
    await sweepCalls(new Date(Date.now() + 120_000));
    const after = await call(f.ownerToken, 'get', `/calls/${unanswered.body.data.call.callId}`);
    expect(after.body.data.call).toMatchObject({ status: 'missed', outcome: 'missed', endReason: 'no_answer' });
    // Answering after it stopped ringing is refused.
    const late = await call(f.parentToken, 'post', `/calls/${unanswered.body.data.call.callId}/accept`, {
      connectionId: pA.id,
    });
    expect(late.body.error.code).toBe('CALL_NOT_RINGING');
    const parentUser = await User.findOne({ schoolId: f.schoolId, parentId: f.parentIds[0] }).lean();
    expect(
      await Notification.countDocuments({ schoolId: f.schoolId, userId: parentUser!._id, category: 'call' }),
    ).toBeGreaterThanOrEqual(2);
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'call.started' })).toBeTruthy();
  });

  it('nobody connected: unreachable at once, with a missed-call notice', async () => {
    const tc = await connect(f.teacherToken);
    const res = await start(f.teacherToken, tc, f.students[1], { type: 'parent' });
    expect(res.body.data.call).toMatchObject({ status: 'unreachable', outcome: 'unreachable' });
  });

  it('the relationship is checked again on answer: a caller disabled while ringing cannot be answered', async () => {
    const tc = await connect(f.teacherToken);
    const p1 = await connect(parent1);
    const res = await start(f.teacherToken, tc, f.students[1], { type: 'parent' });
    await p1.waitFor('call.incoming');
    const teacherUser = await User.findOne({ schoolId: f.schoolId, employeeId: f.teacherEmployeeId }).lean();
    await User.updateOne({ _id: teacherUser!._id, schoolId: f.schoolId }, { $set: { status: 'suspended' } });
    try {
      const acc = await call(parent1, 'post', `/calls/${res.body.data.call.callId}/accept`, { connectionId: p1.id });
      expect(acc.status).toBe(403);
      const doc = await CallSession.findOne({ schoolId: f.schoolId, callId: res.body.data.call.callId }).lean();
      expect(doc).toMatchObject({ status: 'failed', endReason: 'not_authorized' });
    } finally {
      await User.updateOne({ _id: teacherUser!._id, schoolId: f.schoolId }, { $set: { status: 'active' } });
    }
  });

  it('a dropped connection can rejoin and the other side is told; signals then reach the new connection', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const res = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    const callId = res.body.data.call.callId;
    await pA.waitFor('call.incoming');
    await call(f.parentToken, 'post', `/calls/${callId}/accept`, { connectionId: pA.id });
    await call(f.parentToken, 'post', `/calls/${callId}/connected`);
    await admin.close();
    await pA.waitFor('call.peer_disconnected');
    const again = await connect(f.ownerToken);
    // Rejoining someone else's call, or with someone else's connection, does not work.
    expect((await call(parent1, 'post', `/calls/${callId}/rejoin`, { connectionId: again.id })).body.error.code).toBe(
      'SIGNALING_NOT_CONNECTED',
    );
    const rj = await call(f.ownerToken, 'post', `/calls/${callId}/rejoin`, { connectionId: again.id });
    expect(rj.status).toBe(200);
    expect(rj.body.data.iceServers).toBeDefined();
    await pA.waitFor('call.peer_rejoined');
    pA.send({ type: 'signal', callId, signal: { kind: 'answer', sdp: 'restart answer' } });
    expect((await again.waitFor('signal')).signal.sdp).toBe('restart answer');
  });

  it('history: each person sees their own calls, filtered by conversation; nobody else can open them', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const res = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    await pA.waitFor('call.incoming');
    await call(f.ownerToken, 'post', `/calls/${res.body.data.call.callId}/hangup`);
    const mine = await call(f.parentToken, 'get', '/calls?limit=50');
    const entry = mine.body.data.find((c: { callId: string }) => c.callId === res.body.data.call.callId);
    expect(entry).toMatchObject({ direction: 'incoming', outcome: 'missed', callBack: { type: 'staff' } });
    expect((await call(parent1, 'get', `/calls/${res.body.data.call.callId}`)).status).toBe(404);
    expect(
      (await call(parent1, 'get', '/calls?limit=50')).body.data.some(
        (c: { callId: string }) => c.callId === res.body.data.call.callId,
      ),
    ).toBe(false);
    expect((await call(f.accountantToken, 'get', '/calls')).status).toBe(403);
  });
});

describe('concurrency', () => {
  it('a recipient in a call is busy for others; unrelated calls in the same and another school go ahead', async () => {
    const admin = await connect(f.ownerToken);
    const pA = await connect(f.parentToken);
    const tc = await connect(f.teacherToken);
    const p1 = await connect(parent1);
    const bAdmin = await connect(other.ownerToken);
    const bParent = await connect(other.parentToken);

    const first = await start(f.ownerToken, admin, f.students[0], { type: 'parent' });
    await pA.waitFor('call.incoming');
    await call(f.parentToken, 'post', `/calls/${first.body.data.call.callId}/accept`, { connectionId: pA.id });

    // Parent A is busy for the teacher...
    const busy = await start(f.teacherToken, tc, f.students[0], { type: 'parent' });
    expect(busy.body.data.call.status).toBe('busy');
    // ...but the teacher can call Parent 1, and School B runs its own call, at the same time.
    const parallel = await start(f.teacherToken, tc, f.students[1], { type: 'parent' });
    expect(parallel.body.data.call.status).toBe('ringing');
    const school2 = await start(other.ownerToken, bAdmin, other.students[0], { type: 'parent' });
    expect(school2.body.data.call.status).toBe('ringing');
    await p1.waitFor('call.incoming');
    await bParent.waitFor('call.incoming');
    expect(
      (await call(parent1, 'post', `/calls/${parallel.body.data.call.callId}/accept`, { connectionId: p1.id })).status,
    ).toBe(200);
    expect(
      (
        await call(other.parentToken, 'post', `/calls/${school2.body.data.call.callId}/accept`, {
          connectionId: bParent.id,
        })
      ).status,
    ).toBe(200);

    // Ending one call leaves the others live.
    await call(f.ownerToken, 'post', `/calls/${first.body.data.call.callId}/hangup`);
    const states = await CallSession.find({
      callId: { $in: [parallel.body.data.call.callId, school2.body.data.call.callId] },
    })
      .setOptions({ crossTenant: true })
      .select('status')
      .lean();
    expect(states.map((s) => s.status)).toEqual(['connecting', 'connecting']);

    // A participant cannot start a second call.
    const second = await start(f.teacherToken, tc, f.students[0], { type: 'parent' });
    expect(second.body.error.code).toBe('ALREADY_IN_CALL');
  });

  it('two people calling the same parent at the same moment: exactly one rings, the other is busy', async () => {
    const owner = await connect(f.ownerToken);
    const principal = await connect(f.principalToken);
    const p2 = await connect(parent2);
    const [a, b] = await Promise.all([
      start(f.ownerToken, owner, f.students[2], { type: 'parent' }),
      start(f.principalToken, principal, f.students[2], { type: 'parent' }),
    ]);
    expect([a.body.data.call.status, b.body.data.call.status].sort()).toEqual(['busy', 'ringing']);
    await p2.waitFor('call.incoming');
    await p2.none('call.incoming', 150);
  });

  it('many independent calls at once in two schools', async () => {
    const pairs: Array<Promise<number>> = [];
    const runs = [
      { caller: f.ownerToken, callee: f.parentToken, student: f.students[0] },
      { caller: f.principalToken, callee: parent1, student: f.students[1] },
      { caller: f.adminToken, callee: parent2, student: f.students[2] },
      { caller: other.ownerToken, callee: other.parentToken, student: other.students[0] },
    ];
    for (const r of runs) {
      pairs.push(
        (async () => {
          const a = await connect(r.caller);
          const b = await connect(r.callee);
          const res = await start(r.caller, a, r.student, { type: 'parent' });
          const callId = res.body.data.call.callId;
          await b.waitFor('call.incoming', (e) => e.call.callId === callId);
          await call(r.callee, 'post', `/calls/${callId}/accept`, { connectionId: b.id });
          a.send({ type: 'signal', callId, signal: { kind: 'offer', sdp: `offer for ${callId}` } });
          const got = await b.waitFor('signal');
          expect(got.signal.sdp).toBe(`offer for ${callId}`);
          return (await call(r.caller, 'post', `/calls/${callId}/hangup`)).status;
        })(),
      );
    }
    expect(await Promise.all(pairs)).toEqual([200, 200, 200, 200]);
  });

  it('call starts are rate limited per user', async () => {
    const tc = await connect(f.teacherToken);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await start(f.teacherToken, tc, f.students[1], { type: 'parent' })).status);
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses[6]).toBe(429);
  });

  it('finished calls are published to in-process listeners (seam for later stages), metadata only', async () => {
    const seen: CallFinishedEvent[] = [];
    const fn = (e: CallFinishedEvent) => seen.push(e);
    callEvents.on('finished', fn);
    try {
      const tc = await connect(f.teacherToken);
      await start(f.teacherToken, tc, f.students[1], { type: 'parent' });
      expect(seen.at(-1)).toMatchObject({ schoolId: f.schoolId, status: 'unreachable', durationSec: 0 });
      expect(Object.keys(seen.at(-1)!).sort()).toEqual([
        'callId',
        'durationSec',
        'kind',
        'reason',
        'schoolId',
        'status',
      ]);
    } finally {
      callEvents.off('finished', fn);
    }
  });
});

describe('TURN credentials', () => {
  const base = {
    CALL_STUN_URLS: ['stun:turn.test:3478'],
    CALL_TURN_URLS: ['turn:turn.test:3478'],
    CALL_TURN_TTL_SECONDS: 600,
  };

  it('are short-lived coturn REST credentials derived from the server secret', () => {
    const secret = 's'.repeat(40);
    const now = Date.UTC(2026, 9, 25, 12);
    const r = iceServersFor({ schoolId: 'a', userId: 'b' }, { ...base, CALL_TURN_SECRET: secret }, now);
    const turn = r.iceServers.find((s) => s.username)!;
    const [expiry] = turn.username!.split(':');
    expect(Number(expiry)).toBe(now / 1000 + 600);
    expect(turn.credential).toBe(crypto.createHmac('sha1', secret).update(turn.username!).digest('base64'));
    expect(turn.username).not.toContain('b');
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.relayAvailable).toBe(true);
  });

  it('no secret: no TURN entry (STUN only)', () => {
    const r = iceServersFor({ schoolId: 'a', userId: 'b' }, { ...base, CALL_TURN_SECRET: undefined });
    expect(r.iceServers).toEqual([{ urls: ['stun:turn.test:3478'] }]);
    expect(r.relayAvailable).toBe(false);
  });
});

describe('plan, permissions and messaging relationships', () => {
  it('calls are in no default plan, not part of the core set, and lost when a subscription is ineligible', async () => {
    const { DEFAULT_PLAN_TEMPLATES } = await import('../src/modules/subscriptions/default-plans');
    const { CORE_FEATURES } = await import('../src/config/entitlements');
    const { computeEntitlements } = await import('../src/modules/subscriptions/entitlements.service');
    for (const tpl of DEFAULT_PLAN_TEMPLATES) expect(tpl.features).not.toContain('calls.voice');
    expect(CORE_FEATURES).not.toContain('calls.voice');
    const granted = { status: 'active', featureOverrides: [{ feature: 'calls.voice', mode: 'grant' }] };
    expect(computeEntitlements(granted, null).features.has('calls.voice')).toBe(true);
    expect(computeEntitlements({ ...granted, status: 'expired' }, null).features.has('calls.voice')).toBe(false);
  });

  it('only parents, teachers and leadership hold calls:use, and it cannot be put in a custom role', async () => {
    const { ROLE_PERMISSIONS, DELEGABLE_PERMISSIONS } = await import('../src/config/permissions');
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, p]) => p.has('calls:use'))
      .map(([r]) => r)
      .sort();
    expect(holders).toEqual(['parent', 'principal', 'school_admin', 'school_owner', 'teacher']);
    expect(DELEGABLE_PERMISSIONS).not.toContain('calls:use');
  });

  it('a parent can message the school office for their child, and conversations carry the call target', async () => {
    const contacts = await call(f.parentToken, 'get', '/messages/contacts');
    const kid = contacts.body.data.students.find((s: { studentId: string }) => s.studentId === f.students[0]);
    const officeMember = kid.office[0];
    const res = await call(f.parentToken, 'post', '/messages/conversations', {
      studentId: f.students[0],
      teacherUserId: officeMember.userId,
      body: 'Please call me about the bus route.',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.callTo).toEqual({ type: 'staff', userId: officeMember.userId });
    const staffView = await User.findOne({ _id: officeMember.userId, schoolId: f.schoolId }).lean();
    expect(['school_admin', 'principal', 'school_owner']).toContain(staffView!.role);
    // A random user id is still refused.
    const bad = await call(f.parentToken, 'post', '/messages/conversations', {
      studentId: f.students[0],
      teacherUserId: '6ade045727d8840a5c2e5185',
      body: 'Hello',
    });
    expect(bad.status).toBe(403);
  });
});
