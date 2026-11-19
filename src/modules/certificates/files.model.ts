import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const FILE_CATEGORIES = [
  'student_document',
  'certificate',
  'homework',
  'submission',
  'employee_document',
  'school',
] as const;

/**
 * Metadata for privately stored files. Bytes live outside any public web root under
 * STORAGE_DIR/<schoolId>/...; they are only served through authorised download endpoints.
 */
const FileObjectSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      category: { type: String, enum: FILE_CATEGORIES, required: true },
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
      storageKey: { type: String, required: true },
      sha256: { type: String },
      studentId: { type: ObjectId, ref: 'Student' },
      employeeId: { type: ObjectId, ref: 'Employee' },
      homeworkId: { type: ObjectId, ref: 'Homework' },
      documentType: { type: String },
      description: { type: String },
      uploadedBy: { type: ObjectId, ref: 'User' },
      /** Whether parents/students linked to `studentId` may download it. */
      visibleToFamily: { type: Boolean, default: false },
    },
    baseOptions,
  ),
);
FileObjectSchema.index({ schoolId: 1, studentId: 1, category: 1 });
export const FileObject = model('FileObject', FileObjectSchema);

export const CERTIFICATE_TYPES = [
  'leaving',
  'transfer',
  'character',
  'bonafide',
  'study',
  'fee_clearance',
  'achievement',
  'sports',
  'merit',
  'custom',
] as const;

const CertificateSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      studentId: { type: ObjectId, ref: 'Student', required: true },
      type: { type: String, enum: CERTIFICATE_TYPES, required: true },
      serialNo: { type: String, required: true },
      title: { type: String, required: true },
      body: { type: String, required: true },
      issueDate: { type: Date, required: true },
      issuedBy: { type: ObjectId, ref: 'User' },
      issuedByName: { type: String },
      fileId: { type: ObjectId, ref: 'FileObject' },
      status: { type: String, enum: ['issued', 'revoked'], default: 'issued' },
      revokedReason: { type: String },
      /** The template it was issued from, and the particulars table printed under the text. */
      templateKey: { type: String },
      details: { type: [{ _id: false, label: String, value: String }], default: [] },
    },
    baseOptions,
  ),
);
CertificateSchema.index({ schoolId: 1, serialNo: 1 }, { unique: true });
CertificateSchema.index({ schoolId: 1, studentId: 1 });
export const Certificate = model('Certificate', CertificateSchema);
