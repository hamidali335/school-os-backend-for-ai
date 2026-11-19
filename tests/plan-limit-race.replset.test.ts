import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { School } from '../src/modules/schools/school.model';
import { Student } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * The active-student limit and section capacity under concurrent requests (replica set, the
 * production topology): admissions, re-activations and an import racing for the last places
 * must never end above the limit.
 */
const t = useTestApp();
let s: SchoolFixture;
let n = 0;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: null } });
});

const active = () => Student.countDocuments({ schoolId: s.schoolId, status: 'active' });
async function limitTo(maxStudents: number) {
  const plan = await Plan.create({
    code: `race-${Date.now()}-${n++}`,
    name: 'Race',
    priceMonthlyPkr: 0,
    limits: { maxStudents },
  });
  await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
}
afterEach(() => limitTo(100_000));

const admit = (tag: string, i: number, sectionId = s.sectionA, admissionNo?: string) =>
  request(t.app)
    .post('/api/v1/students')
    .set(auth(s.ownerToken))
    .send({
      campusId: s.campusId,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId,
      firstName: `${tag}${i}`,
      gender: 'female',
      ...(admissionNo ? { admissionNo } : {}),
    });

describe('Active-student limit under concurrency', () => {
  it('twelve admissions at once for the last three places: exactly three succeed', async () => {
    await limitTo((await active()) + 3);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admit('Racea', i)));
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(3);
    for (const r of results.filter((x) => x.status !== 201)) expect(r.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: /^Racea/ })).toBe(3);
  });

  it('with their own admission numbers (no shared numbering counter), the limit still holds', async () => {
    await limitTo((await active()) + 2);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => admit('Raceown', i, s.sectionA, `RACE-OWN-${i}`)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: /^Raceown/ })).toBe(2);
  });

  it('re-activating left students at once cannot pass the limit', async () => {
    const left: string[] = [];
    for (let i = 0; i < 6; i++) {
      const st = (await admit('Raceleft', i)).body.data;
      await api(t.app, s.ownerToken, 'post', `/students/${st._id}/status`, { status: 'left', reason: 'test' });
      left.push(st._id);
    }
    await limitTo((await active()) + 2);
    const results = await Promise.all(
      left.map((id) =>
        request(t.app).post(`/api/v1/students/${id}/status`).set(auth(s.ownerToken)).send({ status: 'active' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: /^Raceleft/, status: 'active' })).toBe(2);
  });

  it('admissions while an import fills the last places: the limit holds exactly', async () => {
    const csv =
      'Admission No,Student Name,Gender,Class,Section\n' +
      Array.from({ length: 20 }, (_, i) => `RACEIMP-${i},Raceimp Kid${i},Male,Class 5,B`).join('\n') +
      '\n';
    const up = await request(t.app)
      .post('/api/v1/imports')
      .set(auth(s.ownerToken))
      .field('type', 'students')
      .attach('file', Buffer.from(csv), 'race.csv');
    const id = up.body.data.job._id;
    await waitStaged(t.app, s.ownerToken, id);
    await checkAndWait(t.app, s.ownerToken, id, {
      mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    });
    const limit = (await active()) + 8;
    await limitTo(limit);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const manual = await Promise.all(Array.from({ length: 10 }, (_, i) => admit('Racemix', i)));
    for (;;) {
      const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await active()).toBe(limit);
    expect(manual.every((r) => r.status === 201 || r.body.error.code === 'PLAN_LIMIT_REACHED')).toBe(true);
  });
});

describe('Section capacity under concurrency', () => {
  it('ten admissions at once into a section with two places: exactly two succeed', async () => {
    const enrolled = await Student.countDocuments({ schoolId: s.schoolId, sectionId: s.sectionB, status: 'active' });
    await Section.updateOne({ schoolId: s.schoolId, _id: s.sectionB }, { $set: { capacity: enrolled + 2 } });
    try {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => admit('Racesec', i, s.sectionB)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      for (const r of results.filter((x) => x.status !== 201)) expect(r.body.error.code).toBe('SECTION_FULL');
      expect(await Student.countDocuments({ schoolId: s.schoolId, sectionId: s.sectionB, status: 'active' })).toBe(
        enrolled + 2,
      );
    } finally {
      await Section.updateOne({ schoolId: s.schoolId, _id: s.sectionB }, { $set: { capacity: null } });
    }
  });
});
