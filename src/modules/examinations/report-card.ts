import type { SchoolContext } from '../../types/context';
import { formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, forbidden, notFound } from '../../utils/errors';
import { findOwned, oid, scope } from '../../utils/tenant';
import { assertSectionAccess, teacherSectionIds, visibleStudentIds } from '../academics/access.service';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { AttendanceRecord, type AttendanceStatus } from '../attendance/attendance.model';
import { countStatuses } from '../attendance/attendance-stats';
import { DEFAULT_GRADING_SCALE, School } from '../schools/school.model';
import { Parent, Student, StudentEnrollment } from '../students/student.models';
import { Exam, Mark } from './exam.models';
import { sectionResults } from './exams.service';

type Ctx = SchoolContext;

/**
 * Everything a printed result card shows, assembled once on the server so the screen and the
 * PDF always agree. Totals, percentages, grades, pass/fail and positions come from
 * result-calc (the same numbers as the section result sheet); nothing is recalculated here.
 */
export async function reportCardsForSection(ctx: Ctx, examId: string, sectionId: string, onlyStudentId?: string) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  const section = await findOwned(Section, ctx, sectionId, 'Section');
  const results = await sectionResults(ctx, examId, sectionId);
  const rows = onlyStudentId ? results.results.filter((r) => r.studentId === onlyStudentId) : results.results;
  if (!rows.length) throw notFound('Result');

  const [school, cls, session, students, subjectRemarks] = await Promise.all([
    School.findById(ctx.schoolId).select('name settings.timezone settings.gradingScale settings.passPercent').lean(),
    SchoolClass.findOne(scope(ctx, { _id: section.classId }))
      .select('name')
      .lean(),
    AcademicSession.findOne(scope(ctx, { _id: exam.sessionId }))
      .select('name startDate endDate')
      .lean(),
    Student.find(scope(ctx, { _id: { $in: rows.map((r) => oid(r.studentId)) } }))
      .select('firstName lastName admissionNo rollNo dateOfBirth guardians')
      .lean(),
    Mark.find(
      scope(ctx, {
        examId: exam._id,
        studentId: { $in: rows.map((r) => oid(r.studentId)) },
        remarks: { $nin: [null, ''] },
      }),
    )
      .select('studentId paperId remarks')
      .lean(),
  ]);
  const studentById = new Map(students.map((s) => [s._id.toString(), s]));
  const primaryParentIds = students
    .map((s) => (s.guardians.find((g) => g.isPrimary) ?? s.guardians[0])?.parentId)
    .filter(Boolean);
  const parents = await Parent.find(scope(ctx, { _id: { $in: primaryParentIds } }))
    .select('name relation')
    .lean();
  const parentById = new Map(parents.map((p) => [p._id.toString(), p]));
  const remarkByKey = new Map(subjectRemarks.map((m) => [`${m.studentId}:${m.paperId}`, m.remarks as string]));

  // Attendance for the session up to the end of the exam (or today, if earlier).
  const tz = school?.settings?.timezone ?? 'Asia/Karachi';
  const today = parseDateOnly(todayInTz(tz));
  const until = [exam.endDate, session?.endDate, today].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0]!;
  const attendance = session
    ? await AttendanceRecord.find(
        scope(ctx, {
          studentId: { $in: rows.map((r) => oid(r.studentId)) },
          date: { $gte: session.startDate, $lte: until },
        }),
      )
        .select('studentId status')
        .lean()
    : [];
  const attendanceBy = new Map<string, AttendanceStatus[]>();
  for (const a of attendance)
    attendanceBy.set(a.studentId.toString(), [
      ...(attendanceBy.get(a.studentId.toString()) ?? []),
      a.status as AttendanceStatus,
    ]);

  const gradingScale = school?.settings?.gradingScale?.length ? school.settings.gradingScale : DEFAULT_GRADING_SCALE;
  const published = exam.status === 'published';
  return rows.map((r) => {
    const st = studentById.get(r.studentId);
    const guardianRef = st ? (st.guardians.find((g) => g.isPrimary) ?? st.guardians[0]) : undefined;
    const guardian = guardianRef ? parentById.get(guardianRef.parentId.toString()) : undefined;
    const counts = countStatuses(attendanceBy.get(r.studentId) ?? []);
    return {
      published,
      exam: {
        _id: exam._id.toString(),
        name: exam.name,
        term: exam.term,
        status: exam.status,
        startDate: exam.startDate ? formatDateOnly(exam.startDate) : null,
        endDate: exam.endDate ? formatDateOnly(exam.endDate) : null,
      },
      session: session ? { name: session.name } : null,
      student: {
        _id: r.studentId,
        name: r.name,
        admissionNo: r.admissionNo,
        rollNo: r.rollNo ?? null,
        guardianName: guardian?.name ?? null,
        guardianRelation: guardianRef?.relation ?? guardian?.relation ?? null,
        dateOfBirth: st?.dateOfBirth ? formatDateOnly(st.dateOfBirth) : null,
        className: cls?.name ?? null,
        sectionName: section.name,
      },
      result: {
        ...r,
        subjects: r.subjects.map((s) => ({ ...s, remarks: remarkByKey.get(`${r.studentId}:${s.paperId}`) ?? null })),
      },
      position: r.position ?? null,
      sectionSize: results.results.length,
      attendance: {
        from: session ? formatDateOnly(session.startDate) : null,
        to: formatDateOnly(until),
        ...counts,
      },
      classAverages: results.subjects.map((s) => ({
        subject: s.subject,
        averagePercent: (s as { averagePercent?: number }).averagePercent ?? null,
      })),
      gradingScale: gradingScale.map((g) => ({
        grade: g.grade ?? '',
        minPercent: g.minPercent ?? 0,
        remark: g.remark ?? null,
      })),
      passPercent: school?.settings?.passPercent ?? 40,
    };
  });
}

export type ReportCard = Awaited<ReturnType<typeof reportCardsForSection>>[number];

/**
 * Who may see a report card. Families: their own children, published results only. Teachers:
 * their sections. Staff with exams:read: any section, and unpublished results only as a draft
 * (the PDF is watermarked DRAFT).
 */
export async function assertReportCardAccess(ctx: Ctx, examId: string, studentId: string) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  const family = await visibleStudentIds(ctx);
  if (family) {
    if (!family.includes(studentId)) throw notFound('Student');
    if (exam.status !== 'published') throw notFound('Results');
  }
  const student = await findOwned(Student, ctx, studentId, 'Student', 'sectionId');
  const mark = await Mark.findOne(scope(ctx, { examId: exam._id, studentId: student._id })).select('sectionId').lean();
  const enrollment = !mark
    ? await StudentEnrollment.findOne(scope(ctx, { studentId: student._id, sessionId: exam.sessionId }))
        .select('sectionId')
        .lean()
    : null;
  const sectionId = (mark?.sectionId ?? enrollment?.sectionId ?? student.sectionId).toString();
  if (ctx.role === 'teacher') await assertSectionAccess(ctx, sectionId, 'marks');
  return { exam, sectionId };
}

export async function assertSectionCardsAccess(ctx: Ctx, examId: string, sectionId: string) {
  await findOwned(Exam, ctx, examId, 'Exam');
  if (await visibleStudentIds(ctx)) throw forbidden('Families can only open their own children’s result cards');
  if (!ctx.permissions.has('exams:read')) throw forbidden();
  if (ctx.role === 'teacher' && !(await teacherSectionIds(ctx, 'marks')).includes(sectionId))
    throw forbidden('You are not assigned to this section');
  if (!sectionId) throw badRequest('sectionId is required');
}
