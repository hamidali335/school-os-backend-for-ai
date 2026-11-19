import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { retireStudentLogins, RETIRED_REASON } from '../scripts/migrate-retire-student-logins';
import { AuditLog } from '../src/modules/audit/audit.model';
import { hashPassword, signSchoolAccessToken } from '../src/modules/auth/tokens';
import { RefreshToken } from '../src/modules/auth/refresh-token.model';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Student } from '../src/modules/students/student.models';
import { AccountToken, User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, login, PASSWORD, useTestApp } from './helpers';

/**
 * Separate student logins are retired: admission creates parent logins only, the role cannot be
 * granted, and logins created before the change cannot be used or edited. The parent account
 * covers every child, and the migration disables old student logins without deleting data.
 */
const t = useTestApp();
let s: SchoolFixture;
const { ObjectId } = mongoose.Types;

/** A student login as the previous version created it (written directly: the API no longer can). */
async function legacyStudentLogin(schoolId: string, studentId: string, username: string) {
  const user = await User.collection.insertOne({
    schoolId: new ObjectId(schoolId),
    name: 'Legacy Student',
    username,
    passwordHash: await hashPassword(PASSWORD),
    role: 'student',
    status: 'active',
    studentId: new ObjectId(studentId),
    campusIds: [],
    tokenVersion: 0,
    mustChangePassword: false,
    activatedAt: new Date(),
    lastLoginAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await Student.collection.updateOne({ _id: new ObjectId(studentId) }, { $set: { userId: user.insertedId } });
  return user.insertedId;
}

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
});

describe('Admission and account creation', () => {
  it('admitting a student creates the parent login only', async () => {
    const st = await api(t.app, s.adminToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'Noor',
      gender: 'female',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      guardians: [{ parent: { name: 'Noor Parent', phone: '+923004445566' }, isPrimary: true }],
    });
    expect(st.accounts.map((a: any) => a.role)).toEqual(['parent']);
    expect(await User.countDocuments({ schoolId: s.schoolId, role: 'student' })).toBe(0);
  });

  it('the student role cannot be created or granted', async () => {
    const res = await request(t.app).post('/api/v1/users').set(auth(s.ownerToken)).send({
      name: 'Some Student',
      username: 'some.student',
      role: 'student',
      credential: 'activation_link',
    });
    expect(res.status).toBe(400);
    const catalogue = await api(t.app, s.ownerToken, 'get', '/roles/catalogue');
    expect(catalogue.builtInRoles.map((r: any) => r.role)).not.toContain('student');
  });

  it('announcements can no longer target a student audience', async () => {
    const res = await request(t.app)
      .post('/api/v1/communications/announcements')
      .set(auth(s.principalToken))
      .send({ title: 'Hello', body: 'Hello students', audience: { roles: ['student'] } });
    expect(res.status).toBe(400);
  });
});

