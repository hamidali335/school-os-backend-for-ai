import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict, notFound, unprocessable } from '../../utils/errors';
import { findOwned, oid, scope } from '../../utils/tenant';
import { atomic } from '../../database/transactions';
import { audit } from '../audit/audit.service';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import {
  Student,
  StudentEnrollment,
  PromotionBatch,
  type EnrollmentStatus,
  type PromotionAction,
} from './student.models';
import { AttendanceRecord } from '../attendance/attendance.model';
import { Invoice, Payment } from '../fees/fees.models';
import { Exam, ExamPaper, Mark } from '../examinations/exam.models';
import { Homework, HomeworkSubmission } from '../homework/homework.models';
import { LeaveRequest } from '../leave/leave.model';

type Ctx = SchoolContext;

export interface PromotionPreviewInput {
  fromSessionId: string;
  toSessionId: string;
  campusId?: string;
  classId?: string;
}

export interface PromotionBatchExecuteInput {
  fromSessionId: string;
  toSessionId: string;
  campusId: string;
  items: Array<{
    studentId: string;
    action: PromotionAction;
    toClassId?: string;
    toSectionId?: string;
    toRollNo?: string;
    remarks?: string;
  }>;
}

/**
 * Preview proposed promotions from one academic session to the next.
 * Inspects school class progression levels, terminal classes, and matching sections.
 */
