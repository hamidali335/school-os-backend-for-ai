import type { SchoolContext, SystemContext } from '../../types/context';
import { formatDateOnly, parseDateOnly } from '../../utils/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors';
import { assertManyRefs, assertRefs, findOwned, oid, scope } from '../../utils/tenant';
import {
  assertSectionAccess,
  assertSubjectAccess,
  teacherSectionIds,
  visibleStudentIds,
} from '../academics/access.service';
import { AcademicSession, SchoolClass, Section, Subject } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { notifyUsers, parentUserIdsForStudents } from '../communications/communications.service';
import { DEFAULT_GRADING_SCALE, School } from '../schools/school.model';
import { Student, StudentEnrollment } from '../students/student.models';
import { Exam, ExamPaper, Mark } from './exam.models';
import { assignPositions, computeStudentResult, subjectStats, type PaperInfo } from './result-calc';
import { publishReadiness } from './result-publication';

type Ctx = SchoolContext;

export async function createExam(
  ctx: Ctx,
  input: { sessionId: string; name: string; term?: string; startDate?: string; endDate?: string; classIds: string[] },
) {
  await assertRefs(ctx, [[AcademicSession, input.sessionId, 'sessionId']]);
  await assertManyRefs(ctx, SchoolClass, input.classIds, 'class');
  const exam = await Exam.create({
    ...input,
    schoolId: ctx.schoolId,
    startDate: input.startDate ? parseDateOnly(input.startDate) : undefined,
    endDate: input.endDate ? parseDateOnly(input.endDate) : undefined,
  });
  await audit(ctx, { action: 'exam.create', entityType: 'Exam', entityId: exam._id });
  return exam.toObject();
}

export interface PaperInput {
  classId: string;
  subjectId: string;
  maxMarks: number;
  passMarks: number;
  date?: string | null;
  startTime?: string | null;
  durationMinutes?: number | null;
}

/** Marks recorded per paper of an exam (papers with marks are protected from removal). */
export async function marksCountByPaper(actor: Ctx | SystemContext, examId: unknown) {
  const rows = await Mark.aggregate([
    { $match: scope(actor, { examId: oid(String(examId)) }) },
    { $group: { _id: '$paperId', count: { $sum: 1 } } },
  ]);
  return new Map<string, number>(rows.map((r) => [String(r._id), r.count as number]));
}

/** Papers of an exam with subject/class names and how many marks each already has. */
export async function papersWithMarks(actor: Ctx | SystemContext, examId: unknown) {
  const [papers, counts] = await Promise.all([
    ExamPaper.find(scope(actor, { examId }))
      .populate('subjectId', 'name code')
      .populate('classId', 'name level')
      .sort({ date: 1, startTime: 1 })
      .lean(),
    marksCountByPaper(actor, examId),
  ]);
  return papers.map((p) => ({ ...p, marksCount: counts.get(p._id.toString()) ?? 0 }));
}

/**
 * Replaces an exam's date sheet (the set of papers). Rules:
 * - A published exam's papers cannot change: parents can see its results, so the exam must be
 *   withdrawn (unpublished) first. This keeps visible results consistent with their papers.
 * - Papers are upserted by (class, subject), so saving twice never duplicates them.
 * - Removing a paper that already has marks is refused (PAPER_HAS_MARKS): marks are never lost
 *   or silently kept behind the user's back. Changing max marks below an entered mark is refused.
 * - Optional `expectedVersion` detects a concurrent edit (STALE_DATE_SHEET) instead of
 *   silently overwriting someone else's changes.
 * - Clearing a date, start time or duration really clears it.
 */
