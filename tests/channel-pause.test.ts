import { FEATURE_KEYS } from '../src/config/entitlements';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setChannelFlagsForTests } from '../src/config/features';
import { setAiProviderForTests, type AiProvider } from '../src/modules/ai/provider';
import { ApprovalRequest } from '../src/modules/approvals/approval.model';
import { AutomationRule } from '../src/modules/automations/automation.models';
import { Announcement, MessageLog, Notification } from '../src/modules/communications/communications.models';
import { dispatchMessage, flushBackground } from '../src/modules/communications/communications.service';
import { School } from '../src/modules/schools/school.model';
import {
  emailAdapter,
  setAdapterForTests,
  smsAdapter,
  whatsappAdapter,
  type MessagingAdapter,
} from '../src/services/messaging/adapters';
import { todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createPlatformAdmin, useTestApp, assignPlan } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
const today = todayInTz('Asia/Karachi');
const sends: string[] = [];

/** A fully "configured" fake provider: proves the pause, not missing credentials, blocks sending. */
const fake = (base: MessagingAdapter): MessagingAdapter => ({
  ...base,
  isConfigured: () => true,
  send: async (m) => {
    sends.push(`${base.channel}:${m.to}`);
    return { providerMessageId: 'FAKE-1' };
  },
});

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 });
  setAdapterForTests('sms', fake(smsAdapter));
  // AI is a plan feature: these tests run on a plan that includes every feature.
  await assignPlan(s.schoolId, 'all_features', FEATURE_KEYS);
  setAdapterForTests('whatsapp', fake(whatsappAdapter));
  setAdapterForTests('email', fake(emailAdapter));
  await School.updateOne({ _id: s.schoolId }, { $set: { 'settings.approvals.bulkMessageThreshold': 1 } });
});
afterAll(() => {
  setAdapterForTests('sms', smsAdapter);
  setAdapterForTests('whatsapp', whatsappAdapter);
  setAdapterForTests('email', emailAdapter);
});
beforeEach(() => {
  sends.length = 0;
  setChannelFlagsForTests({}); // production defaults: all three paused
});
afterEach(async () => {
  await flushBackground();
  vi.restoreAllMocks();
  setChannelFlagsForTests({});
});

const noExternalTraffic = async () => {
  await flushBackground();
  expect(sends).toEqual([]);
  expect(await MessageLog.countDocuments({ schoolId: s.schoolId, status: 'sent' })).toBe(0);
};

describe('Default state: SMS, WhatsApp and email are paused', () => {
  it('reports every channel as coming soon to any signed-in user', async () => {
    for (const token of [s.principalToken, s.teacherToken, s.parentToken]) {
      const res = await request(t.app).get('/api/v1/communications/availability').set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.data.map((c: any) => [c.channel, c.status])).toEqual([
        ['sms', 'coming_soon'],
        ['whatsapp', 'coming_soon'],
        ['email', 'coming_soon'],
      ]);
    }
    const channels = await api(t.app, s.principalToken, 'get', '/communications/channels');
    expect(channels.channels.every((c: any) => c.enabled === false && c.status === 'coming_soon')).toBe(true);
  });

  it('rejects direct sends with 503 CHANNEL_PAUSED, logs nothing and contacts no provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const channel of ['sms', 'whatsapp', 'email']) {
      const to = channel === 'email' ? 'parent@example.com' : '+923001234567';
      const res = await request(t.app)
        .post('/api/v1/communications/messages')
        .set(auth(s.principalToken))
        .send({ channel, to, body: 'Hello' });
      expect(res.status, channel).toBe(503);
      expect(res.body.error.code).toBe('CHANNEL_PAUSED');
      expect(res.body.error.details.pausedChannels).toEqual([channel]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await MessageLog.countDocuments({ schoolId: s.schoolId })).toBe(0);
    await noExternalTraffic();
  });

  it('the delivery service itself refuses paused channels (defence in depth) and records it honestly', async () => {
    const log = await dispatchMessage(
      { kind: 'system', schoolId: s.schoolId, label: 'test' },
      { channel: 'whatsapp', to: '+923001234567', body: 'Hi' },
    );
    expect(log.status).toBe('paused');
    expect(log.costPkr).toBe(0);
    await noExternalTraffic();
    await MessageLog.deleteMany({ schoolId: s.schoolId });
  });
});

