import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * A device that may receive push messages for the signed-in user (incoming calls and school
 * notifications). One row per device token: when another account signs in on the same phone,
 * the token moves to that account; a new token from the same app installation replaces the old.
 */
const PushDeviceSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      userId: { type: ObjectId, ref: 'User', required: true },
      token: { type: String, required: true, maxlength: 4096 },
      /** Random id the app keeps per installation (not a hardware id). */
      installationId: { type: String, maxlength: 64 },
      platform: { type: String, enum: ['android'], required: true },
      lastSeenAt: { type: Date, required: true },
    },
    baseOptions,
  ),
);
PushDeviceSchema.index({ token: 1 }, { unique: true });
PushDeviceSchema.index({ schoolId: 1, userId: 1 });
PushDeviceSchema.index({ installationId: 1 }, { sparse: true });
export const PushDevice = model('PushDevice', PushDeviceSchema);
