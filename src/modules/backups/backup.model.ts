import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId } from '../../database/schema-helpers';

export const BACKUP_STATUSES = ['running', 'completed', 'failed', 'deleted'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/**
 * Platform backup jobs. Platform-level (not a tenant collection) and excluded from backups
 * themselves: a restored server has none of these archive files.
 *
 * A job is `completed` only after the archive was written, re-read, decrypted and every entry
 * matched its checksum (`verifiedAt`). Anything else ends as `failed` with a reason.
 */
const BackupJobSchema = new Schema(
  {
    /** Random public identifier used in URLs and file names (not guessable, not the _id). */
    backupId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['full'], default: 'full' },
    trigger: { type: String, enum: ['manual', 'schedule'], required: true },
    status: { type: String, enum: BACKUP_STATUSES, required: true },
    /** Present only while running: a partial unique index allows one running backup at a time. */
    lock: { type: String },
    phase: { type: String },
    /** Updated while running; a job without a recent heartbeat died with its process. */
    heartbeatAt: { type: Date },
    requestedBy: { type: ObjectId, ref: 'PlatformAdmin' },
    requestedByName: { type: String },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    verifiedAt: { type: Date },
    durationMs: { type: Number },
    error: { type: String },
    fileName: { type: String },
    sizeBytes: { type: Number },
    sha256: { type: String },
    keyId: { type: String },
    consistency: { type: String, enum: ['snapshot', 'write-freeze'] },
    /** Non-secret manifest (counts, checksums, versions). Also stored next to the archive. */
    manifest: { type: Schema.Types.Mixed },
    deletedAt: { type: Date },
    deletedBy: { type: ObjectId, ref: 'PlatformAdmin' },
    deleteReason: { type: String, enum: ['manual', 'retention'] },
  },
  baseOptions,
);
BackupJobSchema.index({ lock: 1 }, { unique: true, partialFilterExpression: { lock: { $type: 'string' } } });
BackupJobSchema.index({ status: 1, startedAt: -1 });

export const BackupJob = model('BackupJob', BackupJobSchema);

/** Single-use, short-lived download grants (hashed). Expire automatically. */
const BackupDownloadTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    backupId: { type: String, required: true },
    adminId: { type: ObjectId, ref: 'PlatformAdmin', required: true },
    tokenVersion: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  baseOptions,
);
BackupDownloadTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BackupDownloadToken = model('BackupDownloadToken', BackupDownloadTokenSchema);

/** Collections never written into a backup. */
export const EXCLUDED_COLLECTIONS = new Set([
  BackupJob.collection.collectionName,
  BackupDownloadToken.collection.collectionName,
  // Sessions: after a disaster everyone signs in again; restoring live refresh tokens from a
  // possibly compromised server would keep those sessions alive.
  'refreshtokens',
]);
