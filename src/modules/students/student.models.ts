import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { atomicGuardPlugin } from '../../database/atomic-guard-plugin';

export const STUDENT_STATUSES = ['active', 'suspended', 'left', 'graduated', 'transferred', 'archived'] as const;
/** Statuses that can be set directly. `archived` is only set/cleared by the archive endpoints. */
export const SETTABLE_STUDENT_STATUSES = ['active', 'suspended', 'left', 'graduated', 'transferred'] as const;

export const ENROLLMENT_STATUSES = [
  'active',
  'promoted',
  'repeating',
  'graduated',
  'left',
  'transferred',
  'suspended',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

const ParentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      relation: { type: String, enum: ['father', 'mother', 'guardian', 'other'], default: 'father' },
      cnic: { type: String, trim: true },
      phone: { type: String, required: true, trim: true },
      whatsapp: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      occupation: { type: String, trim: true },
      address: { type: String },
      preferredChannel: { type: String, enum: ['in_app', 'sms', 'whatsapp', 'email'], default: 'in_app' },
      userId: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
ParentSchema.index({ schoolId: 1, phone: 1 });
ParentSchema.index({ schoolId: 1, cnic: 1 }, { unique: true, partialFilterExpression: { cnic: { $type: 'string' } } });
export const Parent = model('Parent', ParentSchema);

const StudentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      admissionNo: { type: String, required: true, trim: true },
      rollNo: { type: String, trim: true },
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, trim: true },
      gender: { type: String, enum: ['male', 'female', 'other'], required: true },
      dateOfBirth: { type: Date },
      bFormNo: { type: String, trim: true },
      bloodGroup: { type: String },
      medicalNotes: { type: String },
      address: { type: String },
      phone: { type: String, trim: true },
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      guardians: {
        type: [
          {
            _id: false,
            parentId: { type: ObjectId, ref: 'Parent', required: true },
            relation: { type: String, default: 'father' },
            isPrimary: { type: Boolean, default: false },
          },
        ],
        default: [],
      },
      admissionDate: { type: Date, default: () => new Date() },
      previousSchool: { type: String },
      /** Standing monthly fee concession (approved). Applied when invoices are generated. */
      feeConcession: {
        type: { type: String, enum: ['none', 'percent', 'fixed'], default: 'none' },
        value: { type: Number, default: 0, min: 0 },
        reason: { type: String },
        approvalId: { type: ObjectId, ref: 'ApprovalRequest' },
      },
      /**
       * This student's own amount for a monthly fee head, instead of the class fee structure's
       * (schools where every child pays a different fee). Billed even when the class has no
       * structure. A standing concession still applies on top.
       */
      customFees: {
        type: [
          {
            _id: false,
            feeHeadId: { type: ObjectId, ref: 'FeeHead', required: true },
            amount: { type: Number, required: true, min: 0 },
            source: { type: String, enum: ['import', 'manual'], default: 'manual' },
            setAt: { type: Date },
            setBy: { type: ObjectId, ref: 'User' },
          },
        ],
        default: [],
      },
      status: { type: String, enum: STUDENT_STATUSES, default: 'active' },
      statusChangedAt: { type: Date },
      leavingReason: { type: String },
      /** Set while the record is archived: kept for history, hidden from active lists, logins suspended. */
      archive: {
        previousStatus: { type: String },
        archivedAt: { type: Date },
        archivedBy: { type: ObjectId, ref: 'User' },
        reason: { type: String },
      },
      userId: { type: ObjectId, ref: 'User' },
      inquiryId: { type: ObjectId, ref: 'Inquiry' },
      version: { type: Number, default: 1, required: true },
    },
    baseOptions,
  ),
);
StudentSchema.plugin(atomicGuardPlugin);
StudentSchema.index({ schoolId: 1, admissionNo: 1 }, { unique: true });
StudentSchema.index({ schoolId: 1, sectionId: 1, status: 1 });
StudentSchema.index({ schoolId: 1, classId: 1, status: 1 });
StudentSchema.index({ schoolId: 1, 'guardians.parentId': 1 });
StudentSchema.index({ schoolId: 1, firstName: 1, lastName: 1 });
export const Student = model('Student', StudentSchema);

/**
 * Historical session enrollment for a student.
 * Links the permanent student identity to a specific academic session, class, and section.
 * A student has one enrollment per academic session, preserving their academic journey over time.
 */
const StudentEnrollmentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      studentId: { type: ObjectId, ref: 'Student', required: true },
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      rollNo: { type: String, trim: true },
      enrollmentDate: { type: Date, default: () => new Date() },
      status: { type: String, enum: ENROLLMENT_STATUSES, default: 'active' },
      statusChangedAt: { type: Date },
      statusReason: { type: String, trim: true },
      promotionDetails: {
        fromEnrollmentId: { type: ObjectId, ref: 'StudentEnrollment' },
        fromSectionId: { type: ObjectId, ref: 'Section' },
        fromClassId: { type: ObjectId, ref: 'SchoolClass' },
        fromSessionId: { type: ObjectId, ref: 'AcademicSession' },
        promotedAt: { type: Date },
        promotedBy: { type: ObjectId, ref: 'User' },
        remarks: { type: String, trim: true },
      },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);

// One enrollment per student per academic session
StudentEnrollmentSchema.index({ schoolId: 1, studentId: 1, sessionId: 1 }, { unique: true });
StudentEnrollmentSchema.index({ schoolId: 1, sessionId: 1, sectionId: 1, status: 1 });
StudentEnrollmentSchema.index({ schoolId: 1, sessionId: 1, classId: 1, status: 1 });
StudentEnrollmentSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });

export const StudentEnrollment = model('StudentEnrollment', StudentEnrollmentSchema);

export * from './promotion-batch.model';

/** Fields that only staff with students:manage should see. */
export const STUDENT_SENSITIVE_FIELDS = ['bFormNo', 'medicalNotes'] as const;
