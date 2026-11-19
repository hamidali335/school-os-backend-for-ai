import { model, Schema, type Types } from 'mongoose';
import { baseOptions, tenantField, withTenant } from './schema-helpers';

const CounterSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      key: { type: String, required: true },
      seq: { type: Number, required: true, default: 0 },
    },
    baseOptions,
  ),
);
CounterSchema.index({ schoolId: 1, key: 1 }, { unique: true });

export const Counter = model('Counter', CounterSchema);

/** Atomically allocate the next number in a per-school sequence (receipts, invoices...). */
export async function nextSequence(schoolId: Types.ObjectId | string, key: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { schoolId, key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  return doc!.seq;
}

export async function nextNumber(
  schoolId: Types.ObjectId | string,
  key: string,
  prefix: string,
  pad = 6,
): Promise<string> {
  const seq = await nextSequence(schoolId, key);
  return `${prefix}${String(seq).padStart(pad, '0')}`;
}

/** Atomically allocate `count` consecutive numbers of a sequence (same format as nextNumber), in order. */
export async function reserveNumbers(
  schoolId: Types.ObjectId | string,
  key: string,
  prefix: string,
  pad: number,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];
  const doc = await Counter.findOneAndUpdate(
    { schoolId, key },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  const first = doc!.seq - count + 1;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(first + i).padStart(pad, '0')}`);
}
