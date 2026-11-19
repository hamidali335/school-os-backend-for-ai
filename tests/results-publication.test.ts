import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { Exam } from '../src/modules/examinations/exam.models';
import { computeStudentResult } from '../src/modules/examinations/result-calc';
import { DEFAULT_GRADING_SCALE } from '../src/modules/schools/school.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let examId: string;
let mathPaper: string;
let engPaper: string;
let artPaper: string;
let artSubject: string;

const enter = (token: string, paper: string, sectionId: string, marks: unknown[]) =>
  api(t.app, token, 'post', `/exams/${examId}/papers/${paper}/marks`, { sectionId, marks });

describe('Elective papers (pure)', () => {
  const papers = [
    { paperId: 'm', subjectId: 'm', subjectName: 'Maths', maxMarks: 100, passMarks: 33 },
    { paperId: 'a', subjectId: 'a', subjectName: 'Art', maxMarks: 50, passMarks: 17, optional: true },
  ];

  it('leaves an elective recorded as Not taken out of the totals', () => {
    const r = computeStudentResult(
      papers,
      [
        { paperId: 'm', obtained: 70 },
        { paperId: 'a', notTaken: true },
      ],
      DEFAULT_GRADING_SCALE,
      40,
    );
    expect(r.incomplete).toBe(false);
    expect(r.totalMax).toBe(100);
    expect(r.percentage).toBe(70);
    expect(r.subjects.find((x) => x.subject === 'Art')?.notTaken).toBe(true);
  });

  it('never assumes a blank elective is not taken: the result is incomplete', () => {
    const r = computeStudentResult(papers, [{ paperId: 'm', obtained: 70 }], DEFAULT_GRADING_SCALE, 40);
    expect(r.incomplete).toBe(true);
    expect(r.subjects.find((x) => x.subject === 'Art')?.notTaken).toBeUndefined();
    // A missing compulsory mark makes the result incomplete, as before.
    expect(computeStudentResult(papers, [{ paperId: 'a', obtained: 40 }], DEFAULT_GRADING_SCALE, 40).incomplete).toBe(
      true,
    );
    // "Not taken" on a subject that is not elective (any more) is a missing mark.
    const compulsory = papers.map((p) => ({ ...p, optional: false }));
    expect(
      computeStudentResult(
        compulsory,
        [
          { paperId: 'm', obtained: 70 },
          { paperId: 'a', notTaken: true },
        ],
        DEFAULT_GRADING_SCALE,
        40,
      ).incomplete,
    ).toBe(true);
  });

  it('results published before Not taken existed are shown as they were published', () => {
    const r = computeStudentResult(papers, [{ paperId: 'm', obtained: 70 }], DEFAULT_GRADING_SCALE, 40, {
      blankElectiveNotTaken: true,
    });
    expect(r.incomplete).toBe(false);
    expect(r.subjects.find((x) => x.subject === 'Art')?.notTaken).toBe(true);
  });
});

