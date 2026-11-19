import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { textSearchFilter } from '../../utils/pagination';
import { teacherSectionIds, visibleStudentIds } from '../academics/access.service';
import { Section, TeachingAssignment } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { callHub } from '../calls/calls.hub';
import { notifyUsers } from '../communications/communications.service';
import { Parent, Student } from '../students/student.models';
import { User } from '../users/user.model';
import { Conversation, Message } from './messaging.models';

/**
 * Who may talk to whom:
 * - a teacher: the parents of students in sections they teach (class teacher, subject teacher
 *   or current substitute). They keep reading past conversations, but can only send while
 *   they still teach that student;
 * - a parent: the teachers of their own children, and the school office (Admin, Principal and
 *   Office Administrator accounts with access to the child's campus);
 * - leadership (Admin, Principal, Office Administrator): any student's parents, and they can
 *   read every conversation in the school for safeguarding; they post only in their own.
 * Everything is scoped to the signed-in user's school.
 */
const LEADERSHIP = new Set(['school_owner', 'principal', 'school_admin']);
export const isLeader = (ctx: Pick<SchoolContext, 'role'>) => LEADERSHIP.has(ctx.role);
const name = (s: { firstName: string; lastName?: string | null }) => `${s.firstName} ${s.lastName ?? ''}`.trim();

/** Messages are for teachers, school leadership and parents; everyone else gets 403 on every endpoint. */
export function assertMessagingRole(ctx: SchoolContext) {
  if (ctx.role !== 'parent' && ctx.role !== 'teacher' && !isLeader(ctx)) {
    throw forbidden('Only teachers, school leadership and parents use messages');
  }
}

/**
 * "Rida Javed" → every word must match the first name, last name or admission number, so full
 * names work and single words behave as before. At most 5 words of 50 characters, escaped.
 */
export function studentSearchFilter(q?: string): Record<string, unknown> {
  // Only the per-word part: every word must match one of these fields.
  return textSearchFilter(q, ['firstName', 'lastName', 'admissionNo'])?.$or[0] ?? {};
}

/** Students this staff member may message about (null = any student: leadership). */
async function staffStudentFilter(ctx: SchoolContext): Promise<Record<string, unknown> | null> {
  if (isLeader(ctx)) return null;
  if (ctx.role !== 'teacher') throw forbidden('Only teachers, school leadership and parents use messages');
  const sections = await teacherSectionIds(ctx, 'view');
  return { sectionId: { $in: sections.map(oid) } };
}

export async function assertStaffMayMessage(ctx: SchoolContext, studentId: string | Types.ObjectId) {
  const filter = await staffStudentFilter(ctx);
  const ok = await Student.exists(
    scope(ctx, { _id: oid(String(studentId)), status: { $ne: 'archived' }, ...(filter ?? {}) }),
  );
  if (!ok) throw forbidden('You can only message the parents of students you teach');
}

/** Active staff accounts who teach a section (class teacher and subject teachers). */
export async function teachersOfSection(ctx: SchoolContext, sectionId: Types.ObjectId) {
  const [section, assignments] = await Promise.all([
    Section.findOne(scope(ctx, { _id: sectionId }))
      .select('classTeacherId')
      .lean(),
    TeachingAssignment.find(scope(ctx, { sectionId }))
      .populate('subjectId', 'name')
      .select('teacherId subjectId')
      .lean(),
  ]);
  const roles = new Map<string, string[]>();
  if (section?.classTeacherId) roles.set(String(section.classTeacherId), ['Class teacher']);
  for (const a of assignments) {
    const k = String(a.teacherId);
    roles.set(k, [...(roles.get(k) ?? []), (a.subjectId as { name?: string } | null)?.name ?? 'Subject teacher']);
  }
  const users = await User.find(scope(ctx, { employeeId: { $in: [...roles.keys()].map(oid) }, status: 'active' }))
    .select('_id name employeeId')
    .lean();
  return users.map((u) => ({ userId: u._id.toString(), name: u.name, roles: roles.get(String(u.employeeId)) ?? [] }));
}

