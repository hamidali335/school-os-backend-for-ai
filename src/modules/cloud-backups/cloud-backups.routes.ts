import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import {
  deleteSchoolBackup,
  getBackupDownload,
  listSchoolBackups,
  uploadSchoolBackup,
} from './cloud-backups.service';

const UploadBackupBodySchema = z.object({
  backupId: z.string().min(3),
  deviceId: z.string().min(3),
  fileName: z.string().min(3),
  checksumSha256: z.string().min(32),
  schemaVersion: z.number().default(8),
  triggerType: z
    .enum(['manual', 'scheduled', 'pre_migration', 'maintenance'])
    .default('manual'),
  isEncrypted: z.boolean().default(true),
  encryptionAlgorithm: z.string().default('aes-256-gcm'),
  dataBase64: z.string().min(1),
});

const BackupItemSchema = z.object({
  backupId: z.string(),
  deviceId: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  checksumSha256: z.string(),
  isEncrypted: z.boolean(),
  encryptionAlgorithm: z.string(),
  schemaVersion: z.number(),
  triggerType: z.string(),
  status: z.string(),
  createdAt: z.date(),
});

export function registerSchoolCloudBackupRoutes(api: Api) {
  const tags = ['School Cloud Backups'];

  // Upload an encrypted school desktop backup
  api.route({
    method: 'post',
    path: '/backups/school/upload',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Upload an encrypted school desktop backup to isolated cloud storage',
    body: UploadBackupBodySchema,
    response: z.object({
      success: z.boolean(),
      backupId: z.string(),
      fileName: z.string().optional(),
      fileSizeBytes: z.number().optional(),
      checksumSha256: z.string().optional(),
      status: z.string(),
      createdAt: z.date().optional(),
      message: z.string().optional(),
    }),
    handler: async ({ ctx, body }) => {
      const buffer = Buffer.from(body.dataBase64, 'base64');
      return uploadSchoolBackup(
        ctx,
        {
          backupId: body.backupId,
          deviceId: body.deviceId,
          fileName: body.fileName,
          checksumSha256: body.checksumSha256,
          schemaVersion: body.schemaVersion,
          triggerType: body.triggerType,
          isEncrypted: body.isEncrypted,
          encryptionAlgorithm: body.encryptionAlgorithm,
        },
        buffer,
      );
    },
  });

  // List backups for the authenticated school
  api.route({
    method: 'get',
    path: '/backups/school',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'List available encrypted cloud backups for the authenticated school tenant',
    response: z.array(BackupItemSchema),
    handler: ({ ctx }) => listSchoolBackups(ctx),
  });

  // Download encrypted backup for restoration
  api.route({
    method: 'get',
    path: '/backups/school/:backupId/download',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Download encrypted backup binary data for desktop database restoration',
    params: z.object({ backupId: z.string() }),
    response: z.object({
      success: z.boolean(),
      backupId: z.string(),
      fileName: z.string(),
      fileSizeBytes: z.number(),
      checksumSha256: z.string(),
      dataBase64: z.string(),
    }),
    handler: async ({ ctx, params }) => {
      const { backup, buffer } = await getBackupDownload(ctx, params.backupId);
      return {
        success: true,
        backupId: backup.backupId,
        fileName: backup.fileName,
        fileSizeBytes: backup.fileSizeBytes,
        checksumSha256: backup.checksumSha256,
        dataBase64: buffer.toString('base64'),
      };
    },
  });

  // Delete backup
  api.route({
    method: 'delete',
    path: '/backups/school/:backupId',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Delete a cloud backup according to retention policies',
    params: z.object({ backupId: z.string() }),
    response: z.object({ success: z.boolean(), message: z.string() }),
    handler: ({ ctx, params }) => deleteSchoolBackup(ctx, params.backupId),
  });
}
