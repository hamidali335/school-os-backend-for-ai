import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { uriHasDatabase } from '../src/database/connection';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
});

describe('Input validation and error contract', () => {
  it('returns a consistent error envelope with a request id', async () => {
    const res = await request(t.app)
      .get('/api/v1/students/not-an-id')
      .set(auth(s.ownerToken))
      .set('X-Request-Id', 'client-req-12345');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: 'client-req-12345' });
    expect(res.body.error.details[0].path).toBe('params.id');
    expect(res.headers['x-request-id']).toBe('client-req-12345');
  });

  it('returns JSON 404 for unknown routes and 400 for malformed JSON', async () => {
    const nf = await request(t.app).get('/api/v1/does-not-exist');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    const bad = await request(t.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('validates types, formats, enums and ranges', async () => {
    const cases: Array<[string, string, unknown]> = [
      [
        'post',
        '/students',
        {
          campusId: s.campusId,
          firstName: '',
          gender: 'unknown',
          sessionId: s.sessionId,
          classId: s.classId,
          sectionId: s.sectionA,
        },
      ],
      ['post', '/academics/sessions', { name: '2027-28', startDate: '2027-04-01', endDate: '2026-03-31' }],
      ['post', '/fees/invoices/generate', { period: '2026-13' }],
      ['post', '/accounts/expenses', { category: 'rent', amount: 10.5, date: '2026-10-01' }],
      ['post', '/attendance/mark', { sectionId: s.sectionA, date: '13-10-2026', records: [] }],
      [
        'post',
        '/timetable',
        { sectionId: s.sectionA, subjectId: s.mathId, dayOfWeek: 8, startTime: '25:00', endTime: '09:00' },
      ],
      ['get', '/students?limit=1000', undefined],
      ['post', '/users', { name: 'A', email: 'a@b.test', role: 'teacher', password: 'weak' }],
    ];
    for (const [method, url, body] of cases) {
      const res = await (request(t.app) as any)[method](`/api/v1${url}`).set(auth(s.ownerToken)).send(body);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe('VALIDATION_ERROR');
    }
  });

  it('strips unknown fields such as privileged flags', async () => {
    const created = await api(t.app, s.ownerToken, 'post', '/academics/subjects', {
      name: 'Science',
      code: 'SCI',
      isAdmin: true,
      _id: '000000000000000000000000',
    });
    expect(created.isAdmin).toBeUndefined();
    expect(created._id).not.toBe('000000000000000000000000');
  });

  it('prevents privilege escalation through user management', async () => {
    const asAdmin = await request(t.app)
      .post('/api/v1/users')
      .set(auth(s.adminToken))
      .send({ name: 'New Owner', email: 'newowner@example.test', role: 'school_owner' });
    expect(asAdmin.status).toBe(403);
    const asPrincipal = await request(t.app)
      .post('/api/v1/users')
      .set(auth(s.principalToken))
      .send({ name: 'Another Principal', email: 'p2@example.test', role: 'principal' });
    expect(asPrincipal.status).toBe(403);
    const me = await api(t.app, s.ownerToken, 'get', '/auth/me');
    const self = await request(t.app)
      .patch(`/api/v1/users/${me.user._id}`)
      .set(auth(s.ownerToken))
      .send({ status: 'disabled' });
    expect(self.status).toBe(400);
  });

  it('requires a duplicate-safe unique key and reports which field collided', async () => {
    const res = await request(t.app)
      .post('/api/v1/academics/subjects')
      .set(auth(s.ownerToken))
      .send({ name: 'Maths again', code: 'MATH' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE');
    expect(res.body.error.details.fields).toEqual(['code']);
  });

  it('refuses to delete records that are still referenced', async () => {
    const res = await request(t.app).delete(`/api/v1/academics/sections/${s.sectionA}`).set(auth(s.ownerToken));
    expect(res.status).toBe(409);
  });

  it('sets secure headers and does not leak framework details', async () => {
    const res = await request(t.app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('answers / and /api/v1 with a service index instead of 404', async () => {
    for (const path of ['/', '/api/v1']) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.data.docs).toBe('/api-docs');
      expect(res.body.data.auth.schoolLogin).toBe('POST /api/v1/auth/login');
    }
    expect((await request(t.app).get('/favicon.ico')).status).toBe(204);
  });

  it('detects whether the MongoDB URI names a database', () => {
    expect(uriHasDatabase('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true')).toBe(false);
    expect(uriHasDatabase('mongodb+srv://u:p@cluster0.abc.mongodb.net')).toBe(false);
    expect(uriHasDatabase('mongodb://127.0.0.1:27017/school_os')).toBe(true);
    expect(uriHasDatabase('mongodb+srv://u:p@c.mongodb.net/school_os?w=majority')).toBe(true);
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(t.app).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(150);
    expect(res.body.components.securitySchemes.schoolBearer).toBeDefined();
  });
});
