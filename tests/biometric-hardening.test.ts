import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { PunchEvent, StaffAttendance } from '../src/modules/biometric/biometric.models';
import { punchKey, storePunches } from '../src/modules/biometric/biometric.service';
import {
  _resetBiometricIndexCheck,
  INDEX_RECHECK_MS,
  logBiometricIndexStatus,
  missingBiometricIndexes,
} from '../src/modules/biometric/index-check';
import { recomputeStaffDay } from '../src/modules/biometric/staff-attendance.service';
import { Campus } from '../src/modules/campuses/campus.model';
import { ImportJob } from '../src/modules/imports/import.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createUser, login, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Staff attendance after the production-readiness audit: campus restrictions, undoing an import,
 * how dates are read before confirming, relinking many punches, repairing day summaries, and
 * refusing writes while the unique indexes are missing. All data is this file's own test schools
 * in the suite's private test database.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let ayesha: string; // campus A
let bilal: string; // campus A
let zara: string; // campus B
let gate: { _id: string };
let staffRoom: { _id: string };
let campusB: string;
let limitedA: string; // principal limited to campus A
let limitedB: string; // principal limited to campus B

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const day = (employeeId: string, date: string) =>
  StaffAttendance.findOne({
    schoolId: s.schoolId,
    employeeId: oid(employeeId),
    date: new Date(`${date}T00:00:00Z`),
  }).lean();
const req = (token: string, method: 'get' | 'post' | 'put' | 'delete' | 'patch', url: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
  const staff = (await api(t.app, s.ownerToken, 'get', '/employees?limit=50')) as Array<{
    _id: string;
    firstName: string;
  }>;
  ayesha = staff.find((e) => e.firstName === 'Ayesha')!._id;
  bilal = staff.find((e) => e.firstName === 'Bilal')!._id;
  campusB = String((await Campus.create({ schoolId: s.schoolId, name: 'Campus B', code: 'CB' }))._id);
  zara = (
    await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: campusB,
      firstName: 'Zara',
      designation: 'Teacher',
      staffType: 'non_teaching',
      salary: { basic: 30000 },
    })
  )._id;
  const a = await createUser(s.schoolId, 'principal', { campusIds: [s.campusId] });
  const b = await createUser(s.schoolId, 'principal', { campusIds: [campusB] });
  limitedA = await login(t.app, a.email, undefined, s.code);
  limitedB = await login(t.app, b.email, undefined, s.code);
  gate = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
    name: 'Main gate',
    integration: 'file_import',
  });
  staffRoom = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
    name: 'Staff room',
    integration: 'file_import',
  });
  // Device user IDs are numbered per machine: 17 is Ayesha on the gate and Bilal in the staff room.
  await api(t.app, s.ownerToken, 'post', '/biometric/links', {
    deviceId: gate._id,
    deviceUserId: '17',
    employeeId: ayesha,
  });
  await api(t.app, s.ownerToken, 'post', '/biometric/links', {
    deviceId: staffRoom._id,
    deviceUserId: '17',
    employeeId: bilal,
  });
  await api(t.app, s.ownerToken, 'post', '/biometric/links', {
    deviceId: gate._id,
    deviceUserId: '30',
    employeeId: zara,
  });
});

afterEach(() => vi.restoreAllMocks());

