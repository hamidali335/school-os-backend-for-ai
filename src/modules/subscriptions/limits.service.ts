import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import { School } from '../schools/school.model';
import { Plan } from './plan.model';

export interface PlanLimits {
  maxStudents: number;
  maxCampuses: number;
  maxStaffUsers: number;
  aiMonthlyTokens: number;
  messagesPerMonth: number;
}

/** Limits that apply when a school has no plan assigned (e.g. during onboarding). */
export const DEFAULT_LIMITS: PlanLimits = {
  maxStudents: 200,
  maxCampuses: 1,
  maxStaffUsers: 25,
  aiMonthlyTokens: env.AI_DEFAULT_MONTHLY_TOKEN_LIMIT,
  messagesPerMonth: 1_000,
};

export async function getSchoolLimits(schoolId: string | Types.ObjectId): Promise<PlanLimits> {
  const school = await School.findById(schoolId).select('subscription.planId settings.ai.monthlyTokenLimit').lean();
  const plan = school?.subscription?.planId
    ? await Plan.findById(school.subscription.planId).select('limits').lean()
    : null;
  const limits: PlanLimits = { ...DEFAULT_LIMITS, ...(plan?.limits ?? {}) } as PlanLimits;
  // A school may lower (never raise) its own AI ceiling below the plan allowance.
  const own = school?.settings?.ai?.monthlyTokenLimit;
  if (typeof own === 'number' && own >= 0) limits.aiMonthlyTokens = Math.min(limits.aiMonthlyTokens, own);
  return limits;
}

export function planLimitError(what: string, limit: number) {
  return new AppError(
    403,
    'PLAN_LIMIT_REACHED',
    `Your subscription plan allows up to ${limit} ${what}. Please upgrade the plan to add more.`,
    { limit },
  );
}
