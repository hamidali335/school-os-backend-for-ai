import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { CORE_FEATURES } from '../src/config/entitlements';
import { AuditLog } from '../src/modules/audit/audit.model';
import { School } from '../src/modules/schools/school.model';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { auth, createPlatformAdmin, useTestApp } from './helpers';
import { api, buildSchool } from './fixtures';

/**
 * Publishing an edited plan (platform owner). Regression for the permanent false conflict
 * ("The plan changed while you were reviewing it") on plans whose stored document has no
 * `version` field, and for publishing only exactly what was reviewed.
 */
const t = useTestApp();
let token: string;
const p = (method: 'get' | 'post' | 'put', url: string, body?: unknown) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);
// The body the admin panel sends when saving (every editable field).
const full = (features: string[]) => ({
  name: 'Enterprise',
  description: '',
  highlights: [],
  badge: '',
  displayOrder: 100,
  currency: 'PKR',
  prices: { monthly: { amount: 9000, enabled: true }, yearly: { amount: 0, enabled: false } },
  trialDays: 14,
  limits: {},
  features,
  isActive: true,
});
let n = 0;
async function newPlan(published = true) {
  const res = await p('post', '/platform/plans', {
    code: `ent${++n}`,
    ...full([...CORE_FEATURES]),
    publish: published,
  });
  expect(res.status).toBe(201);
  return res.body.data._id as string;
}
const saveDraft = (id: string, features: string[]) => p('put', `/platform/plans/${id}/draft`, full(features));
const review = async (id: string) => (await p('get', `/platform/plans/${id}/draft/preview`)).body.data;
const publish = (id: string, expectedRevision?: string, applyTo = 'all_subscribers') =>
  p('post', `/platform/plans/${id}/publish`, {
    applyTo,
    confirm: true,
    ...(expectedRevision ? { expectedRevision } : {}),
  });

beforeAll(async () => {
  token = (await createPlatformAdmin(t.app, 'platform_owner')).token;
});

describe('publishing an edited plan', () => {
  it('a Features edit on a plan without a stored version publishes (it used to conflict forever)', async () => {
    const id = await newPlan();
    await Plan.collection.updateOne({ code: `ent${n}` }, { $unset: { version: 1 } });
    expect((await saveDraft(id, [...CORE_FEATURES, 'ai.copilot'])).status).toBe(200);
    const r = await review(id);
    expect(r.featuresAdded.map((f: { key: string }) => f.key)).toEqual(['ai.copilot']);
    const res = await publish(id, r.revision);
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toMatchObject({ version: 2, draft: null });
    expect(res.body.data.plan.features).toContain('ai.copilot');
    expect(await AuditLog.exists({ action: 'platform.plan.published', entityId: id })).toBeTruthy();
    // The next edit works too (no lingering conflict).
    await saveDraft(id, [...CORE_FEATURES]);
    expect((await publish(id, (await review(id)).revision)).body.data.plan.version).toBe(3);
  });

  it('a null stored version is treated the same way', async () => {
    const id = await newPlan();
    await Plan.collection.updateOne({ code: `ent${n}` }, { $set: { version: null } });
    await saveDraft(id, [...CORE_FEATURES, 'ai.copilot']);
    expect((await publish(id, (await review(id)).revision)).status).toBe(200);
  });

  it('with schools on the plan: "new subscribers only" keeps their features, and they are counted', async () => {
    const id = await newPlan();
    const s = await buildSchool(t.app, { students: 1 });
    await p('post', `/platform/schools/${s.schoolId}/plan-change`, { planCode: `ent${n}`, confirm: true });
    await Plan.collection.updateOne({ code: `ent${n}` }, { $unset: { version: 1 } });
    await saveDraft(
      id,
      CORE_FEATURES.filter((f) => f !== 'core.payroll'),
    );
    const r = await review(id);
    expect(r.schoolsOnPlan).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/would lose/);
    const res = await publish(id, r.revision, 'new_subscribers_only');
    expect(res.status).toBe(200);
    expect(res.body.data.grandfatheredSchools).toBe(1);
    const school = await School.findById(s.schoolId).lean();
    expect(school!.subscription!.lockedFeatures).toContain('core.payroll');
    const ent = await api(t.app, s.ownerToken, 'get', '/entitlements');
    expect(ent.features.find((f: { key: string }) => f.key === 'core.payroll').entitled).toBe(true);
  });

  it('a first publication of an unpublished plan, then an edit', async () => {
    const id = await newPlan(false);
    await saveDraft(id, [...CORE_FEATURES, 'ai.copilot']);
    expect((await publish(id, (await review(id)).revision)).body.data.plan).toMatchObject({
      published: true,
      version: 1,
    });
    await saveDraft(id, [...CORE_FEATURES]);
    expect((await publish(id, (await review(id)).revision)).body.data.plan.version).toBe(2);
  });
});

describe('real concurrent changes still conflict, and nothing unreviewed is published', () => {
  it('a draft saved by someone else after the review: 409 PLAN_CHANGED, nothing published', async () => {
    const id = await newPlan();
    await saveDraft(id, [...CORE_FEATURES, 'ai.copilot']);
    const seen = await review(id);
    await saveDraft(id, [...CORE_FEATURES, 'ai.insights', 'core.reports']);
    const res = await publish(id, seen.revision);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGED');
    const plan = await Plan.findById(id).lean();
    expect(plan!.features).not.toContain('ai.copilot');
    expect(plan!.features).not.toContain('ai.insights');
    expect(plan!.draft).toBeTruthy();
    // Reviewing again shows the new draft, and that review publishes.
    const again = await review(id);
    expect(again.revision).not.toBe(seen.revision);
    expect(again.featuresAdded.map((f: { key: string }) => f.key)).toContain('ai.insights');
    expect((await publish(id, again.revision)).status).toBe(200);
  });

  it('published by someone else after the review: the second publish is refused', async () => {
    const id = await newPlan();
    await saveDraft(id, [...CORE_FEATURES, 'ai.copilot']);
    const seen = await review(id);
    expect((await publish(id, seen.revision)).status).toBe(200);
    await saveDraft(id, [...CORE_FEATURES, 'ai.assistant']);
    const stale = await publish(id, seen.revision);
    expect(stale.body.error.code).toBe('PLAN_CHANGED');
  });

  it('two owners publish the same reviewed draft at the same moment: exactly one succeeds', async () => {
    const id = await newPlan();
    await saveDraft(id, [...CORE_FEATURES, 'ai.copilot']);
    const seen = await review(id);
    const [a, b] = await Promise.all([publish(id, seen.revision), publish(id, seen.revision)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await Plan.findById(id).lean())!.version).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'platform.plan.published', entityId: id })).toBe(1);
  });
});
