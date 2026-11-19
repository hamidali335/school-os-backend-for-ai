import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { findOwned, oid, scope } from '../../utils/tenant';
import { assertStudentVisible } from '../academics/access.service';
import { Student, StudentEnrollment, Parent } from './student.models';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from '../academics/academics.models';
import { TimetableEntry } from '../timetable/timetable.model';
import { AttendanceRecord } from '../attendance/attendance.model';
import { Invoice, Payment } from '../fees/fees.models';
import { Exam, ExamPaper, Mark } from '../examinations/exam.models';
import { LeaveRequest } from '../leave/leave.model';

type Ctx = SchoolContext;

export interface StudentJourneySessionRecord {
  enrollment: {
    _id: string;
    sessionId: string;
    sessionName: string;
    startDate: Date;
    endDate: Date;
    classId: string;
    className: string;
    classLevel: number;
    sectionId: string;
    sectionName: string;
    rollNo?: string;
    enrollmentDate?: Date;
    status: string;
    statusChangedAt?: Date;
    statusReason?: string;
    promotionDetails?: {
      fromSessionId?: string;
      fromSessionName?: string;
      fromClassId?: string;
      fromClassName?: string;
      fromSectionId?: string;
      fromSectionName?: string;
      promotedAt?: Date;
      remarks?: string;
    };
  };
  attendance: {
    totalDays: number;
    present: number;
    absent: number;
    late: number;
    leave: number;
    rate: number | null;
  };
  fees: {
    totalBilled: number;
    totalPaid: number;
    balance: number;
    invoicesCount: number;
    invoices: Array<{
      _id: string;
      invoiceNo: string;
      period: string;
      total: number;
      paid: number;
      balance: number;
      status: string;
      dueDate?: string;
      items: Array<{ name: string; amount: number }>;
    }>;
    payments: Array<{
      _id: string;
      receiptNo: string;
      amount: number;
      method: string;
      receivedAt: Date;
    }>;
  };
  academics: {
    subjects: Array<{ _id: string; name: string; code: string; teacherName?: string }>;
    timetablePeriodsCount: number;
  };
  examinations: Array<{
    examId: string;
    examName: string;
    papersCount: number;
    totalMaxMarks: number;
    totalObtainedMarks: number;
    percentage: number | null;
    grade?: string;
    papers: Array<{
      paperId: string;
      subjectName: string;
      totalMarks: number;
      obtained: number | null;
      isAbsent: boolean;
      remarks?: string;
    }>;
  }>;
  leaves: Array<{
    _id: string;
    from: Date;
    to: Date;
    days: number;
    reason: string;
    status: string;
  }>;
}

/**
 * Retrieve the complete academic journey and historical records for a student across all sessions,
 * or filtered to a single target session.
 */
