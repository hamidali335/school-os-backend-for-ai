/**
 * Demo seed: "Bright Future School System", Bahawalpur, academic session 2026-2027.
 *
 *   SEED_DEMO_PASSWORD='Choose-A-Strong-Pass-1' npm run seed
 *
 * - All people, phone numbers and emails are fictional (emails use the reserved
 *   ".example" domain; phone numbers use a fictional +92300-55xxxxx range).
 * - Idempotent: every record is upserted on a natural key (codes, admission numbers,
 *   emails, idempotency keys), so running it again does not create duplicates and does
 *   not overwrite passwords that users have since changed.
 * - Refuses to run when NODE_ENV=production unless --allow-production is passed.
 */
import mongoose, { Types } from 'mongoose';
import { closeHasherPool } from '../src/modules/auth/password-hasher';
import { env } from '../src/config/env';
import { ROLE_PERMISSIONS, type SchoolRole } from '../src/config/permissions';
import { connectDatabase } from '../src/database/connection';
import { Expense, Income } from '../src/modules/accounts/accounts.models';
import {
  AcademicSession,
  SchoolClass,
  Section,
  Subject,
  TeachingAssignment,
} from '../src/modules/academics/academics.models';
import { Inquiry } from '../src/modules/admissions/inquiry.model';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { hashPassword } from '../src/modules/auth/tokens';
import { AutomationRule, type AutomationType } from '../src/modules/automations/automation.models';
import { computeNextRun } from '../src/modules/automations/automations.service';
import { Campus } from '../src/modules/campuses/campus.model';
import { Announcement } from '../src/modules/communications/communications.models';
import { Employee } from '../src/modules/employees/employee.model';
import { Exam, ExamPaper, Mark } from '../src/modules/examinations/exam.models';
import { FeeHead, FeeStructure, Invoice } from '../src/modules/fees/fees.models';
import { generateInvoices, recordPayment } from '../src/modules/fees/fees.service';
import { School } from '../src/modules/schools/school.model';
import { onboardSchool } from '../src/modules/schools/schools.service';
import { Parent, Student, StudentEnrollment } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { DEFAULT_PLAN_TEMPLATES, templateDocument } from '../src/modules/subscriptions/default-plans';
import { FEATURE_KEYS } from '../src/config/entitlements';
import { TimetableEntry } from '../src/modules/timetable/timetable.model';
import { User } from '../src/modules/users/user.model';
import type { SchoolContext } from '../src/types/context';
import { addDays, formatDateOnly, parseDateOnly, timeToMinutes, todayInTz } from '../src/utils/dates';

const SCHOOL_CODE = 'BFSS';
const DOMAIN = 'brightfuture.example';
const TZ = 'Asia/Karachi';

// ─── Deterministic pseudo-random generator (same data on every run) ───
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(2026);
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

const BOYS = [
  'Muhammad Ahmed',
  'Ali',
  'Hamza',
  'Usman',
  'Bilal',
  'Hassan',
  'Hussain',
  'Abdullah',
  'Zain',
  'Saad',
  'Talha',
  'Fahad',
  'Umar',
  'Ibrahim',
  'Haris',
  'Rayyan',
  'Shayan',
  'Arham',
  'Ayaan',
  'Daniyal',
];
const GIRLS = [
  'Ayesha',
  'Fatima',
  'Zainab',
  'Maryam',
  'Hira',
  'Sana',
  'Iqra',
  'Amna',
  'Khadija',
  'Aleena',
  'Hania',
  'Anaya',
  'Mahnoor',
  'Eman',
  'Laiba',
  'Minahil',
  'Zoha',
  'Areeba',
  'Noor',
  'Rida',
];
const SURNAMES = [
  'Khan',
  'Ahmed',
  'Malik',
  'Qureshi',
  'Siddiqui',
  'Abbasi',
  'Chaudhry',
  'Bhatti',
  'Rana',
  'Sheikh',
  'Butt',
  'Awan',
  'Javed',
  'Iqbal',
  'Hashmi',
  'Gillani',
  'Bukhari',
  'Shah',
];
const FATHERS = [
  'Imran',
  'Kashif',
  'Asif',
  'Naveed',
  'Tariq',
  'Shahid',
  'Khalid',
  'Rizwan',
  'Adnan',
  'Waqas',
  'Junaid',
  'Sajid',
  'Amjad',
  'Zahid',
  'Nadeem',
  'Arshad',
];
const AREAS = [
  'Model Town A',
  'Satellite Town',
  'Shahdara',
  'Cantt',
  'Islamia Colony',
  'Fareed Gate',
  'Baghdad-ul-Jadeed',
  'Gulberg Colony',
];

