import { pausedChannels, pausedMessage, withoutPausedChannels } from '../../config/features';
import type { SchoolContext, SystemContext } from '../../types/context';
import { parseDateOnly, todayInTz } from '../../utils/dates';
import { oid, scope } from '../../utils/tenant';
import { createApprovalRequest } from '../approvals/approvals.service';
import { audit } from '../audit/audit.service';
import type { ExternalChannel } from '../communications/communications.models';
import {
  dispatchMessage,
  messagingQuota,
  notifyUsers,
  runInBackground,
} from '../communications/communications.service';
import { Invoice } from '../fees/fees.models';
import { School } from '../schools/school.model';
import { Parent, Student } from '../students/student.models';
import { User } from '../users/user.model';

type Actor = SchoolContext | SystemContext;

/** Overdue invoices eligible for a reminder (not reminded within `minDaysBetween`). */
export async function overdueForReminder(
  actor: Actor,
  opts: { minDaysOverdue?: number; minDaysBetween?: number; limit?: number } = {},
) {
  const school = await School.findById(actor.schoolId).select('settings.timezone').lean();
  const today = parseDateOnly(todayInTz(school?.settings?.timezone ?? 'Asia/Karachi'));
  const dueBefore = new Date(today.getTime() - (opts.minDaysOverdue ?? 1) * 86_400_000 + 86_400_000);
  const remindedBefore = new Date(Date.now() - (opts.minDaysBetween ?? 7) * 86_400_000);
  return Invoice.find(
    scope(actor, {
      status: { $in: ['unpaid', 'partial'] },
      dueDate: { $lt: dueBefore },
      $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: remindedBefore } }],
    }),
  )
    .select('invoiceNo studentId period balance dueDate')
    .populate('studentId', 'firstName lastName admissionNo')
    .sort({ dueDate: 1 })
    .limit(opts.limit ?? 500)
    .lean();
}

/**
 * Create a fee-reminder approval request. DATA = overdue invoices computed by code;
 * the reminders are only sent after a person approves.
 */
export async function proposeFeeReminders(
  actor: Actor,
  input: {
    channels: ExternalChannel[];
    minDaysOverdue?: number;
    recommendation?: string;
    source?: 'user' | 'ai' | 'automation';
  },
) {
  const invoices = await overdueForReminder(actor, { minDaysOverdue: input.minDaysOverdue });
  if (!invoices.length) return null;
  // Paused channels (coming soon) are never proposed; in-app reminders are always included.
  input = { ...input, channels: withoutPausedChannels(input.channels) };
  const total = invoices.reduce((s, i) => s + i.balance, 0);
  return createApprovalRequest(actor, {
    type: 'fee_reminder_batch',
    title: `Send fee reminders for ${invoices.length} overdue invoices (Rs ${total.toLocaleString('en-PK')})`,
    source: input.source,
    amount: total,
    // invoiceIds drive the action; invoiceNos are what people read on the approval screen.
    payload: {
      invoiceIds: invoices.map((i) => i._id.toString()),
      invoiceNos: invoices.map((i) => i.invoiceNo),
      channels: input.channels,
    },
    data: {
      invoices: invoices.length,
      totalOverdue: total,
      sample: invoices.slice(0, 10).map((i: any) => ({
        invoiceNo: i.invoiceNo,
        student: `${i.studentId?.firstName ?? ''} ${i.studentId?.lastName ?? ''}`.trim(),
        balance: i.balance,
        dueDate: i.dueDate,
      })),
    },
    analysis: `${invoices.length} invoices are overdue and have not received a reminder in the last 7 days.`,
    recommendation:
      input.recommendation ??
      `Send a polite reminder via in-app${input.channels.length ? ` and ${input.channels.join(', ')}` : ''} with the outstanding amount.`,
  });
}

export function reminderText(
  schoolName: string,
  studentName: string,
  invoiceNo: string,
  period: string,
  balance: number,
) {
  return (
    `Dear Parent, this is a reminder from ${schoolName} that Rs ${balance.toLocaleString('en-PK')} is outstanding for ${studentName} ` +
    `(challan ${invoiceNo}, ${period}). Please pay at your earliest convenience or contact the accounts office. Thank you.`
  );
}

