import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { countStatuses, trailingAbsenceStreak } from '../src/modules/attendance/attendance-stats';
import { conflictsBetween, scanConflicts } from '../src/modules/timetable/conflicts';
import { formatDateOnly, todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
const today = todayInTz('Asia/Karachi');
const daysAgo = (n: number) => formatDateOnly(new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86_400_000));

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 4 });
});

describe('Attendance statistics (pure)', () => {
  it('excludes leave/excused from the rate and counts late as attended', () => {
    const c = countStatuses(['present', 'present', 'late', 'absent', 'leave', 'excused']);
    expect(c.total).toBe(6);
    expect(c.rate).toBe(75);
    expect(countStatuses([]).rate).toBeNull();
  });
  it('measures trailing consecutive absences, skipping leave days', () => {
    expect(
      trailingAbsenceStreak([{ status: 'present' }, { status: 'absent' }, { status: 'leave' }, { status: 'absent' }]),
    ).toBe(2);
    expect(trailingAbsenceStreak([{ status: 'absent' }, { status: 'present' }])).toBe(0);
  });
});

describe('Attendance API', () => {
  it('lets the assigned teacher mark their section and computes the summary', async () => {
    const roster = await api(t.app, s.teacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${today}`);
    expect(roster.students).toHaveLength(2);
    expect(roster.marked).toBe(false);
    const res = await api(t.app, s.teacherToken, 'post', '/attendance/mark', {
      sectionId: s.sectionA,
      date: today,
      records: [
        { studentId: s.students[0], status: 'present' },
        { studentId: s.students[1], status: 'absent' },
      ],
      notifyParents: true,
    });
    expect(res.summary.rate).toBe(50);
    expect(res.parentsNotified).toBe(0); // students[1]'s parent has no app account
    // Correction overwrites rather than duplicates.
    await api(t.app, s.teacherToken, 'post', '/attendance/mark', {
      sectionId: s.sectionA,
      date: today,
      records: [{ studentId: s.students[1], status: 'late' }],
    });
    const after = await api(t.app, s.teacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${today}`);
    expect(after.summary.total).toBe(2);
    expect(after.summary.rate).toBe(100);
  });

  it('blocks teachers from sections they are not assigned to', async () => {
    const res = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.otherTeacherToken))
      .send({ sectionId: s.sectionA, date: today, records: [{ studentId: s.students[0], status: 'absent' }] });
    expect(res.status).toBe(403);
  });

  it('rejects future dates, foreign students and stale edits by teachers', async () => {
    const future = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, date: '2099-01-01', records: [{ studentId: s.students[0], status: 'present' }] });
    expect(future.status).toBe(400);
    const wrongSection = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, date: today, records: [{ studentId: s.students[3], status: 'present' }] });
    expect(wrongSection.status).toBe(400);
    const stale = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, date: daysAgo(20), records: [{ studentId: s.students[0], status: 'present' }] });
    expect(stale.status).toBe(403);
    const admin = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, date: daysAgo(20), records: [{ studentId: s.students[0], status: 'present' }] });
    expect(admin.status).toBe(200);
  });

  it('shows the daily overview with unmarked sections and flags consecutive absences', async () => {
    const daily = await api(t.app, s.ownerToken, 'get', `/attendance/daily?date=${today}`);
    expect(daily.sectionsTotal).toBe(2);
    expect(daily.sectionsMarked).toBe(1);
    expect(daily.unmarkedSections[0].sectionId).toBe(s.sectionB);

    for (const d of [2, 1, 0]) {
      await api(t.app, s.ownerToken, 'post', '/attendance/mark', {
        sectionId: s.sectionB,
        date: daysAgo(d),
        records: [
          { studentId: s.students[2], status: 'absent' },
          { studentId: s.students[3], status: 'present' },
        ],
      });
    }
    const chronic = await api(t.app, s.ownerToken, 'get', '/attendance/chronic-absentees');
    expect(chronic.map((c: any) => c.studentId)).toContain(s.students[2]);
    const report = await api(
      t.app,
      s.ownerToken,
      'get',
      `/attendance/report?from=${daysAgo(30)}&to=${today}&belowThreshold=true`,
    );
    expect(report.students.map((r: any) => r.studentId)).toContain(s.students[2]);
  });

  it('lets parents read only their own child’s attendance', async () => {
    const mine = await api(
      t.app,
      s.parentToken,
      'get',
      `/attendance/students/${s.students[0]}?from=${daysAgo(30)}&to=${today}`,
    );
    expect(mine.summary.total).toBeGreaterThan(0);
    const other = await request(t.app)
      .get(`/api/v1/attendance/students/${s.students[1]}?from=${daysAgo(30)}&to=${today}`)
      .set(auth(s.parentToken));
    expect(other.status).toBe(404);
    const mark = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.parentToken))
      .send({ sectionId: s.sectionA, date: today, records: [{ studentId: s.students[0], status: 'present' }] });
    expect(mark.status).toBe(403);
  });
});

