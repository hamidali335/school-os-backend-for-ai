import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import {
  CORE_FEATURES,
  featureDef,
  FEATURES,
  isFeatureKey,
  normaliseFeatures,
  REQUIRED_FEATURES,
  validateFeatureSet,
  type FeatureKey,
} from '../../config/entitlements';
import type { PlatformContext } from '../../types/context';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { z } from '../../utils/zod';
import { audit, auditPlatformOnSchool } from '../audit/audit.service';
import { School } from '../schools/school.model';
import {
  computeEntitlements,
  describeEntitlements,
  invalidatePlanCache,
  type SubscriptionLike,
} from './entitlements.service';
import { BILLING_PERIODS, Plan, SUBSCRIBER_POLICIES, type BillingPeriod } from './plan.model';

// ───────────────────────────── Plan configuration ─────────────────────────────

const Money = z.number().int().min(0).max(100_000_000);

/** Everything about a plan the Platform Owner can edit (the stable `code` is set once, at creation). */
export const PlanConfig = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).optional(),
  highlights: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  badge: z.string().trim().max(30).optional(),
  displayOrder: z.number().int().min(0).max(10_000).optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'Use a 3-letter currency code such as PKR')
    .optional(),
  prices: z
    .object({
      monthly: z.object({ amount: Money, enabled: z.boolean() }),
      yearly: z.object({ amount: Money, enabled: z.boolean() }),
    })
    .optional(),
  trialDays: z.number().int().min(0).max(180).optional(),
  limits: z
    .object({
      maxStudents: z.number().int().min(1),
      maxCampuses: z.number().int().min(1),
      maxStaffUsers: z.number().int().min(1),
      aiMonthlyTokens: z.number().int().min(0),
      messagesPerMonth: z.number().int().min(0),
    })
    .partial()
    .optional(),
  features: z.array(z.string().max(60)).max(100).optional(),
  /** Offered to new schools. */
  isActive: z.boolean().optional(),
});
export type PlanConfigInput = z.infer<typeof PlanConfig>;

type PlanRecord = Record<string, any>;

/** The editable configuration of a stored plan (published fields), legacy features translated. */
export function configOf(plan: PlanRecord) {
  const monthlyAmount = plan.prices?.monthly?.amount ?? plan.priceMonthlyPkr ?? 0;
  return {
    name: plan.name as string,
    description: (plan.description as string | undefined) ?? '',
    highlights: (plan.highlights as string[] | undefined) ?? [],
    badge: (plan.badge as string | undefined) ?? '',
    displayOrder: (plan.displayOrder as number | undefined) ?? 100,
    currency: (plan.currency as string | undefined) ?? 'PKR',
    prices: {
      monthly: { amount: monthlyAmount, enabled: plan.prices?.monthly?.enabled ?? true },
      yearly: { amount: plan.prices?.yearly?.amount ?? 0, enabled: plan.prices?.yearly?.enabled ?? false },
    },
    trialDays: (plan.trialDays as number | undefined) ?? 14,
    limits: { ...(plan.limits ?? {}) },
    features: normaliseFeatures(plan.features) as string[],
    isActive: plan.isActive !== false,
  };
}
export type PlanConfigFull = ReturnType<typeof configOf>;

function merge(base: PlanConfigFull, patch: Partial<PlanConfigInput>): PlanConfigFull {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    prices: patch.prices ?? base.prices,
    features: patch.features ? [...new Set(patch.features)] : base.features,
    currency: (patch.currency ?? base.currency).toUpperCase(),
  } as PlanConfigFull;
}

/** Server-side validation of a full configuration. Problems are returned, not thrown. */
export function planProblems(cfg: PlanConfigFull) {
  const problems: Array<{ path: string; message: string }> = validateFeatureSet(cfg.features).map((p) => ({
    path: `features.${p.feature}`,
    message: p.message,
  }));
  if (!cfg.prices.monthly.enabled && !cfg.prices.yearly.enabled)
    problems.push({ path: 'prices', message: 'Enable at least one billing period (monthly or yearly).' });
  return problems;
}

function assertValid(cfg: PlanConfigFull) {
  const problems = planProblems(cfg);
  if (problems.length) throw badRequest('This plan configuration is not valid', problems, 'INVALID_PLAN_CONFIG');
}

