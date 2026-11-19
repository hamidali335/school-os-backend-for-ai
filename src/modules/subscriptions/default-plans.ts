import { AI_ENTITLEMENTS, CORE_FEATURES, MOBILE_FEATURES } from '../../config/entitlements';

/**
 * The initial Basic, Pro and Pro Max templates. They are only a starting point: the seed and the
 * migration create them when missing and never overwrite them, and from then on the Platform
 * Owner changes names, prices, features and availability in the admin panel. Prices are
 * placeholders to review; yearly billing starts disabled (no yearly price is assumed). Token
 * allowances only matter once a plan includes AI: whether AI is available is decided by features.
 *
 * Defaults: Basic = every core module and both web portals; Pro = Basic + the parent and teacher
 * mobile apps (coming soon); Pro Max = Pro + every AI feature.
 */
export const DEFAULT_PLAN_TEMPLATES = [
  {
    code: 'basic',
    name: 'Basic',
    description: 'Complete school management with parent and teacher web portals.',
    highlights: ['All school-management modules', 'Parent and teacher web portals'],
    displayOrder: 10,
    monthly: 2_500,
    limits: { maxStudents: 250, maxCampuses: 1, maxStaffUsers: 20, aiMonthlyTokens: 200_000, messagesPerMonth: 1_000 },
    features: [...CORE_FEATURES],
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Everything in Basic, plus the parent and teacher mobile apps when they launch.',
    highlights: ['Everything in Basic', 'Parent and teacher mobile apps (coming soon)'],
    badge: 'Popular',
    displayOrder: 20,
    monthly: 3_500,
    limits: { maxStudents: 800, maxCampuses: 3, maxStaffUsers: 60, aiMonthlyTokens: 500_000, messagesPerMonth: 5_000 },
    features: [...CORE_FEATURES, ...MOBILE_FEATURES],
  },
  {
    code: 'pro_max',
    name: 'Pro Max',
    description: 'The complete experience: everything in Pro plus AI Copilot, insights and the writing assistant.',
    highlights: ['Everything in Pro', 'AI Copilot', 'AI insights and writing assistant'],
    badge: 'Best value',
    displayOrder: 30,
    monthly: 5_000,
    limits: {
      maxStudents: 5_000,
      maxCampuses: 15,
      maxStaffUsers: 400,
      aiMonthlyTokens: 1_000_000,
      messagesPerMonth: 30_000,
    },
    features: [...CORE_FEATURES, ...MOBILE_FEATURES, ...AI_ENTITLEMENTS],
  },
] as const;

/** Document to insert for a template (used with $setOnInsert, so existing plans are never changed). */
export function templateDocument(t: (typeof DEFAULT_PLAN_TEMPLATES)[number]) {
  return {
    code: t.code,
    name: t.name,
    description: t.description,
    highlights: [...t.highlights],
    badge: 'badge' in t ? t.badge : undefined,
    displayOrder: t.displayOrder,
    currency: 'PKR',
    prices: { monthly: { amount: t.monthly, enabled: true }, yearly: { amount: 0, enabled: false } },
    priceMonthlyPkr: t.monthly,
    trialDays: 14,
    limits: { ...t.limits },
    features: [...t.features],
    isActive: true,
    published: true,
    version: 1,
    publishedAt: new Date(),
  };
}
