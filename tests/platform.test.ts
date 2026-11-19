import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createPlatformAdmin, login, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let owner: { token: string };
let admin: { token: string };

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
  owner = await createPlatformAdmin(t.app, 'platform_owner');
  admin = await createPlatformAdmin(t.app, 'platform_admin');
});

const p = (token: string, method: 'get' | 'post' | 'patch' | 'put', url: string, body?: unknown) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

describe('Platform-owner access restrictions', () => {
  it('rejects school users — including school owners — on every platform endpoint', async () => {
    for (const url of [
      '/platform/overview',
      '/platform/schools',
      '/platform/health',
      '/platform/ai-usage?from=2026-01-01&to=2026-12-31',
      '/platform/admins',
    ]) {
      const res = await p(s.ownerToken, 'get', url);
      expect(res.status, url).toBe(401);
    }
  });

  it('rejects platform tokens on school endpoints', async () => {
    expect((await p(owner.token, 'get', '/students')).status).toBe(401);
    expect((await p(owner.token, 'get', '/dashboard')).status).toBe(401);
  });

  it('limits plan and administrator management to the platform owner role', async () => {
    const plan = { code: 'basic', name: 'Basic', priceMonthlyPkr: 15000, limits: { maxStudents: 300 } };
    expect((await p(admin.token, 'post', '/platform/plans', plan)).status).toBe(403);
    expect((await p(admin.token, 'get', '/platform/admins')).status).toBe(403);
    expect((await p(owner.token, 'post', '/platform/plans', plan)).status).toBe(201);
    expect((await p(admin.token, 'get', '/platform/plans')).status).toBe(200);
  });

  it('lists schools with counts but no student or password data', async () => {
    const res = await p(admin.token, 'get', '/platform/schools?limit=100');
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r._id === s.schoolId);
    expect(row.counts.activeStudents).toBe(2);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/passwordHash|Student0|bFormNo|guardians|"phone":"\+92300/);
    const detail = await p(admin.token, 'get', `/platform/schools/${s.schoolId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/Student0|passwordHash/);
  });

  it('exposes health and integration status without secrets', async () => {
    const health = await p(admin.token, 'get', '/platform/health');
    expect(health.body.data.database.pingOk).toBe(true);
    const integ = await p(admin.token, 'get', '/platform/integrations');
    expect(integ.body.data.ai.configured).toBe(false);
    expect(JSON.stringify(integ.body)).not.toMatch(/secret|token|password|apiKey/i);
  });
});

describe('School lifecycle managed by the platform', () => {
  it('onboards a school whose owner can log in with the one-time password', async () => {
    const res = await p(owner.token, 'post', '/platform/schools', {
      name: 'Al-Noor Academy',
      code: 'ALNOOR',
      city: 'Multan',
      planCode: 'basic',
      owner: { name: 'Owner Al-Noor', email: 'owner@alnoor.test' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.temporaryPassword).toBeTruthy();
    const token = await login(t.app, 'owner@alnoor.test', res.body.data.temporaryPassword);
    const me = await api(t.app, token, 'get', '/auth/me');
    expect(me.user.mustChangePassword).toBe(true);
    const sub = await api(t.app, token, 'get', '/subscription');
    expect(sub.plan.code).toBe('basic');
    expect(sub.limits.maxStudents).toBe(300);
  });

  it('suspension blocks school users immediately and activation restores access', async () => {
    const res = await p(admin.token, 'post', `/platform/schools/${s.schoolId}/suspend`, { reason: 'Unpaid invoice' });
    expect(res.status).toBe(200);
    const blocked = await p(s.teacherToken, 'get', '/dashboard');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('SCHOOL_SUSPENDED');
    const login403 = await request(t.app).post('/api/v1/auth/login').send({ email: s.ownerEmail, password: PASSWORD });
    expect(login403.status).toBe(403);
    await p(admin.token, 'post', `/platform/schools/${s.schoolId}/activate`, { reason: 'Payment received' });
    expect((await p(s.teacherToken, 'get', '/dashboard')).status).toBe(200);
    const events = await api(t.app, s.ownerToken, 'get', '/audit-logs?action=platform.school.suspend');
    expect(events).toHaveLength(1);
  });

  it('an expired subscription makes the school read-only', async () => {
    await p(admin.token, 'put', `/platform/schools/${s.schoolId}/subscription`, { status: 'expired' });
    expect((await p(s.ownerToken, 'get', '/students')).status).toBe(200);
    const write = await p(s.ownerToken, 'post', '/academics/subjects', { name: 'Art', code: 'ART' });
    expect(write.status).toBe(402);
    expect(write.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
    await p(admin.token, 'post', `/platform/schools/${s.schoolId}/extend-trial`, { days: 30 });
    expect((await p(s.ownerToken, 'post', '/academics/subjects', { name: 'Art', code: 'ART' })).status).toBe(201);
  });

  it('enforces plan limits on students', async () => {
    const plan = await p(owner.token, 'post', '/platform/plans', {
      code: 'micro',
      name: 'Micro',
      priceMonthlyPkr: 0,
      limits: { maxStudents: 2 },
    });
    expect(plan.status).toBe(201);
    // Changing a school's plan is a platform-owner decision.
    expect(
      (await p(admin.token, 'put', `/platform/schools/${s.schoolId}/subscription`, { planCode: 'micro' })).status,
    ).toBe(403);
    await p(owner.token, 'put', `/platform/schools/${s.schoolId}/subscription`, { planCode: 'micro' });
    const res = await p(s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'Over',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('records platform administrator activity', async () => {
    const res = await p(owner.token, 'get', '/platform/admin-activity');
    expect(res.status).toBe(200);
    expect(res.body.data.some((a: any) => a.actionsLast30Days > 0)).toBe(true);
    const events = await p(owner.token, 'get', '/platform/audit-events');
    expect(events.body.data.some((e: any) => e.action === 'platform.plan.created')).toBe(true);
  });

  it('platform admins cannot change their own role', async () => {
    const me = await p(owner.token, 'get', '/platform/auth/me');
    const res = await p(owner.token, 'patch', `/platform/admins/${me.body.data._id}`, { status: 'disabled' });
    expect(res.status).toBe(403);
  });
});
