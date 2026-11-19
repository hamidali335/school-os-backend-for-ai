import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { PunchEvent, StaffAttendance } from '../src/modules/biometric/biometric.models';
import { detectDateOrder, parsePunchTime, parsePunchType } from '../src/modules/biometric/punch-values';
import { cellText, readSpreadsheet } from '../src/modules/imports/import-files';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Staff attendance from fingerprint machines: reading export files, linking device users to
 * staff, importing punches once, daily records that never overrule a hand-made mark, the
 * connector API, and school isolation. All data is this file's own test schools.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let teacher: { _id: string; employeeNo: string };
let bilal: { _id: string; employeeNo: string };
let device: { _id: string };
const KHI = 'Asia/Karachi';

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
  const staff = (await api(t.app, s.ownerToken, 'get', '/employees?limit=50')) as Array<{
    _id: string;
    employeeNo: string;
    firstName: string;
  }>;
  teacher = staff.find((e) => e.firstName === 'Ayesha')!;
  bilal = staff.find((e) => e.firstName === 'Bilal')!;
  device = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
    name: 'Main gate',
    manufacturer: 'ZKTeco',
    model: 'K40',
    location: 'Main gate',
    integration: 'file_import',
  });
});

const owner = () => auth(s.ownerToken);
async function upload(body: string | Buffer, name: string, token = s.ownerToken) {
  const res = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', 'staff_punches')
    .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body), name);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await waitStaged(t.app, token, res.body.data.job._id);
  return res.body.data as {
    job: { _id: string };
    columns: Array<{ column: number; field: string | null; header: string }>;
  };
}
async function check(
  up: Awaited<ReturnType<typeof upload>>,
  options: Record<string, unknown>,
  mapping?: Record<string, string>,
) {
  return checkAndWait(t.app, s.ownerToken, up.job._id, {
    mapping: up.columns.map((c) => ({ column: c.column, field: mapping?.[c.header] ?? c.field })),
    options: { deviceId: device._id, ...options },
  });
}
async function run(id: string) {
  await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
  for (;;) {
    const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}
const day = (employeeId: string, date: string) =>
  StaffAttendance.findOne({
    schoolId: s.schoolId,
    employeeId: new mongoose.Types.ObjectId(employeeId),
    date: new Date(`${date}T00:00:00Z`),
  }).lean();

describe('Reading punch times and types', () => {
  it('reads local times in the school’s time zone, and exact times as given', () => {
    const local = parsePunchTime('2026-10-01 08:01:33', undefined, { order: null, timeZone: KHI });
    expect(local).toMatchObject({ ok: true, localDate: '2026-10-01' });
    expect((local as { at: Date }).at.toISOString()).toBe('2026-10-01T03:01:33.000Z');
    const exact = parsePunchTime('2026-10-01T23:30:00Z', undefined, { order: null, timeZone: KHI });
    expect(exact).toMatchObject({ ok: true, localDate: '2026-10-02' }); // 04:30 next day in Pakistan
    // The same clock time at a school in another time zone is another instant.
    const dubai = parsePunchTime('2026-10-01 08:01:33', undefined, { order: null, timeZone: 'Asia/Dubai' });
    expect((dubai as { at: Date }).at.toISOString()).toBe('2026-10-01T04:01:33.000Z');
    expect(parsePunchTime('01/10/2026', '8:05 PM', { order: 'dmy', timeZone: KHI })).toMatchObject({
      ok: true,
      localDate: '2026-10-01',
    });
    expect(
      (parsePunchTime('10/01/2026 20:05', undefined, { order: 'mdy', timeZone: KHI }) as { at: Date }).at.toISOString(),
    ).toBe('2026-10-01T15:05:00.000Z');
  });

  it('refuses unclear, impossible or implausible times with the reason', () => {
    expect(parsePunchTime('03/04/2026 08:00', undefined, { order: null, timeZone: KHI })).toMatchObject({
      ok: false,
      ambiguous: true,
    });
    expect(parsePunchTime('31/02/2026 08:00', undefined, { order: 'dmy', timeZone: KHI })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a real date/),
    });
    expect(parsePunchTime('2026-10-01', undefined, { order: null, timeZone: KHI })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no time of day/),
    });
    expect(parsePunchTime('2026-10-01 25:00', undefined, { order: null, timeZone: KHI })).toMatchObject({ ok: false });
    expect(parsePunchTime('1999-12-31 08:00', undefined, { order: null, timeZone: KHI })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/2000/),
    });
    expect(parsePunchTime('2099-01-01 08:00', undefined, { order: null, timeZone: KHI })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/future/),
    });
  });

  it('decides the day/month order for the whole file', () => {
    expect(detectDateOrder(['03/04/2026 08:00', '24/10/2026 08:00'])).toBe('dmy');
    expect(detectDateOrder(['03/04/2026 08:00', '10/24/2026 08:00'])).toBe('mdy');
    expect(detectDateOrder(['03/04/2026 08:00'])).toBeNull();
    expect(detectDateOrder(['24/10/2026 08:00', '10/24/2026 08:00'])).toBe('mixed');
  });

  it('reads explicit in/out words only; numeric codes stay unknown', () => {
    expect(['Check In', 'C/In', 'IN', 'i'].map(parsePunchType)).toEqual(['in', 'in', 'in', 'in']);
    expect(['Check Out', 'C/Out', 'out'].map(parsePunchType)).toEqual(['out', 'out', 'out']);
    expect(['0', '1', 'OverTime In', ''].map(parsePunchType)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });
});

