import crypto from 'node:crypto';
import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import type { SchoolContext } from '../../types/context';
import { formatDateOnly } from '../../utils/dates';
import { badRequest, notFound } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Invoice } from '../fees/fees.models';
import { School } from '../schools/school.model';
import { Parent, Student } from '../students/student.models';
import { CERTIFICATE_TYPES } from './files.model';

type Ctx = SchoolContext;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];

/**
 * Certificate templates. Every type has a complete default; a school may edit the wording of a
 * type (saved for that school only), restore the default, or add its own custom templates.
 * Templates use {{placeholders}} from FIELDS, filled from the school's records when issuing.
 * Nothing is invented: a placeholder with no value is reported as missing, and only fields
 * staff are allowed to supply (conduct, achievement, a missing leaving date...) can be typed in.
 */
const CertificateTemplateSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      /** A certificate type for edited defaults, or "custom-<id>" for a school's own templates. */
      key: { type: String, required: true },
      type: { type: String, enum: CERTIFICATE_TYPES, required: true },
      name: { type: String, required: true, trim: true },
      title: { type: String, required: true, trim: true },
      body: { type: String, required: true },
      details: { type: [{ _id: false, label: String, value: String }], default: [] },
      updatedBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
CertificateTemplateSchema.index({ schoolId: 1, key: 1 }, { unique: true });
export const CertificateTemplate = model('CertificateTemplate', CertificateTemplateSchema);

/**
 * locked: always from records, never typed in. manual: entered by staff when issuing. date: typed
 * in with a date picker (YYYY-MM-DD) and printed like record dates. choices: usual answers offered
 * in a list (staff may still type their own). emphasis: printed in bold on the certificate.
 */
export const FIELDS: Record<
  string,
  { label: string; locked?: boolean; manual?: boolean; date?: boolean; choices?: readonly string[]; emphasis?: boolean }
> = {
  'school.name': { label: 'School name', locked: true },
  'school.city': { label: 'School city' },
  'school.address': { label: 'School address' },
  'student.name': { label: 'Student name', locked: true, emphasis: true },
  'student.admissionNo': { label: 'Admission number', locked: true, emphasis: true },
  'student.rollNo': { label: 'Roll number', emphasis: true },
  'student.guardianName': { label: 'Father / guardian name' },
  'student.relation': { label: 'Son / daughter', choices: ['son', 'daughter'] },
  'student.possessive': { label: 'His / her', choices: ['his', 'her'] },
  'student.dateOfBirth': { label: 'Date of birth', date: true },
  'student.bFormNo': { label: 'B-Form number' },
  'student.className': { label: 'Class', emphasis: true },
  'student.sectionName': { label: 'Section' },
  'student.admissionDate': { label: 'Date of admission', date: true },
  'student.leavingDate': { label: 'Date of leaving', date: true, emphasis: true },
  'student.leavingReason': {
    label: 'Reason for leaving',
    emphasis: true,
    choices: [
      'Completed studies at this school',
      'Family relocated to another city',
      'Transferred to another school',
      "On the parents' request",
      'Admission to a higher institution',
    ],
  },
  'session.name': { label: 'Academic session' },
  'fees.status': { label: 'Fee dues', locked: true },
  'certificate.serialNo': { label: 'Certificate number', locked: true },
  'certificate.issueDate': { label: 'Date of issue', locked: true, date: true },
  'certificate.conduct': {
    label: 'Conduct',
    manual: true,
    emphasis: true,
    choices: ['Excellent', 'Very good', 'Good', 'Satisfactory'],
  },
  'certificate.achievement': { label: 'Achievement or reason', manual: true, emphasis: true },
  'certificate.purpose': { label: 'Purpose', manual: true },
};

const OFFICIAL_FORM_NOTE =
  'Some boards and provincial education departments prescribe their own leaving/transfer form. Where one is required, issue it on that form; this template is the school’s own certificate.';

type TemplateDef = {
  type: CertificateType;
  name: string;
  title: string;
  body: string;
  details: Array<{ label: string; value: string }>;
  note?: string;
};

