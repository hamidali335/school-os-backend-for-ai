import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 });
});

describe('Students', () => {
  it('enrols a student with an inline parent and reuses the parent for siblings', async () => {
    const body = {
      campusId: s.campusId,
      firstName: 'Hamza',
      lastName: 'Ali',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      bFormNo: '31202-1234567-1',
      medicalNotes: 'Asthma',
      guardians: [{ parent: { name: 'Ali Raza', phone: '+923001112233' }, isPrimary: true }],
    };
    const a = await api(t.app, s.adminToken, 'post', '/students', body);
    const b = await api(t.app, s.adminToken, 'post', '/students', { ...body, firstName: 'Zara', gender: 'female' });
    expect(a.admissionNo).toMatch(/^ADM-/);
    expect(a.guardians[0].parentId).toBe(b.guardians[0].parentId);
    const kids = await api(t.app, s.adminToken, 'get', `/parents/${a.guardians[0].parentId}/children`);
    expect(kids).toHaveLength(2);
  });

  it('hides sensitive fields from roles without students:manage', async () => {
    const list = await api(t.app, s.adminToken, 'get', '/students?q=Hamza');
    const id = list[0]._id;
    const asAdmin = await api(t.app, s.adminToken, 'get', `/students/${id}`);
    expect(asAdmin.bFormNo).toBe('31202-1234567-1');
    const asTeacher = await api(t.app, s.teacherToken, 'get', `/students/${id}`);
    expect(asTeacher.bFormNo).toBeUndefined();
    expect(asTeacher.medicalNotes).toBeUndefined();
  });

  it('rejects a section that does not belong to the class', async () => {
    const other = await api(t.app, s.ownerToken, 'post', '/academics/classes', {
      campusId: s.campusId,
      name: 'Class 6',
      level: 6,
    });
    const res = await request(t.app).post('/api/v1/students').set(auth(s.adminToken)).send({
      campusId: s.campusId,
      firstName: 'X',
      gender: 'male',
      sessionId: s.sessionId,
      classId: other._id,
      sectionId: s.sectionA,
    });
    expect(res.status).toBe(400);
  });

  it('enforces section capacity', async () => {
    const small = await api(t.app, s.ownerToken, 'post', '/academics/sections', {
      classId: s.classId,
      sessionId: s.sessionId,
      name: 'C',
      capacity: 1,
    });
    const body = {
      campusId: s.campusId,
      firstName: 'Cap',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: small._id,
    };
    await api(t.app, s.adminToken, 'post', '/students', body);
    const res = await request(t.app)
      .post('/api/v1/students')
      .set(auth(s.adminToken))
      .send({ ...body, firstName: 'Cap2' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SECTION_FULL');
  });

  it('restricts parents to their own children and blocks teachers from writes', async () => {
    const mine = await api(t.app, s.parentToken, 'get', '/students');
    expect(mine.map((x: any) => x._id)).toEqual([s.students[0]]);
    const other = await request(t.app).get(`/api/v1/students/${s.students[1]}`).set(auth(s.parentToken));
    expect(other.status).toBe(404);
    const write = await request(t.app)
      .patch(`/api/v1/students/${s.students[0]}`)
      .set(auth(s.teacherToken))
      .send({ firstName: 'Nope' });
    expect(write.status).toBe(403);
  });

  it('changes status and excludes left students from default lists', async () => {
    await api(t.app, s.adminToken, 'post', `/students/${s.students[2]}/status`, {
      status: 'left',
      reason: 'Relocated to Lahore',
    });
    const active = await api(t.app, s.adminToken, 'get', '/students?limit=100');
    expect(active.find((x: any) => x._id === s.students[2])).toBeUndefined();
    const left = await api(t.app, s.adminToken, 'get', '/students?status=left');
    expect(left.map((x: any) => x._id)).toContain(s.students[2]);
  });
});

describe('Admissions CRM', () => {
  let inquiryId: string;

  it('creates an inquiry, rejects duplicates and logs follow-ups', async () => {
    const body = {
      campusId: s.campusId,
      studentName: 'Fatima Noor',
      parentName: 'Noor Ahmed',
      phone: '+923211234567',
      classSoughtId: s.classId,
      source: 'facebook',
    };
    const inq = await api(t.app, s.adminToken, 'post', '/admissions/inquiries', body);
    inquiryId = inq._id;
    expect(inq.stage).toBe('new');
    expect(inq.classSoughtName).toBe('Class 5');
    const dup = await request(t.app).post('/api/v1/admissions/inquiries').set(auth(s.adminToken)).send(body);
    expect(dup.status).toBe(409);

    const fu = await api(t.app, s.adminToken, 'post', `/admissions/inquiries/${inquiryId}/follow-ups`, {
      channel: 'call',
      note: 'Parent will visit on Saturday',
      nextFollowUpAt: '2026-10-17T05:00:00.000Z',
      stage: 'visit_scheduled',
    });
    expect(fu.stage).toBe('visit_scheduled');
    expect(fu.followUps).toHaveLength(1);
  });

  it('converts an inquiry into an enrolled student with a linked parent', async () => {
    const res = await api(t.app, s.adminToken, 'post', `/admissions/inquiries/${inquiryId}/convert`, {
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionB,
      gender: 'female',
    });
    expect(res.student.firstName).toBe('Fatima');
    expect(res.student.lastName).toBe('Noor');
    const inq = await api(t.app, s.adminToken, 'get', `/admissions/inquiries/${inquiryId}`);
    expect(inq.stage).toBe('admitted');
    expect(inq.convertedStudentId).toBe(res.student._id);
    const again = await request(t.app)
      .post(`/api/v1/admissions/inquiries/${inquiryId}/convert`)
      .set(auth(s.adminToken))
      .send({ sessionId: s.sessionId, classId: s.classId, sectionId: s.sectionB, gender: 'female' });
    expect(again.status).toBe(409);
  });

  it('reports the funnel with conversion rate computed from data', async () => {
    const lost = await api(t.app, s.adminToken, 'post', '/admissions/inquiries', {
      campusId: s.campusId,
      studentName: 'Usman Tariq',
      parentName: 'Tariq',
      phone: '+923331234567',
    });
    await api(t.app, s.adminToken, 'post', `/admissions/inquiries/${lost._id}/lost`, {
      reason: 'Chose another school',
    });
    const p = await api(t.app, s.adminToken, 'get', '/admissions/pipeline');
    expect(p.stages.admitted).toBe(1);
    expect(p.stages.lost).toBe(1);
    expect(p.conversionRate).toBe(50);
  });

  it('forbids teachers and parents from the admissions CRM', async () => {
    expect((await request(t.app).get('/api/v1/admissions/inquiries').set(auth(s.teacherToken))).status).toBe(403);
    expect((await request(t.app).get('/api/v1/admissions/inquiries').set(auth(s.parentToken))).status).toBe(403);
  });
});
