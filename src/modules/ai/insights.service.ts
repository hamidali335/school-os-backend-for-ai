import type { SchoolContext, SystemContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { scope } from '../../utils/tenant';
import { pipeline as admissionsPipeline } from '../admissions/admissions.service';
import { Inquiry } from '../admissions/inquiry.model';
import { pendingApprovalCount } from '../approvals/approvals.service';
import { attendanceReport, chronicAbsentees, dailySummary } from '../attendance/attendance.service';
import { Invoice } from '../fees/fees.models';
import { feeSnapshot } from '../reports/dashboard.service';
import { School } from '../schools/school.model';

type Actor = SchoolContext | SystemContext;

export interface Insight {
  id: string;
  category: 'attendance' | 'fees' | 'admissions' | 'operations';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  metrics: Record<string, unknown>;
  /** Rule-based next step, available even when AI is not. */
  recommendation: string;
}

async function today(schoolId: string) {
  const s = await School.findById(schoolId).select('settings.timezone settings.attendance').lean();
  return {
    todayStr: todayInTz(s?.settings?.timezone ?? 'Asia/Karachi'),
    threshold: s?.settings?.attendance?.lowAttendanceThreshold ?? 75,
  };
}

export async function topOverdue(actor: Actor, limit = 10) {
  const { todayStr } = await today(actor.schoolId);
  return Invoice.aggregate([
    { $match: scope(actor, { status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: parseDateOnly(todayStr) } }) },
    {
      $group: {
        _id: '$studentId',
        overdue: { $sum: '$balance' },
        invoices: { $sum: 1 },
        oldestDue: { $min: '$dueDate' },
      },
    },
    { $sort: { overdue: -1 } },
    { $limit: limit },
    { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 's' } },
    { $unwind: '$s' },
    {
      $project: {
        _id: 0,
        studentId: '$_id',
        overdue: 1,
        invoices: 1,
        oldestDue: 1,
        admissionNo: '$s.admissionNo',
        name: { $trim: { input: { $concat: ['$s.firstName', ' ', { $ifNull: ['$s.lastName', ''] }] } } },
      },
    },
  ]);
}

