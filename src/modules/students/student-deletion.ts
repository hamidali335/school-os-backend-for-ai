import type { Types } from 'mongoose';
import { deleteFile } from '../../services/storage';
import { atomic } from '../../database/transactions';
import type { SchoolContext } from '../../types/context';
import { conflict, notFound } from '../../utils/errors';
import { assertCampusAccess, campusScope, oid, scope } from '../../utils/tenant';
import { Inquiry } from '../admissions/inquiry.model';
import { AttendanceRecord } from '../attendance/attendance.model';
import { audit } from '../audit/audit.service';
import { revokeAllForSubject } from '../auth/tokens';
import { Certificate, FileObject } from '../certificates/files.model';
import { Mark } from '../examinations/exam.models';
import { Invoice, Payment } from '../fees/fees.models';
import { HomeworkSubmission } from '../homework/homework.models';
import { AccountToken, User } from '../users/user.model';
import { Parent, Student, StudentEnrollment } from './student.models';
import { recordChange } from '../sync/sync.service';

/**
 * Permanent deletion is for student records entered by mistake. Once the student's or a
 * parent's portal account has been used, or money has been received or a certificate issued,
 * the record has real history and must be archived instead.
 *
 * Everything entered together with the mistaken record (unpaid invoices, attendance, marks,
 * homework submissions, documents, unused logins, and a parent record created only for this
 * student) is removed with it. The admin sees exactly what will be removed before confirming.
 */
export type StudentDeletionCheck = {
  canDelete: boolean;
  blockers: Array<{ kind: string; count: number; label: string }>;
  willRemove: {
    invoices: number;
    attendanceRecords: number;
    marks: number;
    homeworkSubmissions: number;
    documents: number;
    logins: string[];
    parentRecords: string[];
  };
};

const used = (u: { lastLoginAt?: Date | null; activatedAt?: Date | null }) => Boolean(u.lastLoginAt || u.activatedAt);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function load(ctx: SchoolContext, id: string) {
  const student = await Student.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) })).lean();
  if (!student) throw notFound('Student');
  assertCampusAccess(ctx, student.campusId);
  const parentIds = student.guardians.map((g) => g.parentId);
  const [studentLogin, parents] = await Promise.all([
    User.findOne(scope(ctx, { studentId: student._id }))
      .select('_id email username lastLoginAt activatedAt')
      .lean(),
    Parent.find(scope(ctx, { _id: { $in: parentIds } }))
      .select('_id name')
      .lean(),
  ]);
  // A parent record goes with the student only if it belongs to no other student.
  const ownParents: Array<{ _id: Types.ObjectId; name: string }> = [];
  for (const p of parents) {
    const sibling = await Student.exists(scope(ctx, { 'guardians.parentId': p._id, _id: { $ne: student._id } }));
    if (!sibling) ownParents.push(p);
  }
  const parentLogins = await User.find(scope(ctx, { parentId: { $in: parentIds } }))
    .select('_id parentId email username lastLoginAt activatedAt')
    .lean();
  return { student, studentLogin, parentLogins, ownParents };
}

export async function checkStudentDeletion(ctx: SchoolContext, id: string): Promise<StudentDeletionCheck> {
  const { student, studentLogin, parentLogins, ownParents } = await load(ctx, id);
  const s = student._id;
  const [payments, certificates, invoices, attendance, marks, submissions, documents] = await Promise.all([
    Payment.countDocuments(scope(ctx, { studentId: s })),
    Certificate.countDocuments(scope(ctx, { studentId: s })),
    Invoice.countDocuments(scope(ctx, { studentId: s })),
    AttendanceRecord.countDocuments(scope(ctx, { studentId: s })),
    Mark.countDocuments(scope(ctx, { studentId: s })),
    HomeworkSubmission.countDocuments(scope(ctx, { studentId: s })),
    FileObject.countDocuments(scope(ctx, { studentId: s })),
  ]);

  const blockers: StudentDeletionCheck['blockers'] = [];
  if (studentLogin && used(studentLogin))
    blockers.push({ kind: 'student_login_used', count: 1, label: "the student's portal account has been activated" });
  const usedParentLogins = parentLogins.filter(used).length;
  if (usedParentLogins)
    blockers.push({
      kind: 'parent_login_used',
      count: usedParentLogins,
      label: "a parent's portal account has been activated",
    });
  if (payments)
    blockers.push({ kind: 'payments', count: payments, label: plural(payments, 'fee payment') + ' received' });
  if (certificates)
    blockers.push({
      kind: 'certificates',
      count: certificates,
      label: plural(certificates, 'certificate') + ' issued',
    });

  const ownParentIds = new Set(ownParents.map((p) => p._id.toString()));
  const removableLogins = [
    ...(studentLogin ? [studentLogin] : []),
    ...parentLogins.filter((l) => l.parentId && ownParentIds.has(l.parentId.toString())),
  ];
  return {
    canDelete: blockers.length === 0,
    blockers,
    willRemove: {
      invoices,
      attendanceRecords: attendance,
      marks,
      homeworkSubmissions: submissions,
      documents,
      logins: removableLogins.map((l) => l.email ?? l.username ?? 'login'),
      parentRecords: ownParents.map((p) => p.name),
    },
  };
}

