import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { Student, StudentEnrollment, PromotionBatch } from '../src/modules/students/student.models';
import { Invoice } from '../src/modules/fees/fees.models';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Exam, ExamPaper, Mark } from '../src/modules/examinations/exam.models';

const t = useTestApp();
let s1: SchoolFixture;
let s2: SchoolFixture;

let nextSession: any;
let nurseryClass: any;
let class1: any;
let class2: any;
let terminalClass: any; // e.g. Class 10

let nurserySecA: any;
let class1SecA: any;
let class2SecA: any;
let terminalSecA: any;

let nextNurserySecA: any;
let nextClass1SecA: any;
let nextClass2SecA: any;
let nextTerminalSecA: any;

let nurseryStudent: any;
let class1Student: any;
let terminalStudent: any;

beforeAll(async () => {
  s1 = await buildSchool(t.app, { students: 1 });
  s2 = await buildSchool(t.app, { students: 1 });

  // 1. Create multi-tier class sequence in s1: Nursery (level 0) -> Class 1 (level 1) -> Class 2 (level 2) -> Class 10 (level 10, terminal)
  nurseryClass = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
    campusId: s1.campusId,
    name: 'Nursery',
    level: 0,
  });

  class1 = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
    campusId: s1.campusId,
    name: 'Class 1',
    level: 1,
  });

  class2 = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
    campusId: s1.campusId,
    name: 'Class 2',
    level: 2,
  });

  terminalClass = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
    campusId: s1.campusId,
    name: 'Class 10',
    level: 10,
  });

  // Sections in Source Session (s1.sessionId)
  nurserySecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: nurseryClass._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 30,
  });

  class1SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class1._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 30,
  });

  class2SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class2._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 30,
  });

  terminalSecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: terminalClass._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 30,
  });

  // 2. Create Next Session (2027-2028)
  nextSession = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
    name: '2027-2028',
    startDate: '2027-04-01',
    endDate: '2028-03-31',
  });

  // Sections in Target Session (nextSession._id)
  nextNurserySecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: nurseryClass._id,
    sessionId: nextSession._id,
    name: 'A',
    capacity: 30,
  });

  nextClass1SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class1._id,
    sessionId: nextSession._id,
    name: 'A',
    capacity: 30,
  });

  nextClass2SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class2._id,
    sessionId: nextSession._id,
    name: 'A',
    capacity: 30,
  });

  nextTerminalSecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: terminalClass._id,
    sessionId: nextSession._id,
    name: 'A',
    capacity: 30,
  });

  // 3. Enrol test students in source session
  nurseryStudent = await api(t.app, s1.adminToken, 'post', '/students', {
    campusId: s1.campusId,
    firstName: 'Hamza',
    lastName: 'Ali',
    gender: 'male',
    sessionId: s1.sessionId,
    classId: nurseryClass._id,
    sectionId: nurserySecA._id,
    rollNo: 'N-01',
    guardians: [{ parent: { name: 'Ali Khan', phone: '+923001112233' }, isPrimary: true }],
  });

  class1Student = await api(t.app, s1.adminToken, 'post', '/students', {
    campusId: s1.campusId,
    firstName: 'Zainab',
    lastName: 'Fatima',
    gender: 'female',
    sessionId: s1.sessionId,
    classId: class1._id,
    sectionId: class1SecA._id,
    rollNo: 'C1-01',
    guardians: [{ parent: { name: 'Farooq Ahmed', phone: '+923002223344' }, isPrimary: true }],
  });

  terminalStudent = await api(t.app, s1.adminToken, 'post', '/students', {
    campusId: s1.campusId,
    firstName: 'Usman',
    lastName: 'Ghani',
    gender: 'male',
    sessionId: s1.sessionId,
    classId: terminalClass._id,
    sectionId: terminalSecA._id,
    rollNo: 'C10-01',
    guardians: [{ parent: { name: 'Ghani Rehman', phone: '+923003334455' }, isPrimary: true }],
  });
});