async function importFile(csv: string, options: Record<string, unknown>, token = s.ownerToken) {
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', 'staff_punches')
    .attach('file', Buffer.from(csv), 'punches.csv');
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const { job, columns } = up.body.data as {
    job: { _id: string };
    columns: Array<{ column: number; field: string | null }>;
  };
  await waitStaged(t.app, token, job._id);
  const checked = await checkAndWait(t.app, token, job._id, {
    mapping: columns.map((c) => ({ column: c.column, field: c.field })),
    options: { deviceId: gate._id, ...options },
  });
  return { id: job._id, ...checked };
}
async function run(id: string, token = s.ownerToken) {
  await api(t.app, token, 'post', `/imports/${id}/run`, { confirm: true });
  for (;;) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function waitUndo(id: string, token = s.ownerToken) {
  for (;;) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (job.undo?.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function undo(id: string, token = s.ownerToken) {
  const res = await req(token, 'post', `/biometric/imports/${id}/undo`, { confirm: true });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return waitUndo(id, token);
}

describe('Campus restrictions within a school', () => {
  beforeAll(async () => {
    const id = (await importFile('AC-No.,Time\n17,2026-09-01 08:00\n30,2026-09-01 08:05\n', {})).id;
    await run(id);
    // Ayesha marked absent while she punched: a conflict on campus A.
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-09-01',
      status: 'absent',
    });
  });

  it('a campus-B user cannot mark, clear, resolve or link campus-A staff by supplying their IDs', async () => {
    const conflictDay = await day(ayesha, '2026-09-01');
    expect(conflictDay?.conflict?.code).toBe('marked_off_but_punched');
    const link = (await api(t.app, s.ownerToken, 'get', '/biometric/links')).find(
      (l: { deviceUserId: string; employeeId: { _id: string } }) => l.employeeId._id === ayesha,
    );
    const denied: Array<[string, 'get' | 'post' | 'put' | 'delete', string, object?]> = [
      ['mark', 'put', '/staff-attendance', { employeeId: ayesha, date: '2026-09-01', status: 'present' }],
      ['clear', 'delete', `/staff-attendance/${ayesha}/2026-09-01`],
      ['resolve', 'post', `/staff-attendance/${conflictDay!._id}/resolve`, { action: 'use_punches' }],
      ['link', 'post', '/biometric/links', { deviceId: gate._id, deviceUserId: '55', employeeId: ayesha }],
      ['unlink', 'delete', `/biometric/links/${link._id}`],
      ['repair', 'post', '/staff-attendance/repair', { from: '2026-09-01', to: '2026-09-01', employeeId: ayesha }],
    ];
    for (const [name, method, url, body] of denied) {
      const res = await req(limitedB, method, url, body);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(404);
    }
    // Widening the day view to another campus is refused, not silently applied.
    expect((await req(limitedB, 'get', `/staff-attendance?date=2026-09-01&campusId=${s.campusId}`)).status).toBe(403);
    // Nothing changed.
    expect(await day(ayesha, '2026-09-01')).toMatchObject({
      status: 'absent',
      source: 'manual',
      conflict: { code: 'marked_off_but_punched' },
    });
    expect(await mongoose.connection.collection('deviceuserlinks').countDocuments({ deviceUserId: '55' })).toBe(0);
  });

  it('lists show a campus-limited user only their campuses’ staff, links, punches and conflicts', async () => {
    const ids = (rows: Array<{ employeeId?: { _id: string } | null }>) => rows.map((r) => r.employeeId?._id);
    const linksB = await api(t.app, limitedB, 'get', '/biometric/links');
    expect(ids(linksB)).toEqual([zara]);
    const punchesB = await api(t.app, limitedB, 'get', '/biometric/punches?date=2026-09-01');
    expect(ids(punchesB)).toEqual([zara]);
    expect(await api(t.app, limitedB, 'get', '/staff-attendance/conflicts')).toEqual([]);
    const dayB = await api(t.app, limitedB, 'get', '/staff-attendance?date=2026-09-01');
    expect(dayB.rows.map((r: { employee: { _id: string } }) => r.employee._id)).toEqual([zara]);
    // Asking for a campus-A staff member's punches returns nothing.
    expect(await api(t.app, limitedB, 'get', `/biometric/punches?employeeId=${ayesha}`)).toEqual([]);

    const conflictsA = await api(t.app, limitedA, 'get', '/staff-attendance/conflicts');
    expect(conflictsA.map((c: { employeeId: { _id: string } }) => c.employeeId._id)).toEqual([ayesha]);
    // A user with every campus sees both.
    const all = await api(t.app, s.ownerToken, 'get', '/biometric/links');
    expect(new Set(ids(all))).toEqual(new Set([ayesha, bilal, zara]));
  });

  it('a campus-limited user can work with their own campus’ staff', async () => {
    expect(
      (await req(limitedB, 'put', '/staff-attendance', { employeeId: zara, date: '2026-09-01', status: 'half_day' }))
        .status,
    ).toBe(200);
    expect(await day(zara, '2026-09-01')).toMatchObject({ status: 'half_day', source: 'manual' });
    expect((await req(limitedB, 'delete', `/staff-attendance/${zara}/2026-09-01`)).status).toBe(200);
    const made = await req(limitedB, 'post', '/biometric/links', {
      deviceId: gate._id,
      deviceUserId: '31',
      employeeId: zara,
    });
    expect(made.status).toBe(201);
    expect((await req(limitedB, 'delete', `/biometric/links/${made.body.data.link._id}`)).status).toBe(200);
    // Campus A's user resolves campus A's conflict.
    const conflictDay = await day(ayesha, '2026-09-01');
    expect(
      (await req(limitedA, 'post', `/staff-attendance/${conflictDay!._id}/resolve`, { action: 'keep_mark' })).status,
    ).toBe(200);
  });

  it('a link cannot move punches away from (or to) staff of another campus', async () => {
    // 40 is Ayesha's on every device; a campus-B device link for 40 would take her gate punches.
    await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: null,
      deviceUserId: '40',
      employeeId: ayesha,
    });
    await run((await importFile('AC-No.,Time\n40,2026-09-02 08:00\n', {})).id);
    const res = await req(limitedB, 'post', '/biometric/links', {
      deviceId: gate._id,
      deviceUserId: '40',
      employeeId: zara,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CAMPUS_FORBIDDEN');
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, deviceUserId: '40', employeeId: oid(ayesha) })).toBe(
      1,
    );
    expect(await mongoose.connection.collection('deviceuserlinks').countDocuments({ deviceUserId: '40' })).toBe(1);
  });

  it('a campus-limited user’s import refuses rows of other campuses’ staff', async () => {
    const res = await importFile('AC-No.,Time\n17,2026-09-03 08:00\n30,2026-09-03 08:00\n', {}, limitedB);
    expect(res.summary).toMatchObject({ create: 1, invalid: 1 });
    const done = await run(res.id, limitedB);
    expect(done.result).toMatchObject({ created: 1, failed: 1 });
    expect(
      await PunchEvent.countDocuments({ schoolId: s.schoolId, localDate: '2026-09-03', employeeId: oid(ayesha) }),
    ).toBe(0);
    expect(await day(zara, '2026-09-03')).toMatchObject({ status: 'present' });
  });

  it('another school reaches nothing of this school', async () => {
    const conflictDay = await day(ayesha, '2026-09-01');
    const job = await ImportJob.findOne({ schoolId: s.schoolId }).lean();
    for (const [method, url, body] of [
      ['put', '/staff-attendance', { employeeId: ayesha, date: '2026-09-01', status: 'present' }],
      ['post', `/staff-attendance/${conflictDay!._id}/resolve`, { action: 'keep_mark' }],
      ['post', '/staff-attendance/repair', { from: '2026-09-01', to: '2026-09-01', employeeId: ayesha }],
      ['get', `/biometric/imports/${job!._id}/undo`],
      ['post', `/biometric/imports/${job!._id}/undo`, { confirm: true }],
    ] as const) {
      const res = await req(other.ownerToken, method, url, body as object | undefined);
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: job!._id }).lean())!.undo).toBeUndefined();
  });

  it('the accountant views but cannot resolve, link, unlink, manage keys, undo or repair', async () => {
    const conflictDay = await day(ayesha, '2026-09-01');
    const link = (await api(t.app, s.ownerToken, 'get', '/biometric/links'))[0];
    const job = await ImportJob.findOne({ schoolId: s.schoolId }).lean();
    expect((await req(s.accountantToken, 'get', '/staff-attendance/conflicts')).status).toBe(200);
    for (const [method, url, body] of [
      ['post', `/staff-attendance/${conflictDay!._id}/resolve`, { action: 'keep_mark' }],
      ['post', '/biometric/links', { deviceUserId: '77', employeeId: ayesha }],
      ['delete', `/biometric/links/${link._id}`],
      ['post', `/biometric/devices/${gate._id}/connector-key`],
      ['delete', `/biometric/devices/${gate._id}/connector-key`],
      ['get', `/biometric/imports/${job!._id}/undo`],
      ['post', `/biometric/imports/${job!._id}/undo`, { confirm: true }],
      ['post', '/staff-attendance/repair', { from: '2026-09-01', to: '2026-09-01' }],
    ] as const) {
      const res = await req(s.accountantToken, method, url, body as object | undefined);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });
});