const PARTICULARS = [
  { label: 'Admission No.', value: '{{student.admissionNo}}' },
  { label: 'Date of Birth', value: '{{student.dateOfBirth}}' },
  { label: 'Date of Admission', value: '{{student.admissionDate}}' },
  { label: 'Class at Leaving', value: '{{student.className}}' },
];

/** Award certificates: printed with the student's name large under "presented to" (see renderCertificate). */
export const AWARD_TYPES = ['achievement', 'sports', 'merit'] as const;
/** Certificates addressed to any reader ("To whom it may concern"). */
export const OPEN_LETTER_TYPES = ['character', 'bonafide', 'study', 'fee_clearance'] as const;

export const DEFAULT_TEMPLATES: Record<Exclude<CertificateType, 'custom'>, TemplateDef> = {
  leaving: {
    type: 'leaving',
    name: 'School Leaving Certificate',
    title: 'School Leaving Certificate',
    body:
      'This is to certify that {{student.name}}, {{student.relation}} of {{student.guardianName}}, was a bona fide student of {{school.name}} from {{student.admissionDate}} to {{student.leavingDate}}, and was studying in {{student.className}} at the time of leaving.\n\n' +
      'The particulars given below are true according to the Admission and Withdrawal Register of the school. ' +
      'The name of the student has been struck off the school rolls with effect from {{student.leavingDate}}. ' +
      'During {{student.possessive}} stay at this school, {{student.possessive}} conduct remained {{certificate.conduct}}.\n\n' +
      'We wish {{student.name}} every success in all future endeavours.',
    details: [
      ...PARTICULARS,
      { label: 'Date of Leaving', value: '{{student.leavingDate}}' },
      { label: 'Reason for Leaving', value: '{{student.leavingReason}}' },
      { label: 'Conduct', value: '{{certificate.conduct}}' },
      { label: 'Fee Dues', value: '{{fees.status}}' },
    ],
    note: OFFICIAL_FORM_NOTE,
  },
  transfer: {
    type: 'transfer',
    name: 'Transfer Certificate',
    title: 'Transfer Certificate',
    body:
      'Certified that {{student.name}}, {{student.relation}} of {{student.guardianName}}, Admission No. {{student.admissionNo}}, was a student of {{school.name}} and was studying in {{student.className}} at the time of leaving.\n\n' +
      'At the request of the parent/guardian, the student is granted transfer from this school with effect from {{student.leavingDate}}, to seek admission in another institution. ' +
      'The school has no objection to {{student.possessive}} admission elsewhere. The particulars given below are true according to the school record.',
    details: [
      ...PARTICULARS,
      { label: 'Date of Leaving', value: '{{student.leavingDate}}' },
      { label: 'Conduct', value: '{{certificate.conduct}}' },
      { label: 'Fee Dues', value: '{{fees.status}}' },
    ],
    note: OFFICIAL_FORM_NOTE,
  },
  character: {
    type: 'character',
    name: 'Character Certificate',
    title: 'Character Certificate',
    body:
      'This is to certify that {{student.name}}, {{student.relation}} of {{student.guardianName}}, Admission No. {{student.admissionNo}}, is a student of {{school.name}} in {{student.className}}.\n\n' +
      'To the best of our knowledge and according to the school record, the conduct and character of the student have remained {{certificate.conduct}}. ' +
      'The school has no adverse record against {{student.possessive}} name.\n\n' +
      'This certificate is issued on the request of the parent/guardian. We wish {{student.name}} a bright and successful future.',
    details: [
      { label: 'Admission No.', value: '{{student.admissionNo}}' },
      { label: 'Class', value: '{{student.className}}' },
      { label: 'Academic Session', value: '{{session.name}}' },
      { label: 'Conduct', value: '{{certificate.conduct}}' },
    ],
  },
  bonafide: {
    type: 'bonafide',
    name: 'Bonafide Certificate',
    title: 'Bonafide Certificate',
    body:
      'This is to certify that {{student.name}}, {{student.relation}} of {{student.guardianName}}, is a bona fide student of {{school.name}}, presently enrolled in {{student.className}}, Section {{student.sectionName}}, in the academic session {{session.name}}.\n\n' +
      'According to the school record, the date of birth of the student is {{student.dateOfBirth}}. ' +
      'This certificate is issued on the request of the parent/guardian for whatever purpose it may serve.',
    details: [
      { label: 'Admission No.', value: '{{student.admissionNo}}' },
      { label: 'Roll No.', value: '{{student.rollNo}}' },
      { label: 'Class / Section', value: '{{student.className}} / {{student.sectionName}}' },
      { label: 'Date of Birth', value: '{{student.dateOfBirth}}' },
    ],
  },
  study: {
    type: 'study',
    name: 'Study / Enrollment Certificate',
    title: 'Study Certificate',
    body:
      'This is to certify that {{student.name}}, {{student.relation}} of {{student.guardianName}}, Admission No. {{student.admissionNo}}, has been enrolled at {{school.name}} since {{student.admissionDate}}, and is presently studying in {{student.className}}, Section {{student.sectionName}}, in the academic session {{session.name}}.\n\n' +
      'This certificate is issued on the request of the parent/guardian for {{certificate.purpose}}.',
    details: [
      { label: 'Admission No.', value: '{{student.admissionNo}}' },
      { label: 'Date of Admission', value: '{{student.admissionDate}}' },
      { label: 'Date of Birth', value: '{{student.dateOfBirth}}' },
      { label: 'Present Class', value: '{{student.className}}' },
    ],
  },
  fee_clearance: {
    type: 'fee_clearance',
    name: 'Fee Clearance Certificate',
    title: 'Fee Clearance Certificate',
    body:
      'This is to certify that {{student.name}}, {{student.relation}} of {{student.guardianName}}, Admission No. {{student.admissionNo}}, of {{student.className}}, has cleared all fees and other dues payable to {{school.name}}.\n\n' +
      'According to the accounts record of the school, no amount is outstanding against the student as on {{certificate.issueDate}}. ' +
      'This certificate is issued on the request of the parent/guardian.',
    details: [
      { label: 'Admission No.', value: '{{student.admissionNo}}' },
      { label: 'Class', value: '{{student.className}}' },
      { label: 'Fee Dues', value: '{{fees.status}}' },
      { label: 'Cleared on', value: '{{certificate.issueDate}}' },
    ],
  },
  achievement: {
    type: 'achievement',
    name: 'Certificate of Achievement',
    title: 'Certificate of Achievement',
    body:
      'In recognition of {{certificate.achievement}} during the academic session {{session.name}}.\n\n' +
      'Presented with appreciation for the dedication and hard work behind this accomplishment, and with best wishes for continued success.',
    details: [
      { label: 'Class', value: '{{student.className}}' },
      { label: 'Session', value: '{{session.name}}' },
    ],
  },
  sports: {
    type: 'sports',
    name: 'Sports Certificate',
    title: 'Certificate of Sporting Excellence',
    body:
      'For {{certificate.achievement}}.\n\n' +
      'The school applauds the commitment, discipline and true sportsmanship shown, and congratulates the student on this achievement.',
    details: [
      { label: 'Class', value: '{{student.className}}' },
      { label: 'Session', value: '{{session.name}}' },
    ],
  },
  merit: {
    type: 'merit',
    name: 'Certificate of Merit',
    title: 'Certificate of Merit',
    body:
      'For {{certificate.achievement}} in the academic session {{session.name}}.\n\n' +
      'This distinction recognises outstanding effort and performance. The school takes pride in this achievement and wishes the student every success ahead.',
    details: [
      { label: 'Father / Guardian', value: '{{student.guardianName}}' },
      { label: 'Class', value: '{{student.className}}' },
      { label: 'Session', value: '{{session.name}}' },
    ],
  },
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}/g;

