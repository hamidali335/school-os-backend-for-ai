import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { auth, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Ordinary (hand-marked) staff attendance and its report: days per status, an honest percentage
 * (unmarked days are "not recorded", never absent), filters, CSV of exactly the filtered rows,
 * and no access for families or other schools. The biometric device integration stays paused.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let bilal: string;
const today = todayInTz('Asia/Karachi');
const day = (n: number) => formatDateOnly(addDays(parseDateOnly(today), -n));
const from = day(10);
const to = day(6);

const mark = (employeeId: string, date: string, status: string, note?: string) =>
  api(t.app, f.ownerToken, 'put', '/staff-attendance', { employeeId, date, status, ...(note ? { note } : {}) });
const report = (qs: string, token = f.ownerToken) => api(t.app, token, 'get', `/staff-attendance/report?${qs}`);

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
  const staff = await api(t.app, f.ownerToken, 'get', '/employees?limit=50');
  bilal = staff.find((e: { firstName: string }) => e.firstName === 'Bilal')._id;
  await api(t.app, f.ownerToken, 'patch', `/employees/${bilal}`, { department: 'Science' });
  // Ayesha: present, late, half day, absent, and one day nobody marked.
  await mark(f.teacherEmployeeId, day(10), 'present');
  await mark(f.teacherEmployeeId, day(9), 'late', 'Arrived 8:40');
  await mark(f.teacherEmployeeId, day(8), 'half_day');
  await mark(f.teacherEmployeeId, day(7), 'absent');
  await mark(bilal, day(10), 'leave');
});

describe('marking', () => {
  it('a second mark for the same person and day replaces the first (one record per day)', async () => {
    await mark(bilal, day(6), 'absent');
    await mark(bilal, day(6), 'present', 'Was on duty at the gate');
    const r = await report(`from=${day(6)}&to=${day(6)}&employeeId=${bilal}`);
    expect(r.rows[0]).toMatchObject({ present: 1, absent: 0 });
  });

  it('only staff managers can mark; families cannot see staff attendance', async () => {
    const res = await request(t.app)
      .put('/api/v1/staff-attendance')
      .set(auth(f.teacherToken))
      .send({ employeeId: bilal, date: day(5), status: 'present' });
    expect(res.status).toBe(403);
    expect(
      (await request(t.app).get(`/api/v1/staff-attendance/report?from=${from}&to=${to}`).set(auth(f.parentToken)))
        .status,
    ).toBe(403);
  });
});

describe('report', () => {
  it('counts each status and gives an honest percentage', async () => {
    const r = await report(`from=${from}&to=${to}`);
    expect(r.days).toBe(5);
    const ayesha = r.rows.find((x: { employeeId: string }) => x.employeeId === f.teacherEmployeeId);
    expect(ayesha).toMatchObject({ present: 1, late: 1, halfDay: 1, absent: 1, leave: 0, notRecorded: 1 });
    expect(ayesha.attendancePercent).toBe(62.5); // (1 + 1 + 0.5) ÷ 4 recorded days
    expect(JSON.stringify(r)).not.toMatch(/salary|cnic/i);
  });

  it('a person with no marks has no percentage rather than 0%', async () => {
    const r = await report(`from=${day(30)}&to=${day(25)}`);
    expect(r.rows.every((x: { attendancePercent: number | null }) => x.attendancePercent === null)).toBe(true);
  });

  it('filters by status, department and person', async () => {
    expect(
      (await report(`from=${from}&to=${to}&status=leave`)).rows.map((x: { employeeId: string }) => x.employeeId),
    ).toEqual([bilal]);
    expect(
      (await report(`from=${from}&to=${to}&department=Science`)).rows.map((x: { employeeId: string }) => x.employeeId),
    ).toEqual([bilal]);
    expect((await report(`from=${from}&to=${to}&employeeId=${f.teacherEmployeeId}`)).rows).toHaveLength(1);
  });

  it('refuses a reversed or too long range', async () => {
    for (const qs of [`from=${to}&to=${from}`, `from=${day(400)}&to=${day(1)}`]) {
      expect((await request(t.app).get(`/api/v1/staff-attendance/report?${qs}`).set(auth(f.ownerToken))).status).toBe(
        400,
      );
    }
  });

  it('the CSV has exactly the filtered rows', async () => {
    const res = await request(t.app)
      .get(`/api/v1/staff-attendance/report.csv?from=${from}&to=${to}&status=leave`)
      .set(auth(f.ownerToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'Employee No,Name,Designation,Department,Present,Late,Half day,Absent,Leave,Not recorded,Attendance %',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Bilal');
  });

  it("another school never sees this school's staff", async () => {
    const r = await report(`from=${from}&to=${to}`, other.ownerToken);
    expect(r.rows.map((x: { employeeId: string }) => x.employeeId)).not.toContain(f.teacherEmployeeId);
    const res = await request(t.app)
      .get(`/api/v1/staff-attendance/report?from=${from}&to=${to}&employeeId=${f.teacherEmployeeId}`)
      .set(auth(other.ownerToken));
    expect(res.body.data.rows).toEqual([]);
  });
});