describe('Reading attendance export files', () => {
  it('a TXT export without a heading row (tab separated) becomes Column A, B, C…', async () => {
    const sheet = await readSpreadsheet(
      Buffer.from('    17\t2026-10-01 08:01:33\t1\t0\n    18\t2026-10-01 08:05:00\t1\t0\n'),
      'attlog.txt',
    );
    expect(sheet.headers).toEqual(['Column A', 'Column B', 'Column C', 'Column D']);
    expect(sheet.rows.map((r) => r.values[0])).toEqual(['17', '18']);
    expect(sheet.notes.join(' ')).toMatch(/no heading row/);
  });

  it('a TXT export separated by spaces is split into columns; .dat is read as text', async () => {
    const sheet = await readSpreadsheet(
      Buffer.from('17 2026-10-01 08:01:33 1\n18 2026-10-01 08:05:00 1\n'),
      'attlog.dat',
    );
    expect(sheet.rows[0].values).toEqual(['17', '2026-10-01', '08:01:33', '1']);
    expect(sheet.notes.join(' ')).toMatch(/separated by spaces/);
  });

  it('Excel date-time cells keep their time; date-only and time-only cells read as before', async () => {
    expect(cellText(new Date(Date.UTC(2026, 9, 1, 8, 1, 33))).text).toBe('2026-10-01 08:01:33');
    expect(cellText(new Date(Date.UTC(2014, 3, 4))).text).toBe('2014-04-04'); // a birth date: unchanged
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 8, 5))).text).toBe('08:05:00');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Log');
    ws.addRow(['AC-No.', 'Name', 'Time', 'State']);
    ws.addRow(['17', 'Ayesha Khan', new Date(Date.UTC(2026, 9, 1, 8, 1, 33)), 'C/In']);
    const sheet = await readSpreadsheet(Buffer.from(await wb.xlsx.writeBuffer()), 'log.xlsx');
    expect(sheet.rows[0].values).toEqual(['17', 'Ayesha Khan', '2026-10-01 08:01:33', 'C/In']);
  });
});

