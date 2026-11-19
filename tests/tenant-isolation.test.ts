import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { TenantScopeError } from '../src/database/tenant-plugin';
import { Student } from '../src/modules/students/student.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let A: SchoolFixture;
let B: SchoolFixture;
let invoiceB: string;
let paymentB: string;
let approvalB: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe('Tenant isolation: School A cannot read or modify School B', () => {
  beforeAll(async () => {
    A = await buildSchool(t.app, { students: 2 });
    B = await buildSchool(t.app, { students: 2 });
    const gen = await api(t.app, B.ownerToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    invoiceB = gen.invoiceIds[0];
    const pay = await api(t.app, B.ownerToken, 'post', `/fees/invoices/${invoiceB}/payments`, {
      amount: 1000,
      method: 'cash',
    });
    paymentB = pay.payment._id;
    const w = await api(t.app, B.accountantToken, 'post', `/fees/invoices/${invoiceB}/waiver-requests`, {
      amount: 500,
      reason: 'Sibling discount for October',
    });
    approvalB = w._id;
  });

  it('returns 404 for every by-id read of another school’s records', async () => {
    const paths = [
      `/students/${B.students[0]}`,
      `/students/${B.students[0]}/overview`,
      `/fees/invoices/${invoiceB}`,
      `/fees/invoices/${invoiceB}/challan.pdf`,
      `/fees/payments/${paymentB}`,
      `/fees/payments/${paymentB}/receipt.pdf`,
      `/fees/students/${B.students[0]}/ledger`,
      `/academics/sections/${B.sectionA}`,
      `/academics/classes/${B.classId}`,
      `/employees/${B.teacherEmployeeId}`,
      `/parents/${B.parentIds[0]}`,
      `/approvals/${approvalB}`,
      `/attendance/sections/${B.sectionA}?date=2026-10-01`,
    ];
    for (const p of paths) {
      const res = await request(t.app).get(`/api/v1${p}`).set(auth(A.ownerToken));
      expect(res.status, p).toBe(404);
      expect(res.body.error.code, p).toBe('NOT_FOUND');
    }
  });

  it('cannot modify, pay, approve or mark attendance on another school’s records', async () => {
    const attempts: Array<[string, string, unknown]> = [
      ['patch', `/students/${B.students[0]}`, { firstName: 'Hacked' }],
      ['post', `/students/${B.students[0]}/status`, { status: 'left' }],
      ['post', `/fees/invoices/${invoiceB}/payments`, { amount: 100, method: 'cash' }],
      ['post', `/fees/invoices/${invoiceB}/waiver-requests`, { amount: 100, reason: 'cross tenant attempt' }],
      ['post', `/approvals/${approvalB}/decision`, { decision: 'approve' }],
      ['delete', `/academics/sections/${B.sectionB}`, undefined],
      ['patch', `/employees/${B.teacherEmployeeId}`, { designation: 'Hacked' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await (request(t.app) as any)[method](`/api/v1${path}`).set(auth(A.ownerToken)).send(body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const mark = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(A.ownerToken))
      .send({ sectionId: B.sectionA, date: '2026-10-01', records: [{ studentId: B.students[0], status: 'absent' }] });
    expect(mark.status).toBe(404);

    // Nothing changed in School B.
    const st = await api(t.app, B.ownerToken, 'get', `/students/${B.students[0]}`);
    expect(st.firstName).toBe('Student0');
    expect(st.status).toBe('active');
    const approval = await api(t.app, B.ownerToken, 'get', `/approvals/${approvalB}`);
    expect(approval.status).toBe('pending');
  });

  it('rejects links to another school’s records when creating data (INVALID_REFERENCE)', async () => {
    const res = await request(t.app).post('/api/v1/students').set(auth(A.ownerToken)).send({
      campusId: A.campusId,
      firstName: 'X',
      gender: 'male',
      sessionId: A.sessionId,
      classId: A.classId,
      sectionId: B.sectionA,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REFERENCE');

    const assign = await request(t.app)
      .post('/api/v1/academics/teaching-assignments')
      .set(auth(A.ownerToken))
      .send({ sectionId: A.sectionA, subjectId: A.englishId, teacherId: B.teacherEmployeeId });
    expect(assign.status).toBe(400);

    const user = await request(t.app)
      .post('/api/v1/users')
      .set(auth(A.ownerToken))
      .send({ name: 'Sneaky', email: 'sneaky@example.test', role: 'parent', parentId: B.parentIds[0] });
    expect(user.status).toBe(400);
  });

  it('ignores a schoolId supplied in the request body or query', async () => {
    const created = await api(t.app, A.ownerToken, 'post', '/academics/subjects', {
      name: 'Urdu',
      code: 'URDU',
      schoolId: B.schoolId,
    });
    expect(created.schoolId).toBe(A.schoolId);
    const list = await request(t.app).get(`/api/v1/students?schoolId=${B.schoolId}`).set(auth(A.ownerToken));
    expect(list.status).toBe(200);
    expect(list.body.data.every((s: any) => s.schoolId === A.schoolId)).toBe(true);
  });

  it('never returns another school’s rows from list, search, report and export endpoints', async () => {
    const bIds = new Set(B.students);
    const lists = [
      '/students?limit=100',
      '/students?q=Student',
      '/fees/invoices?limit=100',
      '/fees/payments?limit=100',
      '/approvals?limit=100',
      '/audit-logs?limit=100',
      '/parents?limit=100',
    ];
    for (const p of lists) {
      const res = await request(t.app).get(`/api/v1${p}`).set(auth(A.ownerToken));
      expect(res.status, p).toBe(200);
      const json = JSON.stringify(res.body.data);
      expect(json.includes(B.schoolId), p).toBe(false);
      for (const id of bIds) expect(json.includes(id), p).toBe(false);
    }
    const outstanding = await api(t.app, A.ownerToken, 'get', `/fees/outstanding?classId=${B.classId}`);
    expect(outstanding.students).toHaveLength(0);
    const csv = await request(t.app)
      .get(`/api/v1/reports/outstanding?format=csv&classId=${B.classId}`)
      .set(auth(A.ownerToken));
    expect(csv.status).toBe(200);
    expect(csv.text.split('\r\n')).toHaveLength(1);
    const results = await request(t.app)
      .get(`/api/v1/attendance/report?from=2026-01-01&to=2026-12-31&sectionId=${B.sectionA}`)
      .set(auth(A.ownerToken));
    expect(results.status).toBe(200);
    expect(results.body.data.students).toHaveLength(0);
  });

  it('protects private files across schools', async () => {
    const up = await request(t.app)
      .post('/api/v1/files')
      .set(auth(B.ownerToken))
      .field('category', 'student_document')
      .field('studentId', B.students[0])
      .attach('file', PDF, { filename: 'bform.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.data.storageKey).toBeUndefined();
    const own = await request(t.app).get(`/api/v1/files/${up.body.data._id}/download`).set(auth(B.ownerToken));
    expect(own.status).toBe(200);
    const other = await request(t.app).get(`/api/v1/files/${up.body.data._id}/download`).set(auth(A.ownerToken));
    expect(other.status).toBe(404);
    const docs = await request(t.app).get(`/api/v1/students/${B.students[0]}/documents`).set(auth(A.ownerToken));
    expect(docs.status).toBe(404);
  });

  it('the tenant guard blocks any query that forgets the schoolId filter', async () => {
    await expect(Student.find({ firstName: 'Student0' }).lean()).rejects.toBeInstanceOf(TenantScopeError);
    await expect(Student.updateMany({}, { $set: { status: 'left' } })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(Student.aggregate([{ $match: { status: 'active' } }])).rejects.toBeInstanceOf(TenantScopeError);
    await expect(Student.countDocuments({ schoolId: new mongoose.Types.ObjectId(A.schoolId) })).resolves.toBe(2);
  });

  it('parents in one school cannot see another school’s students even with valid ids', async () => {
    const res = await request(t.app).get(`/api/v1/students/${B.students[0]}`).set(auth(A.parentToken));
    expect(res.status).toBe(404);
  });
});