export async function previewPromotionBatch(ctx: Ctx, input: PromotionPreviewInput) {
  if (input.fromSessionId === input.toSessionId) {
    throw badRequest('Source and target academic sessions must be different');
  }

  const fromSession = await findOwned(AcademicSession, ctx, input.fromSessionId, 'Source Academic Session');
  const toSession = await findOwned(AcademicSession, ctx, input.toSessionId, 'Target Academic Session');

  // Determine campuses to evaluate
  const campusFilter: Record<string, unknown> = scope(ctx);
  if (input.campusId) campusFilter.campusId = oid(input.campusId);
  else if (ctx.campusIds.length) campusFilter.campusId = { $in: ctx.campusIds.map(oid) };

  // Fetch all active classes ordered by grade level
  const classesQuery: Record<string, unknown> = scope(ctx, { status: 'active' });
  if (input.campusId) classesQuery.campusId = oid(input.campusId);
  const classes = await SchoolClass.find(classesQuery).sort({ campusId: 1, level: 1, name: 1 }).lean();

  // Group classes by campus
  const classesByCampus = new Map<string, typeof classes>();
  for (const c of classes) {
    const cid = c.campusId.toString();
    const list = classesByCampus.get(cid) ?? [];
    list.push(c);
    classesByCampus.set(cid, list);
  }

  // Pre-load all sections in the target session
  const targetSections = await Section.find(scope(ctx, { sessionId: toSession._id })).lean();
  const targetSectionsByClass = new Map<string, typeof targetSections>();
  for (const sec of targetSections) {
    const k = sec.classId.toString();
    const list = targetSectionsByClass.get(k) ?? [];
    list.push(sec);
    targetSectionsByClass.set(k, list);
  }

  // Pre-load existing enrollments in target session to identify already-enrolled students
  const existingTargetEnrollments = await StudentEnrollment.find(
    scope(ctx, { sessionId: toSession._id }),
  )
    .select('studentId sectionId')
    .lean();
  const alreadyEnrolledSet = new Set(existingTargetEnrollments.map((e) => e.studentId.toString()));

  // Target section occupancy count
  const targetOccupancy = new Map<string, number>();
  for (const e of existingTargetEnrollments) {
    const secId = e.sectionId.toString();
    targetOccupancy.set(secId, (targetOccupancy.get(secId) ?? 0) + 1);
  }

  // Filter students in fromSession
  const studentFilter: Record<string, unknown> = scope(ctx, {
    sessionId: fromSession._id,
    status: 'active',
  });
  if (input.campusId) studentFilter.campusId = oid(input.campusId);
  if (input.classId) studentFilter.classId = oid(input.classId);

  const students = await Student.find(studentFilter)
    .select('_id admissionNo rollNo firstName lastName gender campusId classId sectionId status')
    .populate('classId', 'name level campusId')
    .populate('sectionId', 'name')
    .sort({ classId: 1, sectionId: 1, rollNo: 1, firstName: 1 })
    .lean();

  // Build progression per campus
  const classProgression = new Map<
    string,
    { nextClass: (typeof classes)[number] | null; isTerminal: boolean }
  >();

  for (const [cid, campusClasses] of classesByCampus.entries()) {
    for (let i = 0; i < campusClasses.length; i++) {
      const current = campusClasses[i];
      const isTerminal = i === campusClasses.length - 1;
      const nextClass = isTerminal ? null : campusClasses[i + 1];
      classProgression.set(current._id.toString(), { nextClass, isTerminal });
    }
  }

  // Group preview items
  interface PreviewStudentItem {
    studentId: string;
    admissionNo: string;
    name: string;
    gender: string;
    rollNo?: string;
    currentClass: { _id: string; name: string; level: number };
    currentSection: { _id: string; name: string };
    proposedAction: PromotionAction;
    proposedClass: { _id: string; name: string; level: number } | null;
    proposedSection: { _id: string; name: string } | null;
    isTerminal: boolean;
    eligible: boolean;
    ineligibilityReason?: string;
  }

  const allItems: PreviewStudentItem[] = [];
  const graduatingItems: PreviewStudentItem[] = [];

  for (const st of students) {
    const classIdStr = (st.classId as any)?._id?.toString() ?? st.classId?.toString();
    const sectionIdStr = (st.sectionId as any)?._id?.toString() ?? st.sectionId?.toString();
    const currentSectionName = (st.sectionId as any)?.name ?? '';
    const currentClassName = (st.classId as any)?.name ?? '';
    const currentClassLevel = (st.classId as any)?.level ?? 0;

    const prog = classProgression.get(classIdStr) ?? { nextClass: null, isTerminal: false };
    const isAlreadyEnrolled = alreadyEnrolledSet.has(st._id.toString());

    let proposedAction: PromotionAction = 'promote';
    let proposedClass: { _id: string; name: string; level: number } | null = null;
    let proposedSection: { _id: string; name: string } | null = null;

    if (prog.isTerminal) {
      proposedAction = 'graduate';
    } else if (prog.nextClass) {
      proposedAction = 'promote';
      proposedClass = {
        _id: prog.nextClass._id.toString(),
        name: prog.nextClass.name,
        level: prog.nextClass.level,
      };

      // Match target section by name, or fallback to first available
      const availableTargetSections = targetSectionsByClass.get(prog.nextClass._id.toString()) ?? [];
      const matchingSection = availableTargetSections.find(
        (sec) => sec.name.trim().toLowerCase() === currentSectionName.trim().toLowerCase(),
      );
      const chosenSection = matchingSection ?? availableTargetSections[0];
      if (chosenSection) {
        proposedSection = {
          _id: chosenSection._id.toString(),
          name: chosenSection.name,
        };
      }
    }

    const item: PreviewStudentItem = {
      studentId: st._id.toString(),
      admissionNo: st.admissionNo,
      name: `${st.firstName} ${st.lastName ?? ''}`.trim(),
      gender: st.gender,
      rollNo: st.rollNo ?? undefined,
      currentClass: { _id: classIdStr, name: currentClassName, level: currentClassLevel },
      currentSection: { _id: sectionIdStr, name: currentSectionName },
      proposedAction,
      proposedClass,
      proposedSection,
      isTerminal: prog.isTerminal,
      eligible: !isAlreadyEnrolled,
      ineligibilityReason: isAlreadyEnrolled
        ? 'Student is already enrolled in the target academic session'
        : undefined,
    };

    allItems.push(item);
    if (prog.isTerminal) {
      graduatingItems.push(item);
    }
  }

  // Compile summary
  const summary = {
    totalStudents: allItems.length,
    totalEligible: allItems.filter((i) => i.eligible).length,
    totalAlreadyEnrolled: allItems.filter((i) => !i.eligible).length,
    proposedPromotions: allItems.filter((i) => i.eligible && i.proposedAction === 'promote').length,
    graduatingStudents: graduatingItems.filter((i) => i.eligible).length,
  };

  // Compile classes metadata for target session
  const classesMetadata = classes.map((c) => {
    const prog = classProgression.get(c._id.toString());
    const availableSections = (targetSectionsByClass.get(c._id.toString()) ?? []).map((s) => ({
      _id: s._id.toString(),
      name: s.name,
      capacity: s.capacity,
      enrolledCount: targetOccupancy.get(s._id.toString()) ?? 0,
    }));

    return {
      _id: c._id.toString(),
      campusId: c.campusId.toString(),
      name: c.name,
      level: c.level,
      isTerminal: prog?.isTerminal ?? false,
      nextClass: prog?.nextClass
        ? { _id: prog.nextClass._id.toString(), name: prog.nextClass.name, level: prog.nextClass.level }
        : null,
      targetSections: availableSections,
    };
  });

  return {
    fromSession: { _id: fromSession._id.toString(), name: fromSession.name },
    toSession: { _id: toSession._id.toString(), name: toSession.name },
    classes: classesMetadata,
    students: allItems,
    graduatingStudents: graduatingItems,
    summary,
  };
}

