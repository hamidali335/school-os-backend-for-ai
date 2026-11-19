import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Payment } from '../src/modules/fees/fees.models';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, login, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
});

const newStudent = (first: string, phone: string) =>
  api(t.app, s.adminToken, 'post', '/students', {
    campusId: s.campusId,
    firstName: first,
    lastName: 'Test',
    gender: 'male',
    sessionId: s.sessionId,
    classId: s.classId,
    sectionId: s.sectionA,
    guardians: [
      {
        parent: { name: `Father of ${first}`, phone, email: `${first.toLowerCase()}.dad@example.test` },
        isPrimary: true,
      },
    ],
  });

describe('Adding students with logins (regression)', () => {
  it('several parents without an email can each get a login, and no student login is created', async () => {
    for (let i = 0; i < 3; i++)
      await api(t.app, s.adminToken, 'post', '/students', {
        campusId: s.campusId,
        firstName: `NoEmail${i}`,
        gender: 'male',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionA,
        guardians: [{ parent: { name: `No Email Parent ${i}`, phone: `+9230011100${10 + i}` }, isPrimary: true }],
      });
    const logins = await User.countDocuments({ schoolId: s.schoolId, role: 'parent', email: { $exists: false } });
    expect(logins).toBeGreaterThanOrEqual(3);
    expect(await User.countDocuments({ schoolId: s.schoolId, role: 'student' })).toBe(0);
  });

  it('syncing indexes removes a stale email index left from an older version, and adding students works', async () => {
    const users = mongoose.connection.db!.collection('users');
    await users.createIndex({ schoolId: 1, email: 1 }, { name: 'schoolId_1_email_1' });
    const dropped = await User.syncIndexes();
    expect(dropped).toContain('schoolId_1_email_1');
    const ok = await request(t.app).post('/api/v1/students').set(auth(s.adminToken)).send({
      campusId: s.campusId,
      firstName: 'Stale',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
    });
    expect(ok.status).toBe(201);
  });
});

