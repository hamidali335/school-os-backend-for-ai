import type { Permission } from '../../config/permissions';
import type { SchoolContext, SystemContext } from '../../types/context';
import {
  addDays,
  currentPeriod,
  formatDateOnly,
  parseDateOnly,
  startOfLocalDay,
  startOfLocalMonth,
  startOfMonthUtc,
  todayInTz,
} from '../../utils/dates';
import { notFound } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import { assertStudentVisible, teacherSectionIds, visibleStudentIds } from '../academics/access.service';
import { Section } from '../academics/academics.models';
import { pipeline as admissionsPipeline } from '../admissions/admissions.service';
import { pendingApprovalCount } from '../approvals/approvals.service';
import { AttendanceRecord, type AttendanceStatus } from '../attendance/attendance.model';
import { countStatuses } from '../attendance/attendance-stats';
import { dailySummary, registerStates } from '../attendance/attendance.service';
import { Notification } from '../communications/communications.models';
import { Employee } from '../employees/employee.model';
import { Exam, ExamPaper } from '../examinations/exam.models';
import { Invoice, Payment } from '../fees/fees.models';
import { Homework, HomeworkSubmission } from '../homework/homework.models';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { TimetableEntry } from '../timetable/timetable.model';

type Actor = SchoolContext | SystemContext;

async function tzToday(schoolId: string) {
  const s = await School.findById(schoolId).select('settings.timezone settings.currentSessionId').lean();
  const tz = s?.settings?.timezone ?? 'Asia/Karachi';
  return { tz, todayStr: todayInTz(tz), today: parseDateOnly(todayInTz(tz)), sessionId: s?.settings?.currentSessionId };
}

/** Fee position computed from invoices and payments (never estimated). */
export async function feeSnapshot(actor: Actor) {
  const { tz, today, todayStr } = await tzToday(actor.schoolId);
  const period = currentPeriod(tz);
  const prevPeriod = formatDateOnly(addDays(startOfMonthUtc(period), -1)).slice(0, 7);
  // Payments are timestamps, so "today" and the months begin at local midnight in the school's timezone.
  const todayStart = startOfLocalDay(todayStr, tz);
  const monthStart = startOfLocalMonth(period, tz);
  const prevMonthStart = startOfLocalMonth(prevPeriod, tz);
  const cs = actor.kind === 'school' ? campusScope(actor) : {};
  const [outstanding, collected, periodInvoices] = await Promise.all([
    Invoice.aggregate([
      { $match: scope(actor, { status: { $in: ['unpaid', 'partial'] }, ...cs }) },
      {
        $group: {
          _id: null,
          balance: { $sum: '$balance' },
          invoices: { $sum: 1 },
          overdueBalance: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, '$balance', 0] } },
          overdueInvoices: { $sum: { $cond: [{ $lt: ['$dueDate', today] }, 1, 0] } },
          overdueStudents: { $addToSet: { $cond: [{ $lt: ['$dueDate', today] }, '$studentId', null] } },
        },
      },
    ]),
    Payment.aggregate([
      { $match: scope(actor, { status: 'valid', receivedAt: { $gte: prevMonthStart }, ...cs }) },
      {
        $group: {
          _id: null,
          thisMonth: { $sum: { $cond: [{ $gte: ['$receivedAt', monthStart] }, '$amount', 0] } },
          lastMonth: { $sum: { $cond: [{ $lt: ['$receivedAt', monthStart] }, '$amount', 0] } },
          today: { $sum: { $cond: [{ $gte: ['$receivedAt', todayStart] }, '$amount', 0] } },
        },
      },
    ]),
    Invoice.aggregate([
      { $match: scope(actor, { period, status: { $ne: 'cancelled' }, ...cs }) },
      { $group: { _id: null, billed: { $sum: '$total' }, paid: { $sum: '$paid' } } },
    ]),
  ]);
  const o = outstanding[0];
  const c = collected[0];
  const p = periodInvoices[0];
  return {
    period,
    outstandingBalance: o?.balance ?? 0,
    unpaidInvoices: o?.invoices ?? 0,
    overdueBalance: o?.overdueBalance ?? 0,
    overdueInvoices: o?.overdueInvoices ?? 0,
    overdueStudents: (o?.overdueStudents ?? []).filter(Boolean).length,
    collectedToday: c?.today ?? 0,
    collectedThisMonth: c?.thisMonth ?? 0,
    collectedLastMonth: c?.lastMonth ?? 0,
    currentPeriodBilled: p?.billed ?? 0,
    currentPeriodPaid: p?.paid ?? 0,
    currentPeriodCollectionRate: p?.billed ? Math.round((p.paid / p.billed) * 1000) / 10 : null,
  };
}

