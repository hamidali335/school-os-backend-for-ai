import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { ImportJob } from '../src/modules/imports/import.models';
import { Student } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { School } from '../src/modules/schools/school.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Students imported versus "Active students": an import reports every student it saved
 * ("Added"), the dashboard and the student list count only students whose status is Active. A
 * file whose Status column says Left / Struck off / Graduated / Suspended for some rows adds them
 * as not active. All rows are synthetic; everything runs on this file's own test database.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

const N = 5000;
// 296 of the 5,000 rows are not current students in the school's own file.
const NOT_ACTIVE = { 'Struck off': 100, Graduated: 100, Suspended: 96 } as const;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
  const plan = await Plan.create({
    code: `counts-${Date.now()}`,
    name: 'Counts',
    priceMonthlyPkr: 0,
    limits: { maxStudents: 100_000 },
  });
  await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
  // As in a school's own data: sections without a fixed capacity.
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: null } });
}, 120_000);

afterEach(() => vi.restoreAllMocks());

/** Synthetic students: unique admission numbers, made-up names; the first 296 are not current. */
function file(prefix: string, n: number, statuses: Record<string, number>) {
  const lines = ['Admission No,Student Name,Gender,Class,Section,Status'];
  const marks = Object.entries(statuses).flatMap(([status, count]) => Array.from({ length: count }, () => status));
  for (let i = 0; i < n; i++)
    lines.push(
      [
        `${prefix}-${i}`,
        `Synthetic${prefix} Pupil${i}`,
        i % 2 ? 'Male' : 'Female',
        'Class 5',
        i % 2 ? 'A' : 'B',
        marks[i] ?? 'Active',
      ].join(','),
    );
  return `${lines.join('\n')}\n`;
}

async function importCsv(csv: string, token = s.ownerToken) {
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', 'students')
    .attach('file', Buffer.from(csv), 'school-os-students-part1.csv');
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const id = up.body.data.job._id as string;
  await waitStaged(t.app, token, id);
  const { summary } = await checkAndWait(t.app, token, id, {
    mapping: up.body.data.columns.map((c: { column: number; field: string | null }) => ({
      column: c.column,
      field: c.field,
    })),
    options: { campusId: s.campusId, sessionId: s.sessionId },
  });
  return { id, summary };
}
async function run(id: string, token = s.ownerToken) {
  await api(t.app, token, 'post', `/imports/${id}/run`, { confirm: true });
  for (;;) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const dashboardActive = async (token: string) =>
  (await api(t.app, token, 'get', '/dashboard')).students.active as number;
async function listTotal(token: string, status?: string) {
  const res = await request(t.app)
    .get(`/api/v1/students?limit=100${status ? `&status=${status}` : ''}`)
    .set(auth(token));
  expect(res.status).toBe(200);
  return res.body.meta.total as number;
}

describe('5,000 imported students and the Active students count', () => {
  let jobId: string;

  it('every saved student is counted as added; only Active ones on the dashboard (the reported 5,000 vs 4,704)', async () => {
    const { id, summary } = await importCsv(file('P1', N, NOT_ACTIVE));
    jobId = id;
    expect(summary).toMatchObject({ total: N, create: N, invalid: 0 });
    const job = await run(id);
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ created: N, updated: 0, skipped: 0, failed: 0 });
    // Persisted: all 5,000 (plus the fixture's one student).
    expect(await Student.countDocuments({ schoolId: s.schoolId })).toBe(N + 1);
    // Active: 4,704 imported (plus the fixture's student) — the dashboard and the list agree.
    expect(await dashboardActive(s.ownerToken)).toBe(N - 296 + 1);
    expect(await listTotal(s.ownerToken)).toBe(N - 296 + 1);
    // Pagination hides nothing: the other statuses add up to the rest.
    expect(
      (await listTotal(s.ownerToken, 'left')) +
        (await listTotal(s.ownerToken, 'graduated')) +
        (await listTotal(s.ownerToken, 'suspended')),
    ).toBe(296);
  }, 600_000);

  it('the check and the result say how many are added as active and how many as not active', async () => {
    const job = await api(t.app, s.ownerToken, 'get', `/imports/${jobId}`);
    expect(job.summary.statusBreakdown).toEqual({ active: N - 296, left: 100, graduated: 100, suspended: 96 });
    expect(job.result.breakdown).toEqual({ active: N - 296, left: 100, graduated: 100, suspended: 96 });
    // The same after a refresh, and the dashboard still agrees with the active part.
    expect((await api(t.app, s.ownerToken, 'get', `/imports/${jobId}`)).result).toEqual(job.result);
    expect(await dashboardActive(s.ownerToken)).toBe(job.result.breakdown.active + 1);
  });

  it('importing the same file again adds no duplicate', async () => {
    const { id, summary } = await importCsv(file('P1', N, NOT_ACTIVE));
    expect(summary).toMatchObject({ create: 0, exists: N });
    const job = await run(id);
    expect(job.result).toMatchObject({ created: 0, skipped: N, failed: 0 });
    expect(await Student.countDocuments({ schoolId: s.schoolId })).toBe(N + 1);
  }, 600_000);

  it('another school’s counts and lists are untouched', async () => {
    expect(await dashboardActive(other.ownerToken)).toBe(1);
    expect(await listTotal(other.ownerToken)).toBe(1);
    expect(await Student.countDocuments({ schoolId: other.schoolId })).toBe(1);
  });
});

describe('When saving some students fails', () => {
  it('the failed rows are reported as not imported, never as added; added equals what was saved', async () => {
    const before = await Student.countDocuments({ schoolId: s.schoolId });
    const create = Student.create.bind(Student);
    let calls = 0;
    vi.spyOn(Student, 'create').mockImplementation(((...args: Parameters<typeof create>) => {
      calls++;
      if (calls % 5 === 0) return Promise.reject(new Error('simulated database write failure'));
      return create(...args);
    }) as never);
    const { id } = await importCsv(file('F1', 30, {}));
    const job = await run(id);
    vi.restoreAllMocks();
    const saved = (await Student.countDocuments({ schoolId: s.schoolId })) - before;
    expect(job.result.failed).toBe(6);
    expect(job.result.created).toBe(24);
    expect(job.result.created).toBe(saved);
    expect(job.result.created + job.result.failed).toBe(30);
    const failed = await api(t.app, s.ownerToken, 'get', `/imports/${id}/rows?filter=problems&limit=100`);
    expect(failed).toHaveLength(6);
    expect(
      failed.every((r: { result: string; resultMessage: string }) => r.result === 'failed' && r.resultMessage),
    ).toBe(true);

    // Importing the file again adds exactly the 6 missing students, no duplicates.
    const again = await importCsv(file('F1', 30, {}));
    expect(again.summary).toMatchObject({ create: 6, exists: 24 });
    expect((await run(again.id)).result).toMatchObject({ created: 6, failed: 0 });
    expect((await Student.countDocuments({ schoolId: s.schoolId })) - before).toBe(30);
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: id }).lean())!.status).toBe('completed');
  }, 300_000);
});
