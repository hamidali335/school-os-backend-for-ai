import ExcelJS from 'exceljs';
import type { SchoolContext } from '../../types/context';
import { toCsv } from '../../utils/csv';
import { formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, forbidden } from '../../utils/errors';
import { campusScope, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass, Section, Subject } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { Employee } from '../employees/employee.model';
import { FeeHead, FeeStructure, Invoice, Payment } from '../fees/fees.models';
import { TYPE_DEFS, type ImportType } from '../imports/import-fields';
import { School } from '../schools/school.model';
import { WEEKDAY_NAMES } from '../schools/school-days';
import { Parent, Student } from '../students/student.models';
import { TimetableEntry } from '../timetable/timetable.model';

type Ctx = SchoolContext;
type Row = Record<string, unknown>;
type Sheet = {
  name: string;
  columns: Array<{ key: string; header: string; width?: number; money?: boolean }>;
  rows: Row[];
};

/**
 * School data downloads. Students, parents and staff use exactly the columns of the import
 * templates (same headings, * for required), so a downloaded file can be edited and imported
 * again. Every download is recorded in the audit log. Only what the user may see is included
 * (their campuses; each dataset needs its permission).
 */
export const DATASETS = {
  students: { label: 'Students (import format)', permission: 'students:export' },
  parents: { label: 'Parents (import format)', permission: 'students:export' },
  families: { label: 'Students with their parents', permission: 'students:export' },
  fees: { label: 'Fees: summary per student, invoices and payments', permission: 'fees:export' },
  staff: { label: 'Staff (import format)', permission: 'employees:read' },
  salaries: { label: 'Staff with salaries', permission: 'payroll:manage' },
  timetable: { label: 'Timetable (current session)', permission: 'timetable:read' },
} as const;
export type Dataset = keyof typeof DATASETS;
export const DATASET_KEYS = Object.keys(DATASETS) as Dataset[];

export const canExport = (ctx: Ctx, d: Dataset) => ctx.permissions.has(DATASETS[d].permission);

const titleCase = (v?: string | null) =>
  v
    ? v
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\bOn Leave\b/, 'On leave')
    : '';