describe('Timetable conflicts (pure)', () => {
  const base = {
    sectionId: 's1',
    teacherId: 't1',
    campusId: 'c1',
    room: 'R1',
    dayOfWeek: 1,
    startMinutes: 480,
    endMinutes: 520,
  };
  it('detects section, teacher and room overlaps but allows back-to-back periods', () => {
    expect(conflictsBetween({ ...base, sectionId: 's2', room: 'R2' }, base).map((c) => c.type)).toEqual(['teacher']);
    expect(conflictsBetween({ ...base, teacherId: 't2', room: 'r1 ' }, base).map((c) => c.type)).toEqual([
      'section',
      'room',
    ]);
    expect(conflictsBetween({ ...base, startMinutes: 520, endMinutes: 560 }, base)).toEqual([]);
    expect(conflictsBetween({ ...base, dayOfWeek: 2 }, base)).toEqual([]);
    expect(conflictsBetween({ ...base, campusId: 'c2', sectionId: 's3', teacherId: 't3' }, base)).toEqual([]);
  });
  it('scans a whole timetable', () => {
    expect(
      scanConflicts([
        { ...base, id: 'a' },
        { ...base, id: 'b', sectionId: 's9', room: null, startMinutes: 500, endMinutes: 540 },
      ]),
    ).toHaveLength(1);
  });
});

describe('Timetable API', () => {
  it('rejects double-booking a teacher and reports conflicts on check', async () => {
    const p = {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      teacherId: s.teacherEmployeeId,
      dayOfWeek: 1,
      startTime: '08:00',
      endTime: '08:40',
      room: '5A',
    };
    await api(t.app, s.ownerToken, 'post', '/timetable', p);
    const clash = await request(t.app)
      .post('/api/v1/timetable')
      .set(auth(s.ownerToken))
      .send({ ...p, sectionId: s.sectionB, room: '5B', startTime: '08:20', endTime: '09:00' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('TIMETABLE_CONFLICT');
    expect(clash.body.error.details.conflicts[0].type).toBe('teacher');
    const ok = await api(t.app, s.ownerToken, 'post', '/timetable', { ...p, startTime: '08:40', endTime: '09:20' });
    expect(ok.startTime).toBe('08:40');
    const check = await api(t.app, s.ownerToken, 'post', '/timetable/check', {
      ...p,
      sectionId: s.sectionB,
      teacherId: null,
      room: '5a',
    });
    expect(check.ok).toBe(false);
    expect(check.conflicts.map((c: any) => c.type)).toEqual(['room']);
  });

  it('validates time ranges and replaces a section timetable atomically', async () => {
    const bad = await request(t.app)
      .post('/api/v1/timetable')
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionB, subjectId: s.mathId, dayOfWeek: 2, startTime: '10:00', endTime: '09:00' });
    expect(bad.status).toBe(400);
    const internal = await request(t.app)
      .put(`/api/v1/timetable/sections/${s.sectionB}`)
      .set(auth(s.ownerToken))
      .send({
        entries: [
          { subjectId: s.mathId, dayOfWeek: 3, startTime: '08:00', endTime: '08:40' },
          { subjectId: s.englishId, dayOfWeek: 3, startTime: '08:30', endTime: '09:10' },
        ],
      });
    expect(internal.status).toBe(409);
    const replaced = await api(t.app, s.ownerToken, 'put', `/timetable/sections/${s.sectionB}`, {
      entries: [
        { subjectId: s.mathId, dayOfWeek: 3, startTime: '08:00', endTime: '08:40' },
        { subjectId: s.englishId, dayOfWeek: 3, startTime: '08:40', endTime: '09:20' },
      ],
    });
    expect(replaced).toHaveLength(2);
  });

  it('gives teachers their own timetable and parents their child’s', async () => {
    const mine = await api(t.app, s.teacherToken, 'get', '/timetable');
    expect(mine.length).toBe(2);
    const child = await api(t.app, s.parentToken, 'get', '/timetable');
    expect(child.every((e: any) => (e.sectionId._id ?? e.sectionId) === s.sectionA)).toBe(true);
    const write = await request(t.app)
      .post('/api/v1/timetable')
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, subjectId: s.mathId, dayOfWeek: 5, startTime: '08:00', endTime: '08:40' });
    expect(write.status).toBe(403);
  });
});