describe('How dates are read, before confirming', () => {
  it('shows examples of the reading the import will use, and the import saves exactly that', async () => {
    // 02/03/2026 is 2 March (day first) or 3 February (month first): the school chose month first.
    const csv = 'AC-No.,Time\n17,02/03/2026 08:00\n17,02/03/2026 17:30\n17,25/03/2026 08:00\n';
    const res = await importFile(csv, { dateOrder: 'mdy' });
    const preview = res.summary.datePreview;
    expect(preview).toMatchObject({
      timeZone: 'Asia/Karachi',
      order: 'mdy',
      orderSource: 'chosen',
      ambiguousRows: 2,
      overriddenRows: 1,
    });
    expect(preview.examples).toEqual([
      expect.objectContaining({
        rowNo: 2,
        original: '02/03/2026 08:00',
        interpreted: '2026-02-03 08:00:00',
        readAs: 'mdy',
        ambiguous: true,
      }),
      expect.objectContaining({ rowNo: 3, interpreted: '2026-02-03 17:30:00', ambiguous: true }),
      // 25 cannot be a month: read day first whatever the option, and said on the row.
      expect.objectContaining({ rowNo: 4, interpreted: '2026-03-25 08:00:00', readAs: 'dmy', overridden: true }),
    ]);
    const warned = await api(t.app, s.ownerToken, 'get', `/imports/${res.id}/rows?filter=warnings`);
    expect(warned.map((r: { rowNo: number }) => r.rowNo)).toEqual([4]);
    expect(warned[0].issues.map((i: { message: string }) => i.message).join(' ')).toMatch(/read as day\/month\/year/);
    await run(res.id);
    const stored = await PunchEvent.find({ schoolId: s.schoolId, importJobId: oid(res.id) })
      .sort({ rowNo: 1 })
      .lean();
    expect(stored.map((p) => p.punchedAt.toISOString())).toEqual(preview.examples.map((e: { at: string }) => e.at));
    expect(stored.map((p) => p.localDate)).toEqual(['2026-02-03', '2026-02-03', '2026-03-25']);
    // The order used is recorded with the import's outcome.
    const log = await AuditLog.findOne({ schoolId: s.schoolId, action: 'import.completed', entityId: res.id }).lean();
    expect(log!.metadata).toMatchObject({ dateOrder: 'mdy', dateOrderSource: 'chosen', deviceId: gate._id });
  });
});

