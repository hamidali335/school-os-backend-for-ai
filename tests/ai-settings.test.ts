import { FEATURE_KEYS } from '../src/config/entitlements';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiUsage } from '../src/modules/ai/ai-usage.model';
import { invalidateAiProviderCache } from '../src/modules/ai/provider';
import { decryptSecret, encryptSecret, maskSecret } from '../src/services/secrets';
import { buildSchool, type SchoolFixture } from './fixtures';
import { auth, createPlatformAdmin, useTestApp, assignPlan } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let owner: { token: string };
let admin: { token: string };
const KEY = 'gsk_test_key_1234567890abcdef';

/** Fake OpenAI-compatible provider endpoint; records the requests it receives. */
function mockProvider(reply: (url: string, body: any) => { status: number; json: unknown }) {
  const calls: Array<{ url: string; headers: any; body: any }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, headers: init?.headers, body });
    const r = reply(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
const completion = (content: string) => ({
  status: 200,
  json: {
    model: 'openai/gpt-oss-120b',
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
});

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  owner = await createPlatformAdmin(t.app, 'platform_owner');
  // AI is a plan feature: these tests run on a plan that includes every feature.
  await assignPlan(s.schoolId, 'all_features', FEATURE_KEYS);
  admin = await createPlatformAdmin(t.app, 'platform_admin');
});
afterEach(() => {
  vi.restoreAllMocks();
  invalidateAiProviderCache();
});

const p = (token: string, method: 'get' | 'put' | 'post' | 'delete', url: string, body?: unknown) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

describe('Secret storage', () => {
  it('encrypts, decrypts and masks keys', () => {
    const enc = encryptSecret(KEY);
    expect(enc).not.toContain(KEY);
    expect(decryptSecret(enc)).toBe(KEY);
    expect(decryptSecret(enc.replace(/.$/, 'A'))).toBeNull();
    expect(maskSecret(KEY)).toBe('gsk_…cdef');
  });
});

