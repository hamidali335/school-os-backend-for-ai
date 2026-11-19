import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

const AcademicRolloverBatchSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      batchNumber: { type: String, required: true },
      fromSessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      toSessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      executedBy: { type: ObjectId, ref: 'User' },
      executedAt: { type: Date, default: Date.now },
      status: { type: String, enum: ['completed', 'rolled_back'], default: 'completed' },
      createdSectionIds: { type: [ObjectId], ref: 'Section', default: [] },
      reusedSectionIds: { type: [ObjectId], ref: 'Section', default: [] },
      createdTeachingAssignmentIds: { type: [ObjectId], ref: 'TeachingAssignment', default: [] },
      createdTimetableEntryIds: { type: [ObjectId], ref: 'TimetableEntry', default: [] },
      summary: {
        sectionsCreatedCount: { type: Number, default: 0 },
        sectionsReusedCount: { type: Number, default: 0 },
        teachingAssignmentsCount: { type: Number, default: 0 },
        timetableEntriesCount: { type: Number, default: 0 },
      },
      rolledBackAt: { type: Date },
      rolledBackBy: { type: ObjectId, ref: 'User' },
      rollbackReason: { type: String, trim: true },
    },
    baseOptions,
  ),
);

AcademicRolloverBatchSchema.index({ schoolId: 1, toSessionId: 1, status: 1 });
AcademicRolloverBatchSchema.index({ schoolId: 1, batchNumber: 1 }, { unique: true });

export const AcademicRolloverBatch = model('AcademicRolloverBatch', AcademicRolloverBatchSchema);
