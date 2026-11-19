import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { campusScope, oid, scope } from '../../utils/tenant';
import { Section } from '../academics/academics.models';
import { visibleStudentIds } from '../academics/access.service';
import { audit } from '../audit/audit.service';
import { notifyUsers } from '../communications/communications.service';
import { schoolTimezone } from '../schools/timezone';
import { Student } from '../students/student.models';
import { User } from '../users/user.model';
import { ACTIVE_LEAVE_STATUSES, LeaveRequest, type LeaveStatus } from './leave.model';

/**
 * Student leave requests. Policy (approved):
 * - Parents submit, list and open requests for their own linked children only, and may cancel
 *   their own request while it is pending.
 * - Class teachers see requests for students of the sections they are class teacher of, and may
 *   add a review note. They never approve or reject.
 * - Only holders of `leave:decide` (school owner, principal, office administrator, or a custom
 *   role granted it) approve or reject, and never their own request.
 * - Approving does not change attendance: the register only shows an "approved leave" hint.
 */

/** How far back a parent may report leave (a sick day already taken), and the longest request. */
export const LEAVE_BACKDATE_DAYS = 7;
export const LEAVE_MAX_DAYS = 30;
export const LEAVE_MAX_AHEAD_DAYS = 120;

const DECIDERS = new Set(['school_owner', 'principal', 'school_admin']);

type Event = { action: string; note?: string };
const event = (ctx: SchoolContext, e: Event) => ({
  action: e.action,
  byUserId: oid(ctx.userId),
  byName: ctx.name,
  byRole: ctx.role,
  ...(e.note ? { note: e.note } : {}),
  at: new Date(),
});

const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

/** Sections where this teacher is the class teacher (subject teachers do not review leave). */
async function classTeacherSectionIds(ctx: SchoolContext): Promise<Types.ObjectId[]> {
  if (ctx.role !== 'teacher' || !ctx.employeeId) return [];
  const rows = await Section.find(scope(ctx, { classTeacherId: oid(ctx.employeeId) }))
    .select('_id')
    .lean();
  return rows.map((r) => r._id as Types.ObjectId);
}

/**
 * What the caller may see, as a Mongo filter fragment. Anything outside it answers 404, so
 * request ids reveal nothing.
 */
export async function leaveVisibility(ctx: SchoolContext): Promise<Record<string, unknown>> {
  if (ctx.role === 'parent') {
    const kids = (await visibleStudentIds(ctx)) ?? [];
    return { studentId: { $in: kids.map(oid) } };
  }
  if (ctx.role === 'teacher') {
    return { sectionId: { $in: await classTeacherSectionIds(ctx) } };
  }
  if (ctx.permissions.has('leave:decide') || ctx.permissions.has('leave:read')) return campusScope(ctx);
  return { _id: { $in: [] } };
}

async function findVisible(ctx: SchoolContext, id: string) {
  const row = await LeaveRequest.findOne(scope(ctx, { _id: oid(id), ...(await leaveVisibility(ctx)) }))
    .populate('studentId', 'firstName lastName admissionNo')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .lean();
  if (!row) throw notFound('Leave request');
  return row;
}

