import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const PROMOTION_ACTIONS = ['promote', 'repeat', 'graduate', 'manual', 'left', 'transferred'] as const;
export type PromotionAction = (typeof PROMOTION_ACTIONS)[number];

export const PROMOTION_BATCH_STATUSES = ['committed', 'rolled_back'] as const;
export type PromotionBatchStatus = (typeof PROMOTION_BATCH_STATUSES)[number];

const PromotionBatchItemSchema = new Schema(
  {
    studentId: { type: ObjectId, ref: 'Student', required: true },
    action: { type: String, enum: PROMOTION_ACTIONS, required: true },
    fromClassId: { type: ObjectId, ref: 'SchoolClass', required: true },
    fromSectionId: { type: ObjectId, ref: 'Section', required: true },
    fromRollNo: { type: String, trim: true },
    fromEnrollmentId: { type: ObjectId, ref: 'StudentEnrollment' },
    toClassId: { type: ObjectId, ref: 'SchoolClass' },
    toSectionId: { type: ObjectId, ref: 'Section' },
    toRollNo: { type: String, trim: true },
    toEnrollmentId: { type: ObjectId, ref: 'StudentEnrollment' },
    previousStudentStatus: { type: String, required: true },
    newStudentStatus: { type: String, required: true },
    remarks: { type: String, trim: true },
  },
  { _id: false },
);

const PromotionBatchSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      fromSessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      toSessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      status: { type: String, enum: PROMOTION_BATCH_STATUSES, default: 'committed' },
      totalPromoted: { type: Number, default: 0 },
      totalRepeating: { type: Number, default: 0 },
      totalGraduated: { type: Number, default: 0 },
      totalManual: { type: Number, default: 0 },
      promotedBy: { type: ObjectId, ref: 'User' },
      promotedAt: { type: Date, default: () => new Date() },
      rolledBackBy: { type: ObjectId, ref: 'User' },
      rolledBackAt: { type: Date },
      rollbackReason: { type: String, trim: true },
      items: { type: [PromotionBatchItemSchema], default: [] },
    },
    baseOptions,
  ),
);

PromotionBatchSchema.index({ schoolId: 1, toSessionId: 1, createdAt: -1 });
PromotionBatchSchema.index({ schoolId: 1, fromSessionId: 1 });
PromotionBatchSchema.index({ schoolId: 1, campusId: 1, createdAt: -1 });

export const PromotionBatch = model('PromotionBatch', PromotionBatchSchema);
