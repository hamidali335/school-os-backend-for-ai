import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';

export interface OutgoingMessage {
  to: string;
  body: string;
  subject?: string;
}

export interface SendResult {
  providerMessageId?: string;
}

export interface MessagingAdapter {
  channel: 'email' | 'sms' | 'whatsapp';
  provider: string;
  isConfigured(): boolean;
  /** Throws on provider rejection. Resolves only when the provider accepted the message. */
  send(msg: OutgoingMessage): Promise<SendResult>;
  costPerMessagePkr(): number;
}

const TIMEOUT_MS = 15_000;

async function postForm(
  url: string,
  headers: Record<string, string>,
  body: URLSearchParams | string,
  contentType: string,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const detail = json?.message ?? json?.error?.message ?? text.slice(0, 200);
    throw new Error(`Provider responded ${res.status}: ${detail}`);
  }
  return json;
}

let transporter: Transporter | undefined;
export const emailAdapter: MessagingAdapter = {
  channel: 'email',
  provider: 'smtp',
  isConfigured: () => Boolean(env.SMTP_HOST && env.SMTP_FROM),
  costPerMessagePkr: () => env.MESSAGE_COST_EMAIL_PKR,
  async send(msg) {
    transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      connectionTimeout: TIMEOUT_MS,
    });
    const info = await transporter.sendMail({
      from: env.SMTP_FROM,
      to: msg.to,
      subject: msg.subject ?? '(no subject)',
      text: msg.body,
    });
    if (info.rejected?.length) throw new Error('SMTP server rejected the recipient');
    return { providerMessageId: info.messageId };
  },
};

/** SMS via Twilio's REST API. Other Pakistani SMS gateways can be added as adapters. */
export const smsAdapter: MessagingAdapter = {
  channel: 'sms',
  provider: 'twilio',
  isConfigured: () => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
  costPerMessagePkr: () => env.MESSAGE_COST_SMS_PKR,
  async send(msg) {
    const sid = env.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const json = await postForm(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      { Authorization: `Basic ${auth}` },
      new URLSearchParams({ To: msg.to, From: env.TWILIO_FROM_NUMBER!, Body: msg.body }),
      'application/x-www-form-urlencoded',
    );
    return { providerMessageId: json?.sid };
  },
};

/**
 * WhatsApp via Meta's WhatsApp Cloud API (text message). Note: Meta only allows free-form
 * text inside a 24h customer-service window; business-initiated messages require approved
 * templates. Template support is a documented follow-up.
 */
export const whatsappAdapter: MessagingAdapter = {
  channel: 'whatsapp',
  provider: 'meta_cloud_api',
  isConfigured: () => Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
  costPerMessagePkr: () => env.MESSAGE_COST_WHATSAPP_PKR,
  async send(msg) {
    const json = await postForm(
      `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
      JSON.stringify({
        messaging_product: 'whatsapp',
        to: msg.to.replace(/[^\d]/g, ''),
        type: 'text',
        text: { body: msg.body },
      }),
      'application/json',
    );
    return { providerMessageId: json?.messages?.[0]?.id };
  },
};

const registry: Record<'email' | 'sms' | 'whatsapp', MessagingAdapter> = {
  email: emailAdapter,
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
};

export function getAdapter(channel: 'email' | 'sms' | 'whatsapp'): MessagingAdapter {
  return registry[channel];
}

/** Test hook: swap an adapter (e.g. to simulate provider failures). */
export function setAdapterForTests(channel: 'email' | 'sms' | 'whatsapp', adapter: MessagingAdapter) {
  registry[channel] = adapter;
}

export function channelStatus() {
  return (Object.keys(registry) as Array<'email' | 'sms' | 'whatsapp'>).map((c) => ({
    channel: c,
    provider: registry[c].provider,
    configured: registry[c].isConfigured(),
    costPerMessagePkr: registry[c].costPerMessagePkr(),
  }));
}