describe('Phase 2: Student Promotion, Academic History & Session Rollover Engine', () => {
  it('previews promotion batch accurately identifying class progression and terminal classes', async () => {
    const preview = await api(t.app, s1.adminToken, 'post', '/students/promotion-preview', {
      fromSessionId: s1.sessionId,
      toSessionId: nextSession._id,
      campusId: s1.campusId,
    });

    expect(preview.fromSession._id).toBe(s1.sessionId);
    expect(preview.toSession._id).toBe(nextSession._id);
    expect(preview.classes.length).toBeGreaterThanOrEqual(4);

    // Verify Nursery student is proposed to move to Class 1
    const pNursery = preview.students.find((s: any) => s.studentId === nurseryStudent._id);
    expect(pNursery).toBeDefined();
    expect(pNursery.proposedAction).toBe('promote');
    expect(pNursery.proposedClass._id).toBe(class1._id);
    expect(pNursery.proposedSection._id).toBe(nextClass1SecA._id);
    expect(pNursery.isTerminal).toBe(false);

    // Verify Class 1 student is proposed to move to Class 2
    const pClass1 = preview.students.find((s: any) => s.studentId === class1Student._id);
    expect(pClass1).toBeDefined();
    expect(pClass1.proposedAction).toBe('promote');
    expect(pClass1.proposedClass._id).toBe(class2._id);
    expect(pClass1.proposedSection._id).toBe(nextClass2SecA._id);

    // Verify Terminal class student is proposed for graduation review
    const pTerminal = preview.students.find((s: any) => s.studentId === terminalStudent._id);
    expect(pTerminal).toBeDefined();
    expect(pTerminal.isTerminal).toBe(true);
    expect(pTerminal.proposedAction).toBe('graduate');
    expect(preview.graduatingStudents.some((g: any) => g.studentId === terminalStudent._id)).toBe(true);
  });

  it('rejects unauthorized users from previewing or executing promotion batches', async () => {
    // Teacher token has no students:manage
    await expect(
      api(t.app, s1.teacherToken, 'post', '/students/promotion-preview', {
        fromSessionId: s1.sessionId,
        toSessionId: nextSession._id,
      }),
    ).rejects.toThrow();

    await expect(
      api(t.app, s1.teacherToken, 'post', '/students/promotion-batches', {
        fromSessionId: s1.sessionId,
        toSessionId: nextSession._id,
        campusId: s1.campusId,
        items: [{ studentId: nurseryStudent._id, action: 'promote', toClassId: class1._id, toSectionId: nextClass1SecA._id }],
      }),
    ).rejects.toThrow();
  });

  it('executes a batch promotion with promotions, repeaters, graduations and manual placements', async () => {
    // Enrol another student in Class 1 to test repeater
    const repeaterStudent = await api(t.app, s1.adminToken, 'post', '/students', {
      campusId: s1.campusId,
      firstName: 'Taha',
      lastName: 'Imran',
      gender: 'male',
      sessionId: s1.sessionId,
      classId: class1._id,
      sectionId: class1SecA._id,
      rollNo: 'C1-02',
      guardians: [{ parent: { name: 'Imran Siddiqui', phone: '+923004445566' }, isPrimary: true }],
    });

    const batch = await api(t.app, s1.adminToken, 'post', '/students/promotion-batches', {
      fromSessionId: s1.sessionId,
      toSessionId: nextSession._id,
      campusId: s1.campusId,
      items: [
        // 1. Nursery -> Class 1 (normal promotion)
        {
          studentId: nurseryStudent._id,
          action: 'promote',
          toClassId: class1._id,
          toSectionId: nextClass1SecA._id,
          toRollNo: 'C1-10',
        },
        // 2. Class 1 -> Class 1 in next session (repeating)
        {
          studentId: repeaterStudent._id,
          action: 'repeat',
          toClassId: class1._id,
          toSectionId: nextClass1SecA._id,
          toRollNo: 'C1-11',
          remarks: 'Needs to repeat Class 1 curriculum',
        },
        // 3. Class 10 -> Graduated (terminal class)
        {
          studentId: terminalStudent._id,
          action: 'graduate',
          remarks: 'Passed Matriculation Examination',
        },
      ],
    });

    expect(batch.batchId).toBeDefined();
    expect(batch.totalProcessed).toBe(3);
    expect(batch.totalPromoted).toBe(1);
    expect(batch.totalRepeating).toBe(1);
    expect(batch.totalGraduated).toBe(1);

    // Verify Nursery student updated to Class 1
    const updatedNursery = await Student.findOne({ _id: nurseryStudent._id, schoolId: s1.schoolId }).lean();
    expect(updatedNursery!.sessionId.toString()).toBe(nextSession._id);
    expect(updatedNursery!.classId.toString()).toBe(class1._id);
    expect(updatedNursery!.sectionId.toString()).toBe(nextClass1SecA._id);
    expect(updatedNursery!.status).toBe('active');

    // Verify repeater student stays in Class 1 in nextSession
    const updatedRepeater = await Student.findOne({ _id: repeaterStudent._id, schoolId: s1.schoolId }).lean();
    expect(updatedRepeater!.sessionId.toString()).toBe(nextSession._id);
    expect(updatedRepeater!.classId.toString()).toBe(class1._id);
    expect(updatedRepeater!.sectionId.toString()).toBe(nextClass1SecA._id);

    // Verify repeater enrollment has status 'repeating'
    const repeaterEnrollments = await StudentEnrollment.find({
      schoolId: s1.schoolId,
      studentId: repeaterStudent._id,
      sessionId: nextSession._id,
    }).lean();
    expect(repeaterEnrollments).toHaveLength(1);
    expect(repeaterEnrollments[0].status).toBe('repeating');

    // Verify terminal student is graduated
    const updatedTerminal = await Student.findOne({ _id: terminalStudent._id, schoolId: s1.schoolId }).lean();
    expect(updatedTerminal!.status).toBe('graduated');

    // Verify terminal student's target enrollment is graduated
    const terminalEnrollments = await StudentEnrollment.find({
      schoolId: s1.schoolId,
      studentId: terminalStudent._id,
      sessionId: nextSession._id,
    }).lean();
    expect(terminalEnrollments).toHaveLength(1);
    expect(terminalEnrollments[0].status).toBe('graduated');
  });

  it('prevents duplicate enrollment in the target academic session', async () => {
    // Attempting to promote nurseryStudent again into nextSession must fail with conflict
    await expect(
      api(t.app, s1.adminToken, 'post', '/students/promotion-batches', {
        fromSessionId: s1.sessionId,
        toSessionId: nextSession._id,
        campusId: s1.campusId,
        items: [
          {
            studentId: nurseryStudent._id,
            action: 'promote',
            toClassId: class1._id,
            toSectionId: nextClass1SecA._id,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('handles student departure (left and transferred) cleanly preserving permanent identity', async () => {
    // Mark a student as left
    const leftRes = await api(t.app, s1.adminToken, 'post', `/students/${class1Student._id}/status`, {
      status: 'left',
      reason: 'Family relocated to another city',
    });
    expect(leftRes.status).toBe('left');

    const leftStudent = await Student.findOne({ _id: class1Student._id, schoolId: s1.schoolId }).lean();
    expect(leftStudent!.status).toBe('left');
    expect(leftStudent!.leavingReason).toBe('Family relocated to another city');

    // Check enrollment status synced
    const enr = await StudentEnrollment.findOne({
      schoolId: s1.schoolId,
      studentId: class1Student._id,
      sessionId: s1.sessionId,
    }).lean();
    expect(enr!.status).toBe('left');

    // Mark as transferred
    const transRes = await api(t.app, s1.adminToken, 'post', `/students/${class1Student._id}/status`, {
      status: 'transferred',
      reason: 'Transferred to Army Public School',
    });
    expect(transRes.status).toBe('transferred');
  });

  it('blocks batch rollback when an affected student has acquired new-session activity', async () => {
    // Find the promotion batch created earlier
    const batches = await api(t.app, s1.adminToken, 'get', `/students/promotion-batches?toSessionId=${nextSession._id}`);
    expect(batches.length).toBeGreaterThan(0);
    const batchId = batches[0]._id;

    // Simulate new-session activity for nurseryStudent (who was promoted to nextSession)
    // 1. Mark attendance in nextSession
    await AttendanceRecord.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: nurseryStudent._id,
      sessionId: nextSession._id,
      classId: class1._id,
      sectionId: nextClass1SecA._id,
      date: new Date('2027-04-05'),
      status: 'present',
    });

    // Check rollback eligibility
    const check = await api(t.app, s1.adminToken, 'get', `/students/promotion-batches/${batchId}/rollback-check`);
    expect(check.canRollback).toBe(false);
    expect(check.totalBlockedStudents).toBe(1);
    expect(check.blockers[0].studentId).toBe(nurseryStudent._id);
    expect(check.blockers[0].attendanceCount).toBe(1);

    // Attempting to rollback must be rejected with 409 conflict
    await expect(
      api(t.app, s1.adminToken, 'post', `/students/promotion-batches/${batchId}/rollback`, {
        reason: 'Mistaken promotion run',
      }),
    ).rejects.toThrow();

    // Clean up simulated attendance record
    await AttendanceRecord.deleteOne({ schoolId: s1.schoolId, studentId: nurseryStudent._id, sessionId: nextSession._id });
  });

  it('successfully rolls back a promotion batch when no new-session records exist', async () => {
    const batches = await api(t.app, s1.adminToken, 'get', `/students/promotion-batches?toSessionId=${nextSession._id}`);
    const batchId = batches[0]._id;

    // Check rollback eligibility now that attendance was cleared
    const check = await api(t.app, s1.adminToken, 'get', `/students/promotion-batches/${batchId}/rollback-check`);
    expect(check.canRollback).toBe(true);
    expect(check.blockers.length).toBe(0);

    // Execute rollback
    const rollbackRes = await api(t.app, s1.adminToken, 'post', `/students/promotion-batches/${batchId}/rollback`, {
      reason: 'Rollback test: restore previous placements',
    });
    expect(rollbackRes.status).toBe('rolled_back');
    expect(rollbackRes.restoredStudentsCount).toBe(3);

    // Verify nursery student restored to Nursery Class in original session
    const restoredNursery = await Student.findOne({ _id: nurseryStudent._id, schoolId: s1.schoolId }).lean();
    expect(restoredNursery!.sessionId.toString()).toBe(s1.sessionId);
    expect(restoredNursery!.classId.toString()).toBe(nurseryClass._id);
    expect(restoredNursery!.sectionId.toString()).toBe(nurserySecA._id);
    expect(restoredNursery!.status).toBe('active');

    // Verify terminal student restored to Class 10 in original session
    const restoredTerminal = await Student.findOne({ _id: terminalStudent._id, schoolId: s1.schoolId }).lean();
    expect(restoredTerminal!.sessionId.toString()).toBe(s1.sessionId);
    expect(restoredTerminal!.classId.toString()).toBe(terminalClass._id);
    expect(restoredTerminal!.status).toBe('active');

    // Verify target enrollments in nextSession were deleted
    const targetEnrollments = await StudentEnrollment.find({
      schoolId: s1.schoolId,
      studentId: nurseryStudent._id,
      sessionId: nextSession._id,
    }).lean();
    expect(targetEnrollments).toHaveLength(0);

    // Repeated rollback on already rolled back batch is rejected
    await expect(
      api(t.app, s1.adminToken, 'post', `/students/promotion-batches/${batchId}/rollback`, {
        reason: 'Second attempt',
      }),
    ).rejects.toThrow();
  });

  it('delivers complete student academic journey across sessions with session filtering', async () => {
    // 1. Promote nursery student back to nextSession
    await api(t.app, s1.adminToken, 'post', '/students/promotion-batches', {
      fromSessionId: s1.sessionId,
      toSessionId: nextSession._id,
      campusId: s1.campusId,
      items: [
        {
          studentId: nurseryStudent._id,
          action: 'promote',
          toClassId: class1._id,
          toSectionId: nextClass1SecA._id,
          toRollNo: 'C1-10',
          remarks: 'Promoted to Class 1-A',
        },
      ],
    });

    // 2. Add historical records in both sessions for nurseryStudent
    // Past session attendance
    await AttendanceRecord.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: nurseryStudent._id,
      sessionId: s1.sessionId,
      classId: nurseryClass._id,
      sectionId: nurserySecA._id,
      date: new Date('2026-05-10'),
      status: 'present',
    });

    // Past session fee invoice
    await Invoice.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: nurseryStudent._id,
      sessionId: s1.sessionId,
      classId: nurseryClass._id,
      sectionId: nurserySecA._id,
      invoiceNo: 'INV-JOURNEY-01',
      period: '2026-05',
      issueDate: new Date('2026-05-01'),
      dueDate: new Date('2026-05-10'),
      items: [{ name: 'Tuition Fee', amount: 1500 }],
      subtotal: 1500,
      total: 1500,
      paid: 1500,
      balance: 0,
      status: 'paid',
    });

    // Past session exam and marks
    const nurserySub = await api(t.app, s1.ownerToken, 'post', '/academics/subjects', {
      name: 'Rhymes',
      code: 'RHYM',
      classIds: [nurseryClass._id],
    });
    const exam = await api(t.app, s1.ownerToken, 'post', '/exams', {
      sessionId: s1.sessionId,
      name: 'Midterm Nursery Assessment',
      term: 'mid_term',
      classIds: [nurseryClass._id],
    });
    const papers = await api(t.app, s1.ownerToken, 'put', `/exams/${exam._id}/papers`, {
      papers: [{ subjectId: nurserySub._id, classId: nurseryClass._id, maxMarks: 50, passMarks: 20 }],
    });
    await api(t.app, s1.adminToken, 'post', `/exams/${exam._id}/papers/${papers[0]._id}/marks`, {
      sectionId: nurserySecA._id,
      marks: [{ studentId: nurseryStudent._id, obtained: 46 }],
    });

    // 3. Query complete student journey across all sessions
    const journeyAll = await api(t.app, s1.adminToken, 'get', `/students/${nurseryStudent._id}/journey`);
    expect(journeyAll.student._id).toBe(nurseryStudent._id);
    expect(journeyAll.student.admissionNo).toBe(nurseryStudent.admissionNo);
    expect(journeyAll.totalSessionsCount).toBe(2);
    expect(journeyAll.sessions).toHaveLength(2);

    // Verify first session details in journey
    const firstSessionRecord = journeyAll.sessions.find((s: any) => s.enrollment.sessionId === s1.sessionId);
    expect(firstSessionRecord).toBeDefined();
    expect(firstSessionRecord.enrollment.className).toBe('Nursery');
    expect(firstSessionRecord.attendance.present).toBe(1);
    expect(firstSessionRecord.fees.totalBilled).toBe(1500);
    expect(firstSessionRecord.fees.balance).toBe(0);
    expect(firstSessionRecord.examinations.length).toBeGreaterThan(0);
    expect(firstSessionRecord.examinations[0].totalObtainedMarks).toBe(46);
    expect(firstSessionRecord.examinations[0].grade).toBe('A+');

    // 4. Query student journey filtered to target session
    const journeyTarget = await api(
      t.app,
      s1.adminToken,
      'get',
      `/students/${nurseryStudent._id}/journey?sessionId=${nextSession._id}`,
    );
    expect(journeyTarget.sessions).toHaveLength(1);
    expect(journeyTarget.sessions[0].enrollment.sessionId).toBe(nextSession._id);
    expect(journeyTarget.sessions[0].enrollment.className).toBe('Class 1');
    expect(journeyTarget.sessions[0].enrollment.promotionDetails.fromClassName).toBe('Nursery');
  });

  it('enforces multi-tenant isolation across all promotion and journey endpoints', async () => {
    // School 2 admin cannot preview or promote School 1 students
    await expect(
      api(t.app, s2.adminToken, 'post', '/students/promotion-preview', {
        fromSessionId: s1.sessionId,
        toSessionId: nextSession._id,
      }),
    ).rejects.toThrow();

    await expect(
      api(t.app, s2.adminToken, 'post', '/students/promotion-batches', {
        fromSessionId: s1.sessionId,
        toSessionId: nextSession._id,
        campusId: s1.campusId,
        items: [{ studentId: nurseryStudent._id, action: 'promote', toClassId: class1._id, toSectionId: nextClass1SecA._id }],
      }),
    ).rejects.toThrow();

    // School 2 admin cannot access School 1 student's journey
    await expect(api(t.app, s2.adminToken, 'get', `/students/${nurseryStudent._id}/journey`)).rejects.toThrow();
  });
});