describe('Deleting a student entered by mistake', () => {
  it('removes the student, their own parent record, unused logins and related entries', async () => {
    const st = await newStudent('Mistake', '+923001119001');
    const parentId = st.guardians[0].parentId;
    const check = await api(t.app, s.adminToken, 'get', `/students/${st._id}/deletion-check`);
    expect(check.canDelete).toBe(true);
    expect(check.willRemove.parentRecords).toEqual(['Father of Mistake']);
    expect(check.willRemove.logins.length).toBeGreaterThan(0);

    await api(t.app, s.adminToken, 'delete', `/students/${st._id}`, { reason: 'Entered twice by mistake' });
    expect(await Student.exists({ schoolId: s.schoolId, _id: st._id })).toBeNull();
    expect(await Parent.exists({ schoolId: s.schoolId, _id: parentId })).toBeNull();
    expect(await User.countDocuments({ schoolId: s.schoolId, $or: [{ studentId: st._id }, { parentId }] })).toBe(0);
    const logs = await api(t.app, s.ownerToken, 'get', `/audit-logs?action=student.deleted`);
    expect(logs[0].summary).toContain('Entered twice by mistake');
  });

  it('keeps a parent record that also belongs to a sibling', async () => {
    const a = await newStudent('SibA', '+923001119002');
    const b = await api(t.app, s.adminToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'SibB',
      gender: 'female',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      guardians: [{ parentId: a.guardians[0].parentId, isPrimary: true }],
    });
    const check = await api(t.app, s.adminToken, 'get', `/students/${b._id}/deletion-check`);
    expect(check.willRemove.parentRecords).toEqual([]);
    await api(t.app, s.adminToken, 'delete', `/students/${b._id}`, { reason: 'Wrong child' });
    expect(await Parent.exists({ schoolId: s.schoolId, _id: a.guardians[0].parentId })).toBeTruthy();
  });

  it('is refused once a parent or the student activated their portal account — archive instead', async () => {
    const st = await newStudent('Activated', '+923001119003');
    await User.updateOne(
      { schoolId: s.schoolId, parentId: st.guardians[0].parentId },
      { $set: { activatedAt: new Date() } },
    );
    const check = await api(t.app, s.adminToken, 'get', `/students/${st._id}/deletion-check`);
    expect(check.canDelete).toBe(false);
    expect(check.blockers.map((b: any) => b.kind)).toContain('parent_login_used');
    const res = await request(t.app)
      .delete(`/api/v1/students/${st._id}`)
      .set(auth(s.adminToken))
      .send({ reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IN_USE');
    expect(res.body.error.message).toContain('Archive');
  });

  it('is refused when a fee payment was received', async () => {
    const st = await newStudent('Paid', '+923001119004');
    await Payment.collection.insertOne({
      schoolId: new mongoose.Types.ObjectId(s.schoolId),
      studentId: new mongoose.Types.ObjectId(st._id),
      amount: 100,
    });
    const check = await api(t.app, s.adminToken, 'get', `/students/${st._id}/deletion-check`);
    expect(check.blockers.map((b: any) => b.kind)).toContain('payments');
  });

  it('cannot be done by a teacher or for another school', async () => {
    const st = await newStudent('Guarded', '+923001119005');
    expect(
      (await request(t.app).delete(`/api/v1/students/${st._id}`).set(auth(s.teacherToken)).send({ reason: 'x x x' }))
        .status,
    ).toBe(403);
    const other = await buildSchool(t.app, { students: 1 });
    expect(
      (await request(t.app).delete(`/api/v1/students/${st._id}`).set(auth(other.adminToken)).send({ reason: 'x x x' }))
        .status,
    ).toBe(404);
  });
});

describe('Archiving students', () => {
  it('hides the student, suspends logins and restores everything as it was', async () => {
    const st = await newStudent('Archie', '+923001119006');
    const before = await User.find({
      schoolId: s.schoolId,
      $or: [{ studentId: st._id }, { parentId: st.guardians[0].parentId }],
    }).lean();
    const archived = await api(t.app, s.adminToken, 'post', `/students/${st._id}/archive`, {
      reason: 'Left without notice',
    });
    expect(archived.status).toBe('archived');
    expect(archived.loginsSuspended).toBe(before.length);

    const active = await api(t.app, s.adminToken, 'get', '/students?limit=100');
    expect(active.find((x: any) => x._id === st._id)).toBeUndefined();
    const inArchive = await api(t.app, s.adminToken, 'get', '/students?status=archived');
    expect(inArchive.map((x: any) => x._id)).toContain(st._id);
    const status = await request(t.app)
      .post(`/api/v1/students/${st._id}/status`)
      .set(auth(s.adminToken))
      .send({ status: 'active' });
    expect(status.status).toBe(409);

    const restored = await api(t.app, s.adminToken, 'post', `/students/${st._id}/unarchive`);
    expect(restored.status).toBe('active');
    const after = await User.find({ schoolId: s.schoolId, _id: { $in: before.map((u) => u._id) } }).lean();
    for (const u of after) expect(u.status).toBe(before.find((b) => b._id.equals(u._id))!.status);
  });

  it('keeps a parent signed in while another of their children is current', async () => {
    const a = await newStudent('KeepA', '+923001119007');
    await api(t.app, s.adminToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'KeepB',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      guardians: [{ parentId: a.guardians[0].parentId, isPrimary: true }],
    });
    await api(t.app, s.adminToken, 'post', `/students/${a._id}/archive`, { reason: 'Moved city' });
    const parentLogin = await User.findOne({ schoolId: s.schoolId, parentId: a.guardians[0].parentId }).lean();
    expect(parentLogin!.status).not.toBe('suspended');
  });

  it('archive is not a settable status', async () => {
    const res = await request(t.app)
      .post(`/api/v1/students/${s.students[0]}/status`)
      .set(auth(s.adminToken))
      .send({ status: 'archived' });
    expect(res.status).toBe(400);
  });
});

