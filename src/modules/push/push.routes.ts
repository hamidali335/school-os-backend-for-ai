import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import * as svc from './push.service';

const TokenBody = z.object({ token: z.string().trim().min(20).max(4096), platform: z.literal('android').default('android') });
const RegisterBody = TokenBody.extend({
  installationId: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional()
    .openapi({ description: 'Random id the app keeps per installation, so a refreshed token replaces the old one' }),
});

export function registerPushRoutes(api: Api) {
  const tags = ['Push'];

  api.route({
    method: 'put',
    path: '/devices/push',
    tags,
    auth: 'school',
    summary: 'Register this device for push (school notifications, and incoming calls where the plan has calls)',
    description:
      'The device token from Firebase Cloud Messaging. Any signed-in school user: push carries only that user’s own notifications, and calls are still authorized per call. `pushConfigured` says whether this server can send push at all (docs/PUSH_NOTIFICATIONS.md).',
    body: RegisterBody,
    response: z.object({ pushConfigured: z.boolean() }),
    handler: ({ ctx, body }) => svc.registerDevice(ctx, body.token, body.installationId),
  });

  api.route({
    method: 'delete',
    path: '/devices/push',
    tags,
    auth: 'school',
    status: 204,
    summary: 'Stop push to this device (before signing out)',
    body: TokenBody,
    handler: ({ ctx, body }) => svc.unregisterDevice(ctx, body.token),
  });
}
