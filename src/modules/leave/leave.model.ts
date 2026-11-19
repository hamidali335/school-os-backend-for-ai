import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
/** Statuses that block another request for the same child and dates. */
export const ACTIVE_LEAVE_STATUSES: LeaveStatus[] = ['pending', 'approved'];
export const LEAVE_ACTIONS = ['submitted', 'reviewed', 'approved', 'rejected', 'cancelled'] as const;

/** One entry in the request's history: who did what, when, with what note. Append-only. */
const LeaveEventSchema = new Schema(
  {
    action: { type: String, enum: LEAVE_ACTIONS, required: true },
    byUserId: { type: ObjectId, ref: 'User', required: true },
    byName: { type: String, required: true },
    byRole: { type: String, required: true },
    note: { type: String, maxlength: 500 },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * A parent's leave request for one of their children. Class and section are copied from the
 * student when it is submitted, so routing to the class teacher stays stable if the child
 * later moves section. Approval never changes attendance by itself.
 */
const LeaveRequestSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      studentId: { type: ObjectId, ref: 'Student', required: true },
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      from: { type: Date, required: true },
      to: { type: Date, required: true },
      days: { type: Number, required: true, min: 1, max: 30 },
      reason: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },
      status: { type: String, enum: LEAVE_STATUSES, default: 'pending', required: true },
      requestedBy: { type: ObjectId, ref: 'User', required: true },
      requestedByName: { type: String, required: true },
      decidedBy: { type: ObjectId, ref: 'User' },
      decidedByName: { type: String },
      decidedAt: { type: Date },
      decisionNote: { type: String, maxlength: 500 },
      history: { type: [LeaveEventSchema], default: [] },
    },
    baseOptions,
  ),
);
LeaveRequestSchema.index({ schoolId: 1, status: 1, createdAt: -1 });
LeaveRequestSchema.index({ schoolId: 1, studentId: 1, from: 1 });
LeaveRequestSchema.index({ schoolId: 1, sectionId: 1, status: 1, from: 1 });

export const LeaveRequest = model('LeaveRequest', LeaveRequestSchema);
