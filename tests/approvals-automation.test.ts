import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { setChannelFlagsForTests } from '../src/config/features';
import { AutomationRule } from '../src/modules/automations/automation.models';
import { computeNextRun } from '../src/modules/automations/automations.service';
import { tick } from '../src/modules/automations/scheduler';
import { flushBackground } from '../src/modules/communications/communications.service';
import { School } from '../src/modules/schools/school.model';
import { setAdapterForTests, smsAdapter } from '../src/services/messaging/adapters';
import { todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
const today = todayInTz('Asia/Karachi');

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 });
});

describe('Approval workflow', () => {
  it('routes large expenses through approval and excludes them from totals until approved', async () => {
    const small = await api(t.app, s.accountantToken, 'post', '/accounts/expenses', {
      category: 'stationery',
      amount: 2000,
      date: today,
    });
    expect(small.approvalRequired).toBe(false);
    const big = await api(t.app, s.accountantToken, 'post', '/accounts/expenses', {
      category: 'maintenance',
      amount: 80000,
      date: today,
      vendor: 'Bahawal Builders',
    });
    expect(big.approvalRequired).toBe(true);
    expect(big.expense.status).toBe('pending_approval');

    let summary = await api(t.app, s.accountantToken, 'get', `/accounts/summary?from=${today}&to=${today}`);
    expect(summary.expenses).toBe(2000);

    const approval = await api(t.app, s.principalToken, 'post', `/approvals/${big.approval._id}/decision`, {
      decision: 'approve',
    });
    expect(approval.status).toBe('executed');
    summary = await api(t.app, s.accountantToken, 'get', `/accounts/summary?from=${today}&to=${today}`);
    expect(summary.expenses).toBe(82000);
  });

  it('rejection leaves the action unexecuted and is final', async () => {
    const big = await api(t.app, s.accountantToken, 'post', '/accounts/expenses', {
      category: 'events',
      amount: 60000,
      date: today,
    });
    const rejected = await api(t.app, s.principalToken, 'post', `/approvals/${big.approval._id}/decision`, {
      decision: 'reject',
      note: 'Not budgeted',
    });
    expect(rejected.status).toBe('rejected');
    const exp = await api(t.app, s.accountantToken, 'get', `/accounts/expenses/${big.expense._id}`);
    expect(exp.status).toBe('rejected');
    const again = await request(t.app)
      .post(`/api/v1/approvals/${big.approval._id}/decision`)
      .set(auth(s.ownerToken))
      .send({ decision: 'approve' });
    expect(again.status).toBe(409);
  });

  it('prevents a principal approving their own request; the owner may (flagged in audit)', async () => {
    const big = await api(t.app, s.principalToken, 'post', '/accounts/expenses', {
      category: 'rent',
      amount: 90000,
      date: today,
    });
    const self = await request(t.app)
      .post(`/api/v1/approvals/${big.approval._id}/decision`)
      .set(auth(s.principalToken))
      .send({ decision: 'approve' });
    expect(self.status).toBe(403);
    const byOwner = await api(t.app, s.ownerToken, 'post', `/approvals/${big.approval._id}/decision`, {
      decision: 'approve',
    });
    expect(byOwner.status).toBe('executed');
    const ownerExpense = await api(t.app, s.ownerToken, 'post', '/accounts/expenses', {
      category: 'rent',
      amount: 95000,
      date: today,
    });
    const ownerSelf = await api(t.app, s.ownerToken, 'post', `/approvals/${ownerExpense.approval._id}/decision`, {
      decision: 'approve',
    });
    expect(ownerSelf.status).toBe('executed');
    const logs = await api(
      t.app,
      s.ownerToken,
      'get',
      `/audit-logs?action=approval.approved&entityId=${ownerExpense.approval._id}`,
    );
    expect(logs[0].metadata.selfApproval).toBe(true);
  });

  it('teachers and school administrators cannot decide approvals', async () => {
    const big = await api(t.app, s.accountantToken, 'post', '/accounts/expenses', {
      category: 'marketing',
      amount: 70000,
      date: today,
    });
    for (const token of [s.teacherToken, s.adminToken]) {
      const res = await request(t.app)
        .post(`/api/v1/approvals/${big.approval._id}/decision`)
        .set(auth(token))
        .send({ decision: 'approve' });
      expect(res.status).toBe(403);
    }
  });
});

