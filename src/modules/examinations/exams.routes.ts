import type { Api } from '../../utils/api';
import { parseDateOnly } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, paginationQuery, timeHHmm, z } from '../../utils/zod';
import { visibleStudentIds } from '../academics/access.service';
import { audit } from '../audit/audit.service';
import { Student } from '../students/student.models';
import { EXAM_STATUSES, Exam, ExamPaper, Mark } from './exam.models';
import * as svc from './exams.service';
import { loadBrand } from '../branding/branding.service';
import { renderResultCards } from '../../services/pdf';
import { assertReportCardAccess, assertSectionCardsAccess, reportCardsForSection } from './report-card';
import { publishReadiness } from './result-publication';

const TERMS = ['first_term', 'mid_term', 'final_term', 'monthly_test', 'other'] as const;

const ExamRes = z
  .object({
    ...docBase,
    sessionId: objectId(),
    name: z.string(),
    term: z.enum(TERMS),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    classIds: z.array(z.any()),
    status: z.enum(EXAM_STATUSES),
    publishedAt: z.string().optional(),
    datesheetVersion: z.number().optional(),
  })
  .openapi('Exam');

const PaperRes = z
  .object({
    ...docBase,
    examId: objectId(),
    classId: z.any(),
    subjectId: z.any(),
    maxMarks: z.number(),
    passMarks: z.number(),
    date: z.string().optional(),
    startTime: z.string().optional(),
    durationMinutes: z.number().optional(),
    marksCount: z.number().optional().openapi({ description: 'Marks already entered for this paper (staff only)' }),
  })
  .openapi('ExamPaper');

const SubjectResult = z.object({
  paperId: z.string(),
  subjectId: z.string(),
  subject: z.string(),
  maxMarks: z.number(),
  passMarks: z.number(),
  obtained: z.number().nullable(),
  isAbsent: z.boolean(),
  percentage: z.number().nullable(),
  grade: z.string().nullable(),
  passed: z.boolean().nullable(),
  notTaken: z.boolean().optional().openapi({ description: 'Elective the student does not take: left out of totals' }),
});

const StudentResultRes = z
  .object({
    studentId: z.string(),
    name: z.string(),
    admissionNo: z.string(),
    totalObtained: z.number(),
    totalMax: z.number(),
    percentage: z.number(),
    grade: z.string(),
    remark: z.string().nullable().optional(),
    passed: z.boolean(),
    failedSubjects: z.array(z.string()),
    incomplete: z
      .boolean()
      .openapi({ description: 'True when some marks are missing; incomplete results are not ranked' }),
    position: z.number().nullable(),
    subjects: z.array(SubjectResult),
  })
  .openapi('StudentResult');