/**
 * Execute a confirmed batch promotion, repeat, graduation, or manual placement.
 * Runs atomically inside a transaction, recording a full audit snapshot in PromotionBatch.
 */
export async function executePromotionBatch(ctx: Ctx, input: PromotionBatchExecuteInput) {
  if (input.fromSessionId === input.toSessionId) {
    throw badRequest('Source and target academic sessions must be different');
  }
  if (!input.items || !input.items.length) {
    throw badRequest('At least one student must be included in the promotion batch');
  }

  const fromSession = await findOwned(AcademicSession, ctx, input.fromSessionId, 'Source Academic Session');
  const toSession = await findOwned(AcademicSession, ctx, input.toSessionId, 'Target Academic Session');

  // Prevent duplicate student IDs in the input payload
  const studentIdSet = new Set<string>();
  for (const item of input.items) {
    if (studentIdSet.has(item.studentId)) {
      throw badRequest(`Duplicate student ${item.studentId} in promotion batch payload`);
    }
    studentIdSet.add(item.studentId);
  }

  // Pre-validate: ensure none of these students already have an enrollment in toSessionId
  const existingEnrollments = await StudentEnrollment.find(
    scope(ctx, {
      sessionId: toSession._id,
      studentId: { $in: Array.from(studentIdSet).map(oid) },
    }),
  )
    .select('studentId')
    .lean();

  if (existingEnrollments.length > 0) {
    const duplicateIds = existingEnrollments.map((e) => e.studentId.toString());
    throw conflict(
      `Cannot promote: ${duplicateIds.length} student${duplicateIds.length === 1 ? ' is' : 's are'} already enrolled in session ${toSession.name}`,
      { duplicateStudentIds: duplicateIds },
      'DUPLICATE_ENROLLMENT',
    );
  }

  // Validate target classes and sections exist in tenant and toSession
  const targetClassIds = [
    ...new Set(input.items.map((i) => i.toClassId).filter(Boolean)),
  ] as string[];
  const targetSectionIds = [
    ...new Set(input.items.map((i) => i.toSectionId).filter(Boolean)),
  ] as string[];

  if (targetClassIds.length > 0) {
    const validClasses = await SchoolClass.find(
      scope(ctx, { _id: { $in: targetClassIds.map(oid) } }),
    )
      .select('_id')
      .lean();
    if (validClasses.length !== targetClassIds.length) {
      throw badRequest('One or more target classes do not exist in this school', undefined, 'INVALID_REFERENCE');
    }
  }

  if (targetSectionIds.length > 0) {
    const validSections = await Section.find(
      scope(ctx, { _id: { $in: targetSectionIds.map(oid) }, sessionId: toSession._id }),
    )
      .select('_id')
      .lean();
    if (validSections.length !== targetSectionIds.length) {
      throw badRequest(
        'One or more target sections do not exist or do not belong to the target academic session',
        undefined,
        'INVALID_REFERENCE',
      );
    }
  }

  // Execute atomically
  return atomic(async () => {
    const batchItems: Array<{
      studentId: Types.ObjectId;
      action: PromotionAction;
      fromClassId: Types.ObjectId;
      fromSectionId: Types.ObjectId;
      fromRollNo?: string;
      fromEnrollmentId?: Types.ObjectId;
      toClassId?: Types.ObjectId;
      toSectionId?: Types.ObjectId;
      toRollNo?: string;
      toEnrollmentId?: Types.ObjectId;
      previousStudentStatus: string;
      newStudentStatus: string;
      remarks?: string;
    }> = [];

    let totalPromoted = 0;
    let totalRepeating = 0;
    let totalGraduated = 0;
    let totalManual = 0;

    for (const item of input.items) {
      const student = await findOwned(Student, ctx, item.studentId, 'Student');

      // Fetch or derive source enrollment
      const sourceEnrollment = await StudentEnrollment.findOne(
        scope(ctx, { studentId: student._id, sessionId: fromSession._id }),
      ).lean();

      // Determine statuses
      let sourceStatus: EnrollmentStatus = 'promoted';
      let targetStatus: EnrollmentStatus = 'active';
      let newStudentStatus = 'active';

      if (item.action === 'repeat') {
        sourceStatus = 'repeating';
        targetStatus = 'repeating';
        newStudentStatus = 'active';
        totalRepeating++;
      } else if (item.action === 'graduate') {
        sourceStatus = 'graduated';
        targetStatus = 'graduated';
        newStudentStatus = 'graduated';
        totalGraduated++;
      } else if (item.action === 'left') {
        sourceStatus = 'left';
        targetStatus = 'left';
        newStudentStatus = 'left';
      } else if (item.action === 'transferred') {
        sourceStatus = 'transferred';
        targetStatus = 'transferred';
        newStudentStatus = 'transferred';
      } else if (item.action === 'manual') {
        sourceStatus = 'promoted';
        targetStatus = 'active';
        newStudentStatus = 'active';
        totalManual++;
      } else {
        // 'promote'
        sourceStatus = 'promoted';
        targetStatus = 'active';
        newStudentStatus = 'active';
        totalPromoted++;
      }

      // 1. Update source enrollment
      if (sourceEnrollment) {
        await StudentEnrollment.updateOne(
          scope(ctx, { _id: sourceEnrollment._id }),
          {
            $set: {
              status: sourceStatus,
              statusChangedAt: new Date(),
              statusReason: item.remarks ?? `Session rollover from ${fromSession.name} to ${toSession.name}`,
            },
          },
        );
      }

      // 2. Create target session enrollment
      const toClassId = item.toClassId ? oid(item.toClassId) : student.classId;
      const toSectionId = item.toSectionId ? oid(item.toSectionId) : student.sectionId;
      const toRollNo = item.toRollNo ?? student.rollNo;

      const [newEnrollment] = await StudentEnrollment.create(
        [
          {
            schoolId: oid(ctx.schoolId),
            studentId: student._id,
            sessionId: toSession._id,
            campusId: student.campusId,
            classId: toClassId,
            sectionId: toSectionId,
            rollNo: toRollNo,
            enrollmentDate: new Date(),
            status: targetStatus,
            statusChangedAt: targetStatus !== 'active' ? new Date() : undefined,
            statusReason: item.remarks,
            promotionDetails: {
              fromEnrollmentId: sourceEnrollment?._id,
              fromSectionId: student.sectionId,
              fromClassId: student.classId,
              fromSessionId: fromSession._id,
              promotedAt: new Date(),
              promotedBy: ctx.userId ? oid(ctx.userId) : undefined,
              remarks: item.remarks,
            },
            createdBy: ctx.userId ? oid(ctx.userId) : undefined,
          },
        ],
      );

      // 3. Update Student current pointers
      const studentSet: Record<string, unknown> = {
        sessionId: toSession._id,
        classId: toClassId,
        sectionId: toSectionId,
        rollNo: toRollNo,
        status: newStudentStatus,
      };
      if (newStudentStatus !== 'active') {
        studentSet.statusChangedAt = new Date();
        studentSet.leavingReason = item.remarks;
      }

      await Student.updateOne(scope(ctx, { _id: student._id }), { $set: studentSet });

      batchItems.push({
        studentId: student._id,
        action: item.action,
        fromClassId: student.classId,
        fromSectionId: student.sectionId,
        fromRollNo: student.rollNo,
        fromEnrollmentId: sourceEnrollment?._id,
        toClassId,
        toSectionId,
        toRollNo,
        toEnrollmentId: newEnrollment._id,
        previousStudentStatus: student.status,
        newStudentStatus,
        remarks: item.remarks,
      });
    }

    // 4. Create the master PromotionBatch audit record
    const [batch] = await PromotionBatch.create(
      [
        {
          schoolId: oid(ctx.schoolId),
          campusId: oid(input.campusId),
          fromSessionId: fromSession._id,
          toSessionId: toSession._id,
          status: 'committed',
          totalPromoted,
          totalRepeating,
          totalGraduated,
          totalManual,
          promotedBy: ctx.userId ? oid(ctx.userId) : undefined,
          promotedAt: new Date(),
          items: batchItems,
        },
      ],
    );

    await audit(ctx, {
      action: 'student.batch_promote',
      entityType: 'AcademicSession',
      entityId: toSession._id,
      metadata: {
        batchId: batch._id,
        fromSessionId: fromSession._id,
        toSessionId: toSession._id,
        totalStudents: batchItems.length,
        totalPromoted,
        totalRepeating,
        totalGraduated,
        totalManual,
      },
    });

    return {
      batchId: batch._id.toString(),
      fromSessionId: fromSession._id.toString(),
      toSessionId: toSession._id.toString(),
      status: batch.status,
      totalProcessed: batchItems.length,
      totalPromoted,
      totalRepeating,
      totalGraduated,
      totalManual,
    };
  });
}

