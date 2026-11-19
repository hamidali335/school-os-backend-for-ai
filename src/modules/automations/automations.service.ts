import { pausedChannels, withoutPausedChannels } from '../../config/features';
import type { SchoolContext, SystemContext } from '../../types/context';
import { parseDateOnly, todayInTz } from '../../utils/dates';
import { oid, scope } from '../../utils/tenant';
import { Inquiry } from '../admissions/inquiry.model';
import { createApprovalRequest } from '../approvals/approvals.service';
import { AttendanceRecord } from '../attendance/attendance.model';
import { tryNarrate } from '../ai/ai.service';
import { dailyBriefFacts } from '../ai/insights.service';
import { notifyUsers, parentUserIdsForStudents } from '../communications/communications.service';
import type { ExternalChannel } from '../communications/communications.models';
import { applyLateFees } from '../fees/fees.service';
import { School } from '../schools/school.model';
import { Parent, Student } from '../students/student.models';
import { User } from '../users/user.model';
import { AutomationRule, AutomationRun, type AutomationType } from './automation.models';
import { proposeFeeReminders } from './reminders.service';

export const AUTOMATION_TEMPLATES: Record<
  AutomationType,
  { name: string; description: string; requiresApproval: string }
> = {
  fee_reminder: {
    name: 'Overdue fee reminders',
    description: 'Finds overdue invoices not reminded in 7 days and prepares parent reminders.',
    requiresApproval: 'Always — reminders are queued as an approval request and only sent once approved.',
  },
  admission_followup: {
    name: 'Admission follow-up reminders',
    description: 'Notifies each assigned staff member (in-app) about inquiries whose follow-up is due.',
    requiresApproval: 'No — internal staff notifications only.',
  },
  attendance_alert: {
    name: 'Absence alerts to parents',
    description:
      "Notifies parents in-app about today's absences. External SMS/WhatsApp/email alerts are batched for approval.",
    requiresApproval: 'In-app: no. External channels: yes (message batch approval).',
  },
  late_fee: {
    name: 'Apply late fees',
    description:
      'Applies the late fee configured in school settings to invoices overdue beyond the grace period (once per invoice).',
    requiresApproval: 'No — applies the school’s own configured policy; every run is logged and audited.',
  },
  daily_brief: {
    name: 'Daily brief to leadership',
    description:
      'Sends the daily brief to the owner and principal as an in-app notification (AI-written when available).',
    requiresApproval: 'No — internal notification only.',
  },
};

// ───────────────────────────── Scheduling maths ─────────────────────────────

function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Next run strictly after `from`, at `hour`:00 school-local time. */
export function computeNextRun(
  schedule: { frequency?: string | null; hour?: number | null; weekday?: number | null },
  timeZone: string,
  from = new Date(),
): Date {
  const hour = schedule.hour ?? 9;
  const localToday = todayInTz(timeZone, from);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(parseDateOnly(localToday).getTime() + i * 86_400_000);
    const isoWeekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (schedule.frequency === 'weekly' && schedule.weekday && isoWeekday !== schedule.weekday) continue;
    const localMidnightAsUtc = day.getTime() + hour * 3_600_000;
    const candidate = new Date(localMidnightAsUtc - tzOffsetMinutes(timeZone, new Date(localMidnightAsUtc)) * 60_000);
    if (candidate > from) return candidate;
  }
  return new Date(from.getTime() + 86_400_000);
}

// ───────────────────────────── Rule execution ─────────────────────────────

type Rule = {
  _id: unknown;
  type: AutomationType;
  config?: { channels?: string[] | null; minDaysOverdue?: number | null } | null;
};

async function runFeeReminder(actor: SystemContext, rule: Rule) {
  // Paused channels (coming soon) are left out; in-app reminders still go ahead.
  const paused = pausedChannels(rule.config?.channels ?? []);
  const approval = await proposeFeeReminders(actor, {
    channels: withoutPausedChannels((rule.config?.channels ?? []) as ExternalChannel[]),
    minDaysOverdue: rule.config?.minDaysOverdue ?? 3,
    source: 'automation',
  });
  if (!approval) return { status: 'skipped' as const, summary: 'No overdue invoices need a reminder', result: {} };
  return {
    status: 'success' as const,
    summary: `Approval request created: ${approval.title}`,
    result: { approvalId: approval._id.toString(), ...(paused.length ? { pausedChannels: paused } : {}) },
  };
}

async function runAdmissionFollowup(actor: SystemContext) {
  const due = await Inquiry.aggregate([
    {
      $match: scope(actor, {
        stage: { $nin: ['admitted', 'lost'] },
        nextFollowUpAt: { $lte: new Date() },
        assignedTo: { $ne: null },
      }),
    },
    { $group: { _id: '$assignedTo', count: { $sum: 1 } } },
  ]);
  let notified = 0;
  for (const row of due) {
    notified += await notifyUsers(actor, [row._id], {
      title: 'Admission follow-ups due',
      body: `You have ${row.count} admission inquiries due for follow-up.`,
      category: 'admissions',
      link: '/admissions/inquiries?followUpDue=true',
    });
  }
  const total = due.reduce((s, r) => s + r.count, 0);
  if (!total) return { status: 'skipped' as const, summary: 'No follow-ups due', result: {} };
  return {
    status: 'success' as const,
    summary: `${total} follow-ups due; ${notified} staff notified`,
    result: { inquiries: total, staffNotified: notified },
  };
}