export async function createLeave(
  ctx: SchoolContext,
  input: { studentId: string; from: string; to: string; reason: string },
) {
  if (ctx.role !== 'parent') throw forbidden('Only parents submit leave requests for their children');
  const kids = (await visibleStudentIds(ctx)) ?? [];
  if (!kids.includes(input.studentId)) throw notFound('Student');
  const student = await Student.findOne(scope(ctx, { _id: oid(input.studentId), status: 'active' }))
    .select('firstName lastName campusId classId sectionId')
    .lean();
  if (!student) throw notFound('Student');

  const today = parseDateOnly(todayInTz(await schoolTimezone(ctx.schoolId)));
  const from = parseDateOnly(input.from);
  const to = parseDateOnly(input.to);
  if (to < from) throw badRequest('"to" must be on or after "from"', { field: 'to' });
  const days = daysBetween(from, to);
  if (days > LEAVE_MAX_DAYS) throw badRequest(`A request can cover at most ${LEAVE_MAX_DAYS} days`, { field: 'to' });
  if (from < addDays(today, -LEAVE_BACKDATE_DAYS)) {
    throw badRequest(`Leave can be reported at most ${LEAVE_BACKDATE_DAYS} days after it started`, { field: 'from' });
  }
  if (from > addDays(today, LEAVE_MAX_AHEAD_DAYS)) {
    throw badRequest(`Leave can be requested at most ${LEAVE_MAX_AHEAD_DAYS} days ahead`, { field: 'from' });
  }

  const overlapFilter = (excludeId?: Types.ObjectId) =>
    scope(ctx, {
      studentId: student._id,
      status: { $in: ACTIVE_LEAVE_STATUSES },
      from: { $lte: to },
      to: { $gte: from },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
  const overlapping = () =>
    conflict('There is already a pending or approved leave request for these dates', undefined, 'LEAVE_OVERLAP');
  if (await LeaveRequest.exists(overlapFilter())) throw overlapping();

  const doc = await LeaveRequest.create({
    schoolId: ctx.schoolId,
    studentId: student._id,
    campusId: student.campusId,
    classId: student.classId,
    sectionId: student.sectionId,
    from,
    to,
    days,
    reason: input.reason.trim(),
    status: 'pending',
    requestedBy: ctx.userId,
    requestedByName: ctx.name,
    history: [event(ctx, { action: 'submitted', note: input.reason.trim() })],
  });
  // Two submissions at the same moment both pass the check above; the later one gives way.
  const earlier = await LeaveRequest.findOne(overlapFilter(doc._id as Types.ObjectId))
    .select('_id')
    .lean();
  if (earlier && String(earlier._id) < String(doc._id)) {
    await LeaveRequest.deleteOne(scope(ctx, { _id: doc._id }));
    throw overlapping();
  }

  await audit(ctx, {
    action: 'leave.submit',
    entityType: 'LeaveRequest',
    entityId: doc._id,
    metadata: { studentId: input.studentId, from: input.from, to: input.to, days },
  });
  // Tell the class teacher and the school's deciders (in-app).
  const section = await Section.findOne(scope(ctx, { _id: student.sectionId }))
    .select('classTeacherId')
    .lean();
  const recipients = await User.find(
    scope(ctx, {
      status: 'active',
      $or: [
        { role: { $in: [...DECIDERS] } },
        ...(section?.classTeacherId ? [{ employeeId: section.classTeacherId }] : []),
      ],
    }),
  )
    .select('_id')
    .lean();
  const childName = `${student.firstName} ${student.lastName ?? ''}`.trim();
  await notifyUsers(
    ctx,
    recipients.map((r) => r._id),
    {
      title: 'Leave request',
      body: `${childName}: ${formatDateOnly(from)}${days > 1 ? ` to ${formatDateOnly(to)}` : ''}.`,
      category: 'leave',
      link: `/leave-requests/${doc._id}`,
    },
  );
  return findVisible(ctx, String(doc._id));
}

export async function listLeave(
  ctx: SchoolContext,
  q: {
    page: number;
    limit: number;
    status?: LeaveStatus;
    studentId?: string;
    classId?: string;
    sectionId?: string;
    from?: string;
    to?: string;
  },
) {
  const and: Record<string, unknown>[] = [await leaveVisibility(ctx)];
  if (q.status) and.push({ status: q.status });
  if (q.studentId) and.push({ studentId: oid(q.studentId) });
  if (q.classId) and.push({ classId: oid(q.classId) });
  if (q.sectionId) and.push({ sectionId: oid(q.sectionId) });
  if (q.from) and.push({ to: { $gte: parseDateOnly(q.from) } });
  if (q.to) and.push({ from: { $lte: parseDateOnly(q.to) } });
  return paginate(LeaveRequest, scope(ctx, { $and: and }), {
    page: q.page,
    limit: q.limit,
    sort: { createdAt: -1 },
    populate: [
      { path: 'studentId', select: 'firstName lastName admissionNo' },
      { path: 'classId', select: 'name' },
      { path: 'sectionId', select: 'name' },
    ],
  });
}

export function getLeave(ctx: SchoolContext, id: string) {
  return findVisible(ctx, id);
}

/** Class teacher's review note. It informs the decision; it is not one. */
export async function reviewLeave(ctx: SchoolContext, id: string, note: string) {
  if (ctx.role !== 'teacher') throw forbidden('Only the class teacher can add a review note');
  const row = await findVisible(ctx, id); // 404 unless they are this section's class teacher
  if (row.status !== 'pending') throw conflict(`This request is already ${row.status}`, undefined, 'LEAVE_NOT_PENDING');
  const updated = await LeaveRequest.findOneAndUpdate(
    scope(ctx, { _id: row._id, status: 'pending' }),
    { $push: { history: event(ctx, { action: 'reviewed', note: note.trim() }) } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict('This request was decided in the meantime', undefined, 'LEAVE_NOT_PENDING');
  await audit(ctx, { action: 'leave.review', entityType: 'LeaveRequest', entityId: row._id });
  return findVisible(ctx, id);
}

export async function decideLeave(ctx: SchoolContext, id: string, decision: 'approve' | 'reject', note?: string) {
  if (!ctx.permissions.has('leave:decide')) throw forbidden('Only school administrators decide leave requests');
  const row = await findVisible(ctx, id);
  if (String(row.requestedBy) === ctx.userId) {
    throw forbidden('You cannot decide on your own request. Another administrator must review it.');
  }
  const status: LeaveStatus = decision === 'approve' ? 'approved' : 'rejected';
  // Atomic claim: of two administrators deciding at once, exactly one wins.
  const updated = await LeaveRequest.findOneAndUpdate(
    scope(ctx, { _id: row._id, status: 'pending', requestedBy: { $ne: oid(ctx.userId) } }),
    {
      $set: {
        status,
        decidedBy: oid(ctx.userId),
        decidedByName: ctx.name,
        decidedAt: new Date(),
        ...(note?.trim() ? { decisionNote: note.trim() } : {}),
      },
      $push: { history: event(ctx, { action: status, note: note?.trim() }) },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!updated)
    throw conflict(
      `This request is already ${
        (
          await LeaveRequest.findOne(scope(ctx, { _id: row._id }))
            .select('status')
            .lean()
        )?.status ?? 'decided'
      }`,
      undefined,
      'LEAVE_NOT_PENDING',
    );
  await audit(ctx, {
    action: `leave.${status}`,
    entityType: 'LeaveRequest',
    entityId: row._id,
    metadata: { note: note?.trim() || undefined },
  });
  await notifyUsers(ctx, [row.requestedBy as Types.ObjectId], {
    title: status === 'approved' ? 'Leave approved' : 'Leave not approved',
    body: `${formatDateOnly(row.from)}${row.days > 1 ? ` to ${formatDateOnly(row.to)}` : ''}${note?.trim() ? `: ${note.trim()}` : ''}`,
    category: 'leave',
    link: `/leave-requests/${row._id}`,
  });
  return findVisible(ctx, id);
}

/** The parent who asked, or a decider, may withdraw a request while it is still pending. */
export async function cancelLeave(ctx: SchoolContext, id: string, note?: string) {
  const row = await findVisible(ctx, id);
  const own = String(row.requestedBy) === ctx.userId;
  if (!own && !ctx.permissions.has('leave:decide'))
    throw forbidden('Only the requester or an administrator can cancel');
  const updated = await LeaveRequest.findOneAndUpdate(
    scope(ctx, { _id: row._id, status: 'pending' }),
    { $set: { status: 'cancelled' }, $push: { history: event(ctx, { action: 'cancelled', note: note?.trim() }) } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated)
    throw conflict(`Only pending requests can be cancelled; this one is ${row.status}`, undefined, 'LEAVE_NOT_PENDING');
  await audit(ctx, { action: 'leave.cancel', entityType: 'LeaveRequest', entityId: row._id });
  return findVisible(ctx, id);
}

/** Students of a section with approved leave covering a date (register hint only). */
export async function approvedLeaveOn(
  ctx: SchoolContext,
  studentIds: Types.ObjectId[],
  day: Date,
): Promise<Set<string>> {
  if (!studentIds.length) return new Set();
  const rows = await LeaveRequest.find(
    scope(ctx, { studentId: { $in: studentIds }, status: 'approved', from: { $lte: day }, to: { $gte: day } }),
  )
    .select('studentId')
    .lean();
  return new Set(rows.map((r) => String(r.studentId)));
}