describe('Student logins created before the change', () => {
  it('cannot sign in; with the right password they are told to use the parent account', async () => {
    await legacyStudentLogin(s.schoolId, s.students[0], `legacy-${Date.now()}`);
    const username = (await User.findOne({ schoolId: s.schoolId, role: 'student' }).lean())!.username!;
    const ok = await request(t.app).post('/api/v1/auth/login').send({ username, password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.error.code).toBe('ACCOUNT_RETIRED');
    expect(ok.body.error.message).toMatch(/parent/i);
    // A wrong password gets the normal answer: no hint that the ID exists.
    const bad = await request(t.app).post('/api/v1/auth/login').send({ username, password: 'Wrong-Password-1' });
    expect(bad.status).toBe(401);
  });

  it('an access token issued before the change stops working', async () => {
    const legacy = await User.findOne({ schoolId: s.schoolId, role: 'student' }).lean();
    const token = signSchoolAccessToken({
      userId: legacy!._id.toString(),
      schoolId: s.schoolId,
      role: 'parent', // the claim is ignored: the role is re-read from the database
      tokenVersion: legacy!.tokenVersion,
    });
    const res = await request(t.app).get('/api/v1/students').set(auth(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_RETIRED');
  });

  it('are hidden from user management and cannot be edited back to life', async () => {
    const legacy = await User.findOne({ schoolId: s.schoolId, role: 'student' }).lean();
    const list = await api(t.app, s.ownerToken, 'get', '/users?limit=100');
    expect(list.map((u: any) => u._id)).not.toContain(legacy!._id.toString());
    const id = legacy!._id.toString();
    expect((await request(t.app).get(`/api/v1/users/${id}`).set(auth(s.ownerToken))).status).toBe(404);
    expect(
      (await request(t.app).patch(`/api/v1/users/${id}`).set(auth(s.ownerToken)).send({ name: 'Revived' })).status,
    ).toBe(404);
    expect((await request(t.app).post(`/api/v1/users/${id}/access-link`).set(auth(s.ownerToken)).send({})).status).toBe(
      404,
    );
  });

  it('an unused activation link for a student login no longer works', async () => {
    const legacy = await User.findOne({ schoolId: s.schoolId, role: 'student' }).lean();
    const crypto = await import('node:crypto');
    const raw = crypto.randomBytes(32).toString('base64url');
    await AccountToken.create({
      schoolId: s.schoolId,
      userId: legacy!._id,
      purpose: 'activation',
      tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const res = await request(t.app).post('/api/v1/auth/account-link/inspect').send({ token: raw });
    expect(res.status).toBe(400);
  });
});

describe('Migration: retire existing student logins', () => {
  it('dry run changes nothing', async () => {
    const before = await User.find({ role: 'student' }).setOptions({ crossTenant: true }).lean();
    const r = await retireStudentLogins(false);
    expect(r.toRetire).toBeGreaterThanOrEqual(1);
    expect(r.retired).toBe(0);
    const after = await User.find({ role: 'student' }).setOptions({ crossTenant: true }).lean();
    expect(after.map((u) => u.status)).toEqual(before.map((u) => u.status));
  });

  it('disables student logins, revokes access, keeps every record, and is safe to re-run', async () => {
    const other = await buildSchool(t.app, { students: 1 });
    const otherLegacy = await legacyStudentLogin(other.schoolId, other.students[0], `legacy-other-${Date.now()}`);
    const legacy = await User.findOne({ schoolId: s.schoolId, role: 'student' }).lean();
    await RefreshToken.create({
      subjectType: 'user',
      subjectId: legacy!._id.toString(),
      schoolId: s.schoolId,
      tokenHash: `test-${Date.now()}`,
      familyId: 'f1',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const parentBefore = await User.findOne({ schoolId: s.schoolId, role: 'parent' }).sort({ _id: 1 }).lean();
    const studentsBefore = await Student.countDocuments({ schoolId: s.schoolId });
    const attendanceBefore = await AttendanceRecord.countDocuments({ schoolId: s.schoolId }).catch(() => 0);

    const r = await retireStudentLogins(true);
    expect(r.retired).toBe(r.toRetire);

    for (const id of [legacy!._id, otherLegacy]) {
      const u = await User.findById(id).setOptions({ crossTenant: true }).lean();
      expect(u).toMatchObject({ role: 'student', status: 'disabled', statusReason: RETIRED_REASON });
      expect(u!.tokenVersion).toBe(1);
      expect(u!.studentId).toBeTruthy(); // the history link is kept
    }
    expect(
      await RefreshToken.countDocuments({ subjectId: legacy!._id.toString(), revokedAt: null }).setOptions({
        crossTenant: true,
      }),
    ).toBe(0);
    expect(
      await AccountToken.countDocuments({ userId: legacy!._id, usedAt: null }).setOptions({ crossTenant: true }),
    ).toBe(0);
    const student = await Student.findById(s.students[0]).setOptions({ crossTenant: true }).lean();
    expect(student).toBeTruthy();
    expect(student!.userId).toBeUndefined();
    expect(await Student.countDocuments({ schoolId: s.schoolId })).toBe(studentsBefore);
    expect(await AttendanceRecord.countDocuments({ schoolId: s.schoolId }).catch(() => 0)).toBe(attendanceBefore);
    const parentAfter = await User.findOne({ _id: parentBefore!._id, schoolId: s.schoolId }).lean();
    expect(parentAfter!.status).toBe(parentBefore!.status);
    expect(
      await AuditLog.countDocuments({ action: 'user.student_login_retired', entityId: legacy!._id.toString() }),
    ).toBe(1);

    const again = await retireStudentLogins(true);
    expect(again.toRetire).toBe(0);
    expect(again.retired).toBe(0);
  });
});

describe('Parents cover their children', () => {
  it('a parent with two children sees both, and nothing from another school', async () => {
    const phone = '+923007778899';
    const mk = (firstName: string) =>
      api(t.app, s.adminToken, 'post', '/students', {
        campusId: s.campusId,
        firstName,
        gender: 'male',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionB,
        guardians: [{ parent: { name: 'Two Kids Parent', phone, email: 'two.kids@example.test' }, isPrimary: true }],
      });
    const a = await mk('Ahmad');
    const b = await mk('Bilal');
    const parentAccount = a.accounts.find((x: any) => x.role === 'parent');
    const { activateAndLogin } = await import('./helpers');
    const token = await activateAndLogin(t.app, parentAccount, PASSWORD, s.code);
    const kids = await api(t.app, token, 'get', '/students');
    expect(kids.map((k: any) => k._id).sort()).toEqual([a._id, b._id].sort());
    const dash = await api(t.app, token, 'get', '/dashboard');
    expect(dash.role).toBe('parent');
    expect(dash.children).toHaveLength(2);
    expect((await request(t.app).get(`/api/v1/students/${s.students[0]}`).set(auth(token))).status).toBe(404);
    const other = await buildSchool(t.app, { students: 1 });
    expect((await request(t.app).get(`/api/v1/students/${other.students[0]}`).set(auth(token))).status).toBe(404);
    // Same parent can still sign in with their email.
    expect(await login(t.app, 'two.kids@example.test', PASSWORD, s.code)).toBeTruthy();
  });
});
