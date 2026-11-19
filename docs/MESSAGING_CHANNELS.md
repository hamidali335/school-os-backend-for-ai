# Messaging Channels: Pause and Reactivation

SMS, WhatsApp and email sending are **temporarily paused** ("Coming soon") while their provider integrations are completed. They have not been removed. Everything is preserved:
- the provider adapters (Twilio SMS, WhatsApp Cloud API, SMTP email);
- templates and wording;
- automation rule settings and announcement drafts;
- message history and database fields.

In-app notifications are not affected and work normally.

## The switches

All three are server-side environment variables, default `false`. The backend reads them at startup, so a restart is needed after a change.

| Channel | Switch |
|---|---|
| SMS | `SMS_ENABLED` |
| WhatsApp | `WHATSAPP_ENABLED` |
| Email | `EMAIL_SENDING_ENABLED` |

The switch logic is in `src/config/features.ts`. Each channel can be turned on without the others.

## What happens while a channel is paused

| Entry point | Behaviour |
|---|---|
| `POST /communications/messages` (single send) | `503 CHANNEL_PAUSED`. Nothing is sent or logged. |
| New announcement, or adding a paused channel to a draft | `503 CHANNEL_PAUSED`. In-app announcements work. |
| Publishing a draft that already lists a paused channel | Published in-app. The paused channel is skipped, needs no approval, and is reported in `pausedChannels`. |
| Approving a request queued before the pause (announcement, fee reminders, message batch) | Executed without the paused channel. In-app parts still go ahead. The result lists `pausedChannels`. |
| Automations (fee reminders, absence alerts) | Saving a rule with a newly added paused channel returns `503`. Existing rules keep their settings and run in-app only. |
| AI drafts / Copilot proposals | Paused channels are dropped; drafts are saved as in-app. |
| Delivery service (`dispatchMessage`) | Final guard: a paused channel never reaches the provider. Any such attempt is logged with status `paused`, never `sent`. |

There are no retries and no background jobs for paused channels. No "sent" or delivered records are created for them.

**Clients:**
- `GET /communications/availability` (any signed-in user) returns each channel's state as `available` or `coming_soon`.
- `GET /communications/channels` and `GET /platform/integrations` include `enabled` and `status`.
- Both frontends show **Coming soon** and disable the matching controls. The server enforces the pause regardless of what the client does.

## Turning a channel on

1. Set the provider credentials in `.env`:
   - email: `SMTP_*`;
   - SMS: `TWILIO_*`;
   - WhatsApp: `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
2. Set the switch, for example `SMS_ENABLED=true`, and restart the API.
3. Verify the channel:
   - Send one message with `POST /communications/messages` to a number or address you control.
   - Check that the message log shows `sent` and that the message actually arrives.
   - Check `GET /platform/integrations` for failures.
4. Run `npm test`. The existing delivery tests in `tests/approvals-automation.test.ts` and `tests/channel-pause.test.ts` cover the send path with the channel switched on.

**WhatsApp:** Meta requires approved templates for messages the school initiates outside a 24-hour customer window. Template sending is not implemented yet, so plan that before enabling WhatsApp for reminders.