const day = (d?: Date | null) => (d ? formatDateOnly(d) : '');
const fullName = (p: { firstName?: string; lastName?: string | null }) =>
  `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();

/** Template headings of an import type, keyed by field ("Student Name *"). */
function templateColumns(type: ImportType) {
  return TYPE_DEFS[type].fields
    .filter((f) => f.inTemplate !== false)
    .map((f) => ({ key: f.key, header: f.required ? `${f.label} *` : f.label }));
}

async function lookups(ctx: Ctx) {
  const [classes, sections, sessions, campuses] = await Promise.all([
    SchoolClass.find(scope(ctx)).select('name level').lean(),
    Section.find(scope(ctx)).select('name').lean(),
    AcademicSession.find(scope(ctx)).select('name').lean(),
    Campus.find(scope(ctx)).select('name').lean(),
  ]);
  const by = <T extends { _id: unknown }>(list: T[], f: (x: T) => string) =>
    new Map(list.map((x) => [String(x._id), f(x)]));
  return {
    className: by(classes, (c) => c.name),
    classLevel: by(classes, (c) => String(c.level ?? 99)),
    sectionName: by(sections, (s) => s.name),
    sessionName: by(sessions, (s) => s.name),
    campusName: by(campuses, (c) => c.name),
  };
}

/** Students of the user's campuses (archived ones too: they are part of the school's record), in class order. */
async function loadStudents(ctx: Ctx, L: Awaited<ReturnType<typeof lookups>>) {
  const students = await Student.find(scope(ctx, campusScope(ctx)))
    .select(
      'admissionNo rollNo firstName lastName gender dateOfBirth bFormNo address admissionDate previousSchool status sessionId classId sectionId campusId guardians customFees',
    )
    .lean();
  const level = (s: (typeof students)[number]) => Number(L.classLevel.get(String(s.classId)) ?? 99);
  students.sort(
    (a, b) =>
      level(a) - level(b) ||
      (L.sectionName.get(String(a.sectionId)) ?? '').localeCompare(L.sectionName.get(String(b.sectionId)) ?? '') ||
      a.admissionNo.localeCompare(b.admissionNo, undefined, { numeric: true }),
  );
  const parentIds = [...new Set(students.flatMap((s) => (s.guardians ?? []).map((g) => String(g.parentId))))];
  const parents = await Parent.find(scope(ctx, { _id: { $in: parentIds } }))
    .select('name phone cnic relation email whatsapp occupation address userId')
    .lean();
  return { students, parentById: new Map(parents.map((p) => [String(p._id), p])) };
}

async function studentsSheet(ctx: Ctx): Promise<Sheet> {
  const L = await lookups(ctx);
  const { students, parentById } = await loadStudents(ctx, L);
  const rows = students.map((s) => {
    const gs = (s.guardians ?? []).map((g) => ({ ...g, p: parentById.get(String(g.parentId)) }));
    const primary = gs.find((g) => g.isPrimary) ?? gs[0];
    const mother = gs.find((g) => g !== primary && g.relation === 'mother');
    return {
      admissionNo: s.admissionNo,
      fullName: fullName(s),
      gender: titleCase(s.gender),
      dateOfBirth: day(s.dateOfBirth),
      className: L.className.get(String(s.classId)) ?? '',
      sectionName: L.sectionName.get(String(s.sectionId)) ?? '',
      sessionName: L.sessionName.get(String(s.sessionId)) ?? '',
      campusName: L.campusName.get(String(s.campusId)) ?? '',
      rollNo: s.rollNo ?? '',
      bFormNo: s.bFormNo ?? '',
      parentName: primary?.p?.name ?? '',
      parentRelation: titleCase(primary?.relation),
      parentPhone: primary?.p?.phone ?? '',
      parentCnic: primary?.p?.cnic ?? '',
      motherName: mother?.p?.name ?? '',
      motherPhone: mother?.p?.phone ?? '',
      address: s.address ?? '',
      admissionDate: day(s.admissionDate),
      previousSchool: s.previousSchool ?? '',
      status: titleCase(s.status),
    };
  });
  return { name: 'Students', columns: templateColumns('students'), rows };
}

async function parentsSheet(ctx: Ctx): Promise<Sheet> {
  const L = await lookups(ctx);
  const { students } = await loadStudents(ctx, L);
  const children = new Map<string, string[]>();
  for (const s of students)
    for (const g of s.guardians ?? [])
      children.set(String(g.parentId), [...(children.get(String(g.parentId)) ?? []), s.admissionNo]);
  // Every parent record of the school, also those not linked to a student (shown with no children).
  const parents = await Parent.find(scope(ctx))
    .select('name phone relation cnic email whatsapp occupation address')
    .sort({ name: 1 })
    .lean();
  const visible = ctx.campusIds.length ? parents.filter((p) => children.has(String(p._id))) : parents;
  return {
    name: 'Parents',
    columns: templateColumns('parents'),
    rows: visible.map((p) => ({
      name: p.name,
      phone: p.phone,
      relation: titleCase(p.relation),
      cnic: p.cnic ?? '',
      email: p.email ?? '',
      whatsapp: p.whatsapp ?? '',
      occupation: p.occupation ?? '',
      address: p.address ?? '',
      childAdmissionNos: (children.get(String(p._id)) ?? []).join(', '),
    })),
  };
}

async function familiesSheet(ctx: Ctx): Promise<Sheet> {
  const L = await lookups(ctx);
  const { students, parentById } = await loadStudents(ctx, L);
  const rows: Row[] = [];
  for (const s of students) {
    const base = {
      admissionNo: s.admissionNo,
      student: fullName(s),
      className: L.className.get(String(s.classId)) ?? '',
      sectionName: L.sectionName.get(String(s.sectionId)) ?? '',
      studentStatus: titleCase(s.status),
    };
    if (!s.guardians?.length) rows.push({ ...base, parent: '(no parent linked)' });
    for (const g of s.guardians ?? []) {
      const p = parentById.get(String(g.parentId));
      rows.push({
        ...base,
        parent: p?.name ?? '',
        relation: titleCase(g.relation),
        phone: p?.phone ?? '',
        cnic: p?.cnic ?? '',
        primary: g.isPrimary ? 'Yes' : 'No',
        login: p?.userId ? 'Yes' : 'No',
      });
    }
  }
  return {
    name: 'Students with parents',
    columns: [
      { key: 'admissionNo', header: 'Admission No' },
      { key: 'student', header: 'Student Name', width: 24 },
      { key: 'className', header: 'Class' },
      { key: 'sectionName', header: 'Section' },
      { key: 'studentStatus', header: 'Student Status' },
      { key: 'parent', header: 'Parent Name', width: 24 },
      { key: 'relation', header: 'Relation' },
      { key: 'phone', header: 'Phone' },
      { key: 'cnic', header: 'CNIC' },
      { key: 'primary', header: 'Primary Guardian' },
      { key: 'login', header: 'Has Login' },
    ],
    rows,
  };
}

const KIND = { regular: 'Monthly fee', adhoc: 'Charge', opening: 'Previous dues' } as Record<string, string>;

async function feeSheets(ctx: Ctx): Promise<Sheet[]> {
  const L = await lookups(ctx);
  const { students, parentById } = await loadStudents(ctx, L);
  const school = await School.findById(ctx.schoolId).select('settings.timezone settings.currentSessionId').lean();
  const today = parseDateOnly(todayInTz(school?.settings?.timezone ?? 'Asia/Karachi'));
  const ids = students.map((s) => s._id);
  const [invoices, payments, heads, structures] = await Promise.all([
    Invoice.find(scope(ctx, { studentId: { $in: ids }, status: { $ne: 'cancelled' } }))
      .select('invoiceNo kind period studentId issueDate dueDate total paid balance status')
      .sort({ period: 1, invoiceNo: 1 })
      .lean(),
    Payment.find(scope(ctx, { studentId: { $in: ids } }))
      .select('receiptNo receivedAt studentId invoiceId amount method reference receivedByName status')
      .sort({ receivedAt: 1 })
      .lean(),
    FeeHead.find(scope(ctx, { frequency: 'monthly' }))
      .select('_id')
      .lean(),
    FeeStructure.find(
      scope(ctx, {
        isActive: true,
        ...(school?.settings?.currentSessionId ? { sessionId: school.settings.currentSessionId } : {}),
      }),
    )
      .select('classId items')
      .lean(),
  ]);
  const monthly = new Set(heads.map((h) => String(h._id)));
  const classMonthly = new Map(
    structures.map((st) => [
      String(st.classId),
      st.items.filter((i) => monthly.has(String(i.feeHeadId))).reduce((a, i) => a + i.amount, 0),
    ]),
  );
  const studentById = new Map(students.map((s) => [String(s._id), s]));
  const invoiceNo = new Map(invoices.map((i) => [String(i._id), i.invoiceNo]));
  const byStudent = new Map<string, typeof invoices>();
  for (const i of invoices) byStudent.set(String(i.studentId), [...(byStudent.get(String(i.studentId)) ?? []), i]);
  const lastPaid = new Map<string, Date>();
  for (const p of payments) if (p.status === 'valid') lastPaid.set(String(p.studentId), p.receivedAt);
  const who = (id: unknown) => {
    const s = studentById.get(String(id));
    return s
      ? {
          admissionNo: s.admissionNo,
          student: fullName(s),
          className: L.className.get(String(s.classId)) ?? '',
          sectionName: L.sectionName.get(String(s.sectionId)) ?? '',
        }
      : { admissionNo: '', student: '', className: '', sectionName: '' };
  };

  const summary = students.map((s) => {
    const list = byStudent.get(String(s._id)) ?? [];
    const billed = list.reduce((a, i) => a + i.total, 0);
    const paid = list.reduce((a, i) => a + i.paid, 0);
    const outstanding = list.reduce((a, i) => a + i.balance, 0);
    const overdue = list.filter((i) => i.balance > 0 && i.dueDate < today).reduce((a, i) => a + i.balance, 0);
    const own = (s.customFees ?? []).reduce((a, c) => a + c.amount, 0);
    const primary = (s.guardians ?? []).find((g) => g.isPrimary) ?? s.guardians?.[0];
    const p = primary ? parentById.get(String(primary.parentId)) : undefined;
    return {
      ...who(s._id),
      parent: p?.name ?? '',
      phone: p?.phone ?? '',
      monthlyFee: s.customFees?.length ? own : (classMonthly.get(String(s.classId)) ?? ''),
      feeSource: s.customFees?.length ? 'Own fee' : classMonthly.has(String(s.classId)) ? 'Class fee' : 'Not set',
      billed,
      paid,
      outstanding,
      overdue,
      unpaidInvoices: list.filter((i) => i.balance > 0).length,
      lastPayment: day(lastPaid.get(String(s._id))),
      state: !list.length ? 'Not billed yet' : outstanding === 0 ? 'Paid up' : paid > 0 ? 'Partly paid' : 'Unpaid',
    };
  });
  const money = true;
  return [
    {
      name: 'Fee summary',
      columns: [
        { key: 'admissionNo', header: 'Admission No' },
        { key: 'student', header: 'Student Name', width: 24 },
        { key: 'className', header: 'Class' },
        { key: 'sectionName', header: 'Section' },
        { key: 'parent', header: 'Father / Guardian', width: 22 },
        { key: 'phone', header: 'Phone' },
        { key: 'monthlyFee', header: 'Monthly Fee', money },
        { key: 'feeSource', header: 'Fee Set By' },
        { key: 'billed', header: 'Total Billed', money },
        { key: 'paid', header: 'Total Paid', money },
        { key: 'outstanding', header: 'Outstanding', money },
        { key: 'overdue', header: 'Overdue', money },
        { key: 'unpaidInvoices', header: 'Unpaid Invoices' },
        { key: 'lastPayment', header: 'Last Payment' },
        { key: 'state', header: 'Status' },
      ],
      rows: summary,
    },
    {
      name: 'Invoices',
      columns: [
        { key: 'invoiceNo', header: 'Invoice No' },
        { key: 'period', header: 'Month' },
        { key: 'kind', header: 'Type' },
        { key: 'admissionNo', header: 'Admission No' },
        { key: 'student', header: 'Student Name', width: 24 },
        { key: 'className', header: 'Class' },
        { key: 'issueDate', header: 'Issued' },
        { key: 'dueDate', header: 'Due' },
        { key: 'total', header: 'Total', money },
        { key: 'paid', header: 'Paid', money },
        { key: 'balance', header: 'Balance', money },
        { key: 'status', header: 'Status' },
      ],
      rows: invoices.map((i) => ({
        invoiceNo: i.invoiceNo,
        period: i.period,
        kind: KIND[i.kind ?? 'regular'] ?? i.kind,
        ...who(i.studentId),
        issueDate: day(i.issueDate),
        dueDate: day(i.dueDate),
        total: i.total,
        paid: i.paid,
        balance: i.balance,
        status: titleCase(i.status),
      })),
    },
    {
      name: 'Payments',
      columns: [
        { key: 'receiptNo', header: 'Receipt No' },
        { key: 'date', header: 'Date' },
        { key: 'admissionNo', header: 'Admission No' },
        { key: 'student', header: 'Student Name', width: 24 },
        { key: 'className', header: 'Class' },
        { key: 'invoiceNo', header: 'Invoice No' },
        { key: 'amount', header: 'Amount', money },
        { key: 'method', header: 'Method' },
        { key: 'reference', header: 'Reference' },
        { key: 'receivedBy', header: 'Received By' },
        { key: 'status', header: 'Status' },
      ],
      rows: payments.map((p) => ({
        receiptNo: p.receiptNo,
        date: day(p.receivedAt),
        ...who(p.studentId),
        invoiceNo: invoiceNo.get(String(p.invoiceId)) ?? '',
        amount: p.amount,
        method: titleCase(p.method),
        reference: p.reference ?? '',
        receivedBy: p.receivedByName ?? '',
        status: p.status === 'reversed' ? 'Reversed' : 'Valid',
      })),
    },
  ];
}

async function loadStaff(ctx: Ctx) {
  return Employee.find(scope(ctx, campusScope(ctx)))
    .select(
      'employeeNo firstName lastName staffType designation department gender phone email cnic qualification joiningDate salary bankAccount address campusId status',
    )
    .sort({ employeeNo: 1 })
    .lean();
}

async function staffSheet(ctx: Ctx): Promise<Sheet> {
  const [staff, L] = await Promise.all([loadStaff(ctx), lookups(ctx)]);
  return {
    name: 'Staff',
    columns: templateColumns('staff'),
    rows: staff.map((e) => ({
      employeeNo: e.employeeNo,
      fullName: fullName(e),
      staffType: e.staffType === 'teaching' ? 'Teaching' : 'Non-teaching',
      designation: e.designation,
      department: e.department ?? '',
      gender: titleCase(e.gender),
      phone: e.phone ?? '',
      email: e.email ?? '',
      cnic: e.cnic ?? '',
      qualification: e.qualification ?? '',
      joiningDate: day(e.joiningDate),
      basicSalary: e.salary?.basic ?? '',
      address: e.address ?? '',
      campusName: L.campusName.get(String(e.campusId)) ?? '',
      status: titleCase(e.status),
    })),
  };
}

async function salariesSheet(ctx: Ctx): Promise<Sheet> {
  const staff = await loadStaff(ctx);
  const money = true;
  return {
    name: 'Salaries',
    columns: [
      { key: 'employeeNo', header: 'Employee No' },
      { key: 'name', header: 'Full Name', width: 24 },
      { key: 'designation', header: 'Designation', width: 18 },
      { key: 'staffType', header: 'Staff Type' },
      { key: 'basic', header: 'Basic Salary', money },
      { key: 'allowances', header: 'Allowances', money },
      { key: 'deductions', header: 'Deductions', money },
      { key: 'net', header: 'Net Salary', money },
      { key: 'bankAccount', header: 'Bank Account', width: 20 },
      { key: 'status', header: 'Status' },
    ],
    rows: staff.map((e) => {
      const basic = e.salary?.basic ?? 0;
      const allowances = e.salary?.allowances ?? 0;
      const deductions = e.salary?.deductions ?? 0;
      return {
        employeeNo: e.employeeNo,
        name: fullName(e),
        designation: e.designation,
        staffType: e.staffType === 'teaching' ? 'Teaching' : 'Non-teaching',
        basic,
        allowances,
        deductions,
        net: basic + allowances - deductions,
        bankAccount: e.bankAccount ?? '',
        status: titleCase(e.status),
      };
    }),
  };
}

async function timetableSheet(ctx: Ctx): Promise<Sheet> {
  const school = await School.findById(ctx.schoolId).select('settings.currentSessionId').lean();
  const sessionId = school?.settings?.currentSessionId;
  const [entries, L] = await Promise.all([
    sessionId ? TimetableEntry.find(scope(ctx, { sessionId, ...campusScope(ctx) })).lean() : Promise.resolve([]),
    lookups(ctx),
  ]);
  const [subjects, teachers, sections] = await Promise.all([
    Subject.find(scope(ctx)).select('name').lean(),
    Employee.find(scope(ctx)).select('firstName lastName').lean(),
    Section.find(scope(ctx)).select('classId').lean(),
  ]);
  const subject = new Map(subjects.map((s) => [String(s._id), s.name]));
  const teacher = new Map(teachers.map((t) => [String(t._id), fullName(t)]));
  const classOf = new Map(sections.map((s) => [String(s._id), String(s.classId)]));
  const rows = entries
    .map((e) => {
      const classId = classOf.get(String(e.sectionId)) ?? '';
      return {
        level: Number(L.classLevel.get(classId) ?? 99),
        className: L.className.get(classId) ?? '',
        sectionName: L.sectionName.get(String(e.sectionId)) ?? '',
        dayNo: e.dayOfWeek,
        day: WEEKDAY_NAMES[e.dayOfWeek - 1],
        start: e.startTime,
        end: e.endTime,
        subject: subject.get(String(e.subjectId)) ?? '',
        teacher: e.teacherId ? (teacher.get(String(e.teacherId)) ?? '') : '',
        room: e.room ?? '',
      };
    })
    .sort(
      (a, b) =>
        a.level - b.level ||
        a.sectionName.localeCompare(b.sectionName) ||
        a.dayNo - b.dayNo ||
        a.start.localeCompare(b.start),
    );
  return {
    name: 'Timetable',
    columns: [
      { key: 'className', header: 'Class' },
      { key: 'sectionName', header: 'Section' },
      { key: 'day', header: 'Day' },
      { key: 'start', header: 'Start' },
      { key: 'end', header: 'End' },
      { key: 'subject', header: 'Subject', width: 20 },
      { key: 'teacher', header: 'Teacher', width: 22 },
      { key: 'room', header: 'Room' },
    ],
    rows,
  };
}

const BUILDERS: Record<Dataset, (ctx: Ctx) => Promise<Sheet[]>> = {
  students: async (ctx) => [await studentsSheet(ctx)],
  parents: async (ctx) => [await parentsSheet(ctx)],
  families: async (ctx) => [await familiesSheet(ctx)],
  fees: feeSheets,
  staff: async (ctx) => [await staffSheet(ctx)],
  salaries: async (ctx) => [await salariesSheet(ctx)],
  timetable: async (ctx) => [await timetableSheet(ctx)],
};

async function workbook(sheets: Sheet[], about: string[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'School OS';
  wb.created = new Date();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = sh.columns.map((c) => ({
      key: c.key,
      header: c.header,
      width: c.width ?? Math.max(12, Math.min(30, c.header.length + 4)),
      // Text columns keep leading zeros (phones, admission numbers).
      style: c.money ? { numFmt: '#,##0' } : { numFmt: '@' },
    }));
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }));
    for (const r of sh.rows) ws.addRow(r);
    if (sh.rows.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: sh.columns.length } };
  }
  const info = wb.addWorksheet('About');
  info.columns = [{ width: 100 }];
  for (const line of about) info.addRow([line]);
  info.getRow(1).font = { bold: true, size: 13 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** One dataset (or "all": every dataset the user may download, one sheet each). */
export async function exportData(ctx: Ctx, dataset: Dataset | 'all', format: 'xlsx' | 'csv') {
  const wanted = dataset === 'all' ? DATASET_KEYS.filter((d) => canExport(ctx, d)) : [dataset];
  if (dataset !== 'all' && !canExport(ctx, dataset))
    throw forbidden(
      `You need the “${DATASETS[dataset].permission}” permission to download ${DATASETS[dataset].label.toLowerCase()}`,
    );
  if (!wanted.length) throw forbidden('You have no permission to download school data');
  const sheets = (await Promise.all(wanted.map((d) => BUILDERS[d](ctx)))).flat();
  const school = await School.findById(ctx.schoolId).select('name settings.timezone').lean();
  const date = todayInTz(school?.settings?.timezone ?? 'Asia/Karachi');
  await audit(ctx, {
    action: 'school.data_exported',
    entityType: 'School',
    entityId: ctx.schoolId,
    summary: `Downloaded ${wanted.join(', ')} (${format})`,
    metadata: { datasets: wanted, format, rows: sheets.reduce((a, s) => a + s.rows.length, 0) },
  });
  const slug = (school?.name ?? 'school')
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const base = `${slug}-${dataset}-${date}`;
  if (format === 'csv') {
    if (sheets.length !== 1)
      throw badRequest('CSV holds one table: choose Excel for this download', { field: 'format' });
    return {
      fileName: `${base}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(toCsv(sheets[0].columns, sheets[0].rows)),
    };
  }
  const skipped = dataset === 'all' ? DATASET_KEYS.filter((d) => !canExport(ctx, d)) : [];
  const about = [
    `${school?.name ?? 'School'} — data downloaded ${date}`,
    ...sheets.map((s) => `${s.name}: ${s.rows.length} rows`),
    'Students, Parents and Staff use the columns of the import templates: edit and import them again under Import data.',
    ...(skipped.length ? [`Not included (no permission): ${skipped.map((d) => DATASETS[d].label).join(', ')}`] : []),
  ];
  return {
    fileName: `${base}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: await workbook(sheets, about),
  };
}
