import type { Api } from '../../utils/api';
import { crudRoutes, refuseIfReferenced } from '../../utils/crud';
import { docBase, email, idParams, isoDate, objectId, paginationQuery, phonePk, z } from '../../utils/zod';
import { archiveStudent, unarchiveStudent } from '../users/archive.service';
import { checkStudentDeletion, deleteStudent } from './student-deletion';
import {
  Parent,
  PROMOTION_ACTIONS,
  SETTABLE_STUDENT_STATUSES,
  STUDENT_STATUSES,
  Student,
} from './student.models';
import { AccountSummaryRes, ProvisionedAccountRes } from '../users/account-schemas';
import { accountFor, provisionParentAccount } from '../users/users.service';
import { notFound } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import * as svc from './students.service';
import { ParentInline, StudentBody } from './student.schemas';

export const StudentRes = z
  .object({
    ...docBase,
    campusId: objectId(),
    admissionNo: z.string(),
    rollNo: z.string().optional(),
    firstName: z.string(),
    lastName: z.string().optional(),
    gender: z.enum(['male', 'female', 'other']),
    dateOfBirth: z.string().optional(),
    bloodGroup: z.string().optional(),
    address: z.string().optional(),
    sessionId: z.any(),
    classId: z.any(),
    sectionId: z.any(),
    guardians: z.array(z.object({ parentId: z.any(), relation: z.string(), isPrimary: z.boolean() })),
    status: z.enum(STUDENT_STATUSES),
    archive: z
      .object({ previousStatus: z.string(), archivedAt: z.string(), reason: z.string().optional() })
      .optional()
      .openapi({ description: 'Present while archived' }),
    feeConcession: z.object({ type: z.string(), value: z.number(), reason: z.string().optional() }).optional(),
    bFormNo: z.string().optional().openapi({ description: 'Only for users with students:manage' }),
    medicalNotes: z.string().optional().openapi({ description: 'Only for users with students:manage' }),
  })
  .openapi('Student');

const ParentRes = z
  .object({
    ...docBase,
    name: z.string(),
    relation: z.string(),
    phone: z.string(),
    whatsapp: z.string().optional(),
    email: z.string().optional(),
    cnic: z.string().optional(),
    occupation: z.string().optional(),
    address: z.string().optional(),
    preferredChannel: z.enum(['in_app', 'sms', 'whatsapp', 'email']),
    userId: objectId().optional(),
  })
  .openapi('Parent');

export const EnrollmentRes = z
  .object({
    ...docBase,
    studentId: objectId(),
    sessionId: z.any(),
    classId: z.any(),
    sectionId: z.any(),
    campusId: z.any(),
    rollNo: z.string().optional(),
    enrollmentDate: z.any().optional(),
    status: z.string(),
    statusChangedAt: z.any().optional(),
    statusReason: z.string().optional(),
    promotionDetails: z
      .object({
        fromEnrollmentId: objectId().optional(),
        fromSectionId: objectId().optional(),
        fromClassId: objectId().optional(),
        fromSessionId: objectId().optional(),
        promotedAt: z.any().optional(),
        promotedBy: objectId().optional(),
        remarks: z.string().optional(),
      })
      .optional(),
  })
  .openapi('StudentEnrollment');

