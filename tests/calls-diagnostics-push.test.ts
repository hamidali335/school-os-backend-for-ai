import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { callHub, callStarts, callTimers } from '../src/modules/calls/calls.hub';
import { CallSession } from '../src/modules/calls/calls.model';
import { attachCallSignaling, SIGNALING_PATH } from '../src/modules/calls/calls.socket';
import { PushDevice } from '../src/modules/push/push.model';
import type { Message } from 'firebase-admin/messaging';
import { setPushSenderForTests, type PushSender } from '../src/modules/push/push.service';
import { School } from '../src/modules/schools/school.model';
import { auth, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * Call media diagnostics (participants only, numbers only) and push for incoming calls when the
 * app is not connected. Push goes through a recording sender: nothing leaves the machine.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let server: http.Server;
let url: string;
const open: WebSocket[] = [];

type Sent = { token: string; message: Message & { token: string } };
class RecordingSender implements PushSender {
  readonly configured = true;
  sent: Sent[] = [];
  invalid = new Set<string>();
  async send(messages: Message[]) {
    return messages.map((m) => {
      const token = (m as { token: string }).token;
      if (this.invalid.has(token)) return 'invalid_token' as const;
      this.sent.push({ token, message: m as Sent['message'] });
      return 'accepted' as const;
    });
  }
  /** Call pushes only (missed-call notices are school notifications, tested elsewhere). */
  get calls() {
    return this.sent.filter((x) => x.message.data?.type?.startsWith('call.'));
  }
}

async function connect(token: string): Promise<{ id: string; events: Record<string, any>[] }> {
  const ws = new WebSocket(url);
  open.push(ws);
  const events: Record<string, any>[] = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'ready'); i++) await new Promise((r) => setTimeout(r, 20));
  return { id: events.find((e) => e.type === 'ready')!.connectionId, events };
}

const call = (token: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${path}`).set(auth(token)).send(body);

const stats = (over: object = {}) => ({
  moment: 'connected',
  client: 'mobile',
  iceState: 'connected',
  localCandidate: 'host',
  remoteCandidate: 'prflx',
  bytesSent: 9646,
  bytesReceived: 14317,
  packetsSent: 212,
  packetsReceived: 249,
  packetsLost: 0,
  roundTripMs: 115,
  audioLevelIn: 0.25,
  audioLevelOut: null,
  localTrack: 'live',
  ...over,
});

const TOKEN_A = 'fcm-device-token-parent-a-0000000001';
const TOKEN_B = 'fcm-device-token-other-school-000001';

async function grantCalls(schoolId: string) {
  await School.updateOne(
    { _id: schoolId },
    { $push: { 'subscription.featureOverrides': { feature: 'calls.voice', mode: 'grant' } } },
  );
}

/** The owner calls Parent A (student 0), with the owner's device connected. */
async function ownerCallsParent() {
  const admin = await connect(f.ownerToken);
  const res = await call(f.ownerToken, 'post', '/calls', {
    studentId: f.students[0],
    to: { type: 'parent' },
    connectionId: admin.id,
  });
  expect(res.status).toBe(201);
  return { admin, call: res.body.data.call };
}

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
  await grantCalls(f.schoolId);
  await grantCalls(other.schoolId);
  server = http.createServer(t.app);
  attachCallSignaling(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${SIGNALING_PATH}`;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.close();
  await CallSession.updateMany(
    { status: { $in: ['ringing', 'connecting', 'active'] } },
    { $set: { status: 'failed', endReason: 'test_cleanup', endedAt: new Date() } },
  ).setOptions({ crossTenant: true });
  await PushDevice.deleteMany({}).setOptions({ crossTenant: true });
  setPushSenderForTests(null);
  callTimers.clearAll();
  callStarts.reset();
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  callHub.closeAll(1001, 'done');
  await new Promise((r) => server.close(r));
});