/** Published fields to $set for a configuration (keeps the legacy monthly mirror in sync). */
function publishedFields(cfg: PlanConfigFull) {
  return {
    name: cfg.name,
    description: cfg.description,
    highlights: cfg.highlights,
    badge: cfg.badge,
    displayOrder: cfg.displayOrder,
    currency: cfg.currency,
    prices: cfg.prices,
    priceMonthlyPkr: cfg.prices.monthly.amount,
    trialDays: cfg.trialDays,
    limits: cfg.limits,
    features: cfg.features,
    isActive: cfg.isActive,
  };
}

export const isAssignable = (plan: PlanRecord) => !plan.archivedAt && plan.published !== false;

// ───────────────────────────── Queries ─────────────────────────────

async function subscriberCounts(planIds: Types.ObjectId[]) {
  const rows = await School.aggregate([
    { $match: { 'subscription.planId': { $in: planIds } } },
    { $group: { _id: '$subscription.planId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n as number]));
}

export function planView(plan: PlanRecord, subscribers = 0) {
  return {
    _id: plan._id,
    code: plan.code,
    ...configOf(plan),
    // Legacy fields kept for older clients.
    priceMonthlyPkr: configOf(plan).prices.monthly.amount,
    published: plan.published !== false,
    archived: Boolean(plan.archivedAt),
    archivedAt: plan.archivedAt?.toISOString?.() ?? null,
    version: plan.version ?? 1,
    publishedAt: plan.publishedAt?.toISOString?.() ?? null,
    draft: plan.draft ? { ...plan.draft, features: normaliseFeatures(plan.draft.features) } : null,
    subscribers,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export async function listPlans() {
  const plans = await Plan.find().sort({ displayOrder: 1, priceMonthlyPkr: 1, name: 1 }).lean();
  const counts = await subscriberCounts(plans.map((p) => p._id));
  return plans.map((p) => planView(p, counts.get(String(p._id)) ?? 0));
}

export async function getPlan(id: string) {
  const plan = await Plan.findById(id).lean();
  if (!plan) throw notFound('Plan');
  const schools = await School.find({ 'subscription.planId': plan._id })
    .select('name code status subscription')
    .sort({ name: 1 })
    .lean();
  return {
    ...planView(plan, schools.length),
    schools: schools.map((s) => ({
      _id: s._id,
      name: s.name,
      code: s.code,
      status: s.status,
      subscriptionStatus: s.subscription?.status ?? 'trialing',
      billingPeriod: s.subscription?.billingPeriod ?? null,
      agreedPrice: s.subscription?.agreedPrice?.amount ?? null,
      currency: s.subscription?.agreedPrice?.currency ?? null,
      grandfathered: Boolean(s.subscription?.lockedFeatures?.length),
      overrides: s.subscription?.featureOverrides?.length ?? 0,
    })),
  };
}

// ───────────────────────────── Create / draft / publish ─────────────────────────────

export async function createPlan(ctx: PlatformContext, code: string, input: PlanConfigInput, publish: boolean) {
  const normalised = code.toLowerCase();
  if (await Plan.exists({ code: normalised }))
    throw conflict('A plan with this code already exists', undefined, 'DUPLICATE');
  const defaults: PlanConfigFull = {
    name: input.name,
    description: '',
    highlights: [],
    badge: '',
    displayOrder: 100,
    currency: 'PKR',
    prices: { monthly: { amount: 0, enabled: true }, yearly: { amount: 0, enabled: false } },
    trialDays: 14,
    limits: {},
    // No feature list given: the core product (no AI, no mobile apps).
    features: CORE_FEATURES,
    isActive: publish,
  };
  const cfg = merge(defaults, input);
  if (!publish) cfg.isActive = false;
  assertValid(cfg);
  const plan = await Plan.create({
    code: normalised,
    ...publishedFields(cfg),
    published: publish,
    version: publish ? 1 : 0,
    publishedAt: publish ? new Date() : undefined,
    publishedBy: publish ? ctx.adminId : undefined,
    draft: publish ? undefined : { ...cfg, updatedAt: new Date(), updatedBy: ctx.adminId },
  });
  invalidatePlanCache();
  await audit(ctx, {
    action: 'platform.plan.created',
    entityType: 'Plan',
    entityId: plan._id,
    summary: `${cfg.name} (${normalised})`,
    metadata: { published: publish, config: cfg },
  });
  return planView(plan.toObject());
}

/** Save edits as a draft. Invalid drafts are rejected; the published configuration never changes here. */
export async function saveDraft(ctx: PlatformContext, id: string, input: Partial<PlanConfigInput>) {
  const plan = await Plan.findById(id).lean();
  if (!plan) throw notFound('Plan');
  if (plan.archivedAt) throw conflict('Restore this plan before editing it');
  const base = plan.draft ? merge(configOf(plan), plan.draft as PlanConfigInput) : configOf(plan);
  const cfg = merge(base, input);
  assertValid(cfg);
  await Plan.updateOne(
    { _id: plan._id },
    { $set: { draft: { ...cfg, updatedAt: new Date(), updatedBy: ctx.adminId } } },
  );
  await audit(ctx, { action: 'platform.plan.draft_saved', entityType: 'Plan', entityId: plan._id, summary: plan.code });
  return getPlan(id);
}

export async function discardDraft(ctx: PlatformContext, id: string) {
  const plan = await Plan.findById(id).select('code draft published').lean();
  if (!plan) throw notFound('Plan');
  if (plan.published === false) throw conflict('This plan has never been published; archive it instead');
  await Plan.updateOne({ _id: plan._id }, { $unset: { draft: 1 } });
  await audit(ctx, {
    action: 'platform.plan.draft_discarded',
    entityType: 'Plan',
    entityId: plan._id,
    summary: plan.code,
  });
  return getPlan(id);
}

const featureNames = (keys: string[]) => keys.map((k) => ({ key: k, name: featureDef(k)?.name ?? k }));

/**
 * The stored version as written in the database. Plans saved before versioning (or before
 * `npm run migrate:plan-entitlements`) have no `version` field; they count as version 1, and
 * the concurrency check below must match that missing value, not a literal 1.
 */
const storedVersion = (plan: PlanRecord): number | null => (typeof plan.version === 'number' ? plan.version : null);

/**
 * What a reviewer saw: the published version and the exact draft. Publishing requires the same
 * revision, so changes saved by someone else after the review are never published unseen.
 */
export function planRevision(plan: PlanRecord): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([plan.version ?? 1, plan.draft ?? null]))
    .digest('base64url')
    .slice(0, 22);
}

/** What publishing the draft would change. */
export async function previewDraft(id: string) {
  const plan = await Plan.findById(id).lean();
  if (!plan) throw notFound('Plan');
  return previewOf(plan);
}

async function previewOf(plan: PlanRecord) {
  if (!plan.draft) throw badRequest('This plan has no unpublished changes');
  const before = configOf(plan);
  const after = merge(before, plan.draft as PlanConfigInput);
  const added = after.features.filter((f) => !before.features.includes(f));
  const removed = before.features.filter((f) => !after.features.includes(f));
  const schools = plan.published === false ? 0 : await School.countDocuments({ 'subscription.planId': plan._id });
  const warnings: string[] = [];
  if (removed.length && schools)
    warnings.push(
      `${schools} school(s) on this plan would lose ${removed.length} feature(s) if the change applies to existing subscribers. Choose “new subscribers only” to keep their current features.`,
    );
  for (const f of after.features)
    if (featureDef(f)?.availability === 'coming_soon')
      warnings.push(
        `${featureDef(f)!.name} is not released yet. Schools see it as “coming soon”, not as a working feature.`,
      );
  if (
    before.prices.monthly.amount !== after.prices.monthly.amount ||
    before.prices.yearly.amount !== after.prices.yearly.amount
  )
    warnings.push(
      'Price changes apply to new subscriptions. Existing schools keep their agreed price until you apply the new price to them.',
    );
  return {
    planId: plan._id,
    code: plan.code,
    revision: planRevision(plan),
    firstPublish: plan.published === false,
    before,
    after,
    featuresAdded: featureNames(added),
    featuresRemoved: featureNames(removed),
    priceChanges: (['monthly', 'yearly'] as const)
      .map((period) => ({
        period,
        before: before.prices[period],
        after: after.prices[period],
      }))
      .filter((c) => c.before.amount !== c.after.amount || c.before.enabled !== c.after.enabled),
    renamed: before.name !== after.name ? { from: before.name, to: after.name } : null,
    offeredToNewSchools: { before: before.isActive, after: after.isActive },
    schoolsOnPlan: schools,
    problems: planProblems(after),
    warnings,
  };
}

export async function publishDraft(
  ctx: PlatformContext,
  id: string,
  opts: { applyTo: (typeof SUBSCRIBER_POLICIES)[number]; note?: string; expectedRevision?: string },
) {
  // One read: what is published is exactly what this read contains, and the update below only
  // applies if the plan is still in this state.
  const plan = await Plan.findById(id).lean();
  if (!plan) throw notFound('Plan');
  if (opts.expectedRevision && opts.expectedRevision !== planRevision(plan))
    throw conflict(
      'The plan was changed after you reviewed it. Review the new changes before publishing.',
      { revision: planRevision(plan) },
      'PLAN_CHANGED',
    );
  const preview = await previewOf(plan);
  if (preview.problems.length)
    throw badRequest('This plan configuration is not valid', preview.problems, 'INVALID_PLAN_CONFIG');
  const before = preview.before;
  const after = preview.after;
  const featuresChanged = preview.featuresAdded.length > 0 || preview.featuresRemoved.length > 0;
  let grandfathered = 0;
  // Grandfather existing subscribers first: if publishing fails afterwards they still have
  // exactly the features they had, so no school ends up with a partial configuration.
  if (opts.applyTo === 'new_subscribers_only' && featuresChanged && !preview.firstPublish) {
    const r = await School.updateMany(
      { 'subscription.planId': plan._id, 'subscription.lockedFeatures.0': { $exists: false } },
      { $set: { 'subscription.lockedFeatures': before.features } },
    );
    grandfathered = r.modifiedCount;
  }
  // Only publish if nobody published or saved another draft in the meantime (optimistic
  // concurrency on the stored version, which matches a missing field for older plans, and on
  // the draft itself).
  const nextVersion = (plan.version ?? 1) + 1;
  const res = await Plan.updateOne(
    { _id: plan._id, version: storedVersion(plan), draft: plan.draft },
    {
      $set: {
        ...publishedFields(after),
        published: true,
        publishedAt: new Date(),
        publishedBy: ctx.adminId,
        version: nextVersion,
      },
      $unset: { draft: 1 },
    },
  );
  if (!res.modifiedCount)
    throw conflict(
      'The plan was changed after you reviewed it. Review the new changes before publishing.',
      undefined,
      'PLAN_CHANGED',
    );
  invalidatePlanCache();
  await audit(ctx, {
    action: 'platform.plan.published',
    entityType: 'Plan',
    entityId: plan._id,
    summary: `${after.name} (${plan.code}) v${nextVersion}`,
    metadata: {
      applyTo: opts.applyTo,
      note: opts.note,
      featuresAdded: preview.featuresAdded.map((f) => f.key),
      featuresRemoved: preview.featuresRemoved.map((f) => f.key),
      priceChanges: preview.priceChanges,
      renamed: preview.renamed,
      before,
      after,
      grandfatheredSchools: grandfathered,
    },
  });
  return { plan: await getPlan(id), grandfatheredSchools: grandfathered };
}

export async function setArchived(ctx: PlatformContext, id: string, archived: boolean, note?: string) {
  const plan = await Plan.findById(id).lean();
  if (!plan) throw notFound('Plan');
  if (archived === Boolean(plan.archivedAt))
    throw conflict(archived ? 'Plan is already archived' : 'Plan is not archived');
  await Plan.updateOne(
    { _id: plan._id },
    archived ? { $set: { archivedAt: new Date(), isActive: false } } : { $unset: { archivedAt: 1 } },
  );
  invalidatePlanCache();
  await audit(ctx, {
    action: archived ? 'platform.plan.archived' : 'platform.plan.restored',
    entityType: 'Plan',
    entityId: plan._id,
    summary: plan.code,
    metadata: { note },
  });
  return getPlan(id);
}

// ───────────────────────────── Schools: plan, price, overrides ─────────────────────────────

type Override = { feature: string; mode: 'grant' | 'revoke'; reason?: string };

async function loadSchool(id: string) {
  const school = await School.findById(id).select('name code status subscription').lean();
  if (!school) throw notFound('School');
  return school;
}

/** Full entitlement picture for one school (platform view). */
export async function schoolSubscriptionView(id: string) {
  const school = await loadSchool(id);
  const plan = school.subscription?.planId ? await Plan.findById(school.subscription.planId).lean() : null;
  const ent = computeEntitlements(school.subscription as SubscriptionLike, plan);
  return {
    school: { _id: school._id, name: school.name, code: school.code, status: school.status },
    plan: plan ? { _id: plan._id, code: plan.code, name: plan.name, archived: Boolean(plan.archivedAt) } : null,
    status: school.subscription?.status ?? 'trialing',
    eligible: ent.eligible,
    trialEndsAt: school.subscription?.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: school.subscription?.currentPeriodEnd?.toISOString() ?? null,
    billingPeriod: school.subscription?.billingPeriod ?? null,
    agreedPrice: school.subscription?.agreedPrice?.amount != null ? school.subscription.agreedPrice : null,
    currentPlanPrice: plan ? configOf(plan).prices : null,
    grandfatheredFeatures: school.subscription?.lockedFeatures?.length
      ? normaliseFeatures(school.subscription.lockedFeatures)
      : null,
    overrides: (school.subscription?.featureOverrides ?? []).map((o) => ({
      feature: o.feature,
      mode: o.mode,
      reason: o.reason ?? null,
      byName: o.byName ?? null,
      at: o.at?.toISOString() ?? null,
    })),
    features: describeEntitlements(ent.features),
  };
}

function priceFor(plan: PlanRecord, period: BillingPeriod) {
  const cfg = configOf(plan);
  const p = cfg.prices[period];
  if (!p.enabled) throw badRequest(`${cfg.name} is not sold with ${period} billing`, { field: 'billingPeriod' });
  return { amount: p.amount, currency: cfg.currency, period, setAt: new Date() };
}

/** What changing a school to another plan would do (nothing is saved). */
export async function previewPlanChange(id: string, planCode: string) {
  const school = await loadSchool(id);
  const plan = await Plan.findOne({ code: planCode.toLowerCase() }).lean();
  if (!plan) throw badRequest('Unknown plan code', { field: 'planCode' });
  const current = school.subscription?.planId ? await Plan.findById(school.subscription.planId).lean() : null;
  const sub = school.subscription as SubscriptionLike;
  const before = computeEntitlements(sub, current).features;
  // A plan change follows the new plan's features; school overrides are kept.
  const after = computeEntitlements({ ...sub, planId: plan._id, lockedFeatures: null }, plan).features;
  return {
    current: current ? { code: current.code, name: current.name } : null,
    proposed: {
      code: plan.code,
      name: plan.name,
      assignable: isAssignable(plan),
      prices: configOf(plan).prices,
      currency: configOf(plan).currency,
    },
    gained: featureNames([...after].filter((f) => !before.has(f))),
    lost: featureNames([...before].filter((f) => !after.has(f))),
    overridesKept: (school.subscription?.featureOverrides ?? []).length,
    subscriptionEligible: computeEntitlements(sub, plan).eligible,
  };
}

/** Upgrade or downgrade. Users, data and overrides are kept; billing state is not invented. */
export async function changeSchoolPlan(
  ctx: PlatformContext,
  id: string,
  input: { planCode: string; billingPeriod?: BillingPeriod; note?: string },
) {
  const school = await loadSchool(id);
  const plan = await Plan.findOne({ code: input.planCode.toLowerCase() }).lean();
  if (!plan) throw badRequest('Unknown plan code', { field: 'planCode' });
  if (!isAssignable(plan)) throw conflict('This plan is archived or not published, so it cannot be assigned');
  const preview = await previewPlanChange(id, input.planCode);
  const period: BillingPeriod =
    input.billingPeriod ??
    (school.subscription?.billingPeriod as BillingPeriod | undefined) ??
    (configOf(plan).prices.monthly.enabled ? 'monthly' : 'yearly');
  const samePlan = String(school.subscription?.planId ?? '') === String(plan._id);
  await School.updateOne(
    { _id: school._id },
    {
      $set: {
        'subscription.planId': plan._id,
        'subscription.billingPeriod': period,
        'subscription.agreedPrice': priceFor(plan, period),
        'subscription.planChangedAt': new Date(),
      },
      $unset: { 'subscription.lockedFeatures': 1 },
    },
  );
  const detail = {
    previousPlan: preview.current?.code ?? null,
    newPlan: plan.code,
    billingPeriod: period,
    featuresGained: preview.gained.map((f) => f.key),
    featuresLost: preview.lost.map((f) => f.key),
    note: input.note,
    samePlan,
  };
  await auditPlatformOnSchool(ctx, id, {
    action: 'platform.subscription.plan_changed',
    entityType: 'School',
    entityId: id,
    metadata: detail,
  });
  await audit(ctx, {
    action: 'platform.subscription.plan_changed',
    entityType: 'School',
    entityId: id,
    summary: `${school.name}: ${preview.current?.name ?? 'no plan'} → ${plan.name}`,
    metadata: detail,
  });
  return schoolSubscriptionView(id);
}

/** Explicitly move a school to the plan's current price (never automatic). */
export async function applyCurrentPrice(ctx: PlatformContext, id: string, note?: string) {
  const school = await loadSchool(id);
  if (!school.subscription?.planId) throw badRequest('This school has no plan');
  const plan = await Plan.findById(school.subscription.planId).lean();
  if (!plan) throw notFound('Plan');
  const period = (school.subscription.billingPeriod as BillingPeriod | undefined) ?? 'monthly';
  const next = priceFor(plan, period);
  const previous = school.subscription.agreedPrice?.amount != null ? school.subscription.agreedPrice : null;
  await School.updateOne(
    { _id: school._id },
    { $set: { 'subscription.agreedPrice': next, 'subscription.billingPeriod': period } },
  );
  const detail = { previous, next, note };
  await auditPlatformOnSchool(ctx, id, {
    action: 'platform.subscription.price_applied',
    entityType: 'School',
    entityId: id,
    metadata: detail,
  });
  await audit(ctx, {
    action: 'platform.subscription.price_applied',
    entityType: 'School',
    entityId: id,
    metadata: detail,
  });
  return schoolSubscriptionView(id);
}

/** Replace a school's feature overrides. Validated so the effective set stays consistent. */
/** Throws unless the overrides are valid for this subscription and plan. */
export function checkOverrides(
  sub: SubscriptionLike | null | undefined,
  plan: PlanRecord | null,
  overrides: Override[],
) {
  const seen = new Set<string>();
  for (const o of overrides) {
    if (!isFeatureKey(o.feature)) throw badRequest(`Unknown feature “${o.feature}”`, { field: 'overrides' });
    if (seen.has(o.feature)) throw badRequest(`${featureDef(o.feature)!.name} is listed twice`, { field: 'overrides' });
    seen.add(o.feature);
    if (o.mode === 'revoke' && REQUIRED_FEATURES.includes(o.feature as FeatureKey))
      throw badRequest(`${featureDef(o.feature)!.name} is part of every plan and cannot be revoked`, {
        field: 'overrides',
      });
  }
  // Dependencies are checked on what the school would actually get (ignoring subscription status).
  const after = computeEntitlements(
    { ...sub, status: 'active', trialEndsAt: null, featureOverrides: overrides },
    plan as never,
  ).features;
  const problems = validateFeatureSet([...after]);
  if (problems.length)
    throw badRequest(
      'These overrides leave the school with an inconsistent feature set',
      problems,
      'INVALID_OVERRIDES',
    );
}

export async function setOverrides(ctx: PlatformContext, id: string, overrides: Override[], note?: string) {
  const school = await loadSchool(id);
  const plan = school.subscription?.planId ? await Plan.findById(school.subscription.planId).lean() : null;
  const sub = school.subscription as SubscriptionLike;
  checkOverrides(sub, plan, overrides);
  const before = computeEntitlements(sub, plan).features;
  const previous = (school.subscription?.featureOverrides ?? []).map((o) => ({ feature: o.feature, mode: o.mode }));
  await School.updateOne(
    { _id: school._id },
    {
      $set: {
        'subscription.featureOverrides': overrides.map((o) => ({
          feature: o.feature,
          mode: o.mode,
          reason: o.reason,
          by: ctx.adminId,
          byName: ctx.name,
          at: new Date(),
        })),
      },
    },
  );
  const nowFeatures = computeEntitlements({ ...sub, featureOverrides: overrides }, plan).features;
  const detail = {
    previous,
    next: overrides.map((o) => ({ feature: o.feature, mode: o.mode, reason: o.reason })),
    featuresGained: [...nowFeatures].filter((f) => !before.has(f)),
    featuresLost: [...before].filter((f) => !nowFeatures.has(f)),
    note,
  };
  await auditPlatformOnSchool(ctx, id, {
    action: 'platform.subscription.overrides_changed',
    entityType: 'School',
    entityId: id,
    metadata: detail,
  });
  await audit(ctx, {
    action: 'platform.subscription.overrides_changed',
    entityType: 'School',
    entityId: id,
    metadata: detail,
  });
  return schoolSubscriptionView(id);
}

/** For the school app: which offered plans include a feature the school does not have. */
export async function plansIncluding() {
  const plans = await Plan.find({ archivedAt: null, published: { $ne: false }, isActive: { $ne: false } })
    .select('code name features displayOrder priceMonthlyPkr')
    .sort({ displayOrder: 1, priceMonthlyPkr: 1 })
    .lean();
  const out = new Map<string, string[]>();
  for (const f of FEATURES)
    out.set(
      f.key,
      plans.filter((p) => normaliseFeatures(p.features).includes(f.key)).map((p) => p.name),
    );
  return out;
}

export { BILLING_PERIODS, SUBSCRIBER_POLICIES };