describe('Importing punches', () => {
  it('suggests columns, shows linked and unlinked users, and imports each punch once', async () => {
    await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: device._id,
      deviceUserId: '17',
      employeeId: teacher._id,
    });
    const csv =
      'AC-No.,Name,Time,State\n' +
      '17,Ayesha Khan,2026-10-01 08:01:33,C/In\n' +
      '0017,Ayesha Khan,2026-10-01 08:01:33,C/In\n' + // the same punch (leading zeros)
      '17,Ayesha Khan,2026-10-01 14:30:00,C/Out\n' +
      '99,Unknown,2026-10-01 08:10:00,C/In\n' +
      ',No id,2026-10-01 08:11:00,C/In\n' +
      '17,Ayesha Khan,not a time,C/In\n';
    const up = await upload(csv, 'export.csv');
    expect(Object.fromEntries(up.columns.map((c) => [c.header, c.field]))).toMatchObject({
      'AC-No.': 'deviceUserId',
      Name: 'name',
      Time: 'dateTime',
      State: 'punchType',
    });
    const { summary, warnings } = await check(up, {});
    expect(summary).toMatchObject({ total: 6, create: 3, duplicate: 1, invalid: 2, withWarnings: 1 });
    expect(warnings.join(' ')).toMatch(/1 device user ID\(s\) are not linked to staff yet \(99\)/);
    const done = await run(up.job._id);
    expect(done.result).toMatchObject({ created: 3, failed: 2, skipped: 1 });

    const punches = await PunchEvent.find({ schoolId: s.schoolId, localDate: '2026-10-01' }).lean();
    expect(punches).toHaveLength(3);
    expect(punches.filter((p) => p.employeeId)).toHaveLength(2);
    expect(punches.every((p) => String(p.importJobId) === up.job._id)).toBe(true);
    const d = await day(teacher._id, '2026-10-01');
    expect(d).toMatchObject({ status: 'present', source: 'biometric', punches: { count: 2, in: 1, out: 1 } });
    expect(d!.punches!.first!.toISOString()).toBe('2026-10-01T03:01:33.000Z');

    // The same file again, and an overlapping export: nothing twice.
    const again = await upload(csv, 'export-again.csv');
    expect((await check(again, {})).summary).toMatchObject({ create: 0, exists: 3 });
    const overlap = await upload(`${csv}17,Ayesha Khan,2026-10-02 08:00:00,C/In\n`, 'export-week.csv');
    expect((await check(overlap, {})).summary).toMatchObject({ create: 1, exists: 3 });
    expect((await run(overlap.job._id)).result).toMatchObject({ created: 1 });
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId })).toBe(4);
  });

  it('linking a waiting device user links their punches and works out the days; unlinking undoes it', async () => {
    const unlinked = await api(t.app, s.ownerToken, 'get', '/biometric/unlinked');
    expect(unlinked).toEqual([expect.objectContaining({ deviceUserId: '99', punches: 1, suggestion: null })]);
    const made = await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: null,
      deviceUserId: '99',
      employeeId: bilal._id,
    });
    expect(made.punchesLinked).toBe(1);
    expect(await day(bilal._id, '2026-10-01')).toMatchObject({ status: 'present', punches: { count: 1 } });
    expect(await api(t.app, s.ownerToken, 'get', '/biometric/unlinked')).toEqual([]);
    const res = await api(t.app, s.ownerToken, 'delete', `/biometric/links/${made.link._id}`);
    expect(res.punchesChanged).toBe(1);
    expect(await day(bilal._id, '2026-10-01')).toBeNull(); // a day made only from those punches goes
  });

  it('suggests a link only when the device user ID is exactly an Employee No', async () => {
    // Separate date and time columns (named so this import's remembered matches do not affect the
    // files of later tests, whose "Time" column holds the date and time).
    const up = await upload(
      `User ID,Punch Date,Punch Clock\n${teacher.employeeNo},2026-10-03,08:00\n`,
      'by-number.csv',
    );
    expect((await check(up, {}, { 'Punch Date': 'date', 'Punch Clock': 'time' })).summary).toMatchObject({ create: 1 });
    await run(up.job._id);
    const unlinked = (await api(t.app, s.ownerToken, 'get', '/biometric/unlinked')) as Array<{
      deviceUserId: string;
      suggestion: { employeeId: string } | null;
    }>;
    const row = unlinked.find((u) => u.deviceUserId === teacher.employeeNo)!;
    expect(row.suggestion).toMatchObject({ employeeId: teacher._id });
    // Not linked until someone confirms it.
    expect(
      await PunchEvent.countDocuments({ schoolId: s.schoolId, deviceUserId: teacher.employeeNo, employeeId: null }),
    ).toBe(1);
  });

  it('dates that could be day/month or month/day are refused until the order is chosen', async () => {
    const csv = 'AC-No.,Time\n17,03/04/2026 08:00\n17,05/06/2026 08:00\n';
    const up = await upload(csv, 'ambiguous.csv');
    const auto = await check(up, {});
    expect(auto.summary).toMatchObject({ invalid: 2 });
    const rows = await api(t.app, s.ownerToken, 'get', `/imports/${up.job._id}/rows?filter=problems`);
    expect(rows[0].issues[0].message).toMatch(/could be day\/month or month\/day/);
    const chosen = await check(up, { dateOrder: 'dmy' });
    expect(chosen.summary).toMatchObject({ create: 2, invalid: 0 });
  });

  it('a file without a heading row is imported by matching Column A, B…', async () => {
    const up = await upload('\t17\t2026-10-05 08:00:00\t0\t1\n\t17\t2026-10-05 13:00:00\t1\t1\n', 'attlog.txt');
    const map = { 'Column B': 'deviceUserId', 'Column C': 'dateTime' };
    const { summary } = await check(up, {}, map);
    expect(summary).toMatchObject({ create: 2, invalid: 0 });
    expect((await run(up.job._id)).result).toMatchObject({ created: 2 });
    expect(await day(teacher._id, '2026-10-05')).toMatchObject({
      status: 'present',
      punches: { count: 2, in: 0, out: 0 },
    });
  });

  it('a device that is disabled, removed, of another school or not for file import refuses every row', async () => {
    const otherDevice = await api(t.app, other.ownerToken, 'post', '/biometric/devices', {
      name: 'Theirs',
      integration: 'file_import',
    });
    const up = await upload('AC-No.,Time\n17,2026-10-06 08:00\n', 'x.csv');
    const res = await check(up, { deviceId: otherDevice._id });
    expect(res.summary).toMatchObject({ invalid: 1, create: 0 });
    expect(res.warnings.join(' ')).toMatch(/no longer exists/);
    const conn = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'Connector',
      integration: 'connector_api',
    });
    expect((await check(up, { deviceId: conn._id })).warnings.join(' ')).toMatch(/does not use File import/);
    expect(await PunchEvent.countDocuments({ schoolId: other.schoolId })).toBe(0);
  });

  it('a 5,000-row export is checked and imported in the background', async () => {
    const lines = ['AC-No.,Time,State'];
    for (let i = 0; i < 5000; i++) {
      const minute = String(i % 60).padStart(2, '0');
      const hour = String(6 + (Math.floor(i / 60) % 12)).padStart(2, '0');
      const dayNo = String(1 + Math.floor(i / 720)).padStart(2, '0');
      lines.push(`${1000 + (i % 40)},2026-09-${dayNo} ${hour}:${minute}:00,${i % 2 ? 'C/Out' : 'C/In'}`);
    }
    const up = await upload(`${lines.join('\n')}\n`, 'big.csv');
    const { summary } = await check(up, {});
    expect(summary.total).toBe(5000);
    expect(summary.create + summary.duplicate).toBe(5000);
    const done = await run(up.job._id);
    expect(done.status).toBe('completed');
    expect(done.result.created).toBe(summary.create);
    expect(await PunchEvent.countDocuments({ schoolId: s.schoolId, deviceUserId: { $gte: '1000', $lt: '1040' } })).toBe(
      summary.create,
    );
  }, 240_000);
});

