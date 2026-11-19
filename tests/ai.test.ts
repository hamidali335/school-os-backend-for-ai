import { FEATURE_KEYS } from '../src/config/entitlements';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setChannelFlagsForTests } from '../src/config/features';
import { AiUsage } from '../src/modules/ai/ai-usage.model';
import { ErrorEvent } from '../src/modules/health/error-event.model';
import { AiProviderError, setAiProviderForTests, type AiProvider, type ChatRequest } from '../src/modules/ai/provider';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { School } from '../src/modules/schools/school.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp, assignPlan } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

function fakeProvider(handler: (req: ChatRequest) => Promise<any> | any): AiProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    isConfigured: () => true,
    estimateCostUsd: (u) => (u.promptTokens + u.completionTokens) / 1_000_000,
    chat: async (req) => handler(req),
  };
}
const reply = (content: string, toolCalls: any[] = []) => ({
  content,
  toolCalls,
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  model: 'fake-1',
});

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 });
  await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', { period: '2026-08' });
  // AI is a plan feature: these tests run on a plan that includes every feature.
  await assignPlan(s.schoolId, 'all_features', FEATURE_KEYS);
});
afterEach(() => setAiProviderForTests(null));

describe('AI provider failures never affect the core system', () => {
  it('returns AI_UNAVAILABLE when no API key is configured, while core endpoints keep working', async () => {
    const res = await request(t.app)
      .post('/api/v1/ai/copilot/chat')
      .set(auth(s.principalToken))
      .send({ messages: [{ role: 'user', content: 'How is attendance?' }] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    const status = await api(t.app, s.principalToken, 'get', '/ai/status');
    expect(status.configured).toBe(false);
    expect((await request(t.app).get('/api/v1/dashboard').set(auth(s.principalToken))).status).toBe(200);
    expect((await request(t.app).get('/api/v1/fees/outstanding').set(auth(s.principalToken))).status).toBe(200);
  });

  it('does not count expected AI unavailability as a server error', async () => {
    await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Text that is long enough to be summarised by the AI.' });
    expect(await ErrorEvent.countDocuments({})).toBe(0);
  });

  it('still returns computed insights and a plain daily brief without AI', async () => {
    const insights = await api(t.app, s.principalToken, 'get', '/ai/insights?narrative=true');
    expect(insights.aiStatus).toBe('unavailable');
    expect(insights.insights.find((i: any) => i.id === 'fees_overdue')).toBeTruthy();
    const brief = await api(t.app, s.principalToken, 'get', '/ai/daily-brief');
    expect(brief.aiStatus).toBe('unavailable');
    expect(brief.text).toContain('Daily brief for');
  });

  it('maps provider errors and timeouts to AI_PROVIDER_ERROR and records the failure', async () => {
    setAiProviderForTests(
      fakeProvider(() => {
        throw new AiProviderError('timed out', 'timeout');
      }),
    );
    const res = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Parents asked about the winter vacation schedule and uniform policy.' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_PROVIDER_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('timed out');
    const rows = await AiUsage.find({ schoolId: s.schoolId, status: 'error' }).lean();
    expect(rows.some((r) => r.errorCode === 'TIMEOUT')).toBe(true);
  });

  it('enforces the monthly token limit (AI_LIMIT_REACHED)', async () => {
    setAiProviderForTests(fakeProvider(() => reply('ok')));
    const plan = await Plan.create({
      code: `tiny${Date.now()}`,
      name: 'Tiny',
      priceMonthlyPkr: 0,
      limits: { aiMonthlyTokens: 200 },
      features: [...FEATURE_KEYS],
    });
    await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
    const first = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'A long enough piece of text to summarise for the test.' });
    expect(first.status).toBe(200);
    await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'A long enough piece of text to summarise for the test.' });
    const blocked = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'A long enough piece of text to summarise for the test.' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('AI_LIMIT_REACHED');
    await assignPlan(s.schoolId, 'all_features', FEATURE_KEYS);
    await AiUsage.deleteMany({ schoolId: s.schoolId });
  });

  it('respects the school setting that turns AI off', async () => {
    setAiProviderForTests(fakeProvider(() => reply('ok')));
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { ai: { enabled: false } });
    const res = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to be summarised.' });
    expect(res.status).toBe(503);
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { ai: { enabled: true } });
  });
});

