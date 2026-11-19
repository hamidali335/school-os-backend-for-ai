import crypto from 'node:crypto';
import type { SchoolContext } from '../../types/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { School } from '../schools/school.model';
import { computeEntitlements, planForEntitlements } from '../subscriptions/entitlements.service';
import { getSchoolLimits } from '../subscriptions/limits.service';
import { SyncDevice } from '../sync/sync.models';
import { getLicensePublicKeyPem, signLicensePayload } from './licensing.crypto';
import { License, LicenseAuditLog } from './licensing.models';
import type {
  ActivateDeviceSchema,
  ReplaceDeviceSchema,
  VerifyDeviceSchema,
} from './licensing.schemas';
import { z } from '../../utils/zod';

export async function activateDevice(
  ctx: SchoolContext,
  input: z.infer<typeof ActivateDeviceSchema>,
) {
  const school = await School.findById(ctx.schoolId);
  if (!school) {
    throw notFound('School tenant not found');
  }

  // 1. Verify school subscription status
  const subStatus = school.subscription?.status || 'trialing';
  if (subStatus === 'cancelled' || subStatus === 'expired') {
    throw forbidden(`School subscription is ${subStatus}. Device activation cannot proceed.`);
  }

  // 2. Fetch plan and effective limits
  const plan = await planForEntitlements(school.subscription?.planId);
  const limits = await getSchoolLimits(ctx.schoolId);
  const maxDevices = (limits as any).maxDevices || 2;
  const gracePeriodDays = (limits as any).offlineGraceDays || 7;

  // 3. Enforce device limit
  const existingLicense = await License.findOne({
    schoolId: ctx.schoolId,
    deviceId: input.deviceId,
  });

  if (!existingLicense || existingLicense.status === 'revoked') {
    const activeCount = await License.countDocuments({
      schoolId: ctx.schoolId,
      status: 'active',
      deviceId: { $ne: input.deviceId },
    });

    if (activeCount >= maxDevices) {
      throw new AppError(
        403,
        'DEVICE_LIMIT_EXCEEDED',
        `Device activation limit reached (${activeCount}/${maxDevices} active devices). Please revoke an unused device or upgrade your plan.`,
        { activeCount, maxDevices },
      );
    }
  }

  // 4. Determine expiration date
  const now = new Date();
  let expiresAt: Date;
  if (school.subscription?.currentPeriodEnd) {
    expiresAt = new Date(school.subscription.currentPeriodEnd);
  } else if (school.subscription?.trialEndsAt) {
    expiresAt = new Date(school.subscription.trialEndsAt);
  } else {
    expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30-day default
  }

  // 5. Compute feature entitlements
  const { features } = computeEntitlements(school.subscription as any, plan);

  const licenseId = existingLicense?.licenseId || `lic_${crypto.randomUUID().replace(/-/g, '')}`;

  const payloadToSign = {
    licenseId,
    schoolId: String(school._id),
    schoolName: school.name,
    schoolCode: school.code,
    deviceId: input.deviceId,
    hardwareFingerprint: input.hardwareFingerprint,
    planCode: plan?.code || 'standard',
    planName: plan?.name || 'Standard School Plan',
    status: 'active',
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    gracePeriodDays,
    entitlements: Array.from(features),
    limits: {
      maxStudents: limits.maxStudents,
      maxDevices,
      maxStaffUsers: limits.maxStaffUsers,
    },
    licenseVersion: 1,
  };

  const { signedPayload, signature } = signLicensePayload(payloadToSign);

  // 6. Persist or update License record
  const licenseDoc = await License.findOneAndUpdate(
    { schoolId: ctx.schoolId, deviceId: input.deviceId },
    {
      licenseId,
      schoolId: ctx.schoolId,
      deviceId: input.deviceId,
      hardwareFingerprint: input.hardwareFingerprint,
      deviceName: input.deviceName,
      planCode: payloadToSign.planCode,
      status: 'active',
      issuedAt: now,
      expiresAt,
      gracePeriodDays,
      entitlements: payloadToSign.entitlements,
      limits: payloadToSign.limits,
      licenseVersion: 1,
      signature,
      signedPayload,
      lastVerifiedAt: now,
      revokedAt: null,
      revocationReason: null,
    },
    { upsert: true, returnDocument: 'after' },
  );

  // 7. Ensure SyncDevice is recorded
  await SyncDevice.findOneAndUpdate(
    { schoolId: ctx.schoolId, deviceId: input.deviceId },
    {
      deviceName: input.deviceName,
      platform: input.platform,
      status: 'registered',
      lastSeenAt: now,
      lastHandshakeAt: now,
      metadata: { hardwareFingerprint: input.hardwareFingerprint },
    },
    { upsert: true },
  );

  // 8. Audit logging
  await LicenseAuditLog.create({
    schoolId: ctx.schoolId,
    deviceId: input.deviceId,
    action: 'activated',
    performedBy: ctx.userId,
    details: {
      deviceName: input.deviceName,
      planCode: payloadToSign.planCode,
      licenseId,
    },
  });

  return {
    success: true,
    ...payloadToSign,
    signedPayload,
    signature,
    publicKey: getLicensePublicKeyPem(),
    serverTime: now.toISOString(),
  };
}