export async function setPapers(ctx: Ctx, examId: string, papers: PaperInput[], expectedVersion?: number) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  if (exam.status === 'published')
    throw conflict(
      'Results of this exam are published. Withdraw (unpublish) the results before changing its papers.',
      undefined,
      'EXAM_PUBLISHED',
    );
  if (expectedVersion !== undefined && expectedVersion !== (exam.datesheetVersion ?? 0))
    throw conflict(
      'Someone else changed this date sheet while you were editing. Reload it and apply your changes again.',
      { currentVersion: exam.datesheetVersion ?? 0 },
      'STALE_DATE_SHEET',
    );
  await assertManyRefs(
    ctx,
    SchoolClass,
    papers.map((p) => p.classId),
    'class',
  );
  await assertManyRefs(
    ctx,
    Subject,
    papers.map((p) => p.subjectId),
    'subject',
  );
  const examClasses = exam.classIds.map(String);
  const startStr = exam.startDate ? formatDateOnly(exam.startDate) : null;
  const endStr = exam.endDate ? formatDateOnly(exam.endDate) : null;
  const existing = await ExamPaper.find(scope(ctx, { examId: exam._id })).lean();
  const existingByKey = new Map(existing.map((e) => [`${e.classId}:${e.subjectId}`, e]));
  const subjects = await Subject.find(scope(ctx, { _id: { $in: papers.map((p) => oid(p.subjectId)) } }))
    .select('name classIds')
    .lean();
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));
  const problems: Array<{ index: number; field: string; message: string }> = [];
  papers.forEach((p, index) => {
    const add = (field: string, message: string) => problems.push({ index, field, message });
    if (!examClasses.includes(p.classId)) add('classId', 'This class is not part of the exam');
    if (p.passMarks > p.maxMarks) add('passMarks', 'Pass marks cannot be more than maximum marks');
    if (p.date && startStr && p.date < startStr) add('date', `The exam starts on ${startStr}`);
    if (p.date && endStr && p.date > endStr) add('date', `The exam ends on ${endStr}`);
    const subj = subjectById.get(p.subjectId);
    const isNew = !existingByKey.has(`${p.classId}:${p.subjectId}`);
    // New papers must be for a subject taught in that class; existing ones are kept as they are.
    if (isNew && subj?.classIds?.length && !subj.classIds.map(String).includes(p.classId))
      add('subjectId', `${subj.name} is not taught in this class`);
  });
  if (problems.length) throw badRequest('Some papers are not valid', problems, 'VALIDATION_ERROR');
  const keys = papers.map((p) => `${p.classId}:${p.subjectId}`);
  if (new Set(keys).size !== keys.length) throw badRequest('The same subject is listed twice for a class');

  // Protect marks: never remove a paper with marks, never cap max marks below an entered mark.
  const counts = await marksCountByPaper(ctx, exam._id);
  const removed = existing.filter((e) => !keys.includes(`${e.classId}:${e.subjectId}`));
  const blocked = removed.filter((e) => (counts.get(e._id.toString()) ?? 0) > 0);
  if (blocked.length) {
    const named = await ExamPaper.find(scope(ctx, { _id: { $in: blocked.map((b) => b._id) } }))
      .populate('subjectId', 'name')
      .populate('classId', 'name')
      .lean();
    throw conflict(
      'Some papers already have marks and cannot be removed. Keep them ticked.',
      named.map((n) => ({
        paperId: n._id.toString(),
        class: (n.classId as any)?.name,
        subject: (n.subjectId as any)?.name,
        marks: counts.get(n._id.toString()) ?? 0,
      })),
      'PAPER_HAS_MARKS',
    );
  }
  for (const p of papers) {
    const prev = existingByKey.get(`${p.classId}:${p.subjectId}`);
    if (!prev || !(counts.get(prev._id.toString()) ?? 0)) continue;
    const top = await Mark.findOne(scope(ctx, { paperId: prev._id, obtained: { $ne: null } }))
      .sort({ obtained: -1 })
      .select('obtained')
      .lean();
    if (top?.obtained != null && top.obtained > p.maxMarks)
      throw conflict(
        `A student already has ${top.obtained} marks in this paper, so maximum marks cannot be ${p.maxMarks}.`,
        { classId: p.classId, subjectId: p.subjectId },
        'MAX_BELOW_ENTERED_MARKS',
      );
  }

  // Claim the edit atomically: fails if the exam was published or edited by someone else since.
  const claimed = await Exam.findOneAndUpdate(
    scope(ctx, {
      _id: exam._id,
      status: { $ne: 'published' },
      ...(expectedVersion !== undefined ? { datesheetVersion: expectedVersion } : {}),
    }),
    { $inc: { datesheetVersion: 1 }, ...(exam.status === 'draft' ? { $set: { status: 'scheduled' } } : {}) },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed)
    throw conflict(
      'The exam changed while you were editing (it may have been published). Reload and try again.',
      undefined,
      'STALE_DATE_SHEET',
    );

  let added = 0;
  let updated = 0;
  for (const p of papers) {
    const set: Record<string, unknown> = {
      maxMarks: p.maxMarks,
      passMarks: p.passMarks,
      classId: oid(p.classId),
      subjectId: oid(p.subjectId),
    };
    const unset: Record<string, 1> = {};
    if (p.date) set.date = parseDateOnly(p.date);
    else unset.date = 1;
    if (p.startTime) set.startTime = p.startTime;
    else unset.startTime = 1;
    if (p.durationMinutes) set.durationMinutes = p.durationMinutes;
    else unset.durationMinutes = 1;
    const prev = existingByKey.get(`${p.classId}:${p.subjectId}`);
    if (prev) {
      const same =
        prev.maxMarks === p.maxMarks &&
        prev.passMarks === p.passMarks &&
        (prev.date ? formatDateOnly(prev.date) : null) === (p.date ?? null) &&
        (prev.startTime ?? null) === (p.startTime ?? null) &&
        (prev.durationMinutes ?? null) === (p.durationMinutes ?? null);
      if (!same) updated++;
    } else added++;
    await ExamPaper.updateOne(
      scope(ctx, { examId: exam._id, classId: oid(p.classId), subjectId: oid(p.subjectId) }),
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  if (removed.length)
    await ExamPaper.deleteMany(
      scope(ctx, {
        examId: exam._id,
        _id: { $in: removed.map((r) => r._id) },
      }),
    );
  await audit(ctx, {
    action: 'exam.papers_set',
    entityType: 'Exam',
    entityId: exam._id,
    summary: `Date sheet saved: ${added} added, ${updated} changed, ${removed.length} removed`,
    metadata: {
      papers: papers.length,
      added,
      updated,
      removed: removed.map((r) => ({ classId: r.classId.toString(), subjectId: r.subjectId.toString() })),
      version: claimed.datesheetVersion,
    },
  });
  return papersWithMarks(ctx, exam._id);
}

async function loadPaper(ctx: Ctx, examId: string, paperId: string) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  const paper = await ExamPaper.findOne(scope(ctx, { _id: oid(paperId), examId: exam._id })).lean();
  if (!paper) throw notFound('Exam paper');
  return { exam, paper };
}

