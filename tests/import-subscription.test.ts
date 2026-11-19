import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IMPORT_LEASE } from '../src/modules/imports/imports.service';
import { School } from '../src/modules/schools/school.model';
import { Student } from '../src/modules/students/student.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/** A school whose subscription lapses while an import runs can still stop it; nothing new starts. */
const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
});
const HEARTBEAT = IMPORT_LEASE.HEARTBEAT_MS;
afterEach(async () => {
  vi.restoreAllMocks();
  IMPORT_LEASE.HEARTBEAT_MS = HEARTBEAT;
  await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.status': 'active' } });
});

async function checkedImport(tag: string, rows: number) {
  const csv =
    'Admission No,Student Name,Gender,Class,Section\n' +
    Array.from({ length: rows }, (_, i) => `${tag}-${i},${tag} Kid${i},Male,Class 5,${i % 2 ? 'A' : 'B'}`).join('\n') +
    '\n';
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', 'students')
    .attach('file', Buffer.from(csv), 'f.csv');
  const id = up.body.data.job._id as string;
  await waitStaged(t.app, s.ownerToken, id);
  await checkAndWait(t.app, s.ownerToken, id, {
    mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
  });
  return id;
}

describe('Imports when the subscription lapses', () => {
  it('a running import can be stopped; a new run cannot start', async () => {
    IMPORT_LEASE.HEARTBEAT_MS = 100;
    const original = Student.create.bind(Student);
    vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
      await new Promise((r) => setTimeout(r, 200));
      return (original as any)(...args);
    }) as never);
    const running = await checkedImport('Subrun', 80);
    const waiting = await checkedImport('Subwait', 2);
    await api(t.app, s.ownerToken, 'post', `/imports/${running}/run`, { confirm: true });
    await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.status': 'expired' } });

    const stop = await request(t.app).post(`/api/v1/imports/${running}/stop`).set(auth(s.ownerToken));
    expect(stop.status).toBe(200);
    for (;;) {
      const job = await api(t.app, s.ownerToken, 'get', `/imports/${running}`);
      if (job.status !== 'running') {
        expect(job.status).toBe('cancelled');
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const start = await request(t.app)
      .post(`/api/v1/imports/${waiting}/run`)
      .set(auth(s.ownerToken))
      .send({ confirm: true });
    expect(start.status).toBe(402);
    expect(start.body.error.code).toBe('SUBSCRIPTION_INACTIVE');
  });
});
