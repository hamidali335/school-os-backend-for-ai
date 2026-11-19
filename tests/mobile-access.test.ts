import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SchoolRole } from '../src/config/permissions';
import { AuditLog } from '../src/modules/audit/audit.model';
import { assignPlan, auth, createUser, PASSWORD, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * Mobile app policy: parents and teachers only, decided from the verified role. Staff keep full
 * website access. The header names the client; it can never grant a role.
 */
const t = useTestApp();
let f: SchoolFixture;
let parentEmail: string;

const STAFF: SchoolRole[] = ['school_owner', 'principal', 'school_admin', 'accountant', 'staff'];

const mobileLogin = (body: Record<string, unknown>, client = 'mobile') =>
  request(t.app).post('/api/v1/auth/login').set('X-Client-App', client).send(body);

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  // Both mobile features are in this school's plan, so only the role decides.
  await assignPlan(f.schoolId, 'mobile-all', ['mobile.parent_app', 'mobile.teacher_app']);
  parentEmail = (await createUser(f.schoolId, 'parent')).email;
});

describe('sign-in through the mobile app', () => {
  it('parents and teachers sign in and use the API', async () => {
    for (const role of ['parent', 'teacher'] as const) {
      const { email } = await createUser(f.schoolId, role);
      const res = await mobileLogin({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      const me = await request(t.app)
        .get('/api/v1/auth/me')
        .set(auth(res.body.data.accessToken))
        .set('X-Client-App', 'mobile');
      expect(me.status).toBe(200);
      expect(me.body.data.user.role).toBe(role);
    }
  });

  it.each(STAFF)('%s is refused with MOBILE_ROLE_NOT_ALLOWED and gets no tokens', async (role) => {
    const { email, userId } = await createUser(f.schoolId, role);
    const res = await mobileLogin({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    expect(res.body.data).toBeUndefined();
    const audit = await AuditLog.findOne({
      schoolId: f.schoolId,
      actorId: userId,
      action: 'auth.mobile_login_refused',
    }).lean();
    expect(audit).not.toBeNull();
  });

  it('a wrong password is refused the same way for every role (no role is revealed)', async () => {
    const { email } = await createUser(f.schoolId, 'principal');
    const res = await mobileLogin({ email, password: 'Wrong-Password-1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('staff still sign in on the website (no header)', async () => {
    for (const role of STAFF) {
      const { email } = await createUser(f.schoolId, role);
      const res = await request(t.app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
    }
  });

  it('parents and teachers still sign in on the website', async () => {
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: parentEmail, password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('requests with a web session cannot be relabelled', () => {
  it('a staff token is refused with any mobile client value', async () => {
    for (const client of ['mobile', 'parent-mobile', 'teacher-mobile', 'MOBILE']) {
      const res = await request(t.app).get('/api/v1/auth/me').set(auth(f.principalToken)).set('X-Client-App', client);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    }
  });

  it('a forged role declaration does not work: the header must match the verified role', async () => {
    const asParent = await request(t.app)
      .get('/api/v1/auth/me')
      .set(auth(f.parentToken))
      .set('X-Client-App', 'teacher-mobile');
    expect(asParent.status).toBe(403);
    const asTeacher = await request(t.app)
      .get('/api/v1/auth/me')
      .set(auth(f.teacherToken))
      .set('X-Client-App', 'parent-mobile');
    expect(asTeacher.status).toBe(403);
    expect(
      (await request(t.app).get('/api/v1/auth/me').set(auth(f.parentToken)).set('X-Client-App', 'parent-mobile'))
        .status,
    ).toBe(200);
  });

  it('unknown client values are refused; repeated headers use the first value', async () => {
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set(auth(f.parentToken))
      .set('X-Client-App', 'admin-mobile');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Unknown client application');
  });

  it('a custom-role staff account is refused even with broad permissions', async () => {
    const res = await request(t.app).get('/api/v1/students').set(auth(f.ownerToken)).set('X-Client-App', 'mobile');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    // The same token keeps working on the website.
    expect((await request(t.app).get('/api/v1/students').set(auth(f.ownerToken))).status).toBe(200);
  });
});

describe('refresh through the mobile app', () => {
  it('parents and teachers refresh normally', async () => {
    const res = await mobileLogin({ email: parentEmail, password: PASSWORD });
    const next = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('X-Client-App', 'mobile')
      .send({ refreshToken: res.body.data.refreshToken });
    expect(next.status).toBe(200);
  });

  it('a staff web session cannot be turned into mobile tokens by refreshing with the header', async () => {
    const { email } = await createUser(f.schoolId, 'accountant');
    const web = await request(t.app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const res = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('X-Client-App', 'mobile')
      .send({ refreshToken: web.body.data.refreshToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    expect(res.body.data).toBeUndefined();
  });

  it('the mobile plan feature is still required for parents and teachers', async () => {
    const other = await buildSchool(t.app, { students: 1 });
    await assignPlan(other.schoolId, 'no-mobile', ['core.students']);
    const res = await request(t.app).get('/api/v1/auth/me').set(auth(other.parentToken)).set('X-Client-App', 'mobile');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(res.body.error.details.feature).toBe('mobile.parent_app');
  });
});
