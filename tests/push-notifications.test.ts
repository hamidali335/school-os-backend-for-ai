import type { Message } from 'firebase-admin/messaging';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { notifyUsers } from '../src/modules/communications/communications.service';
import { classify, FcmAdminSender, type MessagingLike } from '../src/modules/push/fcm-admin';
import { PushDevice } from '../src/modules/push/push.model';
import { channelFor, setPushSenderForTests, type PushSender } from '../src/modules/push/push.service';
import { User } from '../src/modules/users/user.model';
import { auth, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * Push for school notifications and the FCM sender (docs/PUSH_NOTIFICATIONS.md). FCM is replaced
 * by fakes: nothing is sent to Google or to a phone.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;

type Sent = Message & { token: string };
class RecordingSender implements PushSender {
  readonly configured = true;
  sent: Sent[] = [];
  async send(messages: Message[]) {
    this.sent.push(...(messages as Sent[]));
    return messages.map(() => 'accepted' as const);
  }
}

const call = (token: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${path}`).set(auth(token)).send(body);
const settle = () => new Promise((r) => setTimeout(r, 80));
const userIdOf = async (token: string) => String((await call(token, 'get', '/auth/me')).body.data.user._id);

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
});

afterEach(async () => {
  await PushDevice.deleteMany({}).setOptions({ crossTenant: true });
  setPushSenderForTests(null);
});

// ───────────────────────────── The sender ─────────────────────────────

function fakeMessaging(
  script: Array<(m: Message) => { success: boolean; error?: { code: string; message?: string } }>,
) {
  const calls: Array<{ count: number; dryRun?: boolean }> = [];
  const m: MessagingLike = {
    sendEach: vi.fn(async (messages: Message[], dryRun?: boolean) => {
      const step = script[Math.min(calls.length, script.length - 1)];
      calls.push({ count: messages.length, dryRun });
      return { responses: messages.map(step) };
    }),
  };
  return { m, calls };
}
const msg = (token: string): Message => ({ token, data: { type: 't' } });
const noSleep = vi.fn(async () => undefined);

describe('FCM sender', () => {
  it('accepted, invalid and failed tokens are told apart; invalid ones are never retried', async () => {
    const { m, calls } = fakeMessaging([
      (x) => {
        const tk = (x as Sent).token;
        if (tk === 'gone') return { success: false, error: { code: 'messaging/registration-token-not-registered' } };
        if (tk === 'bad')
          return {
            success: false,
            error: {
              code: 'messaging/invalid-argument',
              message: 'The registration token is not a valid FCM registration token',
            },
          };
        if (tk === 'payload')
          return { success: false, error: { code: 'messaging/invalid-argument', message: 'Invalid JSON payload' } };
        return { success: true };
      },
    ]);
    const s = new FcmAdminSender(m, { sleep: noSleep, dryRun: true });
    expect(await s.send(['ok', 'gone', 'bad', 'payload'].map(msg))).toEqual([
      'accepted',
      'invalid_token',
      'invalid_token',
      'failed',
    ]);
    expect(calls).toEqual([{ count: 4, dryRun: true }]);
    expect(s.stats).toMatchObject({ accepted: 1, invalidTokens: 2, failed: 1 });
    expect(s.stats.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('transient failures are retried with growing backoff, a bounded number of times', async () => {
    const unavailable = () => ({ success: false, error: { code: 'messaging/server-unavailable' } });
    const sleep = vi.fn(async () => undefined);
    const flaky = fakeMessaging([unavailable, () => ({ success: true })]);
    expect(await new FcmAdminSender(flaky.m, { sleep, backoffMs: 100 }).send([msg('a')])).toEqual(['accepted']);
    expect(flaky.calls).toHaveLength(2);

    sleep.mockClear();
    const down = fakeMessaging([unavailable]);
    const s = new FcmAdminSender(down.m, { sleep, backoffMs: 100, attempts: 3 });
    expect(await s.send([msg('a')])).toEqual(['failed']);
    expect(down.calls).toHaveLength(3);
    const waits = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(waits[0]).toBeGreaterThanOrEqual(100);
    expect(waits[1]).toBeGreaterThanOrEqual(200);
    expect(s.stats.lastErrorCode).toBe('messaging/server-unavailable');
  });

  it('permanent and credential errors are not retried; a credential error raises the alarm', async () => {
    const onConfigError = vi.fn();
    const perm = fakeMessaging([() => ({ success: false, error: { code: 'messaging/payload-size-limit-exceeded' } })]);
    expect(await new FcmAdminSender(perm.m, { sleep: noSleep }).send([msg('a')])).toEqual(['failed']);
    expect(perm.calls).toHaveLength(1);

    const auth = fakeMessaging([() => ({ success: false, error: { code: 'messaging/authentication-error' } })]);
    expect(await new FcmAdminSender(auth.m, { sleep: noSleep, onConfigError }).send([msg('a'), msg('b')])).toEqual([
      'failed',
      'failed',
    ]);
    expect(auth.calls).toHaveLength(1);
    expect(onConfigError).toHaveBeenCalledWith('messaging/authentication-error');

    // The whole request refused (for example a revoked key): no retry, nothing marked invalid.
    const thrown: MessagingLike = {
      sendEach: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { code: 'app/invalid-credential' }))),
    };
    expect(await new FcmAdminSender(thrown, { sleep: noSleep, onConfigError }).send([msg('a')])).toEqual(['failed']);
    expect(thrown.sendEach).toHaveBeenCalledTimes(1);
    // A network failure of the whole request is retried.
    const net: MessagingLike = {
      sendEach: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'app/network-error' }))
        .mockResolvedValue({ responses: [{ success: true }] }),
    };
    expect(await new FcmAdminSender(net, { sleep: noSleep }).send([msg('a')])).toEqual(['accepted']);
  });

  it('tokens from another Firebase project are removed only when this project demonstrably works', async () => {
    const onConfigError = vi.fn();
    const mismatch = { success: false, error: { code: 'messaging/mismatched-credential' } };
    const mixed = fakeMessaging([(x) => ((x as Sent).token === 'old' ? mismatch : { success: true })]);
    expect(await new FcmAdminSender(mixed.m, { sleep: noSleep, onConfigError }).send([msg('old'), msg('new')])).toEqual(
      ['invalid_token', 'accepted'],
    );
    expect(onConfigError).not.toHaveBeenCalled();
    // Every token refused that way: the server's project is wrong; keep the tokens, raise the alarm.
    const all = fakeMessaging([() => mismatch]);
    expect(await new FcmAdminSender(all.m, { sleep: noSleep, onConfigError }).send([msg('a'), msg('b')])).toEqual([
      'failed',
      'failed',
    ]);
    expect(onConfigError).toHaveBeenCalledWith('messaging/mismatched-credential');
  });

  it('more than 500 messages go in several requests', async () => {
    const { m, calls } = fakeMessaging([() => ({ success: true })]);
    const out = await new FcmAdminSender(m, { sleep: noSleep }).send(
      Array.from({ length: 1201 }, (_, i) => msg(`t${i}`)),
    );
    expect(out.every((o) => o === 'accepted')).toBe(true);
    expect(calls.map((c) => c.count)).toEqual([500, 500, 201]);
  });

  it('error codes are classified', () => {
    expect(classify('messaging/registration-token-not-registered')).toBe('invalid_token');
    expect(classify('messaging/internal-error')).toBe('transient');
    expect(classify('app/network-timeout')).toBe('transient');
    expect(classify('messaging/third-party-auth-error')).toBe('config');
    expect(classify('messaging/mismatched-credential')).toBe('other_project');
    expect(classify('messaging/invalid-argument', 'Invalid TTL')).toBe('permanent');
  });
});

// ───────────────────────────── School notifications ─────────────────────────────

describe('school notifications by push', () => {
  it('device registration needs only a signed-in school user (not the calls plan), and is validated', async () => {
    setPushSenderForTests(new RecordingSender());
    const ok = await call(f.accountantToken, 'put', '/devices/push', { token: 'accountant-device-token-0001' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.pushConfigured).toBe(true);
    expect((await call(f.parentToken, 'put', '/devices/push', { token: 'short' })).status).toBe(400);
    expect(
      (
        await call(f.parentToken, 'put', '/devices/push', {
          token: 'parent-device-token-000001',
          installationId: '../x',
        })
      ).status,
    ).toBe(400);
    expect((await request(t.app).put('/api/v1/devices/push').send({ token: 'no-session-token-00001' })).status).toBe(
      401,
    );
  });

  it('a refreshed token from the same installation replaces the old one; several devices per user', async () => {
    setPushSenderForTests(new RecordingSender());
    const inst = '3f9c2a10-1111-4b7e-9c2d-aaaaaaaaaaaa';
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-old-001', installationId: inst });
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-new-002', installationId: inst });
    await call(f.parentToken, 'put', '/devices/push', {
      token: 'parent-tablet-token-0003',
      installationId: '7a7a7a7a-2222-4b7e-9c2d-bbbbbbbbbbbb',
    });
    const rows = await PushDevice.find({}).setOptions({ crossTenant: true }).lean();
    expect(rows.map((r) => r.token).sort()).toEqual(['parent-phone-token-new-002', 'parent-tablet-token-0003']);
  });

  it('a teacher’s message: the parent’s devices get one normal-priority notification; nobody else gets anything', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-000001' });
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-tablet-token-00002' });
    await call(f.otherTeacherToken, 'put', '/devices/push', { token: 'other-teacher-token-00003' });
    await call(other.parentToken, 'put', '/devices/push', { token: 'other-school-parent-00004' });

    const res = await call(f.teacherToken, 'post', '/messages/conversations', {
      studentId: f.students[0],
      body: 'Ali did very well in the maths test today.',
      clientMessageId: 'push-message-000001',
    });
    expect(res.status).toBe(201);
    await settle();
    expect(sender.sent.map((m) => m.token).sort()).toEqual(['parent-phone-token-000001', 'parent-tablet-token-00002']);
    const m = sender.sent[0];
    expect(m.android?.priority).toBe('normal');
    expect(m.android?.notification).toMatchObject({ channelId: 'school_updates', visibility: 'private' });
    expect(m.data).toMatchObject({ type: 'notification', category: 'message' });
    // The same notification on two devices carries the same tag: a repeat replaces, never doubles.
    expect(new Set(sender.sent.map((x) => x.android?.notification?.tag)).size).toBe(1);
    expect(m.android?.notification?.tag).toBe(m.data?.notificationId);
    // Nothing that identifies other people or sessions.
    expect(Object.keys(m.data!).sort()).toEqual(expect.arrayContaining(['category', 'notificationId', 'type']));
    expect(JSON.stringify(m)).not.toMatch(/Bearer|accessToken|refreshToken|password/i);

    // A retried send (same clientMessageId) is saved and notified once: no second push.
    sender.sent.length = 0;
    const again = await call(f.teacherToken, 'post', '/messages/conversations', {
      studentId: f.students[0],
      body: 'Ali did very well in the maths test today.',
      clientMessageId: 'push-message-000001',
    });
    expect(again.status).toBeLessThan(300);
    await settle();
    expect(sender.sent).toEqual([]);
  });

  it('a leave decision reaches the parent by push', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-000001' });
    const day = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const leave = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: day,
      to: day,
      reason: 'Family wedding',
    });
    expect(leave.status).toBe(201);
    sender.sent.length = 0;
    await call(f.principalToken, 'post', `/leave-requests/${leave.body.data._id}/decision`, { decision: 'approve' });
    await settle();
    expect(sender.sent.map((m) => [m.token, m.data?.category])).toEqual([['parent-phone-token-000001', 'leave']]);
  });

  it('every category goes through the same path; missed calls get their own channel', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-000001' });
    const parent = await userIdOf(f.parentToken);
    const ctx = { kind: 'system', schoolId: f.schoolId } as never;
    const cats = [
      'attendance',
      'fees',
      'homework',
      'announcement',
      'message',
      'leave',
      'results',
      'approval',
      'general',
      'call',
    ];
    for (const category of cats)
      await notifyUsers(ctx, [parent], { title: `T ${category}`, body: 'B', category, link: '/x' });
    await settle();
    // Pushes are sent in the background, so they may finish in any order.
    const got = sender.sent.map((m) => [m.data?.category, m.android?.notification?.channelId]).sort();
    expect(got).toEqual(cats.map((c) => [c, channelFor(c)]).sort());
    expect(channelFor('call')).toBe('missed_calls');
    expect(sender.sent.every((m) => m.android?.priority === 'normal')).toBe(true);
  });

  it('a user in another school never gets this school’s notification, even with a forged user id', async () => {
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(other.parentToken, 'put', '/devices/push', { token: 'other-school-parent-00004' });
    const outsider = await User.findOne({ schoolId: other.schoolId, role: 'parent' })
      .setOptions({ crossTenant: true })
      .lean();
    await notifyUsers({ kind: 'system', schoolId: f.schoolId } as never, [String(outsider!._id)], {
      title: 'Fees',
      body: 'Rs 5000 due',
    });
    await settle();
    expect(sender.sent).toEqual([]);
  });

  it('minimal content mode keeps details in the app; push never breaks the action that caused it', async () => {
    const { env } = await import('../src/config/env');
    const sender = new RecordingSender();
    setPushSenderForTests(sender);
    await call(f.parentToken, 'put', '/devices/push', { token: 'parent-phone-token-000001' });
    const parent = await userIdOf(f.parentToken);
    const prev = env.PUSH_NOTIFICATION_CONTENT;
    (env as { PUSH_NOTIFICATION_CONTENT: string }).PUSH_NOTIFICATION_CONTENT = 'minimal';
    try {
      await notifyUsers({ kind: 'system', schoolId: f.schoolId } as never, [parent], {
        title: 'Fees overdue for Ali',
        body: 'Rs 23,000 is overdue',
        category: 'fees',
      });
      await settle();
      expect(sender.sent[0].android?.notification).toMatchObject({
        title: 'Fees update',
        body: 'Open School OS to see it.',
      });
      expect(JSON.stringify(sender.sent[0])).not.toMatch(/23,000|Ali/);
    } finally {
      (env as { PUSH_NOTIFICATION_CONTENT: string }).PUSH_NOTIFICATION_CONTENT = prev;
    }
    // FCM down: the notification is still created and the call returns normally.
    setPushSenderForTests({ configured: true, send: async () => Promise.reject(new Error('FCM down')) });
    await expect(
      notifyUsers({ kind: 'system', schoolId: f.schoolId } as never, [parent], { title: 'Still saved', body: 'x' }),
    ).resolves.toBe(1);
  });

  it('tokens FCM reports as invalid are removed from that school only', async () => {
    setPushSenderForTests({
      configured: true,
      send: async (ms) =>
        ms.map((m) => ((m as Sent).token.startsWith('dead') ? ('invalid_token' as const) : ('accepted' as const))),
    });
    await call(f.parentToken, 'put', '/devices/push', { token: 'dead-parent-token-000001' });
    await call(f.parentToken, 'put', '/devices/push', { token: 'live-parent-token-000002' });
    await notifyUsers({ kind: 'system', schoolId: f.schoolId } as never, [await userIdOf(f.parentToken)], {
      title: 'x',
      body: 'y',
    });
    await settle();
    const left = await PushDevice.find({}).setOptions({ crossTenant: true }).lean();
    expect(left.map((d) => d.token)).toEqual(['live-parent-token-000002']);
  });
});