export function placeholdersIn(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}

function assertKnownPlaceholders(title: string, body: string, details: Array<{ label: string; value: string }>) {
  const unknown = placeholdersIn(title, body, ...details.map((d) => d.value)).filter((p) => !FIELDS[p]);
  if (unknown.length)
    throw badRequest(
      `Unknown fields in the template: ${unknown.map((u) => `{{${u}}}`).join(', ')}`,
      undefined,
      'VALIDATION_ERROR',
    );
}

type TemplateView = TemplateDef & { key: string; isCustom: boolean; isModified: boolean; updatedAt: string | null };

/** Defaults merged with this school's edits, plus its custom templates. */
export async function listTemplates(ctx: Ctx): Promise<TemplateView[]> {
  const saved = await CertificateTemplate.find(scope(ctx)).lean();
  const byKey = new Map(saved.map((t) => [t.key, t]));
  const builtIn = (Object.keys(DEFAULT_TEMPLATES) as Array<keyof typeof DEFAULT_TEMPLATES>).map((type) => {
    const d = DEFAULT_TEMPLATES[type];
    const s = byKey.get(type);
    return {
      ...d,
      key: type,
      ...(s ? { title: s.title, body: s.body, details: s.details as TemplateDef['details'] } : {}),
      isCustom: false,
      isModified: Boolean(s),
      updatedAt: s?.updatedAt ? new Date(s.updatedAt).toISOString() : null,
    };
  });
  const custom = saved
    .filter((t) => t.key.startsWith('custom-'))
    .map((t) => ({
      type: t.type as CertificateType,
      name: t.name,
      title: t.title,
      body: t.body,
      details: t.details as TemplateDef['details'],
      key: t.key,
      isCustom: true,
      isModified: false,
      updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    }));
  return [...builtIn, ...custom];
}

