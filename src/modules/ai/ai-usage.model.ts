import { model, Schema } from 'mongoose';
import { createdOnlyOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const AI_FEATURES = [
  'copilot',
  'insights',
  'daily_brief',
  'explain',
  'summarize',
  'admissions_recommendation',
  'draft_communication',
  'report_narrative',
  'automation',
  // AI voice conversations (src/modules/ai-calls).
  'voice_conversation',
] as const;

/** One row per AI provider call (or blocked attempt). Tracked separately from messaging costs. */
const AiUsageSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      userId: { type: ObjectId, ref: 'User' },
      feature: { type: String, enum: AI_FEATURES, required: true },
      provider: { type: String, required: true },
      model: { type: String },
      promptTokens: { type: Number, default: 0 },
      completionTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      costUsd: { type: Number, default: 0 },
      usageReported: { type: Boolean, default: true },
      status: { type: String, enum: ['success', 'error', 'limit_reached', 'unavailable'], required: true },
      errorCode: { type: String },
      latencyMs: { type: Number },
      toolCalls: { type: Number, default: 0 },
    },
    createdOnlyOptions,
  ),
);
AiUsageSchema.index({ schoolId: 1, createdAt: -1 });
AiUsageSchema.index({ createdAt: -1, status: 1 });
export const AiUsage = model('AiUsage', AiUsageSchema);