export async function getStudentJourney(ctx: Ctx, studentId: string, filterSessionId?: string) {
  const student = await findOwned(Student, ctx, studentId, 'Student');
  await assertStudentVisible(ctx, studentId);

  // 1. Fetch all student enrollments sorted chronologically
  const enrollments = await StudentEnrollment.find(scope(ctx, { studentId: student._id }))
    .populate('sessionId', 'name startDate endDate isCurrent status')
    .populate('classId', 'name level')
    .populate('sectionId', 'name room')
    .populate('campusId', 'name')
    .populate('promotionDetails.fromSessionId', 'name')
    .populate('promotionDetails.fromClassId', 'name level')
    .populate('promotionDetails.fromSectionId', 'name')
    .sort({ enrollmentDate: 1, createdAt: 1 })
    .lean();

  // 2. Fetch guardians/parent details
  const parentIds = (student.guardians ?? []).map((g: any) => g.parentId);
  const parents = parentIds.length
    ? await Parent.find(scope(ctx, { _id: { $in: parentIds } }))
        .select('name relation phone email preferredChannel')
        .lean()
    : [];
  const parentMap = new Map(parents.map((p) => [p._id.toString(), p]));

  const guardians = (student.guardians ?? []).map((g: any) => {
    const p = parentMap.get(g.parentId?.toString());
    return {
      parentId: g.parentId,
      name: p?.name ?? 'Guardian',
      relation: g.relation ?? p?.relation ?? 'guardian',
      phone: p?.phone,
      email: p?.email,
      isPrimary: g.isPrimary ?? false,
    };
  });

  // Identify original admission session
  const earliestEnrollment = enrollments[0];
  const initialSession = earliestEnrollment
    ? {
        _id: (earliestEnrollment.sessionId as any)?._id?.toString() ?? earliestEnrollment.sessionId?.toString(),
        name: (earliestEnrollment.sessionId as any)?.name ?? 'Initial Session',
      }
    : null;

  // Filter enrollments if filterSessionId is requested
  const targetEnrollments = filterSessionId
    ? enrollments.filter(
        (e) =>
          ((e.sessionId as any)?._id?.toString() ?? e.sessionId?.toString()) === filterSessionId,
      )
    : enrollments;

  // 3. For each session enrollment, compile session-specific historical data
  const sessionRecords: StudentJourneySessionRecord[] = [];

  for (const enr of targetEnrollments) {
    const sId = (enr.sessionId as any)?._id ?? enr.sessionId;
    const cId = (enr.classId as any)?._id ?? enr.classId;
    const secId = (enr.sectionId as any)?._id ?? enr.sectionId;

    const sName = (enr.sessionId as any)?.name ?? '';
    const sStart = (enr.sessionId as any)?.startDate ?? new Date(0);
    const sEnd = (enr.sessionId as any)?.endDate ?? new Date(8640000000000000);
    const cName = (enr.classId as any)?.name ?? '';
    const cLevel = (enr.classId as any)?.level ?? 0;
    const secName = (enr.sectionId as any)?.name ?? '';

    // A. Attendance for this student in this session
    const attendanceDocs = await AttendanceRecord.find(
      scope(ctx, { studentId: student._id, sessionId: sId }),
    )
      .select('status date')
      .lean();

    let pres = 0;
    let abs = 0;
    let late = 0;
    let lve = 0;
    for (const a of attendanceDocs) {
      if (a.status === 'present') pres++;
      else if (a.status === 'absent') abs++;
      else if (a.status === 'late') late++;
      else if (a.status === 'leave') lve++;
    }
    const attTotal = attendanceDocs.length;
    const attRate = attTotal > 0 ? Math.round(((pres + late) / attTotal) * 100) : null;

    // B. Fees: Invoices and payments in this session
    const invoiceDocs = await Invoice.find(scope(ctx, { studentId: student._id, sessionId: sId }))
      .select('invoiceNo period total paid balance status dueDate items')
      .sort({ period: 1 })
      .lean();

    const invIds = invoiceDocs.map((i) => i._id);
    const paymentDocs = invIds.length
      ? await Payment.find(
          scope(ctx, {
            studentId: student._id,
            invoiceId: { $in: invIds },
            status: 'valid',
          }),
        )
          .select('receiptNo amount method receivedAt')
          .sort({ receivedAt: -1 })
          .lean()
      : [];

    let totalBilled = 0;
    let totalPaid = 0;
    let totalBalance = 0;
    for (const inv of invoiceDocs) {
      totalBilled += inv.total ?? 0;
      totalPaid += inv.paid ?? 0;
      totalBalance += inv.balance ?? 0;
    }

    // C. Academics: Subjects, Teaching assignments, Timetable
    const assignments = await TeachingAssignment.find(
      scope(ctx, { sessionId: sId, sectionId: secId }),
    )
      .populate('teacherId', 'firstName lastName')
      .populate('subjectId', 'name')
      .lean();

    const teacherMap = new Map<string, string>();
    const assignedSubjectIds: string[] = [];
    for (const a of assignments) {
      const subId = (a.subjectId as any)?._id?.toString() ?? a.subjectId?.toString();
      const t = a.teacherId as any;
      if (subId) {
        assignedSubjectIds.push(subId);
        if (t) {
          teacherMap.set(subId, `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim());
        }
      }
    }

    // Historical curriculum integrity: if teaching assignments exist for this section in this session,
    // they represent the actual curriculum taught in that session. Fall back to classIds only if no assignments exist yet.
    const subjectFilter: any = assignedSubjectIds.length > 0
      ? { _id: { $in: assignedSubjectIds.map(oid) } }
      : { classIds: cId };
    const subjects = await Subject.find(scope(ctx, subjectFilter)).select('name code').lean();

    const timetableCount = await TimetableEntry.countDocuments(
      scope(ctx, { sessionId: sId, sectionId: secId }),
    );

    // D. Examinations & Marks
    const exams = await Exam.find(scope(ctx, { sessionId: sId })).select('name startDate endDate').lean();
    const examResults: StudentJourneySessionRecord['examinations'] = [];

    for (const ex of exams) {
      const papers = await ExamPaper.find(scope(ctx, { examId: ex._id }))
        .populate('subjectId', 'name')
        .lean();

      if (!papers.length) continue;

      const marks = await Mark.find(
        scope(ctx, {
          paperId: { $in: papers.map((p) => p._id) },
          studentId: student._id,
        }),
      ).lean();

      if (!marks.length) continue;

      const markMap = new Map(marks.map((m) => [m.paperId.toString(), m]));
      let examTotalMax = 0;
      let examTotalObtained = 0;

      const paperResults = papers.map((p) => {
        const m = markMap.get(p._id.toString());
        examTotalMax += p.maxMarks;
        if (m && !m.isAbsent && typeof m.obtained === 'number') {
          examTotalObtained += m.obtained;
        }
        return {
          paperId: p._id.toString(),
          subjectName: (p.subjectId as any)?.name ?? 'Subject',
          totalMarks: p.maxMarks,
          obtained: typeof m?.obtained === 'number' ? m.obtained : null,
          isAbsent: m?.isAbsent ?? false,
          remarks: m?.remarks ?? undefined,
        };
      });

      const pct = examTotalMax > 0 ? Math.round((examTotalObtained / examTotalMax) * 100) : null;
      let grade = 'F';
      if (pct !== null) {
        if (pct >= 80) grade = 'A+';
        else if (pct >= 70) grade = 'A';
        else if (pct >= 60) grade = 'B';
        else if (pct >= 50) grade = 'C';
        else if (pct >= 40) grade = 'D';
      }

      examResults.push({
        examId: ex._id.toString(),
        examName: ex.name,
        papersCount: papers.length,
        totalMaxMarks: examTotalMax,
        totalObtainedMarks: examTotalObtained,
        percentage: pct,
        grade,
        papers: paperResults,
      });
    }

    // E. Leaves during this session
    const leaves = await LeaveRequest.find(
      scope(ctx, {
        studentId: student._id,
        from: { $gte: sStart, $lte: sEnd },
      }),
    )
      .select('from to days reason status')
      .sort({ from: -1 })
      .lean();

    const fromPromo = enr.promotionDetails as any;

    sessionRecords.push({
      enrollment: {
        _id: enr._id.toString(),
        sessionId: sId.toString(),
        sessionName: sName,
        startDate: sStart,
        endDate: sEnd,
        classId: cId.toString(),
        className: cName,
        classLevel: cLevel,
        sectionId: secId.toString(),
        sectionName: secName,
        rollNo: enr.rollNo ?? undefined,
        enrollmentDate: enr.enrollmentDate ? new Date(enr.enrollmentDate) : undefined,
        status: enr.status,
        statusChangedAt: enr.statusChangedAt ? new Date(enr.statusChangedAt) : undefined,
        statusReason: enr.statusReason ?? undefined,
        promotionDetails: fromPromo
          ? {
              fromSessionId: fromPromo.fromSessionId?._id?.toString(),
              fromSessionName: fromPromo.fromSessionId?.name ?? undefined,
              fromClassId: fromPromo.fromClassId?._id?.toString(),
              fromClassName: fromPromo.fromClassId?.name ?? undefined,
              fromSectionId: fromPromo.fromSectionId?._id?.toString(),
              fromSectionName: fromPromo.fromSectionId?.name ?? undefined,
              promotedAt: fromPromo.promotedAt ? new Date(fromPromo.promotedAt) : undefined,
              remarks: fromPromo.remarks ?? undefined,
            }
          : undefined,
      },
      attendance: {
        totalDays: attTotal,
        present: pres,
        absent: abs,
        late,
        leave: lve,
        rate: attRate,
      },
      fees: {
        totalBilled,
        totalPaid,
        balance: totalBalance,
        invoicesCount: invoiceDocs.length,
        invoices: invoiceDocs.map((inv) => ({
          _id: inv._id.toString(),
          invoiceNo: inv.invoiceNo,
          period: inv.period,
          total: inv.total,
          paid: inv.paid,
          balance: inv.balance,
          status: inv.status,
          dueDate: inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : undefined,
          items: (inv.items ?? []).map((it) => ({ name: it.name, amount: it.amount })),
        })),
        payments: paymentDocs.map((pay) => ({
          _id: pay._id.toString(),
          receiptNo: pay.receiptNo,
          amount: pay.amount,
          method: pay.method,
          receivedAt: pay.receivedAt,
        })),
      },
      academics: {
        subjects: subjects.map((sub) => ({
          _id: sub._id.toString(),
          name: sub.name,
          code: sub.code,
          teacherName: teacherMap.get(sub._id.toString()),
        })),
        timetablePeriodsCount: timetableCount,
      },
      examinations: examResults,
      leaves: leaves.map((l) => ({
        _id: l._id.toString(),
        from: l.from,
        to: l.to,
        days: l.days,
        reason: l.reason,
        status: l.status,
      })),
    });
  }

  return {
    student: {
      _id: student._id.toString(),
      admissionNo: student.admissionNo,
      rollNo: student.rollNo,
      firstName: student.firstName,
      lastName: student.lastName,
      gender: student.gender,
      dateOfBirth: student.dateOfBirth,
      admissionDate: student.admissionDate,
      status: student.status,
      statusChangedAt: student.statusChangedAt,
      leavingReason: student.leavingReason,
      initialSession,
      currentSession: {
        _id: student.sessionId?.toString(),
      },
      currentClass: {
        _id: student.classId?.toString(),
      },
      currentSection: {
        _id: student.sectionId?.toString(),
      },
      guardians,
    },
    totalSessionsCount: enrollments.length,
    sessions: sessionRecords,
  };
}
