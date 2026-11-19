import { model, Schema } from 'mongoose';
import { PLATFORM_ROLES } from '../../config/permissions';
import { baseOptions } from '../../database/schema-helpers';

/**
 * Platform operators. Deliberately a separate collection from school users: a platform
 * identity can never be confused with, or escalated from, a school account.
 */
const PlatformAdminSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: PLATFORM_ROLES, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    tokenVersion: { type: Number, default: 0 },
    failedLoginCount: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String },
  },
  baseOptions,
);

export const PlatformAdmin = model('PlatformAdmin', PlatformAdminSchema);
export const PLATFORM_ADMIN_PUBLIC_FIELDS = '_id name email role status lastLoginAt createdAt updatedAt';