/**
 * Inspect a promotion batch and verify whether it can be safely rolled back.
 * Blocks rollback if any affected student has activity (attendance, invoices, marks, homework) in the new session.
 */
export async function checkPromotionBatchRollback(ctx: Ctx, batchId: string) {
  const batch = await findOwned(PromotionBatch, ctx, batchId, 'PromotionBatch');

  if (batch.status === 'rolled_back') {
    return {
      canRollback: false,
      alreadyRolledBack: true,
      blockers: [],
      reason: 'This promotion batch has already been rolled back',
    };
  }

  const studentIds = batch.items.map((i: any) => i.studentId);
  const toSessionId = batch.toSessionId;

  // 1. Check for attendance records in target session
  const attendanceRecords = await AttendanceRecord.find(
    scope(ctx, { sessionId: toSessionId, studentId: { $in: studentIds } }),
  )
    .select('studentId date status')
    .lean();

  // 2. Check for fee invoices in target session
  const invoices = await Invoice.find(
    scope(ctx, { sessionId: toSessionId, studentId: { $in: studentIds } }),
  )
    .select('studentId invoiceNo period total paid balance')
    .lean();

  // 3. Check for exam marks in target session
  const exams = await Exam.find(scope(ctx, { sessionId: toSessionId })).select('_id').lean();
  let markRecords: any[] = [];
  if (exams.length > 0) {
    const papers = await ExamPaper.find(
      scope(ctx, { examId: { $in: exams.map((e) => e._id) } }),
    )
      .select('_id')
      .lean();
    if (papers.length > 0) {
      markRecords = await Mark.find(
        scope(ctx, { paperId: { $in: papers.map((p) => p._id) }, studentId: { $in: studentIds } }),
      )
        .select('studentId paperId obtained')
        .lean();
    }
  }

  // 4. Check for homework submissions in target session
  const homeworks = await Homework.find(scope(ctx, { sessionId: toSessionId })).select('_id').lean();
  let submissions: any[] = [];
  if (homeworks.length > 0) {
    submissions = await HomeworkSubmission.find(
      scope(ctx, {
        homeworkId: { $in: homeworks.map((h) => h._id) },
        studentId: { $in: studentIds },
      }),
    )
      .select('studentId homeworkId')
      .lean();
  }

  // 5. Check for payments/receipts in target session
  const payments = await Payment.find(
    scope(ctx, {
      studentId: { $in: studentIds },
      status: 'valid',
      invoiceId: { $in: invoices.map((i) => i._id) },
    }),
  )
    .select('studentId receiptNo amount')
    .lean();

  // 6. Check for leave requests in target session date range
  const targetSessionDoc = await AcademicSession.findOne(scope(ctx, { _id: toSessionId })).select('startDate endDate').lean();
  let leaveRecords: any[] = [];
  if (targetSessionDoc?.startDate && targetSessionDoc?.endDate) {
    leaveRecords = await LeaveRequest.find(
      scope(ctx, {
        studentId: { $in: studentIds },
        from: { $gte: targetSessionDoc.startDate, $lte: targetSessionDoc.endDate },
      }),
    )
      .select('studentId from to reason')
      .lean();
  }

  // Compile detailed blockers grouped by student
  const blockersMap = new Map<
    string,
    {
      studentId: string;
      admissionNo?: string;
      studentName?: string;
      attendanceCount: number;
      invoiceCount: number;
      paymentCount: number;
      markCount: number;
      homeworkCount: number;
      leaveCount: number;
      details: string[];
    }
  >();

  // Fetch student names for human-readable reporting
  const students = await Student.find(scope(ctx, { _id: { $in: studentIds } }))
    .select('_id admissionNo firstName lastName')
    .lean();
  const studentMeta = new Map(
    students.map((s) => [s._id.toString(), { admissionNo: s.admissionNo, name: `${s.firstName} ${s.lastName ?? ''}`.trim() }]),
  );

  function getOrCreateBlocker(stId: string) {
    let b = blockersMap.get(stId);
    if (!b) {
      const meta = studentMeta.get(stId);
      b = {
        studentId: stId,
        admissionNo: meta?.admissionNo,
        studentName: meta?.name,
        attendanceCount: 0,
        invoiceCount: 0,
        paymentCount: 0,
        markCount: 0,
        homeworkCount: 0,
        leaveCount: 0,
        details: [],
      };
      blockersMap.set(stId, b);
    }
    return b;
  }

  for (const a of attendanceRecords) {
    const b = getOrCreateBlocker(a.studentId.toString());
    b.attendanceCount++;
  }
  for (const inv of invoices) {
    const b = getOrCreateBlocker(inv.studentId.toString());
    b.invoiceCount++;
  }
  for (const p of payments) {
    const b = getOrCreateBlocker(p.studentId.toString());
    b.paymentCount++;
  }
  for (const m of markRecords) {
    const b = getOrCreateBlocker(m.studentId.toString());
    b.markCount++;
  }
  for (const sub of submissions) {
    const b = getOrCreateBlocker(sub.studentId.toString());
    b.homeworkCount++;
  }
  for (const l of leaveRecords) {
    const b = getOrCreateBlocker(l.studentId.toString());
    b.leaveCount++;
  }

  // Finalize descriptive labels
  const blockers = Array.from(blockersMap.values()).map((b) => {
    if (b.attendanceCount > 0) b.details.push(`${b.attendanceCount} attendance record(s)`);
    if (b.invoiceCount > 0) b.details.push(`${b.invoiceCount} fee invoice(s)`);
    if (b.paymentCount > 0) b.details.push(`${b.paymentCount} payment receipt(s)`);
    if (b.markCount > 0) b.details.push(`${b.markCount} exam mark(s)`);
    if (b.homeworkCount > 0) b.details.push(`${b.homeworkCount} homework submission(s)`);
    if (b.leaveCount > 0) b.details.push(`${b.leaveCount} leave request(s)`);
    return b;
  });

  const canRollback = blockers.length === 0;

  return {
    canRollback,
    alreadyRolledBack: false,
    batchId: batch._id.toString(),
    fromSessionId: batch.fromSessionId.toString(),
    toSessionId: batch.toSessionId.toString(),
    totalStudentsInBatch: batch.items.length,
    totalBlockedStudents: blockers.length,
    blockers,
  };
}