describe('Undoing an import', () => {
  it('a file imported under the wrong device is undone; imported again under the right one it counts for the right person', async () => {
    const csv = 'AC-No.,Time,State\n17,2026-08-03 08:00,C/In\n17,2026-08-03 14:00,C/Out\n';
    const wrong = await importFile(csv, { deviceId: staffRoom._id });
    await run(wrong.id);
    expect(await day(bilal, '2026-08-03')).toMatchObject({ status: 'present', punches: { count: 2 } });

    const preview = await api(t.app, s.ownerToken, 'get', `/biometric/imports/${wrong.id}/undo`);
    expect(preview).toMatchObject({
      canUndo: true,
      import: { deviceName: 'Staff room' },
      punches: { total: 2, removed: 2, keptForOtherImports: 0, keptForConnector: 0 },
      staff: { count: 1, names: [expect.stringMatching(/^Bilal/)] },
      days: { affected: 1, becomeNotRecorded: 1, markedKept: 0 },
    });
    const job = await undo(wrong.id);
    expect(job.undo).toMatchObject({ status: 'completed', removed: 2, daysRecalculated: 1, error: null });
    expect(await day(bilal, '2026-08-03')).toBeNull();
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(wrong.id) })).toBe(0);

    const right = await importFile(csv, { deviceId: gate._id });
    expect(right.summary).toMatchObject({ create: 2 });
    await run(right.id);
    expect(await day(ayesha, '2026-08-03')).toMatchObject({ status: 'present', punches: { count: 2, in: 1, out: 1 } });
    expect(await day(bilal, '2026-08-03')).toBeNull();
  });

  it('a file read with the wrong day/month order is undone and imported again with the right one', async () => {
    const csv = 'AC-No.,Time\n17,04/08/2026 08:00\n17,04/08/2026 13:00\n';
    const wrong = await importFile(csv, { dateOrder: 'mdy' }); // 8 April instead of 4 August
    expect(wrong.summary.datePreview.examples[0].interpreted).toBe('2026-04-08 08:00:00');
    await run(wrong.id);
    expect(await day(ayesha, '2026-04-08')).toMatchObject({ punches: { count: 2 } });
    await undo(wrong.id);
    expect(await day(ayesha, '2026-04-08')).toBeNull();
    const right = await importFile(csv, { dateOrder: 'dmy' });
    expect(right.summary).toMatchObject({ create: 2, exists: 0 });
    await run(right.id);
    expect(await day(ayesha, '2026-08-04')).toMatchObject({ punches: { count: 2 } });
  });

  it('overlapping imports: a punch another import (or the connector) also delivered is kept', async () => {
    const first = await importFile('AC-No.,Time\n17,2026-08-10 08:00\n17,2026-08-11 08:00\n17,2026-08-12 08:00\n', {});
    await run(first.id);
    // The next week's export repeats the 11th and 12th.
    const second = await importFile('AC-No.,Time\n17,2026-08-11 08:00\n17,2026-08-12 08:00\n17,2026-08-13 08:00\n', {});
    expect(second.summary).toMatchObject({ create: 1, exists: 2 });
    await run(second.id);
    // A punch of the first import that the connector also sent.
    const conn = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'Overlap connector',
      integration: 'connector_api',
    });
    const key = (await api(t.app, s.ownerToken, 'post', `/biometric/devices/${conn._id}/connector-key`)).key;
    const firstPunch = await PunchEvent.findOne({
      schoolId: s.schoolId,
      importJobId: oid(first.id),
      localDate: '2026-08-10',
    }).lean();
    await PunchEvent.updateOne({ schoolId: s.schoolId, _id: firstPunch!._id }, { $set: { alsoFromConnector: true } }); // as storePunches notes it

    const preview = await api(t.app, s.ownerToken, 'get', `/biometric/imports/${first.id}/undo`);
    expect(preview.punches).toMatchObject({ total: 3, removed: 0, keptForOtherImports: 2, keptForConnector: 1 });
    const job = await undo(first.id);
    expect(job.undo).toMatchObject({ removed: 0, keptForOtherImports: 2, keptForConnector: 1 });
    for (const d of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'])
      expect(await day(ayesha, d), d).toMatchObject({ punches: { count: 1 } });
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(second.id) })).toBe(3); // handed over
    expect(await PunchEvent.findOne({ schoolId: s.schoolId, _id: firstPunch!._id }).lean()).toMatchObject({
      source: 'connector',
    });

    // Undoing the second now removes what only it holds.
    await undo(second.id);
    expect(await day(ayesha, '2026-08-11')).toBeNull();
    expect(await day(ayesha, '2026-08-13')).toBeNull();
    expect(await day(ayesha, '2026-08-10')).toMatchObject({ punches: { count: 1 } }); // the connector's
    expect(key).toMatch(/^sbk_/);
  });

  it('the connector sending a punch a file already stored is noted on the punch', async () => {
    const conn = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'Gate connector',
      integration: 'connector_api',
    });
    const key = (await api(t.app, s.ownerToken, 'post', `/biometric/devices/${conn._id}/connector-key`)).key;
    // A file punch on the connector's device (as if the same machine's export had been imported).
    const at = new Date('2026-08-20T03:00:00Z');
    await PunchEvent.create({
      schoolId: s.schoolId,
      deviceId: conn._id,
      deviceUserId: '17',
      punchedAt: at,
      localDate: '2026-08-20',
      source: 'file',
      importJobId: new mongoose.Types.ObjectId(),
      dedupeKey: punchKey(conn._id, '17', at),
    });
    const res = await request(t.app)
      .post('/api/v1/biometric/ingest')
      .set('Authorization', `Bearer ${key}`)
      .send({ punches: [{ deviceUserId: '17', timestamp: at.toISOString() }] });
    expect(res.body.data).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await PunchEvent.findOne({ schoolId: s.schoolId, deviceId: oid(conn._id) }).lean()).toMatchObject({
      alsoFromConnector: true,
    });
  });

  it('hand-made marks stay exactly as marked; flags and “keep the mark” decisions follow the rules', async () => {
    const res = await importFile('AC-No.,Time\n17,2026-08-24 08:00\n17,2026-08-25 08:00\n17,2026-08-26 08:00\n', {});
    await run(res.id);
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-08-24',
      status: 'absent',
      note: 'Sick',
    });
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-08-25',
      status: 'leave',
    });
    const kept = await day(ayesha, '2026-08-25');
    await api(t.app, s.ownerToken, 'post', `/staff-attendance/${kept!._id}/resolve`, { action: 'keep_mark' });
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-08-26',
      status: 'absent',
    });
    const used = await day(ayesha, '2026-08-26');
    await api(t.app, s.ownerToken, 'post', `/staff-attendance/${used!._id}/resolve`, { action: 'use_punches' });

    const preview = await api(t.app, s.ownerToken, 'get', `/biometric/imports/${res.id}/undo`);
    expect(preview.days).toMatchObject({
      affected: 3,
      markedKept: 2,
      flagsCleared: 1,
      becomeNotRecorded: 1,
      resolvedByPersonLosePunches: 1,
    });
    await undo(res.id);
    expect(await day(ayesha, '2026-08-24')).toMatchObject({
      status: 'absent',
      source: 'manual',
      note: 'Sick',
      punches: { count: 0 },
    });
    expect((await day(ayesha, '2026-08-24'))!.conflict?.code).toBeUndefined();
    expect(await day(ayesha, '2026-08-25')).toMatchObject({
      status: 'leave',
      source: 'manual',
      conflictDismissed: true,
    });
    // "Use the punches" was chosen; the punches are gone, so the day is no longer recorded (as the preview said).
    expect(await day(ayesha, '2026-08-26')).toBeNull();
    // The decisions stay in the audit log.
    expect(
      await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'staff_attendance.resolve' }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('repeated and simultaneous undo requests undo once; an undone import cannot run again', async () => {
    const res = await importFile('AC-No.,Time\n17,2026-08-27 08:00\n', {});
    await run(res.id);
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true }),
      ),
    );
    expect(answers.filter((a) => a.status === 202)).toHaveLength(1);
    for (const a of answers.filter((x) => x.status !== 202)) {
      expect(a.status).toBe(409);
      expect(['UNDO_IN_PROGRESS', 'IMPORT_ALREADY_UNDONE']).toContain(a.body.error.code);
    }
    await waitUndo(res.id);
    const again = await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('IMPORT_ALREADY_UNDONE');
    const rerun = await req(s.ownerToken, 'post', `/imports/${res.id}/run`, { confirm: true });
    expect(rerun.status).toBe(409);
    expect((await api(t.app, s.ownerToken, 'get', `/biometric/imports/${res.id}/undo`)).canUndo).toBe(false);
    const logs = await AuditLog.find({ schoolId: s.schoolId, action: 'import.undone', entityId: res.id }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorType: 'user', metadata: { removed: 1, file: 'punches.csv' } });
    expect(String(logs[0].actorId)).toBeTruthy();
    expect((await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, {})).status).toBe(400); // confirm required
  });

  it('a failure part-way is reported as failed, never as done; undoing again finishes it', async () => {
    const res = await importFile('AC-No.,Time\n17,2026-08-28 08:00\n17,2026-08-29 08:00\n', {});
    await run(res.id);
    // Working out the days fails after the punches are removed.
    vi.spyOn(StaffAttendance, 'deleteOne').mockImplementationOnce(() => {
      throw new Error('database went away');
    });
    await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    const failed = await waitUndo(res.id);
    expect(failed.undo).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not finish/) });
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(res.id) })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'import.undone', entityId: res.id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'import.undo_failed', entityId: res.id })).toBe(1);
    vi.restoreAllMocks();

    // The audit record cannot be written: still not done.
    vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit store down'));
    await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect((await waitUndo(res.id)).undo.status).toBe('failed');
    vi.restoreAllMocks();

    const done = await undo(res.id);
    expect(done.undo).toMatchObject({ status: 'completed', removed: 2 });
    // The days saved before the first attempt were worked out, though the punches were already gone.
    expect(await day(ayesha, '2026-08-28')).toBeNull();
    expect(await day(ayesha, '2026-08-29')).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'import.undone', entityId: res.id })).toBe(1);
  });

  it('a campus-limited user may undo only an import whose punches are all of their campuses', async () => {
    const res = await importFile('AC-No.,Time\n77,2026-08-30 08:00\n30,2026-08-30 08:05\n', {}, limitedB);
    await run(res.id, limitedB);
    // Device user 77 is then linked to campus A's Ayesha by someone with every campus.
    await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: gate._id,
      deviceUserId: '77',
      employeeId: ayesha,
    });
    const preview = await api(t.app, limitedB, 'get', `/biometric/imports/${res.id}/undo`);
    expect(preview).toMatchObject({ canUndo: false, blockedReason: expect.stringMatching(/campus/) });
    const denied = await req(limitedB, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('CAMPUS_FORBIDDEN');
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: res.id }).lean())!.undo).toBeUndefined();
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(res.id) })).toBe(2);
    // Campus A's user does not even see campus B's user's import; the owner can undo it.
    expect((await req(limitedA, 'get', `/biometric/imports/${res.id}/undo`)).status).toBe(404);
    expect((await undo(res.id)).undo.status).toBe('completed');
  });
});

