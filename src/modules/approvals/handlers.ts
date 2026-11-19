import { isChannelEnabled, pausedChannels, pausedMessage } from '../../config/features';
import { setExpenseStatus } from '../accounts/accounts.service';
import { sendFeeReminders } from '../automations/reminders.service';
import type { ExternalChannel } from '../communications/communications.models';
import {
  dispatchMessage,
  messagingQuota,
  publishNow,
  rejectAnnouncement,
  runInBackground,
} from '../communications/communications.service';
import { executeCancel, executeConcession, executeReversal, executeWaiver } from '../fees/fees.service';
import { registerApprovalHandler } from './approvals.service';

/**
 * Maps each approval type to the application code that performs the action once a
 * person approves it. Registered once at startup.
 */
let registered = false;
export function registerApprovalHandlers() {
  if (registered) return;
  registered = true;

  registerApprovalHandler('expense', {
    transactional: true,
    execute: (ctx, req) => setExpenseStatus(ctx, req.payload.expenseId, 'approved'),
    onReject: async (ctx, req) => {
      await setExpenseStatus(ctx, req.payload.expenseId, 'rejected');
    },
  });

  registerApprovalHandler('invoice_waiver', {
    transactional: true,
    execute: (ctx, req) => executeWaiver(ctx, req.payload),
  });
  registerApprovalHandler('invoice_cancel', {
    transactional: true,
    execute: (ctx, req) => executeCancel(ctx, req.payload),
  });
  registerApprovalHandler('payment_reversal', {
    transactional: true,
    execute: (ctx, req) => executeReversal(ctx, req.payload),
  });
  registerApprovalHandler('fee_concession', {
    transactional: true,
    execute: (ctx, req) => executeConcession(ctx, req._id.toString(), req.payload),
  });

  registerApprovalHandler('announcement_publish', {
    execute: async (ctx, req) => ({
      announcementId: req.payload.announcementId,
      ...(await publishNow(ctx, req.payload.announcementId)),
    }),
    onReject: (ctx, req) => rejectAnnouncement(ctx, req.payload.announcementId),
  });

  registerApprovalHandler('fee_reminder_batch', {
    execute: (ctx, req) => sendFeeReminders(ctx, req._id.toString(), req.payload),
  });

  registerApprovalHandler('message_batch', {
    execute: async (ctx, req) => {
      const all = (req.payload.messages ?? []) as Array<{
        parentId: string;
        channel: ExternalChannel;
        to: string;
        text: string;
        recipientName?: string;
      }>;
      // Paused channels (coming soon) are skipped: no job and no provider request.
      const paused = pausedChannels(all.map((m) => m.channel));
      const messages = all.filter((m) => isChannelEnabled(m.channel));
      if (!messages.length) {
        return {
          messagesQueued: 0,
          pausedChannels: paused,
          note: paused.length ? `Not sent: ${pausedMessage(paused)}` : 'There were no messages to send.',
        };
      }
      runInBackground(async () => {
        const quota = await messagingQuota(ctx.schoolId);
        for (const m of messages) {
          await dispatchMessage(
            ctx,
            {
              channel: m.channel,
              to: m.to,
              body: m.text,
              recipientName: m.recipientName,
              recipientParentId: m.parentId,
              relatedType: req.payload.relatedType ?? 'MessageBatch',
              relatedId: req._id.toString(),
            },
            quota,
          );
        }
      });
      return {
        messagesQueued: messages.length,
        ...(paused.length ? { pausedChannels: paused } : {}),
        note:
          'Delivery results are in Communications › Message log. Messages for a channel that is not set up are shown there as "Not configured".' +
          (paused.length ? ` Not sent: ${pausedMessage(paused)}` : ''),
      };
    },
  });
}
