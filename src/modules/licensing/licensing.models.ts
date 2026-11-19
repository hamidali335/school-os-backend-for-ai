import { model, Schema, type InferSchemaType } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const LICENSE_STATUSES = ['active', 'revoked', 'expired'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

const LicenseSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      licenseId: { type: String, required: true, unique: true, trim: true },
      deviceId: { type: String, required: true, trim: true },
      hardwareFingerprint: { type: String, required: true, trim: true },
      deviceName: { type: String, required: true, trim: true },
      planCode: { type: String, required: true, trim: true },
      status: { type: String, enum: LICENSE_STATUSES, default: 'active', index: true },
      issuedAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true },
      gracePeriodDays: { type: Number, default: 7 },
      entitlements: { type: [String], default: [] },
      limits: { type: Schema.Types.Mixed, default: {} },
      licenseVersion: { type: Number, default: 1 },
      signature: { type: String, required: true },
      signedPayload: { type: String, required: true },
      lastVerifiedAt: { type: Date, default: () => new Date() },
      revokedAt: { type: Date },
      revocationReason: { type: String },
    },
    baseOptions,
  ),
);

LicenseSchema.index({ schoolId: 1, deviceId: 1 });
LicenseSchema.index({ schoolId: 1, status: 1 });
export type LicenseDoc = InferSchemaType<typeof LicenseSchema>;
export const License = model('License', LicenseSchema);

const LicenseAuditLogSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      deviceId: { type: String, required: true },
      action: {
        type: String,
        enum: ['activated', 'verified', 'renewed', 'revoked', 'deactivated', 'device_replaced'],
        required: true,
      },
      performedBy: { type: ObjectId, ref: 'User' },
      details: { type: Schema.Types.Mixed },
      timestamp: { type: Date, default: () => new Date() },
    },
    baseOptions,
  ),
);

LicenseAuditLogSchema.index({ schoolId: 1, timestamp: -1 });
LicenseAuditLogSchema.index({ deviceId: 1, timestamp: -1 });
export type LicenseAuditLogDoc = InferSchemaType<typeof LicenseAuditLogSchema>;
export const LicenseAuditLog = model('LicenseAuditLog', LicenseAuditLogSchema);
