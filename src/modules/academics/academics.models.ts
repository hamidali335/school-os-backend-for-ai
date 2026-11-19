import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

const AcademicSessionSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      isCurrent: { type: Boolean, default: false },
      status: { type: String, enum: ['planned', 'active', 'closed'], default: 'active' },
      generationSource: { type: String, enum: ['manual', 'automatic'], default: 'manual' },
      generatedFromSessionId: { type: ObjectId, ref: 'AcademicSession' },
      generatedAt: { type: Date },
      feeRolloverStatus: { type: String, enum: ['none', 'copied', 'customized'], default: 'none' },
      academicRolloverStatus: { type: String, enum: ['none', 'completed', 'rolled_back'], default: 'none' },
      academicRolloverAt: { type: Date },
      academicRolloverFromSessionId: { type: ObjectId, ref: 'AcademicSession' },
    },
    baseOptions,
  ),
);
AcademicSessionSchema.index({ schoolId: 1, name: 1 }, { unique: true });
export const AcademicSession = model('AcademicSession', AcademicSessionSchema);

/** A grade level, e.g. "Class 5". Sections are created per class. */
const SchoolClassSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      name: { type: String, required: true, trim: true },
      level: { type: Number, required: true },
      status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    },
    baseOptions,
  ),
);
SchoolClassSchema.index({ schoolId: 1, campusId: 1, name: 1 }, { unique: true });
export const SchoolClass = model('SchoolClass', SchoolClassSchema, 'classes');

const SectionSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      name: { type: String, required: true, trim: true },
      capacity: { type: Number, default: 40 },
      room: { type: String, trim: true },
      classTeacherId: { type: ObjectId, ref: 'Employee' },
    },
    baseOptions,
  ),
);
SectionSchema.index({ schoolId: 1, sessionId: 1, classId: 1, name: 1 }, { unique: true });
export const Section = model('Section', SectionSchema);

const SubjectSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      classIds: { type: [ObjectId], ref: 'SchoolClass', default: [] },
      isElective: { type: Boolean, default: false },
    },
    baseOptions,
  ),
);
SubjectSchema.index({ schoolId: 1, code: 1 }, { unique: true });
export const Subject = model('Subject', SubjectSchema);

/** Which teacher teaches which subject to which section. Drives teacher permissions. */
const TeachingAssignmentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      subjectId: { type: ObjectId, ref: 'Subject', required: true },
      teacherId: { type: ObjectId, ref: 'Employee', required: true },
    },
    baseOptions,
  ),
);
TeachingAssignmentSchema.index({ schoolId: 1, sectionId: 1, subjectId: 1 }, { unique: true });
TeachingAssignmentSchema.index({ schoolId: 1, teacherId: 1 });
export const TeachingAssignment = model('TeachingAssignment', TeachingAssignmentSchema);

/** What a substitute may do while covering. Viewing the covered students is always included. */
export const SUBSTITUTE_CAPABILITIES = ['attendance', 'homework', 'marks'] as const;
export type SubstituteCapability = (typeof SUBSTITUTE_CAPABILITIES)[number];

/**
 * Temporary cover: the substitute acts for the original teacher in one section (optionally one
 * subject) between two dates, inclusive. The original teaching assignment is never modified;
 * access is granted only while the dates are current and the cover is not cancelled.
 */
const SubstituteAssignmentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      originalTeacherId: { type: ObjectId, ref: 'Employee', required: true },
      substituteTeacherId: { type: ObjectId, ref: 'Employee', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      /** Null: every subject the original teacher teaches in the section (and class-teacher duties). */
      subjectId: { type: ObjectId, ref: 'Subject' },
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      /** Free-text periods, e.g. "Periods 2–4". */
      periods: { type: String, trim: true },
      reason: { type: String, trim: true },
      capabilities: { type: [{ type: String, enum: SUBSTITUTE_CAPABILITIES }], default: ['attendance', 'homework'] },
      status: { type: String, enum: ['active', 'cancelled'], default: 'active' },
      createdBy: { type: ObjectId, ref: 'User', required: true },
      updatedBy: { type: ObjectId, ref: 'User' },
      cancelledBy: { type: ObjectId, ref: 'User' },
      cancelledAt: { type: Date },
      cancelReason: { type: String, trim: true },
    },
    baseOptions,
  ),
);
SubstituteAssignmentSchema.index({ schoolId: 1, substituteTeacherId: 1, status: 1, endDate: 1 });
SubstituteAssignmentSchema.index({ schoolId: 1, sectionId: 1, status: 1, startDate: 1 });
SubstituteAssignmentSchema.index({ schoolId: 1, originalTeacherId: 1, startDate: -1 });
export const SubstituteAssignment = model('SubstituteAssignment', SubstituteAssignmentSchema);
