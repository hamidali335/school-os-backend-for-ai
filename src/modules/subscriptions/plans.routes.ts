import { FEATURE_CATEGORIES, FEATURES } from '../../config/entitlements';
import type { PlatformContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { forbidden } from '../../utils/errors';
import { docBase, idParams, objectId, z } from '../../utils/zod';
import { describeEntitlements } from './entitlements.service';
import {
  applyCurrentPrice,
  changeSchoolPlan,
  createPlan,
  discardDraft,
  getPlan,
  listPlans,
  PlanConfig,
  plansIncluding,
  previewDraft,
  previewPlanChange,
  publishDraft,
  saveDraft,
  schoolSubscriptionView,
  setArchived,
  setOverrides,
} from './plans.service';
import { BILLING_PERIODS, SUBSCRIBER_POLICIES } from './plan.model';
import { LimitsSchema } from './subscriptions.routes';

const Price = z.object({ amount: z.number(), enabled: z.boolean() });
const Prices = z.object({ monthly: Price, yearly: Price });

export const FeatureState = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    entitled: z.boolean(),
    available: z.boolean().openapi({ description: 'False for capabilities not released yet (e.g. mobile apps)' }),
    required: z.boolean(),
  })
  .openapi('FeatureEntitlement');

const PlanConfigRes = z.object({
  name: z.string(),
  description: z.string(),
  highlights: z.array(z.string()),
  badge: z.string(),
  displayOrder: z.number(),
  currency: z.string(),
  prices: Prices,
  trialDays: z.number(),
  limits: LimitsSchema.partial(),
  features: z.array(z.string()),
  isActive: z.boolean(),
});