let quiet = false;
const log = (msg: string) => {
  if (!quiet) console.log(`  • ${msg}`);
};

async function upsert(
  model: mongoose.Model<any>,
  filter: Record<string, unknown>,
  onInsert: Record<string, unknown>,
  set: Record<string, unknown> = {},
) {
  return model
    .findOneAndUpdate(
      filter as any,
      { $setOnInsert: onInsert, ...(Object.keys(set).length ? { $set: set } : {}) } as any,
      {
        upsert: true,
        returnDocument: 'after',
        setDefaultsOnInsert: true,
      },
    )
    .lean() as Promise<any>;
}

/** Seeds the demo school into the currently connected database. Safe to run repeatedly. */
export async function runSeed(password: string, opts: { quiet?: boolean } = {}) {
  quiet = !!opts.quiet;
  await mongoose.connection.syncIndexes();
  const passwordHash = await hashPassword(password);
  log('Seeding Bright Future School System (Bahawalpur, 2026-2027)…');

  // ── Plans ── (templates only: existing plans are never overwritten; edit them in the admin panel)
  for (const tpl of DEFAULT_PLAN_TEMPLATES)
    await Plan.updateOne({ code: tpl.code }, { $setOnInsert: templateDocument(tpl) }, { upsert: true });
  log('Subscription plans: basic, pro, pro_max');

  // ── School, campuses, owner ──
  let school = await School.findOne({ code: SCHOOL_CODE }).lean();
  if (!school) {
    await onboardSchool({
      name: 'Bright Future School System',
      code: SCHOOL_CODE,
      city: 'Bahawalpur',
      address: 'Main Campus, Satellite Town, Bahawalpur, Punjab',
      phone: '+92625550100',
      email: `info@${DOMAIN}`,
      planCode: 'pro_max',
      campus: { name: 'Main Campus (Satellite Town)', code: 'MAIN' },
      owner: { name: 'Mr. Khalid Mahmood', email: `owner@${DOMAIN}`, password },
    });
    school = await School.findOne({ code: SCHOOL_CODE }).lean();
  }
  const schoolId = school!._id;
  // The demo school is on Pro Max (it demonstrates AI). A database seeded before the plan
  // templates existed keeps its plan: only a school with no plan is moved.
  const proMax = await Plan.findOne({ code: 'pro_max' }).lean();
  if (!school!.subscription?.planId)
    await School.updateOne(
      { _id: schoolId },
      {
        $set: {
          'subscription.planId': proMax!._id,
          'subscription.billingPeriod': 'monthly',
          'subscription.agreedPrice': {
            amount: proMax!.prices?.monthly?.amount ?? proMax!.priceMonthlyPkr,
            currency: 'PKR',
            period: 'monthly',
            setAt: new Date(),
          },
        },
      },
    );
  await School.updateOne(
    { _id: schoolId },
    {
      $set: {
        'subscription.status': 'active',
        'subscription.currentPeriodEnd': parseDateOnly('2027-03-31'),
        'settings.fees.lateFeeAmount': 300,
        'settings.fees.lateFeeGraceDays': 5,
        'settings.fees.bankDetails': 'Demo Bank Ltd, Bahawalpur Branch — A/C 0000-DEMO-0000 (fictional)',
      },
    },
  );
  const S = { schoolId } as const;
  const main = await Campus.findOne({ ...S, code: 'MAIN' }).lean();
  const junior = await upsert(
    Campus,
    { ...S, code: 'JR' },
    { name: 'Junior Campus (Model Town A)', address: 'Model Town A, Bahawalpur', city: 'Bahawalpur', isMain: false },
  );
  log('School BFSS with Main and Junior campuses');

  const owner = await User.findOne({ ...S, email: `owner@${DOMAIN}` }).lean();
  const ownerCtx: SchoolContext = {
    kind: 'school',
    userId: owner!._id.toString(),
    schoolId: schoolId.toString(),
    role: 'school_owner',
    name: owner!.name,
    email: owner!.email ?? '',
    campusIds: [],
    permissions: ROLE_PERMISSIONS.school_owner,
    // The seed writes data directly as the owner; plan checks apply to API requests.
    entitlements: new Set(FEATURE_KEYS),
    subscriptionEligible: true,
  };

  // ── Academic session ──
  const session = await upsert(
    AcademicSession,
    { ...S, name: '2026-2027' },
    { startDate: parseDateOnly('2026-04-01'), endDate: parseDateOnly('2027-03-31'), status: 'active' },
    { isCurrent: true },
  );
  await School.updateOne({ _id: schoolId }, { $set: { 'settings.currentSessionId': session._id } });

  // ── Classes and sections ──
  const classDefs = [
    { name: 'Playgroup', level: -2, campus: junior._id, sections: ['A'] },
    { name: 'Nursery', level: -1, campus: junior._id, sections: ['A'] },
    { name: 'Prep', level: 0, campus: junior._id, sections: ['A'] },
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `Class ${i + 1}`,
      level: i + 1,
      campus: main!._id,
      sections: i === 0 || i === 4 ? ['A', 'B'] : ['A'],
    })),
  ];
  const classes: Array<{
    _id: Types.ObjectId;
    name: string;
    level: number;
    campusId: Types.ObjectId;
    sections: any[];
  }> = [];
  for (const c of classDefs) {
    const cls = await upsert(SchoolClass, { ...S, campusId: c.campus, name: c.name }, { level: c.level });
    const sections = [];
    for (const name of c.sections) {
      sections.push(
        await upsert(
          Section,
          { ...S, sessionId: session._id, classId: cls._id, name },
          { campusId: c.campus, capacity: 35, room: `${c.name.replace('Class ', 'R')}-${name}` },
        ),
      );
    }
    classes.push({ ...cls, campusId: c.campus, sections });
  }
  log(`${classes.length} classes, ${classes.reduce((n, c) => n + c.sections.length, 0)} sections`);

  // ── Subjects ──
  const subjectDefs = [
    ['English', 'ENG'],
    ['Urdu', 'URD'],
    ['Mathematics', 'MATH'],
    ['General Science', 'SCI'],
    ['Islamiyat', 'ISL'],
    ['Social Studies', 'SST'],
    ['Computer Studies', 'COMP'],
    ['Nazra Quran', 'QURAN'],
  ];
  const subjects: Record<string, any> = {};
  for (const [name, code] of subjectDefs) {
    subjects[code] = await upsert(Subject, { ...S, code }, { name }, { classIds: classes.map((c) => c._id) });
  }

  // ── Employees and staff logins ──
  const staffDefs: Array<{
    no: string;
    first: string;
    last: string;
    gender: 'male' | 'female';
    designation: string;
    type: 'teaching' | 'non_teaching';
    basic: number;
    role?: SchoolRole;
    email?: string;
    campus?: Types.ObjectId;
  }> = [
    {
      no: 'BFS-E-001',
      first: 'Saima',
      last: 'Rauf',
      gender: 'female',
      designation: 'Principal',
      type: 'teaching',
      basic: 120000,
      role: 'principal',
      email: `principal@${DOMAIN}`,
    },
    {
      no: 'BFS-E-002',
      first: 'Waseem',
      last: 'Akhtar',
      gender: 'male',
      designation: 'Administrative Officer',
      type: 'non_teaching',
      basic: 65000,
      role: 'school_admin',
      email: `admin@${DOMAIN}`,
    },
    {
      no: 'BFS-E-003',
      first: 'Naeem',
      last: 'Ashraf',
      gender: 'male',
      designation: 'Accountant',
      type: 'non_teaching',
      basic: 60000,
      role: 'accountant',
      email: `accounts@${DOMAIN}`,
    },
    {
      no: 'BFS-E-004',
      first: 'Ayesha',
      last: 'Siddiqui',
      gender: 'female',
      designation: 'Senior Teacher (Mathematics)',
      type: 'teaching',
      basic: 55000,
      role: 'teacher',
      email: `teacher.ayesha@${DOMAIN}`,
    },
    {
      no: 'BFS-E-005',
      first: 'Bilal',
      last: 'Hashmi',
      gender: 'male',
      designation: 'Teacher (English)',
      type: 'teaching',
      basic: 50000,
      role: 'teacher',
      email: `teacher.bilal@${DOMAIN}`,
    },
    {
      no: 'BFS-E-006',
      first: 'Rabia',
      last: 'Noor',
      gender: 'female',
      designation: 'Teacher (Science)',
      type: 'teaching',
      basic: 48000,
      role: 'teacher',
      email: `teacher.rabia@${DOMAIN}`,
    },
    {
      no: 'BFS-E-007',
      first: 'Farhan',
      last: 'Latif',
      gender: 'male',
      designation: 'Teacher (Urdu)',
      type: 'teaching',
      basic: 46000,
    },
    {
      no: 'BFS-E-008',
      first: 'Sadia',
      last: 'Kamran',
      gender: 'female',
      designation: 'Teacher (Islamiyat)',
      type: 'teaching',
      basic: 45000,
    },
    {
      no: 'BFS-E-009',
      first: 'Asma',
      last: 'Javed',
      gender: 'female',
      designation: 'Teacher (Computer)',
      type: 'teaching',
      basic: 47000,
    },
    {
      no: 'BFS-E-010',
      first: 'Kiran',
      last: 'Shahzad',
      gender: 'female',
      designation: 'Montessori Directress',
      type: 'teaching',
      basic: 42000,
      campus: junior._id,
    },
    {
      no: 'BFS-E-011',
      first: 'Nabila',
      last: 'Arif',
      gender: 'female',
      designation: 'Montessori Directress',
      type: 'teaching',
      basic: 42000,
      campus: junior._id,
    },
    {
      no: 'BFS-E-012',
      first: 'Qari',
      last: 'Abdul Rehman',
      gender: 'male',
      designation: 'Teacher (Nazra Quran)',
      type: 'teaching',
      basic: 38000,
    },
    {
      no: 'BFS-E-013',
      first: 'Mehwish',
      last: 'Tahir',
      gender: 'female',
      designation: 'Teacher (Social Studies)',
      type: 'teaching',
      basic: 44000,
    },
    {
      no: 'BFS-E-014',
      first: 'Imtiaz',
      last: 'Ali',
      gender: 'male',
      designation: 'Office Assistant',
      type: 'non_teaching',
      basic: 32000,
    },
    {
      no: 'BFS-E-015',
      first: 'Ghulam',
      last: 'Fareed',
      gender: 'male',
      designation: 'Security Guard',
      type: 'non_teaching',
      basic: 28000,
    },
    {
      no: 'BFS-E-016',
      first: 'Shabana',
      last: 'Bibi',
      gender: 'female',
      designation: 'Cleaning Staff',
      type: 'non_teaching',
      basic: 25000,
      campus: junior._id,
    },
  ];
  const employees: Record<string, any> = {};
  for (const d of staffDefs) {
    const emp = await upsert(
      Employee,
      { ...S, employeeNo: d.no },
      {
        campusId: d.campus ?? main!._id,
        firstName: d.first,
        lastName: d.last,
        gender: d.gender,
        designation: d.designation,
        staffType: d.type,
        phone: `+92300550${d.no.slice(-3)}0`,
        joiningDate: parseDateOnly('2024-08-01'),
        salary: { basic: d.basic, allowances: Math.round(d.basic * 0.1), deductions: 0 },
      },
    );
    employees[d.no] = emp;
    if (d.role && d.email) {
      const u = await upsert(
        User,
        { ...S, email: d.email },
        { name: `${d.first} ${d.last}`, passwordHash, role: d.role, employeeId: emp._id },
      );
      if (!emp.userId) await Employee.updateOne({ ...S, _id: emp._id }, { $set: { userId: u._id } });
    }
  }
  log(`${staffDefs.length} employees; logins for principal, admin, accountant and 3 teachers`);

  // ── Class teachers and teaching assignments ──
  const teacherFor: Record<string, string> = {
    MATH: 'BFS-E-004',
    ENG: 'BFS-E-005',
    SCI: 'BFS-E-006',
    URD: 'BFS-E-007',
    ISL: 'BFS-E-008',
    COMP: 'BFS-E-009',
    QURAN: 'BFS-E-012',
    SST: 'BFS-E-013',
  };
  const classTeacherRotation = [
    'BFS-E-004',
    'BFS-E-005',
    'BFS-E-006',
    'BFS-E-007',
    'BFS-E-008',
    'BFS-E-009',
    'BFS-E-013',
    'BFS-E-012',
  ];
  let rot = 0;
  for (const c of classes) {
    for (const sec of c.sections) {
      const ct =
        c.level <= 0
          ? c.level === -2
            ? 'BFS-E-010'
            : 'BFS-E-011'
          : classTeacherRotation[rot++ % classTeacherRotation.length];
      await Section.updateOne({ ...S, _id: sec._id }, { $set: { classTeacherId: employees[ct]._id } });
      if (c.level >= 1) {
        for (const [code, empNo] of Object.entries(teacherFor)) {
          if (code === 'COMP' && c.level < 3) continue;
          await upsert(
            TeachingAssignment,
            { ...S, sectionId: sec._id, subjectId: subjects[code]._id },
            { sessionId: session._id, teacherId: employees[empNo]._id },
          );
        }
      }
    }
  }

  // ── Fee heads and structures ──
  const heads = {
    tuition: await upsert(
      FeeHead,
      { ...S, code: 'TUITION' },
      { name: 'Tuition Fee', frequency: 'monthly', concessionApplies: true },
    ),
    computer: await upsert(FeeHead, { ...S, code: 'COMPLAB' }, { name: 'Computer Lab Fee', frequency: 'monthly' }),
    admission: await upsert(FeeHead, { ...S, code: 'ADMISSION' }, { name: 'Admission Fee', frequency: 'one_time' }),
    annual: await upsert(FeeHead, { ...S, code: 'ANNUAL' }, { name: 'Annual Charges', frequency: 'annual' }),
    exam: await upsert(FeeHead, { ...S, code: 'EXAM' }, { name: 'Examination Fee', frequency: 'annual' }),
  };
  for (const c of classes) {
    const tuition = c.level <= 0 ? 3500 + (c.level + 2) * 250 : 4500 + c.level * 400;
    const items: any[] = [
      { feeHeadId: heads.tuition._id, amount: tuition },
      { feeHeadId: heads.admission._id, amount: 8000 },
      { feeHeadId: heads.annual._id, amount: 6000, billingMonths: [4] },
      { feeHeadId: heads.exam._id, amount: 1500, billingMonths: [9, 2] },
    ];
    if (c.level >= 3) items.push({ feeHeadId: heads.computer._id, amount: 500 });
    await FeeStructure.updateOne(
      { ...S, sessionId: session._id, classId: c._id },
      { $setOnInsert: { name: `${c.name} 2026-2027`, items, isActive: true } },
      { upsert: true },
    );
  }
  log('Fee heads and per-class fee structures');

  // ── Students and parents ──
  let admissionSeq = 0;
  let studentCount = 0;
  const allStudents: any[] = [];
  for (const c of classes) {
    for (const sec of c.sections) {
      const n = c.level <= 0 ? 6 : 8;
      for (let i = 0; i < n; i++) {
        admissionSeq++;
        const admissionNo = `BFS-2026-${String(admissionSeq).padStart(4, '0')}`;
        const gender = rand() < 0.5 ? 'male' : 'female';
        const first = pick(gender === 'male' ? BOYS : GIRLS);
        const surname = pick(SURNAMES);
        const fatherName = `${pick(FATHERS)} ${surname}`;
        const phone = `+9230055${String(10000 + admissionSeq * 7).slice(-5)}`;
        const parent = await upsert(
          Parent,
          { ...S, phone },
          {
            name: fatherName,
            relation: 'father',
            whatsapp: phone,
            occupation: pick([
              'Businessman',
              'Government Employee',
              'Doctor',
              'Teacher',
              'Engineer',
              'Shopkeeper',
              'Banker',
              'Farmer',
            ]),
            address: `House ${Math.floor(rand() * 400) + 1}, ${pick(AREAS)}, Bahawalpur`,
            preferredChannel: pick(['whatsapp', 'sms', 'in_app']),
          },
        );
        const age = c.level + 6;
        const st = await upsert(
          Student,
          { ...S, admissionNo },
          {
            campusId: c.campusId,
            rollNo: String(i + 1),
            firstName: first,
            lastName: surname,
            gender,
            dateOfBirth: parseDateOnly(
              `${2026 - age}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}`,
            ),
            sessionId: session._id,
            classId: c._id,
            sectionId: sec._id,
            guardians: [{ parentId: parent._id, relation: 'father', isPrimary: true }],
            admissionDate: parseDateOnly(i < n - 1 ? '2026-04-01' : '2026-08-18'),
            address: parent.address,
            feeConcession:
              i === 2
                ? { type: 'percent', value: 25, reason: 'Sibling concession (demo)' }
                : { type: 'none', value: 0 },
          },
        );
        allStudents.push(st);
        await upsert(
          StudentEnrollment,
          { ...S, studentId: st._id, sessionId: session._id },
          {
            campusId: c.campusId,
            classId: c._id,
            sectionId: sec._id,
            rollNo: String(i + 1),
            status: 'active',
            enrolledAt: parseDateOnly(i < n - 1 ? '2026-04-01' : '2026-08-18'),
            feeConcession: st.feeConcession,
          },
        );
        studentCount++;
      }
    }
  }
  log(`${studentCount} students with parent records`);

  // Demo parent login (students have no login of their own; the parent portal covers them).
  const demoStudent = allStudents.find((s) => s.admissionNo === 'BFS-2026-0060') ?? allStudents[allStudents.length - 1];
  const demoParentId = demoStudent.guardians[0].parentId;
  const parentUser = await upsert(
    User,
    { ...S, email: `parent@${DOMAIN}` },
    { name: 'Demo Parent', passwordHash, role: 'parent', parentId: demoParentId },
  );
  await Parent.updateOne({ ...S, _id: demoParentId }, { $set: { userId: parentUser._id, email: `parent@${DOMAIN}` } });

  // ── Invoices and payments (Aug–Oct 2026) ──
  const today = todayInTz(TZ);
  for (const period of ['2026-08', '2026-09', '2026-10']) {
    await generateInvoices(ownerCtx, { period, dueDate: `${period}-10` });
  }
  const invoices = await Invoice.find({ ...S, period: { $in: ['2026-08', '2026-09', '2026-10'] }, kind: 'regular' })
    .sort({ period: 1, invoiceNo: 1 })
    .lean();
  const payProb: Record<string, number> = { '2026-08': 0.95, '2026-09': 0.82, '2026-10': 0.45 };
  let payments = 0;
  for (const inv of invoices) {
    const r = mulberry32(parseInt(inv.studentId.toString().slice(-6), 16) + Number(inv.period.slice(5)))();
    if (r > payProb[inv.period]) continue;
    const partial = r > payProb[inv.period] * 0.85;
    const amount = partial ? Math.round(inv.total / 2) : inv.total;
    const receivedAt = addDays(parseDateOnly(`${inv.period}-10`), -Math.floor(r * 8));
    if (receivedAt > parseDateOnly(today)) continue;
    try {
      await recordPayment(ownerCtx, inv._id.toString(), {
        amount: Math.min(amount, inv.total),
        method: r < 0.5 ? 'cash' : r < 0.8 ? 'bank_transfer' : 'online',
        receivedAt: receivedAt.toISOString(),
        idempotencyKey: `seed-${inv.invoiceNo}`,
      });
      payments++;
    } catch {
      /* already settled on a previous run */
    }
  }
  log(`${invoices.length} invoices (Aug–Oct 2026), ${payments} payments recorded`);

  // ── Attendance for the last 15 school days (Mon–Sat) ──
  const days: string[] = [];
  for (let d = parseDateOnly(today); days.length < 15; d = addDays(d, -1))
    if (d.getUTCDay() !== 0) days.unshift(formatDateOnly(d));
  const chronic = new Set(allStudents.filter((_, i) => i % 37 === 5).map((s) => s._id.toString()));
  const ops: any[] = [];
  for (const st of allStudents) {
    const r = mulberry32(parseInt(st._id.toString().slice(-6), 16));
    days.forEach((day, idx) => {
      let status: string;
      if (chronic.has(st._id.toString()) && idx >= days.length - 4) status = 'absent';
      else {
        const x = r();
        status = x < 0.88 ? 'present' : x < 0.93 ? 'absent' : x < 0.97 ? 'late' : 'leave';
      }
      ops.push({
        updateOne: {
          filter: { schoolId, studentId: st._id, date: parseDateOnly(day) },
          update: {
            $setOnInsert: {
              status,
              sessionId: session._id,
              campusId: st.campusId,
              classId: st.classId,
              sectionId: st.sectionId,
              markedBy: owner!._id,
            },
          },
          upsert: true,
        },
      });
    });
  }
  await AttendanceRecord.bulkWrite(ops, { ordered: false });
  log(`Attendance for ${days.length} school days (${days[0]} → ${days[days.length - 1]})`);

  // ── Timetable for Class 5-A ──
  const c5 = classes.find((c) => c.name === 'Class 5')!;
  const c5a = c5.sections[0];
  const periods = [
    ['08:00', '08:40'],
    ['08:40', '09:20'],
    ['09:20', '10:00'],
    ['10:30', '11:10'],
    ['11:10', '11:50'],
    ['11:50', '12:30'],
  ];
  const weekly = ['MATH', 'ENG', 'URD', 'SCI', 'ISL', 'SST'];
  await TimetableEntry.deleteMany({ ...S, sectionId: c5a._id });
  const entries = [];
  for (let day = 1; day <= 5; day++) {
    for (let p = 0; p < periods.length; p++) {
      const code = weekly[(p + day) % weekly.length];
      entries.push({
        schoolId,
        sessionId: session._id,
        campusId: c5.campusId,
        sectionId: c5a._id,
        subjectId: subjects[code]._id,
        teacherId: employees[teacherFor[code]]._id,
        dayOfWeek: day,
        startTime: periods[p][0],
        endTime: periods[p][1],
        startMinutes: timeToMinutes(periods[p][0]),
        endMinutes: timeToMinutes(periods[p][1]),
        room: c5a.room,
      });
    }
  }
  await TimetableEntry.insertMany(entries);
  log('Weekly timetable for Class 5-A');

  // ── Exam with marks (Class 5 and Class 8) ──
  const c8 = classes.find((c) => c.name === 'Class 8')!;
  const exam = await upsert(
    Exam,
    { ...S, sessionId: session._id, name: 'First Term Examination 2026' },
    {
      term: 'first_term',
      startDate: parseDateOnly('2026-09-14'),
      endDate: parseDateOnly('2026-09-22'),
      classIds: [c5._id, c8._id],
      status: 'published',
      publishedAt: parseDateOnly('2026-10-01'),
    },
  );
  for (const cls of [c5, c8]) {
    for (const [i, code] of ['ENG', 'URD', 'MATH', 'SCI', 'ISL'].entries()) {
      const paper = await upsert(
        ExamPaper,
        { ...S, examId: exam._id, classId: cls._id, subjectId: subjects[code]._id },
        { maxMarks: 100, passMarks: 33, date: parseDateOnly(`2026-09-${14 + i}`) },
      );
      const markOps = allStudents
        .filter((s) => s.classId.toString() === cls._id.toString())
        .map((s) => {
          const r = mulberry32(parseInt(s._id.toString().slice(-6), 16) + i)();
          return {
            updateOne: {
              filter: { schoolId, paperId: paper._id, studentId: s._id },
              update: {
                $setOnInsert: {
                  examId: exam._id,
                  sectionId: s.sectionId,
                  classId: cls._id,
                  subjectId: subjects[code]._id,
                  obtained: Math.round(28 + r * 70),
                  isAbsent: false,
                },
              },
              upsert: true,
            },
          };
        });
      await Mark.bulkWrite(markOps as any, { ordered: false });
    }
  }
  log('First Term Examination 2026 with published marks for Class 5 and Class 8');

  // ── Admissions inquiries ──
  const stages = [
    'new',
    'new',
    'contacted',
    'contacted',
    'visit_scheduled',
    'test_scheduled',
    'offered',
    'admitted',
    'lost',
    'contacted',
    'new',
    'visit_scheduled',
    'lost',
    'offered',
    'new',
    'contacted',
    'admitted',
    'test_scheduled',
  ];
  const sources = ['walk_in', 'facebook', 'referral', 'phone', 'website', 'whatsapp', 'event'];
  const admin = await User.findOne({ ...S, email: `admin@${DOMAIN}` }).lean();
  for (let i = 0; i < stages.length; i++) {
    const gender = i % 2 ? 'female' : 'male';
    const surname = pick(SURNAMES);
    const cls = classes[Math.floor(rand() * classes.length)];
    const created = addDays(parseDateOnly(today), -Math.floor(2 + rand() * 40));
    const stage = stages[i];
    const open = !['admitted', 'lost'].includes(stage);
    await upsert(
      Inquiry,
      { ...S, inquiryNo: `INQ-S${String(i + 1).padStart(4, '0')}` },
      {
        campusId: cls.campusId,
        studentName: `${pick(gender === 'male' ? BOYS : GIRLS)} ${surname}`,
        gender,
        classSoughtId: cls._id,
        classSoughtName: cls.name,
        parentName: `${pick(FATHERS)} ${surname}`,
        phone: `+9230056${String(20000 + i * 13).slice(-5)}`,
        source: sources[i % sources.length],
        stage,
        priority: pick(['low', 'medium', 'high']),
        assignedTo: admin?._id,
        lastContactedAt: stage === 'new' ? undefined : addDays(created, 1),
        nextFollowUpAt: open ? addDays(parseDateOnly(today), Math.floor(rand() * 6) - 3) : undefined,
        lostReason: stage === 'lost' ? pick(['Fee too high', 'Distance from home', 'Chose another school']) : undefined,
        followUps:
          stage === 'new'
            ? []
            : [
                {
                  at: addDays(created, 1),
                  by: admin?._id,
                  byName: admin?.name,
                  channel: 'call',
                  note: 'Shared fee structure and campus visit timings',
                  outcome: 'Interested',
                },
              ],
        createdAt: created,
      },
    );
  }
  log(`${stages.length} admission inquiries across the funnel`);

  // ── Accounts: expenses and other income ──
  const expenseDefs = [
    ['utilities', 38500, 'LESCO/MEPCO electricity bill'],
    ['utilities', 6200, 'Gas and water'],
    ['stationery', 14800, 'Registers and printing paper'],
    ['maintenance', 22000, 'Classroom fan repairs'],
    ['it_software', 9000, 'Internet and hosting'],
    ['events', 18000, 'Independence Day function'],
  ] as const;
  for (const month of ['2026-08', '2026-09', '2026-10']) {
    for (const [idx, [category, amount, description]] of expenseDefs.entries()) {
      if (month === '2026-10' && idx > 3) continue;
      const ref = `SEED-EXP-${month}-${idx}`;
      await Expense.updateOne(
        { ...S, reference: ref },
        {
          $setOnInsert: {
            category,
            amount,
            description,
            date: parseDateOnly(`${month}-0${3 + idx}`),
            paymentMethod: 'bank_transfer',
            status: 'approved',
            source: 'manual',
            createdBy: owner!._id,
          },
        },
        { upsert: true },
      );
    }
    await Income.updateOne(
      { ...S, reference: `SEED-INC-${month}` },
      {
        $setOnInsert: {
          category: 'canteen',
          amount: 15000,
          date: parseDateOnly(`${month}-28`),
          description: 'Canteen contract share',
          paymentMethod: 'cash',
          createdBy: owner!._id,
        },
      },
      { upsert: true },
    );
  }
  log('Expenses and other income for Aug–Oct 2026');

  // ── Announcement and automation rules ──
  await Announcement.updateOne(
    { ...S, title: 'Welcome to Session 2026-2027' },
    {
      $setOnInsert: {
        body: 'Dear parents, welcome to the new academic session. Please keep your contact details up to date with the school office.',
        audience: { roles: ['parent', 'teacher'] },
        channels: ['in_app'],
        status: 'published',
        publishedAt: parseDateOnly('2026-04-01'),
        createdBy: owner!._id,
        createdByName: owner!.name,
        delivery: { status: 'completed', recipients: 0, inApp: 0, external: {} },
      },
    },
    { upsert: true },
  );
  const rules: Array<{
    type: AutomationType;
    name: string;
    schedule: Record<string, unknown>;
    config: Record<string, unknown>;
  }> = [
    {
      type: 'fee_reminder',
      name: 'Overdue fee reminders',
      schedule: { frequency: 'weekly', hour: 10, weekday: 1 },
      config: { channels: ['whatsapp'], minDaysOverdue: 5 },
    },
    {
      type: 'admission_followup',
      name: 'Admission follow-up reminders',
      schedule: { frequency: 'daily', hour: 9 },
      config: { channels: [], minDaysOverdue: 0 },
    },
    {
      type: 'attendance_alert',
      name: 'Absence alerts to parents',
      schedule: { frequency: 'daily', hour: 11 },
      config: { channels: [], minDaysOverdue: 0 },
    },
    {
      type: 'daily_brief',
      name: 'Daily brief to leadership',
      schedule: { frequency: 'daily', hour: 8 },
      config: { channels: [], minDaysOverdue: 0 },
    },
  ];
  for (const r of rules) {
    await AutomationRule.updateOne(
      { ...S, type: r.type },
      { $setOnInsert: { ...r, enabled: true, nextRunAt: computeNextRun(r.schedule, TZ), createdBy: owner!._id } },
      { upsert: true },
    );
  }
  log('Welcome announcement and 4 automation rules');

  return { schoolId: schoolId.toString(), students: studentCount, invoices: invoices.length };
}