export async function marksRoster(ctx: Ctx, examId: string, paperId: string, sectionId: string) {
  const { paper } = await loadPaper(ctx, examId, paperId);
  const section = await findOwned(Section, ctx, sectionId, 'Section');
  if (section.classId.toString() !== paper.classId.toString()) throw badRequest('Section is not in the paper’s class');
  await assertSubjectAccess(ctx, section._id, paper.subjectId, 'marks');
  const [students, marks] = await Promise.all([
    Student.find(scope(ctx, { sectionId: section._id, status: 'active' }))
      .select('firstName lastName admissionNo rollNo')
      .sort({ rollNo: 1, firstName: 1 })
      .lean(),
    Mark.find(scope(ctx, { paperId: paper._id, sectionId: section._id })).lean(),
  ]);
  const byStudent = new Map(marks.map((m) => [m.studentId.toString(), m]));
  const subject = await Subject.findOne(scope(ctx, { _id: paper.subjectId }))
    .select('isElective')
    .lean();
  return {
    paper: {
      _id: paper._id,
      maxMarks: paper.maxMarks,
      passMarks: paper.passMarks,
      subjectId: paper.subjectId,
      isElective: Boolean(subject?.isElective),
    },
    students: students.map((s) => {
      const m = byStudent.get(s._id.toString());
      return {
        studentId: s._id,
        name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
        admissionNo: s.admissionNo,
        rollNo: s.rollNo,
        obtained: m?.obtained ?? null,
        isAbsent: m?.isAbsent ?? false,
        notTaken: m?.notTaken ?? false,
        remarks: m?.remarks ?? null,
      };
    }),
  };
}

