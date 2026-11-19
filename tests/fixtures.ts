import type { Express } from 'express';
import request from 'supertest';
import { activateAndLogin, auth, createTestSchool, login, PASSWORD, userToken, type TestSchool } from './helpers';

export interface SchoolFixture extends TestSchool {
  sessionId: string;
  classId: string;
  sectionA: string;
  sectionB: string;
  mathId: string;
  englishId: string;
  teacherEmployeeId: string;
  teacherToken: string;
  otherTeacherToken: string;
  principalToken: string;
  adminToken: string;
  accountantToken: string;
  students: string[];
  /** Accounts provisioned at admission, per student (parent + student logins with activation tokens). */
  admissionAccounts: any[][];
  parentIds: string[];
  parentToken: string;
  tuitionHeadId: string;
}

export async function api<T = any>(
  app: Express,
  token: string,
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  url: string,
  body?: unknown,
  expect = [200, 201, 202, 204],
) {
  const res = await (request(app) as any)
    [method](`/api/v1${url}`)
    .set(auth(token))
    .send(body as object);
  if (!expect.includes(res.status))
    throw new Error(`${method.toUpperCase()} ${url} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data as T;
}

/** A small but complete school built through the public API. */
export async function buildSchool(app: Express, opts: { students?: number } = {}): Promise<SchoolFixture> {
  const school = await createTestSchool(app);
  const t = school.ownerToken;
  const session = await api(app, t, 'post', '/academics/sessions', {
    name: '2026-2027',
    startDate: '2026-04-01',
    endDate: '2027-03-31',
  });
  await api(app, t, 'post', `/academics/sessions/${session._id}/set-current`);
  // Open every day, so tests that mark attendance "today" do not depend on the weekday they run on
  // (school days are tested on their own in release-features.test.ts).
  await api(app, t, 'patch', '/school/settings', { workingDays: [1, 2, 3, 4, 5, 6, 7] });
  const cls = await api(app, t, 'post', '/academics/classes', { campusId: school.campusId, name: 'Class 5', level: 5 });
  const secA = await api(app, t, 'post', '/academics/sections', {
    classId: cls._id,
    sessionId: session._id,
    name: 'A',
    capacity: 30,
  });
  const secB = await api(app, t, 'post', '/academics/sections', {
    classId: cls._id,
    sessionId: session._id,
    name: 'B',
    capacity: 30,
  });
  const math = await api(app, t, 'post', '/academics/subjects', {
    name: 'Mathematics',
    code: 'MATH',
    classIds: [cls._id],
  });
  const eng = await api(app, t, 'post', '/academics/subjects', { name: 'English', code: 'ENG', classIds: [cls._id] });

  const teacherEmp = await api(app, t, 'post', '/employees', {
    campusId: school.campusId,
    firstName: 'Ayesha',
    lastName: 'Khan',
    designation: 'Teacher',
    staffType: 'teaching',
    salary: { basic: 45000, allowances: 5000 },
  });
  const otherEmp = await api(app, t, 'post', '/employees', {
    campusId: school.campusId,
    firstName: 'Bilal',
    designation: 'Teacher',
    staffType: 'teaching',
    salary: { basic: 40000 },
  });
  await api(app, t, 'patch', `/academics/sections/${secA._id}`, { classTeacherId: teacherEmp._id });
  await api(app, t, 'post', '/academics/teaching-assignments', {
    sectionId: secA._id,
    subjectId: math._id,
    teacherId: teacherEmp._id,
  });

  const mkUser = async (role: string, extra: Record<string, string> = {}) => {
    const email = `${role}.${Math.random().toString(36).slice(2, 8)}@example.test`;
    await api(app, t, 'post', '/users', { name: `${role} person`, email, role, password: PASSWORD, ...extra });
    return login(app, email);
  };
  // Teaching staff get their login automatically on registration (pending activation).
  const teacherToken = await activateAndLogin(app, teacherEmp.account, PASSWORD, school.code);
  const otherTeacherToken = await activateAndLogin(app, otherEmp.account, PASSWORD, school.code);
  const principalToken = await mkUser('principal');
  const adminToken = await mkUser('school_admin');
  const accountantToken = await mkUser('accountant');

  const students: string[] = [];
  const parentIds: string[] = [];
  let firstParentAccount: any;
  const admissionAccounts: any[][] = [];
  const n = opts.students ?? 4;
  for (let i = 0; i < n; i++) {
    const st = await api(app, t, 'post', '/students', {
      campusId: school.campusId,
      firstName: `Student${i}`,
      lastName: 'Test',
      gender: i % 2 ? 'female' : 'male',
      sessionId: session._id,
      classId: cls._id,
      sectionId: i < Math.ceil(n / 2) ? secA._id : secB._id,
      guardians: [
        {
          parent: { name: `Parent ${i}`, phone: `+92300000${String(i).padStart(4, '0')}${school.code.length}` },
          isPrimary: true,
        },
      ],
    });
    students.push(st._id);
    parentIds.push(st.guardians[0].parentId);
    admissionAccounts.push(st.accounts);
    if (i === 0) firstParentAccount = st.accounts.find((a: any) => a.role === 'parent');
  }
  // Parent logins are provisioned on admission; the parent activates with their link.
  const parentToken = await activateAndLogin(app, firstParentAccount, PASSWORD, school.code);

  const tuition = await api(app, t, 'post', '/fees/heads', {
    name: 'Tuition Fee',
    code: 'TUITION',
    frequency: 'monthly',
    concessionApplies: true,
  });
  const admission = await api(app, t, 'post', '/fees/heads', {
    name: 'Admission Fee',
    code: 'ADM',
    frequency: 'one_time',
  });
  const annual = await api(app, t, 'post', '/fees/heads', {
    name: 'Annual Charges',
    code: 'ANNUAL',
    frequency: 'annual',
  });
  await api(app, t, 'put', '/fees/structures', {
    sessionId: session._id,
    classId: cls._id,
    name: 'Class 5 fees',
    items: [
      { feeHeadId: tuition._id, amount: 5000 },
      { feeHeadId: admission._id, amount: 10000 },
      { feeHeadId: annual._id, amount: 3000, billingMonths: [4] },
    ],
  });

  return {
    ...school,
    sessionId: session._id,
    classId: cls._id,
    sectionA: secA._id,
    sectionB: secB._id,
    mathId: math._id,
    englishId: eng._id,
    teacherEmployeeId: teacherEmp._id,
    teacherToken,
    otherTeacherToken,
    principalToken,
    adminToken,
    accountantToken,
    students,
    admissionAccounts,
    parentIds,
    parentToken,
    tuitionHeadId: tuition._id,
  };
}

export { userToken };
