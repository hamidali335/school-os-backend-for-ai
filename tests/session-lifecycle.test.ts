import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { Student, StudentEnrollment } from '../src/modules/students/student.models';
import { Invoice } from '../src/modules/fees/fees.models';
import { migrateSessionEnrollments } from '../scripts/migrate-session-enrollments';

const t = useTestApp();
let s1: SchoolFixture;
let s2: SchoolFixture;

beforeAll(async () => {
  s1 = await buildSchool(t.app, { students: 2 });
  s2 = await buildSchool(t.app, { students: 1 });
});

describe('Phase 1: Academic Session Lifecycle Foundation', () => {
  it('enrols a student and creates an initial StudentEnrollment record', async () => {
    const body = {
      campusId: s1.campusId,
      firstName: 'Bilal',
      lastName: 'Tariq',
      gender: 'male',
      sessionId: s1.sessionId,
      classId: s1.classId,
      sectionId: s1.sectionA,
      rollNo: '101',
      guardians: [{ parent: { name: 'Tariq Mehmood', phone: '+923009988776' }, isPrimary: true }],
    };

    const student = await api(t.app, s1.adminToken, 'post', '/students', body);
    expect(student._id).toBeDefined();
    expect(student.admissionNo).toBeDefined();

    // Verify enrollment record was automatically created
    const enrollments = await api(t.app, s1.adminToken, 'get', `/students/${student._id}/enrollments`);
    expect(enrollments).toHaveLength(1);
    expect(enrollments[0].studentId).toBe(student._id);
    expect(enrollments[0].sessionId._id).toBe(s1.sessionId);
    expect(enrollments[0].classId._id).toBe(s1.classId);
    expect(enrollments[0].sectionId._id).toBe(s1.sectionA);
    expect(enrollments[0].rollNo).toBe('101');
    expect(enrollments[0].status).toBe('active');
  });

  it('prevents duplicate enrollment in the same academic session', async () => {
    const student = await Student.findOne({ schoolId: s1.schoolId }).lean();
    expect(student).not.toBeNull();

    // Direct database write attempting to create duplicate enrollment in same session
    await expect(
      StudentEnrollment.create({
        schoolId: s1.schoolId,
        studentId: student!._id,
        sessionId: student!.sessionId,
        classId: student!.classId,
        sectionId: student!.sectionId,
        campusId: student!.campusId,
        status: 'active',
      }),
    ).rejects.toThrow();
  });

  it('preserves permanent student identity and records multiple session enrollments upon promotion', async () => {
    // 1. Create next academic session
    const nextSession = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
      name: '2027-2028',
      startDate: '2027-04-01',
      endDate: '2028-03-31',
    });

    // 2. Create next class (Class 6) and section (Section 6-A)
    const nextClass = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
      campusId: s1.campusId,
      name: 'Class 6',
      level: 6,
    });
    const nextSection = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
      campusId: s1.campusId,
      classId: nextClass._id,
      sessionId: nextSession._id,
      name: 'A',
      capacity: 35,
    });

    // 3. Pick a student in Class 5 (sectionA)
    const originalStudent = await Student.findOne({
      schoolId: s1.schoolId,
      sectionId: s1.sectionA,
      status: 'active',
    }).lean();
    expect(originalStudent).not.toBeNull();
    const originalStudentId = originalStudent!._id.toString();
    const originalAdmissionNo = originalStudent!.admissionNo;

    // Promote student from Section 5-A to Section 6-A
    const promoteRes = await api(t.app, s1.adminToken, 'post', '/students/promote', {
      fromSectionId: s1.sectionA,
      toSectionId: nextSection._id,
      studentIds: [originalStudentId],
    });
    expect(promoteRes.promoted).toBe(1);

    // 4. Verify permanent student identity is preserved
    const updatedStudent = await Student.findOne({ _id: originalStudentId, schoolId: s1.schoolId }).lean();
    expect(updatedStudent!._id.toString()).toBe(originalStudentId);
    expect(updatedStudent!.admissionNo).toBe(originalAdmissionNo);
    // Current placement pointer is now Section 6-A in Session 2027-2028
    expect(updatedStudent!.sectionId.toString()).toBe(nextSection._id);
    expect(updatedStudent!.classId.toString()).toBe(nextClass._id);
    expect(updatedStudent!.sessionId.toString()).toBe(nextSession._id);

    // 5. Verify enrollment history has both the previous and new session enrollments
    const enrollments = await api(t.app, s1.adminToken, 'get', `/students/${originalStudentId}/enrollments`);
    expect(enrollments.length).toBeGreaterThanOrEqual(2);

    const prevEnrollment = enrollments.find((e: any) => e.sessionId._id === s1.sessionId);
    const newEnrollment = enrollments.find((e: any) => e.sessionId._id === nextSession._id);

    expect(prevEnrollment).toBeDefined();
    expect(prevEnrollment.status).toBe('promoted');
    expect(prevEnrollment.sectionId._id).toBe(s1.sectionA);

    expect(newEnrollment).toBeDefined();
    expect(newEnrollment.status).toBe('active');
    expect(newEnrollment.sectionId._id).toBe(nextSection._id);
    expect(newEnrollment.classId._id).toBe(nextClass._id);
    expect(newEnrollment.promotionDetails?.fromSectionId).toBe(s1.sectionA);
  });

  it('preserves historical report cards for past sessions even after promotion', async () => {
    // Student promoted to Class 6 in the previous test:
    // Create an exam in the original session for Class 5
    const exam = await api(t.app, s1.adminToken, 'post', '/exams', {
      sessionId: s1.sessionId,
      name: 'Annual Exam 2026',
      term: 'final_term',
      classIds: [s1.classId],
    });

    const papers = await api(t.app, s1.adminToken, 'put', `/exams/${exam._id}/papers`, {
      papers: [
        {
          classId: s1.classId,
          subjectId: s1.mathId,
          maxMarks: 100,
          passMarks: 40,
        },
      ],
    });
    const paperId = papers[0]._id;

    // Pick the student who was promoted
    const promotedStudent = await Student.findOne({
      schoolId: s1.schoolId,
      sessionId: { $ne: s1.sessionId },
    }).lean();
    expect(promotedStudent).not.toBeNull();

    // Enter marks for Section 5-A
    await api(t.app, s1.adminToken, 'post', `/exams/${exam._id}/papers/${paperId}/marks`, {
      sectionId: s1.sectionA,
      marks: [{ studentId: promotedStudent!._id.toString(), obtained: 85 }],
    });

    // Fetch report card for this promoted student
    const reportCard = await api(t.app, s1.adminToken, 'get', `/exams/${exam._id}/report-cards/${promotedStudent!._id}`);
    expect(reportCard.student._id).toBe(promotedStudent!._id.toString());
    expect(reportCard.result.totalObtained).toBe(85);
    expect(reportCard.result.grade).toBe('A');
  });

  it('preserves historical attendance and fee records across promotions', async () => {
    const student = await Student.findOne({
      schoolId: s1.schoolId,
      sessionId: { $ne: s1.sessionId },
    }).lean();
    expect(student).not.toBeNull();
    const stId = student!._id.toString();

    // Mark attendance in the original session date
    await api(t.app, s1.adminToken, 'post', '/attendance/mark', {
      sectionId: s1.sectionA,
      date: '2026-05-15',
      finalize: false,
      records: [{ studentId: stId, status: 'present' }],
    });

    // Check attendance for this student via student attendance history
    const attHistory = await api(t.app, s1.adminToken, 'get', `/attendance/students/${stId}?from=2026-05-01&to=2026-05-31`);
    expect(attHistory.records).toBeDefined();
    expect(attHistory.records.some((r: any) => r.status === 'present')).toBe(true);

    // Create an invoice for this student in the previous session
    const invoice = await Invoice.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      studentId: stId,
      sessionId: s1.sessionId,
      classId: s1.classId,
      sectionId: s1.sectionA,
      invoiceNo: `INV-TEST-${Date.now()}`,
      period: '2026-05',
      issueDate: new Date('2026-05-01'),
      dueDate: new Date('2026-05-10'),
      items: [{ name: 'Lab Fee', amount: 500 }],
      subtotal: 500,
      total: 500,
      balance: 500,
      status: 'unpaid',
    });
    expect(invoice._id).toBeDefined();
    expect(invoice.balance).toBe(500);

    // Verify invoice remains accessible
    const fetchedInvoice = await api(t.app, s1.accountantToken, 'get', `/fees/invoices/${invoice._id}`);
    expect(fetchedInvoice.studentId._id ?? fetchedInvoice.studentId).toBe(stId);
    expect(fetchedInvoice.balance).toBe(500);
  });

  it('synchronizes current session enrollment on student updates and status changes', async () => {
    const student = await Student.findOne({ schoolId: s1.schoolId, status: 'active' }).lean();
    expect(student).not.toBeNull();
    const stId = student!._id.toString();

    // 1. Update roll number
    await api(t.app, s1.adminToken, 'patch', `/students/${stId}`, {
      rollNo: '999',
    });

    const enrollmentsAfterRoll = await api(t.app, s1.adminToken, 'get', `/students/${stId}/enrollments`);
    const currentEnr = enrollmentsAfterRoll.find((e: any) => e.sessionId._id === student!.sessionId.toString());
    expect(currentEnr.rollNo).toBe('999');

    // 2. Change student status to left
    await api(t.app, s1.adminToken, 'post', `/students/${stId}/status`, {
      status: 'left',
      reason: 'Relocated to another city',
    });

    const enrollmentsAfterStatus = await api(t.app, s1.adminToken, 'get', `/students/${stId}/enrollments`);
    const updatedEnr = enrollmentsAfterStatus.find((e: any) => e.sessionId._id === student!.sessionId.toString());
    expect(updatedEnr.status).toBe('left');
    expect(updatedEnr.statusReason).toBe('Relocated to another city');
  });

  it('enforces tenant isolation across school enrollments', async () => {
    // School 1 students
    const s1Students = await Student.find({ schoolId: s1.schoolId }).lean();
    expect(s1Students.length).toBeGreaterThan(0);

    // School 2 admin cannot access School 1 student enrollments
    const res = await request(t.app)
      .get(`/api/v1/students/${s1Students[0]._id}/enrollments`)
      .set(auth(s2.adminToken));

    expect(res.status).toBe(404);

    // Direct database query scoped to School 2 finds 0 enrollments of School 1
    const s2EnrollmentsOfS1Student = await StudentEnrollment.find({
      schoolId: s2.schoolId,
      studentId: s1Students[0]._id,
    });
    expect(s2EnrollmentsOfS1Student).toHaveLength(0);
  });

  it('runs migration idempotently without creating duplicate enrollments', async () => {
    // Run migration dry-run first
    const dryRun = await migrateSessionEnrollments(false);
    expect(dryRun.totalStudents).toBeGreaterThan(0);

    // Run migration with --apply
    const run1 = await migrateSessionEnrollments(true);
    expect(run1.totalStudents).toBeGreaterThan(0);

    // Run migration with --apply second time (idempotency check)
    const run2 = await migrateSessionEnrollments(true);
    expect(run2.created).toBe(0);
    expect(run2.alreadyEnrolled).toBe(run2.totalStudents);
  });
});