export async function adminDashboard(actor: Actor) {
  const { today, todayStr } = await tzToday(actor.schoolId);
  const monthStart = startOfMonthUtc(todayStr.slice(0, 7));
  const cs = actor.kind === 'school' ? campusScope(actor) : {};
  const [studentsByGender, newAdmissions, staff, attendance, fees, admissions, approvals, upcomingPapers] =
    await Promise.all([
      Student.aggregate([
        { $match: scope(actor, { status: 'active', ...cs }) },
        { $group: { _id: '$gender', count: { $sum: 1 } } },
      ]),
      Student.countDocuments(scope(actor, { admissionDate: { $gte: monthStart }, ...cs })),
      Employee.aggregate([
        { $match: scope(actor, { status: 'active', ...cs }) },
        { $group: { _id: '$staffType', count: { $sum: 1 } } },
      ]),
      dailySummary(actor),
      feeSnapshot(actor),
      admissionsPipeline(actor),
      pendingApprovalCount(actor),
      ExamPaper.aggregate([
        { $match: scope(actor, { date: { $gte: today, $lte: addDays(today, 14) } }) },
        { $group: { _id: '$examId', firstPaper: { $min: '$date' }, papers: { $sum: 1 } } },
        { $lookup: { from: 'exams', localField: '_id', foreignField: '_id', as: 'exam' } },
        { $unwind: '$exam' },
        { $project: { _id: 0, examId: '$_id', name: '$exam.name', firstPaper: 1, papers: 1 } },
        { $sort: { firstPaper: 1 } },
      ]),
    ]);
  const gender = Object.fromEntries(studentsByGender.map((g) => [g._id, g.count])) as Record<string, number>;
  const staffBy = Object.fromEntries(staff.map((s) => [s._id, s.count])) as Record<string, number>;

  const actions: Array<{
    type: string;
    priority: 'high' | 'medium' | 'low';
    title: string;
    count: number;
    link: string;
  }> = [];
  if (attendance.sectionsTotal - attendance.sectionsMarked > 0) {
    actions.push({
      type: 'attendance_unmarked',
      priority: 'high',
      title: 'Sections without attendance today',
      count: attendance.sectionsTotal - attendance.sectionsMarked,
      link: '/attendance/daily',
    });
  }
  if (attendance.incompleteSections.length) {
    actions.push({
      type: 'attendance_incomplete',
      priority: 'high',
      title: 'Sections with incomplete attendance today',
      count: attendance.incompleteSections.length,
      link: '/attendance/daily',
    });
  }
  if (approvals)
    actions.push({
      type: 'approvals_pending',
      priority: 'high',
      title: 'Requests awaiting approval',
      count: approvals,
      link: '/approvals?status=pending',
    });
  if (fees.overdueInvoices) {
    actions.push({
      type: 'fees_overdue',
      priority: 'medium',
      title: 'Overdue fee invoices',
      count: fees.overdueInvoices,
      link: '/fees/invoices?overdue=true',
    });
  }
  if (admissions.followUps.overdue + admissions.followUps.dueToday) {
    actions.push({
      type: 'admission_followups',
      priority: 'medium',
      title: 'Admission follow-ups due',
      count: admissions.followUps.overdue + admissions.followUps.dueToday,
      link: '/admissions/inquiries?followUpDue=true',
    });
  }
  return {
    role: 'admin' as const,
    date: todayStr,
    students: {
      active: Object.values(gender).reduce((a, b) => a + b, 0),
      byGender: gender,
      newThisMonth: newAdmissions,
    },
    staff: {
      active: Object.values(staffBy).reduce((a, b) => a + b, 0),
      teaching: staffBy.teaching ?? 0,
      nonTeaching: staffBy.non_teaching ?? 0,
    },
    attendanceToday: {
      rate: attendance.overall.rate,
      present: attendance.overall.present,
      absent: attendance.overall.absent,
      late: attendance.overall.late,
      sectionsMarked: attendance.sectionsMarked,
      sectionsTotal: attendance.sectionsTotal,
    },
    fees,
    admissions: {
      open: admissions.open,
      conversionRate: admissions.conversionRate,
      followUps: admissions.followUps,
      stages: admissions.stages,
    },
    approvalsPending: approvals,
    upcomingExams: upcomingPapers.map((e) => ({ ...e, firstPaper: formatDateOnly(e.firstPaper) })),
    actions,
  };
}