export async function deleteStudent(ctx: SchoolContext, id: string, reason: string) {
  const check = await checkStudentDeletion(ctx, id);
  if (!check.canDelete) {
    throw conflict(
      `This student has history (${check.blockers.map((b) => b.label).join(', ')}). Archive the student instead.`,
      check.blockers.map((b) => ({ path: b.kind, message: b.label })),
      'IN_USE',
    );
  }
  const { student, studentLogin, parentLogins, ownParents } = await load(ctx, id);
  const ownParentIds = ownParents.map((p) => p._id);
  const loginIds = [
    ...(studentLogin ? [studentLogin._id] : []),
    ...parentLogins.filter((l) => l.parentId && ownParentIds.some((p) => p.equals(l.parentId!))).map((l) => l._id),
  ];

  const files = await FileObject.find(scope(ctx, { studentId: student._id }))
    .select('storageKey')
    .lean();

  await atomic(async () => {
    // Remove access first, so a half-finished delete can never leave a working login behind.
    for (const uid of loginIds) {
      await User.updateOne(scope(ctx, { _id: uid }), { $set: { status: 'disabled' }, $inc: { tokenVersion: 1 } });
      await revokeAllForSubject('user', uid.toString(), 'student_deleted');
    }

    await StudentEnrollment.deleteMany(scope(ctx, { studentId: student._id }));
    await Invoice.deleteMany(scope(ctx, { studentId: student._id }));
    await AttendanceRecord.deleteMany(scope(ctx, { studentId: student._id }));
    await Mark.deleteMany(scope(ctx, { studentId: student._id }));
    await HomeworkSubmission.deleteMany(scope(ctx, { studentId: student._id }));
    await FileObject.deleteMany(scope(ctx, { studentId: student._id }));
    // An inquiry converted into this student goes back to "offered" so admissions history stays.
    await Inquiry.updateMany(scope(ctx, { convertedStudentId: student._id }), {
      $set: { stage: 'offered' },
      $unset: { convertedStudentId: 1 },
    });

    if (loginIds.length) {
      await AccountToken.deleteMany(scope(ctx, { userId: { $in: loginIds } }));
      await User.deleteMany(scope(ctx, { _id: { $in: loginIds } }));
    }
    if (ownParentIds.length) await Parent.deleteMany(scope(ctx, { _id: { $in: ownParentIds } }));
    await Student.deleteOne(scope(ctx, { _id: student._id }));

    await recordChange(
      ctx.schoolId,
      'STUDENT',
      student._id.toString(),
      'DELETE',
      1,
      { id: student._id.toString(), admissionNo: student.admissionNo, isDeleted: true },
      { deleted: true, originDeviceId: 'web_portal' },
    );
  });

  for (const f of files) await deleteFile(f.storageKey).catch(() => undefined);

  await audit(ctx, {
    action: 'student.deleted',
    entityType: 'Student',
    entityId: student._id,
    summary: `${[student.firstName, student.lastName].filter(Boolean).join(' ')} (${student.admissionNo}): ${reason}`,
    metadata: { reason, removed: check.willRemove },
  });
}
