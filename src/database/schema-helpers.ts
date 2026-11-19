import { Schema } from 'mongoose';
import { tenantPlugin } from './tenant-plugin';

export const { ObjectId } = Schema.Types;

/**
 * Required, immutable tenant key for every school-owned collection.
 * Usage: `withTenant(new Schema({ ...tenantField, name: String }, baseOptions))`
 * (spreading into a literal keeps Mongoose's type inference intact).
 */
export const tenantField = {
  schoolId: { type: ObjectId, ref: 'School', required: true as const, index: true, immutable: true },
};

export const baseOptions = { timestamps: true, versionKey: false } as const;
export const createdOnlyOptions = { timestamps: { createdAt: true, updatedAt: false }, versionKey: false } as const;

/** Attach the tenant guard plugin (queries without a schoolId filter throw). */
export function withTenant<S extends Schema<any, any, any, any, any, any, any, any>>(schema: S): S {
  schema.plugin(tenantPlugin);
  return schema;
}
