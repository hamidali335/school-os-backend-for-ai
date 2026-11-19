import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { useTestApp } from './helpers';
import { formatDateOnly, parseDateOnly } from '../src/utils/dates';
import { AcademicSession, SchoolClass, Section } from '../src/modules/academics/academics.models';
import {
  addYearsPreservingMonthDay,
  computeNextSessionDates,
  deriveNextSessionName,
} from '../src/modules/academics/session-generator.service';
import { FeeHead, FeeStructure, Invoice, Payment } from '../src/modules/fees/fees.models';
import { FeeTemplate } from '../src/modules/fees/fee-template';
import { Student, StudentEnrollment } from '../src/modules/students/student.models';
import { School } from '../src/modules/schools/school.model';
import { previousDues } from '../src/modules/fees/family-voucher';

const t = useTestApp();
let s1: SchoolFixture;
let s2: SchoolFixture;

let class1: any;
let class2: any;
let class1SecA: any;
let class2SecA: any;

let tuitionHead: any;
let examHead: any;
let inactiveHead: any;

let studentActive: any;
let studentRepeating: any;
let studentGraduated: any;
let studentLeft: any;

beforeAll(async () => {
  s1 = await buildSchool(t.app, { students: 1 });
  s2 = await buildSchool(t.app, { students: 1 });

  // 1. Classes in School 1
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

  // 2. Sections in current session
  class1SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class1._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 35,
  });

  class2SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class2._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 35,
  });

  // 3. Fee Heads
  tuitionHead = await api(t.app, s1.ownerToken, 'post', '/fees/heads', {
    name: 'Tuition Fee',
    code: 'TUIT',
    frequency: 'monthly',
    billing: 'class',
    concessionApplies: true,
  });

  examHead = await api(t.app, s1.ownerToken, 'post', '/fees/heads', {
    name: 'Examination Fee',
    code: 'EXAM',
    frequency: 'term',
    billing: 'class',
  });

  inactiveHead = await api(t.app, s1.ownerToken, 'post', '/fees/heads', {
    name: 'Discontinued Activity',
    code: 'DISC',
    frequency: 'monthly',
    billing: 'class',
  });
  // Deactivate inactiveHead
  await FeeHead.updateOne({ schoolId: s1.schoolId, _id: inactiveHead._id }, { $set: { isActive: false } });

  // 4. Fee Structures in current session
  await api(t.app, s1.ownerToken, 'put', '/fees/structures', {
    sessionId: s1.sessionId,
    classId: class1._id,
    name: 'Class 1 Structure 2025',
    items: [
      { feeHeadId: tuitionHead._id, amount: 5000 },
      { feeHeadId: examHead._id, amount: 1500, billingMonths: [3, 9] },
      { feeHeadId: inactiveHead._id, amount: 800 },
    ],
  });

  await api(t.app, s1.ownerToken, 'put', '/fees/structures', {
    sessionId: s1.sessionId,
    classId: class2._id,
    name: 'Class 2 Structure 2025',
    items: [
      { feeHeadId: tuitionHead._id, amount: 6000 },
      { feeHeadId: examHead._id, amount: 1800, billingMonths: [3, 9] },
    ],
  });
});

