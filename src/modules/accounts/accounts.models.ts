import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'cheque', 'online', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const EXPENSE_CATEGORIES = [
  'salaries',
  'rent',
  'utilities',
  'maintenance',
  'stationery',
  'transport_fuel',
  'events',
  'marketing',
  'it_software',
  'taxes',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const INCOME_CATEGORIES = [
  'donation',
  'canteen',
  'uniform_sales',
  'book_sales',
  'event',
  'rent',
  'grant',
  'other',
] as const;

/** Non-fee income. Fee collections live in the Payment collection and are never duplicated here. */
const IncomeSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus' },
      category: { type: String, enum: INCOME_CATEGORIES, required: true },
      amount: { type: Number, required: true, min: 1 },
      date: { type: Date, required: true },
      description: { type: String, trim: true },
      payer: { type: String, trim: true },
      paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'cash' },
      reference: { type: String, trim: true },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
IncomeSchema.index({ schoolId: 1, date: -1 });
export const Income = model('Income', IncomeSchema);

const ExpenseSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus' },
      category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
      amount: { type: Number, required: true, min: 1 },
      date: { type: Date, required: true },
      vendor: { type: String, trim: true },
      description: { type: String, trim: true },
      paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'cash' },
      reference: { type: String, trim: true },
      status: { type: String, enum: ['pending_approval', 'approved', 'rejected'], default: 'approved' },
      approvalId: { type: ObjectId, ref: 'ApprovalRequest' },
      source: { type: String, enum: ['manual', 'payroll'], default: 'manual' },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
ExpenseSchema.index({ schoolId: 1, date: -1 });
ExpenseSchema.index({ schoolId: 1, status: 1 });
export const Expense = model('Expense', ExpenseSchema);
