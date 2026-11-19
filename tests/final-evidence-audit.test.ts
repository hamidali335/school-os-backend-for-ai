import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { AcademicSession, SchoolClass, Section, Subject } from '../src/modules/academics/academics.models';
import { FeeHead, FeeStructure, Invoice, Payment } from '../src/modules/fees/fees.models';
import { Student, StudentEnrollment, PromotionBatch } from '../src/modules/students/student.models';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Exam, ExamPaper, Mark } from '../src/modules/examinations/exam.models';
import { Homework, HomeworkSubmission } from '../src/modules/homework/homework.models';
import { LeaveRequest } from '../src/modules/leave/leave.model';
import { User } from '../src/modules/users/user.model';
import { previousDues, challanData } from '../src/modules/fees/family-voucher';
import { checkPromotionBatchRollback, rollbackPromotionBatch } from '../src/modules/students/promotion.service';
import { getStudentJourney } from '../src/modules/students/student-journey.service';

const t = useTestApp();
let s: SchoolFixture;
let nextSession: any;
let nextSectionA: any;
let studentDoc: any;
let student2Doc: any;
let ownerUserId: any;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
  studentDoc = await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean();
  student2Doc = await Student.findOne({ schoolId: s.schoolId, _id: s.students[1] }).lean();

  const ownerUser = await User.findOne({ schoolId: s.schoolId, email: s.ownerEmail }).lean();
  ownerUserId = ownerUser?._id;

  // Create next academic session
  nextSession = await api(t.app, s.ownerToken, 'post', '/academics/sessions', {
    name: '2027-2028',
    startDate: '2027-04-01',
    endDate: '2028-03-31',
  });

  // Create Section A in nextSession
  nextSectionA = await api(t.app, s.ownerToken, 'post', '/academics/sections', {
    campusId: s.campusId,
    classId: s.classId,
    sessionId: nextSession._id,
    name: 'A',
    capacity: 30,
  });
});

