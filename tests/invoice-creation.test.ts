import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Invoice } from '../src/modules/fees/fees.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createTestSchool, useTestApp, type TestSchool } from './helpers';

/**
 * Creating invoices: why "Generate invoices" can create nothing (found in a school whose current
 * session had no students while its 1,530 students and both fee structures were in the previous
 * session), and the rules of ad-hoc invoices. All data here is this file's own test school.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let bare: TestSchool;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 });
  other = await buildSchool(t.app, { students: 1 });
  bare = await createTestSchool(t.app);
});
afterEach(() => vi.restoreAllMocks());

const post = (token: string, url: string, body: unknown) =>
  request(t.app)
    .post(`/api/v1${url}`)
    .set(auth(token))
    .send(body as object);
const adhoc = (over: Record<string, unknown> = {}) => ({
  studentId: s.students[0],
  period: '2026-11',
  dueDate: '2026-11-15',
  items: [{ name: 'Exam fee', amount: 1500 }],
  ...over,
});

describe('Generate invoices: every student not invoiced is explained', () => {
  it('without a current session: SETUP_REQUIRED, naming what to set up', async () => {
    const res = await post(bare.ownerToken, '/fees/invoices/generate', { period: '2026-11' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SETUP_REQUIRED');
    expect(res.body.error.details).toEqual({ setup: 'current_session' });
    expect(res.body.error.message).toMatch(/no current academic session/);
  });

  it('students in another session and classes without a fee structure are reported, not silently skipped', async () => {
    // As found: a new session was made current; the students and fee structures stayed in the old one.
    const next = await api(t.app, s.ownerToken, 'post', '/academics/sessions', {
      name: '2027-2028',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
    });
    await api(t.app, s.ownerToken, 'post', `/academics/sessions/${next._id}/set-current`);
    try {
      const empty = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-11' });
      expect(empty).toMatchObject({
        created: 0,
        skippedExisting: 0,
        skippedNoStructure: 0,
        skippedOtherSession: 3,
        session: { _id: next._id, name: '2027-2028' },
        classesWithoutStructure: [],
      });
      // One student admitted into the new session, in a class with no fee structure there.
      const cls = await api(t.app, s.ownerToken, 'post', '/academics/classes', {
        campusId: s.campusId,
        name: 'Class 6',
        level: 6,
      });
      const sec = await api(t.app, s.ownerToken, 'post', '/academics/sections', {
        classId: cls._id,
        sessionId: next._id,
        name: 'A',
      });
      await api(t.app, s.ownerToken, 'post', '/students', {
        campusId: s.campusId,
        sessionId: next._id,
        classId: cls._id,
        sectionId: sec._id,
        firstName: 'Newsession',
        gender: 'male',
      });
      const one = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-11' });
      expect(one).toMatchObject({
        created: 0,
        skippedNoStructure: 1,
        skippedOtherSession: 3,
        classesWithoutStructure: [{ classId: cls._id, name: 'Class 6', students: 1 }],
      });
      expect(await Invoice.countDocuments({ schoolId: s.schoolId, period: '2026-11' })).toBe(0);
    } finally {
      await api(t.app, s.ownerToken, 'post', `/academics/sessions/${s.sessionId}/set-current`);
    }
  });

  it('a month in which the structure bills nothing is reported as nothing due', async () => {
    // Only the annual head (April) and the one-time head remain once the students were billed.
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-05' });
    const res = await api(t.app, s.ownerToken, 'put', '/fees/structures', {
      sessionId: s.sessionId,
      classId: s.classId,
      name: 'Class 5 annual only',
      items: [
        {
          feeHeadId: (await api(t.app, s.ownerToken, 'get', '/fees/heads')).find((h: any) => h.code === 'ANNUAL')._id,
          amount: 3000,
          billingMonths: [4],
        },
      ],
    });
    expect(res._id).toBeTruthy();
    const june = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-06' });
    expect(june).toMatchObject({ created: 0, skippedNothingDue: 3 });
  });
});

describe('Ad-hoc invoices', () => {
  it('a valid invoice is created, numbered and audited', async () => {
    const res = await post(s.accountantToken, '/fees/invoices', adhoc());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'adhoc', total: 1500, balance: 1500, status: 'unpaid' });
    expect(res.body.data.invoiceNo).toMatch(/^INV-202611-\d{6}$/);
    expect(
      await AuditLog.countDocuments({
        schoolId: s.schoolId,
        action: 'invoice.create_adhoc',
        entityId: String(res.body.data._id),
      }),
    ).toBe(1);
  });

  it('works for a student who is not in the current session (no session rule applies)', async () => {
    const next = await api(t.app, s.ownerToken, 'post', '/academics/sessions', {
      name: 'Later',
      startDate: '2028-04-01',
      endDate: '2029-03-31',
    });
    await api(t.app, s.ownerToken, 'post', `/academics/sessions/${next._id}/set-current`);
    try {
      expect((await post(s.accountantToken, '/fees/invoices', adhoc())).status).toBe(201);
    } finally {
      await api(t.app, s.ownerToken, 'post', `/academics/sessions/${s.sessionId}/set-current`);
    }
  });

  it('missing fields are named', async () => {
    const res = await post(s.accountantToken, '/fees/invoices', { period: '2026-11', items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: any) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.studentId', 'body.dueDate', 'body.items']));
  });

  it.each([
    ['a negative amount', { items: [{ name: 'Trip', amount: -5 }] }, 'body.items.0.amount'],
    ['a fractional amount', { items: [{ name: 'Trip', amount: 10.5 }] }, 'body.items.0.amount'],
    ['an impossible due date', { dueDate: '2026-02-31' }, 'body.dueDate'],
    ['a badly written due date', { dueDate: '15/11/2026' }, 'body.dueDate'],
    ['an impossible month', { period: '2026-13' }, 'body.period'],
    ['a charge without a description', { items: [{ name: ' ', amount: 100 }] }, 'body.items.0.name'],
  ])('rejects %s with a field message (never a server error)', async (_label, over, path) => {
    const res = await post(s.accountantToken, '/fees/invoices', adhoc(over));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: any) => d.path)).toContain(path);
  });

  it('refuses a total of Rs 0 instead of creating an invoice that is already "paid"', async () => {
    const before = await Invoice.countDocuments({ schoolId: s.schoolId });
    const res = await post(s.accountantToken, '/fees/invoices', adhoc({ items: [{ name: 'Free trip', amount: 0 }] }));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/above Rs 0/);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId })).toBe(before);
  });

  it('users without fee management cannot create invoices', async () => {
    for (const token of [s.teacherToken, s.parentToken]) {
      const res = await post(token, '/fees/invoices', adhoc());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it("another school's student cannot be invoiced", async () => {
    const res = await post(s.accountantToken, '/fees/invoices', adhoc({ studentId: other.students[0] }));
    expect(res.status).toBe(404);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, studentId: other.students[0] })).toBe(0);
    expect(await Invoice.countDocuments({ schoolId: other.schoolId })).toBe(0);
  });

  it('the same request sent twice (a retry) creates one invoice', async () => {
    const body = adhoc({ idempotencyKey: 'retry-key-123456', items: [{ name: 'Uniform', amount: 2200 }] });
    const first = await post(s.accountantToken, '/fees/invoices', body);
    const again = await post(s.accountantToken, '/fees/invoices', body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data._id).toBe(first.body.data._id);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, idempotencyKey: 'retry-key-123456' })).toBe(1);
    const misuse = await post(s.accountantToken, '/fees/invoices', { ...body, studentId: s.students[1] });
    expect(misuse.status).toBe(409);
    expect(misuse.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('eight identical requests at the same moment create one invoice; all answer with it', async () => {
    const body = adhoc({ idempotencyKey: 'same-moment-key-1', items: [{ name: 'Sports day', amount: 700 }] });
    const results = await Promise.all(Array.from({ length: 8 }, () => post(s.accountantToken, '/fees/invoices', body)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(results.map((r) => r.body.data._id)).size).toBe(1);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, idempotencyKey: 'same-moment-key-1' })).toBe(1);
  });

  it('separate invoices with the same charges and dates are all created (different keys, or none)', async () => {
    const charges = { items: [{ name: 'Lab coat', amount: 950 }] };
    const before = await Invoice.countDocuments({ schoolId: s.schoolId, 'items.name': 'Lab coat' });
    const results = await Promise.all([
      post(s.accountantToken, '/fees/invoices', adhoc({ ...charges, idempotencyKey: 'lab-coat-key-1' })),
      post(s.accountantToken, '/fees/invoices', adhoc({ ...charges, idempotencyKey: 'lab-coat-key-2' })),
      post(s.accountantToken, '/fees/invoices', adhoc(charges)),
      post(s.accountantToken, '/fees/invoices', adhoc(charges)),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.data._id)).size).toBe(4);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, 'items.name': 'Lab coat' })).toBe(before + 4);
  });

  it('the same key in another school is a different request', async () => {
    const mine = await post(s.accountantToken, '/fees/invoices', adhoc({ idempotencyKey: 'cross-school-key' }));
    const theirs = await post(other.accountantToken, '/fees/invoices', {
      studentId: other.students[0],
      period: '2026-11',
      dueDate: '2026-11-15',
      items: [{ name: 'Exam fee', amount: 1500 }],
      idempotencyKey: 'cross-school-key',
    });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.data._id).not.toBe(mine.body.data._id);
    expect(String(theirs.body.data.studentId?._id ?? theirs.body.data.studentId)).toBe(other.students[0]);
  });

  it('a database failure leaves no invoice and answers with a safe message', async () => {
    const before = await Invoice.countDocuments({ schoolId: s.schoolId });
    vi.spyOn(Invoice, 'create').mockRejectedValueOnce(new Error('write failed at shard host-17'));
    const res = await post(s.accountantToken, '/fees/invoices', adhoc());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).not.toMatch(/shard|host/);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId })).toBe(before);
  });
});
