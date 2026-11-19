import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { assignPositions, computeStudentResult, gradeFor } from '../src/modules/examinations/result-calc';
import { DEFAULT_GRADING_SCALE } from '../src/modules/schools/school.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let examId: string;
let mathPaper: string;
let engPaper: string;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 4 });
});

describe('Result calculation (pure)', () => {
  const papers = [
    { paperId: 'p1', subjectId: 'm', subjectName: 'Maths', maxMarks: 100, passMarks: 33 },
    { paperId: 'p2', subjectId: 'e', subjectName: 'English', maxMarks: 50, passMarks: 17 },
  ];
  it('computes totals, percentage, grade and pass/fail', () => {
    const r = computeStudentResult(
      papers,
      [
        { paperId: 'p1', obtained: 85 },
        { paperId: 'p2', obtained: 40 },
      ],
      DEFAULT_GRADING_SCALE,
      40,
    );
    expect(r.totalObtained).toBe(125);
    expect(r.totalMax).toBe(150);
    expect(r.percentage).toBe(83.33);
    expect(r.grade).toBe('A');
    expect(r.passed).toBe(true);
    const failed = computeStudentResult(
      papers,
      [
        { paperId: 'p1', obtained: 90 },
        { paperId: 'p2', isAbsent: true },
      ],
      DEFAULT_GRADING_SCALE,
      40,
    );
    expect(failed.passed).toBe(false);
    expect(failed.failedSubjects).toEqual(['English']);
    const incomplete = computeStudentResult(papers, [{ paperId: 'p1', obtained: 90 }], DEFAULT_GRADING_SCALE, 40);
    expect(incomplete.incomplete).toBe(true);
  });
  it('uses competition ranking for ties and skips incomplete results', () => {
    const ranked = assignPositions([
      { percentage: 90, incomplete: false },
      { percentage: 80, incomplete: false },
      { percentage: 90, incomplete: false },
      { percentage: 99, incomplete: true },
      { percentage: 70, incomplete: false },
    ]);
    expect(ranked.map((r) => r.position)).toEqual([1, 3, 1, null, 4]);
    expect(gradeFor(39.99, DEFAULT_GRADING_SCALE).grade).toBe('F');
  });
});

describe('Examinations API', () => {
  it('sets up an exam with papers', async () => {
    const exam = await api(t.app, s.ownerToken, 'post', '/exams', {
      sessionId: s.sessionId,
      name: 'Mid-Term 2026',
      term: 'mid_term',
      classIds: [s.classId],
    });
    examId = exam._id;
    const papers = await api(t.app, s.ownerToken, 'put', `/exams/${examId}/papers`, {
      papers: [
        { classId: s.classId, subjectId: s.mathId, maxMarks: 100, passMarks: 33, date: '2026-10-20' },
        { classId: s.classId, subjectId: s.englishId, maxMarks: 100, passMarks: 33, date: '2026-10-21' },
      ],
    });
    mathPaper = papers.find((p: any) => p.subjectId._id === s.mathId)._id;
    engPaper = papers.find((p: any) => p.subjectId._id === s.englishId)._id;
  });

  it('lets only the subject teacher enter marks and rejects marks above the maximum', async () => {
    const roster = await api(
      t.app,
      s.teacherToken,
      'get',
      `/exams/${examId}/papers/${mathPaper}/marks?sectionId=${s.sectionA}`,
    );
    expect(roster.students).toHaveLength(2);
    const over = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[0], obtained: 101 }] });
    expect(over.status).toBe(422);
    const notMine = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.otherTeacherToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[0], obtained: 50 }] });
    expect(notMine.status).toBe(403);
    await api(t.app, s.teacherToken, 'post', `/exams/${examId}/papers/${mathPaper}/marks`, {
      sectionId: s.sectionA,
      marks: [
        { studentId: s.students[0], obtained: 92 },
        { studentId: s.students[1], obtained: 20 },
      ],
    });
    await api(t.app, s.ownerToken, 'post', `/exams/${examId}/papers/${engPaper}/marks`, {
      sectionId: s.sectionA,
      marks: [
        { studentId: s.students[0], obtained: 78 },
        { studentId: s.students[1], isAbsent: true },
      ],
    });
  });

  it('computes section results with positions and subject statistics', async () => {
    const r = await api(t.app, s.principalToken, 'get', `/exams/${examId}/results?sectionId=${s.sectionA}`);
    expect(r.results[0].studentId).toBe(s.students[0]);
    expect(r.results[0].percentage).toBe(85);
    expect(r.results[0].position).toBe(1);
    expect(r.results[1].passed).toBe(false);
    expect(r.summary.passRate).toBe(50);
  });

  it('hides results from parents until published, then shows only their child', async () => {
    const before = await request(t.app)
      .get(`/api/v1/exams/${examId}/report-cards/${s.students[0]}`)
      .set(auth(s.parentToken));
    expect(before.status).toBe(404);
    // Section B has no marks yet, so publishing is refused until every student has marks or Absent.
    const blocked = await request(t.app)
      .post(`/api/v1/exams/${examId}/publish`)
      .set(auth(s.principalToken))
      .send({ notifyParents: true });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('RESULTS_INCOMPLETE');
    for (const paper of [mathPaper, engPaper])
      await api(t.app, s.ownerToken, 'post', `/exams/${examId}/papers/${paper}/marks`, {
        sectionId: s.sectionB,
        marks: [
          { studentId: s.students[2], obtained: 50 },
          { studentId: s.students[3], obtained: 45 },
        ],
      });
    const pub = await api(t.app, s.principalToken, 'post', `/exams/${examId}/publish`, { notifyParents: true });
    expect(pub.notified).toBe(1);
    const card = await api(t.app, s.parentToken, 'get', `/exams/${examId}/report-cards/${s.students[0]}`);
    expect(card.result.grade).toBe('A');
    const other = await request(t.app)
      .get(`/api/v1/exams/${examId}/report-cards/${s.students[1]}`)
      .set(auth(s.parentToken));
    expect(other.status).toBe(404);
    const edit = await request(t.app)
      .post(`/api/v1/exams/${examId}/papers/${mathPaper}/marks`)
      .set(auth(s.teacherToken))
      .send({ sectionId: s.sectionA, marks: [{ studentId: s.students[1], obtained: 60 }] });
    expect(edit.status).toBe(409);
  });
});

