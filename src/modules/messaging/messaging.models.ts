import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * Teacher–parent conversations. Each conversation is about one student and has exactly two
 * participants: a staff member and a parent account. Students have no logins of their own,
 * so "messaging a student" means messaging that student's parent account about them.
 */
const ConversationSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      studentId: { type: ObjectId, ref: 'Student', required: true },
      parentId: { type: ObjectId, ref: 'Parent', required: true },
      parentUserId: { type: ObjectId, ref: 'User', required: true },
      staffUserId: { type: ObjectId, ref: 'User', required: true },
      staffName: { type: String, required: true },
      parentName: { type: String, required: true },
      studentName: { type: String, required: true },
      startedBy: { type: ObjectId, ref: 'User', required: true },
      lastMessageAt: { type: Date, required: true },
      lastMessagePreview: { type: String, default: '' },
      lastSenderUserId: { type: ObjectId, ref: 'User' },
      /** When each participant last read the conversation (for unread counts and read receipts). */
      parentReadAt: { type: Date },
      staffReadAt: { type: Date },
    },
    baseOptions,
  ),
);
// One conversation per student, parent account and staff member.
ConversationSchema.index({ schoolId: 1, studentId: 1, parentUserId: 1, staffUserId: 1 }, { unique: true });
ConversationSchema.index({ schoolId: 1, staffUserId: 1, lastMessageAt: -1 });
ConversationSchema.index({ schoolId: 1, parentUserId: 1, lastMessageAt: -1 });
ConversationSchema.index({ schoolId: 1, lastMessageAt: -1 });
export const Conversation = model('Conversation', ConversationSchema);

const MessageSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      conversationId: { type: ObjectId, ref: 'Conversation', required: true },
      senderUserId: { type: ObjectId, ref: 'User', required: true },
      senderName: { type: String, required: true },
      senderRole: { type: String, required: true },
      body: { type: String, required: true, maxlength: 2000 },
      /** The sending device's id for this message: a retry with the same id is not saved twice. */
      clientMessageId: { type: String, maxlength: 64 },
    },
    baseOptions,
  ),
);
MessageSchema.index({ schoolId: 1, conversationId: 1, createdAt: -1 });
MessageSchema.index(
  { schoolId: 1, conversationId: 1, senderUserId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
export const Message = model('Message', MessageSchema);