export async function enterMarks(
  ctx: Ctx,
  examId: string,
  paperId: string,
  input: {
    sectionId: string;
    marks: Array<{
      studentId: string;
      obtained?: number | null;
      isAbsent?: boolean;
      notTaken?: boolean;
      remarks?: string;
    }>;
  },
) {
  const { exam, paper } = await loadPaper(ctx, examId, paperId);
  if (exam.status === 'published')
    throw conflict('Results are published; unpublish before changing marks', undefined, 'RESULTS_PUBLISHED');
  const section = await findOwned(Section, ctx, input.sectionId, 'Section');
  if (section.classId.toString() !== paper.classId.toString()) throw badRequest('Section is not in the paper’s class');
  const access = await assertSubjectAccess(ctx, section._id, paper.subjectId, 'marks');
  const ids = input.marks.map((m) => m.studentId);
  if (new Set(ids).size !== ids.length) throw badRequest('Each student may appear only once');
  const enrolledStudentIds = await StudentEnrollment.distinct('studentId', scope(ctx, { sectionId: section._id }));
  const inSection = await Student.countDocuments(
    scope(ctx, {
      _id: { $in: ids.map(oid) },
      $or: [{ sectionId: section._id }, { _id: { $in: enrolledStudentIds } }],
    }),
  );
  if (inSection !== ids.length)
    throw badRequest('Some students are not in this section', undefined, 'INVALID_REFERENCE');
  const elective = Boolean(
    (
      await Subject.findOne(scope(ctx, { _id: paper.subjectId }))
        .select('isElective')
        .lean()
    )?.isElective,
  );
  for (const m of input.marks) {
    if (m.notTaken) {
      if (!elective)
        throw badRequest(
          'Only an elective subject can be marked Not taken',
          { studentId: m.studentId },
          'NOT_ELECTIVE',
        );
      if (m.isAbsent || (m.obtained !== undefined && m.obtained !== null))
        throw badRequest('A student who does not take the subject has no marks and is not absent', {
          studentId: m.studentId,
        });
      continue;
    }
    if (!m.isAbsent && (m.obtained === undefined || m.obtained === null))
      throw badRequest(
        elective
          ? 'Provide obtained marks, isAbsent or notTaken for every student'
          : 'Provide obtained marks or isAbsent for every student',
      );
    if (m.obtained !== undefined && m.obtained !== null && m.obtained > paper.maxMarks) {
      throw unprocessable(`Marks cannot exceed the maximum of ${paper.maxMarks}`, { studentId: m.studentId });
    }
  }
  await Mark.bulkWrite(
    input.marks.map((m) => ({
      updateOne: {
        filter: { schoolId: oid(ctx.schoolId), paperId: paper._id, studentId: oid(m.studentId) },
        update: {
          $set: {
            examId: exam._id,
            sectionId: section._id,
            classId: paper.classId,
            subjectId: paper.subjectId,
            obtained: m.isAbsent || m.notTaken ? null : m.obtained,
            isAbsent: !m.notTaken && !!m.isAbsent,
            notTaken: !!m.notTaken,
            remarks: m.remarks,
            enteredBy: oid(ctx.userId),
          },
        },
        upsert: true,
      },
    })) as any,
  );
  if (exam.status !== 'marks_entry')
    await Exam.updateOne(scope(ctx, { _id: exam._id, status: { $ne: 'published' } }), {
      $set: { status: 'marks_entry' },
    });
  await audit(ctx, {
    action: 'marks.enter',
    entityType: 'ExamPaper',
    entityId: paper._id,
    metadata: {
      sectionId: input.sectionId,
      count: input.marks.length,
      // Who was recorded as not taking the elective, so the decision can be traced.
      ...(input.marks.some((m) => m.notTaken)
        ? { notTaken: input.marks.filter((m) => m.notTaken).map((m) => m.studentId) }
        : {}),
      ...(access.viaSubstitute ? { viaSubstitute: access.viaSubstitute } : {}),
    },
  });
  return { saved: input.marks.length };
}

async function gradingSettings(schoolId: string) {
  const school = await School.findById(schoolId).select('settings.gradingScale settings.passPercent').lean();
  return {
    scale: (school?.settings?.gradingScale?.length ? school.settings.gradingScale : DEFAULT_GRADING_SCALE) as Array<{
      grade: string;
      minPercent: number;
      remark?: string;
    }>,
    passPercent: school?.settings?.passPercent ?? 40,
  };
}

