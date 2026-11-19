import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'resigned', 'terminated', 'archived'] as const;
/** Statuses that can be set directly. `archived` is only set/cleared by the archive endpoints. */
export const SETTABLE_EMPLOYEE_STATUSES = ['active', 'on_leave', 'resigned', 'terminated'] as const;

const EmployeeSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      employeeNo: { type: String, required: true, trim: true },
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, trim: true },
      gender: { type: String, enum: ['male', 'female', 'other'] },
      cnic: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      address: { type: String },
      designation: { type: String, required: true, trim: true },
      department: { type: String, trim: true },
      staffType: { type: String, enum: ['teaching', 'non_teaching'], required: true },
      qualification: { type: String },
      joiningDate: { type: Date },
      salary: {
        basic: { type: Number, default: 0, min: 0 },
        allowances: { type: Number, default: 0, min: 0 },
        deductions: { type: Number, default: 0, min: 0 },
      },
      bankAccount: { type: String },
      status: { type: String, enum: EMPLOYEE_STATUSES, default: 'active' },
      leftAt: { type: Date },
      /** Set while the record is archived: kept for history, hidden from active lists, logins suspended. */
      archive: {
        previousStatus: { type: String },
        archivedAt: { type: Date },
        archivedBy: { type: ObjectId, ref: 'User' },
        reason: { type: String },
      },
      userId: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
EmployeeSchema.index({ schoolId: 1, employeeNo: 1 }, { unique: true });
EmployeeSchema.index({ schoolId: 1, status: 1, staffType: 1 });
export const Employee = model('Employee', EmployeeSchema);

/** Monthly payslip. Net pay is computed by application code, never by AI. */
const PayslipSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      employeeId: { type: ObjectId, ref: 'Employee', required: true },
      period: { type: String, required: true },
      basic: { type: Number, required: true },
      allowances: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      bonus: { type: Number, default: 0 },
      net: { type: Number, required: true },
      status: { type: String, enum: ['draft', 'paid', 'cancelled'], default: 'draft' },
      paidAt: { type: Date },
      paymentMethod: { type: String, enum: ['cash', 'bank_transfer', 'cheque'] },
      expenseId: { type: ObjectId, ref: 'Expense' },
      notes: { type: String },
    },
    baseOptions,
  ),
);
PayslipSchema.index({ schoolId: 1, employeeId: 1, period: 1 }, { unique: true });
PayslipSchema.index({ schoolId: 1, period: 1 });
export const Payslip = model('Payslip', PayslipSchema);
