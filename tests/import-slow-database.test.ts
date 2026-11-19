import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { recoverInterruptedImports } from '../src/modules/imports/imports.service';
import { Student } from '../src/modules/students/student.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Uploads must not depend on how fast the database writes.
 *
 * Found with a 5,000-row CSV on a development machine whose database was a shared cloud tier over
 * the internet: saving the file's rows took ~30 s (≈1.5 s per batch of 250 rows, measured from
 * the saved rows' ids), so the 30 s browser timeout ended every upload, and the server finished
 * anyway, leaving imports nobody saw. The rows are now saved after the response.
 *
 * Method: the same per-batch slowness is reproduced by delaying each staging write
 * (ImportRow.insertMany) by 1.5 s. The upload must answer long before the rows are ready, and
 * every step that needs the rows must wait for them instead of using half of them.
 */
const t = useTestApp();
let s: SchoolFixture;
const BATCH_DELAY_MS = 1500;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: 600 } });
});
afterEach(() => vi.restoreAllMocks());

const csv = (prefix: string, n: number) =>
  'Admission No,Student Name *,Gender *,Class *,Section *,Parent Name,Parent Phone\n' +
  Array.from(
    { length: n },
    (_, i) =>
      `${prefix}-${i},${prefix} Kid${i},${i % 2 ? 'Male' : 'Female'},Class 5,${i % 2 ? 'A' : 'B'},${prefix} Parent${i % 40},030${String(10000000 + (i % 40)).padStart(8, '0')}`,
  ).join('\n') +
  '\n';

function slowStaging(failOnBatch?: number) {
  const original = ImportRow.insertMany.bind(ImportRow);
  let batch = 0;
  return vi.spyOn(ImportRow, 'insertMany').mockImplementation((async (...args: Parameters<typeof original>) => {
    batch++;
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    if (failOnBatch && batch === failOnBatch) throw new Error('simulated database error');
    return original(...args);
  }) as never);
}

const upload = (body: string) =>
  request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', 'students')
    .attach('file', Buffer.from(body), 'students.csv');
const rowsOf = (id: string) =>
  ImportRow.countDocuments({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id) });

describe('A slow database never times out the upload', () => {
  it('the upload answers at once; checking waits for the rows instead of using part of them', async () => {
    slowStaging();
    const t0 = performance.now();
    const up = await upload(csv('SLOW', 1000)); // 4 batches → ~6 s of saving
    const answeredMs = performance.now() - t0;
    expect(up.status).toBe(201);
    expect(answeredMs).toBeLessThan(BATCH_DELAY_MS * 2);
    const id = up.body.data.job._id;
    expect(up.body.data.job).toMatchObject({ status: 'staging', totalRows: 1000 });
    // The column step has what it needs straight away.
    expect(up.body.data.columns.map((c: any) => c.field)).toContain('fullName');
    // Everything that needs the rows refuses clearly until they are ready.
    const mapping = up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field }));
    const early = await request(t.app).post(`/api/v1/imports/${id}/check`).set(auth(s.ownerToken)).send({ mapping });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('IMPORT_STAGING');
    expect(early.body.error.message).toMatch(/still being prepared \(\d+ of 1000\)/);
    for (const url of [`/api/v1/imports/${id}/rows`, `/api/v1/imports/${id}/report.csv`])
      expect((await request(t.app).get(url).set(auth(s.ownerToken))).status).toBe(409);
    expect(
      (await request(t.app).post(`/api/v1/imports/${id}/run`).set(auth(s.ownerToken)).send({ confirm: true })).status,
    ).toBe(409);
    // Progress is visible while it works, and the job becomes usable when every row is saved.
    const mid = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
    expect(mid.status).toBe('staging');
    const ready = await waitStaged(t.app, s.ownerToken, id);
    expect(ready).toMatchObject({ status: 'analyzed', progress: { processed: 1000, total: 1000 } });
    expect(await rowsOf(id)).toBe(1000);
    const checked = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    // Every row is assessed (the test school's plan allows 200 active students, so the rest are
    // reported as over the limit: the same rule as the admission form).
    expect(checked.summary.total).toBe(1000);
    expect(checked.summary.create + checked.summary.invalid).toBe(1000);
    expect(checked.summary.create).toBeGreaterThan(0);
  }, 60_000);

  it('if saving the rows fails, the import says so and keeps nothing', async () => {
    slowStaging(2);
    const up = await upload(csv('FAIL', 600));
    expect(up.status).toBe(201);
    const id = up.body.data.job._id;
    const job = await waitStaged(t.app, s.ownerToken, id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Upload the file again/);
    expect(await rowsOf(id)).toBe(0);
    const check = await request(t.app)
      .post(`/api/v1/imports/${id}/check`)
      .set(auth(s.ownerToken))
      .send({ mapping: [] });
    expect(check.status).toBe(409);
    const history = await api(t.app, s.ownerToken, 'get', '/imports?limit=50');
    expect(history.find((j: any) => j._id === id).status).toBe('failed');
  }, 60_000);

  it('stopping while the rows are being prepared cancels the import and removes its rows', async () => {
    slowStaging();
    const up = await upload(csv('STOP', 1000));
    const id = up.body.data.job._id;
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/stop`);
    const job = await waitStaged(t.app, s.ownerToken, id);
    expect(job.status).toBe('cancelled');
    vi.restoreAllMocks();
    // Background deletion is the last step; give it a moment.
    for (let i = 0; i < 50 && (await rowsOf(id)) > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await rowsOf(id)).toBe(0);
  }, 60_000);

  it('a server restart while rows were being prepared marks the import failed and removes its rows', async () => {
    const up = await upload(csv('CRASH', 10));
    const id = up.body.data.job._id;
    await waitStaged(t.app, s.ownerToken, id);
    const jobId = new mongoose.Types.ObjectId(id);
    // As if the process stopped during preparation: status staging, no heartbeat for minutes.
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: jobId },
      { $set: { status: 'staging', heartbeatAt: new Date(Date.now() - 10 * 60_000) } },
    );
    expect(await api(t.app, s.ownerToken, 'get', `/imports/${id}`)).toMatchObject({ status: 'failed' });
    // A live preparation elsewhere (recent heartbeat) is left alone.
    const live = await upload(csv('LIVE', 5));
    await waitStaged(t.app, s.ownerToken, live.body.data.job._id);
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: live.body.data.job._id },
      { $set: { status: 'staging', heartbeatAt: new Date() } },
    );
    await recoverInterruptedImports();
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: jobId }).lean())!.status).toBe('failed');
    expect(await rowsOf(id)).toBe(0);
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: live.body.data.job._id }).lean())!.status).toBe(
      'staging',
    );
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: live.body.data.job._id }, { $set: { status: 'analyzed' } });
  });

  it('the whole workflow: upload, columns, check, import, counts and history', async () => {
    const up = await upload(csv('FLOW', 150));
    const id = up.body.data.job._id;
    await waitStaged(t.app, s.ownerToken, id);
    const mapping = up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field }));
    const checked = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(checked.summary).toMatchObject({ total: 150, create: 150, invalid: 0 });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    let job: any;
    for (let i = 0; i < 1200; i++) {
      job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ status: 'completed', result: { created: 150, failed: 0, skipped: 0 } });
    expect(await Student.countDocuments({ schoolId: s.schoolId, admissionNo: /^FLOW-/ })).toBe(150);
    const history = await api(t.app, s.ownerToken, 'get', '/imports?limit=50');
    expect(history.find((j: any) => j._id === id)).toMatchObject({ status: 'completed', result: { created: 150 } });
  }, 300_000);
});
