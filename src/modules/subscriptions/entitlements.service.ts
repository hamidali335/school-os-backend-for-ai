import type { Types } from 'mongoose';
import {
  CORE_FEATURES,
  FEATURES,
  featureDef,
  isFeatureKey,
  normaliseFeatures,
  REQUIRED_FEATURES,
  type FeatureKey,
} from '../../config/entitlements';
import { AppError } from '../../utils/errors';
import { School } from '../schools/school.model';
import { Plan } from './plan.model';

/**
 * Effective entitlements for a school, computed from the saved configuration on every request.
 *
 * Precedence (highest first):
 * 1. Required features (logins, school setup, the parent and teacher web portals) are always on.
 * 2. An explicit school-level REVOKE removes a feature, whatever the plan includes.
 * 3. An explicit school-level GRANT adds a feature the plan does not include.
 * 4. The plan's features: the school's grandfathered snapshot if it has one, otherwise the
 *    plan's published features. A school with no plan gets the core features only (no AI,
 *    no mobile apps).
 * Then the subscription status: an ineligible subscription (cancelled, expired, or a trial that
 * has ended) loses AI and mobile features; core modules stay readable but read-only under the
 * existing write block (see subscriptionAllowsWrites).
 */
export interface SubscriptionLike {
  planId?: Types.ObjectId | null;
  status?: string | null;
  trialEndsAt?: Date | null;
  lockedFeatures?: string[] | null;
  featureOverrides?: Array<{ feature: string; mode: 'grant' | 'revoke' | string }> | null;
}

export interface PlanLike {
  _id: Types.ObjectId;
  code: string;
  name: string;
  features?: string[] | null;
}

/** The existing subscription policy: these states allow normal use. */
export function subscriptionEligible(sub: SubscriptionLike | null | undefined) {
  if (!sub?.status) return true;
  if (sub.status === 'cancelled' || sub.status === 'expired') return false;
  if (sub.status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt.getTime() < Date.now()) return false;
  return true;
}

const PREMIUM_CATEGORIES = new Set(['ai', 'mobile', 'calls']);

export function computeEntitlements(sub: SubscriptionLike | null | undefined, plan: PlanLike | null) {
  const base: FeatureKey[] = sub?.lockedFeatures?.length
    ? normaliseFeatures(sub.lockedFeatures)
    : plan
      ? normaliseFeatures(plan.features)
      : CORE_FEATURES;
  const set = new Set<FeatureKey>(base);
  for (const o of sub?.featureOverrides ?? []) if (o.mode === 'grant' && isFeatureKey(o.feature)) set.add(o.feature);
  for (const o of sub?.featureOverrides ?? [])
    if (o.mode === 'revoke' && isFeatureKey(o.feature)) set.delete(o.feature);
  for (const r of REQUIRED_FEATURES) set.add(r);
  const eligible = subscriptionEligible(sub);
  if (!eligible) for (const k of [...set]) if (PREMIUM_CATEGORIES.has(featureDef(k)!.category)) set.delete(k);
  return { features: set as ReadonlySet<FeatureKey>, eligible };
}

// Plans change rarely and every school request needs one: a short in-process cache, cleared on
// every plan write. Other API instances see a change within PLAN_CACHE_MS at most.
const PLAN_CACHE_MS = 10_000;
const planCache = new Map<string, { at: number; plan: PlanLike | null }>();

export function invalidatePlanCache() {
  planCache.clear();
}

export async function planForEntitlements(
  planId: Types.ObjectId | string | null | undefined,
): Promise<PlanLike | null> {
  if (!planId) return null;
  const key = String(planId);
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_CACHE_MS) return hit.plan;
  const plan = (await Plan.findById(planId).select('code name features').lean()) as PlanLike | null;
  planCache.set(key, { at: Date.now(), plan });
  return plan;
}

/** Entitlements for a school by id (for work outside a request, e.g. the scheduler). */
export async function schoolEntitlements(schoolId: string | Types.ObjectId) {
  const school = await School.findById(schoolId).select('subscription').lean();
  const plan = await planForEntitlements(school?.subscription?.planId);
  return { ...computeEntitlements(school?.subscription as SubscriptionLike, plan), plan };
}

/** 403 for a feature the school's subscription does not include (documented code: FEATURE_NOT_IN_PLAN). */
export function featureNotInPlan(feature: string, eligible = true) {
  const def = featureDef(feature);
  const name = def?.name ?? feature;
  return new AppError(
    403,
    'FEATURE_NOT_IN_PLAN',
    eligible
      ? `${name} is not included in your school’s subscription plan.`
      : `${name} is not available while the school subscription is inactive.`,
    { feature, featureName: name },
  );
}

/** Throws unless every feature is entitled. Unknown keys are always denied. */
export function assertEntitled(
  entitlements: { features: ReadonlySet<string>; eligible: boolean },
  features: readonly string[],
) {
  for (const f of features)
    if (!isFeatureKey(f) || !entitlements.features.has(f)) throw featureNotInPlan(f, entitlements.eligible);
}

/** The full feature list with this school's state, for the school app and the platform panel. */
export function describeEntitlements(features: ReadonlySet<string>) {
  return FEATURES.map((f) => ({
    key: f.key,
    name: f.name,
    description: f.description,
    category: f.category,
    entitled: features.has(f.key),
    available: f.availability === 'available',
    required: 'required' in f && f.required === true,
  }));
}
