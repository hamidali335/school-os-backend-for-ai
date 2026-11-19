import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { AcademicRolloverBatch } from '../src/modules/academics/academic-rollover-batch.model';
import {
  checkAcademicRolloverRollback,
  rollbackAcademicRollover,
  executeAcademicRollover,
} from '../src/modules/academics/academic-rollover.service';
import { FeeStructure, Invoice, Payment } from '../src/modules/fees/fees.models';
import { Student, StudentEnrollment, PromotionBatch } from '../src/modules/students/student.models';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Exam, ExamPaper, Mark } from '../src/modules/examinations/exam.models';
import { Homework, HomeworkSubmission } from '../src/modules/homework/homework.models';
import { LeaveRequest } from '../src/modules/leave/leave.model';
import { User } from '../src/modules/users/user.model';
import { checkPromotionBatchRollback, rollbackPromotionBatch } from '../src/modules/students/promotion.service';
import { getStudentJourney } from '../src/modules/students/student-journey.service';
import { reportCardsForSection } from '../src/modules/examinations/report-card';

const t = useTestApp();
let s1: SchoolFixture;
let s2: SchoolFixture;

let s1OwnerUser: any;
let student1Doc: any;
let student2Doc: any;

let session1: any;
let session2: any;

let class5: any;
let sec5A_s1: any;
let sec5B_s1: any;

let sec5A_s2: any; // Pre-existing in session 2
let sec5B_s2: any; // Created during rollover in session 2

let sciSubject: any;
let phySubject: any;
let chemSubject: any;

let teacherEmp: any;

beforeAll(async () => {
  s1 = await buildSchool(t.app, { students: 2 });
  s2 = await buildSchool(t.app, { students: 1 });

  const ownerUser = await User.findOne({ schoolId: s1.schoolId, email: s1.ownerEmail }).lean();
  s1OwnerUser = ownerUser?._id;

  student1Doc = await Student.findOne({ schoolId: s1.schoolId, _id: s1.students[0] }).lean();
  student2Doc = await Student.findOne({ schoolId: s1.schoolId, _id: s1.students[1] }).lean();

  teacherEmp = s1.teacherEmployeeId;
  session1 = await AcademicSession.findOne({ schoolId: s1.schoolId, _id: s1.sessionId }).lean();

  // Create Session 2
  session2 = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
    name: '2027-2028',
    startDate: '2027-04-01',
    endDate: '2028-03-31',
    status: 'planned',
  });

  class5 = await SchoolClass.findOne({ schoolId: s1.schoolId, _id: s1.classId }).lean();
  sec5A_s1 = await Section.findOne({ schoolId: s1.schoolId, _id: s1.sectionA }).lean();
  sec5B_s1 = await Section.findOne({ schoolId: s1.schoolId, _id: s1.sectionB }).lean();
});