export async function verifyDeviceLicense(
  ctx: SchoolContext,
  input: z.infer<typeof VerifyDeviceSchema>,
) {
  const school = await School.findById(ctx.schoolId);
  if (!school) {
    throw notFound('School tenant not found');
  }

  const license = await License.findOne({
    schoolId: ctx.schoolId,
    deviceId: input.deviceId,
  });

  if (!license) {
    throw notFound('No license found for this device');
  }

  if (license.status === 'revoked') {
    throw new AppError(
      403,
      'LICENSE_REVOKED',
      `Device license has been revoked. Reason: ${license.revocationReason || 'Administrative revocation'}`,
    );
  }

  if (license.hardwareFingerprint !== input.hardwareFingerprint) {
    throw new AppError(
      403,
      'DEVICE_FINGERPRINT_MISMATCH',
      'Hardware fingerprint does not match the activated device profile.',
    );
  }

  const now = new Date();
  const plan = await planForEntitlements(school.subscription?.planId);
  const limits = await getSchoolLimits(ctx.schoolId);
  const maxDevices = (limits as any).maxDevices || 2;
  const gracePeriodDays = (limits as any).offlineGraceDays || 7;

  let expiresAt: Date;
  if (school.subscription?.currentPeriodEnd) {
    expiresAt = new Date(school.subscription.currentPeriodEnd);
  } else if (school.subscription?.trialEndsAt) {
    expiresAt = new Date(school.subscription.trialEndsAt);
  } else {
    expiresAt = license.expiresAt;
  }

  const { features } = computeEntitlements(school.subscription as any, plan);

  const payloadToSign = {
    licenseId: license.licenseId,
    schoolId: String(school._id),
    schoolName: school.name,
    schoolCode: school.code,
    deviceId: input.deviceId,
    hardwareFingerprint: input.hardwareFingerprint,
    planCode: plan?.code || license.planCode,
    planName: plan?.name || 'Standard School Plan',
    status: 'active',
    issuedAt: license.issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    gracePeriodDays,
    entitlements: Array.from(features),
    limits: {
      maxStudents: limits.maxStudents,
      maxDevices,
      maxStaffUsers: limits.maxStaffUsers,
    },
    licenseVersion: license.licenseVersion,
  };

  const { signedPayload, signature } = signLicensePayload(payloadToSign);

  license.lastVerifiedAt = now;
  license.expiresAt = expiresAt;
  license.entitlements = payloadToSign.entitlements;
  license.limits = payloadToSign.limits;
  license.signedPayload = signedPayload;
  license.signature = signature;
  await license.save();

  await SyncDevice.updateOne(
    { schoolId: ctx.schoolId, deviceId: input.deviceId },
    { lastSeenAt: now, lastHandshakeAt: now },
  );

  return {
    success: true,
    ...payloadToSign,
    signedPayload,
    signature,
    publicKey: getLicensePublicKeyPem(),
    serverTime: now.toISOString(),
  };
}