/**
 * Rollback an eligible promotion batch.
 * Restores previous class/section assignments, statuses, and source enrollments.
 */
export async function rollbackPromotionBatch(ctx: Ctx, batchId: string, input: { reason: string }) {
  if (!input.reason?.trim() || input.reason.trim().length < 3) {
    throw badRequest('A valid reason (at least 3 characters) is required for promotion rollback');
  }

  const check = await checkPromotionBatchRollback(ctx, batchId);
  if (!check.canRollback) {
    throw conflict(
      'Promotion rollback is blocked because affected students have acquired new-session records. ' +
        'Resolve or delete those records before rolling back.',
      { blockers: check.blockers },
      'ROLLBACK_BLOCKED',
    );
  }

  const batch = await findOwned(PromotionBatch, ctx, batchId, 'PromotionBatch');

  return atomic(async () => {
    for (const item of batch.items as any[]) {
      // 1. Remove the target enrollment created during the batch
      if (item.toEnrollmentId) {
        await StudentEnrollment.deleteOne(scope(ctx, { _id: item.toEnrollmentId }));
      } else {
        await StudentEnrollment.deleteOne(
          scope(ctx, { studentId: item.studentId, sessionId: batch.toSessionId }),
        );
      }

      // 2. Restore the source enrollment status back to 'active'
      if (item.fromEnrollmentId) {
        await StudentEnrollment.updateOne(
          scope(ctx, { _id: item.fromEnrollmentId }),
          {
            $set: {
              status: item.previousStudentStatus === 'active' ? 'active' : item.previousStudentStatus,
            },
            $unset: { statusReason: 1 },
          },
        );
      } else {
        await StudentEnrollment.updateOne(
          scope(ctx, { studentId: item.studentId, sessionId: batch.fromSessionId }),
          {
            $set: {
              status: item.previousStudentStatus === 'active' ? 'active' : item.previousStudentStatus,
            },
            $unset: { statusReason: 1 },
          },
        );
      }

      // 3. Restore Student current placement pointers
      await Student.updateOne(
        scope(ctx, { _id: item.studentId }),
        {
          $set: {
            sessionId: batch.fromSessionId,
            classId: item.fromClassId,
            sectionId: item.fromSectionId,
            rollNo: item.fromRollNo,
            status: item.previousStudentStatus,
          },
          $unset: { leavingReason: 1 },
        },
      );
    }

    // 4. Mark batch as rolled_back
    const updatedBatch = await PromotionBatch.findOneAndUpdate(
      scope(ctx, { _id: batch._id }),
      {
        $set: {
          status: 'rolled_back',
          rolledBackAt: new Date(),
          rolledBackBy: ctx.userId ? oid(ctx.userId) : undefined,
          rollbackReason: input.reason.trim(),
        },
      },
      { returnDocument: 'after' },
    ).lean();

    await audit(ctx, {
      action: 'student.batch_rollback',
      entityType: 'PromotionBatch',
      entityId: batch._id,
      metadata: {
        batchId: batch._id,
        reason: input.reason.trim(),
        restoredStudents: batch.items.length,
      },
    });

    return {
      batchId: batch._id.toString(),
      status: 'rolled_back',
      restoredStudentsCount: batch.items.length,
      rolledBackAt: updatedBatch?.rolledBackAt,
    };
  });
}