describe('Publishing results: drafts allowed, incomplete results blocked', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
    other = await buildSchool(t.app, { students: 1 });
    const art = await api(t.app, s.ownerToken, 'post', '/academics/subjects', {
      name: 'Art',
      code: 'ART',
      classIds: [s.classId],
      isElective: true,
    });
    artSubject = art._id;
    const exam = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Final Term 2026',
      term: 'final_term',
      classIds: [s.classId],
    });
    examId = exam._id;
    const papers = await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, {
      papers: [
        { classId: s.classId, subjectId: s.mathId, maxMarks: 100, passMarks: 33 },
        { classId: s.classId, subjectId: s.englishId, maxMarks: 75, passMarks: 25 },
        { classId: s.classId, subjectId: art._id, maxMarks: 50, passMarks: 17 },
      ],
    });
    const id = (subjectId: string) => papers.find((p: any) => p.subjectId._id === subjectId)._id;
    mathPaper = id(s.mathId);
    engPaper = id(s.englishId);
    artPaper = id(art._id);
  });

  it('saves a partial draft and refuses to publish, naming the class, section, subject and students', async () => {
    // Teacher saves only one of the two students in section A: a draft.
    await enter(s.teacherToken, mathPaper, s.sectionA, [{ studentId: s.students[0], obtained: 80 }]);
    const check = await api(t.app, s.principalToken, 'get', `/exams/${examId}/publish-check`);
    expect(check.ready).toBe(false);
    const mathA = check.groups.find((g: any) => g.paperId === mathPaper && g.sectionId === s.sectionA);
    expect(mathA.missingCount).toBe(1);
    expect(mathA.missing.map((m: any) => m.studentId)).toEqual([s.students[1]]);
    expect(mathA.className).toBeTruthy();
    expect(check.message).toMatch(/^Result cannot be published\. Marks or an approved status are missing/);
    // A blank elective blocks too (nobody recorded that these students do not take Art).
    expect(check.groups.some((g: any) => g.paperId === artPaper)).toBe(true);
    expect(check.electiveGaps.length).toBeGreaterThan(0);
    expect(check.message).toMatch(/mark a student who does not take the subject as Not taken/);

    const res = await request(t.app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(auth(s.principalToken))
      .send({ notifyParents: false });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('RESULTS_INCOMPLETE');
    expect(res.body.error.details.groups.length).toBeGreaterThan(0);
    const exam = await api(t.app, s.principalToken, 'get', `/exams/${examId}`);
    expect(exam.status).not.toBe('published');
  });

  it('never treats a blank as zero or absent: a row without marks or Absent is rejected', async () => {
    const blank = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[1] }] });
    expect(blank.status).toBe(400);
    const negative = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[1], obtained: -1 }] });
    expect(negative.status).toBe(400);
    // "Not taken" only for an elective, and never together with marks.
    const compulsory = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[1], notTaken: true }] });
    expect(compulsory.status).toBe(400);
    expect(compulsory.body.error.code).toBe('NOT_ELECTIVE');
    const both = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${artPaper}/marks`)
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[1], notTaken: true, obtained: 20 }] });
    expect(both.status).toBe(400);
  });

  it('publishes once every student has marks, Absent, or (elective) Not taken — recorded and audited', async () => {
    await enter(s.ownerToken, mathPaper, s.sectionA, [{ studentId: s.students[1], isAbsent: true }]);
    await enter(s.ownerToken, engPaper, s.sectionA, [
      { studentId: s.students[0], obtained: 60 },
      { studentId: s.students[1], obtained: 30 },
    ]);
    await enter(s.ownerToken, artPaper, s.sectionA, [{ studentId: s.students[0], obtained: 45 }]);
    for (const paper of [mathPaper, engPaper])
      await enter(s.ownerToken, paper, s.sectionB, [
        { studentId: s.students[2], obtained: 50 },
        { studentId: s.students[3], obtained: 40 },
      ]);
    // Still blocked: Art is blank for the students who do not take it.
    const blocked = await api(t.app, s.principalToken, 'get', `/exams/${examId}/publish-check`);
    expect(blocked.ready).toBe(false);
    expect(
      blocked.groups.map((g: any) => [g.paperId, g.missingCount]).filter(([p]: [string]) => p === artPaper),
    ).toEqual([
      [artPaper, 1],
      [artPaper, 2],
    ]);
    await enter(s.ownerToken, artPaper, s.sectionA, [{ studentId: s.students[1], notTaken: true }]);
    await enter(s.ownerToken, artPaper, s.sectionB, [
      { studentId: s.students[2], notTaken: true },
      { studentId: s.students[3], obtained: 30 },
    ]);
    const roster = await api(
      t.app,
      s.ownerToken,
      'get',
      `/exams/${examId}/papers/${artPaper}/marks?sectionId=${s.sectionA}`,
    );
    expect(roster.paper.isElective).toBe(true);
    expect(roster.students.find((x: any) => x.studentId === s.students[1])).toMatchObject({
      notTaken: true,
      obtained: null,
      isAbsent: false,
    });
    const logged = await AuditLog.findOne({
      schoolId: s.schoolId,
      action: 'marks.enter',
      'metadata.notTaken': s.students[1],
    }).lean();
    expect(logged).toBeTruthy();
    const check = await api(t.app, s.principalToken, 'get', `/exams/${examId}/publish-check`);
    expect(check.ready).toBe(true);
    expect(check.electiveGaps).toEqual([]);
    expect(check.message).toBe('All marks are complete. The result can be published.');
  });

  it('builds a draft result card with totals that match the marks (checked by hand)', async () => {
    const card = await api(t.app, s.ownerToken, 'get', `/exams/${examId}/result-cards/${s.students[0]}`);
    expect(card.published).toBe(false);
    // Maths 80/100 + English 60/75 + Art 45/50 = 185/225 = 82.22%
    expect(card.result.totalObtained).toBe(185);
    expect(card.result.totalMax).toBe(225);
    expect(card.result.percentage).toBe(82.22);
    expect(card.result.grade).toBe('A');
    expect(card.result.passed).toBe(true);
    expect(card.student.className).toBeTruthy();
    expect(card.student.sectionName).toBeTruthy();
    expect(card.session.name).toBeTruthy();
    expect(card.attendance).toHaveProperty('rate');

    // Student 1: absent in Maths (0/100, below pass), English 30/75, Art not taken.
    const absent = await api(t.app, s.ownerToken, 'get', `/exams/${examId}/result-cards/${s.students[1]}`);
    const maths = absent.result.subjects.find((x: any) => x.paperId === mathPaper);
    expect(maths.isAbsent).toBe(true);
    expect(maths.obtained).toBe(0);
    expect(absent.result.subjects.find((x: any) => x.paperId === artPaper).notTaken).toBe(true);
    expect(absent.result.totalObtained).toBe(30);
    expect(absent.result.totalMax).toBe(175);
    expect(absent.result.percentage).toBe(17.14);
    expect(absent.result.passed).toBe(false);
    expect(absent.result.incomplete).toBe(false);
  });

  it('hides unpublished result cards from families, then shows them after publishing', async () => {
    const hidden = await request(t.app)
      .get(`/api/v1/exams/${examId}/result-cards/${s.students[0]}`)
      .set(auth(s.parentToken));
    expect(hidden.status).toBe(404);
    await api(t.app, s.principalToken, 'post', `/exams/${examId}/publish`, { notifyParents: false });
    const card = await api(t.app, s.parentToken, 'get', `/exams/${examId}/result-cards/${s.students[0]}`);
    expect(card.published).toBe(true);
    const pdf = await request(t.app)
      .get(`/api/v1/exams/${examId}/result-cards/${s.students[0]}/pdf`)
      .set(auth(s.parentToken));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('prints a whole section in one PDF for staff, never for families or other schools', async () => {
    const all = await request(t.app)
      .get(`/api/v1/exams/${examId}/section-result-cards.pdf?sectionId=${s.sectionA}`)
      .set(auth(s.principalToken));
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toContain('application/pdf');
    const family = await request(t.app)
      .get(`/api/v1/exams/${examId}/section-result-cards.pdf?sectionId=${s.sectionA}`)
      .set(auth(s.parentToken));
    expect(family.status).toBe(403);
    const foreign = await request(t.app)
      .get(`/api/v1/exams/${examId}/result-cards/${s.students[0]}`)
      .set(auth(other.ownerToken));
    expect(foreign.status).toBe(404);
  });

  it('an exam published before Not taken existed still shows its blank electives as not taken', async () => {
    // As stored by the earlier version: published, with Art left blank for a student.
    const legacy = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Mid Term 2025',
      term: 'mid_term',
      classIds: [s.classId],
    });
    const papers = await api(t.app, s.ownerToken, 'put', `/exams/${legacy._id}/papers`, {
      papers: [
        { classId: s.classId, subjectId: s.mathId, maxMarks: 100, passMarks: 33 },
        { classId: s.classId, subjectId: artSubject, maxMarks: 50, passMarks: 17 },
      ],
    });
    const maths = papers.find((p: any) => p.subjectId._id === s.mathId)._id;
    await api(t.app, s.ownerToken, 'post', `/exams/${legacy._id}/papers/${maths}/marks`, {
      sectionId: s.sectionA,
      marks: [
        { studentId: s.students[0], obtained: 70 },
        { studentId: s.students[1], obtained: 50 },
      ],
    });
    await Exam.updateOne(
      { schoolId: s.schoolId, _id: legacy._id },
      { $set: { status: 'published', publishedAt: new Date('2025-11-01') } },
    );
    const card = await api(t.app, s.ownerToken, 'get', `/exams/${legacy._id}/result-cards/${s.students[0]}`);
    expect(card.result.incomplete).toBe(false);
    expect(card.result.subjects.find((x: any) => x.subject === 'Art').notTaken).toBe(true);
    expect(card.result.percentage).toBe(70);
  });
});