describe('Messaging is honest about delivery', () => {
  // These tests exercise the real delivery path that is kept for future activation,
  // so they switch the channels on. Production defaults are OFF (see channel-pause tests).
  beforeAll(() => setChannelFlagsForTests({ sms: true, whatsapp: true, email: true }));
  afterAll(() => setChannelFlagsForTests({}));
  it('logs not_configured instead of claiming a send when no provider credentials exist', async () => {
    const res = await api(t.app, s.principalToken, 'post', '/communications/messages', {
      channel: 'sms',
      parentId: s.parentIds[0],
      body: 'Test message',
    });
    expect(res.status).toBe('not_configured');
    expect(res.costPkr).toBe(0);
    const channels = await api(t.app, s.principalToken, 'get', '/communications/channels');
    expect(channels.channels.every((c: any) => c.configured === false)).toBe(true);
  });

  it('records sent only after the provider accepts, and failed when it rejects', async () => {
    // Put the real adapter back even if an assertion below fails, so later tests are unaffected.
    onTestFinished(() => setAdapterForTests('sms', smsAdapter));
    let fail = false;
    setAdapterForTests('sms', {
      ...smsAdapter,
      isConfigured: () => true,
      costPerMessagePkr: () => 2,
      send: async () => {
        if (fail) throw new Error('Provider responded 400: invalid number');
        return { providerMessageId: 'SM123' };
      },
    });
    const ok = await api(t.app, s.principalToken, 'post', '/communications/messages', {
      channel: 'sms',
      to: '+923001234567',
      body: 'Hello',
    });
    expect(ok.status).toBe('sent');
    expect(ok.providerMessageId).toBe('SM123');
    expect(ok.costPkr).toBe(2);
    fail = true;
    const bad = await api(t.app, s.principalToken, 'post', '/communications/messages', {
      channel: 'sms',
      to: '+923001234568',
      body: 'Hello',
    });
    expect(bad.status).toBe('failed');
    expect(bad.costPkr).toBe(0);
    const costs = await api(t.app, s.principalToken, 'get', `/communications/costs?from=${today}&to=${today}`);
    expect(costs.totalPkr).toBe(2);
    setAdapterForTests('sms', smsAdapter);
  });

  it('publishes in-app announcements immediately and gates bulk external sends behind approval', async () => {
    const inApp = await api(t.app, s.principalToken, 'post', '/communications/announcements', {
      title: 'Sports Day',
      body: 'Sports day on Friday.',
      audience: { roles: ['parent'] },
    });
    const pub = await api(t.app, s.principalToken, 'post', `/communications/announcements/${inApp._id}/publish`);
    expect(pub.status).toBe('published');
    expect(pub.inApp).toBe(3); // every parent gets an app account on admission (pending ones see it after activating)
    const notes = await api(t.app, s.parentToken, 'get', '/notifications');
    expect(notes.some((n: any) => n.title === 'Sports Day')).toBe(true);

    await api(t.app, s.ownerToken, 'patch', '/school/settings', { approvals: { bulkMessageThreshold: 2 } });
    const sms = await api(t.app, s.principalToken, 'post', '/communications/announcements', {
      title: 'Fee due',
      body: 'Fees due on 10th.',
      audience: { roles: ['parent'] },
      channels: ['sms'],
    });
    const gated = await api(t.app, s.principalToken, 'post', `/communications/announcements/${sms._id}/publish`);
    expect(gated.status).toBe('pending_approval');
    const approved = await api(t.app, s.ownerToken, 'post', `/approvals/${gated.approvalId}/decision`, {
      decision: 'approve',
    });
    expect(approved.status).toBe('executed');
    await flushBackground();
    const ann = await api(t.app, s.principalToken, 'get', `/communications/announcements/${sms._id}`);
    expect(ann.status).toBe('published');
    expect(ann.delivery.status).toBe('completed');
    expect(ann.delivery.external.sms.not_configured).toBe(3);
  });
});