export function registerStudentRoutes(api: Api) {
  const tags = ['Students'];

  api.route({
    method: 'get',
    path: '/students',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'List / search students',
    description:
      'Staff see active students by default (pass `status` to change). Parents see only their children; students only themselves.',
    query: paginationQuery.extend({
      q: z.string().max(100).optional(),
      classId: objectId().optional(),
      sectionId: objectId().optional(),
      campusId: objectId().optional(),
      sessionId: objectId().optional(),
      status: z.enum(STUDENT_STATUSES).optional(),
      gender: z.enum(['male', 'female', 'other']).optional(),
    }),
    response: StudentRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listStudents(ctx, query),
  });

  api.route({
    method: 'post',
    path: '/students/promotion-preview',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Preview student promotions and session rollover',
    description:
      'Calculates proposed class progression, matching sections, repeating students, and terminal-class graduation lists before committing.',
    body: z.object({
      fromSessionId: objectId(),
      toSessionId: objectId(),
      campusId: objectId().optional(),
      classId: objectId().optional(),
    }),
    response: z.any(),
    handler: ({ ctx, body }) => svc.previewPromotionBatch(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/students/promotion-batches',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Execute a confirmed student promotion batch',
    description:
      'Promotes, repeats, graduates, or manually assigns students to the target academic session atomically, creating a tracked PromotionBatch.',
    body: z.object({
      fromSessionId: objectId(),
      toSessionId: objectId(),
      campusId: objectId(),
      items: z
        .array(
          z.object({
            studentId: objectId(),
            action: z.enum(PROMOTION_ACTIONS),
            toClassId: objectId().optional(),
            toSectionId: objectId().optional(),
            toRollNo: z.string().trim().max(30).optional(),
            remarks: z.string().trim().max(300).optional(),
          }),
        )
        .min(1)
        .max(1000),
    }),
    response: z.any(),
    handler: ({ ctx, body }) => svc.executePromotionBatch(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/students/promotion-batches',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'List previous promotion batches',
    query: z.object({
      campusId: objectId().optional(),
      toSessionId: objectId().optional(),
      fromSessionId: objectId().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    response: z.any(),
    handler: ({ ctx, query }) => svc.listPromotionBatches(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/students/promotion-batches/:id',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'Get details of a promotion batch',
    params: idParams,
    response: z.any(),
    handler: ({ ctx, params }) => svc.getPromotionBatch(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/students/promotion-batches/:id/rollback-check',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Check if a promotion batch can be safely rolled back',
    description:
      'Inspects whether affected students have acquired new-session records (attendance, invoices, marks, homework) that block rollback.',
    params: idParams,
    response: z.any(),
    handler: ({ ctx, params }) => svc.checkPromotionBatchRollback(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/students/promotion-batches/:id/rollback',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Rollback an eligible promotion batch',
    description:
      'Restores previous student class/section assignments, statuses, and source enrollments. Refused if new-session activity exists.',
    params: idParams,
    body: z.object({
      reason: z.string().trim().min(3).max(300),
    }),
    response: z.any(),
    handler: ({ ctx, params, body }) => svc.rollbackPromotionBatch(ctx, params.id, body),
  });

  api.route({
    method: 'get',
    path: '/students/:id',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'Student profile',
    params: idParams,
    response: StudentRes,
    handler: ({ ctx, params }) => svc.getStudent(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/students/:id/enrollments',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'Student session enrollment history',
    description: 'Returns all academic session enrollments for this student across sessions.',
    params: idParams,
    response: z.array(EnrollmentRes),
    handler: ({ ctx, params }) => svc.getStudentEnrollments(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/students/:id/journey',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'Complete student academic journey & historical record',
    description:
      'Returns the complete academic history of a student across all sessions (or filtered by sessionId), including historical attendance, fee transactions, exam results, subjects, teachers, leaves, and promotion details.',
    params: idParams,
    query: z.object({
      sessionId: objectId().optional(),
    }),
    response: z.any(),
    handler: ({ ctx, params, query }) => svc.getStudentJourney(ctx, params.id, query.sessionId),
  });

  api.route({
    method: 'post',
    path: '/students',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Enrol a student (parent logins are provisioned per school settings; students get no login)',
    description:
      'Validates that the section belongs to the class, session and campus, enforces section capacity (`SECTION_FULL`) and the plan student limit (`PLAN_LIMIT_REACHED`).',
    body: StudentBody,
    response: StudentRes.extend({
      accounts: z.array(ProvisionedAccountRes),
      accountsSkipped: z.array(z.string()),
    }),
    status: 201,
    handler: ({ ctx, body }) => svc.createStudent(ctx, body),
  });

  api.route({
    method: 'patch',
    path: '/students/:id',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Update a student',
    params: idParams,
    body: StudentBody.partial(),
    response: StudentRes,
    handler: ({ ctx, params, body }) => svc.updateStudent(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/students/:id/status',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Change enrolment status (active, suspended, left, graduated)',
    params: idParams,
    body: z.object({ status: z.enum(SETTABLE_STUDENT_STATUSES), reason: z.string().trim().max(300).optional() }),
    response: StudentRes,
    handler: ({ ctx, params, body }) => svc.changeStatus(ctx, params.id, body.status, body.reason),
  });

  api.route({
    method: 'get',
    path: '/students/:id/accounts',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Parent portal logins linked to a student (account is null when the parent has none)',
    params: idParams,
    response: z.object({
      parents: z.array(z.object({ parentId: objectId(), name: z.string(), account: AccountSummaryRes.nullable() })),
    }),
    handler: async ({ ctx, params }) => {
      const st = await Student.findOne(scope(ctx, { _id: oid(params.id), ...campusScope(ctx) }))
        .select('_id guardians')
        .lean();
      if (!st) throw notFound('Student');
      const parents = await Parent.find(scope(ctx, { _id: { $in: st.guardians.map((g) => g.parentId) } }))
        .select('_id name')
        .lean();
      return {
        parents: await Promise.all(
          parents.map(async (p) => ({
            parentId: p._id,
            name: p.name,
            account: await accountFor(ctx, 'parentId', p._id),
          })),
        ),
      };
    },
  });

  api.route({
    method: 'put',
    path: '/students/:id/guardians/:parentId',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Link an existing parent to a student, or change the link (relation, primary guardian)',
    description:
      'Both records must already exist in your school (the student in your campuses); nothing is created. A parent can have any number of children; ' +
      `a student up to ${svc.MAX_GUARDIANS} parents/guardians (\`GUARDIAN_LIMIT\`). Making a guardian primary makes the others not primary. ` +
      'The parent’s portal login (if any) sees the student at once. Returns the student.',
    params: z.object({ id: objectId(), parentId: objectId() }),
    body: z.object({
      relation: z.enum(svc.GUARDIAN_RELATIONS).optional(),
      isPrimary: z.boolean().optional(),
    }),
    response: StudentRes,
    handler: ({ ctx, params, body }) => svc.linkGuardian(ctx, params.id, params.parentId, body),
  });

  api.route({
    method: 'delete',
    path: '/students/:id/guardians/:parentId',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Unlink a parent from a student (the parent and the student records stay)',
    description:
      'Only the link is removed: the parent record and its login are kept, and the parent no longer sees this student. ' +
      'If the primary guardian is unlinked, the next one becomes primary. Returns the student.',
    params: z.object({ id: objectId(), parentId: objectId() }),
    response: StudentRes,
    handler: ({ ctx, params }) => svc.unlinkGuardian(ctx, params.id, params.parentId),
  });

  api.route({
    method: 'get',
    path: '/students/:id/deletion-check',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Can this student record be deleted? (records entered by mistake only)',
    description:
      'Deletion is blocked once the student’s or a parent’s portal account has been activated, a fee payment was received or a certificate issued — archive the student instead. ' +
      'Otherwise lists everything that would be removed with the record.',
    params: idParams,
    response: z.object({
      canDelete: z.boolean(),
      blockers: z.array(z.object({ kind: z.string(), count: z.number(), label: z.string() })),
      willRemove: z.object({
        invoices: z.number(),
        attendanceRecords: z.number(),
        marks: z.number(),
        homeworkSubmissions: z.number(),
        documents: z.number(),
        logins: z.array(z.string()),
        parentRecords: z.array(z.string()),
      }),
    }),
    handler: ({ ctx, params }) => checkStudentDeletion(ctx, params.id),
  });

  api.route({
    method: 'delete',
    path: '/students/:id',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Permanently delete a student record entered by mistake',
    description:
      'Only when `deletion-check` allows it (otherwise 409 `IN_USE`: archive instead). Also removes the student’s unpaid invoices, attendance, marks, submissions, documents, ' +
      'unused logins, and a parent record that belongs to no other student.',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    status: 204,
    handler: ({ ctx, params, body }) => deleteStudent(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/students/:id/archive',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Archive a student (keeps all history; hides from active lists; suspends logins)',
    description:
      'The student’s login is suspended, and each parent login too unless that parent has another current child. Restore with `POST /students/{id}/unarchive`. ' +
      'List archived students with `GET /students?status=archived`.',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    response: StudentRes.extend({ loginsSuspended: z.number() }),
    handler: ({ ctx, params, body }) => archiveStudent(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/students/:id/unarchive',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Restore an archived student (previous status and logins come back as they were)',
    params: idParams,
    response: StudentRes.extend({ loginsRestored: z.number() }),
    handler: ({ ctx, params }) => unarchiveStudent(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/students/promote',
    tags,
    auth: 'school',
    permission: 'students:manage',
    summary: 'Promote students from one section to another (e.g. next session)',
    body: z.object({
      fromSectionId: objectId(),
      toSectionId: objectId(),
      studentIds: z.array(objectId()).max(200).optional(),
    }),
    response: z.object({ promoted: z.number(), toSectionId: objectId() }),
    handler: ({ ctx, body }) => svc.promoteStudents(ctx, body),
  });

  // Before the /parents/:id routes, so "unlinked" is never read as an id.
  api.route({
    method: 'get',
    path: '/parents/unlinked',
    tags,
    auth: 'school',
    permission: 'parents:read',
    summary: 'Parent records not linked to any student (e.g. left over after a correction), for review or deletion',
    description:
      'Includes whether the parent has a portal login. Such parents can be deleted (DELETE /parents/{id}); a parent still linked to a student cannot.',
    query: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(500) }),
    response: z.object({ total: z.number(), items: z.array(ParentRes.extend({ hasLogin: z.boolean() })) }),
    handler: async ({ ctx, query }) => {
      const linked = await Student.distinct('guardians.parentId', scope(ctx));
      const filter = scope(ctx, { _id: { $nin: linked } });
      const [total, items] = await Promise.all([
        Parent.countDocuments(filter),
        Parent.find(filter).sort({ name: 1 }).limit(query.limit).lean(),
      ]);
      return { total, items: items.map((p) => ({ ...p, hasLogin: Boolean(p.userId) })) };
    },
  });

  crudRoutes(api, {
    path: '/parents',
    tag: 'Parents',
    label: 'parent',
    model: Parent,
    read: 'parents:read',
    write: 'parents:manage',
    createSchema: ParentInline.extend({ preferredChannel: z.enum(['in_app', 'sms', 'whatsapp', 'email']).optional() }),
    response: ParentRes,
    sort: { name: 1 },
    searchFields: ['name', 'phone', 'cnic', 'email'],
    beforeDelete: refuseIfReferenced([[Student, 'guardians.parentId', 'students']]),
  });

  api.route({
    method: 'get',
    path: '/parents/:id/account',
    tags: ['Parents'],
    auth: 'school',
    permission: 'parents:read',
    summary: 'The portal login of a parent record (null when the parent has none)',
    params: idParams,
    response: z.object({ account: AccountSummaryRes.nullable() }),
    handler: async ({ ctx, params }) => {
      const parent = await Parent.findOne(scope(ctx, { _id: oid(params.id) }))
        .select('_id')
        .lean();
      if (!parent) throw notFound('Parent');
      return { account: await accountFor(ctx, 'parentId', parent._id) };
    },
  });

  api.route({
    method: 'post',
    path: '/parents/:id/account',
    tags: ['Parents'],
    auth: 'school',
    permission: ['parents:read', 'users:manage'],
    summary: 'Create the portal login for an existing parent record (idempotent)',
    description:
      'One login per parent record, covering all of their linked children. Returns the existing login (`created: false`) instead of creating a duplicate. ' +
      'Uses the parent’s email (if free) and phone; new logins are `pending` until the activation link is used.',
    params: idParams,
    response: ProvisionedAccountRes,
    handler: ({ ctx, params }) => provisionParentAccount(ctx, params.id, { provisionedBy: 'manual' }),
  });

  api.route({
    method: 'get',
    path: '/parents/:id/children',
    tags: ['Parents'],
    auth: 'school',
    permission: 'parents:read',
    summary: 'Students linked to a parent',
    params: idParams,
    response: z.array(StudentRes.partial()),
    handler: ({ ctx, params }) => svc.parentChildren(ctx, params.id),
  });
}
