import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const INQUIRY_STAGES = [
  'new',
  'contacted',
  'visit_scheduled',
  'test_scheduled',
  'offered',
  'admitted',
  'lost',
] as const;
export const INQUIRY_SOURCES = [
  'walk_in',
  'phone',
  'website',
  'facebook',
  'whatsapp',
  'referral',
  'event',
  'other',
] as const;

const InquirySchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      inquiryNo: { type: String, required: true },
      studentName: { type: String, required: true, trim: true },
      gender: { type: String, enum: ['male', 'female', 'other'] },
      dateOfBirth: { type: Date },
      classSoughtId: { type: ObjectId, ref: 'SchoolClass' },
      classSoughtName: { type: String },
      parentName: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      email: { type: String, trim: true, lowercase: true },
      address: { type: String },
      previousSchool: { type: String },
      source: { type: String, enum: INQUIRY_SOURCES, default: 'walk_in' },
      stage: { type: String, enum: INQUIRY_STAGES, default: 'new', index: true },
      priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
      assignedTo: { type: ObjectId, ref: 'User' },
      nextFollowUpAt: { type: Date },
      lastContactedAt: { type: Date },
      followUps: {
        type: [
          {
            at: { type: Date, default: () => new Date() },
            by: { type: ObjectId, ref: 'User' },
            byName: String,
            channel: { type: String, enum: ['call', 'visit', 'sms', 'whatsapp', 'email', 'other'], default: 'call' },
            note: String,
            outcome: String,
          },
        ],
        default: [],
      },
      lostReason: { type: String },
      convertedStudentId: { type: ObjectId, ref: 'Student' },
      notes: { type: String },
    },
    baseOptions,
  ),
);
InquirySchema.index({ schoolId: 1, inquiryNo: 1 }, { unique: true });
InquirySchema.index({ schoolId: 1, stage: 1, nextFollowUpAt: 1 });
InquirySchema.index({ schoolId: 1, phone: 1 });
export const Inquiry = model('Inquiry', InquirySchema);