describe('Announcements', () => {
  it('cannot be created or edited to use a paused channel, but in-app announcements work', async () => {
    const bad = await request(t.app)
      .post('/api/v1/communications/announcements')
      .set(auth(s.principalToken))
      .send({ title: 'Exam week', body: 'Exams start Monday.', audience: { roles: ['parent'] }, channels: ['sms'] });
    expect(bad.status).toBe(503);
    expect(bad.body.error.code).toBe('CHANNEL_PAUSED');

    const ok = await api(t.app, s.principalToken, 'post', '/communications/announcements', {
      title: 'Exam week',
      body: 'Exams start Monday.',
      audience: { roles: ['parent'] },
    });
    const edit = await request(t.app)
      .patch(`/api/v1/communications/announcements/${ok._id}`)
      .set(auth(s.principalToken))
      .send({ channels: ['email'] });
    expect(edit.status).toBe(503);

    const pub = await api(t.app, s.principalToken, 'post', `/communications/announcements/${ok._id}/publish`);
    expect(pub.status).toBe('published');
    expect(pub.inApp).toBeGreaterThan(0);
    const notes = await api(t.app, s.parentToken, 'get', '/notifications');
    expect(notes.some((n: any) => n.title === 'Exam week')).toBe(true);
  });

  it('an older draft that includes SMS/WhatsApp still publishes in-app, skips the paused channels and says so', async () => {
    const draft = await Announcement.create({
      schoolId: s.schoolId,
      title: 'Holiday notice',
      body: 'School is closed on Friday.',
      audience: { roles: ['parent'] },
      channels: ['in_app', 'sms', 'whatsapp'],
      status: 'draft',
    });
    const pub = await api(t.app, s.principalToken, 'post', `/communications/announcements/${draft._id}/publish`);
    expect(pub).toMatchObject({ status: 'published', externalQueued: 0, pausedChannels: ['sms', 'whatsapp'] });
    expect(await ApprovalRequest.countDocuments({ schoolId: s.schoolId, entityId: draft._id.toString() })).toBe(0);
    const ann = await Announcement.findOne({ schoolId: s.schoolId, _id: draft._id }).lean();
    expect(ann!.channels).toEqual(['in_app', 'sms', 'whatsapp']); // preserved for later
    expect(ann!.delivery!.status).toBe('completed');
    await noExternalTraffic();
  });

  it('a send approved before the pause is not delivered when approved during the pause', async () => {
    setChannelFlagsForTests({ whatsapp: true });
    const ann = await api(t.app, s.principalToken, 'post', '/communications/announcements', {
      title: 'Fee due',
      body: 'Fees are due on the 10th.',
      audience: { roles: ['parent'] },
      channels: ['whatsapp'],
    });
    const pending = await api(t.app, s.principalToken, 'post', `/communications/announcements/${ann._id}/publish`);
    expect(pending.status).toBe('pending_approval');

    setChannelFlagsForTests({}); // paused again before anyone approves
    const decided = await api(t.app, s.ownerToken, 'post', `/approvals/${pending.approvalId}/decision`, {
      decision: 'approve',
    });
    expect(decided.status).toBe('executed');
    expect(decided.result).toMatchObject({ externalQueued: 0, pausedChannels: ['whatsapp'] });
    await noExternalTraffic();
  });
});

describe('Automations, reminders and batches', () => {
  it('rejects saving a rule with a paused channel; in-app-only rules are fine', async () => {
    const bad = await request(t.app)
      .post('/api/v1/automations')
      .set(auth(s.ownerToken))
      .send({ type: 'fee_reminder', schedule: { frequency: 'daily', hour: 9 }, config: { channels: ['sms'] } });
    expect(bad.status).toBe(503);
    expect(bad.body.error.code).toBe('CHANNEL_PAUSED');
    const ok = await request(t.app)
      .post('/api/v1/automations')
      .set(auth(s.ownerToken))
      .send({ type: 'admission_followup', schedule: { frequency: 'daily', hour: 9 } });
    expect(ok.status).toBe(201);
  });

  it('an existing attendance-alert rule with WhatsApp still notifies parents in-app and creates no external batch', async () => {
    await api(t.app, s.teacherToken, 'post', '/attendance/mark', {
      sectionId: s.sectionA,
      date: today,
      records: [
        { studentId: s.students[0], status: 'absent' },
        { studentId: s.students[1], status: 'present' },
      ],
    });
    const rule = await AutomationRule.create({
      schoolId: s.schoolId,
      type: 'attendance_alert',
      name: 'Absence alerts',
      schedule: { frequency: 'daily', hour: 11 },
      config: { channels: ['whatsapp'] },
      nextRunAt: new Date(Date.now() + 3600_000),
    });
    const run = await api(t.app, s.ownerToken, 'post', `/automations/${rule._id}/run`);
    expect(run.status).toBe('success');
    expect(run.result).toMatchObject({ inAppNotifications: 1, pausedChannels: ['whatsapp'] });
    expect(run.result.approvalId).toBeUndefined();
    expect(await ApprovalRequest.countDocuments({ schoolId: s.schoolId, type: 'message_batch' })).toBe(0);
    await noExternalTraffic();
  });

  it('fee reminders queued with SMS are delivered in-app only after the pause', async () => {
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', {
      period: '2026-07',
      dueDate: '2026-07-10',
    });
    setChannelFlagsForTests({ sms: true });
    const rule = await api(t.app, s.ownerToken, 'post', '/automations', {
      type: 'fee_reminder',
      schedule: { frequency: 'daily', hour: 9 },
      config: { channels: ['sms'], minDaysOverdue: 1 },
    });
    const run = await api(t.app, s.ownerToken, 'post', `/automations/${rule._id}/run`);
    const approval = await ApprovalRequest.findOne({ schoolId: s.schoolId, _id: run.result.approvalId }).lean();
    expect(approval!.payload.channels).toEqual(['sms']);

    setChannelFlagsForTests({});
    const decided = await api(t.app, s.ownerToken, 'post', `/approvals/${approval!._id}/decision`, {
      decision: 'approve',
    });
    expect(decided.status).toBe('executed');
    expect(decided.result).toMatchObject({ externalMessagesQueued: 0, pausedChannels: ['sms'] });
    expect(decided.result.inAppNotifications).toBeGreaterThan(0);
    await noExternalTraffic();
  });

  it('a queued message batch approved during the pause sends nothing', async () => {
    const approval = await ApprovalRequest.create({
      schoolId: s.schoolId,
      type: 'message_batch',
      title: 'Absence alerts via sms',
      source: 'automation',
      payload: { messages: [{ parentId: s.parentIds[0], channel: 'sms', to: '+923001234567', text: 'Absent today' }] },
    });
    const decided = await api(t.app, s.ownerToken, 'post', `/approvals/${approval._id}/decision`, {
      decision: 'approve',
    });
    expect(decided.status).toBe('executed');
    expect(decided.result).toMatchObject({ messagesQueued: 0, pausedChannels: ['sms'] });
    await noExternalTraffic();
  });
});

