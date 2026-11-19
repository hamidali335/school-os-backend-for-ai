import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId } from '../../database/schema-helpers';
import { AI_PROVIDER_IDS } from './catalog';

/**
 * Platform-wide AI configuration, managed from the owner admin panel. A single document
 * (key "global"). API keys are stored encrypted and never returned by the API.
 */
const ProviderConfigSchema = new Schema(
  {
    apiKeyEncrypted: { type: String },
    apiKeyMasked: { type: String },
    model: { type: String, trim: true },
    baseUrl: { type: String, trim: true },
    inputCostPerMTokUsd: { type: Number, min: 0, default: 0 },
    outputCostPerMTokUsd: { type: Number, min: 0, default: 0 },
    updatedAt: { type: Date },
    updatedBy: { type: ObjectId, ref: 'PlatformAdmin' },
  },
  { _id: false },
);

const AiSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    enabled: { type: Boolean, default: true },
    activeProvider: { type: String, enum: AI_PROVIDER_IDS },
    timeoutMs: { type: Number, min: 1000, max: 120_000, default: 30_000 },
    providers: { type: Map, of: ProviderConfigSchema, default: {} },
    updatedBy: { type: ObjectId, ref: 'PlatformAdmin' },
  },
  baseOptions,
);

export const AiSettings = model('AiSettings', AiSettingsSchema, 'aisettings');
