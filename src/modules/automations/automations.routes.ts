import { assertChannelsEnabled } from '../../config/features';
import type { Api } from '../../utils/api';
import { conflict } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, objectId, paginationQuery, z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { School } from '../schools/school.model';
import { AUTOMATION_TYPES, AutomationRule, AutomationRun } from './automation.models';
import { AUTOMATION_TEMPLATES, computeNextRun, executeRule } from './automations.service';

const ScheduleSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly']).default('daily'),
    hour: z.number().int().min(0).max(23).default(9).openapi({ description: "Hour in the school's timezone" }),
    weekday: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .openapi({ description: '1 = Monday … 7 = Sunday (weekly rules)' }),
  })
  .refine((s) => s.frequency !== 'weekly' || s.weekday, {
    message: 'weekday is required for weekly rules',
    path: ['weekday'],
  });

const ConfigSchema = z.object({
  channels: z
    .array(z.enum(['sms', 'whatsapp', 'email']))
    .max(3)
    .optional()
    .openapi({
      description:
        'External channels (always approval-gated). Channels that are paused (coming soon) are rejected with 503 CHANNEL_PAUSED.',
    }),
  minDaysOverdue: z.number().int().min(0).max(120).optional(),
});

const RuleRes = z
  .object({
    ...docBase,
    type: z.enum(AUTOMATION_TYPES),
    name: z.string(),
    enabled: z.boolean(),
    schedule: z.object({ frequency: z.string(), hour: z.number(), weekday: z.number().optional() }),
    config: z.object({ channels: z.array(z.string()), minDaysOverdue: z.number() }),
    nextRunAt: z.string().optional(),
    lastRunAt: z.string().optional(),
    lastRunStatus: z.string().optional(),
  })
  .openapi('AutomationRule');

const RunRes = z
  .object({
    ...docBase,
    ruleId: objectId(),
    type: z.enum(AUTOMATION_TYPES),
    trigger: z.enum(['schedule', 'manual']),
    status: z.enum(['success', 'failed', 'skipped']),
    summary: z.string().optional(),
    result: z.record(z.string(), z.any()).optional(),
    error: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
  })
  .openapi('AutomationRun');

async function tz(schoolId: string) {
  const s = await School.findById(schoolId).select('settings.timezone').lean();
  return s?.settings?.timezone ?? 'Asia/Karachi';
}

