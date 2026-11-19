import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migratePlanEntitlements } from '../scripts/migrate-plan-entitlements';
import { createApp } from '../src/app';
import {
  AI_ENTITLEMENTS,
  CORE_FEATURES,
  FEATURE_KEYS,
  MOBILE_FEATURES,
  REQUIRED_FEATURES,
} from '../src/config/entitlements';

/** Pro Max is every feature except app voice calls and AI voice calls, which are in no default plan. */
const PRO_MAX_FEATURES = FEATURE_KEYS.filter((f) => f !== 'calls.voice' && f !== 'calls.ai_voice');
import { AiUsage } from '../src/modules/ai/ai-usage.model';
import { setAiProviderForTests, type AiProvider } from '../src/modules/ai/provider';
import { AuditLog } from '../src/modules/audit/audit.model';
import { School } from '../src/modules/schools/school.model';
import { DEFAULT_PLAN_TEMPLATES } from '../src/modules/subscriptions/default-plans';
import { assertEntitled, computeEntitlements } from '../src/modules/subscriptions/entitlements.service';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createPlatformAdmin, login, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let owner: { token: string };
let admin: { token: string };

let providerCalls = 0;
const fakeProvider: AiProvider = {
  name: 'fake',
  model: 'fake-1',
  isConfigured: () => true,
  estimateCostUsd: () => 0,
  chat: async () => {
    providerCalls++;
    return {
      content: 'ok',
      toolCalls: [],
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      model: 'fake-1',
    };
  },
};
afterEach(() => setAiProviderForTests(null));

const p = (token: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) =>
  request(t.app)
    [method](`/api/v1${url}`)
    .set(auth(token))
    .send(body as object);
