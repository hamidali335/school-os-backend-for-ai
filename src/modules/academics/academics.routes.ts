import type { Api } from '../../utils/api';
import { crudRoutes, refuseIfReferenced } from '../../utils/crud';
import { badRequest } from '../../utils/errors';
import { parseDateOnly } from '../../utils/dates';
import { assertManyRefs, findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { Employee } from '../employees/employee.model';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { backfillHomeworkTeacher } from '../homework/homework-teacher';
import { inheritFeeTemplate } from '../fees/fee-template';
import { teacherSectionCapabilities, teacherSectionIds } from './access.service';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from './academics.models';
import { activateSessionSafely, generateNextSession, previewNextSessionGeneration } from './session-generator.service';
import {
  checkAcademicRolloverRollback,
  executeAcademicRollover,
  listAcademicRolloverBatches,
  previewAcademicRollover,
  rollbackAcademicRollover,
} from './academic-rollover.service';

const SessionRes = z
  .object({
    ...docBase,
    name: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    isCurrent: z.boolean(),
    status: z.string(),
    generationSource: z.string().optional(),
    generatedFromSessionId: objectId().optional().nullable(),
    generatedAt: z.string().optional().nullable(),
    feeRolloverStatus: z.string().optional(),
    academicRolloverStatus: z.string().optional(),
    academicRolloverAt: z.string().optional().nullable(),
    academicRolloverFromSessionId: objectId().optional().nullable(),
  })
  .openapi('AcademicSession');
const ClassRes = z
  .object({ ...docBase, campusId: objectId(), name: z.string(), level: z.number(), status: z.string() })
  .openapi('SchoolClass');
const SectionRes = z
  .object({
    ...docBase,
    campusId: objectId(),
    classId: z.any(),
    sessionId: objectId(),
    name: z.string(),
    capacity: z.number(),
    room: z.string().optional(),
    classTeacherId: z.any().optional(),
  })
  .openapi('Section');
const SubjectRes = z
  .object({ ...docBase, name: z.string(), code: z.string(), classIds: z.array(objectId()), isElective: z.boolean() })
  .openapi('Subject');
const AssignmentRes = z
  .object({ ...docBase, sessionId: objectId(), sectionId: z.any(), subjectId: z.any(), teacherId: z.any() })
  .openapi('TeachingAssignment');

const SessionBody = z
  .object({
    name: z.string().trim().min(3).max(40).openapi({ example: '2026-2027' }),
    startDate: isoDate(),
    endDate: isoDate(),
    status: z.enum(['planned', 'active', 'closed']).optional(),
  })
  .refine((v) => v.startDate < v.endDate, { message: 'startDate must be before endDate', path: ['endDate'] });

const PreviewNextSessionRes = z
  .object({
    sourceSession: z.object({
      _id: z.string(),
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      isCurrent: z.boolean(),
      status: z.string(),
    }),
    proposedSession: z.object({
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
    }),
    schoolTimezone: z.string(),
    localToday: z.string(),
    isDue: z.boolean(),
    alreadyGenerated: z.boolean(),
    existingSession: z
      .object({
        _id: z.string(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        status: z.string(),
        isCurrent: z.boolean(),
        generationSource: z.string(),
      })
      .nullable(),
  })
  .openapi('PreviewNextSessionResponse');

const GenerateNextSessionBody = z
  .object({
    sourceSessionId: objectId().optional(),
    name: z.string().trim().min(3).max(40).optional(),
    startDate: isoDate().optional(),
    endDate: isoDate().optional(),
  })
  .openapi('GenerateNextSessionBody');

export function registerAcademicsRoutes(api: Api) {
  const tag = 'Academics';

  api.route({
    method: 'get',
    path: '/academics/sessions/preview-next',
    tags: [tag],
    auth: 'school',
    permission: 'academics:read',
    summary: 'Preview automatic generation of next academic session',
    query: z.object({ sourceSessionId: objectId().optional() }),
    response: PreviewNextSessionRes,
    handler: async ({ ctx, query }) => {
      return previewNextSessionGeneration(ctx, query.sourceSessionId);
    },
  });

  api.route({
    method: 'post',
    path: '/academics/sessions/generate-next',
    tags: [tag],
    auth: 'school',
    permission: 'academics:manage',
    summary: 'Generate next academic session based on previous session dates',
    body: GenerateNextSessionBody,
    response: SessionRes,
    handler: async ({ ctx, body }) => {
      return generateNextSession(ctx, body);
    },
  });

  crudRoutes(api, {
    path: '/academics/sessions',
    tag,
    label: 'academic session',
    model: AcademicSession,
    read: 'academics:read',
    write: 'academics:manage',
    createSchema: SessionBody as any,
    updateSchema: z.object({
      name: z.string().trim().min(3).max(40).optional(),
      startDate: isoDate().optional(),
      endDate: isoDate().optional(),
      status: z.enum(['planned', 'active', 'closed']).optional(),
    }),
    response: SessionRes,
    sort: { startDate: -1 },
    prepare: (_ctx, body) => ({
      ...body,
      ...(body.startDate ? { startDate: parseDateOnly(body.startDate) } : {}),
      ...(body.endDate ? { endDate: parseDateOnly(body.endDate) } : {}),
    }),
    beforeDelete: refuseIfReferenced([
      [Section, 'sessionId', 'sections'],
      [Student, 'sessionId', 'students'],
    ]),
  });

  api.route({
    method: 'post',
    path: '/academics/sessions/:id/set-current',
    tags: [tag],
    auth: 'school',
    permission: 'academics:manage',
    summary: 'Mark an academic session as the current session',
    params: idParams,
    response: SessionRes,
    handler: async ({ ctx, params }) => {
      const session = await findOwned(AcademicSession, ctx, params.id, 'Academic session');
      await AcademicSession.updateMany(scope(ctx, { _id: { $ne: session._id } }), { $set: { isCurrent: false } });
      const updated = await AcademicSession.findOneAndUpdate(
        scope(ctx, { _id: session._id }),
        { $set: { isCurrent: true, status: 'active' } },
        { returnDocument: 'after' },
      ).lean();
      await School.updateOne({ _id: oid(ctx.schoolId) }, { $set: { 'settings.currentSessionId': session._id } });
      await audit(ctx, {
        action: 'academic_session.set_current',
        entityType: 'AcademicSession',
        entityId: session._id,
      });
      return updated;
    },
  });

  api.route({
    method: 'post',
    path: '/academics/sessions/:id/activate',
    tags: [tag],
    auth: 'school',
    permission: 'academics:manage',
    summary: 'Safely activate an academic session as the current session',
    params: idParams,
    response: SessionRes,
    handler: async ({ ctx, params }) => {
      return activateSessionSafely(ctx, params.id);
    },
  });

  crudRoutes(api, {
    path: '/academics/classes',
    tag,
    label: 'class',
    model: SchoolClass,
    read: 'academics:read',
    write: 'academics:manage',
    campusScoped: true,
    createSchema: z.object({
      campusId: objectId(),
      name: z.string().trim().min(1).max(40).openapi({ example: 'Class 5' }),
      level: z
        .number()
        .int()
        .min(-3)
        .max(20)
        .openapi({ description: 'Ordering level; e.g. -2 Playgroup, 0 Prep, 1..12' }),
      status: z.enum(['active', 'inactive']).optional(),
    }),
    response: ClassRes,
    filters: {
      schema: z.object({ campusId: objectId().optional() }),
      toFilter: (q) => (q.campusId ? { campusId: oid(q.campusId) } : {}),
    },
    sort: { level: 1, name: 1 },
    searchFields: ['name'],
    refs: (b) => [[Campus, b.campusId, 'campusId']],
    // A new class starts with the current session's default fee structure, if the school set one.
    afterCreate: async (ctx, doc) => void (await inheritFeeTemplate(ctx, doc._id)),
    beforeDelete: refuseIfReferenced([
      [Section, 'classId', 'sections'],
      [Student, 'classId', 'students'],
    ]),
  });

  crudRoutes(api, {
    path: '/academics/sections',
    tag,
    label: 'section',
    model: Section,
    read: 'academics:read',
    write: 'academics:manage',
    campusScoped: true,
    createSchema: z.object({
      classId: objectId(),
      sessionId: objectId(),
      name: z.string().trim().min(1).max(20).openapi({ example: 'A' }),
      capacity: z.number().int().min(1).max(200).optional(),
      room: z.string().trim().max(40).optional(),
      classTeacherId: objectId().nullable().optional(),
    }),
    response: SectionRes,
    filters: {
      schema: z.object({
        classId: objectId().optional(),
        sessionId: objectId().optional(),
        campusId: objectId().optional(),
      }),
      toFilter: (q) => ({
        ...(q.classId ? { classId: oid(q.classId) } : {}),
        ...(q.sessionId ? { sessionId: oid(q.sessionId) } : {}),
        ...(q.campusId ? { campusId: oid(q.campusId) } : {}),
      }),
    },
    sort: { name: 1 },
    populate: [
      { path: 'classId', select: 'name level' },
      { path: 'classTeacherId', select: 'firstName lastName employeeNo' },
    ],
    refs: (b) => [
      [SchoolClass, b.classId, 'classId'],
      [AcademicSession, b.sessionId, 'sessionId'],
      [Employee, b.classTeacherId, 'classTeacherId'],
    ],
    prepare: async (ctx, body, existing) => {
      const classId = body.classId ?? existing?.classId;
      const cls = await SchoolClass.findOne(scope(ctx, { _id: oid(classId) }))
        .select('campusId')
        .lean();
      if (!cls) throw badRequest('classId does not exist in this school');
      return { ...body, campusId: cls.campusId };
    },
    beforeDelete: refuseIfReferenced([[Student, 'sectionId', 'students']]),
  });

  crudRoutes(api, {
    path: '/academics/subjects',
    tag,
    label: 'subject',
    model: Subject,
    read: 'academics:read',
    write: 'academics:manage',
    createSchema: z.object({
      name: z.string().trim().min(1).max(60).openapi({ example: 'Mathematics' }),
      code: z.string().trim().min(1).max(15).openapi({ example: 'MATH' }),
      classIds: z.array(objectId()).max(50).optional(),
      isElective: z.boolean().optional(),
    }),
    response: SubjectRes,
    filters: {
      schema: z.object({ classId: objectId().optional() }),
      toFilter: (q) => (q.classId ? { classIds: oid(q.classId) } : {}),
    },
    sort: { name: 1 },
    searchFields: ['name', 'code'],
    prepare: async (ctx, body) => {
      if (body.classIds?.length) {
        await assertManyRefs(ctx, SchoolClass, body.classIds, 'class');
      }
      return body;
    },
    beforeDelete: refuseIfReferenced([[TeachingAssignment, 'subjectId', 'teaching assignments']]),
  });

  crudRoutes(api, {
    path: '/academics/teaching-assignments',
    tag,
    label: 'teaching assignment',
    model: TeachingAssignment,
    read: 'academics:read',
    write: 'academics:manage',
    createSchema: z.object({ sectionId: objectId(), subjectId: objectId(), teacherId: objectId() }),
    response: AssignmentRes,
    filters: {
      schema: z.object({
        sectionId: objectId().optional(),
        teacherId: objectId().optional(),
        subjectId: objectId().optional(),
      }),
      toFilter: (q) => ({
        ...(q.sectionId ? { sectionId: oid(q.sectionId) } : {}),
        ...(q.teacherId ? { teacherId: oid(q.teacherId) } : {}),
        ...(q.subjectId ? { subjectId: oid(q.subjectId) } : {}),
      }),
    },
    populate: [
      { path: 'sectionId', select: 'name classId' },
      { path: 'subjectId', select: 'name code' },
      { path: 'teacherId', select: 'firstName lastName employeeNo' },
    ],
    refs: (b) => [
      [Section, b.sectionId, 'sectionId'],
      [Subject, b.subjectId, 'subjectId'],
      [Employee, b.teacherId, 'teacherId'],
    ],
    prepare: async (ctx, body, existing) => {
      const sectionId = body.sectionId ?? existing?.sectionId;
      const subjectId = body.subjectId ?? existing?.subjectId;
      const teacherId = body.teacherId ?? existing?.teacherId;
      const [section, subject, teacher] = await Promise.all([
        Section.findOne(scope(ctx, { _id: oid(sectionId) }))
          .select('sessionId classId')
          .lean(),
        Subject.findOne(scope(ctx, { _id: oid(subjectId) }))
          .select('classIds name')
          .lean(),
        Employee.findOne(scope(ctx, { _id: oid(teacherId) }))
          .select('staffType status')
          .lean(),
      ]);
      if (!section) throw badRequest('sectionId does not exist in this school');
      if (!subject) throw badRequest('subjectId does not exist in this school');
      if (subject.classIds?.length && !subject.classIds.map(String).includes(String(section.classId)))
        throw badRequest(`${subject.name} is not taught in this section's class`, { field: 'subjectId' });
      if (!teacher || teacher.staffType !== 'teaching' || ['resigned', 'terminated'].includes(teacher.status))
        throw badRequest('Only current teaching staff can be assigned to teach a subject', { field: 'teacherId' });
      return { ...body, sessionId: section.sessionId };
    },
    // Homework of this class-subject saved before a teacher existed is now attributed (rule 5
    // in homework-teacher.ts). Homework that already has a teacher keeps its attribution.
    afterCreate: async (ctx, doc) => {
      await backfillHomeworkTeacher(ctx, doc.sectionId, doc.subjectId, doc.teacherId);
    },
    afterUpdate: async (ctx, doc, before) => {
      await backfillHomeworkTeacher(ctx, doc.sectionId, doc.subjectId, doc.teacherId);
      if (String(before.teacherId) !== String(doc.teacherId))
        await audit(ctx, {
          action: 'teaching_assignment.teacher_changed',
          entityType: 'TeachingAssignment',
          entityId: doc._id,
          metadata: { fromTeacherId: String(before.teacherId), toTeacherId: String(doc.teacherId) },
        });
    },
  });

  api.route({
    method: 'get',
    path: '/academics/my-sections',
    tags: [tag],
    auth: 'school',
    permission: 'academics:read',
    roles: ['teacher'],
    summary: 'Sections the signed-in teacher is responsible for',
    description:
      '`capabilities` lists what the teacher may do in each section: `view` always, plus `attendance`, `homework` and `marks` as class or subject teacher, or what a substitute cover includes.',
    response: z.array(
      SectionRes.extend({
        capabilities: z.array(z.enum(['view', 'attendance', 'homework', 'marks'])),
      }),
    ),
    handler: async ({ ctx }) => {
      const caps = await teacherSectionCapabilities(ctx);
      const sections = await Section.find(scope(ctx, { _id: { $in: [...caps.keys()].map(oid) } }))
        .populate('classId', 'name level')
        .sort({ name: 1 })
        .lean();
      return sections.map((sec) => ({ ...sec, capabilities: caps.get(String(sec._id)) ?? ['view'] }));
    },
  });

  api.route({
    method: 'get',
    path: '/academics/rollover/preview',
    tags: [tag],
    auth: 'school',
    permission: 'academics:read',
    summary: 'Preview carry-forward of classes, sections, teacher assignments, and timetables to a new session',
    query: z.object({
      fromSessionId: objectId(),
      toSessionId: objectId(),
    }),
    response: z.any().openapi('AcademicRolloverPreviewResponse'),
    handler: async ({ ctx, query }) => {
      return previewAcademicRollover(ctx, query);
    },
  });

  api.route({
    method: 'post',
    path: '/academics/rollover/execute',
    tags: [tag],
    auth: 'school',
    permission: 'academics:manage',
    summary: 'Execute carry-forward of academic configurations into the target session',
    body: z.object({
      fromSessionId: objectId(),
      toSessionId: objectId(),
      includeSections: z.boolean().optional(),
      includeTeacherAssignments: z.boolean().optional(),
      includeTimetable: z.boolean().optional(),
      teacherOverrides: z
        .array(
          z.object({
            sectionClassId: z.string(),
            sectionName: z.string(),
            subjectId: z.string(),
            teacherId: z.string(),
          }),
        )
        .optional(),
      excludedAssignmentIds: z.array(z.string()).optional(),
      roomOverrides: z
        .array(
          z.object({
            sectionClassId: z.string(),
            sectionName: z.string(),
            room: z.string(),
          }),
        )
        .optional(),
      ignoreWarnings: z.boolean().optional(),
    }),
    response: z.any().openapi('AcademicRolloverExecuteResponse'),
    handler: async ({ ctx, body }) => {
      return executeAcademicRollover(ctx, body);
    },
  });

  api.route({
    method: 'get',
    path: '/academics/rollover/rollback-check',
    tags: [tag],
    auth: 'school',
    permission: 'academics:read',
    summary: 'Check if academic rollover can be safely rolled back for a session',
    query: z.object({
      targetSessionId: objectId(),
    }),
    response: z.any().openapi('AcademicRolloverRollbackCheckResponse'),
    handler: async ({ ctx, query }) => {
      return checkAcademicRolloverRollback(ctx, query.targetSessionId);
    },
  });

  api.route({
    method: 'post',
    path: '/academics/rollover/rollback',
    tags: [tag],
    auth: 'school',
    permission: 'academics:manage',
    summary: 'Roll back an academic rollover batch safely if no dependent activity exists',
    body: z.object({
      targetSessionId: objectId(),
      reason: z.string().trim().min(3),
    }),
    response: z.any().openapi('AcademicRolloverRollbackResponse'),
    handler: async ({ ctx, body }) => {
      return rollbackAcademicRollover(ctx, body);
    },
  });

  api.route({
    method: 'get',
    path: '/academics/rollover/batches',
    tags: [tag],
    auth: 'school',
    permission: 'academics:read',
    summary: 'List academic rollover batches',
    query: z.object({
      sessionId: objectId().optional(),
    }),
    response: z.any().openapi('AcademicRolloverBatchesResponse'),
    handler: async ({ ctx, query }) => {
      return listAcademicRolloverBatches(ctx, query.sessionId);
    },
  });
}