/** Executes an approved reminder batch. External delivery runs in the background and is logged per message. */
export async function sendFeeReminders(
  actor: Actor,
  approvalId: string,
  payload: { invoiceIds: string[]; invoiceNos?: string[]; channels: ExternalChannel[] },
) {
  const school = await School.findById(actor.schoolId).select('name').lean();
  const invoices = await Invoice.find(
    scope(actor, { _id: { $in: payload.invoiceIds.map(oid) }, status: { $in: ['unpaid', 'partial'] } }),
  )
    .select('invoiceNo studentId period balance')
    .lean();
  const students = await Student.find(scope(actor, { _id: { $in: invoices.map((i) => i.studentId) } }))
    .select('firstName lastName guardians')
    .lean();
  const studentById = new Map(students.map((s) => [s._id.toString(), s]));
  const parentIds = [...new Set(students.flatMap((s) => s.guardians.map((g) => g.parentId.toString())))];
  const parents = await Parent.find(scope(actor, { _id: { $in: parentIds.map(oid) } }))
    .select('name phone whatsapp email')
    .lean();
  const parentById = new Map(parents.map((p) => [p._id.toString(), p]));
  const parentUsers = await User.find(scope(actor, { parentId: { $in: parentIds.map(oid) }, status: 'active' }))
    .select('parentId')
    .lean();
  const userByParent = new Map(parentUsers.map((u) => [u.parentId!.toString(), u._id.toString()]));

  let inApp = 0;
  const jobs: Parameters<typeof dispatchMessage>[1][] = [];
  for (const inv of invoices) {
    const st = studentById.get(inv.studentId.toString());
    if (!st) continue;
    const name = `${st.firstName} ${st.lastName ?? ''}`.trim();
    const text = reminderText(school?.name ?? 'the school', name, inv.invoiceNo, inv.period, inv.balance);
    const primary = st.guardians.find((g) => g.isPrimary) ?? st.guardians[0];
    const parentId = primary?.parentId.toString();
    const userId = parentId ? userByParent.get(parentId) : undefined;
    if (userId)
      inApp += await notifyUsers(actor, [userId], {
        title: 'Fee reminder',
        body: text,
        category: 'fees',
        link: `/fees/invoices/${inv._id}`,
      });
    const parent = parentId ? parentById.get(parentId) : undefined;
    if (parent) {
      // Paused channels (coming soon) are skipped: no job, no provider request.
      for (const channel of withoutPausedChannels(payload.channels)) {
        const to =
          channel === 'email'
            ? parent.email
            : channel === 'whatsapp'
              ? (parent.whatsapp ?? parent.phone)
              : parent.phone;
        if (to)
          jobs.push({
            channel,
            to,
            subject: 'Fee reminder',
            body: text,
            recipientName: parent.name,
            recipientParentId: parent._id,
            relatedType: 'FeeReminder',
            relatedId: approvalId,
          });
      }
    }
  }
  await Invoice.updateMany(scope(actor, { _id: { $in: invoices.map((i) => i._id) } }), {
    $set: { lastReminderAt: new Date() },
  });
  if (jobs.length) {
    runInBackground(async () => {
      const quota = await messagingQuota(actor.schoolId);
      for (const j of jobs) await dispatchMessage(actor, j, quota);
    });
  }
  await audit(actor, {
    action: 'fees.reminders_sent',
    entityType: 'ApprovalRequest',
    entityId: approvalId,
    metadata: { invoices: invoices.length, inApp, external: jobs.length },
  });
  const paused = pausedChannels(payload.channels);
  return {
    invoices: invoices.length,
    inAppNotifications: inApp,
    externalMessagesQueued: jobs.length,
    ...(paused.length ? { pausedChannels: paused } : {}),
    note: [
      jobs.length
        ? 'SMS, WhatsApp and email delivery results are in Communications › Message log. Messages for a channel that is not set up are shown there as "Not configured".'
        : 'No external messages were queued.',
      paused.length ? `Not sent: ${pausedMessage(paused)}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