describe('Daily records and hand-made marks', () => {
  it('a day marked absent by hand stays absent when punches arrive, and is flagged to resolve', async () => {
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: teacher._id,
      date: '2026-10-07',
      status: 'absent',
      note: 'Called in sick',
    });
    const up = await upload('AC-No.,Time\n17,2026-10-07 08:00\n', 'late-export.csv');
    await check(up, {});
    await run(up.job._id);
    const d = await day(teacher._id, '2026-10-07');
    expect(d).toMatchObject({
      status: 'absent',
      source: 'manual',
      note: 'Called in sick',
      punches: { count: 1 },
      conflict: { code: 'marked_off_but_punched' },
    });
    const conflicts = await api(t.app, s.ownerToken, 'get', '/staff-attendance/conflicts');
    expect(conflicts.map((c: { _id: string }) => c._id)).toContain(String(d!._id));

    await api(t.app, s.ownerToken, 'post', `/staff-attendance/${d!._id}/resolve`, { action: 'keep_mark' });
    expect(await day(teacher._id, '2026-10-07')).toMatchObject({ status: 'absent', conflictDismissed: true });
    // More punches the same day do not raise it again.
    const more = await upload('AC-No.,Time\n17,2026-10-07 13:00\n', 'later.csv');
    await check(more, {});
    await run(more.job._id);
    expect((await day(teacher._id, '2026-10-07'))!.conflict?.code).toBeUndefined();
  });

  it('using the punches resolves to present; clearing a mark goes back to the punches', async () => {
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: teacher._id,
      date: '2026-10-05',
      status: 'leave',
    });
    const flagged = await day(teacher._id, '2026-10-05');
    expect(flagged).toMatchObject({ status: 'leave', conflict: { code: 'marked_off_but_punched' } });
    await api(t.app, s.ownerToken, 'post', `/staff-attendance/${flagged!._id}/resolve`, { action: 'use_punches' });
    expect(await day(teacher._id, '2026-10-05')).toMatchObject({ status: 'present', source: 'biometric' });
    await api(t.app, s.ownerToken, 'put', '/staff-attendance', {
      employeeId: teacher._id,
      date: '2026-10-05',
      status: 'half_day',
    });
    await api(t.app, s.ownerToken, 'delete', `/staff-attendance/${teacher._id}/2026-10-05`);
    expect(await day(teacher._id, '2026-10-05')).toMatchObject({
      status: 'present',
      source: 'biometric',
      punches: { count: 2 },
    });
  });

  it('no punches never means absent: the day shows as not recorded', async () => {
    const res = await api(t.app, s.ownerToken, 'get', '/staff-attendance?date=2026-10-08');
    expect(res.totals).toMatchObject({ absent: 0, present: 0 });
    expect(res.totals.notRecorded).toBe(res.totals.staff);
    expect(res.rows.every((r: { record: unknown }) => r.record === null)).toBe(true);
  });

  it('days cannot be marked in the future', async () => {
    const res = await request(t.app)
      .put('/api/v1/staff-attendance')
      .set(owner())
      .send({ employeeId: teacher._id, date: '2099-01-01', status: 'present' });
    expect(res.status).toBe(400);
  });
});

