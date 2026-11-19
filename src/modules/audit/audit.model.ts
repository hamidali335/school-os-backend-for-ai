import { model, Schema } from 'mongoose';
import { ObjectId, createdOnlyOptions } from '../../database/schema-helpers';

/**
 * Audit trail. `schoolId` is null for platform-level events. Not tenant-guarded by the
 * plugin because platform events have no tenant; every school-facing query in
 * audit.service filters by schoolId explicitly.
 */
const AuditLogSchema = new Schema(
  {
    schoolId: { type: ObjectId, ref: 'School', index: true },
    actorType: { type: String, enum: ['user', 'platform_admin', 'system', 'ai'], required: true },
    actorId: { type: ObjectId },
    actorName: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true, index: true },
    entityType: { type: String },
    entityId: { type: String },
    summary: { type: String },
    metadata: { type: Object },
    outcome: { type: String, enum: ['success', 'failure'], default: 'success' },
    ip: { type: String },
    requestId: { type: String },
  },
  createdOnlyOptions,
);
AuditLogSchema.index({ schoolId: 1, createdAt: -1 });
AuditLogSchema.index({ actorType: 1, actorId: 1, createdAt: -1 });

export const AuditLog = model('AuditLog', AuditLogSchema);
