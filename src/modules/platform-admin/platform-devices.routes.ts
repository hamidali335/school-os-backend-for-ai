import { authIpLimiter, authLimiter } from '../../middleware/rate-limit';
import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import { enrollDevice } from './platform-devices';

export function registerPlatformDeviceRoutes(api: Api) {
  api.route({
    method: 'post',
    path: '/platform/devices/enroll',
    tags: ['Platform'],
    auth: 'public',
    summary: 'Register this browser as a trusted platform device with a one-time setup code',
    description:
      'Used when PLATFORM_DEVICE_ONLY is on (docs/PLATFORM_REMOTE_ACCESS.md). The code is created on the server with `npm run platform:device -- add <name>`, is valid for 15 minutes and works once. The returned device key is shown only here; the browser sends it as `X-Platform-Device` with every platform request. It is not a login: the platform password is still required.',
    middleware: [authIpLimiter, authLimiter],
    body: z.object({ code: z.string().trim().min(12).max(20) }),
    response: z.object({ deviceKey: z.string(), name: z.string() }),
    handler: ({ body }) => enrollDevice(body.code),
  });
}
