import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { callHub, callStarts, callTimers } from '../src/modules/calls/calls.hub';
import { CallSession } from '../src/modules/calls/calls.model';
import { RING_ACK_MS } from '../src/modules/calls/calls.service';
import { attachCallSignaling, SIGNALING_PATH } from '../src/modules/calls/calls.socket';
import { School } from '../src/modules/schools/school.model';
import { auth, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * A frozen app (Android suspends background apps but their socket stays open) must not make the
 * caller see "Ringing" for the whole ring time: devices that promise acknowledgements and do not
 * give one are dropped, and a call nobody can receive ends as unreachable at once.
 */
const t = useTestApp();
let f: SchoolFixture;
let server: http.Server;
let url: string;
const sockets: WebSocket[] = [];

type Ev = Record<string, any>;
async function connect(token: string, opts: { acks?: boolean; autoAck?: boolean } = {}) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const events: Ev[] = [];
  let closedWith: number | null = null;
  ws.on('close', (code) => (closedWith = code));
  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    events.push(e);
    if (e.type === 'call.incoming' && opts.autoAck) ws.send(JSON.stringify({ type: 'ack', callId: e.call.callId }));
  });
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  ws.send(JSON.stringify({ type: 'auth', token, ...(opts.acks ? { acks: true } : {}) }));
  const end = Date.now() + 3000;
  while (!events.some((e) => e.type === 'ready') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  const ready = events.find((e) => e.type === 'ready');
  if (!ready) throw new Error(JSON.stringify(events));
  return { ws, events, id: ready.connectionId as string, closed: () => closedWith };
}

const startCall = (callerConn: string) =>
  request(t.app)
    .post('/api/v1/calls')
    .set(auth(f.teacherToken))
    .send({ studentId: f.students[0], to: { type: 'parent' }, connectionId: callerConn });
const statusOf = async (callId: string) => (await CallSession.findOne({ schoolId: f.schoolId, callId }).lean())!.status;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  await School.updateOne(
    { _id: f.schoolId },
    { $push: { 'subscription.featureOverrides': { feature: 'calls.voice', mode: 'grant' } } },
  );
  server = http.createServer(t.app);
  attachCallSignaling(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SIGNALING_PATH}`;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await CallSession.updateMany(
    { status: { $in: ['ringing', 'connecting', 'active'] } },
    { $set: { status: 'failed', endReason: 'test_cleanup', endedAt: new Date() } },
  ).setOptions({ crossTenant: true });
  callTimers.clearAll();
  callStarts.reset();
  await wait(50);
});

afterAll(async () => {
  callHub.reset();
  await new Promise((r) => server.close(r));
});

describe('ring acknowledgements', () => {
  it('a frozen phone (promised acks, never answers) is dropped and the call ends as unreachable', async () => {
    const teacher = await connect(f.teacherToken, { acks: true, autoAck: true });
    const parent = await connect(f.parentToken, { acks: true, autoAck: false });
    const res = await startCall(teacher.id);
    expect(res.status).toBe(201);
    const callId = res.body.data.call.callId;
    expect(await statusOf(callId)).toBe('ringing');
    await wait(RING_ACK_MS + 600);
    expect(parent.closed()).toBe(4408);
    expect(await statusOf(callId)).toBe('unreachable');
  }, 20_000);

  it('a phone that acknowledges keeps ringing', async () => {
    const teacher = await connect(f.teacherToken, { acks: true, autoAck: true });
    const parent = await connect(f.parentToken, { acks: true, autoAck: true });
    const res = await startCall(teacher.id);
    const callId = res.body.data.call.callId;
    await wait(RING_ACK_MS + 600);
    expect(parent.closed()).toBeNull();
    expect(await statusOf(callId)).toBe('ringing');
  }, 20_000);

  it('an older app that never promised acks is never cut off', async () => {
    const teacher = await connect(f.teacherToken, { acks: true, autoAck: true });
    const parent = await connect(f.parentToken);
    const res = await startCall(teacher.id);
    const callId = res.body.data.call.callId;
    await wait(RING_ACK_MS + 600);
    expect(parent.closed()).toBeNull();
    expect(await statusOf(callId)).toBe('ringing');
  }, 20_000);
});
