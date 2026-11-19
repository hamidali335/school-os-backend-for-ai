import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * App voice calls (docs/VOICE_CALLS.md). One document per call attempt: who called whom, about
 * which student, and how it ended. Audio never passes through or is stored by the API.
 *
 * Live states: ringing → connecting (answered, media being set up) → active (audio flowing).
 * Final states: completed, missed, declined, cancelled, busy, unreachable, failed.
 */
export const LIVE_CALL_STATUSES = ['ringing', 'connecting', 'active'] as const;
export const FINAL_CALL_STATUSES = [
  'completed',
  'missed',
  'declined',
  'cancelled',
  'busy',
  'unreachable',
  'failed',
] as const;
export const CALL_STATUSES = [...LIVE_CALL_STATUSES, ...FINAL_CALL_STATUSES] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * direct: one named person (a parent, a teacher, an office member).
 * ai: an AI voice conversation (src/modules/ai-calls) started by school leadership: the parent
 * rings as usual and the other side is the server's AI agent, acting for that staff member.
 * office: a parent calling "the school office": every eligible office account rings and the
 * first to answer takes the call.
 */
export const CALL_KINDS = ['direct', 'office', 'ai'] as const;

const CallSessionSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      /** Opaque, unguessable id used by clients and signaling (never the database _id). */
      callId: { type: String, required: true },
      kind: { type: String, enum: CALL_KINDS, required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      studentName: { type: String, required: true },
      callerUserId: { type: ObjectId, ref: 'User', required: true },
      callerName: { type: String, required: true },
      callerRole: { type: String, required: true },
      /** The parent and staff accounts of the call (staff is set on answer for office calls). */
      parentId: { type: ObjectId, ref: 'Parent', required: true },
      parentUserId: { type: ObjectId, ref: 'User', required: true },
      staffUserId: { type: ObjectId, ref: 'User' },
      /** Accounts that were rung. Only these may answer. */
      ringUserIds: { type: [ObjectId], ref: 'User', default: [] },
      declinedUserIds: { type: [ObjectId], ref: 'User', default: [] },
      /** Display name of the callee: the person, or "School office" until someone answers. */
      calleeName: { type: String, required: true },
      /** How the callee is described to the caller, e.g. Parent, Class teacher, Principal. */
      calleeRole: { type: String, required: true },
      answeredByUserId: { type: ObjectId, ref: 'User' },
      /** Signaling connections bound to the call; signals are relayed only between these two. */
      callerConnId: { type: String },
      calleeConnId: { type: String },
      status: { type: String, enum: CALL_STATUSES, required: true },
      endReason: { type: String, maxlength: 40 },
      endedByUserId: { type: ObjectId, ref: 'User' },
      ringExpiresAt: { type: Date, required: true },
      answeredAt: { type: Date },
      connectedAt: { type: Date },
      endedAt: { type: Date },
      durationSec: { type: Number, min: 0 },
      /**
       * Technical connection statistics each side reported (ICE state, candidate types, bytes and
       * packets each way, loss, round-trip time, microphone track state). Never audio or content.
       */
      diagnostics: {
        caller: { type: Schema.Types.Mixed },
        callee: { type: Schema.Types.Mixed },
      },
    },
    baseOptions,
  ),
);
CallSessionSchema.index({ callId: 1 }, { unique: true });
// History for each side, and the busy check ("is this person in a live call?").
CallSessionSchema.index({ schoolId: 1, callerUserId: 1, createdAt: -1 });
CallSessionSchema.index({ schoolId: 1, ringUserIds: 1, createdAt: -1 });
CallSessionSchema.index({ schoolId: 1, answeredByUserId: 1, status: 1 });
// Call history inside a conversation (same student, parent and staff member).
CallSessionSchema.index({ schoolId: 1, studentId: 1, parentUserId: 1, staffUserId: 1, createdAt: -1 });
// Sweeper: live calls whose ringing or connection window has passed.
CallSessionSchema.index({ status: 1, ringExpiresAt: 1 });
export const CallSession = model('CallSession', CallSessionSchema);