export async function getTemplate(ctx: Ctx, key: string): Promise<TemplateView> {
  const t = (await listTemplates(ctx)).find((x) => x.key === key);
  if (!t) throw notFound('Certificate template');
  return t;
}

/** The template used when none is chosen: the school's version of the type's default. */
export async function templateForType(ctx: Ctx, type: CertificateType): Promise<TemplateView> {
  if (type === 'custom') throw badRequest('Choose one of your custom templates', { field: 'templateKey' });
  return getTemplate(ctx, type);
}

export async function saveTemplate(
  ctx: Ctx,
  key: string,
  input: { title: string; body: string; details: Array<{ label: string; value: string }>; name?: string },
) {
  const current = await getTemplate(ctx, key);
  assertKnownPlaceholders(input.title, input.body, input.details);
  await CertificateTemplate.updateOne(
    scope(ctx, { key }),
    {
      $set: {
        type: current.type,
        name: current.isCustom ? input.name?.trim() || current.name : current.name,
        title: input.title,
        body: input.body,
        details: input.details,
        updatedBy: oid(ctx.userId),
      },
      $setOnInsert: { schoolId: oid(ctx.schoolId), key },
    },
    { upsert: true },
  );
  await audit(ctx, { action: 'certificate_template.save', entityType: 'CertificateTemplate', summary: key });
  return getTemplate(ctx, key);
}

export async function createCustomTemplate(
  ctx: Ctx,
  input: { name: string; title: string; body: string; details: Array<{ label: string; value: string }> },
) {
  assertKnownPlaceholders(input.title, input.body, input.details);
  const key = `custom-${crypto.randomBytes(6).toString('hex')}`;
  await CertificateTemplate.create({
    schoolId: ctx.schoolId,
    key,
    type: 'custom',
    name: input.name.trim(),
    title: input.title,
    body: input.body,
    details: input.details,
    updatedBy: ctx.userId,
  });
  await audit(ctx, { action: 'certificate_template.create', entityType: 'CertificateTemplate', summary: input.name });
  return getTemplate(ctx, key);
}

/** Built-in types go back to the default wording; custom templates are deleted. */
export async function resetTemplate(ctx: Ctx, key: string) {
  const current = await getTemplate(ctx, key);
  await CertificateTemplate.deleteOne(scope(ctx, { key }));
  await audit(ctx, {
    action: current.isCustom ? 'certificate_template.delete' : 'certificate_template.restore_default',
    entityType: 'CertificateTemplate',
    summary: key,
  });
  return current.isCustom ? null : getTemplate(ctx, key);
}

