import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import { acknowledgeStep, getOnboarding, STEPS, updateOnboardingState, visitStep } from './onboarding.service';

const StepRes = z.object({
  key: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string(),
  required: z.boolean(),
  manual: z.boolean(),
  dependsOn: z.array(z.string()),
  blockedBy: z.array(z.string()),
  action: z.object({ label: z.string(), href: z.string() }),
  status: z.enum(['complete', 'incomplete', 'attention', 'blocked']).openapi({
    description:
      '`attention`: was complete before but the data is now missing; `blocked`: an earlier step must be done first',
  }),
  detail: z.string().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  completedAt: z.string().nullable(),
});

const GuideRes = z
  .object({
    steps: z.array(StepRes),
    summary: z.object({
      done: z.number(),
      total: z.number(),
      requiredDone: z.number(),
      requiredTotal: z.number(),
      allRequiredComplete: z.boolean(),
      nextStep: z.string().nullable(),
    }),
    state: z.object({ minimized: z.boolean(), dismissed: z.boolean(), dismissedAt: z.string().nullable() }),
  })
  .openapi('SetupGuide');

export function registerOnboardingRoutes(api: Api) {
  const tags = ['Setup guide'];

  api.route({
    method: 'get',
    path: '/onboarding',
    tags,
    auth: 'school',
    permission: 'onboarding:manage',
    allowInactiveSubscription: true,
    summary: 'Step-by-step school setup guide with live progress',
    description:
      'A step is complete once its page has been opened, or as soon as the school’s data shows the work is done. The data checks still run on every request and appear as the step detail.',
    response: GuideRes,
    handler: ({ ctx }) => getOnboarding(ctx),
  });

  api.route({
    method: 'patch',
    path: '/onboarding',
    tags,
    auth: 'school',
    permission: 'onboarding:manage',
    allowInactiveSubscription: true,
    summary: 'Minimise, dismiss or resume the setup guide (saved for the school)',
    body: z.object({ minimized: z.boolean().optional(), dismissed: z.boolean().optional() }),
    response: GuideRes,
    handler: ({ ctx, body }) => updateOnboardingState(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/onboarding/steps/:key/acknowledge',
    tags,
    auth: 'school',
    permission: 'onboarding:manage',
    allowInactiveSubscription: true,
    summary: 'Mark a review-only step as done (or not done)',
    params: z.object({ key: z.enum(STEPS.map((s) => s.key) as [string, ...string[]]) }),
    body: z.object({ acknowledged: z.boolean() }),
    response: GuideRes,
    handler: ({ ctx, params, body }) => acknowledgeStep(ctx, params.key, body.acknowledged),
  });

  api.route({
    method: 'post',
    path: '/onboarding/steps/:key/visit',
    tags,
    auth: 'school',
    permission: 'onboarding:manage',
    allowInactiveSubscription: true,
    summary: 'Record that a step’s page was opened (this completes the step)',
    params: z.object({ key: z.enum(STEPS.map((s) => s.key) as [string, ...string[]]) }),
    response: GuideRes,
    handler: ({ ctx, params }) => visitStep(ctx, params.key),
  });
}