describe('Relinking many punches', () => {
  it('2,000 waiting punches are linked in a few bulk writes, and every day is right', async () => {
    const docs = [];
    for (let i = 0; i < 2000; i++) {
      const at = new Date(Date.UTC(2026, 6, 1 + (i % 25), 3, Math.floor(i / 25) % 60, Math.floor(i / 1500)));
      docs.push({
        schoolId: oid(s.schoolId),
        deviceId: oid(gate._id),
        deviceUserId: '900',
        employeeId: null,
        punchedAt: at,
        localDate: `2026-07-${String(1 + (i % 25)).padStart(2, '0')}`,
        source: 'connector',
        dedupeKey: punchKey(gate._id, '900', at),
      });
    }
    await PunchEvent.insertMany(docs);
    const updateOne = vi.spyOn(PunchEvent, 'updateOne');
    const bulk = vi.spyOn(PunchEvent, 'bulkWrite');
    const started = Date.now();
    const made = await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: gate._id,
      deviceUserId: '900',
      employeeId: bilal,
    });
    const ms = Date.now() - started;
    expect(made.punchesLinked).toBe(2000);
    expect(updateOne).not.toHaveBeenCalled();
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk.mock.calls[0][0]).toHaveLength(2); // 2 × 1,000 punches
    console.info(`[measured] linking 2,000 punches (25 days) took ${ms} ms on the in-memory test database`);
    for (const d of ['2026-07-01', '2026-07-25']) expect(await day(bilal, d)).toMatchObject({ punches: { count: 80 } });
    const res = await api(t.app, s.ownerToken, 'delete', `/biometric/links/${made.link._id}`);
    expect(res.punchesChanged).toBe(2000);
    expect(await day(bilal, '2026-07-01')).toBeNull();
  });
});

