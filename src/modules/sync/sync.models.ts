import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * Tenant-scoped sequence counters for strictly monotonic change feeds and retention.
 */
const SchoolSequenceSchema = withTenant(
  new Schema(
    {
      schoolId: { type: ObjectId, ref: 'School', required: true, unique: true, immutable: true },
      seq: { type: Number, default: 0, required: true },
      highestPrunedSeq: { type: Number, default: 0 },
    },
    baseOptions,
  ),
);
export const SchoolSequence = model('SchoolSequence', SchoolSequenceSchema, 'school_sequences');

/**
 * Physical or logical workstation/device bound to an authorized school tenant.
 */
const SyncDeviceSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      deviceId: { type: String, required: true, trim: true },
      deviceName: { type: String, required: true, trim: true },
      platform: { type: String, enum: ['windows_desktop', 'mobile', 'web', 'other'], default: 'windows_desktop' },
      status: { type: String, enum: ['registered', 'revoked', 'expired'], default: 'registered' },
      registeredBy: { type: ObjectId, ref: 'User' },
      lastSeenAt: { type: Date, default: () => new Date() },
      lastHandshakeAt: { type: Date, default: () => new Date() },
      metadata: { type: Schema.Types.Mixed },
    },
    baseOptions,
  ),
);
SyncDeviceSchema.index({ schoolId: 1, deviceId: 1 }, { unique: true });
export const SyncDevice = model('SyncDevice', SyncDeviceSchema);

/**
 * Idempotency ledger to guarantee at-most-once processing of client mutations.
 */
const SyncIdempotencySchema = withTenant(
  new Schema(
    {
      ...tenantField,
      idempotencyKey: { type: String, required: true, trim: true },
      eventId: { type: String, required: true, trim: true },
      entityType: { type: String, required: true },
      entityId: { type: String, required: true },
      serverVersion: { type: Number, default: 1 },
      status: { type: String, enum: ['synced', 'conflict', 'rejected'], default: 'synced' },
      payloadFingerprint: { type: String, trim: true },
      responsePayload: { type: Schema.Types.Mixed },
      permanent: { type: Boolean, default: false },
      errorCode: { type: String },
      errorMessage: { type: String },
    },
    baseOptions,
  ),
);
SyncIdempotencySchema.index({ schoolId: 1, idempotencyKey: 1 }, { unique: true });
SyncIdempotencySchema.index({ schoolId: 1, eventId: 1 });
export const SyncIdempotency = model('SyncIdempotency', SyncIdempotencySchema);

/**
 * Server change feed for sequence-based incremental downloads.
 */
const SyncChangeLogSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      seq: { type: Number, required: true, default: () => Date.now() },
      version: { type: Number, default: 1 },
      deleted: { type: Boolean, default: false },
      actorId: { type: ObjectId, ref: 'User' },
      visibleToRoles: { type: [String], default: [] },
      changeId: { type: String, required: true, trim: true },
      entityType: { type: String, required: true, trim: true },
      entityId: { type: String, required: true, trim: true },
      operation: { type: String, enum: ['INSERT', 'UPDATE', 'DELETE'], required: true },
      payload: { type: Schema.Types.Mixed, required: true },
      remoteVersion: { type: Number, default: 1 },
      originDeviceId: { type: String, trim: true },
      timestamp: { type: Date, default: () => new Date() },
    },
    baseOptions,
  ),
);
SyncChangeLogSchema.index({ schoolId: 1, seq: 1 }, { unique: true });
SyncChangeLogSchema.index({ schoolId: 1, changeId: 1 });
SyncChangeLogSchema.index({ schoolId: 1, entityType: 1, seq: 1 });
SyncChangeLogSchema.index({ schoolId: 1, timestamp: 1 });
export const SyncChangeLog = model('SyncChangeLog', SyncChangeLogSchema);

/**
 * Consistent snapshot session tracking for bootstrap downloads.
 */
const SyncSnapshotSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      snapshotId: { type: String, required: true, trim: true },
      seq: { type: Number, required: true, default: () => Date.now() },
      createdAt: { type: Date, default: () => new Date() },
      expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
    },
    baseOptions,
  ),
);
SyncSnapshotSchema.index({ schoolId: 1, snapshotId: 1 }, { unique: true });
export const SyncSnapshot = model('SyncSnapshot', SyncSnapshotSchema);

/**
 * Persisted synchronization conflicts requiring authorized administrative decision.
 */
const SyncConflictSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      conflictId: { type: String, required: true, trim: true },
      entityType: { type: String, required: true },
      entityId: { type: String, required: true },
      localPayload: { type: Schema.Types.Mixed, required: true },
      remotePayload: { type: Schema.Types.Mixed, required: true },
      conflictingFields: { type: [String], default: [] },
      reason: { type: String, required: true },
      status: { type: String, enum: ['unresolved', 'resolved'], default: 'unresolved' },
      resolutionStrategy: { type: String, enum: ['local_wins', 'remote_wins', 'merged'] },
      resolvedBy: { type: ObjectId, ref: 'User' },
      resolvedAt: { type: Date },
      resolutionNotes: { type: String },
    },
    baseOptions,
  ),
);
SyncConflictSchema.index({ schoolId: 1, conflictId: 1 }, { unique: true });
SyncConflictSchema.index({ schoolId: 1, entityType: 1, entityId: 1 });
SyncConflictSchema.index({ schoolId: 1, status: 1 });
export const SyncConflict = model('SyncConflict', SyncConflictSchema);

/**
 * Bi-directional entity identifier mapping (Desktop local ID <-> Cloud MongoDB ID).
 */
const SyncEntityMappingSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      entityType: { type: String, required: true },
      localId: { type: String, required: true, trim: true },
      cloudId: { type: String, required: true, trim: true },
    },
    baseOptions,
  ),
);
SyncEntityMappingSchema.index({ schoolId: 1, entityType: 1, localId: 1 }, { unique: true });
SyncEntityMappingSchema.index({ schoolId: 1, entityType: 1, cloudId: 1 });
export const SyncEntityMapping = model('SyncEntityMapping', SyncEntityMappingSchema);