describe('Homework, private files and certificates', () => {
  const PDF = Buffer.from('%PDF-1.4\n%test\n%%EOF');

  it('teacher assigns homework, the parent hands it in for their child, teacher grades', async () => {
    // Students have no login: the parent of students[0] (in section A) submits for them.

    const hw = await api(t.app, s.teacherToken, 'post', '/homework', {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      title: 'Fractions worksheet',
      description: 'Exercise 4.2 Q1-10',
      dueDate: '2099-01-01',
    });
    const notMine = await request(t.app).post('/api/v1/homework').set(auth(s.otherTeacherToken)).send({
      sectionId: s.sectionA,
      subjectId: s.mathId,
      title: 'Not my class',
      description: 'Should be refused',
      dueDate: '2099-01-01',
    });
    expect(notMine.status).toBe(403);

    const upload = (token: string, studentId: string) =>
      request(t.app)
        .post('/api/v1/files')
        .set(auth(token))
        .field('category', 'submission')
        .field('homeworkId', hw._id)
        .field('studentId', studentId)
        .attach('file', PDF, { filename: 'answers.pdf', contentType: 'application/pdf' });
    // Not their child: refused, for the upload and for the submission.
    expect((await upload(s.parentToken, s.students[1])).status).toBe(403);
    const up = await upload(s.parentToken, s.students[0]);
    expect(up.status).toBe(201);
    const other = await request(t.app)
      .post(`/api/v1/homework/${hw._id}/submissions`)
      .set(auth(s.parentToken))
      .send({ studentId: s.students[1], text: 'Not mine' });
    expect(other.status).toBe(403);
    // Staff cannot submit on a child's behalf.
    const staff = await request(t.app)
      .post(`/api/v1/homework/${hw._id}/submissions`)
      .set(auth(s.teacherToken))
      .send({ studentId: s.students[0], text: 'x' });
    expect(staff.status).toBe(403);
    const sub = await api(t.app, s.parentToken, 'post', `/homework/${hw._id}/submissions`, {
      studentId: s.students[0],
      text: 'Done',
      attachmentIds: [up.body.data._id],
    });
    expect(sub.status).toBe('submitted');
    expect(sub.studentId).toBe(s.students[0]);
    // The parent sees their child's submission on the homework.
    const view = await api(t.app, s.parentToken, 'get', `/homework/${hw._id}`);
    expect(view.familySubmissions).toHaveLength(1);
    expect(view.familySubmissions[0]).toMatchObject({ studentId: s.students[0], submission: { status: 'submitted' } });
    const roster = await api(t.app, s.teacherToken, 'get', `/homework/${hw._id}/submissions`);
    expect(roster.totals.submitted).toBe(1);
    const graded = await api(t.app, s.teacherToken, 'post', `/homework/${hw._id}/submissions/${sub._id}/grade`, {
      marks: 9,
      feedback: 'Good',
    });
    expect(graded.status).toBe('graded');
    // The parent can download their child's submission.
    expect(
      (await request(t.app).get(`/api/v1/files/${up.body.data._id}/download`).set(auth(s.parentToken))).status,
    ).toBe(200);
  });

  it('rejects files whose content does not match the declared type', async () => {
    const res = await request(t.app)
      .post('/api/v1/files')
      .set(auth(s.ownerToken))
      .field('category', 'student_document')
      .field('studentId', s.students[1])
      .attach('file', Buffer.from('MZ\x90\x00 fake exe'), { filename: 'virus.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('issues certificates as PDFs visible to the family and verifiable publicly without personal data', async () => {
    const cert = await api(t.app, s.ownerToken, 'post', '/certificates', {
      studentId: s.students[0],
      type: 'character',
      values: { 'certificate.conduct': 'good' },
    });
    expect(cert.serialNo).toMatch(/^CERT-\d{4}-\d{5}$/);
    const dl = await request(t.app).get(`/api/v1/certificates/${cert._id}/download`).set(auth(s.parentToken));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    const verify = await request(t.app).get(
      `/api/v1/public/certificates/verify?schoolCode=${s.code}&serialNo=${cert.serialNo}`,
    );
    expect(verify.body.data).toMatchObject({ valid: true, status: 'issued', holderInitials: 'S. T.' });
    expect(JSON.stringify(verify.body)).not.toContain('Student0');
    const privateDoc = await request(t.app)
      .post('/api/v1/files')
      .set(auth(s.ownerToken))
      .field('category', 'student_document')
      .field('studentId', s.students[0])
      .attach('file', PDF, { filename: 'medical.pdf', contentType: 'application/pdf' });
    const hidden = await request(t.app)
      .get(`/api/v1/files/${privateDoc.body.data._id}/download`)
      .set(auth(s.parentToken));
    expect(hidden.status).toBe(404);
  });
});