describe('Repairing day summaries', () => {
  beforeAll(async () => {
    await run(
      (
        await importFile(
          'AC-No.,Time\n17,2026-06-01 08:00\n17,2026-06-01 14:00\n17,2026-06-02 08:00\n30,2026-06-01 08:00\n',
          {},
        )
      ).id,
    );
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-06-02',
      status: 'half_day',
    });
  });

  it('days out of date are worked out again from the punches; marks stay; repeating changes nothing', async () => {
    // Out of date: a wrong count, a missing day, and a stale count on a marked day.
    await StaffAttendance.updateOne(
      { schoolId: s.schoolId, employeeId: oid(ayesha), date: new Date('2026-06-01T00:00:00Z') },
      { $set: { 'punches.count': 9 } },
    );
    await StaffAttendance.deleteOne({
      schoolId: s.schoolId,
      employeeId: oid(zara),
      date: new Date('2026-06-01T00:00:00Z'),
    });
    await StaffAttendance.updateOne(
      { schoolId: s.schoolId, employeeId: oid(ayesha), date: new Date('2026-06-02T00:00:00Z') },
      { $set: { 'punches.count': 5 } },
    );
    const first = await api(t.app, s.ownerToken, 'post', '/staff-attendance/repair', {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(first).toMatchObject({ checked: 3, repaired: 3 });
    expect(await day(ayesha, '2026-06-01')).toMatchObject({ status: 'present', punches: { count: 2 } });
    expect(await day(zara, '2026-06-01')).toMatchObject({ status: 'present', punches: { count: 1 } });
    expect(await day(ayesha, '2026-06-02')).toMatchObject({
      status: 'half_day',
      source: 'manual',
      punches: { count: 1 },
    });
    expect(
      await api(t.app, s.ownerToken, 'post', '/staff-attendance/repair', { from: '2026-06-01', to: '2026-06-30' }),
    ).toMatchObject({ checked: 3, repaired: 0 });
    expect(await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'staff_attendance.repair' })).toBe(2);
  });

  it('only the caller’s campuses; at most 62 days at a time', async () => {
    await StaffAttendance.updateOne(
      { schoolId: s.schoolId, employeeId: oid(ayesha), date: new Date('2026-06-01T00:00:00Z') },
      { $set: { 'punches.count': 9 } },
    );
    expect(
      await api(t.app, limitedB, 'post', '/staff-attendance/repair', { from: '2026-06-01', to: '2026-06-30' }),
    ).toMatchObject({ checked: 1, repaired: 0 });
    expect(await day(ayesha, '2026-06-01')).toMatchObject({ punches: { count: 9 } }); // not campus B's to repair
    expect(
      await api(t.app, limitedA, 'post', '/staff-attendance/repair', {
        from: '2026-06-01',
        to: '2026-06-01',
        employeeId: ayesha,
      }),
    ).toMatchObject({ checked: 1, repaired: 1 });
    const tooLong = await req(s.ownerToken, 'post', '/staff-attendance/repair', {
      from: '2026-01-01',
      to: '2026-06-30',
    });
    expect(tooLong.status).toBe(400);
    expect(
      (await req(s.ownerToken, 'post', '/staff-attendance/repair', { from: '2026-06-30', to: '2026-06-01' })).status,
    ).toBe(400);
  });
});

describe('Device management and campuses', () => {
  it('a campus-limited user changes only their own campus’ devices; the owner changes any', async () => {
    // Created by campus B's user: campus B (their only campus) by default; another campus is refused.
    const own = await req(limitedB, 'post', '/biometric/devices', {
      name: 'B connector',
      integration: 'connector_api',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data.campusId).toBe(campusB);
    const elsewhere = await req(limitedB, 'post', '/biometric/devices', {
      name: 'Elsewhere',
      integration: 'file_import',
      campusId: s.campusId,
    });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error.code).toBe('CAMPUS_FORBIDDEN');

    const campusA = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'A connector',
      integration: 'connector_api',
      campusId: s.campusId,
    });
    await api(t.app, s.ownerToken, 'post', `/biometric/devices/${campusA._id}/connector-key`);
    // Another campus' device, and a school-wide one (the gate): nothing can be changed.
    for (const target of [campusA, gate]) {
      for (const [method, url, body] of [
        ['patch', `/biometric/devices/${target._id}`, { name: 'Renamed' }],
        ['patch', `/biometric/devices/${target._id}`, { status: 'disabled' }],
        ['patch', `/biometric/devices/${target._id}`, { campusId: campusB }],
        ['delete', `/biometric/devices/${target._id}`],
        ['post', `/biometric/devices/${target._id}/connector-key`],
        ['delete', `/biometric/devices/${target._id}/connector-key`],
      ] as const) {
        const res = await req(limitedB, method, url, body as object | undefined);
        expect(res.status, `${method} ${url} ${JSON.stringify(body ?? {})}`).toBe(403);
      }
    }
    const devices = (await api(t.app, s.ownerToken, 'get', '/biometric/devices')) as Array<Record<string, any>>;
    expect(devices.find((d) => d._id === campusA._id)).toMatchObject({
      name: 'A connector',
      status: 'active',
      campusId: s.campusId,
    });
    expect(devices.find((d) => d._id === campusA._id)!.connectorKeyHint).toBeTruthy(); // not revoked
    expect(devices.find((d) => d._id === gate._id)).toMatchObject({ name: 'Main gate', status: 'active' });

    // Their own device: not moved to another campus or to every campus, otherwise fully theirs.
    expect(
      (await req(limitedB, 'patch', `/biometric/devices/${own.body.data._id}`, { campusId: s.campusId })).status,
    ).toBe(403);
    expect((await req(limitedB, 'patch', `/biometric/devices/${own.body.data._id}`, { campusId: null })).status).toBe(
      403,
    );
    expect(
      (await req(limitedB, 'patch', `/biometric/devices/${own.body.data._id}`, { name: 'B connector 2' })).status,
    ).toBe(200);
    expect((await req(limitedB, 'post', `/biometric/devices/${own.body.data._id}/connector-key`)).status).toBe(201);
    expect((await req(limitedB, 'delete', `/biometric/devices/${own.body.data._id}/connector-key`)).status).toBe(204);
    expect(
      (await req(limitedB, 'patch', `/biometric/devices/${own.body.data._id}`, { status: 'disabled' })).status,
    ).toBe(200);
    expect((await req(limitedB, 'delete', `/biometric/devices/${own.body.data._id}`)).status).toBe(204);

    // The owner (every campus) changes any device.
    expect((await req(s.ownerToken, 'patch', `/biometric/devices/${campusA._id}`, { status: 'disabled' })).status).toBe(
      200,
    );
    expect((await req(s.ownerToken, 'delete', `/biometric/devices/${campusA._id}/connector-key`)).status).toBe(204);
    expect((await req(s.ownerToken, 'delete', `/biometric/devices/${campusA._id}`)).status).toBe(204);
  });

  it('a campus-limited user cannot import into another campus’ device', async () => {
    const files = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'A files',
      integration: 'file_import',
      campusId: s.campusId,
    });
    const res = await importFile('AC-No.,Time\n30,2026-05-11 08:00\n', { deviceId: files._id }, limitedB);
    expect(res.summary).toMatchObject({ create: 0, invalid: 1 });
    expect(res.warnings.join(' ')).toMatch(/belongs to a campus you do not have access to/);
  });
});