export async function teacherDashboard(ctx: SchoolContext) {
  const { today, todayStr } = await tzToday(ctx.schoolId);
  const sectionIds = (await teacherSectionIds(ctx)).map(oid);
  const dow = ((today.getUTCDay() + 6) % 7) + 1;
  const [sections, marked, periods, homework] = await Promise.all([
    Section.find(scope(ctx, { _id: { $in: sectionIds } }))
      .select('name classId')
      .populate('classId', 'name')
      .lean(),
    AttendanceRecord.distinct('sectionId', scope(ctx, { sectionId: { $in: sectionIds }, date: today })),
    ctx.employeeId
      ? TimetableEntry.find(scope(ctx, { teacherId: oid(ctx.employeeId), dayOfWeek: dow }))
          .sort({ startMinutes: 1 })
          .populate('subjectId', 'name')
          .populate('sectionId', 'name')
          .lean()
      : [],
    Homework.find(scope(ctx, { createdBy: oid(ctx.userId), dueDate: { $gte: addDays(today, -14) } }))
      .select('title dueDate sectionId')
      .lean(),
  ]);
  const markedSet = new Set(marked.map(String));
  const states = await registerStates(ctx, sectionIds, today);
  const stateOf = (id: unknown) => states.get(String(id));
  const submissionCounts = await HomeworkSubmission.aggregate([
    { $match: scope(ctx, { homeworkId: { $in: homework.map((h) => h._id) }, status: 'submitted' }) },
    { $group: { _id: null, toGrade: { $sum: 1 } } },
  ]);
  return {
    role: 'teacher' as const,
    date: todayStr,
    sections: sections.map((s) => ({
      sectionId: s._id,
      name: `${(s.classId as any)?.name ?? ''} ${s.name}`.trim(),
      attendanceMarkedToday: markedSet.has(s._id.toString()),
      attendanceState: stateOf(s._id)?.state ?? 'not_started',
      attendanceMissing: stateOf(s._id)?.missing ?? 0,
    })),
    todaysPeriods: periods.map((p: any) => ({
      startTime: p.startTime,
      endTime: p.endTime,
      subject: p.subjectId?.name,
      section: p.sectionId?.name,
      room: p.room,
    })),
    homeworkDueThisWeek: homework.filter((h) => h.dueDate >= today && h.dueDate <= addDays(today, 7)).length,
    submissionsToGrade: submissionCounts[0]?.toGrade ?? 0,
    actions: sections
      .filter((s) => stateOf(s._id)?.state !== 'complete' && (stateOf(s._id)?.enrolled ?? 0) > 0)
      .map((s) => {
        const st = stateOf(s._id)!;
        const name = `${(s.classId as any)?.name ?? ''} ${s.name}`.trim();
        return st.state === 'draft'
          ? {
              type: 'attendance_incomplete',
              priority: 'high' as const,
              title: st.missing
                ? `Finish attendance: ${name} (${st.missing} not marked)`
                : `Submit attendance: ${name} (saved as draft)`,
              count: Math.max(st.missing, 1),
              link: `/attendance/sections/${s._id}`,
            }
          : {
              type: 'attendance_unmarked',
              priority: 'high' as const,
              title: `Mark attendance: ${name}`,
              count: 1,
              link: `/attendance/sections/${s._id}`,
            };
      }),
  };
}

