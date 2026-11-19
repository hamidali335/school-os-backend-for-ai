import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { assertManyRefs, findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { assertSubjectAccess, teacherSubjectFilter, visibleStudentIds } from '../academics/access.service';
import { Section, Subject } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { canAccessFile } from '../certificates/certificates.routes';
import { FileObject } from '../certificates/files.model';
import { notifyUsers, parentUserIdsForStudents } from '../communications/communications.service';
import { Employee } from '../employees/employee.model';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { assertTeacherEligible, personRef, subjectTeacherOf, withTeacherInfo } from './homework-teacher';
import { Homework, HomeworkSubmission } from './homework.models';

const TeacherRef = z.object({ _id: objectId(), name: z.string(), employeeNo: z.string().optional() });

const HomeworkRes = z
  .object({
    ...docBase,
    sectionId: z.any(),
    subjectId: z.any(),
    teacherId: z.any().optional(),
    teacherSource: z.enum(['creator', 'explicit', 'assignment', 'backfill']).optional(),
    teacher: TeacherRef.nullable().optional().openapi({
      description: 'Teacher to display: the attributed teacher, or the current subject teacher when none is recorded',
    }),
    teacherStatus: z.enum(['attributed', 'from_current_assignment', 'unassigned']).optional(),
    className: z.string().optional().openapi({ description: 'Name of the class of `sectionId` (e.g. "Class 5")' }),
    currentSubjectTeacher: TeacherRef.nullable().optional().openapi({
      description: 'Who teaches this subject in this section today (may differ from the attributed teacher)',
    }),
    title: z.string(),
    description: z.string(),
    type: z.enum(['homework', 'assignment', 'project']),
    assignedOn: z.string(),
    dueDate: z.string(),
    maxMarks: z.number().optional(),
    attachmentIds: z.array(objectId()),
    status: z.enum(['published', 'closed']),
  })
  .openapi('Homework');

const AttachmentRes = z
  .object({ _id: objectId(), name: z.string(), mimeType: z.string(), size: z.number() })
  .openapi('HomeworkAttachment');

/** Name, type and size of the files this user may download, in the homework's order. */
async function attachmentsFor(ctx: SchoolContext, ids: Types.ObjectId[] | undefined) {
  if (!ids?.length) return [];
  const files = await FileObject.find(scope(ctx, { _id: { $in: ids } }))
    .select('originalName mimeType size category studentId employeeId homeworkId uploadedBy visibleToFamily')
    .lean();
  const out = [];
  for (const id of ids) {
    const file = files.find((x) => String(x._id) === String(id));
    if (file && (await canAccessFile(ctx, file)))
      out.push({ _id: file._id, name: file.originalName, mimeType: file.mimeType, size: file.size });
  }
  return out;
}

const SubmissionRes = z
  .object({
    ...docBase,
    homeworkId: objectId(),
    studentId: z.any(),
    text: z.string().optional(),
    attachmentIds: z.array(objectId()),
    submittedAt: z.string().optional(),
    isLate: z.boolean(),
    status: z.enum(['pending', 'submitted', 'graded', 'returned']),
    marks: z.number().optional(),
    feedback: z.string().optional(),
  })
  .openapi('HomeworkSubmission');

/**
 * A parent's children who are in the homework's section (usually one; twins share a section).
 * Archived children are left out: their portal access is paused.
 */
async function childrenInSection(ctx: SchoolContext, sectionId: unknown) {
  const family = (await visibleStudentIds(ctx)) ?? [];
  if (!family.length) return [];
  return Student.find(
    scope(ctx, { _id: { $in: family.map(oid) }, sectionId: oid(idOf(sectionId)), status: { $ne: 'archived' } }),
  )
    .select('_id firstName lastName admissionNo')
    .sort({ firstName: 1 })
    .lean();
}

/** The child a parent is handing homework in for; it must be theirs and in that section. */
export async function assertSubmittingChild(ctx: SchoolContext, sectionId: unknown, studentId: string) {
  const kids = await childrenInSection(ctx, sectionId);
  const child = kids.find((k) => k._id.toString() === studentId);
  if (!child) throw forbidden('You can only submit homework for your own child in this class');
  return child;
}

async function familySectionIds(ctx: SchoolContext): Promise<string[] | null> {
  const family = await visibleStudentIds(ctx);
  if (!family) return null;
  const kids = await Student.find(scope(ctx, { _id: { $in: family.map(oid) } }))
    .select('sectionId')
    .lean();
  return kids.map((k) => k.sectionId.toString());
}

const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v);

