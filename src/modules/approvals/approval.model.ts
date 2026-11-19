import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const APPROVAL_TYPES = [
  'expense',
  'fee_concession',
  'invoice_waiver',
  'invoice_cancel',
  'payment_reversal',
  'announcement_publish',
  'fee_reminder_batch',
  'message_batch',
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled'] as const;

/**
 * Every sensitive action is captured as:
 * DATA (facts snapshot) → ANALYSIS → RECOMMENDATION → APPROVAL (human decision)
 * → ACTION (executed by application code) → RESULT → AUDIT LOG.
 */
const ApprovalRequestSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      type: { type: String, enum: APPROVAL_TYPES, required: true },
      title: { type: String, required: true },
      status: { type: String, enum: APPROVAL_STATUSES, default: 'pending' },
      source: { type: String, enum: ['user', 'ai', 'automation'], default: 'user' },
      requestedBy: { type: ObjectId, ref: 'User' },
      requestedByName: { type: String },
      data: { type: Object, default: {} },
      analysis: { type: String },
      recommendation: { type: String },
      payload: { type: Object, required: true },
      entityType: { type: String },
      entityId: { type: String },
      amount: { type: Number },
      decidedBy: { type: ObjectId, ref: 'User' },
      decidedByName: { type: String },
      decidedAt: { type: Date },
      decisionNote: { type: String },
      executedAt: { type: Date },
      result: { type: Object },
      error: { type: String },
    },
    baseOptions,
  ),
);
ApprovalRequestSchema.index({ schoolId: 1, status: 1, createdAt: -1 });
ApprovalRequestSchema.index({ schoolId: 1, entityType: 1, entityId: 1 });
export const ApprovalRequest = model('ApprovalRequest', ApprovalRequestSchema);