describe('1. Financial Integrity & Previous Dues Lifecycle Verification', () => {
  let invUnpaid: any;
  let invPartial: any;
  let invFullyPaid: any;
  let invNewSession: any;

  it('sets up unpaid, partially paid, and fully paid invoices in historical session', async () => {
    // 1. Unpaid invoice: 5,000 PKR
    invUnpaid = await Invoice.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: studentDoc._id,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      invoiceNo: 'INV-HIST-001',
      kind: 'regular',
      period: '2026-05',
      issueDate: new Date('2026-05-01'),
      dueDate: new Date('2026-05-10'),
      items: [{ name: 'Tuition Fee', amount: 5000 }],
      subtotal: 5000,
      total: 5000,
      paid: 0,
      balance: 5000,
      status: 'unpaid',
    });

    // 2. Partially paid invoice: 5,000 PKR (2,000 paid, 3,000 balance)
    invPartial = await Invoice.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: studentDoc._id,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      invoiceNo: 'INV-HIST-002',
      kind: 'regular',
      period: '2026-06',
      issueDate: new Date('2026-06-01'),
      dueDate: new Date('2026-06-10'),
      items: [{ name: 'Tuition Fee', amount: 5000 }],
      subtotal: 5000,
      total: 5000,
      paid: 0,
      balance: 5000,
      status: 'unpaid',
    });

    // Make partial payment of 2,000 on invPartial
    const partPayRes = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invPartial._id}/payments`, {
      amount: 2000,
      method: 'cash',
      reference: 'PART-001',
    });
    expect(partPayRes.invoice.balance).toBe(3000);
    expect(partPayRes.invoice.status).toBe('partial');
    expect(partPayRes.payment.receiptNo).toBeTruthy();

    // 3. Fully paid invoice: 5,000 PKR (5,000 paid, 0 balance)
    invFullyPaid = await Invoice.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: studentDoc._id,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      invoiceNo: 'INV-HIST-003',
      kind: 'regular',
      period: '2026-07',
      issueDate: new Date('2026-07-01'),
      dueDate: new Date('2026-07-10'),
      items: [{ name: 'Tuition Fee', amount: 5000 }],
      subtotal: 5000,
      total: 5000,
      paid: 0,
      balance: 5000,
      status: 'unpaid',
    });

    // Pay full 5,000 on invFullyPaid
    const fullPayRes = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invFullyPaid._id}/payments`, {
      amount: 5000,
      method: 'cash',
      reference: 'FULL-001',
    });
    expect(fullPayRes.invoice.balance).toBe(0);
    expect(fullPayRes.invoice.status).toBe('paid');
  });

  it('correctly aggregates multiple outstanding invoices in previousDues (excluding fully paid)', async () => {
    // 4. Create new-session invoice: 6,000 PKR
    invNewSession = await Invoice.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: studentDoc._id,
      sessionId: nextSession._id,
      classId: s.classId,
      sectionId: s.sectionA,
      invoiceNo: 'INV-NEW-001',
      kind: 'regular',
      period: '2027-04',
      issueDate: new Date('2027-04-01'),
      dueDate: new Date('2027-04-10'),
      items: [{ name: 'Tuition Fee (New Session)', amount: 6000 }],
      subtotal: 6000,
      total: 6000,
      paid: 0,
      balance: 6000,
      status: 'unpaid',
    });

    // Check previousDues for invNewSession
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const dues = await previousDues(ctx, invNewSession);
    // Unpaid (5,000) + Partial (3,000) = 8,000. Fully paid (0) is excluded.
    expect(dues.amount).toBe(8000);
    expect(dues.invoices).toHaveLength(2);
    expect(dues.invoices.map((i) => i.invoiceNo).sort()).toEqual(['INV-HIST-001', 'INV-HIST-002']);

    // Challan figures verification
    const cData = await challanData(ctx, invNewSession._id.toString(), undefined, { withPreviousDues: true });
    expect(cData.total).toBe(6000);
    expect(cData.balance).toBe(6000);
    expect(cData.previousDues?.amount).toBe(8000);
  });

  it('prevents direct overpayment on the new invoice when attempting to lump-sum pay previous dues', async () => {
    // Attempting to record 14,000 payment directly against invNewSession (balance 6,000)
    const overpayRes = await request(t.app)
      .post(`/api/v1/fees/invoices/${invNewSession._id}/payments`)
      .set(auth(s.accountantToken))
      .send({
        amount: 14000,
        method: 'cash',
      });

    expect(overpayRes.status).toBe(422);
    expect(overpayRes.body.error.code).toBe('OVERPAYMENT');
  });

  it('settles previous dues against their original invoices, ensuring exact allocation and non-duplication', async () => {
    // 1. Settle invUnpaid (5,000)
    const pay1 = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invUnpaid._id}/payments`, {
      amount: 5000,
      method: 'bank_transfer',
      reference: 'BANK-UNPAID',
    });
    expect(pay1.invoice.balance).toBe(0);
    expect(pay1.invoice.status).toBe('paid');

    // 2. Settle remaining 3,000 on invPartial
    const pay2 = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invPartial._id}/payments`, {
      amount: 3000,
      method: 'bank_transfer',
      reference: 'BANK-PARTIAL-FINAL',
    });
    expect(pay2.invoice.balance).toBe(0);
    expect(pay2.invoice.status).toBe('paid');

    // 3. Settle new session invoice (6,000)
    const pay3 = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invNewSession._id}/payments`, {
      amount: 6000,
      method: 'cash',
      reference: 'CASH-NEW-SESSION',
    });
    expect(pay3.invoice.balance).toBe(0);
    expect(pay3.invoice.status).toBe('paid');

    // 4. Verify previousDues now evaluates to 0
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;
    const duesAfter = await previousDues(ctx, invNewSession);
    expect(duesAfter.amount).toBe(0);
    expect(duesAfter.invoices).toHaveLength(0);

    // 5. Verify cannot be collected twice: attempting further payment throws 409 settled
    const extraRes = await request(t.app)
      .post(`/api/v1/fees/invoices/${invUnpaid._id}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1000, method: 'cash' });
    expect(extraRes.status).toBe(409);

    // 6. Ledger reconciliation: all invoices, payments, and receipts reconcile
    const ledger = await api(t.app, s.accountantToken, 'get', `/fees/students/${studentDoc._id}/ledger`);
    // Total billed: 5000 + 5000 + 5000 + 6000 = 21000
    // Total paid: 5000 + (2000+3000) + 5000 + 6000 = 21000
    // Outstanding: 0
    expect(ledger.summary.totalBilled).toBe(21000);
    expect(ledger.summary.totalPaid).toBe(21000);
    expect(ledger.summary.outstanding).toBe(0);
  });
});

