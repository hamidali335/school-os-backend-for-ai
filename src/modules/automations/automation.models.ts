import { model, Schema } from 'mongoose';
import { baseOptions, createdOnlyOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const AUTOMATION_TYPES = [
  'fee_reminder',
  'admission_followup',
  'attendance_alert',
  'late_fee',
  'daily_brief',
] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];

const AutomationRuleSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      type: { type: String, enum: AUTOMATION_TYPES, required: true },
      name: { type: String, required: true, trim: true },
      enabled: { type: Boolean, default: true },
      schedule: {
        frequency: { type: String, enum: ['daily', 'weekly'], default: 'daily' },
        /** Hour of day in the school's timezone (0-23). */
        hour: { type: Number, min: 0, max: 23, default: 9 },
        /** ISO weekday 1-7 for weekly rules. */
        weekday: { type: Number, min: 1, max: 7 },
      },
      config: {
        channels: { type: [String], enum: ['sms', 'whatsapp', 'email'], default: [] },
        minDaysOverdue: { type: Number, default: 3 },
      },
      nextRunAt: { type: Date },
      lastRunAt: { type: Date },
      lastRunStatus: { type: String },
      lockedUntil: { type: Date },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
AutomationRuleSchema.index({ enabled: 1, nextRunAt: 1 });
export const AutomationRule = model('AutomationRule', AutomationRuleSchema);

const AutomationRunSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      ruleId: { type: ObjectId, ref: 'AutomationRule', required: true },
      type: { type: String, enum: AUTOMATION_TYPES, required: true },
      trigger: { type: String, enum: ['schedule', 'manual'], required: true },
      triggeredBy: { type: ObjectId, ref: 'User' },
      status: { type: String, enum: ['success', 'failed', 'skipped'], required: true },
      summary: { type: String },
      result: { type: Object },
      error: { type: String },
      startedAt: { type: Date, required: true },
      finishedAt: { type: Date },
    },
    createdOnlyOptions,
  ),
);
AutomationRunSchema.index({ schoolId: 1, ruleId: 1, createdAt: -1 });
// Keep one year of run history.
AutomationRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });
export const AutomationRun = model('AutomationRun', AutomationRunSchema);