/** Unauthorised viewers get 404, so the existence of other classes' homework is not revealed. */
async function assertHomeworkVisible(ctx: SchoolContext, hw: { sectionId: unknown; subjectId: unknown }) {
  const fam = await familySectionIds(ctx);
  if (fam && !fam.includes(idOf(hw.sectionId))) throw notFound('Homework');
  if (ctx.role === 'teacher') {
    await assertSubjectAccess(ctx, idOf(hw.sectionId), idOf(hw.subjectId), 'view').catch(() => {
      throw notFound('Homework');
    });
  }
}

/**
 * Changing, deleting or grading homework needs a current right to manage that class-subject:
 * having created it once is not enough (a substitute loses access when the cover ends).
 */
async function assertHomeworkManageable(ctx: SchoolContext, hw: { sectionId: unknown; subjectId: unknown }) {
  await assertHomeworkVisible(ctx, hw);
  return assertSubjectAccess(ctx, idOf(hw.sectionId), idOf(hw.subjectId), 'homework');
}

export function registerHomeworkRoutes(api: Api) {
  const tags = ['Homework'];

  api.route({
    method: 'get',
    path: '/homework',
    tags,
    auth: 'school',
    permission: 'homework:read',
    summary: 'List homework and assignments',
    description: 'Teachers see their sections; parents/students see their (children’s) sections.',
    query: paginationQuery.extend({
      sectionId: objectId().optional(),
      subjectId: objectId().optional(),
      dueFrom: isoDate().optional(),
      dueTo: isoDate().optional(),
    }),
    response: HomeworkRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      const empty = { items: [], meta: { page: 1, limit: query.limit, total: 0, totalPages: 1 } };
      const fam = await familySectionIds(ctx);
      if (fam) filter.sectionId = { $in: fam.map(oid) };
      if (ctx.role === 'teacher') {
        // Only the class-subjects this teacher teaches (or covers), whole sections as class teacher.
        const or = await teacherSubjectFilter(ctx, 'view');
        if (!or.length) return empty;
        filter.$and = [{ $or: or }];
      }
      if (query.sectionId) {
        if (fam && !fam.includes(query.sectionId)) return empty;
        filter.sectionId = oid(query.sectionId);
      }
      if (query.subjectId) filter.subjectId = oid(query.subjectId);
      if (query.dueFrom || query.dueTo) {
        filter.dueDate = {
          ...(query.dueFrom ? { $gte: parseDateOnly(query.dueFrom) } : {}),
          ...(query.dueTo ? { $lte: parseDateOnly(query.dueTo) } : {}),
        };
      }
      const page = await paginate(Homework, filter, {
        page: query.page,
        limit: query.limit,
        sort: { dueDate: -1 },
        populate: [
          { path: 'subjectId', select: 'name code' },
          { path: 'sectionId', select: 'name classId' },
          { path: 'teacherId', select: 'firstName lastName employeeNo' },
        ],
      });
      return { ...page, items: await withTeacherInfo(ctx, page.items as any[]) };
    },
  });

  api.route({
    method: 'get',
    path: '/homework/teacher-preview',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Who would homework for this class-subject be attributed to?',
    description:
      'Used before assigning homework. Returns the subject teacher of the section (if any) and the teachers who may be chosen explicitly.',
    query: z.object({ sectionId: objectId(), subjectId: objectId() }),
    response: z.object({
      subjectTeacher: TeacherRef.nullable(),
      classTeacher: TeacherRef.nullable(),
      eligibleTeachers: z.array(TeacherRef),
    }),
    handler: async ({ ctx, query }) => {
      const section = await findOwned(Section, ctx, query.sectionId, 'Section');
      const subject = await findOwned(Subject, ctx, query.subjectId, 'Subject');
      await assertSubjectAccess(ctx, section._id, subject._id, 'homework');
      const subjectTeacherId = await subjectTeacherOf(ctx, section._id, subject._id);
      const ids = [subjectTeacherId, section.classTeacherId].filter(Boolean) as Types.ObjectId[];
      const people = await Employee.find(scope(ctx, { _id: { $in: ids }, status: { $in: ['active', 'on_leave'] } }))
        .select('firstName lastName employeeNo')
        .lean();
      const ref = (id: unknown) => personRef(people.find((p) => String(p._id) === String(id)) as any);
      return {
        subjectTeacher: subjectTeacherId ? ref(subjectTeacherId) : null,
        classTeacher: section.classTeacherId ? ref(section.classTeacherId) : null,
        eligibleTeachers: people.map((p) => personRef(p as any)!),
      };
    },
  });

  api.route({
    method: 'post',
    path: '/homework',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Assign homework to a section',
    description:
      'Teachers may only assign subjects they teach in that section. Parents with app accounts get an in-app notification.',
    body: z.object({
      sectionId: objectId(),
      subjectId: objectId(),
      title: z.string().trim().min(3).max(150),
      description: z.string().trim().min(3).max(5000),
      type: z.enum(['homework', 'assignment', 'project']).optional(),
      assignedOn: isoDate().optional(),
      dueDate: isoDate(),
      maxMarks: z.number().int().min(0).max(1000).optional(),
      attachmentIds: z.array(objectId()).max(10).optional(),
      notifyParents: z.boolean().optional(),
      teacherId: objectId()
        .optional()
        .openapi({ description: 'Administrators only: the teacher to attribute it to (must teach the class-subject)' }),
      allowUnassigned: z
        .boolean()
        .optional()
        .openapi({ description: 'Administrators only: save without a teacher when none is assigned yet' }),
    }),
    response: HomeworkRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      const section = await findOwned(Section, ctx, body.sectionId, 'Section');
      const subject = await findOwned(Subject, ctx, body.subjectId, 'Subject');
      if (subject.classIds?.length && !subject.classIds.map(String).includes(String(section.classId)))
        throw badRequest('This subject is not taught in the selected class', { field: 'subjectId' });
      const access = await assertSubjectAccess(ctx, section._id, subject._id, 'homework');
      if (body.attachmentIds?.length) await assertManyRefs(ctx, FileObject, body.attachmentIds, 'attachment');
      const school = await School.findById(ctx.schoolId).select('settings.timezone').lean();
      const today = todayInTz(school?.settings?.timezone ?? 'Asia/Karachi');
      const assignedOn = body.assignedOn ?? today;
      if (body.dueDate < assignedOn) throw badRequest('dueDate cannot be before assignedOn', { field: 'dueDate' });
      if (assignedOn > formatDateOnly(addDays(parseDateOnly(today), 365)))
        throw badRequest('assignedOn is too far in the future', { field: 'assignedOn' });

      // Who is this homework attributed to? See homework-teacher.ts for the rules.
      let teacherId: Types.ObjectId | string | undefined;
      let teacherSource: 'creator' | 'explicit' | 'assignment' | undefined;
      if (ctx.role === 'teacher') {
        if (body.teacherId && body.teacherId !== ctx.employeeId)
          throw forbidden('Teachers can only set homework in their own name');
        teacherId = ctx.employeeId;
        teacherSource = 'creator';
      } else if (body.teacherId) {
        await assertTeacherEligible(ctx, section._id, subject._id, body.teacherId);
        teacherId = oid(body.teacherId);
        teacherSource = 'explicit';
      } else {
        const assigned = await subjectTeacherOf(ctx, section._id, subject._id);
        if (assigned) {
          teacherId = assigned;
          teacherSource = 'assignment';
        } else if (!body.allowUnassigned) {
          throw unprocessable(
            `No teacher is assigned to ${subject.name} in this section. Assign a teacher first, choose one, or save it as unassigned.`,
            { sectionId: body.sectionId, subjectId: body.subjectId },
            'TEACHER_NOT_ASSIGNED',
          );
        }
      }
      const { notifyParents, allowUnassigned: _u, teacherId: _t, ...data } = body;
      const hw = await Homework.create({
        ...data,
        schoolId: ctx.schoolId,
        sessionId: section.sessionId,
        campusId: section.campusId,
        teacherId,
        teacherSource,
        createdViaSubstituteId: access.viaSubstitute,
        createdBy: ctx.userId,
        assignedOn: parseDateOnly(assignedOn),
        dueDate: parseDateOnly(body.dueDate),
      });
      if (body.attachmentIds?.length) {
        await FileObject.updateMany(scope(ctx, { _id: { $in: body.attachmentIds.map(oid) } }), {
          $set: { homeworkId: hw._id },
        });
      }
      if (notifyParents) {
        const students = await Student.find(scope(ctx, { sectionId: section._id, status: 'active' }))
          .select('_id')
          .lean();
        const users = await parentUserIdsForStudents(
          ctx,
          students.map((s) => s._id),
        );
        await notifyUsers(ctx, users, {
          title: `New ${hw.type}: ${subject.name}`,
          body: `${hw.title} — due ${body.dueDate}`,
          category: 'homework',
          link: `/homework/${hw._id}`,
        });
      }
      await audit(ctx, {
        action: 'homework.create',
        entityType: 'Homework',
        entityId: hw._id,
        metadata: { teacherSource: teacherSource ?? 'unassigned', viaSubstitute: access.viaSubstitute },
      });
      const [withTeacher] = await withTeacherInfo(ctx, [
        await Homework.findOne(scope(ctx, { _id: hw._id }))
          .populate('teacherId', 'firstName lastName employeeNo')
          .lean(),
      ] as any[]);
      return withTeacher;
    },
  });

  api.route({
    method: 'get',
    path: '/homework/:id',
    tags,
    auth: 'school',
    permission: 'homework:read',
    summary: 'Get homework (parents also receive each of their children’s submissions)',
    params: idParams,
    response: HomeworkRes.extend({
      familySubmissions: z
        .array(
          z.object({
            studentId: objectId(),
            name: z.string(),
            admissionNo: z.string(),
            submission: SubmissionRes.nullable(),
          }),
        )
        .optional()
        .openapi({ description: 'Parents only: one entry per child of theirs in this section' }),
      attachments: z.array(AttachmentRes).openapi({
        description:
          'The attachments of `attachmentIds` this user may download (GET /files/{id}/download), with name, type and size. ' +
          'Never a storage path or a public URL.',
      }),
    }),
    handler: async ({ ctx, params }) => {
      const hw = await Homework.findOne(scope(ctx, { _id: oid(params.id) }))
        .populate('subjectId', 'name code')
        .populate('sectionId', 'name classId')
        .populate('teacherId', 'firstName lastName employeeNo')
        .lean();
      if (!hw) throw notFound('Homework');
      await assertHomeworkVisible(ctx, hw);
      let familySubmissions;
      if (ctx.role === 'parent') {
        const kids = await childrenInSection(ctx, hw.sectionId);
        const subs = await HomeworkSubmission.find(
          scope(ctx, { homeworkId: hw._id, studentId: { $in: kids.map((k) => k._id) } }),
        ).lean();
        familySubmissions = kids.map((k) => ({
          studentId: k._id,
          name: [k.firstName, k.lastName].filter(Boolean).join(' '),
          admissionNo: k.admissionNo,
          submission: subs.find((x) => x.studentId.toString() === k._id.toString()) ?? null,
        }));
      }
      const [withTeacher] = await withTeacherInfo(ctx, [hw]);
      return { ...withTeacher, familySubmissions, attachments: await attachmentsFor(ctx, hw.attachmentIds) };
    },
  });

  api.route({
    method: 'patch',
    path: '/homework/:id',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Update homework',
    description:
      'Administrators may (re)attribute the homework with `teacherId` (must teach the class-subject); teachers cannot change attribution. ' +
      'Marks already given are never changed: `maxMarks` cannot drop below the highest mark awarded.',
    params: idParams,
    body: z.object({
      title: z.string().trim().min(3).max(150).optional(),
      description: z.string().trim().min(3).max(5000).optional(),
      dueDate: isoDate().optional(),
      maxMarks: z.number().int().min(0).max(1000).optional(),
      status: z.enum(['published', 'closed']).optional(),
      teacherId: objectId().optional(),
    }),
    response: HomeworkRes,
    handler: async ({ ctx, params, body }) => {
      const hw = await findOwned(Homework, ctx, params.id, 'Homework');
      await assertHomeworkManageable(ctx, hw);
      const { teacherId, ...rest } = body;
      const set: Record<string, unknown> = { ...rest };
      if (body.dueDate) {
        if (body.dueDate < formatDateOnly(hw.assignedOn))
          throw badRequest('dueDate cannot be before the assigned date', { field: 'dueDate' });
        set.dueDate = parseDateOnly(body.dueDate);
      }
      if (body.maxMarks !== undefined) {
        const top = await HomeworkSubmission.findOne(scope(ctx, { homeworkId: hw._id, marks: { $ne: null } }))
          .sort({ marks: -1 })
          .select('marks')
          .lean();
        if (top?.marks != null && top.marks > body.maxMarks)
          throw unprocessable(`A submission already has ${top.marks} marks; maximum marks cannot be lower`, {
            field: 'maxMarks',
          });
      }
      if (teacherId !== undefined && String(hw.teacherId ?? '') !== teacherId) {
        if (ctx.role === 'teacher')
          throw forbidden('Only an administrator can change who the homework is attributed to');
        await assertTeacherEligible(ctx, hw.sectionId, hw.subjectId, teacherId);
        set.teacherId = oid(teacherId);
        set.teacherSource = 'explicit';
      }
      await Homework.updateOne(scope(ctx, { _id: hw._id }), { $set: set });
      await audit(ctx, {
        action: 'homework.update',
        entityType: 'Homework',
        entityId: hw._id,
        metadata: {
          fields: Object.keys(set),
          ...(set.teacherId ? { fromTeacherId: hw.teacherId?.toString() ?? null, toTeacherId: teacherId } : {}),
        },
      });
      const updated = await Homework.findOne(scope(ctx, { _id: hw._id }))
        .populate('subjectId', 'name code')
        .populate('sectionId', 'name classId')
        .populate('teacherId', 'firstName lastName employeeNo')
        .lean();
      const [withTeacher] = await withTeacherInfo(ctx, [updated!]);
      return withTeacher;
    },
  });

  api.route({
    method: 'delete',
    path: '/homework/:id',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Delete homework (only when nothing has been submitted)',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const hw = await findOwned(Homework, ctx, params.id, 'Homework');
      await assertHomeworkManageable(ctx, hw);
      if (await HomeworkSubmission.exists(scope(ctx, { homeworkId: hw._id })))
        throw conflict('Homework has submissions; close it instead');
      await Homework.deleteOne(scope(ctx, { _id: hw._id }));
      await audit(ctx, { action: 'homework.delete', entityType: 'Homework', entityId: hw._id });
    },
  });

  api.route({
    method: 'post',
    path: '/homework/:id/submissions',
    tags,
    auth: 'school',
    permission: 'homework:submit',
    roles: ['parent'],
    summary: 'Hand in (or update) homework for one of your children',
    description:
      'Parents submit on behalf of a child of theirs who is in the homework’s section. Attachments must be submission files this parent uploaded for that child.',
    params: idParams,
    body: z
      .object({
        studentId: objectId().openapi({ description: 'The child this submission is for' }),
        text: z.string().trim().max(10_000).optional(),
        attachmentIds: z.array(objectId()).max(10).optional(),
      })
      .refine((v) => v.text || v.attachmentIds?.length, { message: 'Provide text or attachments' }),
    response: SubmissionRes,
    status: 201,
    handler: async ({ ctx, params, body }) => {
      const hw = await findOwned(Homework, ctx, params.id, 'Homework');
      await assertHomeworkVisible(ctx, hw);
      const child = await assertSubmittingChild(ctx, hw.sectionId, body.studentId);
      if (hw.status === 'closed') throw conflict('Homework is closed for submissions');
      if (body.attachmentIds?.length) {
        const owned = await FileObject.countDocuments(
          scope(ctx, {
            _id: { $in: body.attachmentIds.map(oid) },
            uploadedBy: oid(ctx.userId),
            category: 'submission',
            studentId: child._id,
          }),
        );
        if (owned !== body.attachmentIds.length)
          throw badRequest('Attachments must be submission files you uploaded for this child');
      }
      const existing = await HomeworkSubmission.findOne(
        scope(ctx, { homeworkId: hw._id, studentId: child._id }),
      ).lean();
      if (existing?.status === 'graded') throw conflict('Submission has already been graded');
      const now = new Date();
      const isLate = now > addDays(hw.dueDate, 1);
      const doc = await HomeworkSubmission.findOneAndUpdate(
        scope(ctx, { homeworkId: hw._id, studentId: child._id }),
        {
          $set: {
            text: body.text,
            attachmentIds: (body.attachmentIds ?? []).map(oid),
            submittedAt: now,
            isLate,
            status: 'submitted',
          },
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean();
      return doc;
    },
  });

  api.route({
    method: 'get',
    path: '/homework/:id/submissions',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Submission roster for a homework (who submitted, late, graded)',
    params: idParams,
    response: z.object({
      homeworkId: objectId(),
      totals: z.object({
        students: z.number(),
        submitted: z.number(),
        late: z.number(),
        graded: z.number(),
        pending: z.number(),
      }),
      students: z.array(
        z.object({
          studentId: objectId(),
          name: z.string(),
          admissionNo: z.string(),
          submission: SubmissionRes.nullable(),
        }),
      ),
    }),
    handler: async ({ ctx, params }) => {
      const hw = await findOwned(Homework, ctx, params.id, 'Homework');
      await assertHomeworkManageable(ctx, hw);
      const [students, subs] = await Promise.all([
        Student.find(scope(ctx, { sectionId: hw.sectionId, status: 'active' }))
          .select('firstName lastName admissionNo')
          .sort({ firstName: 1 })
          .lean(),
        HomeworkSubmission.find(scope(ctx, { homeworkId: hw._id })).lean(),
      ]);
      const byStudent = new Map(subs.map((s) => [s.studentId.toString(), s]));
      const rows = students.map((s) => ({
        studentId: s._id,
        name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
        admissionNo: s.admissionNo,
        submission: byStudent.get(s._id.toString()) ?? null,
      }));
      return {
        homeworkId: hw._id,
        totals: {
          students: rows.length,
          submitted: subs.length,
          late: subs.filter((s) => s.isLate).length,
          graded: subs.filter((s) => s.status === 'graded').length,
          pending: rows.length - subs.length,
        },
        students: rows,
      };
    },
  });

  api.route({
    method: 'post',
    path: '/homework/:id/submissions/:submissionId/grade',
    tags,
    auth: 'school',
    permission: 'homework:manage',
    summary: 'Grade a submission',
    params: z.object({ id: objectId(), submissionId: objectId() }),
    body: z.object({ marks: z.number().min(0).max(1000).optional(), feedback: z.string().trim().max(2000).optional() }),
    response: SubmissionRes,
    handler: async ({ ctx, params, body }) => {
      const hw = await findOwned(Homework, ctx, params.id, 'Homework');
      await assertHomeworkManageable(ctx, hw);
      if (body.marks !== undefined && hw.maxMarks !== undefined && hw.maxMarks !== null && body.marks > hw.maxMarks) {
        throw unprocessable(`Marks cannot exceed ${hw.maxMarks}`);
      }
      const sub = await HomeworkSubmission.findOneAndUpdate(
        scope(ctx, { _id: oid(params.submissionId), homeworkId: hw._id }),
        { $set: { ...body, status: 'graded', gradedBy: oid(ctx.userId), gradedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!sub) throw notFound('Submission');
      await audit(ctx, { action: 'homework.graded', entityType: 'HomeworkSubmission', entityId: sub._id });
      return sub;
    },
  });
}