export async function studentOverview(ctx: SchoolContext | SystemContext, studentId: string) {
  if (ctx.kind === 'school') await assertStudentVisible(ctx, studentId);
  const student = await Student.findOne(scope(ctx, { _id: oid(studentId) }))
    .select('firstName lastName admissionNo classId sectionId status feeConcession')
    .populate('classId', 'name')
    .populate('sectionId', 'name')
    .lean();
  if (!student) throw notFound('Student');
  const { today } = await tzToday(ctx.schoolId);
  const since = addDays(today, -30);
  const family = ctx.kind === 'school' ? await visibleStudentIds(ctx) : null;
  const canSeeFees = ctx.kind !== 'school' || ctx.permissions.has('fees:read');
  const [records, invoices, latestExam, homework] = await Promise.all([
    AttendanceRecord.find(scope(ctx, { studentId: student._id, date: { $gte: since, $lte: today } }))
      .select('status')
      .lean(),
    Invoice.find(scope(ctx, { studentId: student._id, status: { $in: ['unpaid', 'partial'] } }))
      .select('invoiceNo period balance dueDate')
      .sort({ dueDate: 1 })
      .lean(),
    Exam.findOne(
      scope(ctx, {
        classIds: student.classId,
        ...(family ? { status: 'published' } : { status: { $in: ['marks_entry', 'published'] } }),
      }),
    )
      .sort({ endDate: -1, createdAt: -1 })
      .select('name status')
      .lean(),
    Homework.find(scope(ctx, { sectionId: student.sectionId, dueDate: { $gte: today } }))
      .select('title dueDate subjectId')
      .populate('subjectId', 'name')
      .sort({ dueDate: 1 })
      .limit(10)
      .lean(),
  ]);
  return {
    student: {
      _id: student._id,
      name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
      admissionNo: student.admissionNo,
      class: (student.classId as any)?.name,
      section: (student.sectionId as any)?.name,
      status: student.status,
    },
    attendanceLast30Days: countStatuses(records.map((r) => r.status as AttendanceStatus)),
    // Fee balances only for people allowed to see fees (not, e.g., teachers).
    fees: canSeeFees
      ? {
          outstanding: invoices.reduce((s, i) => s + i.balance, 0),
          overdue: invoices.filter((i) => i.dueDate < today).reduce((s, i) => s + i.balance, 0),
          openInvoices: invoices.map((i) => ({
            invoiceNo: i.invoiceNo,
            period: i.period,
            balance: i.balance,
            dueDate: formatDateOnly(i.dueDate),
          })),
        }
      : null,
    latestExam: latestExam ? { examId: latestExam._id, name: latestExam.name, status: latestExam.status } : null,
    upcomingHomework: homework.map((h: any) => ({
      homeworkId: h._id,
      title: h.title,
      subject: h.subjectId?.name,
      dueDate: formatDateOnly(h.dueDate),
    })),
  };
}

export async function familyDashboard(ctx: SchoolContext) {
  const ids = (await visibleStudentIds(ctx)) ?? [];
  const [children, unread] = await Promise.all([
    Promise.all(ids.map((id) => studentOverview(ctx, id))),
    Notification.countDocuments(scope(ctx, { userId: oid(ctx.userId), readAt: null })),
  ]);
  return {
    role: 'parent' as const,
    date: (await tzToday(ctx.schoolId)).todayStr,
    unreadNotifications: unread,
    children,
    actions: children
      .filter((c) => (c.fees?.overdue ?? 0) > 0)
      .map((c) => ({
        type: 'fee_overdue',
        priority: 'high' as const,
        title: `Overdue fees for ${c.student.name}: Rs ${c.fees?.overdue}`,
        count: 1,
        link: `/fees/students/${c.student._id}/ledger`,
      })),
  };
}

export async function accountantDashboard(ctx: SchoolContext) {
  const fees = await feeSnapshot(ctx);
  const approvals = await pendingApprovalCount(ctx);
  return {
    role: 'accountant' as const,
    date: (await tzToday(ctx.schoolId)).todayStr,
    fees,
    approvalsPending: approvals,
    actions: fees.overdueInvoices
      ? [
          {
            type: 'fees_overdue',
            priority: 'medium' as const,
            title: 'Overdue fee invoices',
            count: fees.overdueInvoices,
            link: '/fees/invoices?overdue=true',
          },
        ]
      : [],
  };
}

export async function dashboardFor(ctx: SchoolContext) {
  switch (ctx.role) {
    case 'teacher':
      return teacherDashboard(ctx);
    case 'parent':
      return familyDashboard(ctx);
    case 'accountant':
      return accountantDashboard(ctx);
    case 'staff':
      return staffDashboard(ctx);
    default:
      return adminDashboard(ctx);
  }
}

/**
 * Custom-role office staff see the admin dashboard with every panel they lack the permission
 * for removed (null), so the dashboard never becomes a side door around their role.
 */
async function staffDashboard(ctx: SchoolContext) {
  const d = await adminDashboard(ctx);
  const can = (p: Permission) => ctx.permissions.has(p);
  const actionPermission: Record<string, Permission> = {
    attendance_unmarked: 'attendance:read',
    attendance_incomplete: 'attendance:read',
    approvals_pending: 'approvals:read',
    fees_overdue: 'fees:read',
    admission_followups: 'admissions:read',
  };
  return {
    ...d,
    students: can('students:read') ? d.students : null,
    staff: can('employees:read') ? d.staff : null,
    attendanceToday: can('attendance:read') ? d.attendanceToday : null,
    fees: can('fees:read') ? d.fees : null,
    admissions: can('admissions:read') ? d.admissions : null,
    approvalsPending: can('approvals:read') ? d.approvalsPending : 0,
    upcomingExams: can('exams:read') ? d.upcomingExams : [],
    actions: d.actions.filter((a) => {
      const p = actionPermission[a.type];
      return !p || can(p);
    }),
  };
}