describe('Undo retries and their audit record', () => {
  it('every claim checks campus access again: a campus-limited user cannot finish an undo that reaches another campus', async () => {
    const res = await importFile('AC-No.,Time\n78,2026-05-12 08:00\n30,2026-05-12 08:05\n', {}, limitedB);
    await run(res.id, limitedB);
    await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: gate._id,
      deviceUserId: '78',
      employeeId: ayesha,
    });
    // The owner's undo stops part-way: the punches are gone, the days are not worked out yet.
    vi.spyOn(StaffAttendance, 'deleteOne').mockImplementationOnce(() => {
      throw new Error('database went away');
    });
    await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect((await waitUndo(res.id)).undo.status).toBe('failed');
    vi.restoreAllMocks();
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(res.id) })).toBe(0);

    // Campus B's user, who uploaded it, retries: refused (its days include campus A's Ayesha).
    const retry = await req(limitedB, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect(retry.status).toBe(403);
    expect(retry.body.error.code).toBe('CAMPUS_FORBIDDEN');
    const after = await api(t.app, limitedB, 'get', `/imports/${res.id}`);
    expect(after.undo).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not finish/) });
    // Nothing is left locked: the owner finishes it.
    expect((await undo(res.id)).undo.status).toBe('completed');
    expect(await day(ayesha, '2026-05-12')).toBeNull();
    expect(await day(zara, '2026-05-12')).toBeNull();
  });

  it('a failure after the undo was recorded: one “undone” entry, no “failed” one; the retry adds none', async () => {
    const res = await importFile('AC-No.,Time\n17,2026-05-13 08:00\n', {});
    await run(res.id);
    const updateOne = ImportJob.updateOne.bind(ImportJob);
    let failed = false;
    vi.spyOn(ImportJob, 'updateOne').mockImplementation(((filter: any, update: any, ...rest: any[]) => {
      if (!failed && update?.$set?.['undo.status'] === 'completed') {
        failed = true;
        throw new Error('database went away while marking the undo done');
      }
      return updateOne(filter, update, ...rest);
    }) as never);
    await req(s.ownerToken, 'post', `/biometric/imports/${res.id}/undo`, { confirm: true });
    expect((await waitUndo(res.id)).undo.status).toBe('failed');
    vi.restoreAllMocks();
    const count = (action: string) => AuditLog.countDocuments({ schoolId: s.schoolId, action, entityId: res.id });
    expect(await count('import.undone')).toBe(1);
    expect(await count('import.undo_failed')).toBe(0);
    expect((await undo(res.id)).undo.status).toBe('completed');
    expect(await count('import.undone')).toBe(1);
    expect(await count('import.undo_failed')).toBe(0);
  });
});

describe('Working days out at the same time', () => {
  const ctx = () => ({ schoolId: s.schoolId });
  const punchAt = (date: string, hhmm: string) => ({
    deviceUserId: '17',
    punchedAt: new Date(`${date}T${hhmm}:00+05:00`),
    localDate: date,
    punchType: 'unknown' as const,
  });

  it('a day written from an older reading of its punches is corrected straight away', async () => {
    const date = '2026-05-20';
    await storePunches(ctx(), { _id: oid(gate._id) }, [punchAt(date, '08:00')], 'connector');
    // Hold one working-out of the day between reading the punches (1) and writing the summary.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const write = StaffAttendance.findOneAndUpdate.bind(StaffAttendance);
    const spy = vi.spyOn(StaffAttendance, 'findOneAndUpdate').mockImplementationOnce(((...args: any[]) => ({
      lean: async () => {
        await held;
        return (write as any)(...args).lean();
      },
    })) as never);
    const slow = recomputeStaffDay(ctx(), ayesha, date);
    while (!spy.mock.calls.length) await new Promise((r) => setTimeout(r, 5));
    // Meanwhile a second punch arrives and its day is written (count 2).
    await storePunches(ctx(), { _id: oid(gate._id) }, [punchAt(date, '14:00')], 'connector');
    expect(await day(ayesha, date)).toMatchObject({ punches: { count: 2 } });
    release(); // the held one now writes what it read: 1
    await slow;
    expect(await day(ayesha, date)).toMatchObject({ punches: { count: 2 } });
  });

  it('30 punches arriving at once: one day record, every punch counted', async () => {
    const date = '2026-05-21';
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        storePunches(ctx(), { _id: oid(gate._id) }, [punchAt(date, `08:${String(i).padStart(2, '0')}`)], 'connector'),
      ),
    );
    const records = await StaffAttendance.find({
      schoolId: s.schoolId,
      employeeId: oid(ayesha),
      date: new Date(`${date}T00:00:00Z`),
    }).lean();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'present', source: 'biometric', punches: { count: 30 } });
  });

  it('a hand-made absence racing punches stays as marked, flagged, with every punch counted', async () => {
    const date = '2026-05-22';
    const [mark] = await Promise.all([
      req(s.ownerToken, 'put', '/staff-attendance', { employeeId: ayesha, date, status: 'absent', note: 'Sick' }),
      storePunches(ctx(), { _id: oid(gate._id) }, [punchAt(date, '08:00')], 'connector'),
      storePunches(ctx(), { _id: oid(gate._id) }, [punchAt(date, '08:30')], 'connector'),
    ]);
    expect(mark.status).toBe(200);
    expect(await day(ayesha, date)).toMatchObject({
      status: 'absent',
      source: 'manual',
      note: 'Sick',
      punches: { count: 2 },
      conflict: { code: 'marked_off_but_punched' },
    });
  });
});

