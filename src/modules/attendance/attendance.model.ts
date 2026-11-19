import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { atomicGuardPlugin } from '../../database/atomic-guard-plugin';
import { versionPlugin } from '../../database/version-plugin';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave', 'excused'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

const AttendanceRecordSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      date: { type: Date, required: true },
      status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
      remarks: { type: String, trim: true },
      markedBy: { type: ObjectId, ref: 'User' },
      parentNotifiedAt: { type: Date },
      version: { type: Number, default: 1, required: true },
    },
    baseOptions,
  ),
);
AttendanceRecordSchema.plugin(versionPlugin);
AttendanceRecordSchema.plugin(atomicGuardPlugin);
AttendanceRecordSchema.index({ schoolId: 1, studentId: 1, date: 1 }, { unique: true });
AttendanceRecordSchema.index({ schoolId: 1, sectionId: 1, date: 1 });
AttendanceRecordSchema.index({ schoolId: 1, date: 1, status: 1 });
export const AttendanceRecord = model('AttendanceRecord', AttendanceRecordSchema);

/**
 * A section's register for one day. It is finalized only when every active student in the
 * section had an explicit status at that moment; until then the saved records are a draft.
 * Completeness is still re-checked live (a student admitted later makes it incomplete again).
 *
 * Saving a draft always writes this document (draftSavedAt), so a draft is never mistaken for a
 * day marked before registers existed: such a day has records but no register, and counts as
 * complete when every student has a status (as it did then).
 */
const AttendanceRegisterSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      date: { type: Date, required: true },
      finalizedAt: { type: Date },
      finalizedBy: { type: ObjectId, ref: 'User' },
      draftSavedAt: { type: Date },
      draftSavedBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
AttendanceRegisterSchema.index({ schoolId: 1, sectionId: 1, date: 1 }, { unique: true });
export const AttendanceRegister = model('AttendanceRegister', AttendanceRegisterSchema);

/** not_started: nobody marked · draft: some students unmarked · complete: everyone marked and finalized. */
export const REGISTER_STATES = ['not_started', 'draft', 'complete'] as const;
export type RegisterState = (typeof REGISTER_STATES)[number];
