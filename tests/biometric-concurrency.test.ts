import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { PunchEvent } from '../src/modules/biometric/biometric.models';
import { staffPunchesProcessor } from '../src/modules/imports/processors/staff-punches';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Staff punch imports and undoing them, at the same time: one of them waits (one at a time per
 * school), and no punch is ever lost. All data is this file's own test school in the suite's
 * private test database.
 */
const t = useTestApp();
let s: SchoolFixture;
let gate: { _id: string };

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const req = (method: 'get' | 'post', url: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(s.ownerToken)).send(body);
const datesLeft = async () =>
  (await PunchEvent.find({ schoolId: s.schoolId }).select('localDate').lean()).map((p) => p.localDate).sort();

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  const staff = (await api(t.app, s.ownerToken, 'get', '/employees?limit=10')) as Array<{
    _id: string;
    firstName: string;
  }>;
  const ayesha = staff.find((e) => e.firstName === 'Ayesha')!._id;
  gate = await api(t.app, s.ownerToken, 'post', '/biometric/devices', { name: 'Gate', integration: 'file_import' });
  await api(t.app, s.ownerToken, 'post', '/biometric/links', {
    deviceId: gate._id,
    deviceUserId: '17',
    employeeId: ayesha,
  });
});

afterEach(() => vi.restoreAllMocks());

