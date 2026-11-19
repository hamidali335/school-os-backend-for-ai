import { model, Schema, type InferSchemaType } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const BACKUP_STATUSES = ['completed', 'failed', 'deleted'] as const;

const SchoolBackupSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      backupId: { type: String, required: true, unique: true, trim: true },
      deviceId: { type: String, required: true, trim: true },
      fileName: { type: String, required: true, trim: true },
      storageKey: { type: String, required: true, trim: true },
      fileSizeBytes: { type: Number, required: true, min: 1 },
      checksumSha256: { type: String, required: true, trim: true },
      isEncrypted: { type: Boolean, default: true },
      encryptionAlgorithm: { type: String, default: 'aes-256-gcm' },
      schemaVersion: { type: Number, default: 8 },
      triggerType: {
        type: String,
        enum: ['manual', 'scheduled', 'pre_migration', 'maintenance'],
        default: 'manual',
      },
      status: { type: String, enum: BACKUP_STATUSES, default: 'completed', index: true },
      uploadedBy: { type: ObjectId, ref: 'User' },
      metadata: { type: Schema.Types.Mixed },
    },
    baseOptions,
  ),
);

SchoolBackupSchema.index({ schoolId: 1, createdAt: -1 });
SchoolBackupSchema.index({ schoolId: 1, checksumSha256: 1 });
export type SchoolBackupDoc = InferSchemaType<typeof SchoolBackupSchema>;
export const SchoolBackup = model('SchoolBackup', SchoolBackupSchema);
