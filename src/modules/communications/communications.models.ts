import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
export const EXTERNAL_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];

/**
 * Message statuses. `sent` means the provider accepted the message (HTTP 2xx / SMTP 250);
 * it is only ever set after a real provider call. `not_configured` and `draft` mean nothing
 * left the system.
 */
export const MESSAGE_STATUSES = [
  'draft',
  'queued',
  'sent',
  'failed',
  'not_configured',
  'limit_reached',
  'paused',
] as const;

const NotificationSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      userId: { type: ObjectId, ref: 'User', required: true },
      title: { type: String, required: true },
      body: { type: String, required: true },
      category: { type: String, default: 'general' },
      link: { type: String },
      data: { type: Object },
      readAt: { type: Date },
    },
    baseOptions,
  ),
);
NotificationSchema.index({ schoolId: 1, userId: 1, readAt: 1, createdAt: -1 });
// Keep in-app notifications for one year.
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });
export const Notification = model('Notification', NotificationSchema);

const AnnouncementSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      title: { type: String, required: true, trim: true },
      body: { type: String, required: true },
      audience: {
        roles: { type: [String], default: [] },
        campusIds: { type: [ObjectId], default: [] },
        classIds: { type: [ObjectId], default: [] },
        sectionIds: { type: [ObjectId], default: [] },
      },
      channels: { type: [String], enum: CHANNELS, default: ['in_app'] },
      status: { type: String, enum: ['draft', 'pending_approval', 'published', 'rejected'], default: 'draft' },
      aiGenerated: { type: Boolean, default: false },
      approvalId: { type: ObjectId, ref: 'ApprovalRequest' },
      publishedAt: { type: Date },
      createdBy: { type: ObjectId, ref: 'User' },
      createdByName: { type: String },
      delivery: {
        status: { type: String, enum: ['none', 'in_progress', 'completed'], default: 'none' },
        recipients: { type: Number, default: 0 },
        inApp: { type: Number, default: 0 },
        external: { type: Object, default: {} },
      },
    },
    baseOptions,
  ),
);
AnnouncementSchema.index({ schoolId: 1, status: 1, createdAt: -1 });
export const Announcement = model('Announcement', AnnouncementSchema);

const MessageLogSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      channel: { type: String, enum: EXTERNAL_CHANNELS, required: true },
      to: { type: String, required: true },
      recipientName: { type: String },
      recipientParentId: { type: ObjectId, ref: 'Parent' },
      recipientUserId: { type: ObjectId, ref: 'User' },
      subject: { type: String },
      body: { type: String, required: true },
      status: { type: String, enum: MESSAGE_STATUSES, required: true },
      provider: { type: String },
      providerMessageId: { type: String },
      error: { type: String },
      costPkr: { type: Number, default: 0 },
      relatedType: { type: String },
      relatedId: { type: String },
      sentBy: { type: ObjectId, ref: 'User' },
      sentAt: { type: Date },
    },
    baseOptions,
  ),
);
MessageLogSchema.index({ schoolId: 1, createdAt: -1 });
MessageLogSchema.index({ schoolId: 1, status: 1, channel: 1 });
MessageLogSchema.index({ schoolId: 1, relatedType: 1, relatedId: 1 });
export const MessageLog = model('MessageLog', MessageLogSchema);
