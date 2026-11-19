import { model, Schema } from 'mongoose';
import { ObjectId, createdOnlyOptions } from '../../database/schema-helpers';

/** Server-side failures (5xx) captured for platform error summaries. No request bodies stored. */
const ErrorEventSchema = new Schema(
  {
    requestId: { type: String },
    method: { type: String },
    route: { type: String },
    status: { type: Number },
    code: { type: String },
    message: { type: String },
    schoolId: { type: ObjectId },
    source: { type: String, enum: ['api', 'scheduler', 'integration'], default: 'api' },
  },
  createdOnlyOptions,
);
// Keep 90 days of error events.
ErrorEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600, name: 'ttl_90d' });

export const ErrorEvent = model('ErrorEvent', ErrorEventSchema);