export async function deactivateDevice(ctx: SchoolContext, deviceId: string) {
  const license = await License.findOne({ schoolId: ctx.schoolId, deviceId });
  if (license) {
    license.status = 'revoked';
    license.revokedAt = new Date();
    license.revocationReason = 'Deactivated by user';
    await license.save();
  }

  await SyncDevice.updateOne(
    { schoolId: ctx.schoolId, deviceId },
    { status: 'revoked' },
  );

  await LicenseAuditLog.create({
    schoolId: ctx.schoolId,
    deviceId,
    action: 'deactivated',
    performedBy: ctx.userId,
    details: { reason: 'User requested deactivation' },
  });

  return { success: true, message: 'Device successfully deactivated' };
}

export async function replaceDevice(
  ctx: SchoolContext,
  input: z.infer<typeof ReplaceDeviceSchema>,
) {
  // 1. Deactivate old device
  await License.updateOne(
    { schoolId: ctx.schoolId, deviceId: input.oldDeviceId },
    {
      status: 'revoked',
      revokedAt: new Date(),
      revocationReason: `Replaced by device ${input.newDeviceId}: ${input.reason || 'Hardware upgrade'}`,
    },
  );

  await SyncDevice.updateOne(
    { schoolId: ctx.schoolId, deviceId: input.oldDeviceId },
    { status: 'revoked' },
  );

  await LicenseAuditLog.create({
    schoolId: ctx.schoolId,
    deviceId: input.oldDeviceId,
    action: 'device_replaced',
    performedBy: ctx.userId,
    details: { newDeviceId: input.newDeviceId, reason: input.reason },
  });

  // 2. Activate new device
  return activateDevice(ctx, {
    deviceId: input.newDeviceId,
    hardwareFingerprint: input.hardwareFingerprint,
    deviceName: input.deviceName,
    platform: 'windows_desktop',
  });
}

export async function listSchoolDevices(schoolId: string) {
  const [licenses, devices] = await Promise.all([
    License.find({ schoolId }).sort({ createdAt: -1 }).lean(),
    SyncDevice.find({ schoolId }).sort({ createdAt: -1 }).lean(),
  ]);

  const deviceMap = new Map(devices.map((d) => [d.deviceId, d]));

  return licenses.map((lic) => {
    const syncDev = deviceMap.get(lic.deviceId);
    return {
      licenseId: lic.licenseId,
      deviceId: lic.deviceId,
      deviceName: lic.deviceName,
      status: lic.status,
      issuedAt: lic.issuedAt,
      expiresAt: lic.expiresAt,
      lastVerifiedAt: lic.lastVerifiedAt,
      lastSeenAt: syncDev?.lastSeenAt,
      platform: syncDev?.platform || 'windows_desktop',
      revokedAt: lic.revokedAt,
      revocationReason: lic.revocationReason,
    };
  });
}

export async function revokeDevice(
  schoolId: string,
  deviceId: string,
  reason: string,
  performedBy?: any,
) {
  const license = await License.findOne({ schoolId, deviceId });
  if (!license) {
    throw notFound('License for device not found');
  }

  license.status = 'revoked';
  license.revokedAt = new Date();
  license.revocationReason = reason;
  await license.save();

  await SyncDevice.updateOne({ schoolId, deviceId }, { status: 'revoked' });

  await LicenseAuditLog.create({
    schoolId,
    deviceId,
    action: 'revoked',
    performedBy,
    details: { reason },
  });

  return { success: true, message: `Device ${deviceId} revoked successfully` };
}