describe('2. Promotion Rollback Safety & Dependency Guards', () => {
  let promoBatch: any;
  let targetEnrollment: any;

  it('promotes student2 to next session and verifies batch creation', async () => {
    // Promote student2Doc to nextSession
    const execRes = await api(t.app, s.ownerToken, 'post', '/students/promotion-batches', {
      fromSessionId: s.sessionId,
      toSessionId: nextSession._id,
      campusId: s.campusId,
      items: [
        {
          studentId: student2Doc._id.toString(),
          action: 'promote',
          toClassId: s.classId,
          toSectionId: nextSectionA._id,
        },
      ],
    });

    expect(execRes.totalPromoted).toBe(1);
    promoBatch = await PromotionBatch.findOne({ schoolId: s.schoolId, _id: execRes.batchId }).lean();
    expect(promoBatch).toBeTruthy();
    expect(promoBatch.status).toBe('committed');

    targetEnrollment = await StudentEnrollment.findOne({
      schoolId: s.schoolId,
      studentId: student2Doc._id,
      sessionId: nextSession._id,
    }).lean();
    expect(targetEnrollment).toBeTruthy();
  });

  it('blocks rollback when dependent attendance exists in target session', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    // Create target session attendance
    const att: any = await AttendanceRecord.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: student2Doc._id,
      sessionId: nextSession._id,
      classId: s.classId,
      sectionId: nextSectionA._id,
      date: new Date('2027-04-05'),
      status: 'present',
    });

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers[0].attendanceCount).toBe(1);

    // Rollback attempt throws conflict
    await expect(rollbackPromotionBatch(ctx, promoBatch._id.toString(), { reason: 'Test' })).rejects.toThrow();

    // Clean up attendance record for next guard test
    await AttendanceRecord.deleteOne({ schoolId: s.schoolId, _id: att._id });
  });

  it('blocks rollback when dependent fee invoice exists in target session', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const inv = await Invoice.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: student2Doc._id,
      sessionId: nextSession._id,
      classId: s.classId,
      sectionId: nextSectionA._id,
      invoiceNo: 'INV-TEST-PROMO-BLOCK',
      kind: 'regular',
      period: '2027-04',
      issueDate: new Date('2027-04-01'),
      dueDate: new Date('2027-04-10'),
      items: [{ name: 'Tuition', amount: 5000 }],
      subtotal: 5000,
      total: 5000,
      paid: 0,
      balance: 5000,
      status: 'unpaid',
    });

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers[0].invoiceCount).toBe(1);

    await Invoice.deleteOne({ schoolId: s.schoolId, _id: inv._id });
  });

  it('blocks rollback when dependent exam mark exists in target session', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const exam = await Exam.create({
      schoolId: s.schoolId,
      sessionId: nextSession._id,
      name: 'Mid Term 2027',
      term: 'mid_term',
      status: 'published',
    });

    const paper = await ExamPaper.create({
      schoolId: s.schoolId,
      examId: exam._id,
      classId: s.classId,
      subjectId: s.mathId,
      maxMarks: 100,
      passMarks: 40,
    });

    const mark = await Mark.create({
      schoolId: s.schoolId,
      examId: exam._id,
      paperId: paper._id,
      studentId: student2Doc._id,
      sectionId: nextSectionA._id,
      classId: s.classId,
      subjectId: s.mathId,
      obtained: 85,
    });

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers[0].markCount).toBe(1);

    await Mark.deleteOne({ schoolId: s.schoolId, _id: mark._id });
    await ExamPaper.deleteOne({ schoolId: s.schoolId, _id: paper._id });
    await Exam.deleteOne({ schoolId: s.schoolId, _id: exam._id });
  });

  it('blocks rollback when dependent homework submission exists in target session', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const hw: any = await Homework.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      sessionId: nextSession._id,
      sectionId: nextSectionA._id,
      subjectId: s.mathId,
      title: 'Math HW 1',
      description: 'Complete all exercises on page 42',
      assignedOn: new Date('2027-04-10'),
      dueDate: new Date('2027-04-12'),
      createdBy: ownerUserId,
    });

    const sub: any = await HomeworkSubmission.create({
      schoolId: s.schoolId,
      homeworkId: hw._id,
      studentId: student2Doc._id,
      status: 'submitted',
    });

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers[0].homeworkCount).toBe(1);

    await HomeworkSubmission.deleteOne({ schoolId: s.schoolId, _id: sub._id });
    await Homework.deleteOne({ schoolId: s.schoolId, _id: hw._id });
  });

  it('blocks rollback when dependent leave request exists in target session date range', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const leave = await LeaveRequest.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      studentId: student2Doc._id,
      classId: s.classId,
      sectionId: nextSectionA._id,
      from: new Date('2027-05-01'),
      to: new Date('2027-05-03'),
      days: 3,
      reason: 'Family event in new session',
      status: 'approved',
      requestedBy: ownerUserId,
      requestedByName: 'Parent',
    });

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(false);
    expect(check.blockers[0].leaveCount).toBe(1);

    await LeaveRequest.deleteOne({ schoolId: s.schoolId, _id: leave._id });
  });

  it('successfully rolls back when all dependent records are clear, preserving historical data', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const check = await checkPromotionBatchRollback(ctx, promoBatch._id.toString());
    expect(check.canRollback).toBe(true);
    expect(check.blockers).toHaveLength(0);

    const rollbackRes = await rollbackPromotionBatch(ctx, promoBatch._id.toString(), {
      reason: 'Administrative test rollback',
    });
    expect(rollbackRes.status).toBe('rolled_back');

    // Target enrollment is deleted
    const targetAfter = await StudentEnrollment.findOne({
      schoolId: s.schoolId,
      studentId: student2Doc._id,
      sessionId: nextSession._id,
    }).lean();
    expect(targetAfter).toBeNull();

    // Source enrollment is restored to active
    const sourceAfter = await StudentEnrollment.findOne({
      schoolId: s.schoolId,
      studentId: student2Doc._id,
      sessionId: s.sessionId,
    }).lean();
    expect(sourceAfter?.status).toBe('active');

    // Student document restored to source session
    const studentAfter = await Student.findOne({
      schoolId: s.schoolId,
      _id: student2Doc._id,
    }).lean();
    expect(studentAfter?.sessionId?.toString()).toBe(s.sessionId);
  });
});

describe('3. Historical Student Journey Completeness Audit', () => {
  it('retrieves student journey and verifies all historical fields', async () => {
    const ctx = {
      schoolId: s.schoolId,
      userId: ownerUserId,
      role: 'owner',
      campusIds: [s.campusId],
    } as any;

    const journey = await getStudentJourney(ctx, studentDoc._id.toString());

    // 1. Admission details
    expect(journey.student.admissionNo).toBeTruthy();
    expect(journey.student.initialSession?.name).toBe('2026-2027');

    // 2. Permanent identity & Parent relationship
    expect(journey.student.guardians.length).toBeGreaterThan(0);
    expect(journey.student.guardians[0].name).toBeTruthy();

    // 3. Multi-session enrollments
    expect(journey.sessions.length).toBeGreaterThan(0);
    const firstSession = journey.sessions[0];
    expect(firstSession.enrollment.sessionName).toBe('2026-2027');
    expect(firstSession.enrollment.className).toBe('Class 5');

    // 4. Fees history
    expect(firstSession.fees.invoicesCount).toBeGreaterThan(0);
    expect(firstSession.fees.payments.length).toBeGreaterThan(0);

    // 5. Academics
    expect(firstSession.academics.subjects.length).toBeGreaterThan(0);
  });
});