/** Compute results for one section of an exam (all papers of the section's class). */
export async function sectionResults(actor: Ctx | SystemContext, examId: string, sectionId: string) {
  const exam = await findOwned(Exam, actor, examId, 'Exam');
  const section = await findOwned(Section, actor, sectionId, 'Section');
  const [enrolledStudentIds, markStudentIds] = await Promise.all([
    StudentEnrollment.distinct('studentId', scope(actor, { sectionId: section._id })),
    Mark.distinct('studentId', scope(actor, { examId: exam._id, sectionId: section._id })),
  ]);
  const historicalOrCurrent: Array<Record<string, unknown>> = [
    { sectionId: section._id, status: { $in: ['active', 'left', 'graduated'] } },
  ];
  const extraStudentIds = [...new Set([...enrolledStudentIds, ...markStudentIds].map(String))];
  if (extraStudentIds.length) {
    historicalOrCurrent.push({ _id: { $in: extraStudentIds.map(oid) } });
  }
  const [papers, students, marks, grading] = await Promise.all([
    ExamPaper.find(scope(actor, { examId: exam._id, classId: section.classId }))
      .populate('subjectId', 'name isElective')
      .lean(),
    Student.find(scope(actor, { $or: historicalOrCurrent }))
      .select('firstName lastName admissionNo rollNo')
      .lean(),
    Mark.find(scope(actor, { examId: exam._id, sectionId: section._id })).lean(),
    gradingSettings(actor.schoolId),
  ]);
  const paperInfo: PaperInfo[] = papers.map((p) => ({
    paperId: p._id.toString(),
    subjectId: (p.subjectId as any)._id.toString(),
    subjectName: (p.subjectId as any).name,
    maxMarks: p.maxMarks,
    passMarks: p.passMarks,
    optional: Boolean((p.subjectId as any).isElective),
  }));
  const marksByStudent = new Map<
    string,
    Array<{ paperId: string; obtained?: number | null; isAbsent?: boolean; notTaken?: boolean }>
  >();
  for (const m of marks) {
    const k = m.studentId.toString();
    marksByStudent.set(k, [
      ...(marksByStudent.get(k) ?? []),
      { paperId: m.paperId.toString(), obtained: m.obtained, isAbsent: m.isAbsent, notTaken: m.notTaken },
    ]);
  }
  // Published results are shown as they were published: before "not taken" could be recorded, a
  // blank elective was read as not taken (publishing now requires every elective to be resolved).
  const resultOpts = { blankElectiveNotTaken: exam.status === 'published' };
  const rows = assignPositions(
    students.map((s) => ({
      studentId: s._id.toString(),
      name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
      admissionNo: s.admissionNo,
      rollNo: s.rollNo,
      ...computeStudentResult(
        paperInfo,
        marksByStudent.get(s._id.toString()) ?? [],
        grading.scale,
        grading.passPercent,
        resultOpts,
      ),
    })),
  ).sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));

  const subjects = paperInfo.map((p) => {
    const values = marks
      .filter((m) => m.paperId.toString() === p.paperId && !m.notTaken)
      .map((m) => (m.isAbsent ? 0 : (m.obtained ?? 0)));
    return {
      subjectId: p.subjectId,
      subject: p.subjectName,
      maxMarks: p.maxMarks,
      passMarks: p.passMarks,
      ...subjectStats(values, p.maxMarks, p.passMarks),
    };
  });
  const complete = rows.filter((r) => !r.incomplete);
  return {
    exam: { _id: exam._id, name: exam.name, status: exam.status },
    sectionId: section._id,
    summary: {
      students: rows.length,
      complete: complete.length,
      passed: complete.filter((r) => r.passed).length,
      passRate: complete.length
        ? Math.round((complete.filter((r) => r.passed).length / complete.length) * 1000) / 10
        : null,
      averagePercentage: complete.length
        ? Math.round((complete.reduce((s, r) => s + r.percentage, 0) / complete.length) * 100) / 100
        : null,
    },
    subjects,
    results: rows,
  };
}

export async function resultsForViewer(ctx: Ctx, examId: string, sectionId: string) {
  await findOwned(Exam, ctx, examId, 'Exam');
  const family = await visibleStudentIds(ctx);
  if (family) throw forbidden('Use the student report card endpoint');
  if (ctx.role === 'teacher' && !(await teacherSectionIds(ctx, 'marks')).includes(sectionId))
    throw forbidden('You are not assigned to this section');
  if (!ctx.permissions.has('exams:read')) throw forbidden();
  return sectionResults(ctx, examId, sectionId);
}

