import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ExamPaper, Mark } from '../src/modules/examinations/exam.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createTestSchool, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

const call = (token: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

describe('Exam date sheet editing', () => {
  let examId: string;
  let version: number;
  const paper = (subjectId: string, extra: Record<string, unknown> = {}) => ({
    classId: s.classId,
    subjectId,
    maxMarks: 100,
    passMarks: 33,
    ...extra,
  });

  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 2 });
    const exam = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Mid-Term 2026',
      startDate: '2026-09-14',
      endDate: '2026-09-25',
      classIds: [s.classId],
    });
    examId = exam._id;
  });

  it('saves papers with schedule, never duplicating them on repeated saves', async () => {
    const body = {
      papers: [
        paper(s.mathId, { date: '2026-09-14', startTime: '09:00', durationMinutes: 120 }),
        paper(s.englishId, { date: '2026-09-15', startTime: '09:00', durationMinutes: 90 }),
      ],
    };
    await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, body);
    const saved = await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, body);
    expect(saved).toHaveLength(2);
    expect(await ExamPaper.countDocuments({ schoolId: s.schoolId, examId })).toBe(2);
    const detail = await api(t.app, s.ownerToken, 'get', `/exams/${examId}`);
    expect(detail.papers.map((p: any) => p.subjectId.name).sort()).toEqual(['English', 'Mathematics']);
    expect(detail.papers[0].marksCount).toBe(0);
    version = detail.datesheetVersion;
    expect(version).toBe(2);
  });

  it('really clears a date, time or duration that is removed', async () => {
    await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, {
      expectedVersion: version,
      papers: [
        paper(s.mathId, { date: '2026-09-14', startTime: '09:00', durationMinutes: 120 }),
        paper(s.englishId, { date: null, startTime: null }),
      ],
    });
    version++;
    const eng = await ExamPaper.findOne({ schoolId: s.schoolId, examId, subjectId: s.englishId }).lean();
    expect(eng!.date).toBeUndefined();
    expect(eng!.startTime).toBeUndefined();
    expect(eng!.durationMinutes).toBeUndefined();
  });

  it('validates marks, dates and durations', async () => {
    const bad = async (p: Record<string, unknown>) =>
      (await call(s.ownerToken, 'put', `/exams/${examId}/papers`, { papers: [paper(s.mathId, p), paper(s.englishId)] }))
        .status;
    expect(await bad({ passMarks: 120 })).toBe(400); // pass > max
    expect(await bad({ maxMarks: 0 })).toBe(400);
    expect(await bad({ durationMinutes: -5 })).toBe(400);
    expect(await bad({ startTime: '25:00' })).toBe(400);
    expect(await bad({ date: '2026-02-30' })).toBe(400);
    expect(await bad({ date: '2026-10-30' })).toBe(400); // after the exam ends
  });

  it('detects a concurrent edit instead of overwriting it', async () => {
    const res = await call(s.ownerToken, 'put', `/exams/${examId}/papers`, {
      expectedVersion: version - 1,
      papers: [paper(s.mathId), paper(s.englishId)],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_DATE_SHEET');
  });

  it('never removes a paper that has marks, nor lowers max marks below a mark', async () => {
    const maths = await ExamPaper.findOne({ schoolId: s.schoolId, examId, subjectId: s.mathId }).lean();
    await api(t.app, s.teacherToken, 'post', `/exams/${examId}/papers/${maths!._id}/marks`, {
      sectionId: s.sectionA,
      marks: [{ studentId: s.students[0], obtained: 80 }],
    });
    const removed = await call(s.ownerToken, 'put', `/exams/${examId}/papers`, { papers: [paper(s.englishId)] });
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('PAPER_HAS_MARKS');
    expect(removed.body.error.details[0]).toMatchObject({ subject: 'Mathematics', marks: 1 });
    const lowered = await call(s.ownerToken, 'put', `/exams/${examId}/papers`, {
      papers: [paper(s.mathId, { maxMarks: 50, passMarks: 20 }), paper(s.englishId)],
    });
    expect(lowered.status).toBe(409);
    expect(lowered.body.error.code).toBe('MAX_BELOW_ENTERED_MARKS');
    expect(await Mark.countDocuments({ schoolId: s.schoolId, examId })).toBe(1);
    const detail = await api(t.app, s.ownerToken, 'get', `/exams/${examId}`);
    expect(detail.papers.find((p: any) => p.subjectId.name === 'Mathematics').marksCount).toBe(1);
    // Removing a paper without marks still works.
    await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, { papers: [paper(s.mathId)] });
    expect(await ExamPaper.countDocuments({ schoolId: s.schoolId, examId })).toBe(1);
  });

  it('requires unpublishing before changing papers, then allows edit and republish', async () => {
    // Publishing needs marks or Absent for every student: the section B student was absent.
    const absentFor = async (subjectId: string, entries: Array<[string, string]>) => {
      const ex = await api(t.app, s.ownerToken, 'get', `/exams/${examId}`);
      const pp = ex.papers.find((x: any) => (x.subjectId._id ?? x.subjectId) === subjectId);
      for (const [sectionId, studentId] of entries)
        await api(t.app, s.ownerToken, 'post', `/exams/${examId}/papers/${pp._id}/marks`, {
          sectionId,
          marks: [{ studentId, isAbsent: true }],
        });
    };
    await absentFor(s.mathId, [[s.sectionB, s.students[1]]]);
    await api(t.app, s.ownerToken, 'post', `/exams/${examId}/publish`, { notifyParents: false });
    const blocked = await call(s.ownerToken, 'put', `/exams/${examId}/papers`, {
      papers: [paper(s.mathId), paper(s.englishId)],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('EXAM_PUBLISHED');
    // Only results:publish holders can withdraw results.
    expect((await call(s.adminToken, 'post', `/exams/${examId}/unpublish`)).status).toBe(403);
    await api(t.app, s.ownerToken, 'post', `/exams/${examId}/unpublish`);
    await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, { papers: [paper(s.mathId), paper(s.englishId)] });
    // The new English paper has no marks yet, so publishing again is refused until it does.
    expect((await call(s.ownerToken, 'post', `/exams/${examId}/publish`, { notifyParents: false })).status).toBe(422);
    await absentFor(s.englishId, [
      [s.sectionA, s.students[0]],
      [s.sectionB, s.students[1]],
    ]);
    await api(t.app, s.ownerToken, 'post', `/exams/${examId}/publish`, { notifyParents: false });
    // Editing the date sheet never removed a mark: 2 Maths entries plus the 2 English ones.
    expect(await Mark.countDocuments({ schoolId: s.schoolId, examId })).toBe(4);
    const actions = (await AuditLog.find({ schoolId: s.schoolId, entityId: examId }).lean()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['exam.papers_set', 'exam.results_published', 'exam.results_unpublished']),
    );
  });

  it('rejects exam dates where the end comes before the start', async () => {
    expect((await call(s.ownerToken, 'patch', `/exams/${examId}`, { endDate: '2026-09-01' })).status).toBe(400);
  });
});

