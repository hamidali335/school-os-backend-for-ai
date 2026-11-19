import type { Api } from '../../utils/api';
import { assertRefs } from '../../utils/tenant';
import { amountPkr, email, objectId, phonePk, z } from '../../utils/zod';
import { AcademicSession } from '../academics/academics.models';
import * as svc from './schools.service';

const GradeBand = z.object({
  grade: z.string().trim().min(1).max(5),
  minPercent: z.number().min(0).max(100),
  remark: z.string().max(60).optional(),
});

export const SettingsSchema = z
  .object({
    timezone: z.string().max(60),
    currency: z.literal('PKR'),
    currentSessionId: objectId(),
    passPercent: z.number().min(0).max(100),
    workingDays: z
      .array(z.number().int().min(1).max(7))
      .min(1, 'Choose at least one school day')
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: 'Each day only once' })
      .openapi({ description: 'School days: ISO weekdays 1 = Monday … 7 = Sunday (default Monday–Saturday)' }),
    gradingScale: z
      .array(GradeBand)
      .min(2)
      .max(15)
      .refine((s) => s.some((b) => b.minPercent === 0), { message: 'Grading scale needs a band starting at 0%' }),
    attendance: z
      .object({
        lowAttendanceThreshold: z.number().min(0).max(100),
        consecutiveAbsenceAlert: z.number().int().min(1).max(30),
      })
      .partial(),
    fees: z
      .object({
        invoiceDueDay: z.number().int().min(1).max(28),
        lateFeeAmount: amountPkr(),
        lateFeeGraceDays: z.number().int().min(0).max(60),
        invoicePrefix: z.string().trim().min(1).max(10),
        receiptPrefix: z.string().trim().min(1).max(10),
        bankDetails: z.string().max(500),
      })
      .partial(),
    approvals: z
      .object({
        expenseThreshold: amountPkr().openapi({ description: 'Expenses at or above this amount require approval' }),
        bulkMessageThreshold: z
          .number()
          .int()
          .min(1)
          .openapi({ description: 'External messages to this many recipients or more require approval' }),
      })
      .partial(),
    ai: z
      .object({
        enabled: z.boolean(),
        monthlyTokenLimit: z
          .number()
          .int()
          .min(0)
          .openapi({ description: 'School-level cap; can only lower the plan allowance' }),
      })
      .partial(),
    accounts: z
      .object({
        autoCreateParentLogins: z
          .boolean()
          .openapi({ description: 'Create a parent login when a student is admitted' }),
      })
      .partial(),
    ui: z
      .object({
        colorCoded: z.boolean().openapi({
          description:
            'Colour-coded interface: subtle colours distinguish sections for everyone in the school (default off)',
        }),
      })
      .partial(),
  })
  .partial()
  .openapi('SchoolSettings');

const SchoolProfile = z
  .object({
    _id: objectId(),
    name: z.string(),
    code: z.string(),
    city: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    status: z.string(),
    subscription: z.any(),
    settings: SettingsSchema,
  })
  .openapi('SchoolProfile');

export function registerSchoolRoutes(api: Api) {
  const tags = ['School'];

  api.route({
    method: 'get',
    path: '/school',
    tags,
    auth: 'school',
    permission: 'school:read',
    summary: "The signed-in user's school profile, subscription and settings",
    response: SchoolProfile,
    handler: ({ ctx }) => svc.getSchoolProfile(ctx),
  });

  api.route({
    method: 'patch',
    path: '/school',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Update school profile details',
    body: z
      .object({
        name: z.string().trim().min(2).max(120),
        city: z.string().trim().max(60),
        address: z.string().trim().max(300),
        phone: phonePk(),
        email: email(),
      })
      .partial(),
    response: SchoolProfile,
    handler: ({ ctx, body }) => svc.updateSchoolProfile(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/school/settings',
    tags,
    auth: 'school',
    permission: 'school:read',
    summary: 'School settings (grading, fees, attendance, approvals, AI)',
    response: SettingsSchema,
    handler: ({ ctx }) => svc.getSettings(ctx),
  });

  api.route({
    method: 'patch',
    path: '/school/settings',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Update school settings (partial; unspecified keys are kept)',
    body: SettingsSchema,
    response: SettingsSchema,
    handler: async ({ ctx, body }) => {
      await assertRefs(ctx, [[AcademicSession, body.currentSessionId, 'currentSessionId']]);
      if (body.gradingScale) body.gradingScale.sort((a, b) => b.minPercent - a.minPercent);
      return svc.updateSettings(ctx, body as Record<string, unknown>);
    },
  });
}
