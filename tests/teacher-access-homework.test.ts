import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { TeachingAssignment } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Homework } from '../src/modules/homework/homework.models';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let ayeshaId: string; // class teacher of A, teaches Maths in A
let bilalId: string; // teacher with no classes
const today = todayInTz('Asia/Karachi');
const day = (n: number) => formatDateOnly(addDays(parseDateOnly(today), n));

const call = (token: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: unknown) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

describe('Teachers only reach their assigned classes', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
    other = await buildSchool(t.app, { students: 1 });
    ayeshaId = s.teacherEmployeeId;
    bilalId = (await api(t.app, s.otherTeacherToken, 'get', '/auth/me')).user.employeeId;
  });

  it('lists only students of the teacher’s own sections, even with a foreign sectionId filter', async () => {
    const mine = await api(t.app, s.teacherToken, 'get', '/students?limit=100');
    expect(mine.length).toBe(2);
    expect(mine.every((st: any) => (st.sectionId._id ?? st.sectionId) === s.sectionA)).toBe(true);
    const tricked = await api(t.app, s.teacherToken, 'get', `/students?sectionId=${s.sectionB}`);
    expect(tricked).toEqual([]);
    const none = await api(t.app, s.otherTeacherToken, 'get', '/students');
    expect(none).toEqual([]);
  });

  it('hides students and records of other sections by id (404, not 403)', async () => {
    const studentB = s.students[3];
    expect((await call(s.teacherToken, 'get', `/students/${studentB}`)).status).toBe(404);
    expect((await call(s.teacherToken, 'get', `/students/${studentB}/overview`)).status).toBe(404);
    expect(
      (await call(s.teacherToken, 'get', `/attendance/students/${studentB}?from=${day(-7)}&to=${today}`)).status,
    ).toBe(404);
    expect((await call(s.otherTeacherToken, 'get', `/students/${s.students[0]}`)).status).toBe(404);
  });

  it('does not show fee balances to teachers', async () => {
    const ov = await api(t.app, s.teacherToken, 'get', `/students/${s.students[0]}/overview`);
    expect(ov.fees).toBeNull();
  });

  it('blocks attendance, timetable and marks for unassigned sections', async () => {
    const roster = await call(s.otherTeacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${today}`);
    expect(roster.status).toBe(403);
    const mark = await call(s.otherTeacherToken, 'post', '/attendance/mark', {
      sectionId: s.sectionA,
      date: today,
      records: [{ studentId: s.students[0], status: 'present' }],
    });
    expect(mark.status).toBe(403);
    expect((await call(s.teacherToken, 'get', `/timetable?sectionId=${s.sectionB}`)).status).toBe(403);
    expect((await call(s.teacherToken, 'get', `/timetable?teacherId=${bilalId}`)).status).toBe(403);
    expect((await call(s.teacherToken, 'get', `/timetable/teacher-load?sessionId=${s.sessionId}`)).status).toBe(403);
    expect((await call(s.parentToken, 'get', `/timetable/teacher-load?sessionId=${s.sessionId}`)).status).toBe(403);
  });

  it('keeps teachers out of other schools entirely', async () => {
    expect((await call(s.teacherToken, 'get', `/students/${other.students[0]}`)).status).toBe(404);
  });
});

describe('Substitute teachers', () => {
  let coverId: string;

  it('validates the cover before saving it', async () => {
    const base = {
      originalTeacherId: ayeshaId,
      substituteTeacherId: bilalId,
      sectionId: s.sectionA,
      subjectId: s.mathId,
    };
    const bad = [
      { ...base, startDate: day(2), endDate: day(1) }, // end before start
      { ...base, substituteTeacherId: ayeshaId, startDate: today, endDate: today }, // same person
      { ...base, startDate: day(-30), endDate: day(-20) }, // already over
      { ...base, subjectId: s.englishId, startDate: today, endDate: today }, // Ayesha does not teach English... but is class teacher
      { ...base, startDate: today, endDate: day(90) }, // too long
    ];
    const statuses = [];
    for (const b of bad) statuses.push((await call(s.ownerToken, 'post', '/substitutes', b)).status);
    // English is allowed because Ayesha is the class teacher of A; everything else is refused.
    expect(statuses).toEqual([400, 400, 400, 201, 400]);
    const created = (await api(t.app, s.ownerToken, 'get', '/substitutes?state=active'))[0];
    await api(t.app, s.ownerToken, 'post', `/substitutes/${created._id}/cancel`, { reason: 'test cleanup' });
    // A teacher from another school can never cover.
    const foreignTeacher = (await api(t.app, other.teacherToken, 'get', '/auth/me')).user.employeeId;
    const foreign = await call(s.ownerToken, 'post', '/substitutes', {
      ...base,
      substituteTeacherId: foreignTeacher,
      startDate: today,
      endDate: today,
    });
    expect(foreign.status).toBe(400);
  });

  it('gives the substitute exactly the covered work for the covered dates', async () => {
    const cover = await api(t.app, s.ownerToken, 'post', '/substitutes', {
      originalTeacherId: ayeshaId,
      substituteTeacherId: bilalId,
      sectionId: s.sectionA,
      subjectId: s.mathId,
      startDate: today,
      endDate: day(1),
      reason: 'Sick leave',
    });
    coverId = cover._id;
    expect(cover.state).toBe('current');
    expect(cover.capabilities).toEqual(['attendance', 'homework']);

    // Can see the class and take attendance.
    expect((await api(t.app, s.otherTeacherToken, 'get', '/students')).length).toBe(2);
    const mark = await api(t.app, s.otherTeacherToken, 'post', '/attendance/mark', {
      sectionId: s.sectionA,
      date: today,
      records: [{ studentId: s.students[0], status: 'present' }],
    });
    expect(mark.saved).toBe(1);
    // Can set Maths homework in A, attributed to the substitute who set it.
    const hw = await api(t.app, s.otherTeacherToken, 'post', '/homework', {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      title: 'Cover work: tables',
      description: 'Learn table of 7',
      dueDate: day(1),
    });
    expect(hw.teacher.name).toContain('Bilal');
    expect(hw.createdViaSubstituteId).toBe(coverId);
    // But not English, not section B, and not marks (capability not granted).
    expect(
      (
        await call(s.otherTeacherToken, 'post', '/homework', {
          sectionId: s.sectionA,
          subjectId: s.englishId,
          title: 'Not allowed',
          description: 'Nope',
          dueDate: day(1),
        })
      ).status,
    ).toBe(403);
    expect((await call(s.otherTeacherToken, 'get', `/attendance/sections/${s.sectionB}?date=${today}`)).status).toBe(
      403,
    );
    const exam = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Cover test exam',
      classIds: [s.classId],
    });
    const [paper] = await api(t.app, s.ownerToken, 'put', `/exams/${exam._id}/papers`, {
      papers: [{ classId: s.classId, subjectId: s.mathId, maxMarks: 50, passMarks: 20 }],
    });
    expect(
      (await call(s.otherTeacherToken, 'get', `/exams/${exam._id}/papers/${paper._id}/marks?sectionId=${s.sectionA}`))
        .status,
    ).toBe(403);

    // The original assignment is untouched and the action is attributed in the audit log.
    const ta = await TeachingAssignment.findOne({
      schoolId: s.schoolId,
      sectionId: s.sectionA,
      subjectId: s.mathId,
    }).lean();
    expect(String(ta!.teacherId)).toBe(ayeshaId);
    const log = await AuditLog.findOne({
      schoolId: s.schoolId,
      action: 'attendance.mark',
      'metadata.viaSubstitute': coverId,
    }).lean();
    expect(log).toBeTruthy();
  });

  it('rejects overlapping covers for the same class', async () => {
    const res = await call(s.ownerToken, 'post', '/substitutes', {
      originalTeacherId: ayeshaId,
      substituteTeacherId: bilalId,
      sectionId: s.sectionA,
      startDate: day(1),
      endDate: day(3),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSTITUTE_CONFLICT');
  });

  it('ends access as soon as the cover is cancelled, and does not start before its dates', async () => {
    await api(t.app, s.ownerToken, 'post', `/substitutes/${coverId}/cancel`, { reason: 'Teacher returned' });
    expect(await api(t.app, s.otherTeacherToken, 'get', '/students')).toEqual([]);
    expect((await call(s.otherTeacherToken, 'get', `/attendance/sections/${s.sectionA}?date=${today}`)).status).toBe(
      403,
    );
    // Bilal set homework while covering; after the cover he can no longer change it.
    const hw = await Homework.findOne({ schoolId: s.schoolId, title: 'Cover work: tables' }).lean();
    expect((await call(s.otherTeacherToken, 'patch', `/homework/${hw!._id}`, { title: 'Changed later' })).status).toBe(
      404,
    );

    const future = await api(t.app, s.ownerToken, 'post', '/substitutes', {
      originalTeacherId: ayeshaId,
      substituteTeacherId: bilalId,
      sectionId: s.sectionA,
      startDate: day(5),
      endDate: day(6),
      capabilities: ['attendance'],
    });
    expect(future.state).toBe('upcoming');
    expect(await api(t.app, s.otherTeacherToken, 'get', '/students')).toEqual([]);
    const mine = await api(t.app, s.otherTeacherToken, 'get', '/substitutes/mine');
    expect(mine.map((c: any) => c._id)).toContain(future._id);
    await api(t.app, s.ownerToken, 'post', `/substitutes/${future._id}/cancel`, {});
  });

  it('is managed only by authorised staff and stays inside the school', async () => {
    expect((await call(s.teacherToken, 'get', '/substitutes')).status).toBe(403);
    expect((await call(s.accountantToken, 'post', '/substitutes', {})).status).toBe(403);
    expect((await call(other.ownerToken, 'post', `/substitutes/${coverId}/cancel`, {})).status).toBe(404);
  });
});

describe('Homework teacher attribution (bug fix)', () => {
  let unassignedHw: string;

  it('A: uses the assigned subject teacher when an administrator sets homework', async () => {
    const hw = await api(t.app, s.ownerToken, 'post', '/homework', {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      title: 'Admin set maths',
      description: 'Exercise 3.1',
      dueDate: day(2),
      maxMarks: 2,
    });
    expect(hw.teacherSource).toBe('assignment');
    expect(hw.teacher.name).toBe('Ayesha Khan');
    const detail = await api(t.app, s.ownerToken, 'get', `/homework/${hw._id}`);
    expect(detail.teacher.name).toBe('Ayesha Khan');
    expect(detail.teacherStatus).toBe('attributed');
  });

  it('B: refuses to silently save without a teacher, and offers explicit choices', async () => {
    const body = {
      sectionId: s.sectionB,
      subjectId: s.englishId,
      title: 'Essay',
      description: 'My school',
      dueDate: day(2),
    };
    const res = await call(s.ownerToken, 'post', '/homework', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('TEACHER_NOT_ASSIGNED');
    const preview = await api(
      t.app,
      s.ownerToken,
      'get',
      `/homework/teacher-preview?sectionId=${s.sectionB}&subjectId=${s.englishId}`,
    );
    expect(preview.subjectTeacher).toBeNull();
    // An explicitly chosen teacher must teach that class-subject.
    const wrong = await call(s.ownerToken, 'post', '/homework', { ...body, teacherId: bilalId });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('TEACHER_NOT_ELIGIBLE');
    const saved = await api(t.app, s.ownerToken, 'post', '/homework', { ...body, allowUnassigned: true });
    expect(saved.teacher).toBeNull();
    expect(saved.teacherStatus).toBe('unassigned');
    unassignedHw = saved._id;
  });

  it('C: shows the teacher once the class-subject gets one (no stale "—")', async () => {
    await api(t.app, s.ownerToken, 'post', '/academics/teaching-assignments', {
      sectionId: s.sectionB,
      subjectId: s.englishId,
      teacherId: bilalId,
    });
    const detail = await api(t.app, s.ownerToken, 'get', `/homework/${unassignedHw}`);
    expect(detail.teacher.name).toContain('Bilal');
    expect(detail.teacherSource).toBe('backfill');
    const list = await api(t.app, s.ownerToken, 'get', `/homework?sectionId=${s.sectionB}`);
    expect(list.find((h: any) => h._id === unassignedHw).teacher.name).toContain('Bilal');
  });

  it('D: keeps historical attribution when the subject teacher changes', async () => {
    const hw = await api(t.app, s.ownerToken, 'post', '/homework', {
      sectionId: s.sectionB,
      subjectId: s.englishId,
      title: 'Before change',
      description: 'Read chapter 1',
      dueDate: day(2),
    });
    expect(hw.teacher.name).toContain('Bilal');
    const ta = await TeachingAssignment.findOne({
      schoolId: s.schoolId,
      sectionId: s.sectionB,
      subjectId: s.englishId,
    }).lean();
    await api(t.app, s.ownerToken, 'patch', `/academics/teaching-assignments/${ta!._id}`, { teacherId: ayeshaId });
    const detail = await api(t.app, s.ownerToken, 'get', `/homework/${hw._id}`);
    expect(detail.teacher.name).toContain('Bilal');
    expect(detail.currentSubjectTeacher.name).toBe('Ayesha Khan');
    // Access follows the current assignment: the new teacher can grade, the old one cannot.
    expect((await call(s.teacherToken, 'get', `/homework/${hw._id}/submissions`)).status).toBe(200);
    expect((await call(s.otherTeacherToken, 'get', `/homework/${hw._id}/submissions`)).status).toBe(404);
  });

  it('refuses a second teacher for the same class-subject (no arbitrary choice)', async () => {
    const res = await call(s.ownerToken, 'post', '/academics/teaching-assignments', {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      teacherId: bilalId,
    });
    expect(res.status).toBe(409);
  });

  it('resolves legacy homework that has no teacher recorded', async () => {
    const legacy = await Homework.create({
      schoolId: s.schoolId,
      sessionId: s.sessionId,
      campusId: s.campusId,
      sectionId: s.sectionA,
      subjectId: s.mathId,
      createdBy: (await api(t.app, s.ownerToken, 'get', '/auth/me')).user._id,
      title: 'Old record',
      description: 'Created before the fix',
      assignedOn: parseDateOnly(today),
      dueDate: parseDateOnly(day(1)),
    });
    const detail = await api(t.app, s.ownerToken, 'get', `/homework/${legacy._id}`);
    expect(detail.teacher.name).toBe('Ayesha Khan');
    expect(detail.teacherStatus).toBe('from_current_assignment');
  });

  it('lets only teachers of that class-subject see or grade it', async () => {
    const maths = await Homework.findOne({ schoolId: s.schoolId, title: 'Admin set maths' }).lean();
    // Bilal now teaches nothing in A: he cannot see or grade A's maths homework.
    expect((await call(s.otherTeacherToken, 'get', `/homework/${maths!._id}`)).status).toBe(404);
    expect((await call(s.otherTeacherToken, 'get', `/homework/${maths!._id}/submissions`)).status).toBe(404);
    const list = await api(t.app, s.otherTeacherToken, 'get', '/homework?due=all');
    expect(list.find((h: any) => h._id === String(maths!._id))).toBeUndefined();
    // Teachers cannot re-attribute homework.
    expect((await call(s.teacherToken, 'patch', `/homework/${maths!._id}`, { teacherId: bilalId })).status).toBe(403);
  });
});
