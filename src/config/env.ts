import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Tests configure the environment explicitly and must never pick up a developer's .env.
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /**
   * Interface to listen on. Empty = every interface (the previous behaviour; phones on the same
   * Wi-Fi can connect in development). Behind nginx on the same host, set 127.0.0.1.
   */
  HOST: optionalString,
  /** Shown by GET /api/v1 so people can tell environments apart, e.g. "laptop-dev" or "production". */
  INSTANCE_NAME: optionalString,
  APP_NAME: z.string().default('School OS'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  API_DOCS_ENABLED: bool(true),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  // Used only when MONGODB_URI does not name a database.
  MONGODB_DB_NAME: z.string().min(1).default('school_os'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_PLATFORM_SECRET: z.string().min(32, 'JWT_PLATFORM_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  PLATFORM_REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(12),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  CORS_ORIGINS: csv,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  /** Session refreshes per client IP per 15 minutes, separate from sign-in (a school behind NAT). */
  AUTH_REFRESH_IP_MAX: z.coerce.number().int().positive().default(1000),
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),

  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  // AI — fallback configuration. Settings saved in the platform admin panel take precedence.
  AI_PROVIDER: z.enum(['groq', 'openai', 'deepseek', 'xai', 'gemini', 'openrouter', 'custom', 'none']).default('groq'),
  AI_API_KEY: optionalString,
  /** Only needed for AI_PROVIDER=custom, or to override a provider's default URL. */
  AI_BASE_URL: optionalString,
  /** @deprecated use AI_API_KEY / AI_BASE_URL. Still honoured. */
  XAI_API_KEY: optionalString,
  XAI_BASE_URL: optionalString,
  AI_MODEL: z.string().default('openai/gpt-oss-120b'),
  /** Encrypts secrets saved in the database (AI keys). Defaults to a key derived from JWT_PLATFORM_SECRET. */
  SETTINGS_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => !v || v.length >= 32, 'SETTINGS_ENCRYPTION_KEY must be at least 32 characters'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_INPUT_COST_PER_MTOK_USD: z.coerce.number().nonnegative().default(0),
  AI_OUTPUT_COST_PER_MTOK_USD: z.coerce.number().nonnegative().default(0),
  AI_DEFAULT_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(500_000),
  AI_PLATFORM_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(0),

  // Messaging
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: optionalString,
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM_NUMBER: optionalString,
  WHATSAPP_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  MESSAGE_COST_EMAIL_PKR: z.coerce.number().nonnegative().default(0),
  MESSAGE_COST_SMS_PKR: z.coerce.number().nonnegative().default(0),
  MESSAGE_COST_WHATSAPP_PKR: z.coerce.number().nonnegative().default(0),
  // Outbound channel switches (see src/config/features.ts). OFF until each integration is ready.
  SMS_ENABLED: bool(false),
  WHATSAPP_ENABLED: bool(false),
  EMAIL_SENDING_ENABLED: bool(false),

  SCHEDULER_ENABLED: bool(true),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),

  SEED_DEMO_PASSWORD: optionalString,

  /**
   * Production refuses a standalone MongoDB server: without a replica set there are no
   * transactions, so a crash in the middle of a payment or admission can leave partial data.
   * Set to true only if you accept that risk (see docs/DEPLOYMENT.md, "MongoDB topology").
   */
  ALLOW_STANDALONE_MONGODB: bool(false),
  /**
   * Client IPs/CIDRs allowed to reach /api/v1/platform/* (platform login included), e.g.
   * "127.0.0.1,192.168.1.0/24,100.64.0.0/10". Empty = no restriction (a warning in production).
   * Compensating control while platform administrators have no MFA. Needs a correct TRUST_PROXY.
   * Not used when Cloudflare Access is configured (below).
   */
  PLATFORM_ALLOWED_IPS: csv,
  /**
   * Cloudflare Access in front of the platform console (docs/PLATFORM_REMOTE_ACCESS.md): with
   * both set, every platform API request must carry a valid Access token for this application,
   * from any network. Team domain: https://<team>.cloudflareaccess.com. AUD: the application's
   * "Application Audience (AUD) Tag". Neither is secret.
   */
  PLATFORM_ACCESS_TEAM_DOMAIN: optionalString.refine(
    (v) => v === undefined || /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/i.test(v),
    'must be https://<team>.cloudflareaccess.com',
  ),
  PLATFORM_ACCESS_AUD: optionalString.refine(
    (v) => v === undefined || /^[a-f0-9]{64}$/i.test(v),
    'must be the 64-character AUD tag',
  ),
  /**
   * Only devices registered with `npm run platform:device -- add <name>` may use the platform API
   * (from any network); everything else gets 404. docs/PLATFORM_REMOTE_ACCESS.md.
   */
  PLATFORM_DEVICE_ONLY: bool(false),
  /** Optional: only these e-mails (as signed in to Access) may use the platform API. Recommended. */
  PLATFORM_ACCESS_EMAILS: csv,
  /** Git commit of the deployed code, recorded in backup manifests (read from .git when unset). */
  APP_GIT_COMMIT: optionalString,

  // Backups (docs/BACKUP_RESTORE.md). Disabled until BACKUP_ENCRYPTION_KEY is set.
  BACKUP_DIR: z.string().default('./backups'),
  /** 32 random bytes, base64 or hex. Keep a copy OFF the server: without it backups cannot be restored. */
  BACKUP_ENCRYPTION_KEY: optionalString.refine(
    (v) => !v || decodedKeyLength(v) === 32,
    'BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as base64 (44 chars) or hex (64 chars); generate one with npm run backup:keygen',
  ),
  BACKUP_SCHEDULE_ENABLED: bool(false),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Completed backups kept on the server. The newest verified backup is never removed. */
  BACKUP_RETENTION_COUNT: z.coerce.number().int().min(1).max(365).default(14),
  BACKUP_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(720).default(60),
  /** auto = snapshot read on a replica set, otherwise pause API writes while the backup runs. */
  BACKUP_CONSISTENCY: z.enum(['auto', 'snapshot', 'freeze']).default('auto'),

  // App voice calls (docs/VOICE_CALLS.md). Signaling runs inside this API; media is WebRTC.
  /** Turns the call signaling socket and call endpoints on (the plan feature calls.voice is also needed). */
  CALLS_ENABLED: bool(true),
  /** STUN servers, e.g. "stun:turn.example.pk:3478". Empty = direct connections on the same network only. */
  CALL_STUN_URLS: csv,
  /** TURN servers, e.g. "turn:turn.example.pk:3478?transport=udp,turns:turn.example.pk:5349?transport=tcp". */
  CALL_TURN_URLS: csv,
  /** coturn `static-auth-secret` (use-auth-secret): the API issues short-lived TURN credentials from it. */
  CALL_TURN_SECRET: optionalString.refine(
    (v) => !v || v.length >= 32,
    'CALL_TURN_SECRET must be at least 32 characters',
  ),
  /** Lifetime of issued TURN credentials. Must cover the longest call (coturn refuses refreshes after expiry). */
  CALL_TURN_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(4500),
  CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(120).default(45),
  /** How long a dropped participant has to reconnect before the call is recorded as failed. */
  CALL_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  CALL_MAX_MINUTES: z.coerce.number().int().min(1).max(240).default(60),
  /** Calls a user may start per minute. */
  CALL_START_PER_MINUTE: z.coerce.number().int().positive().default(6),

  // AI voice conversations (docs/AI_VOICE_CALLS.md). The language model is the platform AI
  // provider (docs/AI_PROVIDERS.md); speech engines are configured here, on the server only.
  /**
   * Push to the Android app (docs/PUSH_NOTIFICATIONS.md): incoming calls and school notifications.
   * Firebase project id; must be the project of the app's google-services.json.
   */
  FCM_PROJECT_ID: optionalString,
  /** Path to the Firebase Admin SDK service-account JSON (server only; never in the app or the repository). */
  FCM_SERVICE_ACCOUNT_FILE: optionalString,
  /**
   * How push authenticates to Google (docs/FCM_KEYLESS.md): adc = Application Default Credentials
   * (keyless Workload Identity Federation through GOOGLE_APPLICATION_CREDENTIALS);
   * service_account_file = FCM_SERVICE_ACCOUNT_FILE. Unset: the key file when it is set.
   */
  FCM_CREDENTIALS: z.enum(['adc', 'service_account_file']).optional(),
  /** ADC configuration file (for WIF, an external_account config; it holds no secret). */
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  /** Staging: FCM validates every message but delivers none. */
  FCM_DRY_RUN: bool(false),
  /** full = the notification's title and text in the push; minimal = only its kind ("Fees update"). */
  PUSH_NOTIFICATION_CONTENT: z.enum(['full', 'minimal']).default('full'),

  AI_CALLS_ENABLED: bool(true),
  /** openai_compatible = POST {url}/audio/transcriptions (e.g. a self-hosted faster-whisper server). */
  AI_CALL_STT_PROVIDER: z.enum(['none', 'openai_compatible']).default('none'),
  AI_CALL_STT_URL: optionalString,
  AI_CALL_STT_MODEL: z.string().default('whisper-large-v3'),
  AI_CALL_STT_API_KEY: optionalString,
  /** openai_compatible = POST {url}/audio/speech; http_wav = POST {url} {text, language, voice} → WAV. */
  AI_CALL_TTS_PROVIDER: z.enum(['none', 'openai_compatible', 'http_wav']).default('none'),
  AI_CALL_TTS_URL: optionalString,
  AI_CALL_TTS_MODEL: z.string().default('tts-1'),
  AI_CALL_TTS_VOICE: z.string().default(''),
  AI_CALL_TTS_API_KEY: optionalString,
  /** Per speech or language-model request. */
  AI_CALL_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  /** AI conversations running at once on this server instance (CPU and engine capacity). */
  AI_CALL_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(2),
  /** AI conversations running at once per school. */
  AI_CALL_MAX_CONCURRENT_PER_SCHOOL: z.coerce.number().int().min(1).max(50).default(1),
  /** AI conversations a school may start per day. */
  AI_CALL_DAILY_LIMIT_PER_SCHOOL: z.coerce.number().int().min(0).max(10_000).default(20),
  /** Hard length limit of one AI conversation. */
  AI_CALL_MAX_MINUTES: z.coerce.number().int().min(1).max(30).default(8),
  /** Turns (parent answers) per conversation before it is closed. */
  AI_CALL_MAX_TURNS: z.coerce.number().int().min(2).max(60).default(20),
  /** Silence before the AI asks again (twice), then ends the call. */
  AI_CALL_SILENCE_SECONDS: z.coerce.number().int().min(5).max(60).default(12),
  /** Transcripts are deleted this many days after the conversation (answers and summary are kept). */
  AI_CALL_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** Minimum supported desktop client version for sync protocol compatibility. */
  MIN_DESKTOP_CLIENT_VERSION: z.string().default('1.0.0'),
});

