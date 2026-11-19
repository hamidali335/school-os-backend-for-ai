import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import { getLicensePublicKeyPem } from './licensing.crypto';
import {
  ActivateDeviceSchema,
  DeactivateDeviceSchema,
  LicenseResponseSchema,
  ReplaceDeviceSchema,
  RevokeDeviceSchema,
  VerifyDeviceSchema,
} from './licensing.schemas';
import {
  activateDevice,
  deactivateDevice,
  listSchoolDevices,
  replaceDevice,
  revokeDevice,
  verifyDeviceLicense,
} from './licensing.service';

export function registerLicensingRoutes(api: Api) {
  const tags = ['Licensing & Activation'];

  // Public key retrieval for offline client distribution and key rotation
  api.route({
    method: 'get',
    path: '/licensing/public-key',
    tags,
    auth: 'public',
    summary: 'Get public Ed25519 verification key for offline desktop license verification',
    response: z.object({
      algorithm: z.string(),
      publicKey: z.string(),
      version: z.number(),
    }),
    handler: () => ({
      algorithm: 'Ed25519',
      publicKey: getLicensePublicKeyPem(),
      version: 1,
    }),
  });

  // Activate device & issue signed license
  api.route({
    method: 'post',
    path: '/licensing/activate',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Activate desktop workstation and issue signed device-bound license',
    body: ActivateDeviceSchema,
    response: LicenseResponseSchema,
    handler: ({ ctx, body }) => activateDevice(ctx, body),
  });

  // Verify / Revalidate device license
  api.route({
    method: 'post',
    path: '/licensing/verify',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Verify and refresh signed device license',
    body: VerifyDeviceSchema,
    response: LicenseResponseSchema,
    handler: ({ ctx, body }) => verifyDeviceLicense(ctx, body),
  });

  // Deactivate workstation
  api.route({
    method: 'post',
    path: '/licensing/deactivate',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Deactivate current workstation and release device seat',
    body: DeactivateDeviceSchema,
    response: z.object({ success: z.boolean(), message: z.string() }),
    handler: ({ ctx, body }) => deactivateDevice(ctx, body.deviceId),
  });

  // Replace device (hardware swap)
  api.route({
    method: 'post',
    path: '/licensing/replace',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Replace an authorized device with a new machine',
    body: ReplaceDeviceSchema,
    response: LicenseResponseSchema,
    handler: ({ ctx, body }) => replaceDevice(ctx, body),
  });

  // List authorized school devices
  api.route({
    method: 'get',
    path: '/licensing/devices',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'List all registered devices and licenses for the authenticated school',
    response: z.array(
      z.object({
        licenseId: z.string(),
        deviceId: z.string(),
        deviceName: z.string(),
        status: z.string(),
        issuedAt: z.date(),
        expiresAt: z.date(),
        lastVerifiedAt: z.date(),
        lastSeenAt: z.date().optional(),
        platform: z.string(),
        revokedAt: z.date().nullable().optional(),
        revocationReason: z.string().nullable().optional(),
      }),
    ),
    handler: ({ ctx }) => listSchoolDevices(ctx.schoolId),
  });

  // Revoke device seat
  api.route({
    method: 'post',
    path: '/licensing/devices/:deviceId/revoke',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Revoke an authorized device license',
    params: z.object({ deviceId: z.string() }),
    body: RevokeDeviceSchema,
    response: z.object({ success: z.boolean(), message: z.string() }),
    handler: ({ ctx, params, body }) =>
      revokeDevice(ctx.schoolId, params.deviceId, body.reason, ctx.userId),
  });
}
