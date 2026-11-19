import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Campus } from '../src/modules/campuses/campus.model';
import { Exam } from '../src/modules/examinations/exam.models';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { activateAndLogin, auth, createUser, login, PASSWORD, useTestApp } from './helpers';

/**
 * Linking existing parents and students (both directions), the parent portal login of a parent
 * record, and exporting the Finance, Admissions, Enrolment and Exam analysis reports. All data is
 * synthetic, in this file's own test database.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

const req = (token: string, method: 'get' | 'post' | 'put' | 'delete' | 'patch', url: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
});

let phoneSeq = 0;
const newParent = (token = s.ownerToken, name = `Parent ${++phoneSeq}`) =>
  api(t.app, token, 'post', '/parents', { name, phone: `+92311${String(5550000 + ++phoneSeq).padStart(7, '0')}` });
const newStudent = (f = s, firstName = `Child${++phoneSeq}`) =>
  api(t.app, f.ownerToken, 'post', '/students', {
    campusId: f.campusId,
    firstName,
    gender: 'female',
    sessionId: f.sessionId,
    classId: f.classId,
    sectionId: f.sectionA,
  });
const guardiansOf = async (studentId: string) =>
  (await api(t.app, s.ownerToken, 'get', `/students/${studentId}`)).guardians as Array<{
    parentId: { _id: string };
    relation: string;
    isPrimary: boolean;
  }>;

describe('Linking existing parents and students', () => {
  it('a parent and a student created separately are linked later; the link shows on both and persists', async () => {
    const parent = await newParent();
    const student = await newStudent();
    expect(student.guardians).toEqual([]);
    const linked = await api(t.app, s.ownerToken, 'put', `/students/${student._id}/guardians/${parent._id}`, {
      relation: 'mother',
    });
    expect(linked.guardians).toEqual([expect.objectContaining({ relation: 'mother', isPrimary: true })]);
    // Re-read (as after a page refresh), from both sides.
    expect(await guardiansOf(student._id)).toEqual([
      expect.objectContaining({
        parentId: expect.objectContaining({ _id: parent._id }),
        relation: 'mother',
        isPrimary: true,
      }),
    ]);
    const children = await api(t.app, s.ownerToken, 'get', `/parents/${parent._id}/children`);
    expect(children.map((c: { _id: string }) => c._id)).toEqual([student._id]);
    expect(children[0].guardians).toEqual([expect.objectContaining({ relation: 'mother', isPrimary: true })]);
    // No record was created or duplicated.
    expect(await Parent.countDocuments({ schoolId: s.schoolId, name: parent.name })).toBe(1);
  });

  it('a parent can have several children and a student several guardians; one is primary', async () => {
    const mother = await newParent();
    const father = await newParent();
    const a = await newStudent();
    const b = await newStudent();
    await api(t.app, s.ownerToken, 'put', `/students/${a._id}/guardians/${mother._id}`, { relation: 'mother' });
    await api(t.app, s.ownerToken, 'put', `/students/${b._id}/guardians/${mother._id}`, { relation: 'mother' });
    await api(t.app, s.ownerToken, 'put', `/students/${a._id}/guardians/${father._id}`, {
      relation: 'father',
      isPrimary: true,
    });
    const g = await guardiansOf(a._id);
    expect(g.map((x) => [x.parentId._id, x.relation, x.isPrimary])).toEqual([
      [mother._id, 'mother', false],
      [father._id, 'father', true],
    ]);
    expect((await api(t.app, s.ownerToken, 'get', `/parents/${mother._id}/children`)).length).toBe(2);
    // Linking again only changes the link: no duplicate entry.
    await api(t.app, s.ownerToken, 'put', `/students/${a._id}/guardians/${mother._id}`, { relation: 'guardian' });
    expect((await guardiansOf(a._id)).map((x) => [x.relation, x.isPrimary])).toEqual([
      ['guardian', false],
      ['father', true],
    ]);
  });

  it('unlinking removes only the link: parent, student and login stay; the parent no longer sees the child', async () => {
    const parent = await newParent();
    const student = await newStudent();
    await api(t.app, s.ownerToken, 'put', `/students/${student._id}/guardians/${parent._id}`, {});
    // The parent's portal login, created from the parent record.
    const account = await api(t.app, s.ownerToken, 'post', `/parents/${parent._id}/account`);
    expect(account).toMatchObject({ role: 'parent', created: true });
    const parentToken = await activateAndLogin(t.app, account, PASSWORD, s.code);
    expect((await req(parentToken, 'get', `/students/${student._id}`)).status).toBe(200);

    const after = await api(t.app, s.ownerToken, 'delete', `/students/${student._id}/guardians/${parent._id}`);
    expect(after.guardians).toEqual([]);
    expect((await req(s.ownerToken, 'get', `/parents/${parent._id}`)).status).toBe(200);
    expect((await req(s.ownerToken, 'get', `/students/${student._id}`)).status).toBe(200);
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parent._id })).toBe(1);
    expect((await req(parentToken, 'get', `/students/${student._id}`)).status).not.toBe(200);
    expect(await api(t.app, parentToken, 'get', '/students')).toEqual([]);
    // Unlinking again: there is no such link.
    expect((await req(s.ownerToken, 'delete', `/students/${student._id}/guardians/${parent._id}`)).status).toBe(404);
    // The parent record could now be deleted (it was refused while linked).
    const linkedParent = await newParent();
    await api(t.app, s.ownerToken, 'put', `/students/${student._id}/guardians/${linkedParent._id}`, {});
    expect((await req(s.ownerToken, 'delete', `/parents/${linkedParent._id}`)).status).toBe(409);
  });

  it('the primary guardian moves to the next one when the primary is unlinked; at most 4 guardians', async () => {
    const student = await newStudent();
    const ps = [await newParent(), await newParent(), await newParent(), await newParent(), await newParent()];
    for (const p of ps.slice(0, 4))
      await api(t.app, s.ownerToken, 'put', `/students/${student._id}/guardians/${p._id}`, {});
    const fifth = await req(s.ownerToken, 'put', `/students/${student._id}/guardians/${ps[4]._id}`, {});
    expect(fifth.status).toBe(409);
    expect(fifth.body.error.code).toBe('GUARDIAN_LIMIT');
    expect((await guardiansOf(student._id))[0]).toMatchObject({ isPrimary: true });
    await api(t.app, s.ownerToken, 'delete', `/students/${student._id}/guardians/${ps[0]._id}`);
    const g = await guardiansOf(student._id);
    expect(g.map((x) => x.parentId._id)).toEqual(ps.slice(1, 4).map((p) => p._id));
    expect(g.filter((x) => x.isPrimary).map((x) => x.parentId._id)).toEqual([ps[1]._id]);
  });

  it('two people linking different parents at the same moment both keep their link', async () => {
    const student = await newStudent();
    const [p1, p2, p3] = [await newParent(), await newParent(), await newParent()];
    await Promise.all(
      [p1, p2, p3].map((p) => api(t.app, s.ownerToken, 'put', `/students/${student._id}/guardians/${p._id}`, {})),
    );
    const g = await guardiansOf(student._id);
    expect(new Set(g.map((x) => x.parentId._id))).toEqual(new Set([p1._id, p2._id, p3._id]));
    expect(g.filter((x) => x.isPrimary)).toHaveLength(1);
  });

  it('records of another school, another campus or a role without permission cannot be linked', async () => {
    const parent = await newParent();
    const student = await newStudent();
    const theirParent = await newParent(other.ownerToken);
    const theirStudent = await newStudent(other);
    // Another school's records: not found, nothing changed.
    expect((await req(s.ownerToken, 'put', `/students/${student._id}/guardians/${theirParent._id}`, {})).status).toBe(
      404,
    );
    expect((await req(s.ownerToken, 'put', `/students/${theirStudent._id}/guardians/${parent._id}`, {})).status).toBe(
      404,
    );
    expect((await req(other.ownerToken, 'put', `/students/${student._id}/guardians/${parent._id}`, {})).status).toBe(
      404,
    );
    expect((await Student.findOne({ schoolId: other.schoolId, _id: theirStudent._id }).lean())!.guardians).toEqual([]);
    // A user limited to another campus of this school.
    const campusB = await Campus.create({ schoolId: s.schoolId, name: 'Campus B', code: 'CB' });
    const limited = await createUser(s.schoolId, 'principal', { campusIds: [String(campusB._id)] });
    const limitedToken = await login(t.app, limited.email, undefined, s.code);
    expect((await req(limitedToken, 'put', `/students/${student._id}/guardians/${parent._id}`, {})).status).toBe(404);
    // The accountant can view students and parents but not change links.
    expect((await req(s.accountantToken, 'put', `/students/${student._id}/guardians/${parent._id}`, {})).status).toBe(
      403,
    );
    expect((await req(s.accountantToken, 'delete', `/students/${student._id}/guardians/${parent._id}`)).status).toBe(
      403,
    );
    expect(await guardiansOf(student._id)).toEqual([]);
  });
});

describe('The portal login of a parent record', () => {
  it('is created from the parent record once; asking again returns the same login', async () => {
    const parent = await newParent();
    expect((await api(t.app, s.ownerToken, 'get', `/parents/${parent._id}/account`)).account).toBeNull();
    const first = await api(t.app, s.ownerToken, 'post', `/parents/${parent._id}/account`);
    expect(first).toMatchObject({ role: 'parent', created: true, status: 'pending' });
    expect(first.activation?.token).toBeTruthy();
    const second = await api(t.app, s.ownerToken, 'post', `/parents/${parent._id}/account`);
    expect(second).toMatchObject({ created: false, userId: first.userId });
    expect(second.activation).toBeUndefined();
    expect((await api(t.app, s.ownerToken, 'get', `/parents/${parent._id}/account`)).account).toMatchObject({
      userId: first.userId,
      role: 'parent',
    });
    // Settings → Users cannot add a second login for the same parent record.
    const dup = await req(s.ownerToken, 'post', '/users', {
      name: 'Dup',
      email: `dup${phoneSeq}@example.test`,
      role: 'parent',
      parentId: parent._id,
      password: PASSWORD,
    });
    expect(dup.status).toBe(409);
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parent._id })).toBe(1);
  });

  it('only for this school’s parent records, and only by users who manage accounts', async () => {
    const parent = await newParent();
    const theirs = await newParent(other.ownerToken);
    expect((await req(s.ownerToken, 'post', `/parents/${theirs._id}/account`)).status).toBe(404);
    expect((await req(s.accountantToken, 'post', `/parents/${parent._id}/account`)).status).toBe(403);
    // A parent login cannot be pointed at another school's parent record from Settings → Users either.
    const cross = await req(s.ownerToken, 'post', '/users', {
      name: 'X',
      email: `x${phoneSeq}@example.test`,
      role: 'parent',
      parentId: theirs._id,
      password: PASSWORD,
    });
    expect(cross.status).toBe(400);
    expect(await User.countDocuments({ schoolId: other.schoolId, parentId: theirs._id })).toBe(0);
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: theirs._id })).toBe(0);
  });
});

describe('Exporting reports', () => {
  /** A CSV as Excel reads it: BOM removed, rows split on CRLF. */
  const csvRows = (text: string) =>
    text
      .replace(/^﻿/, '')
      .split('\r\n')
      .map((l) => l.split(','));
  async function download(token: string, url: string) {
    const res = await (request(t.app) as any)
      .get(`/api/v1${url}`)
      .set(auth(token))
      .buffer(true)
      .parse((r: any, cb: any) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return res as { status: number; headers: Record<string, string>; body: Buffer };
  }

  beforeAll(async () => {
    await api(t.app, s.ownerToken, 'post', '/admissions/inquiries', {
      campusId: s.campusId,
      studentName: 'Synthetic Applicant',
      parentName: 'Synthetic Parent',
      phone: '+923119990001',
      source: 'walk_in',
    });
  });

  it('finance: CSV with the months and totals of the period, and a PDF', async () => {
    const json = await api(t.app, s.ownerToken, 'get', '/reports/finance?from=2026-01-01&to=2026-12-31');
    const csv = await download(s.ownerToken, '/reports/finance?from=2026-01-01&to=2026-12-31&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="finance-2026-01-01-to-2026-12-31.csv"');
    const rows = csvRows(csv.body.toString('utf8'));
    expect(rows[0]).toEqual(['Month', 'Fee collections (PKR)', 'Other income (PKR)', 'Expenses (PKR)', 'Net (PKR)']);
    expect(rows.slice(1)).toHaveLength(json.monthly.length);
    const pdf = await download(s.ownerToken, '/reports/finance?from=2026-01-01&to=2026-12-31&format=pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('admissions: CSV by stage and by source, matching the report on screen', async () => {
    const json = await api(t.app, s.ownerToken, 'get', '/reports/admissions?from=2026-01-01&to=2026-12-31');
    expect(json.total).toBe(1);
    const csv = await download(s.ownerToken, '/reports/admissions?from=2026-01-01&to=2026-12-31&format=csv');
    expect(csv.status).toBe(200);
    const rows = csvRows(csv.body.toString('utf8'));
    expect(rows[0]).toEqual(['Group', 'Stage / source', 'Inquiries', 'Admitted', 'Conversion %']);
    expect(rows.filter((r) => r[0] === 'Stage')).toHaveLength(Object.keys(json.stages).length);
    expect(rows.find((r) => r[0] === 'Stage' && r[1] === 'New')).toEqual(['Stage', 'New', '1', '', '']);
    expect(rows.find((r) => r[0] === 'Source')).toEqual(['Source', 'Walk in', '1', '0', '0']);
    expect((await download(s.ownerToken, '/reports/admissions?format=pdf')).headers['content-type']).toBe(
      'application/pdf',
    );
  });

  it('enrolment: CSV per section with the same counts as the report', async () => {
    const json = await api(t.app, s.ownerToken, 'get', '/reports/enrollment');
    const csv = await download(s.ownerToken, '/reports/enrollment?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="enrolment.csv"');
    const rows = csvRows(csv.body.toString('utf8'));
    expect(rows[0]).toEqual(['Class', 'Section', 'Enrolled', 'Male', 'Female', 'Capacity', 'Seats filled %']);
    expect(rows.slice(1).map((r) => [r[0], r[1], Number(r[2])])).toEqual(
      json.sections.map((x: { class: string; section: string; enrolled: number }) => [x.class, x.section, x.enrolled]),
    );
    // Each school's export counts only its own students.
    const theirJson = await api(t.app, other.ownerToken, 'get', '/reports/enrollment');
    const theirs = csvRows((await download(other.ownerToken, '/reports/enrollment?format=csv')).body.toString('utf8'));
    const sum = (r: string[][]) => r.slice(1).reduce((n, x) => n + Number(x[2]), 0);
    expect(sum(theirs)).toBe(theirJson.totals.students);
    expect(sum(rows)).toBe(json.totals.students);
    expect(json.totals.students).toBe(await Student.countDocuments({ schoolId: s.schoolId, status: 'active' }));
  });

  it('exam analysis: CSV per section and subject; an unknown exam is not found', async () => {
    const exam = await Exam.create({
      schoolId: s.schoolId,
      sessionId: s.sessionId,
      name: 'Mid-term 2026',
      classIds: [s.classId],
    });
    const json = await api(t.app, s.ownerToken, 'get', `/reports/exams/${exam._id}/analysis`);
    const csv = await download(s.ownerToken, `/reports/exams/${exam._id}/analysis?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe('attachment; filename="exam-analysis-Mid-term_2026.csv"');
    const rows = csvRows(csv.body.toString('utf8'));
    expect(rows[0]).toEqual(['Section', 'Subject', 'Students', 'Passed', 'Pass rate %', 'Average %']);
    expect(rows.filter((r) => r[1] === 'All subjects')).toHaveLength(json.sections.length);
    expect(
      (await download(s.ownerToken, `/reports/exams/${exam._id}/analysis?format=pdf`)).body.subarray(0, 5).toString(),
    ).toBe('%PDF-');
    expect((await download(s.ownerToken, `/reports/exams/${String(s.sectionA)}/analysis?format=csv`)).status).toBe(404);
    expect((await download(other.ownerToken, `/reports/exams/${exam._id}/analysis?format=csv`)).status).toBe(404);
  });

  it('exports need the export permission; viewing the report does not', async () => {
    const role = await api(t.app, s.ownerToken, 'post', '/roles', {
      name: 'Report viewer',
      permissions: ['reports:read', 'accounts:read', 'admissions:read', 'students:read', 'exams:read'],
    });
    const email = `viewer${phoneSeq}@example.test`;
    await api(t.app, s.ownerToken, 'post', '/users', {
      name: 'Viewer',
      email,
      role: 'staff',
      customRoleId: role._id,
      password: PASSWORD,
    });
    const viewer = await login(t.app, email);
    for (const url of [
      '/reports/finance?from=2026-01-01&to=2026-12-31',
      '/reports/admissions',
      '/reports/enrollment',
    ]) {
      expect((await req(viewer, 'get', url)).status, url).toBe(200);
      expect((await req(viewer, 'get', `${url}${url.includes('?') ? '&' : '?'}format=csv`)).status, url).toBe(403);
    }
    // A teacher (no reports access) gets nothing.
    expect((await req(s.teacherToken, 'get', '/reports/enrollment?format=csv')).status).toBe(403);
  });
});