function decodedKeyLength(v: string): number {
  if (/^[0-9a-fA-F]{64}$/.test(v)) return 32;
  if (/^[A-Za-z0-9+/]{43}=?$/.test(v)) return Buffer.from(v, 'base64').length;
  return 0;
}

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error('Invalid environment configuration');
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.JWT_ACCESS_SECRET === env.JWT_PLATFORM_SECRET) {
      throw new Error('JWT_ACCESS_SECRET and JWT_PLATFORM_SECRET must differ in production');
    }
    if (/change[-_ ]?me|example|secret123/i.test(env.JWT_ACCESS_SECRET + env.JWT_PLATFORM_SECRET)) {
      throw new Error('Refusing to start in production with placeholder JWT secrets');
    }
    if (Boolean(env.PLATFORM_ACCESS_TEAM_DOMAIN) !== Boolean(env.PLATFORM_ACCESS_AUD)) {
      throw new Error('PLATFORM_ACCESS_TEAM_DOMAIN and PLATFORM_ACCESS_AUD must be set together');
    }
    if (env.CORS_ORIGINS.length === 0) {
      throw new Error('CORS_ORIGINS must list the frontend origins in production');
    }
    const backups = path.resolve(env.BACKUP_DIR);
    const storage = path.resolve(env.STORAGE_DIR);
    if (backups === storage || backups.startsWith(storage + path.sep) || storage.startsWith(backups + path.sep)) {
      throw new Error('BACKUP_DIR and STORAGE_DIR must be separate directories');
    }
    // Swagger UI maps the whole API surface; keep it off in production unless asked for.
    if (process.env.API_DOCS_ENABLED === undefined) env.API_DOCS_ENABLED = false;
  }
  return env;
}