describe('School setup guide', () => {
  it('starts a brand-new school at the beginning and tracks real data, not page visits', async () => {
    const fresh = await createTestSchool(t.app);
    const g = await api(t.app, fresh.ownerToken, 'get', '/onboarding');
    expect(g.summary.requiredDone).toBe(0);
    expect(g.summary.requiredTotal).toBeGreaterThanOrEqual(7);
    expect(g.steps.find((x: any) => x.key === 'sections').status).toBe('blocked');
    expect(g.summary.nextStep).toBe('school_profile');

    // Opening the classes page does not complete the classes step.
    await api(t.app, fresh.ownerToken, 'get', '/academics/classes');
    expect(
      (await api(t.app, fresh.ownerToken, 'get', '/onboarding')).steps.find((x: any) => x.key === 'classes').status,
    ).toBe('incomplete');

    // Doing the work anywhere (here: the normal API) completes it.
    await api(t.app, fresh.ownerToken, 'post', '/academics/classes', {
      campusId: fresh.campusId,
      name: 'Class 1',
      level: 1,
    });
    const after = await api(t.app, fresh.ownerToken, 'get', '/onboarding');
    const classes = after.steps.find((x: any) => x.key === 'classes');
    expect(classes.status).toBe('complete');
    expect(classes.completedAt).toBeTruthy();
  });

  it('completes a step as soon as its page is opened, without waiting for the work', async () => {
    const fresh = await createTestSchool(t.app);
    const other = await createTestSchool(t.app);
    const visited = await api(t.app, fresh.ownerToken, 'post', '/onboarding/steps/staff/visit');
    const staff = visited.steps.find((x: any) => x.key === 'staff');
    expect(staff.status).toBe('complete');
    expect(staff.completedAt).toBeTruthy();
    // Visiting again is harmless, and other schools are unaffected.
    await api(t.app, fresh.ownerToken, 'post', '/onboarding/steps/staff/visit');
    const theirs = await api(t.app, other.ownerToken, 'get', '/onboarding');
    expect(theirs.steps.find((x: any) => x.key === 'staff').status).not.toBe('complete');
    // Unknown steps are rejected.
    expect((await call(fresh.ownerToken, 'post', '/onboarding/steps/nope/visit')).status).toBe(400);
  });

  it('shows a fully set-up school as complete and keeps the state per school', async () => {
    const g = await api(t.app, s.ownerToken, 'get', '/onboarding');
    for (const key of ['academic_session', 'classes', 'sections', 'subjects', 'staff', 'students'])
      expect(g.steps.find((x: any) => x.key === key).status).toBe('complete');
    // English in section A has no teacher in this fixture, so assignment progress is partial.
    const ta = g.steps.find((x: any) => x.key === 'teaching_assignments');
    expect(ta.progress.total).toBeGreaterThan(ta.progress.done);
    await api(t.app, s.ownerToken, 'patch', '/onboarding', { minimized: true });
    expect((await api(t.app, s.ownerToken, 'get', '/onboarding')).state.minimized).toBe(true);
    const otherSchool = await createTestSchool(t.app);
    expect((await api(t.app, otherSchool.ownerToken, 'get', '/onboarding')).state.minimized).toBe(false);
  });

  it('marks a step as needing attention when its data disappears', async () => {
    const fresh = await createTestSchool(t.app);
    const cls = await api(t.app, fresh.ownerToken, 'post', '/academics/classes', {
      campusId: fresh.campusId,
      name: 'Prep',
      level: 0,
    });
    await api(t.app, fresh.ownerToken, 'get', '/onboarding');
    await api(t.app, fresh.ownerToken, 'delete', `/academics/classes/${cls._id}`);
    const g = await api(t.app, fresh.ownerToken, 'get', '/onboarding');
    expect(g.steps.find((x: any) => x.key === 'classes').status).toBe('attention');
  });

  it('supports dismiss/resume and manual review steps, for the Admin only', async () => {
    const d = await api(t.app, s.ownerToken, 'patch', '/onboarding', { dismissed: true });
    expect(d.state.dismissed).toBe(true);
    const r = await api(t.app, s.ownerToken, 'patch', '/onboarding', { dismissed: false });
    expect(r.state).toMatchObject({ dismissed: false, minimized: false });
    const ack = await api(t.app, s.ownerToken, 'post', '/onboarding/steps/review_modules/acknowledge', {
      acknowledged: true,
    });
    expect(ack.steps.find((x: any) => x.key === 'review_modules').status).toBe('complete');
    expect(
      (await call(s.ownerToken, 'post', '/onboarding/steps/classes/acknowledge', { acknowledged: true })).status,
    ).toBe(400);
    expect((await call(s.teacherToken, 'get', '/onboarding')).status).toBe(403);
    expect((await call(s.parentToken, 'patch', '/onboarding', { dismissed: true })).status).toBe(403);
  });
});