describe('Platform AI settings', () => {
  it('lists the provider catalogue', async () => {
    const res = await p(admin.token, 'get', '/platform/ai/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: any) => x.id)).toEqual([
      'groq',
      'openai',
      'deepseek',
      'xai',
      'gemini',
      'openrouter',
      'custom',
    ]);
  });

  it('only the platform owner can change settings; school users cannot reach them', async () => {
    expect(
      (await p(admin.token, 'put', '/platform/ai/settings/providers/groq', { apiKey: KEY, model: 'x' })).status,
    ).toBe(403);
    expect((await p(s.ownerToken, 'get', '/platform/ai/settings')).status).toBe(401);
  });

  it('refuses to activate a provider without a saved key', async () => {
    const res = await p(owner.token, 'put', '/platform/ai/settings', { activeProvider: 'openai' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AI_PROVIDER_INCOMPLETE');
  });

  it('saves a key encrypted, never returns it, and switches the active provider immediately', async () => {
    const res = await p(owner.token, 'put', '/platform/ai/settings/providers/groq', {
      apiKey: KEY,
      model: 'openai/gpt-oss-120b',
      inputCostPerMTokUsd: 0.15,
      outputCostPerMTokUsd: 0.6,
      activate: true,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const groq = res.body.data.providers.find((x: any) => x.provider === 'groq');
    expect(groq).toMatchObject({
      hasApiKey: true,
      apiKeyMasked: 'gsk_…cdef',
      keyReadable: true,
      model: 'openai/gpt-oss-120b',
    });
    expect(res.body.data.effective).toMatchObject({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      source: 'database',
      configured: true,
    });

    const status = await request(t.app).get('/api/v1/ai/status').set(auth(s.principalToken));
    expect(status.body.data).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-120b', configured: true });

    const logs = await p(owner.token, 'get', '/platform/audit-events');
    expect(JSON.stringify(logs.body)).not.toContain(KEY);
  });

  it('school AI features use the selected provider, model and key, and record cost', async () => {
    const calls = mockProvider(() => completion('Short summary.'));
    const res = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Parents asked about the winter vacation schedule and uniform policy.' });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toBe('Short summary.');
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.model).toBe('openai/gpt-oss-120b');
    expect(calls[0].body.max_completion_tokens).toBeDefined();
    const usage = await AiUsage.findOne({ schoolId: s.schoolId, feature: 'summarize' }).lean();
    expect(usage).toMatchObject({ provider: 'groq', status: 'success', totalTokens: 15 });
    expect(usage!.costUsd).toBeGreaterThan(0);
  });

  it('switching model or provider changes what is called, without a restart', async () => {
    await p(owner.token, 'put', '/platform/ai/settings/providers/deepseek', {
      apiKey: 'sk-deepseek-test-key',
      model: 'deepseek-chat',
    });
    await p(owner.token, 'put', '/platform/ai/settings', { activeProvider: 'deepseek' });
    const calls = mockProvider(() => completion('From DeepSeek.'));
    await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to summarise here.' });
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(calls[0].body).toMatchObject({ model: 'deepseek-chat', max_tokens: 700 });

    // Change only the model; the saved key is kept.
    await p(owner.token, 'put', '/platform/ai/settings/providers/deepseek', { model: 'deepseek-reasoner' });
    const calls2 = mockProvider(() => completion('ok'));
    await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to summarise here.' });
    expect(calls2[0].body.model).toBe('deepseek-reasoner');
    expect(calls2[0].headers.Authorization).toBe('Bearer sk-deepseek-test-key');
  });

  it('retries once without temperature when a model rejects it', async () => {
    let n = 0;
    const calls = mockProvider(() =>
      ++n === 1
        ? { status: 400, json: { error: { message: "Unsupported parameter: 'temperature'" } } }
        : completion('fine'),
    );
    const res = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to summarise here.' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.temperature).toBeUndefined();
  });

  it('tests a configuration and explains provider errors to the platform admin', async () => {
    mockProvider(() => completion('OK'));
    const ok = await p(admin.token, 'post', '/platform/ai/test', {});
    expect(ok.body.data).toMatchObject({ ok: true, provider: 'deepseek', reply: 'OK' });

    mockProvider(() => ({ status: 401, json: { error: { message: 'Invalid API Key' } } }));
    const bad = await p(admin.token, 'post', '/platform/ai/test', {
      provider: 'openai',
      apiKey: 'sk-wrong-key-123',
      model: 'gpt-4o-mini',
    });
    expect(bad.body.data).toMatchObject({
      ok: false,
      errorKind: 'auth',
      httpStatus: 401,
      providerMessage: 'Invalid API Key',
    });
    expect(bad.body.data.hint).toContain('API key');
  });

  it('school users never see provider error details', async () => {
    mockProvider(() => ({ status: 401, json: { error: { message: 'Invalid API Key xyz-secret-detail' } } }));
    const res = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to summarise here.' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('xyz-secret-detail');
  });

  it('lists live models from the provider', async () => {
    mockProvider(() => ({ status: 200, json: { data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] } }));
    const res = await p(admin.token, 'get', '/platform/ai/providers/deepseek/models');
    expect(res.body.data).toMatchObject({ source: 'live', models: ['deepseek-chat', 'deepseek-reasoner'] });
  });

  it('can turn AI off platform-wide and fall back to .env after removing a provider', async () => {
    await p(owner.token, 'put', '/platform/ai/settings', { enabled: false });
    const off = await request(t.app)
      .post('/api/v1/ai/summarize')
      .set(auth(s.principalToken))
      .send({ text: 'Some text that is long enough to summarise here.' });
    expect(off.status).toBe(503);
    await p(owner.token, 'put', '/platform/ai/settings', { enabled: true });

    const removed = await p(owner.token, 'delete', '/platform/ai/settings/providers/deepseek');
    expect(removed.body.data.activeProvider).toBeNull();
    // Tests run without an .env key, so the fallback is "not configured".
    expect(removed.body.data.effective.configured).toBe(false);
  });
});