describe('Task Two: Multi-Session Historical Subject and Curriculum Data Protection', () => {
  let examS1: any;
  let paperSciS1: any;
  let markS1: any;

  it('sets up General Science subject, teaching assignment, and exam marks in Session 1', async () => {
    // 1. Create General Science subject mapped to Class 5
    sciSubject = await api(t.app, s1.ownerToken, 'post', '/academics/subjects', {
      name: 'General Science',
      code: 'GEN-SCI-5',
      classIds: [s1.classId],
      isElective: false,
    });

    // 2. Assign teacher to teach General Science in Section A for Session 1
    await TeachingAssignment.create({
      schoolId: s1.schoolId,
      sessionId: session1._id,
      sectionId: sec5A_s1._id,
      subjectId: sciSubject._id,
      teacherId: teacherEmp,
    });

    // 3. Create Session 1 Exam
    examS1 = await Exam.create({
      schoolId: s1.schoolId,
      sessionId: session1._id,
      name: 'Annual Exam 2026',
      term: 'final_term',
      startDate: new Date('2026-12-01'),
      endDate: new Date('2026-12-15'),
      status: 'published',
    });

    // 4. Create Paper for General Science
    paperSciS1 = await ExamPaper.create({
      schoolId: s1.schoolId,
      examId: examS1._id,
      classId: s1.classId,
      subjectId: sciSubject._id,
      maxMarks: 100,
      passMarks: 40,
    });

    // 5. Enter mark for Student 1: 88/100
    markS1 = await Mark.create({
      schoolId: s1.schoolId,
      examId: examS1._id,
      paperId: paperSciS1._id,
      studentId: student1Doc._id,
      classId: s1.classId,
      sectionId: sec5A_s1._id,
      subjectId: sciSubject._id,
      obtained: 88,
      isAbsent: false,
    });

    expect(markS1.obtained).toBe(88);
  });

  it('verifies report card and student journey in Session 1 accurately reflect General Science', async () => {
    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    // Report card in Session 1
    const cards = await reportCardsForSection(ctx, examS1._id.toString(), sec5A_s1._id.toString());
    const stCard = cards.find((c) => c.student._id === student1Doc._id.toString());
    expect(stCard).toBeDefined();
    expect(stCard?.result.subjects).toHaveLength(1);
    expect(stCard?.result.subjects[0].subject).toBe('General Science');
    expect(stCard?.result.subjects[0].obtained).toBe(88);
    expect(stCard?.result.subjects[0].grade).toBe('A');
    expect(stCard?.result.passed).toBe(true);

    // Student Journey in Session 1
    const journey = await getStudentJourney(ctx, student1Doc._id.toString());
    const s1Record = journey.sessions.find((s) => s.enrollment.sessionId === session1._id.toString());
    expect(s1Record).toBeDefined();
    expect(s1Record?.academics.subjects.some((s) => s.name === 'General Science')).toBe(true);
    expect(s1Record?.examinations).toHaveLength(1);
    expect(s1Record?.examinations[0].papers[0].subjectName).toBe('General Science');
    expect(s1Record?.examinations[0].papers[0].obtained).toBe(88);
  });

  it('modifies curriculum in Session 2 (splits Science into Physics and Chemistry and unmaps General Science) without corrupting Session 1 history', async () => {
    // 1. School updates General Science: removes Class 5 from its classIds
    await api(t.app, s1.ownerToken, 'patch', `/academics/subjects/${sciSubject._id}`, {
      classIds: [], // Removed from Class 5
    });

    // 2. School creates Physics and Chemistry for Class 5
    phySubject = await api(t.app, s1.ownerToken, 'post', '/academics/subjects', {
      name: 'Physics',
      code: 'PHY-5',
      classIds: [s1.classId],
      isElective: false,
    });

    chemSubject = await api(t.app, s1.ownerToken, 'post', '/academics/subjects', {
      name: 'Chemistry',
      code: 'CHEM-5',
      classIds: [s1.classId],
      isElective: false,
    });

    // 3. Promote Student 1 to Session 2 (same class, repeater or advanced)
    sec5A_s2 = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
      campusId: s1.campusId,
      classId: s1.classId,
      sessionId: session2._id,
      name: 'A',
      capacity: 35,
    });

    const promoRes = await api(t.app, s1.ownerToken, 'post', '/students/promotion-batches', {
      fromSessionId: session1._id,
      toSessionId: session2._id,
      campusId: s1.campusId,
      items: [
        {
          studentId: student1Doc._id.toString(),
          action: 'repeat',
          toClassId: s1.classId,
          toSectionId: sec5A_s2._id,
        },
      ],
    });
    expect(promoRes.totalRepeating).toBe(1);

    // 4. Assign Physics teacher in Session 2
    await TeachingAssignment.create({
      schoolId: s1.schoolId,
      sessionId: session2._id,
      sectionId: sec5A_s2._id,
      subjectId: phySubject._id,
      teacherId: teacherEmp,
    });

    // 5. Create Session 2 Midterm Exam for Physics
    const examS2 = await Exam.create({
      schoolId: s1.schoolId,
      sessionId: session2._id,
      name: 'Midterm Exam 2027',
      term: 'mid_term',
      status: 'published',
    });

    const paperPhyS2 = await ExamPaper.create({
      schoolId: s1.schoolId,
      examId: examS2._id,
      classId: s1.classId,
      subjectId: phySubject._id,
      maxMarks: 100,
      passMarks: 40,
    });

    await Mark.create({
      schoolId: s1.schoolId,
      examId: examS2._id,
      paperId: paperPhyS2._id,
      studentId: student1Doc._id,
      classId: s1.classId,
      sectionId: sec5A_s2._id,
      subjectId: phySubject._id,
      obtained: 94,
      isAbsent: false,
    });

    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    // 6. Verify Session 1 Report Card is STILL 100% UNTOUCHED
    const cardsS1Recheck = await reportCardsForSection(ctx, examS1._id.toString(), sec5A_s1._id.toString());
    const st1Card = cardsS1Recheck.find((c) => c.student._id === student1Doc._id.toString());
    expect(st1Card).toBeDefined();
    expect(st1Card?.result.subjects).toHaveLength(1);
    expect(st1Card?.result.subjects[0].subject).toBe('General Science');
    expect(st1Card?.result.subjects[0].obtained).toBe(88);
    expect(st1Card?.result.totalMax).toBe(100);
    expect(st1Card?.result.totalObtained).toBe(88);

    // 7. Verify Student Journey preserves multi-session curriculum boundary
    const journeyMulti = await getStudentJourney(ctx, student1Doc._id.toString());
    expect(journeyMulti.sessions).toHaveLength(2);

    const s1Historical = journeyMulti.sessions.find((s) => s.enrollment.sessionId === session1._id.toString())!;
    const s2Current = journeyMulti.sessions.find((s) => s.enrollment.sessionId === session2._id.toString())!;

    // Session 1 still retains General Science with 88 obtained
    expect(s1Historical.academics.subjects.some((s) => s.name === 'General Science')).toBe(true);
    expect(s1Historical.academics.subjects.some((s) => s.name === 'Physics')).toBe(false);
    expect(s1Historical.examinations[0].papers[0].subjectName).toBe('General Science');
    expect(s1Historical.examinations[0].papers[0].obtained).toBe(88);

    // Session 2 reflects new curriculum: Physics
    expect(s2Current.academics.subjects.some((s) => s.name === 'Physics')).toBe(true);
    expect(s2Current.examinations[0].papers[0].subjectName).toBe('Physics');
    expect(s2Current.examinations[0].papers[0].obtained).toBe(94);

    // Clean up Session 2 exam artifacts so session2 is clean for rollover tests
    await Mark.deleteMany({ schoolId: s1.schoolId, examId: examS2._id });
    await ExamPaper.deleteMany({ schoolId: s1.schoolId, examId: examS2._id });
    await Exam.deleteOne({ schoolId: s1.schoolId, _id: examS2._id });
  });
});