describe('call diagnostics', () => {
  it('each participant records its side; only participants can read them', async () => {
    const pA = await connect(f.parentToken);
    const { call: c } = await ownerCallsParent();
    expect((await call(f.parentToken, 'post', `/calls/${c.callId}/accept`, { connectionId: pA.id })).status).toBe(200);

    expect((await call(f.parentToken, 'post', `/calls/${c.callId}/diagnostics`, stats())).status).toBe(204);
    expect(
      (await call(f.ownerToken, 'post', `/calls/${c.callId}/diagnostics`, stats({ client: 'web', audioLevelOut: 0.9 })))
        .status,
    ).toBe(204);

    const seen = await call(f.ownerToken, 'get', `/calls/${c.callId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.diagnostics.callee).toMatchObject({
      client: 'mobile',
      bytesReceived: 14317,
      localTrack: 'live',
    });
    expect(seen.body.data.diagnostics.caller).toMatchObject({ client: 'web', audioLevelOut: 0.9 });

    // Same school but not in the call; another school: as if the call did not exist.
    for (const token of [f.teacherToken, other.ownerToken]) {
      expect((await call(token, 'post', `/calls/${c.callId}/diagnostics`, stats())).status).toBe(404);
      expect((await call(token, 'get', `/calls/${c.callId}`)).status).toBe(404);
    }
  });

  it('only technical numbers are accepted, and not long after the call ended', async () => {
    const { call: c } = await ownerCallsParent();
    const bad = await call(f.ownerToken, 'post', `/calls/${c.callId}/diagnostics`, { ...stats(), transcript: 'hello' });
    expect(bad.status).toBe(400);
    expect(
      (await call(f.ownerToken, 'post', `/calls/${c.callId}/diagnostics`, stats({ audioLevelIn: 5 }))).status,
    ).toBe(400);

    await call(f.ownerToken, 'post', `/calls/${c.callId}/hangup`);
    expect(
      (await call(f.ownerToken, 'post', `/calls/${c.callId}/diagnostics`, stats({ moment: 'ended' }))).status,
    ).toBe(204);
    await CallSession.updateOne(
      { callId: c.callId },
      { $set: { endedAt: new Date(Date.now() - 11 * 60_000) } },
    ).setOptions({ crossTenant: true });
    const late = await call(f.ownerToken, 'post', `/calls/${c.callId}/diagnostics`, stats({ moment: 'ended' }));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CALL_ENDED');
  });
});

describe('push for incoming calls', () => {
  it('without push configured, a recipient with no connected app is unreachable', async () => {
    expect((await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_A })).body.data.pushConfigured).toBe(
      false,
    );
    const { call: c } = await ownerCallsParent();
    expect(c.status).toBe('unreachable');
  });

  it('a registered device rings by push when the app is not connected; the push holds no secrets', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    expect((await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_A })).body.data.pushConfigured).toBe(true);

    const { call: c } = await ownerCallsParent();
    expect(c.status).toBe('ringing');
    await new Promise((r) => setTimeout(r, 50));
    expect(sender.calls).toHaveLength(1);
    const { token, message } = sender.calls[0];
    expect(token).toBe(TOKEN_A);
    expect(message.data).toMatchObject({ type: 'call.incoming', callId: c.callId, ai: '0' });
    expect(message.data!.detail).toContain('Student0 Test');
    // Urgent and short-lived: high priority, worth delivering only while it rings.
    expect(message.android?.priority).toBe('high');
    expect(message.android?.ttl).toBeGreaterThan(0);
    expect(message.android?.ttl).toBeLessThanOrEqual(60_000);
    // Data only (the app shows its own call notification): no notification block, no session
    // tokens, user ids or connection ids.
    expect(message.android?.notification).toBeUndefined();
    expect(Object.keys(message.data!).sort()).toEqual(['ai', 'callId', 'caller', 'detail', 'expiresAt', 'type']);

    // Declining (as the notification's Decline does, through the server) ends it and tells the device.
    const dec = await call(f.parentToken, 'post', `/calls/${c.callId}/decline`);
    expect(dec.body.data.call.status).toBe('declined');
    await new Promise((r) => setTimeout(r, 50));
    expect(sender.calls.map((s) => s.message.data!.type)).toEqual(['call.incoming', 'call.ended']);
  });

  it('the push alone authorizes nothing: another user cannot answer or decline the call', async () => {
    setPushSenderForTests(new RecordingSender());
    await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_A });
    const { call: c } = await ownerCallsParent();
    const outsider = await connect(other.parentToken);
    expect((await call(other.parentToken, 'post', `/calls/${c.callId}/decline`)).status).toBe(404);
    expect(
      (await call(other.parentToken, 'post', `/calls/${c.callId}/accept`, { connectionId: outsider.id })).status,
    ).toBe(404);
    expect((await call(f.teacherToken, 'post', `/calls/${c.callId}/decline`)).status).toBe(404);
  });

  it('signing out removes the device; a token moves when another account signs in on the phone', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_A });
    expect((await call(f.parentToken, 'delete', '/devices/push', { token: TOKEN_A })).status).toBe(204);
    expect((await ownerCallsParent()).call.status).toBe('unreachable');

    await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_B });
    await call(other.parentToken, 'put', '/devices/push', { token: TOKEN_B });
    expect(await PushDevice.countDocuments({ token: TOKEN_B }).setOptions({ crossTenant: true })).toBe(1);
    expect((await ownerCallsParent()).call.status).toBe('unreachable');
    expect(sender.calls).toHaveLength(0);
  });

  it('a token the push service rejects is removed', async () => {
    const sender = new RecordingSender();
    sender.invalid.add(TOKEN_A);
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: TOKEN_A });
    expect((await ownerCallsParent()).call.status).toBe('ringing');
    await new Promise((r) => setTimeout(r, 100));
    expect(await PushDevice.countDocuments({ token: TOKEN_A }).setOptions({ crossTenant: true })).toBe(0);
  });
});