describe('Required unique indexes after startup', () => {
  it('an index removed while the API runs is noticed within seconds; writes work again once it is back', async () => {
    _resetBiometricIndexCheck();
    const mark = (status: string) =>
      req(s.ownerToken, 'put', '/staff-attendance', { employeeId: ayesha, date: '2026-05-25', status });
    expect((await mark('present')).status).toBe(200); // checked and passed
    await PunchEvent.collection.dropIndex('schoolId_1_dedupeKey_1'); // this file's own test database
    // The passed check is trusted for INDEX_RECHECK_MS; afterwards the next write checks again.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + INDEX_RECHECK_MS + 1_000);
    const refused = await mark('absent');
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('BIOMETRIC_NOT_READY');
    const link = await req(s.ownerToken, 'post', '/biometric/links', { deviceUserId: '501', employeeId: bilal });
    expect(link.status).toBe(503);
    vi.restoreAllMocks();
    expect(await day(ayesha, '2026-05-25')).toMatchObject({ status: 'present' });
    // A failed check is repeated on every write: back as soon as the index is.
    await PunchEvent.syncIndexes();
    expect((await mark('absent')).status).toBe(200);
  });

  it('missing when the API starts: every kind of write is refused until it exists', async () => {
    const earlier = await importFile('AC-No.,Time\n17,2026-05-26 08:00\n', {});
    await run(earlier.id);
    await StaffAttendance.collection.dropIndex('schoolId_1_employeeId_1_date_1');
    _resetBiometricIndexCheck();
    await logBiometricIndexStatus(); // what the server does at startup
    for (const [method, url, body] of [
      ['put', '/staff-attendance', { employeeId: ayesha, date: '2026-05-26', status: 'absent' }],
      ['post', '/biometric/devices', { name: 'New one', integration: 'file_import' }],
      ['patch', `/biometric/devices/${gate._id}`, { location: 'Front' }],
      ['post', '/biometric/links', { deviceUserId: '502', employeeId: bilal }],
      ['post', '/staff-attendance/repair', { from: '2026-05-26', to: '2026-05-26' }],
      ['post', `/biometric/imports/${earlier.id}/undo`, { confirm: true }],
    ] as const) {
      const res = await req(s.ownerToken, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(503);
    }
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(earlier.id) })).toBe(1);
    await StaffAttendance.syncIndexes();
    expect(
      (
        await req(s.ownerToken, 'put', '/staff-attendance', {
          employeeId: ayesha,
          date: '2026-05-26',
          status: 'absent',
        })
      ).status,
    ).toBe(200);
  });
});

describe('Required unique indexes', () => {
  it('while one is missing, staff attendance refuses to write (reads still work); once it exists, writes work again', async () => {
    expect(await missingBiometricIndexes()).toEqual([]);
    const earlier = await importFile('AC-No.,Time\n17,2026-05-05 08:00\n', {});
    await run(earlier.id);
    // This file's own test database only.
    await PunchEvent.collection.dropIndex('schoolId_1_dedupeKey_1');
    _resetBiometricIndexCheck();
    expect(await missingBiometricIndexes()).toEqual([
      expect.stringMatching(/^punchevents \{"schoolId":1,"dedupeKey":1\} unique/),
    ]);
    const mark = await req(s.ownerToken, 'put', '/staff-attendance', {
      employeeId: ayesha,
      date: '2026-05-04',
      status: 'absent',
    });
    expect(mark.status).toBe(503);
    expect(mark.body.error.code).toBe('BIOMETRIC_NOT_READY');
    expect(JSON.stringify(mark.body)).not.toMatch(/db:indexes|punchevents/); // details are for the log, not the school
    const res = await importFile('AC-No.,Time\n17,2026-05-04 08:00\n', {});
    const done = await run(res.id);
    expect(done.result).toMatchObject({ created: 0, failed: 1 });
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, localDate: '2026-05-04' })).toBe(0);
    expect((await req(s.ownerToken, 'get', '/biometric/devices')).status).toBe(200);
    // An undo is refused before anything changes.
    const undoing = await req(s.ownerToken, 'post', `/biometric/imports/${earlier.id}/undo`, { confirm: true });
    expect(undoing.status).toBe(503);
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, importJobId: oid(earlier.id) })).toBe(1);
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: earlier.id }).lean())!.undo).toBeUndefined();

    await PunchEvent.syncIndexes();
    _resetBiometricIndexCheck();
    expect(
      (
        await req(s.ownerToken, 'put', '/staff-attendance', {
          employeeId: ayesha,
          date: '2026-05-04',
          status: 'absent',
        })
      ).status,
    ).toBe(200);
  });
});
