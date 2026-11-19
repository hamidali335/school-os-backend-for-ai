import type { Types } from 'mongoose';
import type { SchoolContext, SystemContext } from '../../types/context';
import { unprocessable } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { SchoolClass, Section, TeachingAssignment } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { Homework } from './homework.models';

/*
 * Homework teacher rules (documented in docs/HOMEWORK_TEACHER_RULES.md):
 *
 * 1. A teacher who sets homework is its teacher (source `creator`), including a substitute
 *    covering the class (the cover is recorded in `createdViaSubstituteId`).
 * 2. An administrator may pick the teacher explicitly (`explicit`); the teacher must teach that
 *    subject in that section, or be the section's class teacher.
 * 3. Otherwise the subject teacher of that section is used (`assignment`). There is at most one:
 *    a unique index on (section, subject) makes "several teachers for one class-subject"
 *    impossible, so no arbitrary choice is ever made.
 * 4. If there is no subject teacher, the API refuses (TEACHER_NOT_ASSIGNED) unless the
 *    administrator chose a teacher or explicitly saved it unassigned.
 * 5. When a subject teacher is assigned later, homework of that class-subject that has no
 *    teacher is attributed to them (`backfill`). Homework that already has a teacher keeps it:
 *    historical attribution is never rewritten when the subject's teacher changes. The current
 *    subject teacher is returned separately, and access to manage/grade always follows the
 *    current teaching assignment.
 */

type Actor = SchoolContext | SystemContext;
type Person = { _id: Types.ObjectId; firstName: string; lastName?: string | null; employeeNo?: string };

export const personRef = (p: Person | null | undefined) =>
  p ? { _id: p._id, name: `${p.firstName} ${p.lastName ?? ''}`.trim(), employeeNo: p.employeeNo } : null;

/** The class-subject teacher of a section today (null if nobody is assigned). */
export async function subjectTeacherOf(
  actor: Actor,
  sectionId: string | Types.ObjectId,
  subjectId: string | Types.ObjectId,
) {
  const ta = await TeachingAssignment.findOne(scope(actor, { sectionId: oid(sectionId), subjectId: oid(subjectId) }))
    .select('teacherId')
    .lean();
  return ta?.teacherId ?? null;
}

/** An explicitly chosen teacher must actually teach this class-subject (or be the class teacher). */
export async function assertTeacherEligible(
  ctx: SchoolContext,
  sectionId: Types.ObjectId,
  subjectId: Types.ObjectId,
  teacherId: string,
) {
  const emp = await Employee.findOne(scope(ctx, { _id: oid(teacherId) }))
    .select('staffType status')
    .lean();
  if (!emp || emp.staffType !== 'teaching' || !['active', 'on_leave'].includes(emp.status))
    throw unprocessable('Choose an active teacher from this school', { field: 'teacherId' }, 'TEACHER_NOT_ELIGIBLE');
  const [teaches, classTeacher] = await Promise.all([
    TeachingAssignment.exists(scope(ctx, { sectionId, subjectId, teacherId: emp._id })),
    Section.exists(scope(ctx, { _id: sectionId, classTeacherId: emp._id })),
  ]);
  if (!teaches && !classTeacher)
    throw unprocessable(
      'This teacher does not teach this subject in this class. Assign them in Classes & subjects first, or choose the assigned teacher.',
      { field: 'teacherId' },
      'TEACHER_NOT_ELIGIBLE',
    );
}

/**
 * Adds `teacher` (attributed, or resolved from the current assignment when the record has
 * none), `teacherStatus` and `currentSubjectTeacher` to homework rows. One query per batch.
 */
export async function withTeacherInfo<T extends { sectionId: unknown; subjectId: unknown; teacherId?: unknown }>(
  actor: Actor,
  rows: T[],
) {
  const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v);
  const pairs = rows.map((r) => ({ sectionId: oid(idOf(r.sectionId)), subjectId: oid(idOf(r.subjectId)) }));
  const assignments = pairs.length
    ? await TeachingAssignment.find(scope(actor, { $or: pairs }))
        .select('sectionId subjectId teacherId')
        .populate('teacherId', 'firstName lastName employeeNo')
        .lean()
    : [];
  const current = new Map(
    assignments.map((a) => [`${a.sectionId}:${a.subjectId}`, personRef(a.teacherId as unknown as Person)]),
  );
  // The class name of each populated section, as an extra field (sectionId.classId stays an id).
  const classIds = [
    ...new Set(
      rows
        .map((r) => (r.sectionId as { classId?: unknown } | null)?.classId)
        .filter(Boolean)
        .map((c) => String(c)),
    ),
  ];
  const classes = classIds.length
    ? await SchoolClass.find(scope(actor, { _id: { $in: classIds.map(oid) } }))
        .select('name')
        .lean()
    : [];
  const classNames = new Map(classes.map((c) => [String(c._id), c.name as string]));
  return rows.map((r) => {
    const attributed =
      r.teacherId && typeof r.teacherId === 'object' && 'firstName' in r.teacherId
        ? personRef(r.teacherId as Person)
        : null;
    const currentSubjectTeacher = current.get(`${idOf(r.sectionId)}:${idOf(r.subjectId)}`) ?? null;
    const teacher = attributed ?? currentSubjectTeacher;
    const classId = (r.sectionId as { classId?: unknown } | null)?.classId;
    return {
      ...r,
      className: classId ? classNames.get(String(classId)) : undefined,
      teacher,
      teacherStatus: attributed ? 'attributed' : currentSubjectTeacher ? 'from_current_assignment' : 'unassigned',
      currentSubjectTeacher,
    };
  });
}

/**
 * A teacher was assigned to a class-subject: attribute that class-subject's homework that has
 * no teacher yet. Homework that already has a teacher is left untouched (rule 5).
 */
export async function backfillHomeworkTeacher(
  ctx: SchoolContext,
  sectionId: string | Types.ObjectId,
  subjectId: string | Types.ObjectId,
  teacherId: string | Types.ObjectId,
) {
  const res = await Homework.updateMany(
    scope(ctx, {
      sectionId: oid(sectionId),
      subjectId: oid(subjectId),
      $or: [{ teacherId: { $exists: false } }, { teacherId: null }],
    }),
    { $set: { teacherId: oid(teacherId), teacherSource: 'backfill' } },
  );
  if (res.modifiedCount)
    await audit(ctx, {
      action: 'homework.teacher_backfilled',
      entityType: 'TeachingAssignment',
      metadata: {
        sectionId: String(sectionId),
        subjectId: String(subjectId),
        teacherId: String(teacherId),
        count: res.modifiedCount,
      },
    });
  return res.modifiedCount;
}
