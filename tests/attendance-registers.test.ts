import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AttendanceRecord, AttendanceRegister } from '../src/modules/attendance/attendance.model';
import { formatDateOnly } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
const X = { crossTenant: true } as never;

// Fixed past school days, within the teacher's 7-day correction window.
const day = (n: number) => formatDateOnly(new Date(Date.now() - n * 86_400_000));

const mark = (token: string, body: Record<string, unknown>) =>
  request(t.app).post('/api/v1/attendance/mark').set(auth(token)).send(body);

describe('Attendance registers: drafts allowed, incomplete registers never finalized', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
    other = await buildSchool(t.app, { students: 1 });
  });

  it('saves a partial draft without assuming anything about the unmarked student', async () => {
    const date = day(1);
    const res = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      finalize: false,
      records: [{ studentId: s.students[0], status: 'present' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ finalized: false, state: 'draft', missingCount: 1 });
    expect(res.body.data.missing.map((m: any) => m.studentId)).toEqual([s.students[1]]);
    // The unmarked student has no record at all: not present, not absent.
    expect(await AttendanceRecord.countDocuments({ studentId: s.students[1] }).setOptions(X)).toBe(0);

    const roster = await api(t.app, s.teacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${date}`);
    expect(roster.state).toBe('draft');
    expect(roster.missingCount).toBe(1);
    expect(roster.students.find((x: any) => x.studentId === s.students[1]).status).toBeNull();
  });

  it('refuses to finalize an incomplete register, names the students, and keeps the entries', async () => {
    const date = day(2);
    const res = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      finalize: true,
      records: [{ studentId: s.students[0], status: 'absent' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ATTENDANCE_INCOMPLETE');
    expect(res.body.error.message).toBe(
      'Attendance cannot be finalized. Attendance is missing for 1 student. The 1 entry you marked was saved as a draft.',
    );
    expect(res.body.error.details.missing.map((m: any) => m.studentId)).toEqual([s.students[1]]);
    const saved = await AttendanceRecord.findOne({ studentId: s.students[0], date: new Date(`${date}T00:00:00Z`) })
      .setOptions(X)
      .lean();
    expect(saved?.status).toBe('absent');
    const roster = await api(t.app, s.teacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${date}`);
    expect(roster.state).toBe('draft');
  });

  it('finalizes once every student has a status, including a retry of the same request', async () => {
    const date = day(2);
    const body = {
      sectionId: s.sectionA,
      date,
      finalize: true,
      records: [
        { studentId: s.students[0], status: 'absent' },
        { studentId: s.students[1], status: 'leave' },
      ],
    };
    const first = await mark(s.teacherToken, body);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ finalized: true, state: 'complete', missingCount: 0 });
    const retry = await mark(s.teacherToken, body);
    expect(retry.status).toBe(200);
    expect(retry.body.data.state).toBe('complete');
  });

  it('combines entries saved by two people before finalizing', async () => {
    const date = day(3);
    await mark(s.ownerToken, {
      sectionId: s.sectionA,
      date,
      finalize: false,
      records: [{ studentId: s.students[0], status: 'late' }],
    });
    const res = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      finalize: true,
      records: [{ studentId: s.students[1], status: 'present' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('complete');
  });

  it('keeps older clients working: no finalize flag saves, and finalizes only a complete register', async () => {
    const date = day(4);
    const partial = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[0], status: 'present' }],
    });
    expect(partial.status).toBe(200);
    expect(partial.body.data.state).toBe('draft');
    const full = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[1], status: 'present' }],
    });
    expect(full.body.data.state).toBe('complete');
  });

  it('rejects invalid statuses and students from another section or school', async () => {
    const date = day(5);
    const bad = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[0], status: 'maybe' }],
    });
    expect(bad.status).toBe(400);
    const wrongSection = await mark(s.ownerToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[2], status: 'present' }],
    });
    expect(wrongSection.status).toBe(400);
    const foreign = await mark(s.ownerToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: other.students[0], status: 'present' }],
    });
    expect(foreign.status).toBe(400);
  });

  it('shows administrators which sections are incomplete, and the teacher dashboard says so', async () => {
    const date = day(1); // section A is a draft on this day, section B untouched
    const daily = await api(t.app, s.principalToken, 'get', `/attendance/daily?date=${date}`);
    const a = daily.sections.find((x: any) => x.sectionId === s.sectionA);
    expect(a).toMatchObject({ state: 'draft', missing: 1, marked: true });
    expect(daily.incompleteSections.map((x: any) => x.sectionId)).toContain(s.sectionA);
    expect(daily.sections.find((x: any) => x.sectionId === s.sectionB).state).toBe('not_started');
  });

  it('a day marked before registers existed counts as complete when everyone has a status', async () => {
    // As the earlier version stored it: records, no register document.
    const old = (n: number) => new Date(`${day(n)}T00:00:00Z`);
    const record = (studentId: string, date: Date) => ({
      schoolId: s.schoolId,
      studentId,
      date,
      status: 'present',
      sectionId: s.sectionA,
      classId: s.classId,
      sessionId: s.sessionId,
      campusId: s.campusId,
    });
    await AttendanceRecord.insertMany([
      record(s.students[0], old(20)),
      record(s.students[1], old(20)),
      record(s.students[0], old(21)),
    ]);
    const full = await api(t.app, s.principalToken, 'get', `/attendance/sections/${s.sectionA}?date=${day(20)}`);
    expect(full).toMatchObject({ state: 'complete', missingCount: 0 });
    const daily = await api(t.app, s.principalToken, 'get', `/attendance/daily?date=${day(20)}`);
    expect(daily.sections.find((x: any) => x.sectionId === s.sectionA).state).toBe('complete');
    expect(daily.incompleteSections.map((x: any) => x.sectionId)).not.toContain(s.sectionA);
    // A day that was only partly marked then is still shown as incomplete (never filled in).
    const partial = await api(t.app, s.principalToken, 'get', `/attendance/sections/${s.sectionA}?date=${day(21)}`);
    expect(partial).toMatchObject({ state: 'draft', missingCount: 1 });
    expect(await AttendanceRecord.countDocuments({ schoolId: s.schoolId, date: old(21) })).toBe(1);
  });

  it('a draft with everyone marked stays a draft until it is finalized', async () => {
    const date = day(0);
    const records = [
      { studentId: s.students[0], status: 'present' },
      { studentId: s.students[1], status: 'absent' },
    ];
    const draft = await mark(s.teacherToken, { sectionId: s.sectionA, date, finalize: false, records });
    expect(draft.body.data).toMatchObject({ finalized: false, state: 'draft', missingCount: 0 });
    expect(
      await AttendanceRegister.findOne({
        schoolId: s.schoolId,
        sectionId: s.sectionA,
        date: new Date(`${date}T00:00:00Z`),
      }).lean(),
    ).toMatchObject({ draftSavedAt: expect.any(Date) });
    expect((await api(t.app, s.teacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${date}`)).state).toBe(
      'draft',
    );
    const finalized = await mark(s.teacherToken, { sectionId: s.sectionA, date, finalize: true, records });
    expect(finalized.body.data.state).toBe('complete');
  });

  it('an older client (no finalize flag) can never finalize an incomplete register', async () => {
    const date = day(7);
    const res = await mark(s.teacherToken, {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[1], status: 'absent' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ finalized: false, state: 'draft', missingCount: 1 });
    expect(res.body.data.missing.map((m: any) => m.studentId)).toEqual([s.students[0]]);
    const reg = await AttendanceRegister.findOne({
      schoolId: s.schoolId,
      sectionId: s.sectionA,
      date: new Date(`${date}T00:00:00Z`),
    }).lean();
    expect(reg?.finalizedAt).toBeUndefined();
    const daily = await api(t.app, s.principalToken, 'get', `/attendance/daily?date=${date}`);
    expect(daily.incompleteSections.map((x: any) => x.sectionId)).toContain(s.sectionA);
  });

  it('treats a register as incomplete again when the roster grows after finalizing', async () => {
    const date = day(6);
    await mark(s.ownerToken, {
      sectionId: s.sectionB,
      date,
      finalize: true,
      records: [
        { studentId: s.students[2], status: 'present' },
        { studentId: s.students[3], status: 'present' },
      ],
    });
    await api(t.app, s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'Newcomer',
      gender: 'male',
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionB,
      guardians: [{ parent: { name: 'New Parent', phone: '+923001112233' }, isPrimary: true }],
    });
    const roster = await api(t.app, s.ownerToken, 'get', `/attendance/sections/${s.sectionB}?date=${date}`);
    expect(roster.state).toBe('draft');
    expect(roster.missingCount).toBe(1);
  });
});
