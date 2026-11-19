import { model, Schema, type InferSchemaType } from 'mongoose';
import { baseOptions, ObjectId } from '../../database/schema-helpers';

export const BILLING_PERIODS = ['monthly', 'yearly'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/**
 * How a published change to a plan's features reaches schools already on it:
 * - `all_subscribers`: everyone on the plan gets the new feature set straight away.
 * - `new_subscribers_only`: schools already on the plan keep the features they had (a snapshot
 *   is stored on their subscription); schools that join afterwards get the new set.
 */
export const SUBSCRIBER_POLICIES = ['all_subscribers', 'new_subscribers_only'] as const;

const PriceSchema = new Schema(
  { amount: { type: Number, min: 0, default: 0 }, enabled: { type: Boolean, default: false } },
  { _id: false },
);

const LimitsSchema = {
  maxStudents: { type: Number, default: 200 },
  maxCampuses: { type: Number, default: 1 },
  maxStaffUsers: { type: Number, default: 25 },
  aiMonthlyTokens: { type: Number, default: 200_000 },
  messagesPerMonth: { type: Number, default: 1_000 },
};

/**
 * A subscription plan. The top-level fields are the PUBLISHED configuration, the only one the
 * system enforces. Edits are saved to `draft` first and become live on publish, so a failed or
 * half-finished edit never replaces the last valid published configuration.
 *
 * `code` is the stable identifier: it never changes, so renaming a plan does not affect
 * subscriptions or history.
 */
const PlanSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    /** Short marketing bullet points. */
    highlights: { type: [String], default: [] },
    /** Optional label such as "Popular" or "Best value". */
    badge: { type: String, trim: true },
    displayOrder: { type: Number, default: 100 },
    currency: { type: String, default: 'PKR', uppercase: true, trim: true },
    // No defaults: a plan without prices (created before pricing existed) is read through
    // priceMonthlyPkr, monthly billing only, until the migration fills these in.
    prices: {
      monthly: { type: PriceSchema },
      yearly: { type: PriceSchema },
    },
    /** Legacy mirror of prices.monthly.amount (kept for older clients). */
    priceMonthlyPkr: { type: Number, required: true, min: 0 },
    trialDays: { type: Number, default: 14, min: 0 },
    limits: LimitsSchema,
    /** Feature registry keys (see src/config/entitlements.ts). */
    features: { type: [String], default: [] },
    /** Offered to new schools. */
    isActive: { type: Boolean, default: true },
    /** Archived plans cannot be assigned again; schools already on them keep working. */
    archivedAt: { type: Date },
    /** False until a newly created plan is published for the first time (it cannot be assigned before). */
    published: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    publishedAt: { type: Date },
    publishedBy: { type: ObjectId, ref: 'PlatformAdmin' },
    /** Unpublished edits. Same shape as the published fields that can be edited. */
    draft: { type: Schema.Types.Mixed },
  },
  baseOptions,
);
PlanSchema.index({ displayOrder: 1, name: 1 });

export type PlanDoc = InferSchemaType<typeof PlanSchema>;
export const Plan = model('Plan', PlanSchema);