// ───────────────────────────── Filling a template ─────────────────────────────

const fmt = (d: Date | null | undefined) => {
  if (!d) return null;
  const x = new Date(d);
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${x.getUTCDate()} ${months[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** A typed date: YYYY-MM-DD or "12 March 2015"; null unless it is a real calendar date. */
export function parseEnteredDate(text: string): Date | null {
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const long = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(text);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (long && MONTH_NAMES.includes(long[2].toLowerCase()))
    [y, mo, d] = [Number(long[3]), MONTH_NAMES.indexOf(long[2].toLowerCase()) + 1, Number(long[1])];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/** Values for every field from the school's records (null where the record has none). */
export async function recordValues(ctx: Ctx, studentId: string, issueDate: Date) {
  const student = await Student.findOne(scope(ctx, { _id: oid(studentId) })).lean();
  if (!student) throw notFound('Student');
  const primary = student.guardians.find((g) => g.isPrimary) ?? student.guardians[0];
  const [school, cls, section, session, guardian, outstanding] = await Promise.all([
    School.findById(ctx.schoolId).select('name city address').lean(),
    SchoolClass.findOne(scope(ctx, { _id: student.classId }))
      .select('name')
      .lean(),
    Section.findOne(scope(ctx, { _id: student.sectionId }))
      .select('name')
      .lean(),
    AcademicSession.findOne(scope(ctx, { _id: student.sessionId }))
      .select('name')
      .lean(),
    primary
      ? Parent.findOne(scope(ctx, { _id: primary.parentId }))
          .select('name')
          .lean()
      : null,
    Invoice.aggregate([
      { $match: scope(ctx, { studentId: student._id, status: { $in: ['unpaid', 'partial'] } }) },
      { $group: { _id: null, balance: { $sum: '$balance' } } },
    ]),
  ]);
  const balance = outstanding[0]?.balance ?? 0;
  const left = ['left', 'graduated'].includes(student.status);
  const values: Record<string, string | null> = {
    'school.name': school?.name ?? null,
    'school.city': school?.city ?? null,
    'school.address': school?.address ?? null,
    'student.name': `${student.firstName} ${student.lastName ?? ''}`.trim(),
    'student.admissionNo': student.admissionNo,
    'student.rollNo': student.rollNo ?? null,
    'student.guardianName': guardian?.name ?? null,
    'student.relation': student.gender === 'female' ? 'daughter' : student.gender === 'male' ? 'son' : null,
    'student.possessive': student.gender === 'female' ? 'her' : student.gender === 'male' ? 'his' : null,
    'student.dateOfBirth': fmt(student.dateOfBirth),
    'student.bFormNo': student.bFormNo ?? null,
    'student.className': cls?.name ?? null,
    'student.sectionName': section?.name ?? null,
    'student.admissionDate': fmt(student.admissionDate),
    'student.leavingDate': left ? fmt(student.statusChangedAt) : null,
    'student.leavingReason': left ? (student.leavingReason ?? null) : null,
    'session.name': session?.name ?? null,
    'fees.status': balance > 0 ? `Rs ${balance.toLocaleString('en-PK')} outstanding` : 'No dues outstanding',
    'certificate.serialNo': null, // assigned when the certificate is issued
    'certificate.issueDate': fmt(issueDate),
    'certificate.conduct': null,
    'certificate.achievement': null,
    'certificate.purpose': null,
  };
  return { student, values, outstanding: balance, studentStatus: student.status };
}

export type Filled = {
  title: string;
  body: string;
  details: Array<[string, string]>;
  fields: Array<{ key: string; label: string; value: string | null; source: 'record' | 'entered'; editable: boolean }>;
  missing: Array<{ key: string; label: string; editable: boolean }>;
  warnings: string[];
  /** Filled-in values printed in bold (student name, admission no., class, conduct...). */
  emphasis: string[];
};

/**
 * Fills a template for one student. `entered` may supply values only for fields that are not
 * locked (record-backed identity, fee status, serial and issue date can never be typed in).
 */
/** Wording saved before templates used {name}, {class} and {admissionNo}; it still fills in. */
const LEGACY = { name: 'student.name', class: 'student.className', admissionNo: 'student.admissionNo' } as const;
export const upgradeLegacyPlaceholders = (text: string) =>
  text.replace(/(?<!\{)\{(name|class|admissionNo)\}(?!\})/g, (_m, k: keyof typeof LEGACY) => `{{${LEGACY[k]}}}`);

export function fillTemplate(
  rawTemplate: { type: string; title: string; body: string; details: Array<{ label: string; value: string }> },
  values: Record<string, string | null>,
  entered: Record<string, string> = {},
  serialNo?: string,
): Filled {
  const template = {
    ...rawTemplate,
    title: upgradeLegacyPlaceholders(rawTemplate.title),
    body: upgradeLegacyPlaceholders(rawTemplate.body),
  };
  const merged: Record<string, string | null> = {
    ...values,
    ...(serialNo ? { 'certificate.serialNo': serialNo } : {}),
  };
  const sourceOf: Record<string, 'record' | 'entered'> = {};
  for (const [k, v] of Object.entries(entered)) {
    const f = FIELDS[k];
    if (!f) throw badRequest(`Unknown field ${k}`, { field: 'values' });
    if (f.locked)
      throw badRequest(`${f.label} comes from the school record and cannot be typed in`, { field: 'values' });
    let clean = String(v).trim().slice(0, 300);
    // Dates come from a date picker (YYYY-MM-DD), or already written as printed ("12 March 2015");
    // either way they must be a real date and are printed like the dates from records.
    if (clean && f.date) {
      const d = parseEnteredDate(clean);
      if (!d) throw badRequest(`${f.label}: choose a valid date`, { field: `values.${k}` });
      clean = fmt(d)!;
    }
    if (clean) {
      merged[k] = clean;
      sourceOf[k] = 'entered';
    }
  }
  const used = placeholdersIn(template.title, template.body, ...template.details.map((d) => d.value));
  const missing = used
    .filter((k) => !merged[k] && !(k === 'certificate.serialNo' && !serialNo))
    .map((k) => ({ key: k, label: FIELDS[k]?.label ?? k, editable: !FIELDS[k]?.locked }));
  const fill = (text: string) =>
    text.replace(
      PLACEHOLDER,
      (_m, key: string) =>
        merged[key] ?? (key === 'certificate.serialNo' ? '(assigned on issue)' : `[${FIELDS[key]?.label ?? key}]`),
    );
  const warnings: string[] = [];
  if (['leaving', 'transfer'].includes(template.type) && !values['student.leavingDate'])
    warnings.push(
      'The student is not marked as left in the school record. Enter the leaving date only if the student is leaving now.',
    );
  return {
    title: fill(template.title),
    body: fill(template.body).replace(
      /(^|[.!?]\s+)(his|her)\b/g,
      (_m, p, w: string) => p + w[0].toUpperCase() + w.slice(1),
    ),
    details: template.details.map((d) => [d.label, fill(d.value)] as [string, string]),
    fields: used.map((k) => ({
      key: k,
      label: FIELDS[k]?.label ?? k,
      value: merged[k] ?? null,
      source: sourceOf[k] ?? 'record',
      editable: !FIELDS[k]?.locked,
    })),
    missing,
    warnings,
    emphasis: [...new Set(used.filter((k) => FIELDS[k]?.emphasis && merged[k]).map((k) => merged[k]!))],
  };
}

export const todayString = (d: Date) => formatDateOnly(d);

/** How a certificate of this type is laid out: an award (name in large type) or a formal letter. */
export function certificateLook(type: string, studentName: string) {
  const award = (AWARD_TYPES as readonly string[]).includes(type);
  return {
    layout: award ? ('award' as const) : ('letter' as const),
    ...(award ? { recipient: studentName } : {}),
    ...((OPEN_LETTER_TYPES as readonly string[]).includes(type) ? { salutation: 'To whom it may concern' } : {}),
  };
}