export function registerAutomationRoutes(api: Api) {
  const tags = ['Automations'];

  api.route({
    method: 'get',
    path: '/automations/templates',
    tags,
    auth: 'school',
    permission: 'automations:read',
    summary: 'Available automation types and whether they require approval',
    response: z.array(
      z.object({
        type: z.enum(AUTOMATION_TYPES),
        name: z.string(),
        description: z.string(),
        requiresApproval: z.string(),
      }),
    ),
    handler: () => AUTOMATION_TYPES.map((type) => ({ type, ...AUTOMATION_TEMPLATES[type] })),
  });

  api.route({
    method: 'get',
    path: '/automations',
    tags,
    auth: 'school',
    permission: 'automations:read',
    summary: 'List automation rules',
    response: z.array(RuleRes),
    handler: ({ ctx }) => AutomationRule.find(scope(ctx)).select('-lockedUntil').sort({ createdAt: 1 }).lean(),
  });

  api.route({
    method: 'post',
    path: '/automations',
    tags,
    auth: 'school',
    permission: 'automations:manage',
    summary: 'Create an automation rule',
    body: z.object({
      type: z.enum(AUTOMATION_TYPES),
      name: z.string().trim().min(3).max(80).optional(),
      enabled: z.boolean().default(true),
      schedule: ScheduleSchema,
      config: ConfigSchema.optional(),
    }),
    response: RuleRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      assertChannelsEnabled(body.config?.channels ?? []);
      if (await AutomationRule.exists(scope(ctx, { type: body.type })))
        throw conflict('A rule of this type already exists; edit it instead');
      const rule = await AutomationRule.create({
        ...body,
        schoolId: ctx.schoolId,
        name: body.name ?? AUTOMATION_TEMPLATES[body.type].name,
        nextRunAt: computeNextRun(body.schedule, await tz(ctx.schoolId)),
        createdBy: ctx.userId,
      });
      await audit(ctx, {
        action: 'automation.create',
        entityType: 'AutomationRule',
        entityId: rule._id,
        metadata: { type: body.type },
      });
      return rule.toObject();
    },
  });

  api.route({
    method: 'patch',
    path: '/automations/:id',
    tags,
    auth: 'school',
    permission: 'automations:manage',
    summary: 'Update or enable/disable a rule',
    params: idParams,
    body: z.object({
      name: z.string().trim().min(3).max(80).optional(),
      enabled: z.boolean().optional(),
      schedule: ScheduleSchema.optional(),
      config: ConfigSchema.optional(),
    }),
    response: RuleRes,
    handler: async ({ ctx, params, body }) => {
      const rule = await findOwned(AutomationRule, ctx, params.id, 'Automation rule');
      const set: Record<string, unknown> = { ...body };
      if (body.schedule || body.enabled)
        set.nextRunAt = computeNextRun(body.schedule ?? (rule.schedule as any), await tz(ctx.schoolId));
      if (body.config) {
        delete set.config;
        if (body.config.channels) {
          // Only newly added channels must be available; channels the rule already had are kept
          // (they stay paused at run time) so editing the schedule never loses saved settings.
          const existing = (rule.config?.channels ?? []) as string[];
          assertChannelsEnabled(body.config.channels.filter((c) => !existing.includes(c)));
          set['config.channels'] = body.config.channels;
        }
        if (body.config.minDaysOverdue !== undefined) set['config.minDaysOverdue'] = body.config.minDaysOverdue;
      }
      const updated = await AutomationRule.findOneAndUpdate(
        scope(ctx, { _id: rule._id }),
        { $set: set },
        { returnDocument: 'after' },
      )
        .select('-lockedUntil')
        .lean();
      await audit(ctx, {
        action: 'automation.update',
        entityType: 'AutomationRule',
        entityId: rule._id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    },
  });

  api.route({
    method: 'delete',
    path: '/automations/:id',
    tags,
    auth: 'school',
    permission: 'automations:manage',
    summary: 'Delete a rule',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const rule = await findOwned(AutomationRule, ctx, params.id, 'Automation rule');
      await AutomationRule.deleteOne(scope(ctx, { _id: rule._id }));
      await audit(ctx, { action: 'automation.delete', entityType: 'AutomationRule', entityId: rule._id });
    },
  });

  api.route({
    method: 'post',
    path: '/automations/:id/run',
    tags,
    auth: 'school',
    permission: 'automations:manage',
    summary: 'Run a rule now',
    description:
      'Runs synchronously and returns the run log. Sensitive outputs (external messages) still go to the approval queue.',
    params: idParams,
    response: RunRes,
    handler: async ({ ctx, params }) => {
      const rule = await findOwned(AutomationRule, ctx, params.id, 'Automation rule');
      const run = await executeRule(ctx.schoolId, rule as any, 'manual', ctx);
      await audit(ctx, {
        action: 'automation.run',
        entityType: 'AutomationRule',
        entityId: rule._id,
        metadata: { status: run.status },
      });
      return run;
    },
  });

  api.route({
    method: 'get',
    path: '/automations/runs',
    tags,
    auth: 'school',
    permission: 'automations:read',
    summary: 'Action execution log of automation runs',
    query: paginationQuery.extend({
      ruleId: objectId().optional(),
      status: z.enum(['success', 'failed', 'skipped']).optional(),
    }),
    response: RunRes,
    paginated: true,
    handler: ({ ctx, query }) =>
      paginate(
        AutomationRun,
        scope(ctx, {
          ...(query.ruleId ? { ruleId: oid(query.ruleId) } : {}),
          ...(query.status ? { status: query.status } : {}),
        }),
        { page: query.page, limit: query.limit, sort: { createdAt: -1 } },
      ),
  });
}
