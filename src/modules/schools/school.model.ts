import { model, Schema, type InferSchemaType } from 'mongoose';
import { ObjectId, baseOptions } from '../../database/schema-helpers';

export const SCHOOL_STATUSES = ['active', 'suspended', 'pending'] as const;
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;

export const DEFAULT_GRADING_SCALE = [
  { grade: 'A+', minPercent: 90, remark: 'Outstanding' },
  { grade: 'A', minPercent: 80, remark: 'Excellent' },
  { grade: 'B', minPercent: 70, remark: 'Very Good' },
  { grade: 'C', minPercent: 60, remark: 'Good' },
  { grade: 'D', minPercent: 50, remark: 'Satisfactory' },
  { grade: 'E', minPercent: 40, remark: 'Needs Improvement' },
  { grade: 'F', minPercent: 0, remark: 'Fail' },
];

const SchoolSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    city: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    status: { type: String, enum: SCHOOL_STATUSES, default: 'active', index: true },
    statusReason: { type: String },
    statusChangedAt: { type: Date },
    subscription: {
      planId: { type: ObjectId, ref: 'Plan' },
      status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trialing' },
      trialEndsAt: { type: Date },
      currentPeriodEnd: { type: Date },
      billingPeriod: { type: String, enum: ['monthly', 'yearly'] },
      /**
       * The price agreed for this school, copied from the plan when it was assigned. Later plan
       * price changes do not touch it; the Platform Owner applies a new price explicitly.
       */
      agreedPrice: {
        amount: { type: Number, min: 0 },
        currency: { type: String },
        period: { type: String, enum: ['monthly', 'yearly'] },
        setAt: { type: Date },
      },
      /**
       * Grandfathered features: when a plan change is published "for new subscribers only",
       * schools already on the plan keep this snapshot. Absent means "follow the plan".
       */
      lockedFeatures: { type: [String], default: undefined },
      /** School-specific exceptions to the plan, set by the Platform Owner. */
      featureOverrides: {
        type: [
          {
            _id: false,
            feature: { type: String, required: true },
            mode: { type: String, enum: ['grant', 'revoke'], required: true },
            reason: { type: String },
            by: { type: ObjectId, ref: 'PlatformAdmin' },
            byName: { type: String },
            at: { type: Date },
          },
        ],
        default: [],
      },
      planChangedAt: { type: Date },
    },
    settings: {
      timezone: { type: String, default: 'Asia/Karachi' },
      currency: { type: String, default: 'PKR' },
      currentSessionId: { type: ObjectId, ref: 'AcademicSession' },
      passPercent: { type: Number, default: 40 },
      /** ISO weekdays the school is open (1 = Monday … 7 = Sunday). Empty/absent: Monday to Saturday. */
      workingDays: { type: [Number], default: undefined },
      gradingScale: {
        type: [{ _id: false, grade: String, minPercent: Number, remark: String }],
        default: () => DEFAULT_GRADING_SCALE,
      },
      attendance: {
        lowAttendanceThreshold: { type: Number, default: 75 },
        consecutiveAbsenceAlert: { type: Number, default: 3 },
      },
      fees: {
        invoiceDueDay: { type: Number, default: 10 },
        lateFeeAmount: { type: Number, default: 0 },
        lateFeeGraceDays: { type: Number, default: 0 },
        invoicePrefix: { type: String, default: 'INV-' },
        receiptPrefix: { type: String, default: 'RCP-' },
        bankDetails: { type: String },
      },
      approvals: {
        expenseThreshold: { type: Number, default: 50_000 },
        bulkMessageThreshold: { type: Number, default: 20 },
      },
      ai: {
        enabled: { type: Boolean, default: true },
        monthlyTokenLimit: { type: Number },
      },
      /** Automatic parent-login provisioning when students are admitted (students get no login). */
      accounts: {
        autoCreateParentLogins: { type: Boolean, default: true },
      },
      /** Look of the school app for everyone in this school. */
      ui: {
        colorCoded: { type: Boolean, default: false },
      },
      /** Look of printable documents (validated by DocumentSettingsSchema; merged over defaults on read). */
      documents: { type: Schema.Types.Mixed },
    },
    /** The school's own branding. Never used for the platform or for any other school. */
    branding: {
      logo: {
        storageKey: { type: String },
        width: { type: Number },
        height: { type: Number },
        size: { type: Number },
        updatedAt: { type: Date },
      },
    },
  },
  baseOptions,
);

export type SchoolDoc = InferSchemaType<typeof SchoolSchema>;
export const School = model('School', SchoolSchema);