const OFFICE_ROLE_LABEL: Record<string, string> = {
  school_admin: 'Office Administrator',
  principal: 'Principal',
  school_owner: 'Admin',
};
const OFFICE_ORDER = ['school_admin', 'principal', 'school_owner'];

/**
 * The school office for a student: active Office Administrator, Principal and Admin accounts
 * whose campus access includes the student's campus (no campus list = every campus), office
 * administrators first.
 */
export async function officeForStudent(ctx: SchoolContext, campusId: Types.ObjectId | string) {
  const users = await User.find(
    scope(ctx, {
      role: { $in: OFFICE_ORDER },
      status: 'active',
      $or: [{ campusIds: { $exists: false } }, { campusIds: { $size: 0 } }, { campusIds: oid(String(campusId)) }],
    }),
  )
    .select('_id name role')
    .lean();
  return users
    .sort((a, b) => OFFICE_ORDER.indexOf(a.role) - OFFICE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name))
    .map((u) => ({ userId: u._id.toString(), name: u.name, roles: [OFFICE_ROLE_LABEL[u.role] ?? 'School office'] }));
}

/** People the signed-in user can start a conversation with. */
export async function contacts(ctx: SchoolContext, q?: string) {
  if (ctx.role === 'parent') {
    const ids = (await visibleStudentIds(ctx)) ?? [];
    const kids = await Student.find(scope(ctx, { _id: { $in: ids.map(oid) }, status: { $ne: 'archived' } }))
      .select('firstName lastName admissionNo sectionId classId campusId')
      .populate('classId', 'name')
      .lean();
    return {
      kind: 'teachers' as const,
      students: await Promise.all(
        kids.map(async (k) => ({
          studentId: k._id.toString(),
          name: name(k),
          admissionNo: k.admissionNo,
          className: (k.classId as { name?: string } | null)?.name ?? null,
          teachers: await teachersOfSection(ctx, k.sectionId),
          office: await officeForStudent(ctx, k.campusId),
          parents: [],
        })),
      ),
    };
  }
  const filter = await staffStudentFilter(ctx);
  const students = await Student.find(
    scope(ctx, {
      status: 'active',
      ...(filter ?? {}),
      ...studentSearchFilter(q),
    }),
  )
    .select('firstName lastName admissionNo classId guardians')
    .populate('classId', 'name')
    .sort({ firstName: 1 })
    .limit(50)
    .lean();
  const parentIds = students.flatMap((s) => s.guardians.map((g) => g.parentId));
  const [parents, logins] = await Promise.all([
    Parent.find(scope(ctx, { _id: { $in: parentIds } }))
      .select('name')
      .lean(),
    User.find(scope(ctx, { parentId: { $in: parentIds }, status: 'active' }))
      .select('_id parentId')
      .lean(),
  ]);
  const parentName = new Map(parents.map((p) => [p._id.toString(), p.name]));
  const loginOf = new Map(logins.map((u) => [String(u.parentId), u._id.toString()]));
  return {
    kind: 'parents' as const,
    students: students.map((s) => ({
      studentId: s._id.toString(),
      name: name(s),
      admissionNo: s.admissionNo,
      className: (s.classId as { name?: string } | null)?.name ?? null,
      teachers: [],
      office: [],
      parents: s.guardians.map((g) => ({
        parentId: g.parentId.toString(),
        name: parentName.get(g.parentId.toString()) ?? 'Parent',
        relation: g.relation,
        // Parents without an active login cannot receive in-app messages.
        userId: loginOf.get(g.parentId.toString()) ?? null,
      })),
    })),
  };
}

type Conv = Awaited<ReturnType<typeof loadConversation>>;

async function loadConversation(ctx: SchoolContext, id: string) {
  const c = await Conversation.findOne(scope(ctx, { _id: oid(id) })).lean();
  if (!c) throw notFound('Conversation');
  const participant = String(c.staffUserId) === ctx.userId || String(c.parentUserId) === ctx.userId;
  if (!participant && !isLeader(ctx)) throw notFound('Conversation');
  return c;
}

