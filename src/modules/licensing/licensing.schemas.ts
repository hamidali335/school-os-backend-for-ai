import { z } from '../../utils/zod';

export const ActivateDeviceSchema = z.object({
  deviceId: z.string().min(3).max(64),
  hardwareFingerprint: z.string().min(16).max(128),
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['windows_desktop', 'mobile', 'web', 'other']).default('windows_desktop'),
});

export const VerifyDeviceSchema = z.object({
  licenseId: z.string().min(3),
  deviceId: z.string().min(3).max(64),
  hardwareFingerprint: z.string().min(16).max(128),
});

export const DeactivateDeviceSchema = z.object({
  deviceId: z.string().min(3).max(64),
});

export const ReplaceDeviceSchema = z.object({
  oldDeviceId: z.string().min(3).max(64),
  newDeviceId: z.string().min(3).max(64),
  hardwareFingerprint: z.string().min(16).max(128),
  deviceName: z.string().min(1).max(100),
  reason: z.string().max(250).optional(),
});

export const RevokeDeviceSchema = z.object({
  reason: z.string().min(3).max(250),
});

export const LicenseResponseSchema = z.object({
  success: z.boolean(),
  licenseId: z.string(),
  schoolId: z.string(),
  schoolName: z.string(),
  schoolCode: z.string(),
  deviceId: z.string(),
  planCode: z.string(),
  status: z.enum(['active', 'revoked', 'expired']),
  issuedAt: z.string(),
  expiresAt: z.string(),
  gracePeriodDays: z.number(),
  entitlements: z.array(z.string()),
  limits: z.record(z.string(), z.any()),
  licenseVersion: z.number(),
  signedPayload: z.string(),
  signature: z.string(),
  publicKey: z.string(),
  serverTime: z.string(),
});
