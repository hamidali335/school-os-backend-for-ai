import type { Types } from 'mongoose';
import { ROLE_PERMISSIONS, type SchoolRole } from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { Parent, Student } from '../students/student.models';
import { User } from '../users/user.model';
import {
  assertMessagingRole,
  assertStaffMayMessage,
  isLeader,
  officeForStudent,
  teachersOfSection,
} from '../messaging/messaging.service';

/**
 * Who may call whom. Calls follow exactly the messaging relationships
 * (src/modules/messaging/messaging.service.ts), resolved from the database on every call:
 * - school leadership → any parent of any student of their school;
 * - a teacher → the parents of students in sections they teach (class, subject, substitute);
 * - a parent → their own child's teachers, a named member of the school office, or "the
 *   school office" (every eligible office account rings; the first to answer takes it).
 * Nothing the client sends (school, role, names, user ids of other people) is trusted: the
 * caller comes from the verified session and the recipients from these relationships.
 */
export type CallTarget = { type: 'parent'; parentId?: string } | { type: 'staff'; userId: string } | { type: 'office' };

export interface ResolvedCall {
  kind: 'direct' | 'office';
  studentId: Types.ObjectId;
  studentName: string;
  parentId: Types.ObjectId;
  parentUserId: Types.ObjectId;
  /** Set for direct calls; office calls get it from whoever answers. */
  staffUserId?: Types.ObjectId;
  ringUserIds: Types.ObjectId[];
  calleeName: string;
  calleeRole: string;
}

const fullName = (s: { firstName: string; lastName?: string | null }) => `${s.firstName} ${s.lastName ?? ''}`.trim();

export async function resolveCall(ctx: SchoolContext, studentId: string, to: CallTarget): Promise<ResolvedCall> {
  assertMessagingRole(ctx);
  const student = await Student.findOne(scope(ctx, { _id: oid(studentId), status: { $ne: 'archived' } }))
    .select('firstName lastName sectionId campusId guardians')
    .lean();
  if (!student) throw notFound('Student');
  const studentName = fullName(student);

  if (ctx.role === 'parent') {
    // Only for their own children; anything else looks like a student that does not exist.
    if (!ctx.parentId || !student.guardians.some((g) => String(g.parentId) === ctx.parentId)) throw notFound('Student');
    const base = { studentId: student._id, studentName, parentId: oid(ctx.parentId), parentUserId: oid(ctx.userId) };
    if (to.type === 'office') {
      const office = await officeForStudent(ctx, student.campusId);
      if (!office.length) throw conflict('Nobody at the school office can take calls yet.', undefined, 'NO_RECIPIENT');
      return {
        ...base,
        kind: 'office',
        ringUserIds: office.map((o) => oid(o.userId)),
        calleeName: 'School office',
        calleeRole: 'School office',
      };
    }
    if (to.type !== 'staff') throw badRequest('Choose a teacher or the school office', { field: 'to' });
    const [teachers, office] = await Promise.all([
      teachersOfSection(ctx, student.sectionId),
      officeForStudent(ctx, student.campusId),
    ]);
    const pick = [...teachers, ...office].find((t) => t.userId === to.userId);
    if (!pick) throw forbidden("You can only call your child's teachers or the school office");
    return {
      ...base,
      kind: 'direct',
      staffUserId: oid(pick.userId),
      ringUserIds: [oid(pick.userId)],
      calleeName: pick.name,
      calleeRole: pick.roles.join(', ') || 'Teacher',
    };
  }

  // Staff (teacher or leadership) calling a parent of a student they may contact.
  if (to.type !== 'parent') throw badRequest('Staff call a parent of the student', { field: 'to' });
  await assertStaffMayMessage(ctx, student._id);
  const guardian = to.parentId
    ? student.guardians.find((g) => String(g.parentId) === to.parentId)
    : (student.guardians.find((g) => g.isPrimary) ?? student.guardians[0]);
  if (!guardian) throw badRequest('This parent is not a guardian of the student', { field: 'to.parentId' });
  const [login, parent] = await Promise.all([
    User.findOne(scope(ctx, { parentId: guardian.parentId, role: 'parent', status: 'active' }))
      .select('_id')
      .lean(),
    Parent.findOne(scope(ctx, { _id: guardian.parentId }))
      .select('name')
      .lean(),
  ]);
  if (!login)
    throw conflict(
      'This parent has no active app account yet, so they cannot receive calls.',
      undefined,
      'NO_PARENT_LOGIN',
    );
  if (String(login._id) === ctx.userId) throw badRequest('You cannot call yourself');
  return {
    kind: 'direct',
    studentId: student._id,
    studentName,
    parentId: guardian.parentId,
    parentUserId: login._id,
    staffUserId: oid(ctx.userId),
    ringUserIds: [login._id],
    calleeName: parent?.name ?? 'Parent',
    calleeRole: 'Parent',
  };
}

/** The target a stored call was resolved from, to resolve it again later. */
export function targetOf(call: {
  kind: string;
  callerUserId: Types.ObjectId;
  parentUserId: Types.ObjectId;
  parentId: Types.ObjectId;
  staffUserId?: Types.ObjectId | null;
}): CallTarget {
  if (call.kind === 'office') return { type: 'office' };
  if (String(call.callerUserId) === String(call.parentUserId))
    return { type: 'staff', userId: String(call.staffUserId) };
  return { type: 'parent', parentId: String(call.parentId) };
}

/**
 * The caller's current context, rebuilt from the database (for re-checking a call when it is
 * answered). Null when the caller's account is no longer active.
 */
export async function contextForUser(schoolId: string, userId: Types.ObjectId | string): Promise<SchoolContext | null> {
  const u = await User.findOne({ _id: oid(String(userId)), schoolId: oid(schoolId) })
    .select('name role status campusIds employeeId parentId')
    .lean();
  if (!u || u.status !== 'active') return null;
  const role = u.role as SchoolRole;
  if (!ROLE_PERMISSIONS[role]?.has('calls:use')) return null;
  return {
    kind: 'school',
    userId: String(u._id),
    schoolId,
    role,
    name: u.name,
    email: '',
    campusIds: (u.campusIds ?? []).map(String),
    permissions: ROLE_PERMISSIONS[role],
    entitlements: new Set(),
    subscriptionEligible: true,
    employeeId: u.employeeId ? String(u.employeeId) : undefined,
    parentId: u.parentId ? String(u.parentId) : undefined,
  };
}

/**
 * Is `answeringUserId` still a valid recipient of this call? Re-resolves it from the caller's
 * current relationships: a teacher who no longer teaches the student, a guardian link that was
 * removed, an office member who lost campus access or a disabled caller all fail.
 */
export async function stillAuthorized(
  schoolId: string,
  call: Parameters<typeof targetOf>[0] & { studentId: Types.ObjectId },
  answeringUserId: string,
): Promise<boolean> {
  const caller = await contextForUser(schoolId, call.callerUserId);
  if (!caller) return false;
  try {
    const again = await resolveCall(caller, String(call.studentId), targetOf(call));
    return again.ringUserIds.some((u) => String(u) === answeringUserId);
  } catch {
    return false;
  }
}

export { isLeader };