/**
 * List previous promotion batches for a school.
 */
export async function listPromotionBatches(
  ctx: Ctx,
  query: { campusId?: string; toSessionId?: string; fromSessionId?: string; limit?: number },
) {
  const filter: Record<string, unknown> = scope(ctx);
  if (query.campusId) filter.campusId = oid(query.campusId);
  if (query.toSessionId) filter.toSessionId = oid(query.toSessionId);
  if (query.fromSessionId) filter.fromSessionId = oid(query.fromSessionId);

  return PromotionBatch.find(filter)
    .populate('fromSessionId', 'name startDate endDate')
    .populate('toSessionId', 'name startDate endDate')
    .populate('campusId', 'name')
    .populate('promotedBy', 'name email')
    .populate('rolledBackBy', 'name email')
    .sort({ createdAt: -1 })
    .limit(query.limit ?? 50)
    .lean();
}

/**
 * Get details of a single promotion batch.
 */
export async function getPromotionBatch(ctx: Ctx, id: string) {
  const batch = await findOwned(PromotionBatch, ctx, id, 'PromotionBatch');
  return PromotionBatch.findOne(scope(ctx, { _id: batch._id }))
    .populate('fromSessionId', 'name startDate endDate')
    .populate('toSessionId', 'name startDate endDate')
    .populate('campusId', 'name')
    .populate('items.studentId', 'admissionNo firstName lastName gender')
    .populate('items.fromClassId', 'name level')
    .populate('items.fromSectionId', 'name')
    .populate('items.toClassId', 'name level')
    .populate('items.toSectionId', 'name')
    .populate('promotedBy', 'name email')
    .populate('rolledBackBy', 'name email')
    .lean();
}