async function runAttendanceAlert(actor: SystemContext, rule: Rule) {
  const school = await School.findById(actor.schoolId).select('name settings.timezone').lean();
  const dateStr = todayInTz(school?.settings?.timezone ?? 'Asia/Karachi');
  const day = parseDateOnly(dateStr);
  const absences = await AttendanceRecord.find(scope(actor, { date: day, status: 'absent', parentNotifiedAt: null }))
    .select('studentId')
    .lean();
  if (!absences.length) return { status: 'skipped' as const, summary: 'No new absences to report', result: {} };
  const students = await Student.find(scope(actor, { _id: { $in: absences.map((a) => a.studentId) } }))
    .select('firstName lastName guardians')
    .lean();
  let inApp = 0;
  const batch: Array<{ parentId: string; channel: string; to: string; text: string; recipientName: string }> = [];
  // Paused channels (coming soon) are skipped; parents still get the in-app notice.
  const paused = pausedChannels(rule.config?.channels ?? []);
  const channels = withoutPausedChannels((rule.config?.channels ?? []) as ExternalChannel[]);
  for (const s of students) {
    const name = `${s.firstName} ${s.lastName ?? ''}`.trim();
    const text = `${school?.name}: ${name} was marked absent today (${dateStr}). Please inform the school if this is unexpected.`;
    inApp += await notifyUsers(actor, await parentUserIdsForStudents(actor, [s._id]), {
      title: 'Absence notice',
      body: text,
      category: 'attendance',
    });
    if (channels.length) {
      const primary = s.guardians.find((g) => g.isPrimary) ?? s.guardians[0];
      const parent = primary
        ? await Parent.findOne(scope(actor, { _id: primary.parentId }))
            .select('name phone whatsapp email')
            .lean()
        : null;
      if (parent) {
        for (const ch of channels) {
          const to =
            ch === 'email' ? parent.email : ch === 'whatsapp' ? (parent.whatsapp ?? parent.phone) : parent.phone;
          if (to) batch.push({ parentId: parent._id.toString(), channel: ch, to, text, recipientName: parent.name });
        }
      }
    }
  }
  await AttendanceRecord.updateMany(scope(actor, { _id: { $in: absences.map((a) => a._id) } }), {
    $set: { parentNotifiedAt: new Date() },
  });
  let approvalId: string | undefined;
  if (batch.length) {
    const approval = await createApprovalRequest(actor, {
      type: 'message_batch',
      title: `Send ${batch.length} absence alerts via ${channels.join(', ')}`,
      source: 'automation',
      payload: { messages: batch, relatedType: 'AttendanceAlert' },
      data: { date: dateStr, absentStudents: students.length, messages: batch.length },
      analysis: `${students.length} students were marked absent today.`,
      recommendation: 'Approve to notify parents by external channels.',
    });
    approvalId = approval._id.toString();
  }
  return {
    status: 'success' as const,
    summary: `${students.length} absences; ${inApp} parents notified in-app${approvalId ? '; external alerts awaiting approval' : ''}`,
    result: {
      absentStudents: students.length,
      inAppNotifications: inApp,
      approvalId,
      ...(paused.length ? { pausedChannels: paused } : {}),
    },
  };
}

async function runDailyBrief(actor: SystemContext) {
  const { facts, fallbackText } = await dailyBriefFacts(actor);
  const n = await tryNarrate(
    actor,
    'daily_brief',
    'Write a short morning brief (under 180 words) for school leadership.',
    facts,
  );
  const leaders = await User.find(scope(actor, { role: { $in: ['school_owner', 'principal'] }, status: 'active' }))
    .select('_id')
    .lean();
  const sent = await notifyUsers(
    actor,
    leaders.map((l) => l._id),
    { title: `Daily brief ${facts.date}`, body: n.narrative ?? fallbackText, category: 'brief' },
  );
  return {
    status: 'success' as const,
    summary: `Brief sent to ${sent} leaders (${n.aiStatus === 'ok' ? 'AI-written' : 'standard text'})`,
    result: { recipients: sent, ai: n.aiStatus },
  };
}

export async function executeRule(
  schoolId: string,
  rule: Rule,
  trigger: 'schedule' | 'manual',
  triggeredBy?: SchoolContext,
) {
  const actor: SystemContext = { kind: 'system', schoolId, label: `automation:${rule.type}` };
  const startedAt = new Date();
  let outcome: {
    status: 'success' | 'skipped' | 'failed';
    summary: string;
    result: Record<string, unknown>;
    error?: string;
  };
  try {
    switch (rule.type) {
      case 'fee_reminder':
        outcome = await runFeeReminder(actor, rule);
        break;
      case 'admission_followup':
        outcome = await runAdmissionFollowup(actor);
        break;
      case 'attendance_alert':
        outcome = await runAttendanceAlert(actor, rule);
        break;
      case 'late_fee': {
        const r = await applyLateFees(actor);
        outcome = {
          status: r.applied ? 'success' : 'skipped',
          summary: `Late fee applied to ${r.applied} invoices`,
          result: r,
        };
        break;
      }
      case 'daily_brief':
        outcome = await runDailyBrief(actor);
        break;
    }
  } catch (err) {
    outcome = {
      status: 'failed',
      summary: 'Run failed',
      result: {},
      error: err instanceof Error ? err.message.slice(0, 500) : 'Unknown error',
    };
  }
  const run = await AutomationRun.create({
    schoolId: oid(schoolId),
    ruleId: rule._id as any,
    type: rule.type,
    trigger,
    triggeredBy: triggeredBy ? oid(triggeredBy.userId) : undefined,
    ...outcome!,
    startedAt,
    finishedAt: new Date(),
  });
  await AutomationRule.updateOne(
    { schoolId: oid(schoolId), _id: rule._id },
    { $set: { lastRunAt: startedAt, lastRunStatus: outcome!.status } },
  );
  return run.toObject();
}