describe('Phase 3: Automatic Session Generation, Fee Rollover & Billing Engine', () => {
  describe('Task A: Automatic Next-Session Generation & Leap-Year Date Calculations', () => {
    it('correctly handles leap years when advancing session dates (Feb 29 -> Feb 28)', () => {
      // Leap year start date: 2024-02-29
      const leapStart = new Date(Date.UTC(2024, 1, 29)); // 29 Feb 2024
      const nextNonLeap = addYearsPreservingMonthDay(leapStart, 1);
      expect(formatDateOnly(nextNonLeap)).toBe('2025-02-28');

      // Non-leap to leap year: 2023-02-28 (last day of Feb) -> 2024-02-29
      const nonLeapEnd = new Date(Date.UTC(2023, 1, 28));
      const nextLeap = addYearsPreservingMonthDay(nonLeapEnd, 1);
      expect(formatDateOnly(nextLeap)).toBe('2024-02-29');
    });

    it('correctly preserves month boundaries for April-March, August-July and Jan-Dec sessions', () => {
      // 1 April 2025 - 31 March 2026
      const aprSession = {
        name: '2025-2026',
        startDate: parseDateOnly('2025-04-01'),
        endDate: parseDateOnly('2026-03-31'),
      };
      const nextApr = computeNextSessionDates(aprSession);
      expect(nextApr.name).toBe('2026-2027');
      expect(formatDateOnly(nextApr.startDate)).toBe('2026-04-01');
      expect(formatDateOnly(nextApr.endDate)).toBe('2027-03-31');

      // 1 August 2025 - 31 July 2026
      const augSession = {
        name: 'Session 2025/2026',
        startDate: parseDateOnly('2025-08-01'),
        endDate: parseDateOnly('2026-07-31'),
      };
      const nextAug = computeNextSessionDates(augSession);
      expect(nextAug.name).toBe('Session 2026/2027');
      expect(formatDateOnly(nextAug.startDate)).toBe('2026-08-01');
      expect(formatDateOnly(nextAug.endDate)).toBe('2027-07-31');

      // 1 Jan 2025 - 31 Dec 2025
      const janSession = {
        name: '2025',
        startDate: parseDateOnly('2025-01-01'),
        endDate: parseDateOnly('2025-12-31'),
      };
      const nextJan = computeNextSessionDates(janSession);
      expect(nextJan.name).toBe('2026');
      expect(formatDateOnly(nextJan.startDate)).toBe('2026-01-01');
      expect(formatDateOnly(nextJan.endDate)).toBe('2026-12-31');
    });

    it('GET /academics/sessions/preview-next returns proposed session details without modifying DB', async () => {
      const res = await api(t.app, s1.ownerToken, 'get', '/academics/sessions/preview-next');
      expect(res.sourceSession).toBeDefined();
      expect(res.sourceSession.name).toBeDefined();
      expect(res.proposedSession).toBeDefined();
      expect(res.alreadyGenerated).toBe(false);
      expect(res.schoolTimezone).toBe('Asia/Karachi');
    });

    it('POST /academics/sessions/generate-next creates next session in planned status idempotently', async () => {
      const created = await api(t.app, s1.ownerToken, 'post', '/academics/sessions/generate-next', {});
      expect(created._id).toBeDefined();
      expect(created.status).toBe('planned');
      expect(created.isCurrent).toBe(false);
      expect(created.generationSource).toBe('manual');
      expect(created.feeRolloverStatus).toBe('none');

      // Retrying generation returns the exact same session (idempotency check)
      const retried = await api(t.app, s1.ownerToken, 'post', '/academics/sessions/generate-next', {});
      expect(retried._id).toBe(created._id);
      expect(retried.name).toBe(created.name);

      // Verify preview now indicates alreadyGenerated: true
      const previewAfter = await api(t.app, s1.ownerToken, 'get', '/academics/sessions/preview-next');
      expect(previewAfter.alreadyGenerated).toBe(true);
      expect(previewAfter.existingSession._id).toBe(created._id);
    });

    it('POST /academics/sessions/:id/activate safely sets current session and closes previous active session', async () => {
      // Create a planned session to test activation
      const planned = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
        name: '2028-2029',
        startDate: '2028-04-01',
        endDate: '2029-03-31',
        status: 'planned',
      });
      expect(planned.status).toBe('planned');
      expect(planned.isCurrent).toBe(false);

      const activated = await api(
        t.app,
        s1.ownerToken,
        'post',
        `/academics/sessions/${planned._id}/activate`,
      );
      expect(activated.isCurrent).toBe(true);
      expect(activated.status).toBe('active');

      // Verify School settings.currentSessionId was updated
      const school = await School.findById(s1.schoolId).lean();
      expect(school?.settings?.currentSessionId?.toString()).toBe(planned._id);

      // Verify previous session was closed
      const prev = await AcademicSession.findOne({ schoolId: s1.schoolId, _id: s1.sessionId }).lean();
      expect(prev?.isCurrent).toBe(false);
      expect(prev?.status).toBe('closed');

      // Switch back to s1.sessionId for remaining tests
      await api(t.app, s1.ownerToken, 'post', `/academics/sessions/${s1.sessionId}/activate`);
    });
  });

  describe('Task B: Fee Structure Carry-Forward & Percentage Adjustments', () => {
    let targetSession: any;

    beforeAll(async () => {
      // Find or create target planned session in s1
      const found = await AcademicSession.findOne({
        schoolId: s1.schoolId,
        _id: { $ne: s1.sessionId },
      }).lean();
      if (found) {
        targetSession = found;
      } else {
        targetSession = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
          name: '2026-2027',
          startDate: '2026-04-01',
          endDate: '2027-03-31',
          status: 'planned',
        });
      }
    });

    it('POST /fees/rollover-preview shows original vs proposed amounts with percentage adjustment', async () => {
      const preview = await api(t.app, s1.ownerToken, 'post', '/fees/rollover-preview', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
        adjustments: {
          defaultPercent: 10, // 10% global increase
        },
      });

      expect(preview.fromSession._id).toBe(s1.sessionId);
      expect(preview.toSession._id).toBe(targetSession._id.toString());
      expect(preview.structures.length).toBe(3);

      // Class 1 structure: Tuition 5000 + 10% = 5500; Exam 1500 + 10% = 1650; Inactive head omitted!
      const c1Preview = preview.structures.find((s: any) => s.classId === class1._id);
      expect(c1Preview).toBeDefined();
      expect(c1Preview.originalMonthlyTotal).toBe(5000);
      expect(c1Preview.proposedMonthlyTotal).toBe(5500);

      // Verify inactive head is excluded
      const inactiveInItems = c1Preview.items.find((i: any) => i.feeHeadId === inactiveHead._id);
      expect(inactiveInItems).toBeUndefined();

      // Class 2 structure: Tuition 6000 + 10% = 6600
      const c2Preview = preview.structures.find((s: any) => s.classId === class2._id);
      expect(c2Preview.originalMonthlyTotal).toBe(6000);
      expect(c2Preview.proposedMonthlyTotal).toBe(6600);
      // Net monthly difference across all 3 classes (buildSchool default class +500, class 1 +500, class 2 +600 = 1600)
      expect(preview.summary.netMonthlyDifference).toBe(1600);
    });

    it('POST /fees/rollover-preview supports specific head adjustments and rounding', async () => {
      const preview = await api(t.app, s1.ownerToken, 'post', '/fees/rollover-preview', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
        adjustments: {
          defaultPercent: 10,
          feeHeadAdjustments: {
            [tuitionHead._id]: 15, // Tuition increases by 15%
          },
        },
      });

      const c1 = preview.structures.find((s: any) => s.classId === class1._id);
      const tuitionItem = c1.items.find((i: any) => i.feeHeadId === tuitionHead._id);
      // 5000 * 1.15 = 5750
      expect(tuitionItem.proposedAmount).toBe(5750);

      const examItem = c1.items.find((i: any) => i.feeHeadId === examHead._id);
      // 1500 * 1.10 = 1650
      expect(examItem.proposedAmount).toBe(1650);
    });

    it('POST /fees/rollover carries forward structures to target session without altering source structures', async () => {
      const result = await api(t.app, s1.ownerToken, 'post', '/fees/rollover', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
        adjustments: {
          defaultPercent: 10,
        },
      });

      expect(result.createdCount).toBe(3);
      expect(result.skippedCount).toBe(0);

      // Verify target session structures in DB
      const targetC1 = await FeeStructure.findOne({
        schoolId: s1.schoolId,
        sessionId: targetSession._id,
        classId: class1._id,
      }).lean();
      expect(targetC1).toBeDefined();
      const targetTuition = targetC1?.items.find((i) => i.feeHeadId.toString() === tuitionHead._id);
      expect(targetTuition?.amount).toBe(5500);

      // Inactive head was excluded
      const targetInactive = targetC1?.items.find((i) => i.feeHeadId.toString() === inactiveHead._id);
      expect(targetInactive).toBeUndefined();

      // Crucial: Source session structure in s1 was NEVER altered!
      const sourceC1 = await FeeStructure.findOne({
        schoolId: s1.schoolId,
        sessionId: s1.sessionId,
        classId: class1._id,
      }).lean();
      const sourceTuition = sourceC1?.items.find((i) => i.feeHeadId.toString() === tuitionHead._id);
      expect(sourceTuition?.amount).toBe(5000);

      // Verify target session feeRolloverStatus is updated
      const updatedTargetSession = await AcademicSession.findOne({ schoolId: s1.schoolId, _id: targetSession._id }).lean();
      expect(updatedTargetSession?.feeRolloverStatus).toBe('customized');
    });

    it('POST /fees/rollover is idempotent on retries and respects overwriteExisting', async () => {
      // Calling rollover again without overwriteExisting skips already existing structures
      const retryResult = await api(t.app, s1.ownerToken, 'post', '/fees/rollover', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
        overwriteExisting: false,
      });

      expect(retryResult.createdCount).toBe(0);
      expect(retryResult.skippedCount).toBe(3);

      // Calling rollover with overwriteExisting updates them
      const overwriteResult = await api(t.app, s1.ownerToken, 'post', '/fees/rollover', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
        overwriteExisting: true,
        adjustments: { defaultPercent: 20 },
      });

      expect(overwriteResult.updatedCount).toBe(3);
      const updatedTargetC1 = await FeeStructure.findOne({
        schoolId: s1.schoolId,
        sessionId: targetSession._id,
        classId: class1._id,
      }).lean();
      const updatedTuition = updatedTargetC1?.items.find((i) => i.feeHeadId.toString() === tuitionHead._id);
      // 5000 + 20% = 6000
      expect(updatedTuition?.amount).toBe(6000);
    });
  });

  describe('Task C: New-Session Billing & Challans Engine', () => {
    let billingSession: any;
    let targetClass1SecA: any;

    beforeAll(async () => {
      // Find the rolled-over session
      billingSession = await AcademicSession.findOne({
        schoolId: s1.schoolId,
        _id: { $ne: s1.sessionId },
      }).lean();

      // Create section in target session for Class 1
      targetClass1SecA = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
        campusId: s1.campusId,
        classId: class1._id,
        sessionId: billingSession._id,
        name: 'A',
        capacity: 35,
      });

      // Create students with various enrollment statuses
      // 1. Active student in target session
      studentActive = await api(t.app, s1.ownerToken, 'post', '/students', {
        campusId: s1.campusId,
        firstName: 'Active',
        lastName: 'Student',
        gender: 'male',
        admissionNo: 'ADM-ACT-01',
        sessionId: s1.sessionId,
        classId: class1._id,
        sectionId: class1SecA._id,
      });
      // Enroll in target session
      await StudentEnrollment.create({
        schoolId: s1.schoolId,
        studentId: studentActive._id,
        sessionId: billingSession._id,
        classId: class1._id,
        sectionId: targetClass1SecA._id,
        campusId: s1.campusId,
        status: 'active',
      });

      // 2. Repeating student in target session
      studentRepeating = await api(t.app, s1.ownerToken, 'post', '/students', {
        campusId: s1.campusId,
        firstName: 'Repeating',
        lastName: 'Student',
        gender: 'female',
        admissionNo: 'ADM-REP-02',
        sessionId: s1.sessionId,
        classId: class1._id,
        sectionId: class1SecA._id,
      });
      await StudentEnrollment.create({
        schoolId: s1.schoolId,
        studentId: studentRepeating._id,
        sessionId: billingSession._id,
        classId: class1._id,
        sectionId: targetClass1SecA._id,
        campusId: s1.campusId,
        status: 'repeating',
      });

      // 3. Graduated student (must NOT be billed)
      studentGraduated = await api(t.app, s1.ownerToken, 'post', '/students', {
        campusId: s1.campusId,
        firstName: 'Graduated',
        lastName: 'Student',
        gender: 'male',
        admissionNo: 'ADM-GRAD-03',
        sessionId: s1.sessionId,
        classId: class1._id,
        sectionId: class1SecA._id,
      });
      await StudentEnrollment.create({
        schoolId: s1.schoolId,
        studentId: studentGraduated._id,
        sessionId: billingSession._id,
        classId: class1._id,
        sectionId: targetClass1SecA._id,
        campusId: s1.campusId,
        status: 'graduated',
      });

      // 4. Left student (must NOT be billed)
      studentLeft = await api(t.app, s1.ownerToken, 'post', '/students', {
        campusId: s1.campusId,
        firstName: 'Left',
        lastName: 'Student',
        gender: 'male',
        admissionNo: 'ADM-LEFT-04',
        sessionId: s1.sessionId,
        classId: class1._id,
        sectionId: class1SecA._id,
      });
      await StudentEnrollment.create({
        schoolId: s1.schoolId,
        studentId: studentLeft._id,
        sessionId: billingSession._id,
        classId: class1._id,
        sectionId: targetClass1SecA._id,
        campusId: s1.campusId,
        status: 'left',
      });
    });

    it('POST /fees/invoices/preview-generate previews billing without creating any database records', async () => {
      const invoiceCountBefore = await Invoice.countDocuments({ schoolId: s1.schoolId });

      const preview = await api(t.app, s1.ownerToken, 'post', '/fees/invoices/preview-generate', {
        period: '2026-04',
        sessionId: billingSession._id,
      });

      expect(preview.period).toBe('2026-04');
      // Total eligible enrollments with active or repeating status = 2
      expect(preview.billableStudents).toBe(2);
      expect(preview.totalProjectedAmount).toBeGreaterThan(0);
      expect(preview.classesSummary.length).toBe(1);
      expect(preview.classesSummary[0].studentCount).toBe(2);

      // Verify zero invoices were written
      const invoiceCountAfter = await Invoice.countDocuments({ schoolId: s1.schoolId });
      expect(invoiceCountAfter).toBe(invoiceCountBefore);
    });

    it('POST /fees/invoices/generate bills active and repeating students while excluding graduated and left', async () => {
      const generated = await api(t.app, s1.ownerToken, 'post', '/fees/invoices/generate', {
        period: '2026-04',
        sessionId: billingSession._id,
      });

      // Exactly 2 invoices created (active and repeating)
      expect(generated.created).toBe(2);
      expect(generated.invoiceIds.length).toBe(2);

      // Verify active student invoice
      const activeInv = await Invoice.findOne({
        schoolId: s1.schoolId,
        studentId: studentActive._id,
        period: '2026-04',
      }).lean();
      expect(activeInv).toBeDefined();
      expect(activeInv?.status).toBe('unpaid');

      // Verify repeating student invoice
      const repInv = await Invoice.findOne({
        schoolId: s1.schoolId,
        studentId: studentRepeating._id,
        period: '2026-04',
      }).lean();
      expect(repInv).toBeDefined();

      // Verify graduated student was NOT billed
      const gradInv = await Invoice.findOne({
        schoolId: s1.schoolId,
        studentId: studentGraduated._id,
        period: '2026-04',
      }).lean();
      expect(gradInv).toBeNull();

      // Verify left student was NOT billed
      const leftInv = await Invoice.findOne({
        schoolId: s1.schoolId,
        studentId: studentLeft._id,
        period: '2026-04',
      }).lean();
      expect(leftInv).toBeNull();
    });

    it('re-running invoice generation for same period is strictly idempotent', async () => {
      const rerun = await api(t.app, s1.ownerToken, 'post', '/fees/invoices/generate', {
        period: '2026-04',
        sessionId: billingSession._id,
      });

      expect(rerun.created).toBe(0);
      expect(rerun.skippedExisting).toBe(2);
      expect(rerun.invoiceIds.length).toBe(0);
    });
  });

  describe('Task D: Financial Integrity & Traceable Outstanding Balances', () => {
    it('historical session invoices and payments remain 100% intact with untouched balances', async () => {
      // 1. Create historical invoice in old session s1.sessionId
      const oldInvoice = await Invoice.create({
        schoolId: s1.schoolId,
        campusId: s1.campusId,
        studentId: studentActive._id,
        sessionId: s1.sessionId,
        classId: class1._id,
        sectionId: class1SecA._id,
        invoiceNo: 'INV-HIST-001',
        kind: 'regular',
        period: '2025-10',
        issueDate: parseDateOnly('2025-10-01'),
        dueDate: parseDateOnly('2025-10-10'),
        items: [{ feeHeadId: tuitionHead._id, name: 'Tuition Fee', amount: 5000 }],
        subtotal: 5000,
        total: 5000,
        paid: 2000,
        balance: 3000, // Unpaid balance of 3000
        status: 'partial',
      });

      // 2. Query previous dues for the new session invoice
      const newInv = await Invoice.findOne({
        schoolId: s1.schoolId,
        studentId: studentActive._id,
        period: '2026-04',
      }).lean();

      expect(newInv).toBeDefined();

      const dues = await previousDues(
        { schoolId: s1.schoolId } as any,
        newInv as any,
      );

      // The 3000 from old session is dynamically reflected as previous dues
      expect(dues.amount).toBe(3000);
      expect(dues.invoices.length).toBe(1);
      expect(dues.invoices[0].invoiceNo).toBe('INV-HIST-001');

      // Crucial: New invoice balance is NOT corrupted or inflated with the 3000
      // It remains exactly its own current charge!
      const currentTuition = await FeeStructure.findOne({
        schoolId: s1.schoolId,
        sessionId: { $ne: s1.sessionId },
        classId: class1._id,
      }).lean();
      const expectedCharge = currentTuition?.items.find((i) => i.feeHeadId.toString() === tuitionHead._id)?.amount;

      expect(newInv?.balance).toBe(expectedCharge);

      // Old invoice is untouched
      const oldInvAfter = await Invoice.findOne({ schoolId: s1.schoolId, _id: oldInvoice._id }).lean();
      expect(oldInvAfter?.balance).toBe(3000);
      expect(oldInvAfter?.paid).toBe(2000);
      expect(oldInvAfter?.status).toBe('partial');
    });
  });

  describe('Task E: Multi-Tenant Isolation', () => {
    it('school A cannot view, rollover, or generate sessions/fees for school B', async () => {
      // s2 tries to preview next session of s1
      await expect(
        api(t.app, s2.ownerToken, 'get', `/academics/sessions/preview-next?sourceSessionId=${s1.sessionId}`),
      ).rejects.toThrow();

      // s2 tries to rollover fee structures using s1 session
      await expect(
        api(t.app, s2.ownerToken, 'post', '/fees/rollover-preview', {
          fromSessionId: s1.sessionId,
          toSessionId: s2.sessionId,
        }),
      ).rejects.toThrow();
    });
  });
});