describe('Automation Center', () => {
  // These tests exercise the real delivery path that is kept for future activation,
  // so they switch the channels on. Production defaults are OFF (see channel-pause tests).
  beforeAll(() => setChannelFlagsForTests({ sms: true, whatsapp: true, email: true }));
  afterAll(() => setChannelFlagsForTests({}));
  it('computes the next run in the school timezone', () => {
    const next = computeNextRun({ frequency: 'daily', hour: 9 }, 'Asia/Karachi', new Date('2026-10-13T05:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-14T04:00:00.000Z');
    const weekly = computeNextRun(
      { frequency: 'weekly', hour: 8, weekday: 1 },
      'Asia/Karachi',
      new Date('2026-10-13T05:00:00Z'),
    );
    expect(weekly.toISOString()).toBe('2026-10-19T03:00:00.000Z');
  });

  it('fee reminder automation creates an approval request instead of sending', async () => {
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', {
      period: '2026-07',
      dueDate: '2026-07-10',
    });
    const rule = await api(t.app, s.ownerToken, 'post', '/automations', {
      type: 'fee_reminder',
      schedule: { frequency: 'daily', hour: 9 },
      config: { channels: ['whatsapp'], minDaysOverdue: 1 },
    });
    const run = await api(t.app, s.ownerToken, 'post', `/automations/${rule._id}/run`);
    expect(run.status).toBe('success');
    const approval = await api(t.app, s.ownerToken, 'get', `/approvals/${run.result.approvalId}`);
    expect(approval.type).toBe('fee_reminder_batch');
    expect(approval.source).toBe('automation');
    expect(approval.status).toBe('pending');
    const runs = await api(t.app, s.ownerToken, 'get', `/automations/runs?ruleId=${rule._id}`);
    expect(runs).toHaveLength(1);
  });

  it('the scheduler runs a due rule exactly once and reschedules it', async () => {
    const rule = await api(t.app, s.ownerToken, 'post', '/automations', {
      type: 'admission_followup',
      schedule: { frequency: 'daily', hour: 9 },
    });
    await AutomationRule.updateOne(
      { _id: rule._id, schoolId: s.schoolId },
      { $set: { nextRunAt: new Date(Date.now() - 1000) } },
    );
    await Promise.all([tick(), tick()]);
    const runs = await api(t.app, s.ownerToken, 'get', `/automations/runs?ruleId=${rule._id}`);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('schedule');
    const after = await AutomationRule.findOne({ _id: rule._id, schoolId: s.schoolId }).lean();
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('isolates a school whose rule cannot be scheduled: it is disabled, other schools still run', async () => {
    const other = await buildSchool(t.app, { students: 1 });
    const bad = await api(t.app, s.ownerToken, 'post', '/automations', {
      type: 'attendance_alert',
      schedule: { frequency: 'daily', hour: 9 },
    });
    const good = await api(t.app, other.ownerToken, 'post', '/automations', {
      type: 'admission_followup',
      schedule: { frequency: 'daily', hour: 9 },
    });
    const past = new Date(Date.now() - 1000);
    // A corrupted timezone makes the next run impossible to compute for this school only.
    await School.updateOne({ _id: s.schoolId }, { $set: { 'settings.timezone': 'Not/A_Zone' } });
    await AutomationRule.updateOne({ _id: bad._id, schoolId: s.schoolId }, { $set: { nextRunAt: past } });
    await AutomationRule.updateOne({ _id: good._id, schoolId: other.schoolId }, { $set: { nextRunAt: past } });
    await tick();
    await tick();
    const badAfter = await AutomationRule.findOne({ _id: bad._id, schoolId: s.schoolId }).lean();
    const goodAfter = await AutomationRule.findOne({ _id: good._id, schoolId: other.schoolId }).lean();
    expect(badAfter!.enabled).toBe(false);
    expect(badAfter!.lockedUntil ?? null).toBeNull();
    expect(goodAfter!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const runs = await api(t.app, other.ownerToken, 'get', `/automations/runs?ruleId=${good._id}`);
    expect(runs).toHaveLength(1);
    await School.updateOne({ _id: s.schoolId }, { $set: { 'settings.timezone': 'Asia/Karachi' } });
  });

  it('only managers can create or run automations', async () => {
    const res = await request(t.app)
      .post('/api/v1/automations')
      .set(auth(s.teacherToken))
      .send({ type: 'late_fee', schedule: { hour: 9 } });
    expect(res.status).toBe(403);
  });
});