describe('AI drafting keeps working without paused channels', () => {
  it('saves an AI draft as in-app only when SMS is requested', async () => {
    const provider: AiProvider = {
      name: 'fake',
      model: 'fake',
      isConfigured: () => true,
      estimateCostUsd: () => 0,
      chat: async () => ({
        content: '{"title":"Sports day","body":"Sports day is on Friday."}',
        toolCalls: [],
        usage: null,
        model: 'fake',
      }),
    };
    setAiProviderForTests(provider);
    const draft = await api(t.app, s.principalToken, 'post', '/ai/draft-communication', {
      purpose: 'Tell parents about sports day on Friday',
      channel: 'sms',
      saveAsDraft: { roles: ['parent'], channels: ['sms'] },
    });
    const ann = await Announcement.findOne({ schoolId: s.schoolId, _id: draft.draftAnnouncementId }).lean();
    expect(ann!.channels).toEqual(['in_app']);
    setAiProviderForTests(null);
  });
});

describe('Core modules are unaffected', () => {
  it('students, attendance, fees, payments, exams and in-app notifications all work while messaging is paused', async () => {
    const st = await api(t.app, s.adminToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'Pause',
      lastName: 'Check',
      gender: 'female',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionB,
    });
    expect(st.admissionNo).toBeTruthy();
    const mark = await api(t.app, s.ownerToken, 'post', '/attendance/mark', {
      sectionId: s.sectionB,
      date: today,
      records: [{ studentId: st._id, status: 'absent' }],
      notifyParents: true,
    });
    expect(mark.saved).toBe(1);
    const gen = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-11' });
    const pay = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${gen.invoiceIds[0]}/payments`, {
      amount: 1000,
      method: 'cash',
    });
    expect(pay.payment.receiptNo).toBeTruthy();
    const exam = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Pause Check Test',
      classIds: [s.classId],
    });
    expect(exam._id).toBeTruthy();
    expect(await Notification.countDocuments({ schoolId: s.schoolId })).toBeGreaterThan(0);
    await noExternalTraffic();
  });
});

describe('Independent re-activation', () => {
  it('enabling SMS alone allows SMS while WhatsApp and email stay paused', async () => {
    setChannelFlagsForTests({ sms: true });
    const sms = await api(t.app, s.principalToken, 'post', '/communications/messages', {
      channel: 'sms',
      to: '+923001234567',
      body: 'Live test',
    });
    expect(sms.status).toBe('sent');
    expect(sends).toEqual(['sms:+923001234567']);
    for (const channel of ['whatsapp', 'email']) {
      const to = channel === 'email' ? 'a@example.com' : '+923001234567';
      const res = await request(t.app)
        .post('/api/v1/communications/messages')
        .set(auth(s.principalToken))
        .send({ channel, to, body: 'x' });
      expect(res.status, channel).toBe(503);
    }
    const avail = await api(t.app, s.parentToken, 'get', '/communications/availability');
    expect(avail.map((c: any) => c.enabled)).toEqual([true, false, false]);
    await MessageLog.deleteMany({ schoolId: s.schoolId });
  });

  it('the platform admin sees each channel as coming soon', async () => {
    const admin = await createPlatformAdmin(t.app, 'platform_admin');
    const res = await request(t.app).get('/api/v1/platform/integrations').set(auth(admin.token));
    expect(res.body.data.messaging.map((m: any) => [m.channel, m.status])).toEqual([
      ['email', 'coming_soon'],
      ['sms', 'coming_soon'],
      ['whatsapp', 'coming_soon'],
    ]);
  });
});
