import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { User } from '../src/modules/users/user.model';
import { assignPlan, PASSWORD, useTestApp } from './helpers';
import { buildSchool, type SchoolFixture } from './fixtures';

/**
 * The mobile app and the website use one sign-in endpoint and contract. For the same account,
 * the only difference the app's `X-Client-App: mobile` header may make is the role policy
 * (parents and teachers only), applied after the password. Requests below are exactly what each
 * client sends (SchoolOSMobile src/auth/AuthProvider.tsx, website src/lib/auth/auth-provider.tsx).
 */
const t = useTestApp();
let f: SchoolFixture;
let parentEmail: string;
let teacherUsername: string;

/** What the mobile app sends. */
const mobileLogin = (loginId: string, password: string, schoolCode?: string) => {
  const id = loginId.trim();
  return request(t.app)
    .post('/api/v1/auth/login')
    .set('X-Client-App', 'mobile')
    .send({
      ...(id.includes('@') ? { email: id } : { username: id.toLowerCase() }),
      password,
      ...(schoolCode ? { schoolCode } : {}),
    });
};
/** What the website sends. */
const webLogin = (email: string, password: string) =>
  request(t.app)
    .post('/api/v1/auth/login')
    .send({ ...(email.includes('@') ? { email } : { username: email.trim().toLowerCase() }), password });

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 2 });
  await assignPlan(f.schoolId, 'mobile-login', ['mobile.parent_app', 'mobile.teacher_app']);
  // The parent account provisioned at admission (linked to Student0), with an email address.
  const parent = await User.findOne({ schoolId: f.schoolId, role: 'parent', parentId: f.parentIds[0] }).lean();
  parentEmail = `parent.zero.${Date.now()}@example.test`;
  await User.updateOne({ _id: parent!._id, schoolId: f.schoolId }, { $set: { email: parentEmail } });
  const teacher = await User.findOne({ schoolId: f.schoolId, employeeId: f.teacherEmployeeId }).lean();
  teacherUsername = teacher!.username!;
});

describe('same account, same result on web and mobile', () => {
  it('a parent signs in by email on both, and the mobile token opens the parent portal', async () => {
    const web = await webLogin(parentEmail, PASSWORD);
    expect(web.status).toBe(200);
    const mobile = await mobileLogin(parentEmail, PASSWORD);
    expect(mobile.status).toBe(200);
    expect(mobile.body.data.user).toMatchObject({ role: 'parent' });
    const token = mobile.body.data.accessToken;
    const me = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Client-App', 'mobile');
    expect(me.status).toBe(200);
    // A parent-portal endpoint: only their own child.
    const kids = await request(t.app)
      .get('/api/v1/students')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Client-App', 'mobile');
    expect(kids.status).toBe(200);
    expect(kids.body.data.map((s: { _id: string }) => s._id)).toEqual([f.students[0]]);
  });

  it('email case and surrounding spaces do not matter on either client', async () => {
    const messy = `  ${parentEmail.toUpperCase()} `;
    expect((await mobileLogin(messy, PASSWORD)).status).toBe(200);
    expect((await webLogin(messy, PASSWORD)).status).toBe(200);
  });

  it('a teacher signs in with their employee number (any case)', async () => {
    const res = await mobileLogin(teacherUsername.toUpperCase(), PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('teacher');
  });

  it('a wrong password or an unknown account: the same INVALID_CREDENTIALS on both clients', async () => {
    for (const r of [
      await mobileLogin(parentEmail, 'Wrong-Password-1'),
      await webLogin(parentEmail, 'Wrong-Password-1'),
    ]) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const unknown = await mobileLogin('nobody.here@example.test', PASSWORD);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    // A password is not changed by either client: trailing spaces are part of it.
    expect((await mobileLogin(parentEmail, `${PASSWORD} `)).body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('a wrong school code is rejected like wrong credentials', async () => {
    const res = await mobileLogin(parentEmail, PASSWORD, 'NOSUCHSCHOOL');
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await mobileLogin(parentEmail, PASSWORD, f.code)).status).toBe(200);
  });

  it('the school administrator: refused on mobile only after a correct password, unchanged on the website', async () => {
    const refused = await mobileLogin(f.ownerEmail, PASSWORD);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('MOBILE_ROLE_NOT_ALLOWED');
    expect(refused.body.data).toBeUndefined();
    const wrong = await mobileLogin(f.ownerEmail, 'Wrong-Password-1');
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await webLogin(f.ownerEmail, PASSWORD)).status).toBe(200);
  });
});

describe('which backend answered', () => {
  it('the API index names the instance and fingerprints the database without exposing it', async () => {
    const res = await request(t.app).get('/api/v1');
    expect(res.body.data.instance.database).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb|password|@/i);
  });
});
