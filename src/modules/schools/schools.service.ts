import { Types } from 'mongoose';
import { DEFAULT_WORKING_DAYS } from './school-days';
import { atomic, inTransaction } from '../../database/transactions';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { addDays } from '../../utils/dates';
import { audit } from '../audit/audit.service';
import { hashPassword } from '../auth/tokens';
import { Campus } from '../campuses/campus.model';
import { Plan } from '../subscriptions/plan.model';
import { checkOverrides, configOf } from '../subscriptions/plans.service';
import { User } from '../users/user.model';
import { School } from './school.model';

export interface OnboardSchoolInput {
  name: string;
  code: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  planCode?: string;
  billingPeriod?: 'monthly' | 'yearly';
  trialDays?: number;
  /** School-specific exceptions to the plan (validated before anything is created). */
  featureOverrides?: Array<{ feature: string; mode: 'grant' | 'revoke'; reason?: string }>;
  /** Who set the overrides (platform admin), for the record on the subscription. */
  overridesBy?: { adminId: string; name: string };
  campus?: { name: string; code: string; address?: string };
  owner: { name: string; email: string; password: string; phone?: string };
}

/**
 * Creates a tenant: school, its main campus and the school-owner account. Used by the
 * platform admin API, the seed script and tests.
 */
/** School, main campus and Admin account: one transaction on a replica set (see atomic()). */
export async function onboardSchool(input: OnboardSchoolInput) {
  return atomic(() => onboardSchoolOnce(input));
}

async function onboardSchoolOnce(input: OnboardSchoolInput) {
  const code = input.code.toUpperCase();
  if (await School.exists({ code })) throw conflict('A school with this code already exists', undefined, 'DUPLICATE');

  // Only plans offered to new schools (published, not archived) can be chosen here.
  const plan = input.planCode
    ? await Plan.findOne({
        code: input.planCode.toLowerCase(),
        isActive: true,
        archivedAt: null,
        published: { $ne: false },
      }).lean()
    : null;
  if (input.planCode && !plan) throw notFound('Plan');
  const trialDays = input.trialDays ?? plan?.trialDays ?? 14;
  const overrides = input.featureOverrides ?? [];
  if (overrides.length) checkOverrides({ status: 'trialing' }, plan, overrides);
  let billing: Record<string, unknown> = {};
  if (plan) {
    const cfg = configOf(plan);
    const period = input.billingPeriod ?? (cfg.prices.monthly.enabled ? 'monthly' : 'yearly');
    if (!cfg.prices[period].enabled)
      throw badRequest(`${cfg.name} is not sold with ${period} billing`, { field: 'billingPeriod' });
    // The agreed price is fixed now; later plan price changes do not alter it.
    billing = {
      billingPeriod: period,
      agreedPrice: { amount: cfg.prices[period].amount, currency: cfg.currency, period, setAt: new Date() },
      planChangedAt: new Date(),
    };
  }

  const schoolId = new Types.ObjectId();
  const school = await School.create({
    _id: schoolId,
    name: input.name,
    code,
    city: input.city,
    address: input.address,
    phone: input.phone,
    email: input.email,
    status: 'active',
    subscription: {
      planId: plan?._id,
      status: 'trialing',
      trialEndsAt: addDays(new Date(), trialDays),
      ...billing,
      featureOverrides: overrides.map((o) => ({
        ...o,
        by: input.overridesBy?.adminId,
        byName: input.overridesBy?.name,
        at: new Date(),
      })),
    },
  });
  try {
    const campus = await Campus.create({
      schoolId,
      name: input.campus?.name ?? 'Main Campus',
      code: input.campus?.code ?? 'MAIN',
      address: input.campus?.address ?? input.address,
      city: input.city,
      isMain: true,
    });
    const owner = await User.create({
      schoolId,
      name: input.owner.name,
      email: input.owner.email.toLowerCase(),
      phone: input.owner.phone,
      passwordHash: await hashPassword(input.owner.password),
      role: 'school_owner',
    });
    return { school: school.toObject(), campus: campus.toObject(), ownerId: owner._id };
  } catch (err) {
    if (inTransaction()) throw err; // the transaction abort removes everything
    // Roll back partial onboarding (standalone MongoDB has no multi-document transactions).
    await Campus.deleteMany({ schoolId });
    await User.deleteMany({ schoolId });
    await School.deleteOne({ _id: schoolId });
    throw err;
  }
}

const PROFILE_FIELDS = 'name code city address phone email status subscription settings createdAt updatedAt';

export async function getSchoolProfile(ctx: SchoolContext) {
  const school = await School.findById(ctx.schoolId)
    .select(PROFILE_FIELDS)
    .populate('subscription.planId', 'code name limits features')
    .lean();
  if (!school) throw notFound('School');
  return school;
}

export async function updateSchoolProfile(
  ctx: SchoolContext,
  input: Partial<{ name: string; city: string; address: string; phone: string; email: string }>,
) {
  const school = await School.findByIdAndUpdate(
    ctx.schoolId,
    { $set: input },
    { returnDocument: 'after', runValidators: true },
  )
    .select(PROFILE_FIELDS)
    .lean();
  await audit(ctx, {
    action: 'school.profile_updated',
    entityType: 'School',
    entityId: ctx.schoolId,
    metadata: { fields: Object.keys(input) },
  });
  return school;
}

/** Flatten a nested partial settings object into dotted $set paths so unspecified keys are preserved. */
function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Types.ObjectId))
      Object.assign(out, flatten(v as Record<string, unknown>, key));
    else if (v !== undefined) out[key] = v;
  }
  return out;
}

export async function getSettings(ctx: SchoolContext) {
  const school = await School.findById(ctx.schoolId).select('settings').lean();
  return withDefaultDays(school?.settings);
}

/** Schools that never chose their school days get Monday to Saturday. */
function withDefaultDays<T>(settings: T): T {
  if (!settings) return settings;
  const days = (settings as { workingDays?: number[] }).workingDays;
  return { ...settings, workingDays: days?.length ? days : DEFAULT_WORKING_DAYS };
}

export async function updateSettings(ctx: SchoolContext, input: Record<string, unknown>) {
  const set = flatten(input, 'settings');
  const school = await School.findByIdAndUpdate(
    ctx.schoolId,
    { $set: set },
    { returnDocument: 'after', runValidators: true },
  )
    .select('settings')
    .lean();
  await audit(ctx, {
    action: 'school.settings_updated',
    entityType: 'School',
    entityId: ctx.schoolId,
    metadata: { fields: Object.keys(set) },
  });
  return withDefaultDays(school?.settings);
}

export async function getSchoolSettingsRaw(schoolId: string) {
  const school = await School.findById(schoolId).select('name code settings').lean();
  if (!school) throw notFound('School');
  return school;
}
