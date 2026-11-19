import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * One AI voice conversation (docs/AI_VOICE_CALLS.md): what the school asked for, the call it
 * used (CallSession.callId), and what came out of it. No audio is ever stored. The transcript
 * exists only when the school enabled it and the parent consented, and it is deleted after
 * AI_CALL_TRANSCRIPT_RETENTION_DAYS; answers, summary and outcome are kept.
 */
export const AI_CALL_STATUSES = [
  'starting',
  'ringing',
  'consent',
  'in_progress',
  'completed',
  'no_consent',
  'not_answered',
  'cancelled',
  'failed',
] as const;
export const AI_CALL_FINAL = ['completed', 'no_consent', 'not_answered', 'cancelled', 'failed'] as const;
export const AI_CALL_LANGUAGES = ['ur', 'en'] as const;
export const ANSWER_TYPES = ['text', 'yes_no', 'number', 'date', 'choice'] as const;

const QuestionSchema = new Schema(
  {
    key: { type: String, required: true, maxlength: 40 },
    prompt: { type: String, required: true, maxlength: 300 },
    type: { type: String, enum: ANSWER_TYPES, required: true },
    choices: { type: [String], default: undefined },
    required: { type: Boolean, default: true },
  },
  { _id: false },
);

const AiConversationSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      studentId: { type: ObjectId, ref: 'Student', required: true },
      studentName: { type: String, required: true },
      /** The student's campus, for campus-restricted staff. */
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      parentId: { type: ObjectId, ref: 'Parent', required: true },
      parentUserId: { type: ObjectId, ref: 'User' },
      parentName: { type: String, required: true },
      /** The staff member who configured and started it; the AI acts for them. */
      createdBy: { type: ObjectId, ref: 'User', required: true },
      createdByName: { type: String, required: true },
      purpose: { type: String, required: true, maxlength: 500 },
      language: { type: String, enum: AI_CALL_LANGUAGES, required: true },
      questions: { type: [QuestionSchema], required: true },
      storeTranscript: { type: Boolean, default: true },
      /** The ordinary call session that carried it (calls module). */
      callId: { type: String },
      status: { type: String, enum: AI_CALL_STATUSES, required: true },
      consent: { type: String, enum: ['given', 'refused', 'unclear'] },
      consentAt: { type: Date },
      transcript: {
        type: [
          {
            _id: false,
            role: { type: String, enum: ['ai', 'parent'], required: true },
            text: { type: String, required: true, maxlength: 2000 },
            at: { type: Date, required: true },
          },
        ],
        default: undefined,
      },
      transcriptExpiresAt: { type: Date },
      /** Structured answers by question key (as understood by the AI: to be checked by staff). */
      answers: { type: Schema.Types.Mixed, default: {} },
      summary: { type: String, maxlength: 2000 },
      /** all_answered | partly_answered | none_answered | follow_up (asked for a human). */
      outcome: { type: String, maxlength: 40 },
      followUpRequested: { type: Boolean, default: false },
      failureReason: { type: String, maxlength: 80 },
      startedAt: { type: Date },
      endedAt: { type: Date },
      usage: {
        turns: { type: Number, default: 0 },
        speechSeconds: { type: Number, default: 0 },
        ttsCharacters: { type: Number, default: 0 },
        llmTokens: { type: Number, default: 0 },
        durationSec: { type: Number, default: 0 },
      },
    },
    baseOptions,
  ),
);
AiConversationSchema.index({ schoolId: 1, createdAt: -1 });
AiConversationSchema.index({ schoolId: 1, status: 1 });
AiConversationSchema.index({ schoolId: 1, callId: 1 });
AiConversationSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });
// Retention sweeper: transcripts past their expiry.
AiConversationSchema.index({ transcriptExpiresAt: 1 }, { sparse: true });
export const AiConversation = model('AiConversation', AiConversationSchema);