const pd = async (token: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) => {
  const res = await p(token, method, url, body);
  if (res.status >= 300) throw new Error(`${method.toUpperCase()} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const planId = async (code: string) => String((await Plan.findOne({ code }).lean())!._id);
const entitled = async (token: string) =>
  ((await api(t.app, token, 'get', '/entitlements')).features as any[])
    .filter((f) => f.entitled)
    .map((f) => f.key)
    .sort();
const copilot = (token: string) =>
  p(token, 'post', '/ai/copilot/chat', { messages: [{ role: 'user', content: 'Hello' }] });
const moveTo = (schoolId: string, planCode: string) =>
  pd(owner.token, 'post', `/platform/schools/${schoolId}/plan-change`, { planCode, confirm: true });

beforeAll(async () => {
  owner = await createPlatformAdmin(t.app, 'platform_owner');
  admin = await createPlatformAdmin(t.app, 'platform_admin');
  // A fresh database: the migration creates the Basic, Pro and Pro Max templates.
  const r = await migratePlanEntitlements(true, () => undefined);
  expect(r.templatesCreated).toEqual(['basic', 'pro', 'pro_max']);
});

describe('Plan configuration (defaults)', () => {
  it('Basic has every core module and both web portals, and no AI or mobile apps', async () => {
    const basic = await pd(owner.token, 'get', `/platform/plans/${await planId('basic')}`);
    expect([...basic.features].sort()).toEqual([...CORE_FEATURES].sort());
    for (const f of [...AI_ENTITLEMENTS, ...MOBILE_FEATURES]) expect(basic.features).not.toContain(f);
    expect(basic.features).toEqual(expect.arrayContaining(['portal.parents', 'portal.teachers']));
  });

  it('Pro is Basic plus both mobile apps, without AI', async () => {
    const pro = await pd(owner.token, 'get', `/platform/plans/${await planId('pro')}`);
    expect([...pro.features].sort()).toEqual([...CORE_FEATURES, ...MOBILE_FEATURES].sort());
    for (const f of AI_ENTITLEMENTS) expect(pro.features).not.toContain(f);
  });

  it('Pro Max has everything (except app calls, in no default plan), including every implemented AI feature', async () => {
    const max = await pd(owner.token, 'get', `/platform/plans/${await planId('pro_max')}`);
    expect([...max.features].sort()).toEqual([...PRO_MAX_FEATURES].sort());
  });

  it('the registry marks mobile apps as not released, and every template is valid', async () => {
    const reg = await pd(admin.token, 'get', '/platform/features');
    const mobile = reg.features.filter((f: any) => f.category === 'mobile');
    expect(mobile.map((f: any) => f.availability)).toEqual(['coming_soon', 'coming_soon']);
    for (const tpl of DEFAULT_PLAN_TEMPLATES) for (const r of REQUIRED_FEATURES) expect(tpl.features).toContain(r);
  });
});

describe('Dynamic plan management (draft → preview → publish)', () => {
  it('changes prices and features through a draft, persisted and visible after a restart', async () => {
    const id = await planId('pro');
    await pd(owner.token, 'put', `/platform/plans/${id}/draft`, {
      prices: { monthly: { amount: 4000, enabled: true }, yearly: { amount: 40000, enabled: true } },
      features: [...CORE_FEATURES, ...MOBILE_FEATURES, 'ai.insights'],
    });
    // Not live yet.
    expect((await Plan.findById(id).lean())!.features).not.toContain('ai.insights');
    const preview = await pd(owner.token, 'get', `/platform/plans/${id}/draft/preview`);
    expect(preview.featuresAdded.map((f: any) => f.key)).toEqual(['ai.insights']);
    expect(preview.priceChanges.map((c: any) => c.period).sort()).toEqual(['monthly', 'yearly']);
    // Publishing needs explicit confirmation and the platform owner.
    expect((await p(owner.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers' })).status).toBe(
      400,
    );
    expect(
      (await p(admin.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers', confirm: true }))
        .status,
    ).toBe(403);
    const done = await pd(owner.token, 'post', `/platform/plans/${id}/publish`, {
      applyTo: 'all_subscribers',
      confirm: true,
    });
    expect(done.plan.prices.monthly.amount).toBe(4000);
    expect(done.plan.features).toContain('ai.insights');
    expect(done.plan.draft).toBeNull();
    // A new app instance (a restart) reads the same published configuration from the database.
    const restarted = createApp();
    const res = await request(restarted).get(`/api/v1/platform/plans/${id}`).set(auth(owner.token));
    expect(res.body.data.prices.yearly).toEqual({ amount: 40000, enabled: true });
    expect(await AuditLog.countDocuments({ action: 'platform.plan.published', entityId: id })).toBe(1);
    // Put Pro back to its default for the tests below.
    await pd(owner.token, 'put', `/platform/plans/${id}/draft`, { features: [...CORE_FEATURES, ...MOBILE_FEATURES] });
    await pd(owner.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers', confirm: true });
  });

  it('rejects invalid configurations and keeps the last valid published one', async () => {
    const id = await planId('basic');
    const before = await Plan.findById(id).lean();
    const unknown = await p(owner.token, 'put', `/platform/plans/${id}/draft`, {
      features: [...CORE_FEATURES, 'mobile.watch_app'],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('INVALID_PLAN_CONFIG');
    const dependency = await p(owner.token, 'put', `/platform/plans/${id}/draft`, {
      features: CORE_FEATURES.filter((f) => f !== 'core.reports').concat('ai.insights'),
    });
    expect(dependency.status).toBe(400);
    expect(JSON.stringify(dependency.body)).toMatch(/needs Reports/);
    const noPortal = await p(owner.token, 'put', `/platform/plans/${id}/draft`, {
      features: CORE_FEATURES.filter((f) => f !== 'portal.parents'),
    });
    expect(noPortal.status).toBe(400);
    const noBilling = await p(owner.token, 'put', `/platform/plans/${id}/draft`, {
      prices: { monthly: { amount: 1, enabled: false }, yearly: { amount: 1, enabled: false } },
    });
    expect(noBilling.status).toBe(400);
    const after = await Plan.findById(id).lean();
    expect(after!.features).toEqual(before!.features);
    expect(after!.draft).toBeUndefined();
    expect(after!.version).toBe(before!.version);
  });

  it('creates a new plan without code changes; it cannot be assigned until published', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    const gold = await pd(owner.token, 'post', '/platform/plans', {
      code: 'gold',
      name: 'Gold',
      prices: { monthly: { amount: 3000, enabled: true }, yearly: { amount: 30000, enabled: true } },
      features: [...CORE_FEATURES, 'ai.copilot'],
      publish: false,
    });
    expect(gold.published).toBe(false);
    expect(
      (await p(owner.token, 'post', `/platform/schools/${s.schoolId}/plan-change`, { planCode: 'gold', confirm: true }))
        .status,
    ).toBe(409);
    await pd(owner.token, 'post', `/platform/plans/${gold._id}/publish`, { applyTo: 'all_subscribers', confirm: true });
    await moveTo(s.schoolId, 'gold');
    expect(await entitled(s.ownerToken)).toEqual([...CORE_FEATURES, 'ai.copilot'].sort());
  });

  it('renaming a plan keeps its subscriptions, and archiving keeps existing schools working', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'pro_max');
    const id = await planId('pro_max');
    await pd(owner.token, 'put', `/platform/plans/${id}/draft`, { name: 'Excellent' });
    await pd(owner.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers', confirm: true });
    const ent = await api(t.app, s.ownerToken, 'get', '/entitlements');
    expect(ent.plan).toEqual({ code: 'pro_max', name: 'Excellent' });
    expect(ent.features.filter((f: any) => f.entitled)).toHaveLength(PRO_MAX_FEATURES.length);

    const temp = await pd(owner.token, 'post', '/platform/plans', {
      code: 'legacy_x',
      name: 'Legacy X',
      priceMonthlyPkr: 100,
    });
    await moveTo(s.schoolId, 'legacy_x');
    await pd(owner.token, 'post', `/platform/plans/${temp._id}/archive`, { confirm: true });
    expect((await p(s.ownerToken, 'get', '/students')).status).toBe(200);
    const other = await buildSchool(t.app, { students: 1 });
    expect(
      (
        await p(owner.token, 'post', `/platform/schools/${other.schoolId}/plan-change`, {
          planCode: 'legacy_x',
          confirm: true,
        })
      ).status,
    ).toBe(409);
    const detail = await pd(owner.token, 'get', `/platform/plans/${temp._id}`);
    expect(detail.archived).toBe(true);
    expect(detail.schools.map((x: any) => x._id)).toContain(s.schoolId);
    // Put Pro Max's name back.
    await pd(owner.token, 'put', `/platform/plans/${id}/draft`, { name: 'Pro Max' });
    await pd(owner.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers', confirm: true });
  });

  it('a price change never rewrites an existing subscription; applying it is explicit and audited', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'basic');
    const id = await planId('basic');
    const old = (await Plan.findById(id).lean())!.prices!.monthly!.amount;
    await pd(owner.token, 'put', `/platform/plans/${id}/draft`, {
      prices: { monthly: { amount: old + 500, enabled: true }, yearly: { amount: 0, enabled: false } },
    });
    await pd(owner.token, 'post', `/platform/plans/${id}/publish`, { applyTo: 'all_subscribers', confirm: true });
    let sub = await pd(owner.token, 'get', `/platform/schools/${s.schoolId}/entitlements`);
    expect(sub.agreedPrice.amount).toBe(old);
    expect(sub.currentPlanPrice.monthly.amount).toBe(old + 500);
    sub = await pd(owner.token, 'post', `/platform/schools/${s.schoolId}/subscription/apply-current-price`, {
      confirm: true,
    });
    expect(sub.agreedPrice.amount).toBe(old + 500);
    expect(
      await AuditLog.countDocuments({ action: 'platform.subscription.price_applied', entityId: s.schoolId }),
    ).toBeGreaterThan(0);
  });

  it('"new subscribers only" keeps existing schools on their features; new schools get the new set', async () => {
    const plan = await pd(owner.token, 'post', '/platform/plans', {
      code: 'silver',
      name: 'Silver',
      priceMonthlyPkr: 2000,
      features: [...CORE_FEATURES, 'ai.copilot'],
    });
    const early = await buildSchool(t.app, { students: 1 });
    await moveTo(early.schoolId, 'silver');
    await pd(owner.token, 'put', `/platform/plans/${plan._id}/draft`, { features: [...CORE_FEATURES] });
    const res = await pd(owner.token, 'post', `/platform/plans/${plan._id}/publish`, {
      applyTo: 'new_subscribers_only',
      confirm: true,
    });
    expect(res.grandfatheredSchools).toBe(1);
    expect(await entitled(early.ownerToken)).toContain('ai.copilot');
    const late = await buildSchool(t.app, { students: 1 });
    await moveTo(late.schoolId, 'silver');
    expect(await entitled(late.ownerToken)).not.toContain('ai.copilot');
  });
});

describe('Schools on Basic, Pro and Pro Max', () => {
  const schools: Record<string, SchoolFixture> = {};
  beforeAll(async () => {
    for (const code of ['basic', 'pro', 'pro_max']) {
      schools[code] = await buildSchool(t.app, { students: 2 });
      await moveTo(schools[code].schoolId, code);
    }
  });

  it('each school gets its plan’s effective features', async () => {
    expect(await entitled(schools.basic.ownerToken)).toEqual([...CORE_FEATURES].sort());
    expect(await entitled(schools.pro.ownerToken)).toEqual([...CORE_FEATURES, ...MOBILE_FEATURES].sort());
    expect(await entitled(schools.pro_max.ownerToken)).toEqual([...PRO_MAX_FEATURES].sort());
    const me = await api(t.app, schools.basic.teacherToken, 'get', '/auth/me');
    expect(me.entitlements).not.toContain('ai.copilot');
    const mobile = (await api(t.app, schools.pro.ownerToken, 'get', '/entitlements')).features.find(
      (f: any) => f.key === 'mobile.parent_app',
    );
    expect(mobile).toMatchObject({ entitled: true, available: false });
  });

  it('parents and teachers sign in and use their web portals on every plan', async () => {
    for (const code of ['basic', 'pro', 'pro_max']) {
      const s = schools[code];
      expect((await p(s.parentToken, 'get', '/students')).status, code).toBe(200);
      expect((await p(s.parentToken, 'get', '/dashboard')).status, code).toBe(200);
      expect((await p(s.teacherToken, 'get', '/academics/my-sections')).status, code).toBe(200);
      expect((await p(s.teacherToken, 'get', '/homework')).status, code).toBe(200);
      expect(await login(t.app, s.ownerEmail, PASSWORD)).toBeTruthy();
    }
  });

  it('role permissions still apply on every plan (Pro Max does not give a teacher the fee module)', async () => {
    const res = await p(schools.pro_max.teacherToken, 'get', '/fees/invoices');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('Basic and Pro cannot use AI by calling the API directly; the provider is never contacted', async () => {
    setAiProviderForTests(fakeProvider);
    providerCalls = 0;
    for (const code of ['basic', 'pro']) {
      const s = schools[code];
      for (const res of [
        await copilot(s.ownerToken),
        await p(s.ownerToken, 'post', '/ai/summarize', { text: 'A long enough piece of text to summarise here.' }),
        await p(s.ownerToken, 'get', '/ai/insights'),
      ]) {
        expect(res.status, code).toBe(403);
        expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      }
      const status = await api(t.app, s.ownerToken, 'get', '/ai/status');
      expect(status).toMatchObject({ includedInPlan: [], available: false });
    }
    expect(providerCalls).toBe(0);
  });

  it('Pro Max can use AI, subject to the school AI switch', async () => {
    setAiProviderForTests(fakeProvider);
    providerCalls = 0;
    expect((await copilot(schools.pro_max.ownerToken)).status).toBe(200);
    expect(providerCalls).toBe(1);
    await api(t.app, schools.pro_max.ownerToken, 'patch', '/school/settings', { ai: { enabled: false } });
    expect((await copilot(schools.pro_max.ownerToken)).body.error.code).toBe('AI_UNAVAILABLE');
    await api(t.app, schools.pro_max.ownerToken, 'patch', '/school/settings', { ai: { enabled: true } });
  });

  it('only a dedicated mobile client needs the mobile-app entitlement', async () => {
    const asApp = (token: string, app: string) =>
      request(t.app).get('/api/v1/students').set(auth(token)).set('X-Client-App', app);
    const basicApp = await asApp(schools.basic.parentToken, 'parent-mobile');
    expect(basicApp.status).toBe(403);
    expect(basicApp.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await asApp(schools.pro.parentToken, 'parent-mobile')).status).toBe(200);
    expect((await asApp(schools.pro.teacherToken, 'teacher-mobile')).status).toBe(200);
    expect((await asApp(schools.pro.parentToken, 'something-else')).status).toBe(403);
    // The web portal (no header) works on Basic.
    expect((await p(schools.basic.parentToken, 'get', '/students')).status).toBe(200);
  });
});

describe('Upgrades, downgrades and overrides', () => {
  it('upgrade and downgrade apply on the next request with the same session, without deleting data', async () => {
    setAiProviderForTests(fakeProvider);
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'basic');
    const usersBefore = await User.find({ schoolId: s.schoolId }).select('_id').lean();
    expect((await copilot(s.principalToken)).status).toBe(403);

    // Platform admins may not change plans; a confirmation is required.
    expect(
      (
        await p(admin.token, 'post', `/platform/schools/${s.schoolId}/plan-change`, {
          planCode: 'pro_max',
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await p(owner.token, 'post', `/platform/schools/${s.schoolId}/plan-change`, { planCode: 'pro_max' })).status,
    ).toBe(400);
    const preview = await pd(
      owner.token,
      'get',
      `/platform/schools/${s.schoolId}/plan-change/preview?planCode=pro_max`,
    );
    expect(preview.gained.map((f: any) => f.key).sort()).toEqual([...AI_ENTITLEMENTS, ...MOBILE_FEATURES].sort());
    expect(preview.lost).toEqual([]);

    await moveTo(s.schoolId, 'pro_max'); // upgrade
    expect((await copilot(s.principalToken)).status).toBe(200); // same token, no new sign-in
    const usage = await AiUsage.countDocuments({ schoolId: s.schoolId });
    expect(usage).toBeGreaterThan(0);

    await moveTo(s.schoolId, 'basic'); // downgrade
    const denied = await copilot(s.principalToken);
    expect(denied.status).toBe(403);
    // Nothing deleted: users, students and the AI history are all kept and still readable.
    expect(await AiUsage.countDocuments({ schoolId: s.schoolId })).toBe(usage);
    expect((await User.find({ schoolId: s.schoolId }).select('_id').lean()).length).toBe(usersBefore.length);
    expect((await p(s.principalToken, 'get', '/students')).body.data.length).toBe(1);
    expect((await p(s.principalToken, 'get', '/ai/usage?from=2020-01-01&to=2099-12-31')).status).toBe(200);

    await moveTo(s.schoolId, 'pro_max'); // re-upgrade
    expect((await copilot(s.principalToken)).status).toBe(200);

    const log = await AuditLog.find({ action: 'platform.subscription.plan_changed', entityId: s.schoolId })
      .sort({ createdAt: 1 })
      .lean();
    expect(log.length).toBeGreaterThanOrEqual(4);
    const downgrade = log.find((l: any) => l.metadata?.previousPlan === 'pro_max' && l.metadata?.newPlan === 'basic');
    expect(downgrade!.metadata.featuresLost).toEqual(expect.arrayContaining(AI_ENTITLEMENTS));
  });

  it('a plan-template change reaches signed-in users on their next request (cache refreshed)', async () => {
    setAiProviderForTests(fakeProvider);
    const s = await buildSchool(t.app, { students: 1 });
    const plan = await pd(owner.token, 'post', '/platform/plans', {
      code: 'cachetest',
      name: 'Cache',
      priceMonthlyPkr: 1,
      features: [...FEATURE_KEYS],
    });
    await moveTo(s.schoolId, 'cachetest');
    expect((await copilot(s.ownerToken)).status).toBe(200);
    await pd(owner.token, 'put', `/platform/plans/${plan._id}/draft`, {
      features: FEATURE_KEYS.filter((f) => f !== 'ai.copilot'),
    });
    await pd(owner.token, 'post', `/platform/plans/${plan._id}/publish`, { applyTo: 'all_subscribers', confirm: true });
    expect((await copilot(s.ownerToken)).status).toBe(403);
  });

  it('school overrides grant and revoke features without touching the plan; a revoke beats the plan', async () => {
    setAiProviderForTests(fakeProvider);
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'basic');
    const before = await Plan.findOne({ code: 'basic' }).lean();
    await pd(owner.token, 'put', `/platform/schools/${s.schoolId}/feature-overrides`, {
      overrides: [
        { feature: 'ai.copilot', mode: 'grant', reason: 'Negotiated pilot' },
        { feature: 'core.fees', mode: 'revoke', reason: 'Uses another fee system' },
      ],
    });
    expect((await copilot(s.ownerToken)).status).toBe(200);
    const fees = await p(s.ownerToken, 'get', '/fees/invoices');
    expect(fees.status).toBe(403);
    expect(fees.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await Plan.findOne({ code: 'basic' }).lean())!.features).toEqual(before!.features);
    // Another Basic school is unaffected.
    const other = await buildSchool(t.app, { students: 1 });
    await moveTo(other.schoolId, 'basic');
    expect((await copilot(other.ownerToken)).status).toBe(403);
    // Overrides survive a plan change.
    await moveTo(s.schoolId, 'pro_max');
    expect((await p(s.ownerToken, 'get', '/fees/invoices')).status).toBe(403);
    // One entry in the school’s own audit log and one in the platform log.
    expect(
      await AuditLog.countDocuments({ action: 'platform.subscription.overrides_changed', entityId: s.schoolId }),
    ).toBe(2);
  });

  it('rejects invalid overrides and leaves the old ones in place', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'pro_max');
    const url = `/platform/schools/${s.schoolId}/feature-overrides`;
    expect(
      (await p(owner.token, 'put', url, { overrides: [{ feature: 'portal.parents', mode: 'revoke' }] })).status,
    ).toBe(400);
    expect((await p(owner.token, 'put', url, { overrides: [{ feature: 'ai.teleport', mode: 'grant' }] })).status).toBe(
      400,
    );
    const dep = await p(owner.token, 'put', url, { overrides: [{ feature: 'core.reports', mode: 'revoke' }] });
    expect(dep.status).toBe(400);
    expect(dep.body.error.code).toBe('INVALID_OVERRIDES');
    expect((await p(admin.token, 'put', url, { overrides: [] })).status).toBe(403);
    expect((await School.findById(s.schoolId).lean())!.subscription!.featureOverrides).toEqual([]);
  });

  it('a failed plan change leaves the subscription exactly as it was', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'pro');
    const before = (await School.findById(s.schoolId).lean())!.subscription;
    expect(
      (await p(owner.token, 'post', `/platform/schools/${s.schoolId}/plan-change`, { planCode: 'nope', confirm: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await p(owner.token, 'post', `/platform/schools/${s.schoolId}/plan-change`, {
          planCode: 'basic',
          billingPeriod: 'yearly',
          confirm: true,
        })
      ).status,
    ).toBe(400); // Basic is not sold yearly
    expect((await School.findById(s.schoolId).lean())!.subscription).toEqual(before);
  });
});

describe('Security and subscription status', () => {
  it('schools cannot read or change plans, other schools’ subscriptions or their own entitlements', async () => {
    const a = await buildSchool(t.app, { students: 1 });
    const b = await buildSchool(t.app, { students: 1 });
    await moveTo(a.schoolId, 'basic');
    await moveTo(b.schoolId, 'pro_max');
    for (const [m, url] of [
      ['get', '/platform/plans'],
      ['get', `/platform/schools/${b.schoolId}/entitlements`],
      ['post', `/platform/schools/${a.schoolId}/plan-change`],
      ['put', `/platform/schools/${a.schoolId}/feature-overrides`],
    ] as const)
      expect((await p(a.ownerToken, m, url, { planCode: 'pro_max', confirm: true, overrides: [] })).status, url).toBe(
        401,
      );
    // Client-supplied "entitlements" are ignored: only the saved subscription counts.
    await p(a.ownerToken, 'patch', '/school/settings', {
      subscription: { planId: b.schoolId },
      entitlements: FEATURE_KEYS,
    });
    expect((await copilot(a.ownerToken)).status).toBe(403);
    expect((await api(t.app, a.ownerToken, 'get', '/entitlements')).plan.code).toBe('basic');
  });

  it('unknown features are always denied, and an inactive subscription loses AI but stays readable', async () => {
    const ent = computeEntitlements({ status: 'active' }, null);
    expect(() => assertEntitled(ent, ['ai.copilot'])).toThrow(/not included/);
    expect(() => assertEntitled({ features: new Set(['x.y']), eligible: true }, ['x.y'])).toThrow();
    const expired = computeEntitlements(
      { status: 'expired' },
      { _id: null as never, code: 'x', name: 'X', features: [...FEATURE_KEYS] },
    );
    expect(expired.eligible).toBe(false);
    for (const f of [...AI_ENTITLEMENTS, ...MOBILE_FEATURES]) expect(expired.features.has(f)).toBe(false);

    setAiProviderForTests(fakeProvider);
    const s = await buildSchool(t.app, { students: 1 });
    await moveTo(s.schoolId, 'pro_max');
    await pd(admin.token, 'put', `/platform/schools/${s.schoolId}/subscription`, { status: 'expired' });
    const insights = await p(s.ownerToken, 'get', '/ai/insights');
    expect(insights.status).toBe(403);
    expect(insights.body.error.message).toMatch(/inactive/);
    expect((await p(s.ownerToken, 'get', '/students')).status).toBe(200); // read-only access stays
    expect((await p(s.ownerToken, 'post', '/academics/subjects', { name: 'Art', code: 'ART' })).status).toBe(402);
    await pd(admin.token, 'put', `/platform/schools/${s.schoolId}/subscription`, { status: 'active' });
    expect((await copilot(s.ownerToken)).status).toBe(200);
  });
});

describe('Onboarding and existing schools', () => {
  it('creating a school with a plan applies its features, agreed price and overrides', async () => {
    const res = await pd(owner.token, 'post', '/platform/schools', {
      name: 'Plan School',
      code: 'PLANSC',
      planCode: 'pro',
      billingPeriod: 'monthly',
      featureOverrides: [{ feature: 'ai.copilot', mode: 'grant', reason: 'Launch offer' }],
      owner: { name: 'Plan Owner', email: 'owner@plansc.test' },
    });
    const token = await login(t.app, 'owner@plansc.test', res.temporaryPassword);
    expect(await entitled(token)).toEqual([...CORE_FEATURES, ...MOBILE_FEATURES, 'ai.copilot'].sort());
    const sub = await pd(owner.token, 'get', `/platform/schools/${res.school._id}/entitlements`);
    expect(sub.agreedPrice).toMatchObject({ currency: 'PKR', period: 'monthly' });
    expect(sub.status).toBe('trialing');
    // Archived plans cannot be chosen, and overrides are for the platform owner only.
    const archived = await p(owner.token, 'post', '/platform/schools', {
      name: 'Nope',
      code: 'NOPE1',
      planCode: 'legacy_x',
      owner: { name: 'Nobody', email: 'n@nope.test' },
    });
    expect(archived.status).toBe(404);
    const adminOverride = await p(admin.token, 'post', '/platform/schools', {
      name: 'Nope',
      code: 'NOPE2',
      planCode: 'basic',
      featureOverrides: [{ feature: 'ai.copilot', mode: 'grant' }],
      owner: { name: 'Nobody', email: 'n2@nope.test' },
    });
    expect(adminOverride.status).toBe(403);
    expect(await School.exists({ code: 'NOPE2' })).toBeNull();
  });

  it('old plan features are read safely: no premium features are granted by a missing or old plan', async () => {
    const noPlan = computeEntitlements({ status: 'active' }, null);
    expect([...noPlan.features].sort()).toEqual([...CORE_FEATURES].sort());
    const starter = computeEntitlements(
      { status: 'active' },
      { _id: null as never, code: 's', name: 'S', features: ['core', 'parent_portal'] },
    );
    expect([...starter.features].sort()).toEqual([...CORE_FEATURES].sort());
    const growth = computeEntitlements(
      { status: 'active' },
      { _id: null as never, code: 'g', name: 'G', features: ['core', 'ai_copilot'] },
    );
    for (const f of AI_ENTITLEMENTS) expect(growth.features.has(f)).toBe(true);
    for (const f of MOBILE_FEATURES) expect(growth.features.has(f)).toBe(false);

    // The migration converts stored legacy features without changing what schools can use.
    const legacy = await Plan.create({
      code: 'starter_old',
      name: 'Starter',
      priceMonthlyPkr: 2500,
      features: ['core', 'parent_portal', 'priority_support'],
    });
    const r = await migratePlanEntitlements(true, () => undefined);
    expect(r.templatesCreated).toEqual([]);
    const migrated = await Plan.findById(legacy._id).lean();
    expect([...migrated!.features].sort()).toEqual([...CORE_FEATURES].sort());
    expect(migrated!.highlights).toContain('Priority support');
    expect(migrated!.prices!.monthly).toEqual({ amount: 2500, enabled: true });
    expect((await migratePlanEntitlements(true, () => undefined)).plansUpdated).toEqual([]); // idempotent
  });
});
