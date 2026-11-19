import { model, Schema } from 'mongoose';
import { baseOptions, tenantField, withTenant } from '../../database/schema-helpers';

const CampusSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      code: { type: String, required: true, uppercase: true, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      phone: { type: String, trim: true },
      isMain: { type: Boolean, default: false },
      status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    },
    baseOptions,
  ),
);
CampusSchema.index({ schoolId: 1, code: 1 }, { unique: true });

export const Campus = model('Campus', CampusSchema);
