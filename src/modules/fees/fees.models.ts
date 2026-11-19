import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { PAYMENT_METHODS } from '../accounts/accounts.models';
import { atomicGuardPlugin } from '../../database/atomic-guard-plugin';

/**
 * monthly: every invoice · annual/term: only in the structure's billingMonths (term = several
 * months a year, e.g. examination fee in April and October) · one_time: first invoice only.
 */
export const FEE_FREQUENCIES = ['monthly', 'term', 'annual', 'one_time'] as const;
/** class: part of the class fee structure · per_student: added only for students who take it (transport, books). */
export const FEE_HEAD_BILLING = ['class', 'per_student'] as const;
export const INVOICE_STATUSES = ['unpaid', 'partial', 'paid', 'waived', 'cancelled'] as const;
/**
 * regular: the monthly invoice (one per student and month); adhoc: extra charges;
 * opening: dues brought from before the school used School OS (one per student, see fee import).
 */
export const INVOICE_KINDS = ['regular', 'adhoc', 'opening'] as const;

const FeeHeadSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      frequency: { type: String, enum: FEE_FREQUENCIES, required: true },
      billing: { type: String, enum: FEE_HEAD_BILLING, default: 'class' },
      /** Whether a student's standing concession reduces this head (normally tuition only). */
      concessionApplies: { type: Boolean, default: false },
      description: { type: String },
      isActive: { type: Boolean, default: true },
    },
    baseOptions,
  ),
);
FeeHeadSchema.index({ schoolId: 1, code: 1 }, { unique: true });
export const FeeHead = model('FeeHead', FeeHeadSchema);

const FeeStructureSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      name: { type: String, required: true, trim: true },
      items: {
        type: [
          {
            _id: false,
            feeHeadId: { type: ObjectId, ref: 'FeeHead', required: true },
            amount: { type: Number, required: true, min: 0 },
            /** For annual heads: calendar months (1-12) in which the charge is billed. */
            billingMonths: { type: [Number], default: [] },
          },
        ],
        default: [],
      },
      isActive: { type: Boolean, default: true },
    },
    baseOptions,
  ),
);
FeeStructureSchema.index({ schoolId: 1, sessionId: 1, classId: 1 }, { unique: true });
export const FeeStructure = model('FeeStructure', FeeStructureSchema);

const InvoiceSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      sessionId: { type: ObjectId, ref: 'AcademicSession' },
      classId: { type: ObjectId, ref: 'SchoolClass' },
      sectionId: { type: ObjectId, ref: 'Section' },
      invoiceNo: { type: String, required: true },
      kind: { type: String, enum: INVOICE_KINDS, default: 'regular' },
      period: { type: String, required: true },
      issueDate: { type: Date, required: true },
      dueDate: { type: Date, required: true },
      items: {
        type: [
          {
            _id: false,
            feeHeadId: { type: ObjectId, ref: 'FeeHead' },
            name: { type: String, required: true },
            amount: { type: Number, required: true, min: 0 },
            concessionApplies: { type: Boolean, default: false },
          },
        ],
        default: [],
      },
      subtotal: { type: Number, required: true, min: 0 },
      concession: { type: Number, default: 0, min: 0 },
      waiver: { type: Number, default: 0, min: 0 },
      lateFee: { type: Number, default: 0, min: 0 },
      total: { type: Number, required: true, min: 0 },
      paid: { type: Number, default: 0, min: 0 },
      balance: { type: Number, required: true, min: 0 },
      status: { type: String, enum: INVOICE_STATUSES, default: 'unpaid' },
      installments: {
        type: [{ _id: false, no: Number, amount: Number, dueDate: Date }],
        default: [],
      },
      lateFeeAppliedAt: { type: Date },
      lastReminderAt: { type: Date },
      notes: { type: String },
      /** Ad-hoc invoices: the client's request key, so a retried request returns the same invoice. */
      idempotencyKey: { type: String },
      cancelledReason: { type: String },
      createdBy: { type: ObjectId, ref: 'User' },
      /**
       * Held while one payment is recorded on this invoice (see recordPayment), so two payments
       * at the same moment cannot both allocate the same fee. Short-lived; expires if its
       * process stops.
       */
      paymentLock: { type: new Schema({ token: String, at: Date }, { _id: false }), default: undefined },
      version: { type: Number, default: 1, required: true },
    },
    baseOptions,
  ),
);
InvoiceSchema.plugin(atomicGuardPlugin);
InvoiceSchema.index({ schoolId: 1, invoiceNo: 1 }, { unique: true });
InvoiceSchema.index(
  { schoolId: 1, studentId: 1, period: 1 },
  { unique: true, partialFilterExpression: { kind: 'regular' }, name: 'one_regular_invoice_per_period' },
);
// Opening balance: at most one per student, so a repeated fee import never adds the dues twice.
InvoiceSchema.index(
  { schoolId: 1, studentId: 1 },
  { unique: true, partialFilterExpression: { kind: 'opening' }, name: 'one_opening_invoice_per_student' },
);
// Ad-hoc invoices: one invoice per request key, even for two identical requests at the same moment.
InvoiceSchema.index(
  { schoolId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
    name: 'invoice_idempotency_key_unique',
  },
);
InvoiceSchema.index({ schoolId: 1, status: 1, dueDate: 1 });
InvoiceSchema.index({ schoolId: 1, period: 1 });
export const Invoice = model('Invoice', InvoiceSchema);

const PaymentSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus' },
      invoiceId: { type: ObjectId, ref: 'Invoice', required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      receiptNo: { type: String, required: true },
      amount: { type: Number, required: true, min: 1 },
      method: { type: String, enum: PAYMENT_METHODS, required: true },
      reference: { type: String, trim: true },
      receivedAt: { type: Date, required: true },
      receivedBy: { type: ObjectId, ref: 'User' },
      receivedByName: { type: String },
      allocations: { type: [{ _id: false, installmentNo: Number, amount: Number }], default: [] },
      /**
       * Which invoice lines this payment settled. line is an item index ("0", "1"...) or
       * "late_fee". Recorded with every payment since allocationSource was added: chosen by staff,
       * or automatic (outstanding lines in invoice order). Older payments have none recorded.
       */
      headAllocations: { type: [{ _id: false, line: String, name: String, amount: Number }], default: [] },
      /** How headAllocations was decided; absent on payments recorded before allocations were kept. */
      allocationSource: { type: String, enum: ['chosen', 'automatic'] },
      balanceAfter: { type: Number },
      status: { type: String, enum: ['valid', 'reversed'], default: 'valid' },
      reversedAt: { type: Date },
      reversalReason: { type: String },
      idempotencyKey: { type: String },
      version: { type: Number, default: 1, required: true },
    },
    baseOptions,
  ),
);
PaymentSchema.plugin(atomicGuardPlugin);
PaymentSchema.index({ schoolId: 1, receiptNo: 1 }, { unique: true });
PaymentSchema.index({ schoolId: 1, receivedAt: -1 });
PaymentSchema.index({ schoolId: 1, invoiceId: 1 });
PaymentSchema.index({ schoolId: 1, studentId: 1 });
PaymentSchema.index(
  { schoolId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
export const Payment = model('Payment', PaymentSchema);