/** Deterministic insights. Every number here comes from database aggregation. */
export async function computeInsights(actor: Actor) {
  const { todayStr, threshold } = await today(actor.schoolId);
  const d = parseDateOnly(todayStr);
  const last7 = { from: formatDateOnly(addDays(d, -6)), to: todayStr };
  const prev7 = { from: formatDateOnly(addDays(d, -13)), to: formatDateOnly(addDays(d, -7)) };
  const [daily, recent, previous, chronic, fees, overdueTop, admissions, staleInquiries, approvals] = await Promise.all(
    [
      dailySummary(actor),
      attendanceReport(actor, last7),
      attendanceReport(actor, prev7),
      chronicAbsentees(actor),
      feeSnapshot(actor),
      topOverdue(actor, 10),
      admissionsPipeline(actor),
      Inquiry.countDocuments(
        scope(actor, {
          stage: { $nin: ['admitted', 'lost'] },
          $or: [{ lastContactedAt: null }, { lastContactedAt: { $lt: addDays(d, -7) } }],
          createdAt: { $lt: addDays(d, -2) },
        }),
      ),
      pendingApprovalCount(actor),
    ],
  );

  const insights: Insight[] = [];

  if (recent.overall.rate !== null) {
    const change =
      previous.overall.rate !== null ? Math.round((recent.overall.rate - previous.overall.rate) * 10) / 10 : null;
    insights.push({
      id: 'attendance_trend',
      category: 'attendance',
      severity: recent.overall.rate < threshold ? 'critical' : change !== null && change <= -3 ? 'warning' : 'info',
      title: `Attendance ${recent.overall.rate}% over the last 7 days`,
      detail:
        change === null
          ? 'No attendance data for the previous week to compare.'
          : `${change >= 0 ? 'Up' : 'Down'} ${Math.abs(change)} points from ${previous.overall.rate}% the week before.`,
      metrics: { last7DaysRate: recent.overall.rate, previous7DaysRate: previous.overall.rate, change, threshold },
      recommendation:
        change !== null && change <= -3
          ? 'Review which sections dropped most and check with class teachers for causes (illness, weather, events).'
          : 'Keep monitoring; recognise sections with consistently high attendance.',
    });
  }
  if (recent.belowThresholdCount > 0) {
    insights.push({
      id: 'attendance_low_students',
      category: 'attendance',
      severity: 'warning',
      title: `${recent.belowThresholdCount} students below ${threshold}% attendance this week`,
      detail: 'Students below the school threshold over the last 7 days.',
      metrics: {
        count: recent.belowThresholdCount,
        students: recent.students.filter((s) => s.rate !== null && s.rate < threshold).slice(0, 10),
      },
      recommendation: 'Ask class teachers to contact these families and log the reasons.',
    });
  }
  if (chronic.length) {
    insights.push({
      id: 'attendance_consecutive_absences',
      category: 'attendance',
      severity: 'critical',
      title: `${chronic.length} students absent several days in a row`,
      detail: 'Consecutive absences may indicate illness, a family issue, or a student about to drop out.',
      metrics: { students: chronic.slice(0, 15) },
      recommendation: 'Call parents today; consider an attendance-alert automation for future cases.',
    });
  }
  if (daily.sectionsTotal > daily.sectionsMarked) {
    insights.push({
      id: 'attendance_unmarked',
      category: 'operations',
      severity: 'warning',
      title: `${daily.sectionsTotal - daily.sectionsMarked} of ${daily.sectionsTotal} sections have not marked attendance today`,
      detail: 'Unmarked sections make daily reports and parent alerts incomplete.',
      metrics: { unmarked: daily.unmarkedSections },
      recommendation: 'Remind the class teachers of these sections.',
    });
  }
  if (fees.overdueBalance > 0) {
    insights.push({
      id: 'fees_overdue',
      category: 'fees',
      severity: fees.overdueStudents > 20 ? 'critical' : 'warning',
      title: `Rs ${fees.overdueBalance.toLocaleString('en-PK')} overdue from ${fees.overdueStudents} students`,
      detail: `${fees.overdueInvoices} invoices are past their due date.`,
      metrics: { overdueBalance: fees.overdueBalance, overdueStudents: fees.overdueStudents, topOverdue: overdueTop },
      recommendation:
        'Send fee reminders (requires approval) and offer installment plans to families with large balances.',
    });
  }
  if (fees.collectedLastMonth > 0) {
    const pct = Math.round(((fees.collectedThisMonth - fees.collectedLastMonth) / fees.collectedLastMonth) * 1000) / 10;
    insights.push({
      id: 'fees_collection_pace',
      category: 'fees',
      severity: 'info',
      title: `Collected Rs ${fees.collectedThisMonth.toLocaleString('en-PK')} so far this month`,
      detail: `Last month's full collection was Rs ${fees.collectedLastMonth.toLocaleString('en-PK')} (${pct >= 0 ? '+' : ''}${pct}% so far).`,
      metrics: {
        collectedThisMonth: fees.collectedThisMonth,
        collectedLastMonth: fees.collectedLastMonth,
        currentPeriodCollectionRate: fees.currentPeriodCollectionRate,
      },
      recommendation: 'Compare against the due date; the bulk of collections usually arrives in the week before it.',
    });
  }
  if (admissions.followUps.overdue > 0 || staleInquiries > 0) {
    insights.push({
      id: 'admissions_followups',
      category: 'admissions',
      severity: admissions.followUps.overdue > 5 ? 'warning' : 'info',
      title: `${admissions.followUps.overdue} overdue admission follow-ups, ${staleInquiries} inquiries not contacted in 7+ days`,
      detail: `Open inquiries: ${admissions.open}. Conversion rate: ${admissions.conversionRate}%.`,
      metrics: {
        ...admissions.followUps,
        staleInquiries,
        open: admissions.open,
        conversionRate: admissions.conversionRate,
      },
      recommendation: 'Call the oldest inquiries first; families who visited or took a test convert best.',
    });
  }
  const bestSource = [...admissions.bySource]
    .filter((s) => s.total >= 3)
    .sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (bestSource) {
    insights.push({
      id: 'admissions_best_source',
      category: 'admissions',
      severity: 'info',
      title: `Best converting source: ${bestSource.source} (${bestSource.conversionRate}%)`,
      detail: `${bestSource.admitted} of ${bestSource.total} inquiries from ${bestSource.source} were admitted.`,
      metrics: { bySource: admissions.bySource },
      recommendation: 'Invest more effort in the best-converting channel.',
    });
  }
  if (approvals > 0) {
    insights.push({
      id: 'approvals_pending',
      category: 'operations',
      severity: approvals > 10 ? 'warning' : 'info',
      title: `${approvals} approval requests pending`,
      detail: 'Pending requests delay waivers, expenses and messages.',
      metrics: { pending: approvals },
      recommendation: 'Review the approval queue.',
    });
  }
  const order = { critical: 0, warning: 1, info: 2 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);
  return { generatedAt: new Date().toISOString(), date: todayStr, insights };
}

/** Facts for the daily brief plus a plain-text fallback that needs no AI. */
export async function dailyBriefFacts(actor: Actor) {
  const { insights, date } = await computeInsights(actor);
  const fees = await feeSnapshot(actor);
  const daily = await dailySummary(actor);
  const admissions = await admissionsPipeline(actor);
  const facts = {
    date,
    attendanceToday: {
      rate: daily.overall.rate,
      present: daily.overall.present,
      absent: daily.overall.absent,
      sectionsMarked: daily.sectionsMarked,
      sectionsTotal: daily.sectionsTotal,
    },
    fees: {
      collectedToday: fees.collectedToday,
      collectedThisMonth: fees.collectedThisMonth,
      overdueBalance: fees.overdueBalance,
      overdueStudents: fees.overdueStudents,
    },
    admissions: {
      open: admissions.open,
      followUpsDueToday: admissions.followUps.dueToday,
      followUpsOverdue: admissions.followUps.overdue,
    },
    topIssues: insights
      .filter((i) => i.severity !== 'info')
      .map((i) => ({ title: i.title, recommendation: i.recommendation })),
  };
  const lines = [
    `Daily brief for ${date}`,
    `• Attendance: ${facts.attendanceToday.rate ?? 'n/a'}% (${facts.attendanceToday.sectionsMarked}/${facts.attendanceToday.sectionsTotal} sections marked, ${facts.attendanceToday.absent} absent).`,
    `• Fees: Rs ${fees.collectedToday.toLocaleString('en-PK')} collected today, Rs ${fees.collectedThisMonth.toLocaleString('en-PK')} this month; Rs ${fees.overdueBalance.toLocaleString('en-PK')} overdue from ${fees.overdueStudents} students.`,
    `• Admissions: ${admissions.open} open inquiries; ${admissions.followUps.dueToday} follow-ups due today, ${admissions.followUps.overdue} overdue.`,
    ...facts.topIssues.map((i) => `• Attention: ${i.title} — ${i.recommendation}`),
  ];
  return { facts, fallbackText: lines.join('\n'), insights };
}
