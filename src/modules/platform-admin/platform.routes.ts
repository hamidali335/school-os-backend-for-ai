import { isChannelEnabled } from '../../config/features';
import os from 'node:os';
import { Types } from 'mongoose';
import { env } from '../../config/env';
import { STAFF_ROLES } from '../../config/permissions';
import { databaseState, pingDatabase } from '../../database/connection';
import { atomic } from '../../database/transactions';
import { channelStatus } from '../../services/messaging/adapters';
import type { PlatformContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { addDays, DEFAULT_TIMEZONE, localDayRange, parseDateOnly } from '../../utils/dates';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { paginate, searchRegex } from '../../utils/pagination';
import { docBase, email, idParams, isoDate, objectId, paginationQuery, password, phonePk, z } from '../../utils/zod';
import { AiUsage } from '../ai/ai-usage.model';
import { getAiProvider } from '../ai/provider';
import { AuditLog } from '../audit/audit.model';
import { audit, auditPlatformOnSchool } from '../audit/audit.service';
import { AuditRes } from '../audit/audit.routes';
import { hashPassword, revokeAllForSubject } from '../auth/tokens';
import { Campus } from '../campuses/campus.model';
import { MessageLog } from '../communications/communications.models';
import { ErrorEvent } from '../health/error-event.model';
import { School, SUBSCRIPTION_STATUSES } from '../schools/school.model';
import { assertPlatformOwner } from '../subscriptions/plans.routes';
import { changeSchoolPlan } from '../subscriptions/plans.service';
import { onboardSchool } from '../schools/schools.service';
import { Student } from '../students/student.models';
import { getSchoolLimits } from '../subscriptions/limits.service';
import { Plan } from '../subscriptions/plan.model';
import { LimitsSchema } from '../subscriptions/subscriptions.routes';
import { User } from '../users/user.model';
import { PushDevice } from '../push/push.model';
import { pushStatus } from '../push/push.service';
import { generateTempPassword, issueAccountToken } from '../users/users.service';
import { PLATFORM_ADMIN_PUBLIC_FIELDS, PlatformAdmin } from './platform-admin.model';

const X = { crossTenant: true } as any;
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Per-school counts via one aggregation per collection (no personal data). */
async function countsBySchool(model: any, match: Record<string, unknown> = {}) {
  const rows = await model
    .aggregate([{ $match: match }, { $group: { _id: '$schoolId', count: { $sum: 1 } } }])
    .option(X);
  return new Map<string, number>(rows.map((r: any) => [r._id?.toString(), r.count]));
}

const SchoolSummary = z
  .object({
    _id: objectId(),
    name: z.string(),
    code: z.string(),
    city: z.string().optional(),
    status: z.string(),
    subscription: z.object({
      status: z.string(),
      plan: z.string().nullable(),
      trialEndsAt: z.string().nullable(),
      currentPeriodEnd: z.string().nullable(),
    }),
    counts: z.object({ activeStudents: z.number(), campuses: z.number(), staffUsers: z.number() }),
    createdAt: z.string(),
  })
  .openapi('PlatformSchoolSummary');

async function summarise(schools: any[]) {
  const ids = schools.map((s) => s._id);
  const [students, campuses, staff, plans] = await Promise.all([
    countsBySchool(Student, { schoolId: { $in: ids }, status: 'active' }),
    countsBySchool(Campus, { schoolId: { $in: ids } }),
    countsBySchool(User, { schoolId: { $in: ids }, role: { $in: [...STAFF_ROLES] }, status: 'active' }),
    Plan.find({ _id: { $in: schools.map((s) => s.subscription?.planId).filter(Boolean) } })
      .select('code')
      .lean(),
  ]);
  const planCode = new Map(plans.map((p) => [p._id.toString(), p.code]));
  return schools.map((s) => ({
    _id: s._id,
    name: s.name,
    code: s.code,
    city: s.city,
    status: s.status,
    subscription: {
      status: s.subscription?.status ?? 'trialing',
      plan: s.subscription?.planId ? (planCode.get(s.subscription.planId.toString()) ?? null) : null,
      trialEndsAt: s.subscription?.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: s.subscription?.currentPeriodEnd?.toISOString() ?? null,
    },
    counts: {
      activeStudents: students.get(s._id.toString()) ?? 0,
      campuses: campuses.get(s._id.toString()) ?? 0,
      staffUsers: staff.get(s._id.toString()) ?? 0,
    },
    createdAt: s.createdAt,
  }));
}

export function registerPlatformRoutes(api: Api) {
  const tags = ['Platform Admin'];
  const ownerOnly = ['platform_owner'] as const;

  api.route({
    method: 'get',
    path: '/platform/overview',
    tags,
    auth: 'platform',
    summary: 'Platform-wide totals (schools, students, usage, errors)',
    response: z.object({
      schools: z.record(z.string(), z.number()),
      activeStudents: z.number(),
      activeUsers: z.number(),
      aiThisMonth: z.object({
        calls: z.number(),
        tokens: z.number(),
        estimatedCostUsd: z.number(),
        errors: z.number(),
      }),
      messagesThisMonth: z.object({
        sent: z.number(),
        failed: z.number(),
        notConfigured: z.number(),
        costPkr: z.number(),
      }),
      serverErrorsLast24h: z.number(),
    }),
    handler: async () => {
      const since = monthStart();
      const [schools, students, users, ai, msgs, errors] = await Promise.all([
        School.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Student.countDocuments({ status: 'active' }).setOptions(X),
        User.countDocuments({ status: 'active' }).setOptions(X),
        AiUsage.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: null,
              calls: { $sum: { $cond: [{ $in: ['$status', ['success', 'error']] }, 1, 0] } },
              tokens: { $sum: '$totalTokens' },
              cost: { $sum: '$costUsd' },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            },
          },
        ]).option(X),
        MessageLog.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: null,
              sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              notConfigured: { $sum: { $cond: [{ $eq: ['$status', 'not_configured'] }, 1, 0] } },
              costPkr: { $sum: '$costPkr' },
            },
          },
        ]).option(X),
        ErrorEvent.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86_400_000) } }),
      ]);
      return {
        schools: Object.fromEntries(schools.map((s) => [s._id, s.count])),
        activeStudents: students,
        activeUsers: users,
        aiThisMonth: {
          calls: ai[0]?.calls ?? 0,
          tokens: ai[0]?.tokens ?? 0,
          estimatedCostUsd: Math.round((ai[0]?.cost ?? 0) * 10000) / 10000,
          errors: ai[0]?.errors ?? 0,
        },
        messagesThisMonth: {
          sent: msgs[0]?.sent ?? 0,
          failed: msgs[0]?.failed ?? 0,
          notConfigured: msgs[0]?.notConfigured ?? 0,
          costPkr: msgs[0]?.costPkr ?? 0,
        },
        serverErrorsLast24h: errors,
      };
    },
  });

  // ─────────────────────────── Schools ───────────────────────────
  api.route({
    method: 'get',
    path: '/platform/schools',
    tags,
    auth: 'platform',
    summary: 'Registered schools with plan, status and counts (no student personal data)',
    query: paginationQuery.extend({
      status: z.enum(['active', 'suspended', 'pending']).optional(),
      q: z.string().max(100).optional(),
    }),
    response: SchoolSummary,
    paginated: true,
    handler: async ({ query }) => {
      const filter: Record<string, unknown> = {};
      if (query.status) filter.status = query.status;
      const rx = searchRegex(query.q);
      if (rx) filter.$or = [{ name: rx }, { code: rx }, { city: rx }];
      const page = await paginate(School, filter, {
        page: query.page,
        limit: query.limit,
        sort: { createdAt: -1 },
        select: 'name code city status subscription createdAt',
      });
      return { ...page, items: await summarise(page.items as any[]) };
    },
  });

  api.route({
    method: 'post',
    path: '/platform/schools',
    tags,
    auth: 'platform',
    summary: 'Onboard a new school (school, main campus and its School Admin account)',
    description:
      'The `owner` object is the school’s Admin account (the field name is kept for API compatibility). ' +
      'Credentials: `owner.password` sets one directly; otherwise `owner.credential` chooses a one-time temporary password (default, returned once) ' +
      'or an activation link (the account stays `pending`; the token is returned once in `activation`). ' +
      'If any part fails, the school, campus and account are all removed.',
    body: z.object({
      name: z.string().trim().min(2).max(120),
      code: z
        .string()
        .trim()
        .min(2)
        .max(12)
        .regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
      city: z.string().trim().max(60).optional(),
      address: z.string().trim().max(300).optional(),
      phone: phonePk().optional(),
      email: email().optional(),
      planCode: z.string().trim().max(30).optional().openapi({ description: 'A plan offered to new schools' }),
      billingPeriod: z.enum(['monthly', 'yearly']).optional(),
      trialDays: z.number().int().min(0).max(180).optional(),
      featureOverrides: z
        .array(
          z.object({
            feature: z.string().max(60),
            mode: z.enum(['grant', 'revoke']),
            reason: z.string().trim().max(300).optional(),
          }),
        )
        .max(50)
        .optional()
        .openapi({ description: 'School-specific exceptions to the plan (platform owner only)' }),
      campus: z.object({ name: z.string().trim().min(2).max(100), code: z.string().trim().min(1).max(12) }).optional(),
      owner: z.object({
        name: z.string().trim().min(2).max(100),
        email: email(),
        phone: phonePk().optional(),
        password: password().optional(),
        credential: z.enum(['temporary_password', 'activation_link']).optional(),
      }),
    }),
    response: z.object({
      school: SchoolSummary,
      ownerEmail: z.string(),
      temporaryPassword: z.string().optional(),
      activation: z.object({ token: z.string(), expiresAt: z.string() }).optional(),
    }),
    status: 201,
    handler: async ({ ctx, body }) => {
      if (body.featureOverrides?.length) assertPlatformOwner(ctx);
      const useLink = !body.owner.password && body.owner.credential === 'activation_link';
      const temporaryPassword = body.owner.password || useLink ? undefined : generateTempPassword();
      // One transaction (replica set): the school never exists without its Admin login/link.
      const { result, activation } = await atomic(async () => {
        const result = await onboardSchool({
          ...body,
          overridesBy: { adminId: ctx.adminId, name: ctx.name },
          owner: {
            ...body.owner,
            // Activation link: an unguessable password nobody knows until the link is used.
            password: body.owner.password ?? temporaryPassword ?? `${generateTempPassword()}${generateTempPassword()}`,
          },
        });
        let activation: { token: string; expiresAt: string } | undefined;
        if (temporaryPassword)
          await User.updateOne(
            { _id: result.ownerId, schoolId: result.school._id },
            { $set: { mustChangePassword: true } },
          );
        if (useLink) {
          await User.updateOne(
            { _id: result.ownerId, schoolId: result.school._id },
            { $set: { status: 'pending', provisionedBy: 'onboarding' } },
          );
          activation = await issueAccountToken(
            { schoolId: result.school._id.toString() },
            result.ownerId,
            'activation',
          );
        }
        return { result, activation };
      });
      await auditPlatformOnSchool(ctx, result.school._id.toString(), {
        action: 'platform.school.onboarded',
        entityType: 'School',
        entityId: result.school._id,
      });
      await audit(ctx, {
        action: 'platform.school.onboarded',
        entityType: 'School',
        entityId: result.school._id,
        summary: body.name,
      });
      const [summary] = await summarise([result.school]);
      return { school: summary, ownerEmail: body.owner.email, temporaryPassword, activation };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/schools/:id/admins',
    tags,
    auth: 'platform',
    summary: "The school's Admin accounts (for account recovery)",
    description: 'Lists only the school-level Admin accounts; no other users or personal data are returned.',
    params: idParams,
    response: z.array(
      z.object({
        _id: objectId(),
        name: z.string(),
        email: z.string().nullable(),
        status: z.string(),
        lastLoginAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    handler: async ({ params }) => {
      const school = await School.findById(params.id).select('_id').lean();
      if (!school) throw notFound('School');
      const admins = await User.find({ schoolId: school._id, role: 'school_owner' })
        .select('name email status lastLoginAt createdAt')
        .sort({ createdAt: 1 })
        .lean();
      return admins.map((a) => ({
        _id: a._id,
        name: a.name,
        email: a.email ?? null,
        status: a.status,
        lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
        createdAt: (a as any).createdAt,
      }));
    },
  });

  api.route({
    method: 'post',
    path: '/platform/schools/:id/admins/:userId/access-link',
    tags,
    auth: 'platform',
    summary: "Issue a single-use activation or password-reset link for a school's Admin",
    description:
      'Account recovery when a school’s only Admin cannot sign in. The previous link stops working. Recorded in both the platform and the school audit log.',
    params: z.object({ id: objectId(), userId: objectId() }),
    response: z.object({
      purpose: z.enum(['activation', 'password_reset']),
      token: z.string(),
      expiresAt: z.string(),
      loginId: z.string(),
    }),
    handler: async ({ ctx, params }) => {
      const admin = await User.findOne({ _id: params.userId, schoolId: params.id, role: 'school_owner' })
        .select('status email username')
        .lean();
      if (!admin) throw notFound('Admin account');
      if (admin.status === 'disabled' || admin.status === 'suspended')
        throw conflict('This account is blocked. Re-enable it in the school before issuing a link.');
      const purpose = admin.status === 'pending' ? 'activation' : 'password_reset';
      const link = await issueAccountToken({ schoolId: params.id }, admin._id, purpose);
      await auditPlatformOnSchool(ctx, params.id, {
        action: `platform.school_admin.${purpose}_link_issued`,
        entityType: 'User',
        entityId: admin._id,
      });
      return { purpose, ...link, loginId: admin.email ?? admin.username ?? '' };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/schools/:id',
    tags,
    auth: 'platform',
    summary: 'School detail: profile, campuses, subscription, limits and usage',
    params: idParams,
    response: SchoolSummary.extend({
      address: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      statusReason: z.string().optional(),
      campuses: z.array(
        z.object({
          _id: objectId(),
          name: z.string(),
          code: z.string(),
          city: z.string().optional(),
          status: z.string(),
        }),
      ),
      limits: LimitsSchema,
      usageThisMonth: z.object({
        aiTokens: z.number(),
        aiCostUsd: z.number(),
        messagesSent: z.number(),
        messagingCostPkr: z.number(),
      }),
    }),
    handler: async ({ params }) => {
      const school = await School.findById(params.id)
        .select('name code city address phone email status statusReason subscription createdAt')
        .lean();
      if (!school) throw notFound('School');
      const since = monthStart();
      const [[summary], campuses, limits, ai, msgs] = await Promise.all([
        summarise([school]),
        Campus.find({ schoolId: school._id }).select('name code city status').lean(),
        getSchoolLimits(school._id),
        AiUsage.aggregate([
          { $match: { schoolId: school._id, createdAt: { $gte: since } } },
          { $group: { _id: null, tokens: { $sum: '$totalTokens' }, cost: { $sum: '$costUsd' } } },
        ]),
        MessageLog.aggregate([
          { $match: { schoolId: school._id, createdAt: { $gte: since }, status: 'sent' } },
          { $group: { _id: null, sent: { $sum: 1 }, cost: { $sum: '$costPkr' } } },
        ]),
      ]);
      return {
        ...summary,
        address: school.address,
        phone: school.phone,
        email: school.email,
        statusReason: school.statusReason,
        campuses,
        limits,
        usageThisMonth: {
          aiTokens: ai[0]?.tokens ?? 0,
          aiCostUsd: Math.round((ai[0]?.cost ?? 0) * 10000) / 10000,
          messagesSent: msgs[0]?.sent ?? 0,
          messagingCostPkr: msgs[0]?.cost ?? 0,
        },
      };
    },
  });

  api.route({
    method: 'patch',
    path: '/platform/schools/:id',
    tags,
    auth: 'platform',
    summary: 'Update school contact details',
    params: idParams,
    body: z
      .object({
        name: z.string().trim().min(2).max(120),
        city: z.string().trim().max(60),
        address: z.string().trim().max(300),
        phone: phonePk(),
        email: email(),
      })
      .partial(),
    response: z.object({ _id: objectId(), name: z.string() }).passthrough(),
    handler: async ({ ctx, params, body }) => {
      const school = await School.findByIdAndUpdate(
        params.id,
        { $set: body },
        { returnDocument: 'after', runValidators: true },
      )
        .select('name code city address phone email status')
        .lean();
      if (!school) throw notFound('School');
      await auditPlatformOnSchool(ctx, params.id, {
        action: 'platform.school.updated',
        entityType: 'School',
        entityId: params.id,
        metadata: { fields: Object.keys(body) },
      });
      await audit(ctx, { action: 'platform.school.updated', entityType: 'School', entityId: params.id });
      return school;
    },
  });

  for (const action of ['suspend', 'activate'] as const) {
    api.route({
      method: 'post',
      path: `/platform/schools/:id/${action}`,
      tags,
      auth: 'platform',
      summary:
        action === 'suspend' ? 'Suspend a school (all its users are blocked immediately)' : 'Re-activate a school',
      params: idParams,
      body: z.object({ reason: z.string().trim().min(3).max(300) }),
      response: z.object({ _id: objectId(), status: z.string(), statusReason: z.string().optional() }),
      handler: async ({ ctx, params, body }) => {
        const status = action === 'suspend' ? 'suspended' : 'active';
        const school = await School.findByIdAndUpdate(
          params.id,
          { $set: { status, statusReason: body.reason, statusChangedAt: new Date() } },
          { returnDocument: 'after' },
        )
          .select('status statusReason')
          .lean();
        if (!school) throw notFound('School');
        await auditPlatformOnSchool(ctx, params.id, {
          action: `platform.school.${action}`,
          entityType: 'School',
          entityId: params.id,
          summary: body.reason,
        });
        await audit(ctx, {
          action: `platform.school.${action}`,
          entityType: 'School',
          entityId: params.id,
          summary: body.reason,
        });
        return school;
      },
    });
  }

  api.route({
    method: 'put',
    path: '/platform/schools/:id/subscription',
    tags,
    auth: 'platform',
    summary: 'Set subscription status / dates (and, for the platform owner, the plan)',
    description:
      'Changing `planCode` here is the same as `POST /platform/schools/{id}/plan-change` (platform owner only, audited with the features gained and lost). ' +
      'Status and dates follow the existing manual billing workflow: nothing is charged or verified automatically.',
    params: idParams,
    body: z.object({
      planCode: z.string().trim().max(30).optional(),
      billingPeriod: z.enum(['monthly', 'yearly']).optional(),
      status: z.enum(SUBSCRIPTION_STATUSES).optional(),
      trialEndsAt: isoDate().nullable().optional(),
      currentPeriodEnd: isoDate().nullable().optional(),
    }),
    response: z.object({
      status: z.string(),
      planId: objectId().optional(),
      trialEndsAt: z.string().nullable().optional(),
      currentPeriodEnd: z.string().nullable().optional(),
    }),
    handler: async ({ ctx, params, body }) => {
      const set: Record<string, unknown> = {};
      if (body.planCode) {
        assertPlatformOwner(ctx);
        if (!(await School.exists({ _id: params.id }))) throw notFound('School');
        await changeSchoolPlan(ctx, params.id, { planCode: body.planCode, billingPeriod: body.billingPeriod });
      }
      if (body.status) set['subscription.status'] = body.status;
      if (body.trialEndsAt !== undefined)
        set['subscription.trialEndsAt'] = body.trialEndsAt ? parseDateOnly(body.trialEndsAt) : null;
      if (body.currentPeriodEnd !== undefined)
        set['subscription.currentPeriodEnd'] = body.currentPeriodEnd ? parseDateOnly(body.currentPeriodEnd) : null;
      const school = await School.findByIdAndUpdate(
        params.id,
        { $set: set },
        { returnDocument: 'after', runValidators: true },
      )
        .select('subscription')
        .lean();
      if (!school) throw notFound('School');
      if (!Object.keys(set).length) return school.subscription as any;
      await auditPlatformOnSchool(ctx, params.id, {
        action: 'platform.subscription.updated',
        entityType: 'School',
        entityId: params.id,
        metadata: body,
      });
      await audit(ctx, {
        action: 'platform.subscription.updated',
        entityType: 'School',
        entityId: params.id,
        metadata: body,
      });
      return school.subscription as any;
    },
  });

  api.route({
    method: 'post',
    path: '/platform/schools/:id/extend-trial',
    tags,
    auth: 'platform',
    summary: 'Extend a trial by N days (from the later of today or the current trial end)',
    params: idParams,
    body: z.object({ days: z.number().int().min(1).max(180) }),
    response: z.object({ trialEndsAt: z.string(), status: z.string() }),
    handler: async ({ ctx, params, body }) => {
      const school = await School.findById(params.id).select('subscription').lean();
      if (!school) throw notFound('School');
      const base =
        school.subscription?.trialEndsAt && school.subscription.trialEndsAt > new Date()
          ? school.subscription.trialEndsAt
          : new Date();
      const trialEndsAt = addDays(base, body.days);
      await School.updateOne(
        { _id: school._id },
        { $set: { 'subscription.trialEndsAt': trialEndsAt, 'subscription.status': 'trialing' } },
      );
      await auditPlatformOnSchool(ctx, params.id, {
        action: 'platform.trial.extended',
        entityType: 'School',
        entityId: params.id,
        metadata: { days: body.days },
      });
      await audit(ctx, {
        action: 'platform.trial.extended',
        entityType: 'School',
        entityId: params.id,
        metadata: { days: body.days },
      });
      return { trialEndsAt: trialEndsAt.toISOString(), status: 'trialing' };
    },
  });

  // ─────────────────────────── Usage & monitoring ───────────────────────────
  api.route({
    method: 'get',
    path: '/platform/usage',
    tags,
    auth: 'platform',
    summary: 'Per-school usage against plan limits for the current month',
    query: paginationQuery,
    response: z.object({
      month: z.string(),
      schools: z.array(
        z.object({
          schoolId: objectId(),
          name: z.string(),
          code: z.string(),
          activeStudents: z.number(),
          staffUsers: z.number(),
          aiTokens: z.number(),
          aiCostUsd: z.number(),
          messagesSent: z.number(),
          messagingCostPkr: z.number(),
          limits: LimitsSchema,
          overLimit: z.array(z.string()),
        }),
      ),
    }),
    handler: async ({ query }) => {
      const since = monthStart();
      const schools = await School.find()
        .select('name code')
        .sort({ name: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean();
      const ids = schools.map((s) => s._id);
      const [students, staff, ai, msgs] = await Promise.all([
        countsBySchool(Student, { schoolId: { $in: ids }, status: 'active' }),
        countsBySchool(User, { schoolId: { $in: ids }, role: { $in: [...STAFF_ROLES] }, status: 'active' }),
        AiUsage.aggregate([
          { $match: { schoolId: { $in: ids }, createdAt: { $gte: since } } },
          { $group: { _id: '$schoolId', tokens: { $sum: '$totalTokens' }, cost: { $sum: '$costUsd' } } },
        ]).option(X),
        MessageLog.aggregate([
          { $match: { schoolId: { $in: ids }, createdAt: { $gte: since }, status: 'sent' } },
          { $group: { _id: '$schoolId', sent: { $sum: 1 }, cost: { $sum: '$costPkr' } } },
        ]).option(X),
      ]);
      const aiBy = new Map(ai.map((r) => [r._id.toString(), r]));
      const msgBy = new Map(msgs.map((r) => [r._id.toString(), r]));
      const rows = [];
      for (const s of schools) {
        const id = s._id.toString();
        const limits = await getSchoolLimits(s._id);
        const row = {
          schoolId: s._id,
          name: s.name,
          code: s.code,
          activeStudents: students.get(id) ?? 0,
          staffUsers: staff.get(id) ?? 0,
          aiTokens: aiBy.get(id)?.tokens ?? 0,
          aiCostUsd: Math.round((aiBy.get(id)?.cost ?? 0) * 10000) / 10000,
          messagesSent: msgBy.get(id)?.sent ?? 0,
          messagingCostPkr: msgBy.get(id)?.cost ?? 0,
          limits,
        };
        const overLimit = [
          row.activeStudents > limits.maxStudents && 'students',
          row.staffUsers > limits.maxStaffUsers && 'staffUsers',
          row.aiTokens >= limits.aiMonthlyTokens && 'aiTokens',
          row.messagesSent >= limits.messagesPerMonth && 'messages',
        ].filter(Boolean) as string[];
        rows.push({ ...row, overLimit });
      }
      return { month: since.toISOString().slice(0, 7), schools: rows };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/ai-usage',
    tags,
    auth: 'platform',
    summary: 'AI usage and estimated cost by school, feature and outcome',
    query: z.object({ from: isoDate(), to: isoDate() }),
    response: z.object({
      totals: z.object({
        calls: z.number(),
        tokens: z.number(),
        estimatedCostUsd: z.number(),
        errors: z.number(),
        limited: z.number(),
      }),
      bySchool: z.array(
        z.object({
          schoolId: objectId(),
          name: z.string(),
          calls: z.number(),
          tokens: z.number(),
          estimatedCostUsd: z.number(),
        }),
      ),
      byFeature: z.array(
        z.object({ feature: z.string(), calls: z.number(), tokens: z.number(), estimatedCostUsd: z.number() }),
      ),
      errorsByCode: z.array(z.object({ code: z.string(), count: z.number() })),
    }),
    handler: async ({ query }) => {
      const { start, end } = localDayRange(query.from, query.to, DEFAULT_TIMEZONE);
      const match = { createdAt: { $gte: start, $lt: end } };
      const [totals, bySchool, byFeature, errors] = await Promise.all([
        AiUsage.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              calls: { $sum: 1 },
              tokens: { $sum: '$totalTokens' },
              cost: { $sum: '$costUsd' },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
              limited: { $sum: { $cond: [{ $eq: ['$status', 'limit_reached'] }, 1, 0] } },
            },
          },
        ]).option(X),
        AiUsage.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$schoolId',
              calls: { $sum: 1 },
              tokens: { $sum: '$totalTokens' },
              cost: { $sum: '$costUsd' },
            },
          },
          { $sort: { tokens: -1 } },
          { $limit: 100 },
          { $lookup: { from: 'schools', localField: '_id', foreignField: '_id', as: 's' } },
          { $unwind: '$s' },
          { $project: { _id: 0, schoolId: '$_id', name: '$s.name', calls: 1, tokens: 1, cost: 1 } },
        ]).option(X),
        AiUsage.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$feature',
              calls: { $sum: 1 },
              tokens: { $sum: '$totalTokens' },
              cost: { $sum: '$costUsd' },
            },
          },
        ]).option(X),
        AiUsage.aggregate([
          { $match: { ...match, status: { $ne: 'success' } } },
          { $group: { _id: { $ifNull: ['$errorCode', '$status'] }, count: { $sum: 1 } } },
        ]).option(X),
      ]);
      const r4 = (n: number) => Math.round(n * 10000) / 10000;
      const t = totals[0] ?? { calls: 0, tokens: 0, cost: 0, errors: 0, limited: 0 };
      return {
        totals: {
          calls: t.calls,
          tokens: t.tokens,
          estimatedCostUsd: r4(t.cost),
          errors: t.errors,
          limited: t.limited,
        },
        bySchool: bySchool.map((s) => ({
          schoolId: s.schoolId,
          name: s.name,
          calls: s.calls,
          tokens: s.tokens,
          estimatedCostUsd: r4(s.cost),
        })),
        byFeature: byFeature.map((f) => ({
          feature: f._id,
          calls: f.calls,
          tokens: f.tokens,
          estimatedCostUsd: r4(f.cost),
        })),
        errorsByCode: errors.map((e) => ({ code: e._id, count: e.count })),
      };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/health',
    tags,
    auth: 'platform',
    summary: 'API and database health',
    response: z.object({
      api: z.object({
        status: z.string(),
        uptimeSeconds: z.number(),
        nodeVersion: z.string(),
        memoryMb: z.object({ rss: z.number(), heapUsed: z.number() }),
        loadAverage: z.array(z.number()),
        environment: z.string(),
      }),
      database: z.object({ state: z.string(), pingOk: z.boolean(), latencyMs: z.number().nullable() }),
      scheduler: z.object({ enabled: z.boolean(), intervalSeconds: z.number() }),
    }),
    handler: async () => {
      const ping = await pingDatabase();
      const mem = process.memoryUsage();
      return {
        api: {
          status: 'ok',
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
          memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
          loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
          environment: env.NODE_ENV,
        },
        database: { state: databaseState(), pingOk: ping.ok, latencyMs: ping.latencyMs },
        scheduler: { enabled: env.SCHEDULER_ENABLED, intervalSeconds: env.SCHEDULER_INTERVAL_SECONDS },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/integrations',
    tags,
    auth: 'platform',
    summary: 'Integration configuration status and recent failures (no secrets)',
    response: z.object({
      ai: z.object({
        provider: z.string(),
        model: z.string(),
        configured: z.boolean(),
        last7Days: z.object({
          calls: z.number(),
          errors: z.number(),
          lastErrorAt: z.string().nullable(),
          errorsByCode: z.record(z.string(), z.number()),
        }),
      }),
      messaging: z.array(
        z.object({
          channel: z.string(),
          provider: z.string(),
          configured: z.boolean(),
          enabled: z.boolean().openapi({
            description:
              'False while the channel is paused (coming soon). Switch: SMS_ENABLED / WHATSAPP_ENABLED / EMAIL_SENDING_ENABLED.',
          }),
          status: z.enum(['available', 'coming_soon']),
          last7Days: z.object({
            sent: z.number(),
            failed: z.number(),
            notConfigured: z.number(),
            lastFailureAt: z.string().nullable(),
          }),
        }),
      ),
      push: z
        .object({
          configured: z.boolean(),
          credentials: z.enum(['none', 'service_account_file', 'adc']),
          projectId: z.string().nullable(),
          dryRun: z.boolean(),
          configError: z.string().nullable(),
          registeredDevices: z.number(),
          sinceStart: z.object({
            accepted: z.number().openapi({ description: 'Messages FCM accepted (not proof the phone showed them)' }),
            invalidDevicesRemoved: z.number(),
            failed: z.number(),
            lastSuccessAt: z.string().nullable(),
            lastFailureAt: z.string().nullable(),
            lastErrorCode: z.string().nullable(),
          }),
        })
        .openapi({ description: 'Firebase push (docs/PUSH_NOTIFICATIONS.md); no keys or tokens' }),
    }),
    handler: async () => {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const registeredDevices = await PushDevice.countDocuments({}).setOptions(X);
      const provider = await getAiProvider();
      const [ai, aiErrors, msgs] = await Promise.all([
        AiUsage.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: null,
              calls: { $sum: { $cond: [{ $in: ['$status', ['success', 'error']] }, 1, 0] } },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
              lastErrorAt: { $max: { $cond: [{ $eq: ['$status', 'error'] }, '$createdAt', null] } },
            },
          },
        ]).option(X),
        AiUsage.aggregate([
          { $match: { createdAt: { $gte: since }, status: 'error' } },
          { $group: { _id: '$errorCode', count: { $sum: 1 } } },
        ]).option(X),
        MessageLog.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: '$channel',
              sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              notConfigured: { $sum: { $cond: [{ $eq: ['$status', 'not_configured'] }, 1, 0] } },
              lastFailureAt: { $max: { $cond: [{ $eq: ['$status', 'failed'] }, '$createdAt', null] } },
            },
          },
        ]).option(X),
      ]);
      const msgBy = new Map(msgs.map((m) => [m._id, m]));
      return {
        ai: {
          provider: provider.name,
          model: provider.model,
          configured: provider.isConfigured(),
          last7Days: {
            calls: ai[0]?.calls ?? 0,
            errors: ai[0]?.errors ?? 0,
            lastErrorAt: ai[0]?.lastErrorAt?.toISOString?.() ?? null,
            errorsByCode: Object.fromEntries(aiErrors.map((e) => [e._id ?? 'UNKNOWN', e.count])),
          },
        },
        messaging: channelStatus().map((c) => {
          const m = msgBy.get(c.channel);
          return {
            channel: c.channel,
            provider: c.provider,
            configured: c.configured,
            enabled: isChannelEnabled(c.channel),
            status: isChannelEnabled(c.channel) ? ('available' as const) : ('coming_soon' as const),
            last7Days: {
              sent: m?.sent ?? 0,
              failed: m?.failed ?? 0,
              notConfigured: m?.notConfigured ?? 0,
              lastFailureAt: m?.lastFailureAt?.toISOString?.() ?? null,
            },
          };
        }),
        push: { ...pushStatus(), registeredDevices },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/errors',
    tags,
    auth: 'platform',
    summary: 'Server error summary (5xx and scheduler failures)',
    query: z.object({
      hours: z.coerce
        .number()
        .int()
        .min(1)
        .max(24 * 90)
        .default(24),
    }),
    response: z.object({
      since: z.string(),
      total: z.number(),
      byRoute: z.array(
        z.object({
          route: z.string().nullable(),
          code: z.string().nullable(),
          source: z.string(),
          count: z.number(),
          lastAt: z.string(),
        }),
      ),
      recent: z.array(
        z.object({
          requestId: z.string().optional(),
          method: z.string().optional(),
          route: z.string().optional(),
          status: z.number().optional(),
          code: z.string().optional(),
          source: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async ({ query }) => {
      const since = new Date(Date.now() - query.hours * 3_600_000);
      const [byRoute, recent, total] = await Promise.all([
        ErrorEvent.aggregate([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: { route: '$route', code: '$code', source: '$source' },
              count: { $sum: 1 },
              lastAt: { $max: '$createdAt' },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 50 },
        ]),
        // Error messages are omitted: they can contain internal details.
        ErrorEvent.find({ createdAt: { $gte: since } })
          .select('requestId method route status code source createdAt')
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
        ErrorEvent.countDocuments({ createdAt: { $gte: since } }),
      ]);
      return {
        since: since.toISOString(),
        total,
        byRoute: byRoute.map((r) => ({
          route: r._id.route ?? null,
          code: r._id.code ?? null,
          source: r._id.source,
          count: r.count,
          lastAt: r.lastAt.toISOString(),
        })),
        recent: recent as any,
      };
    },
  });

  api.route({
    method: 'get',
    path: '/platform/audit-events',
    tags,
    auth: 'platform',
    summary: 'Audit events: platform actions, and optionally a specific school’s events',
    description:
      'Without `schoolId` returns platform-level events. With `schoolId` returns that school’s audit trail (metadata only).',
    query: paginationQuery.extend({
      schoolId: objectId().optional(),
      action: z.string().max(80).optional(),
      actorId: objectId().optional(),
    }),
    response: AuditRes,
    paginated: true,
    handler: ({ query }) => {
      const filter: Record<string, unknown> = query.schoolId
        ? { schoolId: new Types.ObjectId(query.schoolId) }
        : { schoolId: null };
      if (query.action) filter.action = query.action;
      if (query.actorId) filter.actorId = new Types.ObjectId(query.actorId);
      return paginate(AuditLog, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
    },
  });

  api.route({
    method: 'get',
    path: '/platform/admin-activity',
    tags,
    auth: 'platform',
    summary: 'Platform administrator activity (last login, actions in the last 30 days)',
    response: z.array(
      z.object({
        _id: objectId(),
        name: z.string(),
        email: z.string(),
        role: z.string(),
        status: z.string(),
        lastLoginAt: z.string().nullable(),
        actionsLast30Days: z.number(),
        lastActionAt: z.string().nullable(),
      }),
    ),
    handler: async () => {
      const admins = await PlatformAdmin.find().select(PLATFORM_ADMIN_PUBLIC_FIELDS).lean();
      const activity = await AuditLog.aggregate([
        { $match: { actorType: 'platform_admin', createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } } },
        { $group: { _id: '$actorId', count: { $sum: 1 }, last: { $max: '$createdAt' } } },
      ]);
      const by = new Map(activity.map((a) => [a._id?.toString(), a]));
      return admins.map((a) => ({
        _id: a._id,
        name: a.name,
        email: a.email,
        role: a.role,
        status: a.status,
        lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
        actionsLast30Days: by.get(a._id.toString())?.count ?? 0,
        lastActionAt: by.get(a._id.toString())?.last?.toISOString() ?? null,
      }));
    },
  });

  // ─────────────────────────── Platform administrators ───────────────────────────
  const AdminRes = z
    .object({
      _id: objectId(),
      name: z.string(),
      email: z.string(),
      role: z.enum(['platform_owner', 'platform_admin']),
      status: z.string(),
      lastLoginAt: z.string().optional(),
    })
    .openapi('PlatformAdmin');

  api.route({
    method: 'get',
    path: '/platform/admins',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'List platform administrators',
    response: z.array(AdminRes),
    handler: () => PlatformAdmin.find().select(PLATFORM_ADMIN_PUBLIC_FIELDS).sort({ createdAt: 1 }).lean(),
  });

  api.route({
    method: 'post',
    path: '/platform/admins',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Create a platform administrator',
    body: z.object({
      name: z.string().trim().min(2).max(100),
      email: email(),
      role: z.enum(['platform_owner', 'platform_admin']),
      password: password(),
    }),
    response: AdminRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      if (await PlatformAdmin.exists({ email: body.email }))
        throw conflict('An administrator with this email already exists');
      const admin = await PlatformAdmin.create({
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      });
      await audit(ctx, {
        action: 'platform.admin.created',
        entityType: 'PlatformAdmin',
        entityId: admin._id,
        metadata: { role: body.role },
      });
      return PlatformAdmin.findById(admin._id).select(PLATFORM_ADMIN_PUBLIC_FIELDS).lean();
    },
  });

  api.route({
    method: 'patch',
    path: '/platform/admins/:id',
    tags,
    auth: 'platform',
    platformRoles: [...ownerOnly],
    summary: 'Change role or disable a platform administrator',
    params: idParams,
    body: z.object({
      role: z.enum(['platform_owner', 'platform_admin']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
    }),
    response: AdminRes,
    handler: async ({ ctx, params, body }) => {
      if (params.id === (ctx as PlatformContext).adminId) throw forbidden('You cannot change your own role or status');
      const update: Record<string, unknown> = { $set: body };
      if (body.role || body.status === 'disabled') update.$inc = { tokenVersion: 1 };
      const admin = await PlatformAdmin.findByIdAndUpdate(params.id, update, { returnDocument: 'after' })
        .select(PLATFORM_ADMIN_PUBLIC_FIELDS)
        .lean();
      if (!admin) throw notFound('Platform administrator');
      if (body.role || body.status === 'disabled') await revokeAllForSubject('platform', params.id, 'account_changed');
      await audit(ctx, {
        action: 'platform.admin.updated',
        entityType: 'PlatformAdmin',
        entityId: params.id,
        metadata: body,
      });
      return admin;
    },
  });
}
