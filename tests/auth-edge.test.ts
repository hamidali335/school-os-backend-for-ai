import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_AUDIENCE, SCHOOL_AUDIENCE } from '../src/modules/auth/tokens';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createPlatformAdmin, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let me: { _id: string; schoolId: string; role: string };

const claimsFor = () => ({ sid: me.schoolId, role: me.role, tv: 0, typ: 'school' });

describe('Token and session edge cases', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 1 });
    me = (await api(t.app, s.ownerToken, 'get', '/auth/me')).user;
  });

  it('rejects an expired access token with TOKEN_EXPIRED', async () => {
    const expired = jwt.sign(claimsFor(), process.env.JWT_ACCESS_SECRET!, {
      subject: me._id,
      audience: SCHOOL_AUDIENCE,
      issuer: 'school-os',
      expiresIn: -10,
      algorithm: 'HS256',
    });
    const res = await request(t.app).get('/api/v1/auth/me').set(auth(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects tokens signed with the wrong secret, the wrong audience, or no algorithm', async () => {
    const opts = { subject: me._id, issuer: 'school-os', expiresIn: 300 } as const;
    const wrongSecret = jwt.sign(claimsFor(), 'not-the-real-secret-0123456789abcdef012345', {
      ...opts,
      audience: SCHOOL_AUDIENCE,
    });
    const wrongAudience = jwt.sign(claimsFor(), process.env.JWT_ACCESS_SECRET!, {
      ...opts,
      audience: PLATFORM_AUDIENCE,
    });
    const none = jwt.sign(claimsFor(), '', { ...opts, audience: SCHOOL_AUDIENCE, algorithm: 'none' } as any);
    for (const token of [wrongSecret, wrongAudience, none]) {
      const res = await request(t.app).get('/api/v1/students').set(auth(token));
      expect(res.status).toBe(401);
    }
  });

  it('never accepts a school token on platform routes or a platform token on school routes', async () => {
    const platform = await createPlatformAdmin(t.app);
    expect((await request(t.app).get('/api/v1/platform/schools').set(auth(s.ownerToken))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/students').set(auth(platform.token))).status).toBe(401);
  });

  it('stops refresh tokens of a suspended account', async () => {
    const login = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'none@example.test', password: PASSWORD });
    expect(login.status).toBe(401);
    // Principal signs in, then gets suspended by the Admin.
    const principal = await api(t.app, s.principalToken, 'get', '/auth/me');
    const fresh = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: principal.user.email, password: PASSWORD });
    const refreshToken = fresh.body.data.refreshToken;
    await api(t.app, s.ownerToken, 'patch', `/users/${principal.user._id}`, { status: 'suspended' });
    const res = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('rejects malformed JSON and oversized bodies without crashing', async () => {
    const bad = await request(t.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "x@y.z", "password": ');
    expect(bad.status).toBe(400);
    const huge = await request(t.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x@y.z', password: 'a'.repeat(2 * 1024 * 1024) }));
    expect(huge.status).toBe(413);
    expect((await request(t.app).get('/health')).status).toBe(200);
  });

  it('rejects MongoDB operator injection in login', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: { $ne: null }, password: { $ne: null } });
    expect(res.status).toBe(400);
  });
});