/** Non-fatal production configuration warnings, logged once at startup. */
export function configWarnings(e: Env = env): string[] {
  const out: string[] = [];
  if (e.NODE_ENV !== 'production') return out;
  if (e.TRUST_PROXY === 0)
    out.push(
      'TRUST_PROXY=0: behind nginx or a load balancer every client appears to come from the proxy IP, so rate limits are shared by all users. Set TRUST_PROXY=1 when behind one proxy.',
    );
  if (e.API_DOCS_ENABLED) out.push('API_DOCS_ENABLED=true: the Swagger UI is publicly reachable.');
  if (e.SCHEDULER_ENABLED === false) out.push('SCHEDULER_ENABLED=false: automations will not run on this instance.');
  const access = Boolean(e.PLATFORM_ACCESS_TEAM_DOMAIN && e.PLATFORM_ACCESS_AUD);
  if (e.PLATFORM_DEVICE_ONLY && e.PLATFORM_ALLOWED_IPS.length)
    out.push('PLATFORM_ALLOWED_IPS is ignored because PLATFORM_DEVICE_ONLY is on (registered devices only).');
  if (!access && !e.PLATFORM_DEVICE_ONLY && e.PLATFORM_ALLOWED_IPS.length === 0)
    out.push(
      'Neither Cloudflare Access (PLATFORM_ACCESS_TEAM_DOMAIN, PLATFORM_ACCESS_AUD) nor PLATFORM_ALLOWED_IPS is set: the platform admin API (no MFA) is reachable from any address with a password alone.',
    );
  if (access && e.PLATFORM_ACCESS_EMAILS.length === 0)
    out.push(
      'PLATFORM_ACCESS_EMAILS is empty: anyone the Cloudflare Access policy lets in may try platform logins. List the platform owners\u2019 e-mails.',
    );
  if (access && !e.PLATFORM_DEVICE_ONLY && e.PLATFORM_ALLOWED_IPS.length)
    out.push('PLATFORM_ALLOWED_IPS is ignored because Cloudflare Access is configured for the platform API.');
  if (e.CALLS_ENABLED && e.CALL_TURN_URLS.length === 0)
    out.push(
      'CALL_TURN_URLS is empty: app voice calls only connect when both devices can reach each other directly (often not across mobile data or strict routers). Configure a TURN server.',
    );
  if (e.CALL_TURN_URLS.length > 0 && !e.CALL_TURN_SECRET)
    out.push(
      'CALL_TURN_URLS is set without CALL_TURN_SECRET: no TURN credentials can be issued, so the relay is unusable.',
    );
  if (!e.BACKUP_ENCRYPTION_KEY) out.push('BACKUP_ENCRYPTION_KEY is not set: platform backups are disabled.');
  else if (!e.BACKUP_SCHEDULE_ENABLED)
    out.push('BACKUP_SCHEDULE_ENABLED=false: no automatic backups; create them manually.');
  return out;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