const side = (ctx: SchoolContext, c: { parentUserId: unknown }) =>
  String(c.parentUserId) === ctx.userId ? 'parent' : 'staff';

function summary(ctx: SchoolContext, c: Conv) {
  const mine = side(ctx, c);
  const readAt = mine === 'parent' ? c.parentReadAt : c.staffReadAt;
  const participant = String(c.staffUserId) === ctx.userId || String(c.parentUserId) === ctx.userId;
  return {
    _id: c._id.toString(),
    studentId: c.studentId.toString(),
    studentName: c.studentName,
    parentName: c.parentName,
    staffName: c.staffName,
    /** The other participant, from the signed-in user's point of view. */
    withName: mine === 'parent' ? c.staffName : c.parentName,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastMessagePreview: c.lastMessagePreview,
    unread: participant && String(c.lastSenderUserId) !== ctx.userId && (!readAt || readAt < c.lastMessageAt),
    participant,
    /**
     * Whom a call from this conversation would ring (null for oversight). The server resolves
     * and checks the call again when it is placed.
     */
    callTo: !participant
      ? null
      : mine === 'parent'
        ? { type: 'staff' as const, userId: String(c.staffUserId) }
        : { type: 'parent' as const, parentId: String(c.parentId) },
  };
}

export async function listConversations(ctx: SchoolContext, q: { all?: boolean; page: number; limit: number }) {
  assertMessagingRole(ctx);
  const filter =
    q.all && isLeader(ctx) ? {} : { $or: [{ staffUserId: oid(ctx.userId) }, { parentUserId: oid(ctx.userId) }] };
  const [rows, total] = await Promise.all([
    Conversation.find(scope(ctx, filter))
      .sort({ lastMessageAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    Conversation.countDocuments(scope(ctx, filter)),
  ]);
  return {
    items: rows.map((c) => summary(ctx, c)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

export async function unreadCount(ctx: SchoolContext) {
  assertMessagingRole(ctx);
  const me = oid(ctx.userId);
  const rows = await Conversation.find(
    scope(ctx, { $or: [{ staffUserId: me }, { parentUserId: me }], lastSenderUserId: { $ne: me } }),
  )
    .select('parentUserId staffReadAt parentReadAt lastMessageAt')
    .lean();
  return {
    unread: rows.filter((c) => {
      const readAt = String(c.parentUserId) === ctx.userId ? c.parentReadAt : c.staffReadAt;
      return !readAt || readAt < c.lastMessageAt;
    }).length,
  };
}

/** Open a conversation's messages; a participant's view marks it read. */
export async function getConversation(ctx: SchoolContext, id: string, limit = 100) {
  const c = await loadConversation(ctx, id);
  const messages = await Message.find(scope(ctx, { conversationId: c._id }))
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  const participant = String(c.staffUserId) === ctx.userId || String(c.parentUserId) === ctx.userId;
  if (participant) await markRead(ctx, c);
  const otherReadAt = side(ctx, c) === 'parent' ? c.staffReadAt : c.parentReadAt;
  const canSend = participant && (await canSendIn(ctx, c));
  return {
    ...summary(ctx, c),
    unread: false,
    canSend,
    messages: messages.reverse().map((m) => ({
      _id: m._id.toString(),
      body: m.body,
      senderName: m.senderName,
      senderRole: m.senderRole,
      mine: String(m.senderUserId) === ctx.userId,
      createdAt: (m as { createdAt: Date }).createdAt.toISOString(),
      /** For your own messages: whether the other side has read it. */
      readByOther:
        String(m.senderUserId) === ctx.userId &&
        Boolean(otherReadAt && otherReadAt >= (m as { createdAt: Date }).createdAt),
      ...(m.clientMessageId && String(m.senderUserId) === ctx.userId ? { clientMessageId: m.clientMessageId } : {}),
    })),
  };
}

async function markRead(ctx: SchoolContext, c: Conv) {
  const field = side(ctx, c) === 'parent' ? 'parentReadAt' : 'staffReadAt';
  const readBefore = c[field] as Date | undefined;
  // Something from the other person was unread until now (not merely "opened again").
  const newlyRead =
    Boolean(c.lastSenderUserId) &&
    String(c.lastSenderUserId) !== ctx.userId &&
    (!readBefore || (c.lastMessageAt && readBefore < c.lastMessageAt));
  await Conversation.updateOne(scope(ctx, { _id: c._id }), { $set: { [field]: new Date() } });
  // The writer's "Seen" ticks and every device's unread badge update without a reload. Only on a
  // real change: viewing is what marks read, so an event per view would bounce between devices.
  if (newlyRead) liveToParticipants(ctx, c, { type: 'message.read', conversationId: c._id.toString() });
}

/** Tell both people's open devices that a conversation changed; they fetch it through the API. */
function liveToParticipants(ctx: SchoolContext, c: Conv, event: { type: string; conversationId: string }) {
  for (const u of new Set([String(c.staffUserId), String(c.parentUserId)]))
    callHub.toUserDevices(ctx.schoolId, u, event);
}

export async function markConversationRead(ctx: SchoolContext, id: string) {
  const c = await loadConversation(ctx, id);
  if (String(c.staffUserId) !== ctx.userId && String(c.parentUserId) !== ctx.userId) throw forbidden();
  await markRead(ctx, c);
}

/** The staff side may only keep writing while they are still allowed to message this student. */
async function canSendIn(ctx: SchoolContext, c: Conv) {
  if (String(c.parentUserId) === ctx.userId) return true;
  if (String(c.staffUserId) !== ctx.userId) return false;
  try {
    await assertStaffMayMessage(ctx, c.studentId);
    return true;
  } catch {
    return false;
  }
}

async function addMessage(ctx: SchoolContext, c: Conv, body: string, clientMessageId?: string) {
  const text = body.trim();
  if (!text) throw badRequest('Write a message', { field: 'body' });
  // A retry of a message that was saved (the answer was lost): nothing new is written or sent.
  const sameMessage = { conversationId: c._id, senderUserId: oid(ctx.userId), clientMessageId };
  if (clientMessageId) {
    const earlier = await Message.findOne(scope(ctx, sameMessage)).lean();
    if (earlier) return earlier;
  }
  let msg;
  try {
    msg = await Message.create({
      schoolId: ctx.schoolId,
      conversationId: c._id,
      senderUserId: ctx.userId,
      senderName: ctx.name,
      senderRole: ctx.role,
      body: text,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  } catch (err) {
    // Two copies of the same retry at once: the unique index keeps one.
    if ((err as { code?: number }).code === 11000 && clientMessageId) {
      const earlier = await Message.findOne(scope(ctx, sameMessage)).lean();
      if (earlier) return earlier;
    }
    throw err;
  }
  const now = (msg as unknown as { createdAt: Date }).createdAt;
  const readField = side(ctx, c) === 'parent' ? 'parentReadAt' : 'staffReadAt';
  await Conversation.updateOne(scope(ctx, { _id: c._id }), {
    $set: {
      lastMessageAt: now,
      lastMessagePreview: text.slice(0, 140),
      lastSenderUserId: oid(ctx.userId),
      [readField]: now,
    },
  });
  // Notify the other participant (in-app; the notification links to the conversation).
  const recipient = String(c.parentUserId) === ctx.userId ? c.staffUserId : c.parentUserId;
  await notifyUsers(ctx, [recipient], {
    title: `New message from ${ctx.name}`,
    body: `About ${c.studentName}: ${text.slice(0, 160)}`,
    category: 'message',
    link: `/messages/${c._id.toString()}`,
    data: { conversationId: c._id.toString() },
  });
  liveToParticipants(ctx, c, { type: 'message.new', conversationId: c._id.toString() });
  return msg;
}

export async function sendMessage(ctx: SchoolContext, id: string, body: string, clientMessageId?: string) {
  const c = await loadConversation(ctx, id);
  if (String(c.staffUserId) !== ctx.userId && String(c.parentUserId) !== ctx.userId)
    throw forbidden('Only the two people in a conversation can write in it');
  if (!(await canSendIn(ctx, c)))
    throw forbidden('You no longer teach this student, so you cannot send new messages here');
  await addMessage(ctx, c, body, clientMessageId);
  return getConversation(ctx, id);
}

/**
 * Start (or continue) a conversation about a student. Staff choose one of the student's
 * parents; a parent chooses one of their child's teachers.
 */
export async function startConversation(
  ctx: SchoolContext,
  input: { studentId: string; parentId?: string; teacherUserId?: string; body: string; clientMessageId?: string },
) {
  const student = await Student.findOne(scope(ctx, { _id: oid(input.studentId) }))
    .select('firstName lastName sectionId campusId guardians status')
    .lean();
  if (!student) throw notFound('Student');
  let parentId: Types.ObjectId;
  let parentUserId: Types.ObjectId;
  let staffUserId: Types.ObjectId;
  if (ctx.role === 'parent') {
    if (!ctx.parentId || !student.guardians.some((g) => String(g.parentId) === ctx.parentId)) throw notFound('Student');
    if (!input.teacherUserId) throw badRequest('Choose a teacher', { field: 'teacherUserId' });
    const [teachers, office] = await Promise.all([
      teachersOfSection(ctx, student.sectionId),
      officeForStudent(ctx, student.campusId),
    ]);
    if (![...teachers, ...office].some((t) => t.userId === input.teacherUserId))
      throw forbidden("You can only message your child's teachers or the school office");
    parentId = oid(ctx.parentId);
    parentUserId = oid(ctx.userId);
    staffUserId = oid(input.teacherUserId);
  } else {
    await assertStaffMayMessage(ctx, student._id);
    const guardian = input.parentId
      ? student.guardians.find((g) => String(g.parentId) === input.parentId)
      : (student.guardians.find((g) => g.isPrimary) ?? student.guardians[0]);
    if (!guardian) throw badRequest('This parent is not a guardian of the student', { field: 'parentId' });
    const login = await User.findOne(scope(ctx, { parentId: guardian.parentId, status: 'active' }))
      .select('_id')
      .lean();
    if (!login)
      throw conflict(
        'This parent has no active app account yet, so they cannot receive messages. Send them their activation link first.',
        undefined,
        'NO_PARENT_LOGIN',
      );
    parentId = guardian.parentId;
    parentUserId = login._id;
    staffUserId = oid(ctx.userId);
  }
  const [parent, staff] = await Promise.all([
    Parent.findOne(scope(ctx, { _id: parentId }))
      .select('name')
      .lean(),
    User.findOne(scope(ctx, { _id: staffUserId }))
      .select('name employeeId')
      .lean(),
  ]);
  if (!staff) throw notFound('Teacher');
  const key = { studentId: student._id, parentUserId, staffUserId };
  let conv: Conv | null = await Conversation.findOne(scope(ctx, key)).lean();
  if (!conv) {
    try {
      const created = await Conversation.create({
        schoolId: ctx.schoolId,
        ...key,
        parentId,
        staffName: staff.name,
        parentName: parent?.name ?? 'Parent',
        studentName: name(student),
        startedBy: ctx.userId,
        lastMessageAt: new Date(),
      });
      conv = created.toObject() as unknown as Conv;
      await audit(ctx, {
        action: 'conversation.started',
        entityType: 'Conversation',
        entityId: created._id,
        summary: `${staff.name} ↔ ${parent?.name ?? 'Parent'} about ${name(student)}`,
      });
    } catch (err) {
      // Two clicks at once: the unique index keeps one conversation; use it.
      if ((err as { code?: number }).code !== 11000) throw err;
      conv = await Conversation.findOne(scope(ctx, key)).lean();
    }
  }
  await addMessage(ctx, conv!, input.body, input.clientMessageId);
  return getConversation(ctx, conv!._id.toString());
}