export const DEMO_LOGINS = [
  'owner',
  'principal',
  'admin',
  'accounts',
  'teacher.ayesha',
  'teacher.bilal',
  'teacher.rabia',
  'parent',
  'student',
].map((e) => `${e}@${DOMAIN}`);

async function main() {
  if (env.NODE_ENV === 'production' && !process.argv.includes('--allow-production')) {
    throw new Error('Refusing to seed demo data with NODE_ENV=production (pass --allow-production to override).');
  }
  const password = env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 10 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new Error(
      'Set SEED_DEMO_PASSWORD (min 10 chars, upper, lower and a digit). It is used for every demo login.',
    );
  }
  await connectDatabase();
  await runSeed(password);
  console.log('\nDone. Demo logins (password = SEED_DEMO_PASSWORD; schoolCode BFSS):');
  for (const e of DEMO_LOGINS) console.log(`  ${e}`);
  console.log('Platform owner accounts are not seeded — use `npm run create-platform-owner`.');
}

if (require.main === module) {
  main()
    .then(() => mongoose.disconnect())
    // Password-hashing worker threads would otherwise keep the script running after it finished.
    .then(() => closeHasherPool())
    .catch(async (err) => {
      console.error(`Seed failed: ${err instanceof Error ? err.message : err}`);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
}