describe('Task One: Rollback Dependency Verification & Section Lifecycle Safety', () => {
  let rolloverBatchId: string;
  let targetSectionCreated: any;

  it('executes academic rollover with mixture of reused section (A) and created section (B)', async () => {
    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    // Academic rollover from session1 to session2
    // Section A already exists in session2 (sec5A_s2) -> should be reused
    // Section B only exists in session1 (sec5B_s1) -> should be newly created
    const result = await executeAcademicRollover(ctx, {
      fromSessionId: session1._id.toString(),
      toSessionId: session2._id.toString(),
      includeSections: true,
      includeTeacherAssignments: true,
      includeTimetable: false,
    });

    expect(result.success).toBe(true);
    expect(result.summary.sectionsReused).toBeGreaterThanOrEqual(1);
    expect(result.summary.sectionsCreated).toBeGreaterThanOrEqual(1);
    rolloverBatchId = result.batchId;

    const batch = await AcademicRolloverBatch.findOne({ schoolId: s1.schoolId, _id: rolloverBatchId }).lean();
    expect(batch).toBeTruthy();
    expect(batch?.reusedSectionIds.map(String)).toContain(sec5A_s2._id.toString());

    // Locate newly created Section B in Session 2
    targetSectionCreated = await Section.findOne({
      schoolId: s1.schoolId,
      sessionId: session2._id,
      name: 'B',
    }).lean();
    expect(targetSectionCreated).toBeTruthy();
    expect(batch?.createdSectionIds.map(String)).toContain(targetSectionCreated._id.toString());
  });

  it('blocks academic rollover rollback when dependent attendance exists in target session', async () => {
    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    const att = await AttendanceRecord.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: student1Doc._id,
      sessionId: session2._id,
      classId: s1.classId,
      sectionId: sec5A_s2._id,
      date: new Date('2027-04-15'),
      status: 'present',
    });

    const check = await checkAcademicRolloverRollback(ctx, session2._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers.some((b) => b.type === 'attendance')).toBe(true);

    // Attempting rollback throws conflict with ROLLBACK_BLOCKED
    await expect(
      rollbackAcademicRollover(ctx, {
        targetSessionId: session2._id.toString(),
        reason: 'Attempt with attendance blocker',
      }),
    ).rejects.toThrow();

    await AttendanceRecord.deleteOne({ schoolId: s1.schoolId, _id: att._id });
  });

  it('prevents deletion of reused sections and sections with enrolled students during academic rollover rollback', async () => {
    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    // Enroll student2 in the newly created Section B in Session 2
    await StudentEnrollment.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: student2Doc._id,
      sessionId: session2._id,
      classId: s1.classId,
      sectionId: targetSectionCreated._id,
      enrollmentDate: new Date('2027-04-01'),
      status: 'active',
    });

    // Verify rollback check is clear of attendance/exam blockers
    const check = await checkAcademicRolloverRollback(ctx, session2._id.toString());
    expect(check.canRollback).toBe(true);

    // Execute rollback
    const rollbackRes = await rollbackAcademicRollover(ctx, {
      targetSessionId: session2._id.toString(),
      reason: 'Administrative test for section protection',
    });
    expect(rollbackRes.status).toBe('rolled_back');

    // 1. Reused section A MUST NEVER be deleted
    const reusedAfter = await Section.findOne({ schoolId: s1.schoolId, _id: sec5A_s2._id }).lean();
    expect(reusedAfter).toBeTruthy();

    // 2. Created section B MUST NOT be deleted because student2 is enrolled in it!
    const createdWithStudentAfter = await Section.findOne({ schoolId: s1.schoolId, _id: targetSectionCreated._id }).lean();
    expect(createdWithStudentAfter).toBeTruthy();

    // Clean up student2 enrollment in Session 2
    await StudentEnrollment.deleteOne({
      schoolId: s1.schoolId,
      studentId: student2Doc._id,
      sessionId: session2._id,
    });
  });

  it('safely deletes unreferenced created sections when rolling back a fresh rollover batch', async () => {
    const ctx = {
      schoolId: s1.schoolId,
      userId: s1OwnerUser,
      role: 'owner',
      campusIds: [s1.campusId],
    } as any;

    // Create a fresh target session for clean unreferenced test
    const sessionClean = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
      name: '2028-2029',
      startDate: '2028-04-01',
      endDate: '2029-03-31',
      status: 'planned',
    });

    // Create pre-existing Section A in sessionClean (reused)
    const secCleanA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
      campusId: s1.campusId,
      classId: s1.classId,
      sessionId: sessionClean._id,
      name: 'A',
      capacity: 30,
    });

    // Run rollover from session1 into sessionClean: Section B will be newly created
    const rollRes = await executeAcademicRollover(ctx, {
      fromSessionId: session1._id.toString(),
      toSessionId: sessionClean._id.toString(),
      includeSections: true,
      includeTeacherAssignments: false,
      includeTimetable: false,
    });
    expect(rollRes.success).toBe(true);

    const secCleanB = await Section.findOne({
      schoolId: s1.schoolId,
      sessionId: sessionClean._id,
      name: 'B',
    }).lean();
    expect(secCleanB).toBeTruthy();

    // Rollback now: Section B has 0 enrollments, so it should be safely deleted!
    await rollbackAcademicRollover(ctx, {
      targetSessionId: sessionClean._id.toString(),
      reason: 'Clean unreferenced section deletion test',
    });

    const secCleanB_after = await Section.findOne({
      schoolId: s1.schoolId,
      sessionId: sessionClean._id,
      name: 'B',
    }).lean();
    expect(secCleanB_after).toBeNull(); // Cleanly deleted

    // Pre-existing Section A is still intact!
    const secCleanA_still_there = await Section.findOne({ schoolId: s1.schoolId, _id: secCleanA._id }).lean();
    expect(secCleanA_still_there).toBeTruthy();
  });

  it('enforces multi-tenant isolation and prevents cross-school rollback attempts', async () => {
    // School 2 attempts to rollback School 1's academic rollover
    const crossRes = await request(t.app)
      .post('/api/v1/academics/rollover/rollback')
      .set(auth(s2.ownerToken))
      .send({
        targetSessionId: session2._id.toString(),
        reason: 'Cross tenant illicit attack',
      });

    // Should return 404 Not Found (Target session not owned by school 2)
    expect(crossRes.status).toBe(404);
  });
});
