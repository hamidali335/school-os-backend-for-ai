import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, createPlatformAdmin, createTestSchool, PASSWORD, useTestApp, userToken } from './helpers';

const t = useTestApp();

describe('Authentication', () => {
  it('serves liveness and readiness health checks', async () => {
    const live = await request(t.app).get('/health');
    expect(live.status).toBe(200);
    expect(live.body.data.status).toBe('ok');
    expect(live.headers['x-request-id']).toBeTruthy();
    const ready = await request(t.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data.database.state).toBe('connected');
  });

  it('logs in, returns tokens without secrets, and serves /auth/me', async () => {
    const school = await createTestSchool(t.app);
    const res = await request(t.app).post('/api/v1/auth/login').send({ email: school.ownerEmail, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTypeOf('string');
    expect(res.body.data.refreshToken).toBeTypeOf('string');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|failedLoginCount/);
    expect(res.body.data.user.role).toBe('school_owner');

    const me = await request(t.app).get('/api/v1/auth/me').set(auth(res.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(school.ownerEmail);
    expect(me.body.data.permissions).toContain('students:manage');
  });

  it('rejects wrong passwords with a generic error and locks after repeated failures', async () => {
    const school = await createTestSchool(t.app);
    const bad = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: school.ownerEmail, password: 'Wrong-pass-123' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'Wrong-pass-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');

    for (let i = 0; i < 4; i++) {
      await request(t.app).post('/api/v1/auth/login').send({ email: school.ownerEmail, password: 'Wrong-pass-123' });
    }
    const locked = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: school.ownerEmail, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('requires a bearer token and rejects tampered tokens', async () => {
    expect((await request(t.app).get('/api/v1/auth/me')).status).toBe(401);
    const school = await createTestSchool(t.app);
    const tampered = school.ownerToken.slice(0, -2) + (school.ownerToken.endsWith('a') ? 'bb' : 'aa');
    const res = await request(t.app).get('/api/v1/auth/me').set(auth(tampered));
    expect(res.status).toBe(401);
  });

  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const school = await createTestSchool(t.app);
    const login = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: school.ownerEmail, password: PASSWORD });
    const first = login.body.data.refreshToken;

    const r1 = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(r1.status).toBe(200);
    const second = r1.body.data.refreshToken;
    expect(second).not.toBe(first);

    const reuse = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: first });
    expect(reuse.status).toBe(401);
    // The legitimate newer token was revoked too (theft response).
    const after = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: second });
    expect(after.status).toBe(401);
  });

  it('invalidates existing access tokens after a password change', async () => {
    const school = await createTestSchool(t.app);
    const res = await request(t.app)
      .post('/api/v1/auth/change-password')
      .set(auth(school.ownerToken))
      .send({ currentPassword: PASSWORD, newPassword: 'Another-Pass-456' });
    expect(res.status).toBe(200);
    expect((await request(t.app).get('/api/v1/auth/me').set(auth(school.ownerToken))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/auth/me').set(auth(res.body.data.accessToken))).status).toBe(200);
  });

  it('validates input and rejects weak new passwords', async () => {
    const school = await createTestSchool(t.app);
    const bad = await request(t.app).post('/api/v1/auth/login').send({ email: 'not-an-email', password: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const weak = await request(t.app)
      .post('/api/v1/auth/change-password')
      .set(auth(school.ownerToken))
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
  });

  it('keeps school and platform identities separate', async () => {
    const school = await createTestSchool(t.app);
    const platform = await createPlatformAdmin(t.app);
    // School token cannot call platform endpoints and vice versa.
    expect((await request(t.app).get('/api/v1/platform/auth/me').set(auth(school.ownerToken))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/auth/me').set(auth(platform.token))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/platform/auth/me').set(auth(platform.token))).status).toBe(200);
  });

  it('returns 401 for disabled accounts on subsequent requests', async () => {
    const school = await createTestSchool(t.app);
    const teacher = await userToken(t.app, school.schoolId, 'teacher');
    const { User } = await import('../src/modules/users/user.model');
    await User.updateOne({ _id: teacher.userId, schoolId: school.schoolId }, { status: 'disabled' });
    const res = await request(t.app).get('/api/v1/auth/me').set(auth(teacher.token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});