describe('Copilot tools are authorised per user', () => {
  // These tests exercise the real delivery path that is kept for future activation,
  // so they switch the channels on. Production defaults are OFF (see channel-pause tests).
  beforeAll(() => setChannelFlagsForTests({ sms: true, whatsapp: true, email: true }));
  afterAll(() => setChannelFlagsForTests({}));
  it('runs read-only tools with the caller’s permissions and records usage and cost', async () => {
    const seenTools: string[][] = [];
    let round = 0;
    setAiProviderForTests(
      fakeProvider((req) => {
        seenTools.push((req.tools ?? []).map((x) => x.function.name));
        round++;
        if (round === 1)
          return reply('', [
            { id: 'c1', type: 'function', function: { name: 'get_fee_outstanding', arguments: '{"limit":5}' } },
          ]);
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        const data = JSON.parse(toolMsg!.content!);
        return reply(`Outstanding is Rs ${data.data.totals.balance}`);
      }),
    );
    const res = await api(t.app, s.principalToken, 'post', '/ai/copilot/chat', {
      messages: [{ role: 'user', content: 'What fees are outstanding?' }],
    });
    expect(res.reply).toMatch(/Outstanding is Rs \d+/);
    expect(res.toolCalls).toEqual([{ tool: 'get_fee_outstanding', ok: true, proposes: false }]);
    expect(seenTools[0]).toContain('get_fee_outstanding');
    const usage = await AiUsage.find({ schoolId: s.schoolId, feature: 'copilot', status: 'success' }).lean();
    expect(usage.length).toBe(2);
    expect(usage[0].totalTokens).toBe(150);
    expect(usage[0].costUsd).toBeGreaterThan(0);
  });

  it('does not offer or execute tools the user lacks permission for', async () => {
    let offered: string[] = [];
    let round = 0;
    setAiProviderForTests(
      fakeProvider((req) => {
        round++;
        if (round === 1) {
          offered = (req.tools ?? []).map((x) => x.function.name);
          // The model tries to call a tool that was not offered.
          return reply('', [
            { id: 'c1', type: 'function', function: { name: 'get_fee_outstanding', arguments: '{}' } },
          ]);
        }
        return reply('done');
      }),
    );
    const res = await api(t.app, s.teacherToken, 'post', '/ai/copilot/chat', {
      messages: [{ role: 'user', content: 'Show me fee defaulters' }],
    });
    expect(offered).not.toContain('get_fee_outstanding');
    expect(offered).not.toContain('get_financial_summary');
    expect(res.toolCalls).toEqual([{ tool: 'get_fee_outstanding', ok: false }]);
    const parent = await request(t.app)
      .post('/api/v1/ai/copilot/chat')
      .set(auth(s.parentToken))
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(parent.status).toBe(403);
  });

  it('can only propose sensitive actions: fee reminders become a pending approval, nothing is sent', async () => {
    let round = 0;
    setAiProviderForTests(
      fakeProvider(() => {
        round++;
        if (round === 1)
          return reply('', [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'propose_fee_reminders', arguments: '{"channels":["sms"]}' },
            },
          ]);
        return reply('I created a reminder request for approval.');
      }),
    );
    const res = await api(t.app, s.principalToken, 'post', '/ai/copilot/chat', {
      messages: [{ role: 'user', content: 'Remind parents with overdue fees' }],
    });
    expect(res.proposals[0].created).toBe(true);
    const approval = await api(t.app, s.principalToken, 'get', `/approvals/${res.proposals[0].approvalId}`);
    expect(approval.status).toBe('pending');
    expect(approval.source).toBe('ai');
    expect(approval.data.invoices).toBeGreaterThan(0);
    const messages = await api(t.app, s.principalToken, 'get', '/communications/messages');
    expect(messages).toHaveLength(0);

    // A different approver approves; SMS is not configured so messages are logged honestly.
    const decided = await api(t.app, s.ownerToken, 'post', `/approvals/${approval._id}/decision`, {
      decision: 'approve',
    });
    expect(decided.status).toBe('executed');
    const { flushBackground } = await import('../src/modules/communications/communications.service');
    await flushBackground();
    const logs = await api(t.app, s.principalToken, 'get', `/communications/messages?relatedId=${approval._id}`);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: any) => l.status === 'not_configured')).toBe(true);
  });

  it('marks AI-drafted announcements so external publishing requires approval', async () => {
    setAiProviderForTests(
      fakeProvider(() =>
        reply('{"title":"Early closure Friday","body":"School will close at 12:00 on Friday for a staff meeting."}'),
      ),
    );
    const draft = await api(t.app, s.principalToken, 'post', '/ai/draft-communication', {
      purpose: 'Tell parents school closes early on Friday',
      channel: 'sms',
      saveAsDraft: { roles: ['parent'], channels: ['sms'] },
    });
    expect(draft.title).toBe('Early closure Friday');
    const pub = await api(
      t.app,
      s.principalToken,
      'post',
      `/communications/announcements/${draft.draftAnnouncementId}/publish`,
    );
    expect(pub.status).toBe('pending_approval');
  });
});