describe('Devices, integrations and access', () => {
  it('planned integrations are listed honestly and cannot be registered', async () => {
    const list = (await api(t.app, s.ownerToken, 'get', '/biometric/integrations')) as Array<{
      method: string;
      status: string;
      usable: boolean;
    }>;
    expect(list.filter((i) => i.usable).map((i) => i.method)).toEqual(['file_import', 'connector_api']);
    expect(list.find((i) => i.method === 'zkteco_push')).toMatchObject({ status: 'planned', usable: false });
    const res = await request(t.app)
      .post('/api/v1/biometric/devices')
      .set(owner())
      .send({ name: 'Push one', integration: 'zkteco_push' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_AVAILABLE');
    const status = await api(t.app, s.ownerToken, 'get', `/biometric/devices/${device._id}/status`);
    expect(status.state).toBe('not_applicable');
  });

  it('a device with punches is disabled, not deleted; one without can be removed', async () => {
    const res = await request(t.app).delete(`/api/v1/biometric/devices/${device._id}`).set(owner());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEVICE_HAS_PUNCHES');
    const spare = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'Spare',
      integration: 'file_import',
    });
    expect((await request(t.app).delete(`/api/v1/biometric/devices/${spare._id}`).set(owner())).status).toBe(204);
  });

  it('teachers have no access; the accountant can view but not change', async () => {
    expect((await request(t.app).get('/api/v1/biometric/devices').set(auth(s.teacherToken))).status).toBe(403);
    expect(
      (await request(t.app).get('/api/v1/staff-attendance?date=2026-10-01').set(auth(s.teacherToken))).status,
    ).toBe(403);
    expect((await request(t.app).get('/api/v1/biometric/devices').set(auth(s.accountantToken))).status).toBe(200);
    expect(
      (
        await request(t.app)
          .post('/api/v1/biometric/devices')
          .set(auth(s.accountantToken))
          .send({ name: 'X', integration: 'file_import' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(t.app)
          .put('/api/v1/staff-attendance')
          .set(auth(s.accountantToken))
          .send({ employeeId: teacher._id, date: '2026-10-01', status: 'absent' })
      ).status,
    ).toBe(403);
  });

  it('another school sees none of it and cannot link to this school’s staff or devices', async () => {
    expect(await api(t.app, other.ownerToken, 'get', '/biometric/links')).toEqual([]);
    expect(
      (await api(t.app, other.ownerToken, 'get', '/biometric/devices')).map((d: { name: string }) => d.name),
    ).toEqual(['Theirs']);
    expect(
      (
        await request(t.app)
          .post('/api/v1/biometric/links')
          .set(auth(other.ownerToken))
          .send({ deviceUserId: '5', employeeId: teacher._id })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(t.app)
          .post('/api/v1/biometric/links')
          .set(auth(other.ownerToken))
          .send({ deviceId: device._id, deviceUserId: '5', employeeId: teacher._id })
      ).status,
    ).toBe(404);
    expect(
      (await request(t.app).get(`/api/v1/biometric/devices/${device._id}/status`).set(auth(other.ownerToken))).status,
    ).toBe(404);
    const theirDay = await api(t.app, other.ownerToken, 'get', '/staff-attendance?date=2026-10-01');
    expect(theirDay.rows.some((r: { employee: { _id: string } }) => r.employee._id === teacher._id)).toBe(false);
  });
});

describe('Connector API', () => {
  let conn: { _id: string };
  let key: string;
  beforeAll(async () => {
    conn = await api(t.app, s.ownerToken, 'post', '/biometric/devices', {
      name: 'Staff room connector',
      integration: 'connector_api',
    });
    expect((await api(t.app, s.ownerToken, 'get', `/biometric/devices/${conn._id}/status`)).state).toBe(
      'not_configured',
    );
    key = (await api(t.app, s.ownerToken, 'post', `/biometric/devices/${conn._id}/connector-key`)).key;
    await api(t.app, s.ownerToken, 'post', '/biometric/links', {
      deviceId: conn._id,
      deviceUserId: '5',
      employeeId: bilal._id,
    });
  });
  const ingest = (body: unknown, k = key) =>
    request(t.app)
      .post('/api/v1/biometric/ingest')
      .set('Authorization', `Bearer ${k}`)
      .send(body as object);

  it('stores punches once, rejects those without a time zone, and reports what happened', async () => {
    const body = {
      punches: [
        { deviceUserId: '5', timestamp: '2026-10-09T08:00:00+05:00', punchType: 'in' },
        { deviceUserId: '5', timestamp: '2026-10-09 14:00:00' },
        { deviceUserId: '6', timestamp: '2026-10-09T03:05:00Z' },
      ],
    };
    const first = await ingest(body);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      stored: 2,
      duplicates: 0,
      linked: 1,
      rejected: [{ index: 1, reason: expect.stringMatching(/time zone/) }],
    });
    const again = await ingest(body);
    expect(again.body.data).toMatchObject({ stored: 0, duplicates: 2 });
    expect(await day(bilal._id, '2026-10-09')).toMatchObject({ status: 'present', punches: { count: 1, in: 1 } });
    expect((await api(t.app, s.ownerToken, 'get', `/biometric/devices/${conn._id}/status`)).state).toBe('received');
  });

  it('a wrong, revoked or other device’s key is refused; a disabled device sends nothing', async () => {
    expect(
      (await ingest({ punches: [{ deviceUserId: '5', timestamp: '2026-10-09T09:00:00Z' }] }, `${key.slice(0, -2)}xx`))
        .status,
    ).toBe(401);
    expect(
      (await ingest({ punches: [{ deviceUserId: '5', timestamp: '2026-10-09T09:00:00Z' }] }, 'nonsense')).status,
    ).toBe(401);
    await api(t.app, s.ownerToken, 'patch', `/biometric/devices/${conn._id}`, { status: 'disabled' });
    expect((await ingest({ punches: [{ deviceUserId: '5', timestamp: '2026-10-09T09:00:00Z' }] })).status).toBe(403);
    await api(t.app, s.ownerToken, 'patch', `/biometric/devices/${conn._id}`, { status: 'active' });
    await api(t.app, s.ownerToken, 'delete', `/biometric/devices/${conn._id}/connector-key`);
    expect((await ingest({ punches: [{ deviceUserId: '5', timestamp: '2026-10-09T09:00:00Z' }] })).status).toBe(401);
    expect(
      (await request(t.app).post(`/api/v1/biometric/devices/${device._id}/connector-key`).set(owner())).status,
    ).toBe(400);
  });

  it('the key is never returned by the device list', async () => {
    const list = await request(t.app).get('/api/v1/biometric/devices').set(owner());
    expect(JSON.stringify(list.body)).not.toMatch(/connectorKeyHash|sbk_/);
  });
});