export const PlanRes = PlanConfigRes.extend({
  ...docBase,
  code: z.string(),
  priceMonthlyPkr: z.number(),
  published: z.boolean(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  version: z.number(),
  publishedAt: z.string().nullable(),
  draft: z.any().nullable().openapi({ description: 'Unpublished edits, or null' }),
  subscribers: z.number(),
}).openapi('Plan');

const PlanDetailRes = PlanRes.extend({
  schools: z.array(
    z.object({
      _id: objectId(),
      name: z.string(),
      code: z.string(),
      status: z.string(),
      subscriptionStatus: z.string(),
      billingPeriod: z.string().nullable(),
      agreedPrice: z.number().nullable(),
      currency: z.string().nullable(),
      grandfathered: z.boolean(),
      overrides: z.number(),
    }),
  ),
});

const FeatureRef = z.object({ key: z.string(), name: z.string() });

const SchoolSubscriptionRes = z
  .object({
    school: z.object({ _id: objectId(), name: z.string(), code: z.string(), status: z.string() }),
    plan: z.object({ _id: objectId(), code: z.string(), name: z.string(), archived: z.boolean() }).nullable(),
    status: z.string(),
    eligible: z.boolean(),
    trialEndsAt: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    billingPeriod: z.string().nullable(),
    agreedPrice: z
      .object({ amount: z.number(), currency: z.string().optional(), period: z.string().optional(), setAt: z.any() })
      .nullable(),
    currentPlanPrice: Prices.nullable(),
    grandfatheredFeatures: z.array(z.string()).nullable(),
    overrides: z.array(
      z.object({
        feature: z.string(),
        mode: z.enum(['grant', 'revoke']),
        reason: z.string().nullable(),
        byName: z.string().nullable(),
        at: z.string().nullable(),
      }),
    ),
    features: z.array(FeatureState),
  })
  .openapi('SchoolSubscription');

const Confirm = z.literal(true).openapi({ description: 'Must be true: the change was reviewed and confirmed' });
const ownerOnly = ['platform_owner'] as const;
const tags = ['Platform Admin: Plans'];

export function registerPlanRoutes(api: Api) {
  // ─────────── Feature registry ───────────
  api.route({
    method: 'get',
    path: '/platform/features',
    tags,
    auth: 'platform',
    summary: 'Every plan-controlled feature this software supports (the registry)',
    description:
      'Plans may only include these keys. `availability: coming_soon` means the capability is not released (e.g. mobile apps): it can be sold, but is shown as coming soon.',
    response: z.object({
      categories: z.array(z.object({ key: z.string(), label: z.string() })),
      features: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          description: z.string(),
          category: z.string(),
          availability: z.enum(['available', 'coming_soon']),
          required: z.boolean(),
          dependsOn: z.array(z.string()),
          permissions: z.array(z.string()),
        }),
      ),
    }),
    handler: () => ({
      categories: Object.entries(FEATURE_CATEGORIES).map(([key, label]) => ({ key, label })),
      features: FEATURES.map((f) => ({
        key: f.key,
        name: f.name,
        description: f.description,
        category: f.category,
        availability: f.availability,
        required: 'required' in f && f.required === true,
        dependsOn: 'dependsOn' in f ? [...f.dependsOn] : [],
        permissions: 'permissions' in f ? [...f.permissions] : [],
      })),
    }),
  });

  // ─────────── Plans ───────────
  api.route({
    method: 'get',
    path: '/platform/plans',
    tags,
    auth: 'platform',
    summary: 'Subscription plans (published configuration, pending draft and subscriber count)',
    response: z.array(PlanRes),
    handler: () => listPlans(),
  });

  api.route({
    method: 'get',
    path: '/platform/plans/:id',
    tags,
    auth: 'platform',
    summary: 'One plan with the schools subscribed to it',
    params: idParams,
    response: PlanDetailRes,
    handler: ({ params }) => getPlan(params.id),
  });

  api.route({
    method: 'post',
    path: '/platform/plans',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Create a plan',
    description:
      '`code` is the stable identifier and never changes (renaming is safe). Without `features` the plan gets the core product (no AI, no mobile apps). ' +
      '`publish: false` saves it as an unpublished draft that cannot be assigned until published. `priceMonthlyPkr` is accepted for older clients.',
    body: PlanConfig.extend({
      code: z
        .string()
        .trim()
        .min(2)
        .max(30)
        .regex(/^[a-z0-9_-]+$/i, 'Letters, digits, dash and underscore only'),
      priceMonthlyPkr: z.number().int().min(0).optional(),
      publish: z.boolean().default(true),
    }),
    response: PlanRes,
    status: 201,
    handler: ({ ctx, body }) => {
      const { code, publish, priceMonthlyPkr, ...cfg } = body;
      if (!cfg.prices && priceMonthlyPkr !== undefined)
        cfg.prices = { monthly: { amount: priceMonthlyPkr, enabled: true }, yearly: { amount: 0, enabled: false } };
      return createPlan(ctx, code, cfg, publish);
    },
  });

  api.route({
    method: 'put',
    path: '/platform/plans/:id/draft',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Save changes to a plan as a draft (validated; nothing goes live until published)',
    description:
      'Partial: only the fields sent change. Invalid configurations are rejected with `INVALID_PLAN_CONFIG` and the details; the published configuration is never touched here.',
    params: idParams,
    body: PlanConfig.partial(),
    response: PlanDetailRes,
    handler: ({ ctx, params, body }) => saveDraft(ctx, params.id, body),
  });

  api.route({
    method: 'delete',
    path: '/platform/plans/:id/draft',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Discard unpublished changes',
    params: idParams,
    response: PlanDetailRes,
    handler: ({ ctx, params }) => discardDraft(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/platform/plans/:id/draft/preview',
    tags,
    auth: 'platform',
    summary: 'What publishing the draft would change (prices, features, schools affected)',
    params: idParams,
    response: z.object({
      planId: objectId(),
      code: z.string(),
      revision: z.string().openapi({ description: 'What was reviewed: send it as `expectedRevision` when publishing' }),
      firstPublish: z.boolean(),
      before: PlanConfigRes,
      after: PlanConfigRes,
      featuresAdded: z.array(FeatureRef),
      featuresRemoved: z.array(FeatureRef),
      priceChanges: z.array(z.object({ period: z.string(), before: Price, after: Price })),
      renamed: z.object({ from: z.string(), to: z.string() }).nullable(),
      offeredToNewSchools: z.object({ before: z.boolean(), after: z.boolean() }),
      schoolsOnPlan: z.number(),
      problems: z.array(z.object({ path: z.string(), message: z.string() })),
      warnings: z.array(z.string()),
    }),
    handler: ({ params }) => previewDraft(params.id),
  });

  api.route({
    method: 'post',
    path: '/platform/plans/:id/publish',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Publish the draft (takes effect on the next request of every affected school)',
    description:
      '`applyTo: all_subscribers` gives every school on the plan the new features at once. `new_subscribers_only` keeps the current features for schools already on it ' +
      '(stored as a snapshot on their subscription) and applies the new set to schools that join later. Prices never change existing subscriptions: ' +
      'use `POST /platform/schools/{id}/subscription/apply-current-price` for that. ' +
      'Send the `revision` from the preview as `expectedRevision`: if the plan was published or its draft changed after that review, the answer is `409 PLAN_CHANGED` and nothing is published (review the new state). Without it, only changes made during this request are detected.',
    params: idParams,
    body: z.object({
      applyTo: z.enum(SUBSCRIBER_POLICIES),
      confirm: Confirm,
      note: z.string().trim().max(500).optional(),
      expectedRevision: z.string().max(64).optional(),
    }),
    response: z.object({ plan: PlanDetailRes, grandfatheredSchools: z.number() }),
    handler: ({ ctx, params, body }) => publishDraft(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/platform/plans/:id/archive',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Archive a plan: no longer offered or assignable; schools on it keep working',
    params: idParams,
    body: z.object({ confirm: Confirm, note: z.string().trim().max(500).optional() }),
    response: PlanDetailRes,
    handler: ({ ctx, params, body }) => setArchived(ctx, params.id, true, body.note),
  });

  api.route({
    method: 'post',
    path: '/platform/plans/:id/restore',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Restore an archived plan (it stays hidden from new schools until you offer it again)',
    params: idParams,
    body: z.object({ note: z.string().trim().max(500).optional() }),
    response: PlanDetailRes,
    handler: ({ ctx, params, body }) => setArchived(ctx, params.id, false, body.note),
  });

  // ─────────── One school's subscription ───────────
  api.route({
    method: 'get',
    path: '/platform/schools/:id/entitlements',
    tags,
    auth: 'platform',
    summary: "A school's plan, agreed price, overrides and effective features",
    params: idParams,
    response: SchoolSubscriptionRes,
    handler: ({ params }) => schoolSubscriptionView(params.id),
  });

  api.route({
    method: 'get',
    path: '/platform/schools/:id/plan-change/preview',
    tags,
    auth: 'platform',
    summary: 'Features a school would gain or lose by moving to another plan (nothing is saved)',
    params: idParams,
    query: z.object({ planCode: z.string().trim().min(1).max(30) }),
    response: z.object({
      current: z.object({ code: z.string(), name: z.string() }).nullable(),
      proposed: z.object({
        code: z.string(),
        name: z.string(),
        assignable: z.boolean(),
        prices: Prices,
        currency: z.string(),
      }),
      gained: z.array(FeatureRef),
      lost: z.array(FeatureRef),
      overridesKept: z.number(),
      subscriptionEligible: z.boolean(),
    }),
    handler: ({ params, query }) => previewPlanChange(params.id, query.planCode),
  });

  api.route({
    method: 'post',
    path: '/platform/schools/:id/plan-change',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Upgrade or downgrade a school (accounts, data and overrides are kept)',
    description:
      'Applies on the next request of every user of the school; nobody has to sign in again. The agreed price is taken from the new plan. ' +
      'Subscription status, payment and dates are not changed here. Nothing is charged or refunded.',
    params: idParams,
    body: z.object({
      planCode: z.string().trim().min(1).max(30),
      billingPeriod: z.enum(BILLING_PERIODS).optional(),
      confirm: Confirm,
      note: z.string().trim().max(500).optional(),
    }),
    response: SchoolSubscriptionRes,
    handler: ({ ctx, params, body }) => changeSchoolPlan(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/platform/schools/:id/subscription/apply-current-price',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: "Move a school to its plan's current price (explicit; never automatic)",
    params: idParams,
    body: z.object({ confirm: Confirm, note: z.string().trim().max(500).optional() }),
    response: SchoolSubscriptionRes,
    handler: ({ ctx, params, body }) => applyCurrentPrice(ctx, params.id, body.note),
  });

  api.route({
    method: 'put',
    path: '/platform/schools/:id/feature-overrides',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Set school-specific feature exceptions (replaces the list)',
    description:
      'Precedence: required features are always on; a `revoke` removes a feature whatever the plan includes; a `grant` adds one the plan lacks. ' +
      'Required features cannot be revoked, and the resulting set must satisfy feature dependencies (`INVALID_OVERRIDES`).',
    params: idParams,
    body: z.object({
      overrides: z
        .array(
          z.object({
            feature: z.string().max(60),
            mode: z.enum(['grant', 'revoke']),
            reason: z.string().trim().max(300).optional(),
          }),
        )
        .max(50),
      note: z.string().trim().max(500).optional(),
    }),
    response: SchoolSubscriptionRes,
    handler: ({ ctx, params, body }) => setOverrides(ctx, params.id, body.overrides, body.note),
  });

  // ─────────── School app ───────────
  api.route({
    method: 'get',
    path: '/entitlements',
    tags: ['Subscription'],
    auth: 'school',
    summary: "The signed-in school's plan features (for showing, hiding or marking features)",
    description:
      'Computed from the saved subscription on every request, so plan changes show up without signing in again. ' +
      'Shown to every signed-in user; the server enforces the same rules on every request (`FEATURE_NOT_IN_PLAN`).',
    response: z.object({
      plan: z.object({ code: z.string(), name: z.string() }).nullable(),
      subscriptionEligible: z.boolean(),
      features: z.array(
        FeatureState.extend({
          availableIn: z.array(z.string()).openapi({ description: 'Names of offered plans that include this feature' }),
          permissions: z.array(z.string()).openapi({ description: 'Route permissions that belong to this feature' }),
        }),
      ),
    }),
    handler: async ({ ctx }) => {
      const { School } = await import('../schools/school.model');
      const { Plan } = await import('./plan.model');
      const school = await School.findById(ctx.schoolId).select('subscription.planId').lean();
      const plan = school?.subscription?.planId
        ? await Plan.findById(school.subscription.planId).select('code name').lean()
        : null;
      const including = await plansIncluding();
      return {
        plan: plan ? { code: plan.code, name: plan.name } : null,
        subscriptionEligible: ctx.subscriptionEligible,
        features: describeEntitlements(ctx.entitlements).map((f) => {
          const def = FEATURES.find((x) => x.key === f.key)!;
          return {
            ...f,
            availableIn: including.get(f.key) ?? [],
            permissions: 'permissions' in def ? [...def.permissions] : [],
          };
        }),
      };
    },
  });
}

/** Plan changes are Platform Owner decisions. */
export function assertPlatformOwner(ctx: PlatformContext) {
  if (ctx.role !== 'platform_owner') throw forbidden('Only the platform owner can change a school’s plan');
}