describe('Archiving teachers', () => {
  it('hides the teacher, blocks their sign-in and restores it', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Archived',
      lastName: 'Teacher',
      designation: 'Teacher',
      staffType: 'non_teaching',
    });
    const email = `arch.teacher.${Date.now()}@example.test`;
    await api(t.app, s.ownerToken, 'post', '/users', {
      name: 'Archived Teacher',
      email,
      role: 'teacher',
      password: PASSWORD,
      employeeId: emp._id,
    });
    await login(t.app, email);

    const archived = await api(t.app, s.ownerToken, 'post', `/employees/${emp._id}/archive`, {
      reason: 'Contract ended',
    });
    expect(archived).toMatchObject({ status: 'archived', loginsSuspended: 1 });
    expect((await request(t.app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(403);
    const list = await api(t.app, s.ownerToken, 'get', '/employees?limit=100');
    expect(list.find((e: any) => e._id === emp._id)).toBeUndefined();
    const archivedList = await api(t.app, s.ownerToken, 'get', '/employees?status=archived');
    expect(archivedList.map((e: any) => e._id)).toContain(emp._id);
    const patch = await request(t.app)
      .patch(`/api/v1/employees/${emp._id}`)
      .set(auth(s.ownerToken))
      .send({ status: 'active' });
    expect(patch.status).toBe(409);

    await api(t.app, s.ownerToken, 'post', `/employees/${emp._id}/unarchive`);
    expect(await login(t.app, email)).toBeTruthy();
  });
});

describe('Changing the sign-in email', () => {
  it('lets the admin fix a mistyped teacher email; the teacher signs in with the new one', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Typo',
      designation: 'Teacher',
      staffType: 'non_teaching',
      email: 'typo.teacher@exmaple.test',
    });
    const created = await api(t.app, s.ownerToken, 'post', '/users', {
      name: 'Typo Teacher',
      email: 'typo.teacher@exmaple.test',
      role: 'teacher',
      password: PASSWORD,
      employeeId: emp._id,
    });
    const updated = await api(t.app, s.ownerToken, 'patch', `/users/${created.user._id}/sign-in`, {
      email: 'typo.teacher@example.test',
    });
    expect(updated.email).toBe('typo.teacher@example.test');
    expect(await login(t.app, 'typo.teacher@example.test')).toBeTruthy();
    expect(
      (await request(t.app).post('/api/v1/auth/login').send({ email: 'typo.teacher@exmaple.test', password: PASSWORD }))
        .status,
    ).toBe(401);
    const empAfter = await api(t.app, s.ownerToken, 'get', `/employees/${emp._id}`);
    expect(empAfter.email).toBe('typo.teacher@example.test');
  });

  it('can fix a parent sign-in email, rejects duplicates and never leaves an account without an identifier', async () => {
    const st = await newStudent('Mailer', '+923001119008');
    const parentLogin = await User.findOne({ schoolId: s.schoolId, parentId: st.guardians[0].parentId }).lean();
    const ok = await api(t.app, s.adminToken, 'patch', `/users/${parentLogin!._id}/sign-in`, {
      email: 'mailer.parent@example.test',
    });
    expect(ok.email).toBe('mailer.parent@example.test');
    const dup = await request(t.app)
      .patch(`/api/v1/users/${parentLogin!._id}/sign-in`)
      .set(auth(s.adminToken))
      .send({ email: s.ownerEmail });
    expect(dup.status).toBe(409);
    const none = await request(t.app)
      .patch(`/api/v1/users/${parentLogin!._id}/sign-in`)
      .set(auth(s.adminToken))
      .send({ email: null, username: null });
    expect(none.status).toBe(400);
    const teacher = await request(t.app)
      .patch(`/api/v1/users/${parentLogin!._id}/sign-in`)
      .set(auth(s.teacherToken))
      .send({ email: 'x@example.test' });
    expect(teacher.status).toBe(403);
  });
});

describe('Student portal accounts', () => {
  it('lists each parent login for the change-email screen (students have no login)', async () => {
    const st = await newStudent('Accounts', '+923001119009');
    const res = await api(t.app, s.adminToken, 'get', `/students/${st._id}/accounts`);
    expect(res.student).toBeUndefined();
    expect(res.parents).toHaveLength(1);
    expect(res.parents[0]).toMatchObject({
      name: 'Father of Accounts',
      account: { role: 'parent', email: 'accounts.dad@example.test' },
    });
    const teacher = await request(t.app).get(`/api/v1/students/${st._id}/accounts`).set(auth(s.teacherToken));
    expect(teacher.status).toBe(403);
  });
});
