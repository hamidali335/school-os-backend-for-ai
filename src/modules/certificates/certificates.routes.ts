import { nextNumber } from '../../database/counter.model';
import { publicLookupLimiter } from '../../middleware/rate-limit';
import { SELF_SCOPED_ROLES, STAFF_ROLES } from '../../config/permissions';
import { renderCertificate } from '../../services/pdf';
import { deleteFile, dispositionName, readFile, saveBuffer, uploadSingle } from '../../services/storage';
import type { SchoolContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors';
import { formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { paginate, searchRegex } from '../../utils/pagination';
import { assertRefs, findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { assertStudentVisible, teacherSectionIds, visibleStudentIds } from '../academics/access.service';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { loadBrand } from '../branding/branding.service';
import { Homework } from '../homework/homework.models';
import { assertSubmittingChild } from '../homework/homework.routes';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { studentIdsMatching } from '../students/student-search';
import { CERTIFICATE_TYPES, Certificate, FILE_CATEGORIES, FileObject } from './files.model';
import {
  certificateLook,
  createCustomTemplate,
  FIELDS as TEMPLATE_FIELDS,
  fillTemplate,
  getTemplate,
  listTemplates,
  recordValues,
  resetTemplate,
  saveTemplate,
  templateForType,
} from './certificate-templates';

const FileRes = z
  .object({
    ...docBase,
    category: z.enum(FILE_CATEGORIES),
    originalName: z.string(),
    mimeType: z.string(),
    size: z.number(),
    studentId: objectId().optional(),
    employeeId: objectId().optional(),
    homeworkId: objectId().optional(),
    documentType: z.string().optional(),
    description: z.string().optional(),
    visibleToFamily: z.boolean(),
  })
  .openapi('FileObject');

const CertificateRes = z
  .object({
    ...docBase,
    studentId: z.any(),
    type: z.enum(CERTIFICATE_TYPES),
    serialNo: z.string(),
    title: z.string(),
    body: z.string(),
    issueDate: z.string(),
    issuedByName: z.string().optional(),
    fileId: objectId().optional(),
    status: z.enum(['issued', 'revoked']),
    revokedReason: z.string().optional(),
    templateKey: z.string().optional(),
    details: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  })
  .openapi('Certificate');

const UPLOAD_PERMISSION: Record<(typeof FILE_CATEGORIES)[number], (ctx: SchoolContext) => boolean> = {
  student_document: (c) => c.permissions.has('students:manage'),
  certificate: (c) => c.permissions.has('certificates:issue'),
  employee_document: (c) => c.permissions.has('employees:manage'),
  homework: (c) => c.permissions.has('homework:manage'),
  submission: (c) => c.permissions.has('homework:submit'),
  school: (c) => c.permissions.has('school:settings'),
};

/** Central file authorisation rule (tenant check already done by the query). */
export async function canAccessFile(ctx: SchoolContext, file: any): Promise<boolean> {
  const family = await visibleStudentIds(ctx);
  if (family) {
    if (file.category === 'homework' && file.homeworkId) {
      const hw = await Homework.findOne(scope(ctx, { _id: file.homeworkId }))
        .select('sectionId')
        .lean();
      if (!hw) return false;
      const kids = await Student.find(scope(ctx, { _id: { $in: family.map(oid) } }))
        .select('sectionId')
        .lean();
      return kids.some((k) => k.sectionId.toString() === hw.sectionId.toString());
    }
    if (!file.studentId || !family.includes(file.studentId.toString())) return false;
    return file.category === 'submission' || file.visibleToFamily;
  }
  if (!STAFF_ROLES.has(ctx.role)) return false;
  switch (file.category) {
    case 'employee_document':
      return ctx.permissions.has('employees:manage') || ctx.permissions.has('payroll:manage');
    case 'homework':
    case 'submission':
      if (ctx.role !== 'teacher') return ctx.permissions.has('homework:read');
      if (file.homeworkId) {
        const hw = await Homework.findOne(scope(ctx, { _id: file.homeworkId }))
          .select('sectionId')
          .lean();
        return !!hw && (await teacherSectionIds(ctx)).includes(hw.sectionId.toString());
      }
      return file.uploadedBy?.toString() === ctx.userId;
    case 'student_document':
    case 'certificate':
      return ctx.permissions.has('students:manage') || ctx.permissions.has('certificates:issue');
    default:
      return ctx.permissions.has('school:read');
  }
}

type IssueInput = {
  type: (typeof CERTIFICATE_TYPES)[number];
  templateKey?: string;
  /** Values staff typed for fields the record does not have (conduct, achievement...). */
  values?: Record<string, string>;
  /** Wording edited for this one certificate; may still contain {{placeholders}}. */
  title?: string;
  body?: string;
  issueDate: Date;
};

/** The template and every filled value for one student, without issuing anything. */
async function prepareCertificate(ctx: SchoolContext, studentId: string, input: IssueInput, serialNo?: string) {
  const template = input.templateKey
    ? await getTemplate(ctx, input.templateKey)
    : await templateForType(ctx, input.type);
  const rec = await recordValues(ctx, studentId, input.issueDate);
  const tpl = {
    type: template.type,
    title: input.title ?? template.title,
    body: input.body ?? template.body,
    details: template.details,
  };
  const filled = fillTemplate(tpl, rec.values, input.values ?? {}, serialNo);
  const blockers: string[] = [];
  if (template.type === 'fee_clearance' && rec.outstanding > 0)
    blockers.push(
      `Rs ${rec.outstanding.toLocaleString('en-PK')} is still outstanding, so a fee clearance certificate cannot be issued.`,
    );
  const missing = filled.missing.filter((m) => m.key !== 'certificate.serialNo');
  if (missing.length) blockers.push(`Missing: ${missing.map((m) => m.label).join(', ')}`);
  return {
    template: { key: template.key, name: template.name, type: template.type, note: template.note ?? null },
    student: rec.student,
    studentStatus: rec.studentStatus,
    ...filled,
    missing,
    blockers,
  };
}

/** Renders, stores and records one certificate from its template. */
async function issueCertificate(ctx: SchoolContext, studentId: string, input: IssueInput) {
  const check = await prepareCertificate(ctx, studentId, input);
  if (check.blockers.length)
    throw unprocessable(
      check.blockers.join(' '),
      { missing: check.missing, blockers: check.blockers },
      check.template.type === 'fee_clearance' && check.blockers[0].includes('outstanding')
        ? 'FEES_OUTSTANDING'
        : 'CERTIFICATE_INCOMPLETE',
    );
  const year = input.issueDate.getUTCFullYear();
  const serialNo = await nextNumber(ctx.schoolId, `certificate-${year}`, `CERT-${year}-`, 5);
  const filled = await prepareCertificate(ctx, studentId, input, serialNo);
  const student = filled.student;
  // The school's branding as it is today is baked into the stored PDF, so an issued
  // certificate never changes if the logo or design changes later.
  const brand = await loadBrand(ctx.schoolId);
  const pdf = await renderCertificate(
    {
      title: filled.title,
      serialNo,
      issueDate: input.issueDate,
      body: filled.body,
      details: filled.details,
      emphasis: filled.emphasis,
      issuedBy: ctx.name,
      ...certificateLook(filled.template.type, `${student.firstName} ${student.lastName ?? ''}`.trim()),
    },
    brand,
  );
  const stored = await saveBuffer(ctx.schoolId, 'certificate', pdf, 'application/pdf', `${serialNo}.pdf`);
  const file = await FileObject.create({
    schoolId: ctx.schoolId,
    category: 'certificate',
    originalName: `${serialNo}.pdf`,
    mimeType: 'application/pdf',
    ...stored,
    studentId: student._id,
    documentType: filled.template.type,
    visibleToFamily: true,
    uploadedBy: ctx.userId,
  });
  const cert = await Certificate.create({
    schoolId: ctx.schoolId,
    studentId: student._id,
    type: filled.template.type,
    templateKey: filled.template.key,
    serialNo,
    title: filled.title,
    body: filled.body,
    details: filled.details.map(([label, value]) => ({ label, value })),
    issueDate: input.issueDate,
    issuedBy: ctx.userId,
    issuedByName: ctx.name,
    fileId: file._id,
  });
  await audit(ctx, {
    action: 'certificate.issue',
    entityType: 'Certificate',
    entityId: cert._id,
    metadata: { type: filled.template.type, template: filled.template.key, serialNo },
  });
  return cert.toObject();
}

async function issueDateFor(ctx: SchoolContext, issueDate?: string) {
  const school = await School.findById(ctx.schoolId).select('settings.timezone').lean();
  return issueDate ? parseDateOnly(issueDate) : parseDateOnly(todayInTz(school?.settings?.timezone ?? 'Asia/Karachi'));
}

const IssueFields = {
  type: z.enum(CERTIFICATE_TYPES),
  templateKey: z.string().trim().max(40).optional(),
  values: z.record(z.string(), z.string().max(300)).optional(),
  title: z.string().trim().min(3).max(120).optional(),
  body: z.string().trim().min(10).max(3000).optional(),
  issueDate: isoDate().optional(),
};

const BULK_MAX = 200;

export function registerCertificateRoutes(api: Api) {
  const ftags = ['Files & Documents'];
  const ctags = ['Certificates'];

  api.route({
    method: 'post',
    path: '/files',
    tags: ftags,
    auth: 'school',
    permission: 'files:upload',
    summary: 'Upload a private file (student document, homework attachment, submission...)',
    description:
      'multipart/form-data with a single `file` field. Allowed: PDF, JPEG, PNG, WebP, Word, Excel, plain text; content is checked against the declared type. ' +
      'Files are never publicly reachable — download through `GET /files/{id}/download`.',
    upload: {
      middleware: uploadSingle('file'),
      field: 'file',
      extraFields: z.object({
        category: z.enum(FILE_CATEGORIES),
        studentId: objectId().optional(),
        employeeId: objectId().optional(),
        homeworkId: objectId().optional(),
        documentType: z.string().max(60).optional(),
        description: z.string().max(300).optional(),
        visibleToFamily: z.enum(['true', 'false']).optional(),
      }),
    },
    response: FileRes,
    status: 201,
    handler: async ({ ctx, req }) => {
      const file = req.file;
      if (!file) throw badRequest('file is required');
      const fields = z
        .object({
          category: z.enum(FILE_CATEGORIES),
          studentId: objectId().optional(),
          employeeId: objectId().optional(),
          homeworkId: objectId().optional(),
          documentType: z.string().max(60).optional(),
          description: z.string().max(300).optional(),
          visibleToFamily: z.enum(['true', 'false']).optional(),
        })
        .safeParse(req.body ?? {});
      if (!fields.success)
        throw badRequest(
          'Invalid upload fields',
          fields.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const f = fields.data;
      if (!UPLOAD_PERMISSION[f.category](ctx)) throw forbidden(`You cannot upload ${f.category} files`);
      await assertRefs(ctx, [
        [Student, f.studentId, 'studentId'],
        [Employee, f.employeeId, 'employeeId'],
        [Homework, f.homeworkId, 'homeworkId'],
      ]);
      if (f.category === 'submission') {
        // Parents hand in homework for their own child in that homework's class.
        if (ctx.role !== 'parent') throw forbidden('Submission files are uploaded by parents');
        if (!f.homeworkId || !f.studentId)
          throw badRequest('homeworkId and studentId are required for submission files');
        const hw = await Homework.findOne(scope(ctx, { _id: oid(f.homeworkId) }))
          .select('sectionId')
          .lean();
        if (!hw) throw notFound('Homework');
        await assertSubmittingChild(ctx, hw.sectionId, f.studentId);
      }
      if (f.category === 'student_document' && !f.studentId)
        throw badRequest('studentId is required for student documents');
      const stored = await saveBuffer(ctx.schoolId, f.category, file.buffer, file.mimetype, file.originalname);
      const doc = await FileObject.create({
        schoolId: ctx.schoolId,
        category: f.category,
        originalName: file.originalname.slice(0, 200),
        mimeType: file.mimetype,
        ...stored,
        studentId: f.studentId,
        employeeId: f.employeeId,
        homeworkId: f.homeworkId,
        documentType: f.documentType,
        description: f.description,
        visibleToFamily: f.visibleToFamily === 'true',
        uploadedBy: ctx.userId,
      });
      await audit(ctx, {
        action: 'file.upload',
        entityType: 'FileObject',
        entityId: doc._id,
        metadata: { category: f.category, size: stored.size },
      });
      const { storageKey: _k, sha256: _h, ...safe } = doc.toObject();
      return safe;
    },
  });

  api.route({
    method: 'get',
    path: '/files/:id/download',
    tags: ftags,
    auth: 'school',
    permission: 'files:read',
    summary: 'Download a file (authorised per file)',
    params: idParams,
    produces: 'application/pdf',
    handler: async ({ ctx, params, res }) => {
      const file = await findOwned(FileObject, ctx, params.id, 'File');
      if (!(await canAccessFile(ctx, file))) throw notFound('File');
      const buf = await readFile(file.storageKey);
      await audit(ctx, { action: 'file.download', entityType: 'FileObject', entityId: file._id });
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', dispositionName(file.originalName));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(buf);
    },
  });

  api.route({
    method: 'delete',
    path: '/files/:id',
    tags: ftags,
    auth: 'school',
    permission: 'files:upload',
    summary: 'Delete a file (uploader, or a user allowed to manage that category)',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const file = await findOwned(FileObject, ctx, params.id, 'File');
      const own = file.uploadedBy?.toString() === ctx.userId;
      if (!own && !UPLOAD_PERMISSION[file.category as (typeof FILE_CATEGORIES)[number]](ctx)) throw forbidden();
      // Parents may only delete files they uploaded themselves.
      if (!own && SELF_SCOPED_ROLES.has(ctx.role)) throw forbidden();
      if (file.category === 'certificate')
        throw conflict('Certificate files cannot be deleted; revoke the certificate instead');
      await FileObject.deleteOne(scope(ctx, { _id: file._id }));
      await deleteFile(file.storageKey);
      await audit(ctx, { action: 'file.delete', entityType: 'FileObject', entityId: file._id });
    },
  });

  api.route({
    method: 'get',
    path: '/students/:id/documents',
    tags: ftags,
    auth: 'school',
    permission: 'files:read',
    summary: "A student's documents and certificates",
    description: 'Parents/students only see files marked visibleToFamily (and their own submissions).',
    params: idParams,
    response: z.array(FileRes),
    handler: async ({ ctx, params }) => {
      await findOwned(Student, ctx, params.id, 'Student');
      await assertStudentVisible(ctx, params.id);
      const family = await visibleStudentIds(ctx);
      const filter: Record<string, unknown> = scope(ctx, { studentId: oid(params.id) });
      if (family) filter.$or = [{ visibleToFamily: true }, { category: 'submission' }];
      else if (!ctx.permissions.has('students:manage') && !ctx.permissions.has('certificates:issue')) {
        filter.category = { $in: ['homework', 'submission'] };
      }
      return FileObject.find(filter).select('-storageKey -sha256').sort({ createdAt: -1 }).lean();
    },
  });

  // ─────────────────────────── Certificates ───────────────────────────
  const TemplateRes = z
    .object({
      key: z.string(),
      type: z.enum(CERTIFICATE_TYPES),
      name: z.string(),
      title: z.string(),
      body: z.string(),
      details: z.array(z.object({ label: z.string(), value: z.string() })),
      note: z.string().optional(),
      isCustom: z.boolean(),
      isModified: z.boolean(),
      updatedAt: z.string().nullable(),
    })
    .openapi('CertificateTemplate');
  const TemplateBody = z.object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(10).max(3000),
    details: z
      .array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(120) }))
      .max(10),
    name: z.string().trim().min(3).max(60).optional(),
  });

  api.route({
    method: 'get',
    path: '/certificate-templates',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Certificate templates: the default for every type (with this school edits) and custom ones',
    response: z.object({
      templates: z.array(TemplateRes),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          locked: z.boolean(),
          manual: z.boolean(),
          date: z.boolean().openapi({ description: 'Entered with a date picker as YYYY-MM-DD' }),
          choices: z
            .array(z.string())
            .openapi({ description: 'Usual answers to offer; any other text is allowed too' }),
        }),
      ),
    }),
    handler: async ({ ctx }) => ({
      templates: await listTemplates(ctx),
      fields: Object.entries(TEMPLATE_FIELDS).map(([key, f]) => ({
        key,
        label: f.label,
        locked: Boolean(f.locked),
        manual: Boolean(f.manual),
        date: Boolean(f.date),
        choices: [...(f.choices ?? [])],
      })),
    }),
  });

  api.route({
    method: 'post',
    path: '/certificate-templates',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Create a custom certificate template for this school',
    body: TemplateBody.extend({ name: z.string().trim().min(3).max(60) }),
    response: TemplateRes,
    status: 201,
    handler: ({ ctx, body }) => createCustomTemplate(ctx, body),
  });

  api.route({
    method: 'put',
    path: '/certificate-templates/:key',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Save the wording of a template for this school (only this school sees it)',
    params: z.object({ key: z.string().max(40) }),
    body: TemplateBody,
    response: TemplateRes,
    handler: ({ ctx, params, body }) => saveTemplate(ctx, params.key, body),
  });

  api.route({
    method: 'delete',
    path: '/certificate-templates/:key',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Restore the default wording of a type, or delete a custom template',
    description: 'Certificates already issued keep the wording they were issued with.',
    params: z.object({ key: z.string().max(40) }),
    response: TemplateRes.nullable(),
    handler: ({ ctx, params }) => resetTemplate(ctx, params.key),
  });

  const PreviewRes = z.object({
    template: z.object({ key: z.string(), name: z.string(), type: z.string(), note: z.string().nullable() }),
    title: z.string(),
    body: z.string(),
    details: z.array(z.tuple([z.string(), z.string()])),
    fields: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.string().nullable(),
        source: z.enum(['record', 'entered']),
        editable: z.boolean(),
      }),
    ),
    missing: z.array(z.object({ key: z.string(), label: z.string(), editable: z.boolean() })),
    warnings: z.array(z.string()),
    emphasis: z.array(z.string()).openapi({ description: 'Values printed in bold on the certificate' }),
    blockers: z.array(z.string()),
    canIssue: z.boolean(),
  });

  api.route({
    method: 'post',
    path: '/certificates/preview',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Fill a certificate for a student without issuing it (shows missing information)',
    description:
      'Values come from the student, guardian, class, session and school records. Nothing is invented: missing values are listed, and only fields that are not locked can be supplied in values.',
    body: z.object({ studentId: objectId(), ...IssueFields }),
    response: PreviewRes,
    handler: async ({ ctx, body }) => {
      const r = await prepareCertificate(ctx, body.studentId, {
        ...body,
        issueDate: await issueDateFor(ctx, body.issueDate),
      });
      const { student: _s, studentStatus: _st, ...rest } = r;
      return { ...rest, canIssue: r.blockers.length === 0 };
    },
  });

  api.route({
    method: 'post',
    path: '/certificates/preview.pdf',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'The certificate PDF exactly as it would be issued, marked PREVIEW (nothing is stored)',
    body: z.object({ studentId: objectId(), ...IssueFields }),
    produces: 'application/pdf',
    handler: async ({ ctx, body, res }) => {
      const issueDate = await issueDateFor(ctx, body.issueDate);
      const r = await prepareCertificate(ctx, body.studentId, { ...body, issueDate });
      const pdf = await renderCertificate(
        {
          title: r.title,
          serialNo: '(assigned on issue)',
          issueDate,
          body: r.body,
          details: r.details,
          emphasis: r.emphasis,
          issuedBy: ctx.name,
          watermark: 'PREVIEW',
          ...certificateLook(r.template.type, `${r.student.firstName} ${r.student.lastName ?? ''}`.trim()),
        },
        await loadBrand(ctx.schoolId),
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="certificate-preview.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'post',
    path: '/certificates',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Issue a certificate from its template (generates and stores the PDF)',
    description:
      'Uses the school template for the type (or templateKey). Refused with 422 CERTIFICATE_INCOMPLETE when information is missing ' +
      '(details.missing lists it), and with FEES_OUTSTANDING for a fee clearance certificate while dues are unpaid.',
    body: z.object({ studentId: objectId(), ...IssueFields }),
    response: CertificateRes,
    status: 201,
    handler: async ({ ctx, body }) =>
      issueCertificate(ctx, body.studentId, { ...body, issueDate: await issueDateFor(ctx, body.issueDate) }),
  });

  api.route({
    method: 'post',
    path: '/certificates/bulk',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Issue one certificate to a whole section, a whole class or chosen students',
    description:
      `Give exactly one of sectionId, classId or studentIds (active students only, up to ${BULK_MAX}). ` +
      'Each student gets their own filled template; students with missing information are skipped with the reason. ' +
      'Students who already hold an issued certificate of the same type are skipped (skipExisting, default true), so a retry never issues twice.',
    body: z
      .object({
        ...IssueFields,
        sectionId: objectId().optional(),
        classId: objectId().optional(),
        studentIds: z.array(objectId()).min(1).max(BULK_MAX).optional(),
        skipExisting: z.boolean().default(true),
      })
      .refine((b) => [b.sectionId, b.classId, b.studentIds].filter(Boolean).length === 1, {
        message: 'Choose a section, a class or a list of students',
        path: ['sectionId'],
      }),
    response: z.object({
      issued: z.array(
        z.object({ certificateId: objectId(), studentId: objectId(), studentName: z.string(), serialNo: z.string() }),
      ),
      skipped: z.array(z.object({ studentId: objectId(), studentName: z.string(), reason: z.string() })),
    }),
    status: 201,
    handler: async ({ ctx, body }) => {
      const filter: Record<string, unknown> = { status: 'active' };
      if (body.sectionId) filter.sectionId = oid(body.sectionId);
      if (body.classId) filter.classId = oid(body.classId);
      if (body.studentIds) filter._id = { $in: [...new Set(body.studentIds)].map(oid) };
      const students = await Student.find(scope(ctx, filter))
        .select('firstName lastName')
        .sort({ firstName: 1, lastName: 1 })
        .lean();
      if (students.length === 0) throw badRequest('No active students match this choice');
      if (students.length > BULK_MAX)
        throw badRequest(`At most ${BULK_MAX} students at a time. Choose one section instead of the whole class.`);
      const template = body.templateKey
        ? await getTemplate(ctx, body.templateKey)
        : await templateForType(ctx, body.type);
      const already = new Set<string>();
      if (body.skipExisting) {
        const existing = await Certificate.find(
          scope(ctx, { type: template.type, status: 'issued', studentId: { $in: students.map((st) => st._id) } }),
        )
          .select('studentId')
          .lean();
        for (const c of existing) already.add(c.studentId.toString());
      }
      const issueDate = await issueDateFor(ctx, body.issueDate);
      const issued: Array<{ certificateId: unknown; studentId: unknown; studentName: string; serialNo: string }> = [];
      const skipped: Array<{ studentId: unknown; studentName: string; reason: string }> = [];
      for (const st of students) {
        const studentName = `${st.firstName} ${st.lastName ?? ''}`.trim();
        if (already.has(st._id.toString())) {
          skipped.push({ studentId: st._id, studentName, reason: 'Already has this certificate' });
          continue;
        }
        const input = { ...body, templateKey: template.key, issueDate };
        const check = await prepareCertificate(ctx, st._id.toString(), input);
        if (check.blockers.length) {
          skipped.push({ studentId: st._id, studentName, reason: check.blockers.join(' ') });
          continue;
        }
        const cert = await issueCertificate(ctx, st._id.toString(), input);
        issued.push({ certificateId: cert._id, studentId: st._id, studentName, serialNo: cert.serialNo });
      }
      return { issued, skipped } as any;
    },
  });

  api.route({
    method: 'get',
    path: '/certificates',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:read',
    summary: 'List certificates',
    query: paginationQuery.extend({
      studentId: objectId().optional(),
      type: z.enum(CERTIFICATE_TYPES).optional(),
      q: z
        .string()
        .trim()
        .max(100)
        .optional()
        .openapi({ description: 'Search: certificate number, student name or admission no' }),
    }),
    response: CertificateRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      const family = await visibleStudentIds(ctx);
      if (family) filter.studentId = { $in: family.map(oid) };
      if (query.studentId) {
        if (family && !family.includes(query.studentId))
          return { items: [], meta: { page: 1, limit: query.limit, total: 0, totalPages: 1 } };
        filter.studentId = oid(query.studentId);
      }
      if (query.type) filter.type = query.type;
      const rx = searchRegex(query.q);
      if (rx) {
        const ids = await studentIdsMatching(ctx, query.q);
        filter.$and = [{ $or: [{ serialNo: rx }, { studentId: { $in: ids } }] }];
      }
      return paginate(Certificate, filter, {
        page: query.page,
        limit: query.limit,
        sort: { issueDate: -1 },
        populate: { path: 'studentId', select: 'firstName lastName admissionNo' },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/certificates/:id/download',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:read',
    summary: 'Download a certificate PDF',
    params: idParams,
    produces: 'application/pdf',
    handler: async ({ ctx, params, res }) => {
      const cert = await findOwned(Certificate, ctx, params.id, 'Certificate');
      await assertStudentVisible(ctx, cert.studentId.toString());
      const file = await FileObject.findOne(scope(ctx, { _id: cert.fileId })).lean();
      if (!file) throw notFound('Certificate file');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', dispositionName(`${cert.serialNo}.pdf`));
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(await readFile(file.storageKey));
    },
  });

  api.route({
    method: 'post',
    path: '/certificates/:id/revoke',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Revoke a certificate',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
    response: CertificateRes,
    handler: async ({ ctx, params, body }) => {
      const cert = await findOwned(Certificate, ctx, params.id, 'Certificate');
      if (cert.status === 'revoked') throw conflict('Certificate already revoked');
      const updated = await Certificate.findOneAndUpdate(
        scope(ctx, { _id: cert._id }),
        { $set: { status: 'revoked', revokedReason: body.reason } },
        { returnDocument: 'after' },
      ).lean();
      await audit(ctx, { action: 'certificate.revoke', entityType: 'Certificate', entityId: cert._id });
      return updated;
    },
  });

  api.route({
    method: 'delete',
    path: '/certificates/:id',
    tags: ctags,
    auth: 'school',
    permission: 'certificates:issue',
    summary: 'Delete a revoked certificate and its PDF',
    description:
      'Only revoked certificates can be deleted (409 otherwise: revoke first). Afterwards public verification of its serial number answers not_found instead of revoked.',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const cert = await findOwned(Certificate, ctx, params.id, 'Certificate');
      if (cert.status !== 'revoked') throw conflict('Only revoked certificates can be deleted. Revoke it first.');
      const file = cert.fileId ? await FileObject.findOne(scope(ctx, { _id: cert.fileId })).lean() : null;
      await Certificate.deleteOne(scope(ctx, { _id: cert._id }));
      if (file) {
        await FileObject.deleteOne(scope(ctx, { _id: file._id }));
        await deleteFile(file.storageKey);
      }
      await audit(ctx, {
        action: 'certificate.delete',
        entityType: 'Certificate',
        entityId: cert._id,
        summary: cert.serialNo,
        metadata: { serialNo: cert.serialNo, type: cert.type, revokedReason: cert.revokedReason },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/public/certificates/verify',
    tags: ctags,
    auth: 'public',
    summary: 'Public certificate verification (minimal data)',
    middleware: [publicLookupLimiter],
    description:
      'Returns only validity, type, issue date, school name and the holder’s initials — no personal details.',
    query: z.object({ schoolCode: z.string().trim().min(2).max(20), serialNo: z.string().trim().min(5).max(30) }),
    response: z.object({
      valid: z.boolean(),
      status: z.enum(['issued', 'revoked', 'not_found']),
      schoolName: z.string().optional(),
      type: z.string().optional(),
      issueDate: z.string().optional(),
      holderInitials: z.string().optional(),
    }),
    handler: async ({ query }) => {
      const school = await School.findOne({ code: query.schoolCode.toUpperCase() }).select('name').lean();
      if (!school) return { valid: false, status: 'not_found' as const };
      const cert = await Certificate.findOne({ schoolId: school._id, serialNo: query.serialNo }).lean();
      if (!cert) return { valid: false, status: 'not_found' as const };
      const st = await Student.findOne({ schoolId: school._id, _id: cert.studentId })
        .select('firstName lastName')
        .lean();
      const initials = [st?.firstName, st?.lastName]
        .filter(Boolean)
        .map((n) => `${n![0]}.`)
        .join(' ');
      return {
        valid: cert.status === 'issued',
        status: cert.status as 'issued' | 'revoked',
        schoolName: school.name,
        type: cert.type,
        issueDate: formatDateOnly(cert.issueDate),
        holderInitials: initials,
      };
    },
  });
}
