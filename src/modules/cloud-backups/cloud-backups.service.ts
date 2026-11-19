import crypto from 'node:crypto';
import type { SchoolContext } from '../../types/context';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { SchoolBackup } from './cloud-backups.models';
import { getCloudBackupStorage } from './cloud-backups.storage';

const DEFAULT_CLOUD_RETENTION = 10;
const MAX_BACKUP_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

export interface UploadBackupMeta {
  backupId: string;
  deviceId: string;
  fileName: string;
  checksumSha256: string;
  schemaVersion?: number;
  triggerType?: 'manual' | 'scheduled' | 'pre_migration' | 'maintenance';
  isEncrypted?: boolean;
  encryptionAlgorithm?: string;
}

export async function uploadSchoolBackup(
  ctx: SchoolContext,
  meta: UploadBackupMeta,
  buffer: Buffer,
) {
  if (!buffer || buffer.length === 0) {
    throw badRequest('Backup file content is empty');
  }

  if (buffer.length > MAX_BACKUP_SIZE_BYTES) {
    throw badRequest(`Backup file exceeds maximum allowed size of ${MAX_BACKUP_SIZE_BYTES} bytes`);
  }

  // 1. Verify file integrity checksum
  const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (meta.checksumSha256 && meta.checksumSha256.toLowerCase() !== computedSha256.toLowerCase()) {
    throw badRequest('Checksum mismatch: backup file corrupted during transit');
  }

  // 2. Duplicate detection
  const existingBackup = await SchoolBackup.findOne({
    schoolId: ctx.schoolId,
    $or: [{ backupId: meta.backupId }, { checksumSha256: computedSha256 }],
    status: 'completed',
  });

  if (existingBackup) {
    return {
      success: true,
      backupId: existingBackup.backupId,
      status: existingBackup.status,
      fileSizeBytes: existingBackup.fileSizeBytes,
      checksumSha256: existingBackup.checksumSha256,
      createdAt: existingBackup.createdAt,
      message: 'Backup already exists and verified',
    };
  }

  // 3. Save to storage provider
  const storage = getCloudBackupStorage();
  const { storageKey, fileSizeBytes } = await storage.saveBackup(
    ctx.schoolId,
    meta.backupId,
    buffer,
  );

  // 4. Record metadata
  const doc = await SchoolBackup.create({
    schoolId: ctx.schoolId,
    backupId: meta.backupId,
    deviceId: meta.deviceId,
    fileName: meta.fileName,
    storageKey,
    fileSizeBytes,
    checksumSha256: computedSha256,
    isEncrypted: meta.isEncrypted ?? true,
    encryptionAlgorithm: meta.encryptionAlgorithm || 'aes-256-gcm',
    schemaVersion: meta.schemaVersion || 8,
    triggerType: meta.triggerType || 'manual',
    status: 'completed',
    uploadedBy: ctx.userId,
  });

  // 5. Apply retention policy (clean up old backups beyond retention count)
  await applyRetentionPolicy(ctx.schoolId, DEFAULT_CLOUD_RETENTION);

  // 6. Audit logging
  await audit(ctx, {
    action: 'CLOUD_BACKUP_UPLOADED',
    entityType: 'SchoolBackup',
    entityId: doc._id.toString(),
    metadata: {
      backupId: meta.backupId,
      fileSizeBytes,
      fileName: meta.fileName,
      triggerType: meta.triggerType,
    },
  });

  return {
    success: true,
    backupId: doc.backupId,
    fileName: doc.fileName,
    fileSizeBytes: doc.fileSizeBytes,
    checksumSha256: doc.checksumSha256,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

export async function listSchoolBackups(ctx: SchoolContext) {
  const backups = await SchoolBackup.find({
    schoolId: ctx.schoolId,
    status: { $ne: 'deleted' },
  })
    .sort({ createdAt: -1 })
    .lean();

  return backups.map((b) => ({
    backupId: b.backupId,
    deviceId: b.deviceId,
    fileName: b.fileName,
    fileSizeBytes: b.fileSizeBytes,
    checksumSha256: b.checksumSha256,
    isEncrypted: b.isEncrypted,
    encryptionAlgorithm: b.encryptionAlgorithm,
    schemaVersion: b.schemaVersion,
    triggerType: b.triggerType,
    status: b.status,
    createdAt: b.createdAt,
  }));
}

export async function getBackupDownload(ctx: SchoolContext, backupId: string) {
  const backup = await SchoolBackup.findOne({
    schoolId: ctx.schoolId,
    backupId,
    status: 'completed',
  });

  if (!backup) {
    throw notFound('School backup record not found or access denied');
  }

  const storage = getCloudBackupStorage();
  const buffer = await storage.readBackup(backup.storageKey);

  // Verify stored integrity
  const verifySha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (verifySha256 !== backup.checksumSha256) {
    throw new AppError(500, 'BACKUP_CORRUPTED', 'Stored cloud backup failed integrity verification');
  }

  return {
    backup,
    buffer,
  };
}

export async function deleteSchoolBackup(ctx: SchoolContext, backupId: string) {
  const backup = await SchoolBackup.findOne({
    schoolId: ctx.schoolId,
    backupId,
  });

  if (!backup) {
    throw notFound('Backup not found');
  }

  backup.status = 'deleted';
  await backup.save();

  const storage = getCloudBackupStorage();
  await storage.deleteBackup(backup.storageKey);

  await audit(ctx, {
    action: 'CLOUD_BACKUP_DELETED',
    entityType: 'SchoolBackup',
    entityId: backup._id.toString(),
    metadata: { backupId },
  });

  return { success: true, message: `Backup ${backupId} deleted successfully` };
}

async function applyRetentionPolicy(schoolId: string, retainCount: number) {
  const completedBackups = await SchoolBackup.find({
    schoolId,
    status: 'completed',
  })
    .sort({ createdAt: -1 })
    .skip(retainCount);

  const storage = getCloudBackupStorage();
  for (const oldBackup of completedBackups) {
    oldBackup.status = 'deleted';
    await oldBackup.save();
    await storage.deleteBackup(oldBackup.storageKey);
  }
}