export async function studentReportCard(ctx: Ctx, examId: string, studentId: string) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  const family = await visibleStudentIds(ctx);
  if (family) {
    if (!family.includes(studentId)) throw notFound('Student');
    if (exam.status !== 'published') throw notFound('Results');
  }
  const student = await findOwned(
    Student,
    ctx,
    studentId,
    'Student',
    'firstName lastName admissionNo sectionId classId',
  );
  // Find which section the student took this exam in (historical mark -> historical enrollment -> current section)
  const mark = await Mark.findOne(scope(ctx, { examId: exam._id, studentId: student._id }))
    .select('sectionId')
    .lean();
  const enrollment = !mark
    ? await StudentEnrollment.findOne(scope(ctx, { studentId: student._id, sessionId: exam.sessionId }))
        .select('sectionId')
        .lean()
    : null;
  const examSectionId = (mark?.sectionId ?? enrollment?.sectionId ?? student.sectionId).toString();

  if (ctx.role === 'teacher') await assertSectionAccess(ctx, examSectionId, 'marks');
  const results = await sectionResults(ctx, examId, examSectionId);
  const mine = results.results.find((r) => r.studentId === studentId);
  if (!mine) throw notFound('Result');
  return {
    exam: results.exam,
    student: {
      _id: student._id,
      name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
      admissionNo: student.admissionNo,
    },
    sectionSize: results.results.length,
    result: mine,
    classAverages: results.subjects.map((s) => ({
      subject: s.subject,
      averagePercent: (s as any).averagePercent ?? null,
    })),
  };
}

export async function publishResults(ctx: Ctx, examId: string, notify: boolean) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  if (exam.status === 'published') throw conflict('Results are already published');
  // Checked on the server every time: a blank mark is never published as zero or absent.
  const readiness = await publishReadiness(ctx, examId);
  if (!readiness.papers) throw unprocessable('The exam has no papers');
  if (!readiness.ready) {
    await audit(ctx, {
      action: 'exam.publish_blocked',
      entityType: 'Exam',
      entityId: exam._id,
      outcome: 'failure',
      metadata: { missingEntries: readiness.missingEntries, invalidEntries: readiness.invalidEntries },
    });
    throw unprocessable(
      readiness.message,
      {
        missingEntries: readiness.missingEntries,
        invalidEntries: readiness.invalidEntries,
        studentsAffected: readiness.studentsAffected,
        groups: readiness.groups,
      },
      'RESULTS_INCOMPLETE',
    );
  }
  // Marks entry is refused once published, so nothing can change between the check and here
  // except another publish, which this claim rejects.
  const claimed = await Exam.updateOne(scope(ctx, { _id: exam._id, status: { $ne: 'published' } }), {
    $set: { status: 'published', publishedAt: new Date(), publishedBy: oid(ctx.userId) },
  });
  if (!claimed.modifiedCount) throw conflict('Results are already published');
  let notified = 0;
  if (notify) {
    const studentIds = await Mark.distinct('studentId', scope(ctx, { examId: exam._id }));
    notified = await notifyUsers(ctx, await parentUserIdsForStudents(ctx, studentIds), {
      title: `Results published: ${exam.name}`,
      body: `Results for ${exam.name} are now available in the parent portal.`,
      category: 'results',
      link: `/exams/${exam._id}`,
    });
  }
  await audit(ctx, {
    action: 'exam.results_published',
    entityType: 'Exam',
    entityId: exam._id,
    metadata: { notified },
  });
  return { status: 'published' as const, notified };
}

export async function unpublishResults(ctx: Ctx, examId: string) {
  const exam = await findOwned(Exam, ctx, examId, 'Exam');
  if (exam.status !== 'published') throw conflict('Results are not published');
  await Exam.updateOne(scope(ctx, { _id: exam._id }), {
    $set: { status: 'marks_entry' },
    $unset: { publishedAt: 1, publishedBy: 1 },
  });
  await audit(ctx, { action: 'exam.results_unpublished', entityType: 'Exam', entityId: exam._id });
  return { status: 'marks_entry' as const };
}
