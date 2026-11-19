import { model, Schema } from 'mongoose';
import { ObjectId, baseOptions } from '../../database/schema-helpers';

/**
 * Refresh-token sessions. Only a SHA-256 hash of the token is stored. Tokens rotate on
 * every use; presenting an already-rotated token revokes the whole family (theft signal).
 */
const RefreshTokenSchema = new Schema(
  {
    subjectType: { type: String, enum: ['user', 'platform'], required: true },
    subjectId: { type: ObjectId, required: true, index: true },
    schoolId: { type: ObjectId, ref: 'School' },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String },
    rotatedAt: { type: Date },
    ip: { type: String },
    userAgent: { type: String },
  },
  baseOptions,
);
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model('RefreshToken', RefreshTokenSchema);