/** Upload and check a punch file (not run yet). */
async function prepare(csv: string) {
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', 'staff_punches')
    .attach('file', Buffer.from(csv), 'punches.csv');
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const { job, columns } = up.body.data as { job: { _id: string }; columns: Array<{ column: number; field: string }> };
  await waitStaged(t.app, s.ownerToken, job._id);
  await checkAndWait(t.app, s.ownerToken, job._id, {
    mapping: columns.map((c) => ({ column: c.column, field: c.field })),
    options: { deviceId: gate._id },
  });
  return job._id;
}
async function job(id: string) {
  return api(t.app, s.ownerToken, 'get', `/imports/${id}`);
}
async function until(id: string, done: (j: any) => boolean) {
  for (;;) {
    const j = await job(id);
    if (done(j)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
}
const ran = (id: string) => until(id, (j) => j.status !== 'running');
const undone = (id: string) => until(id, (j) => j.undo?.status !== 'running');
async function imported(csv: string) {
  const id = await prepare(csv);
  expect((await req('post', `/imports/${id}/run`, { confirm: true })).status).toBe(202);
  await ran(id);
  return id;
}

describe('An import and an undo never overlap (one at a time per school)', () => {
  it('an undo asked for while an overlapping import runs is refused; undone afterwards, the shared punch stays', async () => {
    const a = await imported('AC-No.,Time\n17,2026-08-10 08:00\n17,2026-08-11 08:00\n');
    const b = await prepare('AC-No.,Time\n17,2026-08-11 08:00\n17,2026-08-12 08:00\n');
    // The moment of the audit's probe: B has re-checked its rows (the 11th is "already imported")
    // and is about to save them when A's undo is asked for.
    const original = staffPunchesProcessor.startRun!;
    let during: { status: number; code?: string } | undefined;
    vi.spyOn(staffPunchesProcessor, 'startRun').mockImplementationOnce(async (ctx, plans, o) => {
      const res = await req('post', `/biometric/imports/${a}/undo`, { confirm: true });
      during = { status: res.status, code: res.body.error?.code };
      if (res.status === 202) await undone(a);
      return original.call(staffPunchesProcessor, ctx, plans, o);
    });
    await req('post', `/imports/${b}/run`, { confirm: true });
    await ran(b);
    expect(during).toEqual({ status: 409, code: 'PUNCH_IMPORT_BUSY' });
    expect((await job(a)).undo).toBeNull();

    // Once B has finished, A is undone: the 11th, also in B's file, is kept as B's.
    expect((await req('post', `/biometric/imports/${a}/undo`, { confirm: true })).status).toBe(202);
    expect((await undone(a)).undo).toMatchObject({ status: 'completed', removed: 1, keptForOtherImports: 1 });
    expect(await datesLeft()).toEqual(['2026-08-11', '2026-08-12']);
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(b) })).toBe(2);
  });

  it('an import started while an undo runs is refused until the undo has finished; then nothing is lost', async () => {
    const a = await imported('AC-No.,Time\n17,2026-08-20 08:00\n17,2026-08-21 08:00\n');
    const b = await prepare('AC-No.,Time\n17,2026-08-21 08:00\n17,2026-08-22 08:00\n');
    // Hold the undo just before it removes A's punches.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const deleteMany = PunchEvent.deleteMany.bind(PunchEvent);
    vi.spyOn(PunchEvent, 'deleteMany').mockImplementationOnce(((...args: Parameters<typeof deleteMany>) => ({
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
        held.then(() => deleteMany(...args)).then(ok, fail),
    })) as never);
    expect((await req('post', `/biometric/imports/${a}/undo`, { confirm: true })).status).toBe(202);
    const refused = await req('post', `/imports/${b}/run`, { confirm: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PUNCH_IMPORT_BUSY');
    expect((await job(b)).status).toBe('validated');
    release();
    expect((await undone(a)).undo.status).toBe('completed');
    // B checks its rows again when it starts: the 21st is no longer stored, so it is added.
    expect((await req('post', `/imports/${b}/run`, { confirm: true })).status).toBe(202);
    expect((await ran(b)).result).toMatchObject({ created: 2 });
    expect((await datesLeft()).filter((d) => d >= '2026-08-20')).toEqual(['2026-08-21', '2026-08-22']);
  });

  it('simultaneous undo and import requests: exactly one goes ahead; when all are done no punch is lost', async () => {
    const a = await imported('AC-No.,Time\n17,2026-08-24 08:00\n17,2026-08-25 08:00\n');
    const b = await prepare('AC-No.,Time\n17,2026-08-25 08:00\n17,2026-08-26 08:00\n');
    const answers = await Promise.all([
      req('post', `/biometric/imports/${a}/undo`, { confirm: true }),
      req('post', `/imports/${b}/run`, { confirm: true }),
      req('post', `/biometric/imports/${a}/undo`, { confirm: true }),
      req('post', `/biometric/imports/${a}/undo`, { confirm: true }),
    ]);
    expect(answers.filter((r) => r.status === 202)).toHaveLength(1);
    for (const r of answers.filter((x) => x.status !== 202)) {
      expect(r.status).toBe(409);
      expect(['PUNCH_IMPORT_BUSY', 'UNDO_IN_PROGRESS']).toContain(r.body.error.code);
    }
    await undone(a);
    await ran(b);
    // Finish whichever did not go ahead.
    if ((await job(a)).undo?.status !== 'completed') {
      expect((await req('post', `/biometric/imports/${a}/undo`, { confirm: true })).status).toBe(202);
      await undone(a);
    }
    if ((await job(b)).status === 'validated') {
      expect((await req('post', `/imports/${b}/run`, { confirm: true })).status).toBe(202);
      await ran(b);
    }
    // Whatever the order: A is undone, every punch of B's file is there, once.
    expect((await datesLeft()).filter((d) => d >= '2026-08-24')).toEqual(['2026-08-25', '2026-08-26']);
  });

  it('the remove step keeps a punch that another import took over at that very moment', async () => {
    const a = await imported('AC-No.,Time\n17,2026-08-27 08:00\n17,2026-08-28 08:00\n');
    const c = await imported('AC-No.,Time\n17,2026-08-29 08:00\n'); // another import, not undone
    // Bypassing the lock on purpose: between the undo reading its batch and removing it, the 28th
    // is noted as also in import C.
    const deleteMany = PunchEvent.deleteMany.bind(PunchEvent);
    vi.spyOn(PunchEvent, 'deleteMany').mockImplementationOnce(((...args: Parameters<typeof deleteMany>) => ({
      then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
        PunchEvent.updateMany(
          { schoolId: s.schoolId, importJobId: oid(a), localDate: '2026-08-28' },
          { $addToSet: { alsoImportJobIds: oid(c) } },
        )
          .then(() => deleteMany(...args))
          .then(ok, fail),
    })) as never);
    expect((await req('post', `/biometric/imports/${a}/undo`, { confirm: true })).status).toBe(202);
    expect((await undone(a)).undo).toMatchObject({ status: 'completed', removed: 1, keptForOtherImports: 1 });
    const kept = await PunchEvent.findOne({ schoolId: s.schoolId, localDate: '2026-08-28' }).lean();
    expect(String(kept!.importJobId)).toBe(c);
  });

  it('a lock left by a stopped process expires; a live one is respected', async () => {
    const a = await imported('AC-No.,Time\n17,2026-07-01 08:00\n');
    const locks = mongoose.connection.collection('biometricpunchlocks');
    const _id = `staff_punches:${s.schoolId}` as unknown as mongoose.Types.ObjectId;
    await locks.updateOne(
      { _id },
      { $set: { schoolId: oid(s.schoolId), holder: 'someone-else', kind: 'import', heartbeatAt: new Date() } },
      { upsert: true },
    );
    const busy = await req('post', `/biometric/imports/${a}/undo`, { confirm: true });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('PUNCH_IMPORT_BUSY');
    await locks.updateOne({ _id }, { $set: { heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    expect((await req('post', `/biometric/imports/${a}/undo`, { confirm: true })).status).toBe(202);
    expect((await undone(a)).undo.status).toBe('completed');
    // Released when done.
    expect(await locks.findOne({ _id })).toMatchObject({ holder: null });
    expect(await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'import.undone', entityId: a })).toBe(1);
  });
});
