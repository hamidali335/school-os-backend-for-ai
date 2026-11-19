import { normaliseFeatures } from '../../config/entitlements';
import { STAFF_ROLES } from '../../config/permissions';
import type { Api } from '../../utils/api';
import { scope } from '../../utils/tenant';
import { z } from '../../utils/zod';
import { aiStatus } from '../ai/ai.service';
import { Campus } from '../campuses/campus.model';
import { externalMessagesThisMonth } from '../communications/communications.service';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { User } from '../users/user.model';
import { getSchoolLimits } from './limits.service';
import { Plan } from './plan.model';

export const LimitsSchema = z
  .object({
    maxStudents: z.number(),
    maxCampuses: z.number(),
    maxStaffUsers: z.number(),
    aiMonthlyTokens: z.number(),
    messagesPerMonth: z.number(),
  })
  .openapi('PlanLimits');

export function registerSubscriptionRoutes(api: Api) {
  api.route({
    method: 'get',
    path: '/subscription',
    tags: ['Subscription'],
    auth: 'school',
    permission: 'subscription:read',
    summary: "The school's plan, subscription status, limits and current usage",
    response: z.object({
      plan: z
        .object({ code: z.string(), name: z.string(), priceMonthlyPkr: z.number(), features: z.array(z.string()) })
        .nullable(),
      status: z.string(),
      billingPeriod: z.string().nullable(),
      agreedPrice: z
        .object({ amount: z.number(), currency: z.string(), period: z.string() })
        .nullable()
        .openapi({ description: 'The price agreed for this school (not changed by later plan price changes)' }),
      trialEndsAt: z.string().nullable(),
      currentPeriodEnd: z.string().nullable(),
      limits: LimitsSchema,
      usage: z.object({
        activeStudents: z.number(),
        campuses: z.number(),
        activeStaffUsers: z.number(),
        aiTokensThisMonth: z.number(),
        externalMessagesThisMonth: z.number(),
      }),
    }),
    handler: async ({ ctx }) => {
      const school = await School.findById(ctx.schoolId).select('subscription').lean();
      const [plan, limits, students, campuses, staff, ai, messages] = await Promise.all([
        school?.subscription?.planId
          ? Plan.findById(school.subscription.planId).select('code name priceMonthlyPkr features').lean()
          : null,
        getSchoolLimits(ctx.schoolId),
        Student.countDocuments(scope(ctx, { status: 'active' })),
        Campus.countDocuments(scope(ctx)),
        User.countDocuments(scope(ctx, { role: { $in: [...STAFF_ROLES] }, status: 'active' })),
        aiStatus(ctx.schoolId),
        externalMessagesThisMonth(ctx.schoolId),
      ]);
      return {
        plan: plan
          ? {
              code: plan.code,
              name: plan.name,
              priceMonthlyPkr: plan.priceMonthlyPkr,
              features: normaliseFeatures(plan.features),
            }
          : null,
        status: school?.subscription?.status ?? 'trialing',
        billingPeriod: school?.subscription?.billingPeriod ?? null,
        agreedPrice:
          school?.subscription?.agreedPrice?.amount != null
            ? {
                amount: school.subscription.agreedPrice.amount,
                currency: school.subscription.agreedPrice.currency ?? 'PKR',
                period: school.subscription.agreedPrice.period ?? 'monthly',
              }
            : null,
        trialEndsAt: school?.subscription?.trialEndsAt?.toISOString() ?? null,
        currentPeriodEnd: school?.subscription?.currentPeriodEnd?.toISOString() ?? null,
        limits,
        usage: {
          activeStudents: students,
          campuses,
          activeStaffUsers: staff,
          aiTokensThisMonth: ai.tokensUsedThisMonth,
          externalMessagesThisMonth: messages,
        },
      };
    },
  });
}
