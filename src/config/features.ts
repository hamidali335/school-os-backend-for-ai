import { env } from './env';
import { AppError } from '../utils/errors';

/**
 * Availability switches for outbound messaging channels. These are server-side flags
 * (environment: SMS_ENABLED, WHATSAPP_ENABLED, EMAIL_SENDING_ENABLED) and default to OFF
 * while the provider integrations are being completed.
 *
 * A paused channel is never sent to: no provider request is made, nothing is queued, and
 * no "sent" record is created. The provider adapters, templates, settings and message
 * history are kept so a channel can be switched on again independently later.
 *
 * In-app notifications are not affected — they need no external provider.
 */
export const MESSAGING_CHANNELS = ['sms', 'whatsapp', 'email'] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

const LABELS: Record<MessagingChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email' };

let overrides: Partial<Record<MessagingChannel, boolean>> = {};

export function isChannelEnabled(channel: MessagingChannel): boolean {
  if (overrides[channel] !== undefined) return overrides[channel]!;
  if (channel === 'sms') return env.SMS_ENABLED;
  if (channel === 'whatsapp') return env.WHATSAPP_ENABLED;
  return env.EMAIL_SENDING_ENABLED;
}

export const isMessagingChannel = (c: string): c is MessagingChannel =>
  (MESSAGING_CHANNELS as readonly string[]).includes(c);

/** Status of every outbound channel, for clients that show "Coming soon" labels. */
export function channelAvailability() {
  return MESSAGING_CHANNELS.map((channel) => ({
    channel,
    label: LABELS[channel],
    enabled: isChannelEnabled(channel),
    status: isChannelEnabled(channel) ? ('available' as const) : ('coming_soon' as const),
  }));
}

/** Channels from the list that are currently paused. Non-messaging values (e.g. in_app) are ignored. */
export function pausedChannels(channels: readonly string[]): MessagingChannel[] {
  return [...new Set(channels.filter(isMessagingChannel).filter((c) => !isChannelEnabled(c)))];
}

/** Drops paused messaging channels; keeps everything else (e.g. in_app). */
export function withoutPausedChannels<T extends string>(channels: readonly T[]): T[] {
  return channels.filter((c) => !isMessagingChannel(c) || isChannelEnabled(c));
}

export function pausedMessage(channels: readonly MessagingChannel[]) {
  const names = channels.map((c) => LABELS[c]).join(', ');
  return `${names} ${channels.length > 1 ? 'are' : 'is'} coming soon and temporarily unavailable while the messaging integration is completed.`;
}

/** Throws 503 CHANNEL_PAUSED if any requested messaging channel is paused. */
export function assertChannelsEnabled(channels: readonly string[]) {
  const paused = pausedChannels(channels);
  if (paused.length) {
    throw new AppError(503, 'CHANNEL_PAUSED', pausedMessage(paused), { pausedChannels: paused });
  }
}

/** Test hook: switch channels on/off without changing the environment. Pass {} to reset. */
export function setChannelFlagsForTests(flags: Partial<Record<MessagingChannel, boolean>>) {
  overrides = { ...flags };
}