export function registerExamRoutes(api: Api) {
  const tags = ['Examinations'];

  api.route({
    method: 'get',
    path: '/exams',
    tags,
    auth: 'school',
    permission: 'exams:read',
    summary: 'List exams',
    description: 'Parents/students only see exams for their (children’s) classes that are scheduled or published.',
    query: paginationQuery.extend({
      sessionId: objectId().optional(),
      status: z.enum(EXAM_STATUSES).optional(),
      classId: objectId().optional(),
    }),
    response: ExamRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      const family = await visibleStudentIds(ctx);
      if (family) {
        const kids = await Student.find(scope(ctx, { _id: { $in: family.map(oid) } }))
          .select('classId')
          .lean();
        filter.classIds = { $in: kids.map((k) => k.classId) };
        filter.status = { $in: ['scheduled', 'marks_entry', 'published'] };
      } else if (query.status) filter.status = query.status;
      if (query.sessionId) filter.sessionId = oid(query.sessionId);
      if (query.classId) filter.classIds = oid(query.classId);
      return paginate(Exam, filter, { page: query.page, limit: query.limit, sort: { startDate: -1, createdAt: -1 } });
    },
  });

  api.route({
    method: 'post',
    path: '/exams',
    tags,
    auth: 'school',
    permission: 'exams:manage',
    summary: 'Create an exam',
    body: z.object({
      sessionId: objectId(),
      name: z.string().trim().min(2).max(80).openapi({ example: 'Mid-Term Examination 2026' }),
      term: z.enum(TERMS).optional(),
      startDate: isoDate().optional(),
      endDate: isoDate().optional(),
      classIds: z.array(objectId()).min(1).max(30),
    }),
    response: ExamRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createExam(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/exams/:id',
    tags,
    auth: 'school',
    permission: 'exams:read',
    summary: 'Exam with its papers (date sheet)',
    params: idParams,
    response: ExamRes.extend({ papers: z.array(PaperRes) }),
    handler: async ({ ctx, params }) => {
      const exam = await Exam.findOne(scope(ctx, { _id: oid(params.id) }))
        .populate('classIds', 'name level')
        .lean();
      if (!exam) throw notFound('Exam');
      const family = await visibleStudentIds(ctx);
      if (family && exam.status === 'draft') throw notFound('Exam');
      const papers = await svc.papersWithMarks(ctx, exam._id);
      // Families do not need internal counts.
      return { ...exam, papers: family ? papers.map(({ marksCount: _m, ...p }) => p) : papers };
    },
  });

  api.route({
    method: 'patch',
    path: '/exams/:id',
    tags,
    auth: 'school',
    permission: 'exams:manage',
    summary: 'Update exam details',
    params: idParams,
    body: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      term: z.enum(TERMS).optional(),
      startDate: isoDate().optional(),
      endDate: isoDate().optional(),
    }),
    response: ExamRes,
    handler: async ({ ctx, params, body }) => {
      const exam = await findOwned(Exam, ctx, params.id, 'Exam');
      const start = body.startDate ?? (exam.startDate ? exam.startDate.toISOString().slice(0, 10) : undefined);
      const end = body.endDate ?? (exam.endDate ? exam.endDate.toISOString().slice(0, 10) : undefined);
      if (start && end && start > end)
        throw badRequest('The end date must be on or after the start date', { field: 'endDate' });
      const set: Record<string, unknown> = { ...body };
      if (body.startDate) set.startDate = parseDateOnly(body.startDate);
      if (body.endDate) set.endDate = parseDateOnly(body.endDate);
      const updated = await Exam.findOneAndUpdate(
        scope(ctx, { _id: exam._id }),
        { $set: set },
        { returnDocument: 'after' },
      ).lean();
      await audit(ctx, { action: 'exam.update', entityType: 'Exam', entityId: exam._id });
      return updated;
    },
  });

  api.route({
    method: 'delete',
    path: '/exams/:id',
    tags,
    auth: 'school',
    permission: 'exams:manage',
    summary: 'Delete an exam that has no marks',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const exam = await findOwned(Exam, ctx, params.id, 'Exam');
      if (await Mark.exists(scope(ctx, { examId: exam._id }))) throw conflict('Exam has marks and cannot be deleted');
      await ExamPaper.deleteMany(scope(ctx, { examId: exam._id }));
      await Exam.deleteOne(scope(ctx, { _id: exam._id }));
      await audit(ctx, { action: 'exam.delete', entityType: 'Exam', entityId: exam._id });
    },
  });

  api.route({
    method: 'put',
    path: '/exams/:id/papers',
    tags,
    auth: 'school',
    permission: 'exams:manage',
    summary: 'Set the papers (subjects, max/pass marks, date sheet) of an exam',
    description:
      'Upserts by class+subject (never duplicates). Fails with `EXAM_PUBLISHED` while results are published, `PAPER_HAS_MARKS` when an omitted paper already has marks (details list them), ' +
      '`MAX_BELOW_ENTERED_MARKS` when max marks would drop below an entered mark, and `STALE_DATE_SHEET` when `expectedVersion` is out of date. ' +
      'Paper dates must fall within the exam start/end dates. A null or omitted date, start time or duration clears it.',
    params: idParams,
    body: z.object({
      papers: z
        .array(
          z.object({
            classId: objectId(),
            subjectId: objectId(),
            maxMarks: z.number().int().min(1).max(1000),
            passMarks: z.number().int().min(0).max(1000),
            date: isoDate().nullable().optional(),
            startTime: timeHHmm().nullable().optional(),
            durationMinutes: z.number().int().min(10).max(600).nullable().optional(),
          }),
        )
        .min(1)
        .max(300),
      expectedVersion: z
        .number()
        .int()
        .min(0)
        .optional()
        .openapi({ description: 'datesheetVersion the editor loaded; a mismatch fails with STALE_DATE_SHEET' }),
    }),
    response: z.array(PaperRes),
    handler: ({ ctx, params, body }) => svc.setPapers(ctx, params.id, body.papers, body.expectedVersion),
  });

  api.route({
    method: 'get',
    path: '/exams/:id/papers/:paperId/marks',
    tags,
    auth: 'school',
    permission: 'marks:enter',
    summary: 'Marks-entry roster for a section',
    params: z.object({ id: objectId(), paperId: objectId() }),
    query: z.object({ sectionId: objectId() }),
    response: z.object({
      paper: z.object({
        _id: objectId(),
        maxMarks: z.number(),
        passMarks: z.number(),
        subjectId: objectId(),
        isElective: z
          .boolean()
          .openapi({ description: 'Elective: a student who does not take it is marked Not taken' }),
      }),
      students: z.array(
        z.object({
          studentId: objectId(),
          name: z.string(),
          admissionNo: z.string(),
          rollNo: z.string().optional(),
          obtained: z.number().nullable(),
          isAbsent: z.boolean(),
          notTaken: z.boolean(),
          remarks: z.string().nullable(),
        }),
      ),
    }),
    handler: ({ ctx, params, query }) => svc.marksRoster(ctx, params.id, params.paperId, query.sectionId),
  });

  api.route({
    method: 'post',
    path: '/exams/:id/papers/:paperId/marks',
    tags,
    auth: 'school',
    permission: 'marks:enter',
    summary: 'Enter or update marks for a section',
    description:
      'Teachers can only enter marks for subjects they teach in that section. Blocked once results are published. ' +
      'Each student needs marks, `isAbsent`, or (elective papers only) `notTaken` for a student who does not take the subject. ' +
      'A blank elective is not assumed to be “not taken”: it blocks publication like any other blank.',
    params: z.object({ id: objectId(), paperId: objectId() }),
    body: z.object({
      sectionId: objectId(),
      marks: z
        .array(
          z.object({
            studentId: objectId(),
            obtained: z.number().min(0).max(1000).nullable().optional(),
            isAbsent: z.boolean().optional(),
            notTaken: z.boolean().optional(),
            remarks: z.string().trim().max(200).optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
    response: z.object({ saved: z.number() }),
    handler: ({ ctx, params, body }) => svc.enterMarks(ctx, params.id, params.paperId, body),
  });

  api.route({
    method: 'get',
    path: '/exams/:id/results',
    tags,
    auth: 'school',
    permission: 'exams:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff', 'teacher'],
    summary: 'Section results: totals, percentages, grades, positions and subject statistics',
    params: idParams,
    query: z.object({ sectionId: objectId() }),
    response: z.object({
      exam: z.object({ _id: objectId(), name: z.string(), status: z.string() }),
      sectionId: objectId(),
      summary: z.object({
        students: z.number(),
        complete: z.number(),
        passed: z.number(),
        passRate: z.number().nullable(),
        averagePercentage: z.number().nullable(),
      }),
      subjects: z.array(z.any()),
      results: z.array(StudentResultRes),
    }),
    handler: ({ ctx, params, query }) => svc.resultsForViewer(ctx, params.id, query.sectionId),
  });

  api.route({
    method: 'get',
    path: '/exams/:id/report-cards/:studentId',
    tags,
    auth: 'school',
    permission: 'exams:read',
    summary: "A student's report card for an exam",
    description:
      'Parents/students can only view their own (children’s) report cards, and only after results are published.',
    params: z.object({ id: objectId(), studentId: objectId() }),
    response: z.object({
      exam: z.object({ _id: objectId(), name: z.string(), status: z.string() }),
      student: z.object({ _id: objectId(), name: z.string(), admissionNo: z.string() }),
      sectionSize: z.number(),
      result: StudentResultRes,
      classAverages: z.array(z.object({ subject: z.string(), averagePercent: z.number().nullable() })),
    }),
    handler: ({ ctx, params }) => svc.studentReportCard(ctx, params.id, params.studentId),
  });

  const ReadinessStudent = z.object({
    studentId: z.string(),
    name: z.string(),
    admissionNo: z.string(),
    rollNo: z.string().optional(),
  });
  api.route({
    method: 'get',
    path: '/exams/:id/publish-check',
    tags,
    auth: 'school',
    permission: 'exams:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff', 'teacher'],
    summary: 'Is the result ready to publish? Lists students with missing or invalid marks',
    description:
      'Every active student in each paper roster needs marks within 0..maxMarks or an explicit Absent status. ' +
      'Blank marks are never counted as zero or absent. Elective papers are listed in electiveGaps and do not block publication.',
    params: idParams,
    response: z.object({
      examId: z.string(),
      status: z.string(),
      papers: z.number(),
      ready: z.boolean(),
      missingEntries: z.number(),
      invalidEntries: z.number(),
      studentsAffected: z.number(),
      message: z.string(),
      groups: z.array(
        z.object({
          classId: z.string(),
          className: z.string(),
          sectionId: z.string(),
          sectionName: z.string(),
          paperId: z.string(),
          subject: z.string(),
          roster: z.number(),
          missingCount: z.number(),
          missing: z.array(ReadinessStudent),
          invalidCount: z.number(),
          invalid: z.array(ReadinessStudent.extend({ obtained: z.number(), maxMarks: z.number() })),
        }),
      ),
      electiveGaps: z.array(
        z.object({ className: z.string(), sectionName: z.string(), subject: z.string(), withoutMarks: z.number() }),
      ),
    }),
    handler: async ({ ctx, params }) => {
      if (await visibleStudentIds(ctx)) throw notFound('Exam');
      return publishReadiness(ctx, params.id);
    },
  });

  const ResultCardRes = z
    .object({
      published: z.boolean(),
      exam: z.object({
        _id: z.string(),
        name: z.string(),
        term: z.string(),
        status: z.string(),
        startDate: z.string().nullable(),
        endDate: z.string().nullable(),
      }),
      session: z.object({ name: z.string() }).nullable(),
      student: z.object({
        _id: z.string(),
        name: z.string(),
        admissionNo: z.string(),
        rollNo: z.string().nullable(),
        guardianName: z.string().nullable(),
        guardianRelation: z.string().nullable(),
        dateOfBirth: z.string().nullable(),
        className: z.string().nullable(),
        sectionName: z.string().nullable(),
      }),
      result: StudentResultRes,
      position: z.number().nullable(),
      sectionSize: z.number(),
      attendance: z.object({
        from: z.string().nullable(),
        to: z.string(),
        present: z.number(),
        absent: z.number(),
        late: z.number(),
        leave: z.number(),
        excused: z.number(),
        total: z.number(),
        rate: z.number().nullable(),
      }),
      classAverages: z.array(z.object({ subject: z.string(), averagePercent: z.number().nullable() })),
      gradingScale: z.array(z.object({ grade: z.string(), minPercent: z.number(), remark: z.string().nullable() })),
      passPercent: z.number(),
    })
    .openapi('ResultCard');

  api.route({
    method: 'get',
    path: '/exams/:id/result-cards/:studentId',
    tags,
    auth: 'school',
    permission: 'exams:read',
    summary: 'A student result card (marks, totals, grade, position, attendance)',
    description:
      'Families only see published results for their own children. Staff can preview unpublished results; they are marked as a draft (published: false).',
    params: z.object({ id: objectId(), studentId: objectId() }),
    response: ResultCardRes,
    handler: async ({ ctx, params }) => {
      const { sectionId } = await assertReportCardAccess(ctx, params.id, params.studentId);
      const [card] = await reportCardsForSection(ctx, params.id, sectionId, params.studentId);
      return card;
    },
  });

  api.route({
    method: 'get',
    path: '/exams/:id/result-cards/:studentId/pdf',
    tags,
    auth: 'school',
    permission: 'exams:read',
    summary: 'Download a student result card as a PDF (DRAFT-marked when unpublished)',
    params: z.object({ id: objectId(), studentId: objectId() }),
    produces: 'application/pdf',
    handler: async ({ ctx, params, res }) => {
      const { sectionId } = await assertReportCardAccess(ctx, params.id, params.studentId);
      const cards = await reportCardsForSection(ctx, params.id, sectionId, params.studentId);
      const pdf = await renderResultCards(cards, await loadBrand(ctx.schoolId));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="result-card-' + cards[0].student.admissionNo + '.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'get',
    path: '/exams/:id/section-result-cards.pdf',
    tags,
    auth: 'school',
    permission: 'exams:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff', 'teacher'],
    summary: 'All result cards of a section in one PDF (one page per student)',
    params: idParams,
    query: z.object({ sectionId: objectId() }),
    produces: 'application/pdf',
    handler: async ({ ctx, params, query, res }) => {
      await assertSectionCardsAccess(ctx, params.id, query.sectionId);
      const cards = await reportCardsForSection(ctx, params.id, query.sectionId);
      const pdf = await renderResultCards(cards, await loadBrand(ctx.schoolId));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="result-cards.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'post',
    path: '/exams/:id/publish',
    tags,
    auth: 'school',
    permission: 'results:publish',
    summary: 'Publish results (makes them visible to parents)',
    description:
      'Refused with 422 RESULTS_INCOMPLETE while any student in a paper roster has no marks and no Absent status, or a mark outside the allowed range. ' +
      'error.details.groups names each class, section, subject and the students affected (see GET /exams/{id}/publish-check).',
    params: idParams,
    body: z.object({ notifyParents: z.boolean().default(true) }),
    response: z.object({ status: z.literal('published'), notified: z.number() }),
    handler: ({ ctx, params, body }) => svc.publishResults(ctx, params.id, body.notifyParents),
  });

  api.route({
    method: 'post',
    path: '/exams/:id/unpublish',
    tags,
    auth: 'school',
    permission: 'results:publish',
    summary: 'Withdraw published results (to correct marks)',
    params: idParams,
    response: z.object({ status: z.literal('marks_entry') }),
    handler: ({ ctx, params }) => svc.unpublishResults(ctx, params.id),
  });
}
