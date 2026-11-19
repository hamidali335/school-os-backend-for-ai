import fs from 'node:fs';
import { cert, getApps, initializeApp, type App, type Credential } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import { AdcSource, fcmCredentialMode } from './google-credentials';

/**
 * Firebase Admin SDK set-up for push (docs/PUSH_NOTIFICATIONS.md). One named app for the whole
 * process, created on first use. Two ways to authenticate, both on the server only:
 *   - a downloaded service-account key: FCM_SERVICE_ACCOUNT_FILE (a path; never the contents);
 *   - keyless: FCM_CREDENTIALS=adc with Workload Identity Federation (docs/FCM_KEYLESS.md).
 * Configuration mistakes are reported with what to fix; key material is never logged.
 */

export class PushConfigError extends Error {
  constructor(message: string) {
    super(`Push (FCM) configuration: ${message}`);
    this.name = 'PushConfigError';
  }
}

export interface PushEnv {
  FCM_PROJECT_ID?: string;
  FCM_CREDENTIALS?: string;
  FCM_SERVICE_ACCOUNT_FILE?: string;
  GOOGLE_APPLICATION_CREDENTIALS?: string;
}

export type PushConfig =
  | { mode: 'none' }
  | { mode: 'service_account_file'; projectId: string; clientEmail: string; credential: Credential }
  | { mode: 'adc'; projectId: string; credential: Credential };

/**
 * Reads and checks a downloaded service-account key: readable JSON of type service_account with
 * a project id, client email and an RSA private key. Returns only what is needed to build the
 * credential; error messages never include the file's contents.
 */
export function readServiceAccount(file: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PushConfigError(
      `FCM_SERVICE_ACCOUNT_FILE (${file}) cannot be read. Check the path and that the API's user may read it.`,
    );
  }
  let sa: Record<string, unknown>;
  try {
    sa = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PushConfigError(`FCM_SERVICE_ACCOUNT_FILE (${file}) is not valid JSON. Download the key again.`);
  }
  if (sa.type !== 'service_account')
    throw new PushConfigError(
      `FCM_SERVICE_ACCOUNT_FILE is not a service-account key (type "${String(sa.type)}"). Use Firebase console › Project settings › Service accounts › Generate new private key. (google-services.json belongs in the app, not here.)`,
    );
  const projectId = typeof sa.project_id === 'string' ? sa.project_id : '';
  const clientEmail = typeof sa.client_email === 'string' ? sa.client_email : '';
  const privateKey = typeof sa.private_key === 'string' ? sa.private_key : '';
  if (!projectId || !clientEmail || !privateKey)
    throw new PushConfigError('the service-account key is missing project_id, client_email or private_key.');
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey))
    throw new PushConfigError('the service-account private_key is not a PEM private key. Download the key again.');
  return { projectId, clientEmail, privateKey };
}

/** Wraps the keyless ADC token source (with its OIDC preflight) as an Admin SDK credential. */
function adcCredential(source: AdcSource): Credential {
  return {
    async getAccessToken() {
      // google-auth-library caches and refreshes the token itself; ask again every few minutes.
      return { access_token: await source.token(), expires_in: 300 };
    },
  };
}

/** Works out the push configuration from the environment; throws PushConfigError when it is wrong. */
export function resolvePushConfig(e: PushEnv): PushConfig {
  if (e.FCM_CREDENTIALS === 'service_account_file' && !e.FCM_SERVICE_ACCOUNT_FILE)
    throw new PushConfigError('FCM_CREDENTIALS=service_account_file but FCM_SERVICE_ACCOUNT_FILE is not set.');
  const mode = fcmCredentialMode(e);
  if (mode === 'none') {
    if (e.FCM_PROJECT_ID)
      throw new PushConfigError(
        'FCM_PROJECT_ID is set but no credentials are: set FCM_SERVICE_ACCOUNT_FILE (key file) or FCM_CREDENTIALS=adc (keyless).',
      );
    return { mode: 'none' };
  }
  if (mode === 'service_account_file') {
    const sa = readServiceAccount(e.FCM_SERVICE_ACCOUNT_FILE!);
    if (e.FCM_PROJECT_ID && e.FCM_PROJECT_ID !== sa.projectId)
      throw new PushConfigError(
        `the service-account key belongs to project "${sa.projectId}" but FCM_PROJECT_ID is "${e.FCM_PROJECT_ID}". Use a key from the same Firebase project as the app's google-services.json.`,
      );
    return {
      mode,
      projectId: sa.projectId,
      clientEmail: sa.clientEmail,
      credential: cert({ projectId: sa.projectId, clientEmail: sa.clientEmail, privateKey: sa.privateKey }),
    };
  }
  if (!e.FCM_PROJECT_ID) throw new PushConfigError('FCM_CREDENTIALS=adc needs FCM_PROJECT_ID.');
  return {
    mode,
    projectId: e.FCM_PROJECT_ID,
    credential: adcCredential(new AdcSource(e.GOOGLE_APPLICATION_CREDENTIALS)),
  };
}

const APP_NAME = 'school-os-push';

/** The single Admin SDK app for push (created once, reused). */
export function pushApp(config: Exclude<PushConfig, { mode: 'none' }>): App {
  return (
    getApps().find((a) => a.name === APP_NAME) ??
    initializeApp({ credential: config.credential, projectId: config.projectId }, APP_NAME)
  );
}

// ───────────────────────────── Sending ─────────────────────────────

/** What happened to one device token. "accepted" means FCM took the message, not that it was shown. */
export type TokenOutcome = 'accepted' | 'invalid_token' | 'failed';

/** The part of the Admin SDK messaging API used here (replaced by a fake in tests). */
export interface MessagingLike {
  sendEach(
    messages: Message[],
    dryRun?: boolean,
  ): Promise<{ responses: Array<{ success: boolean; error?: { code?: string; message?: string } }> }>;
}

/** The token is no longer valid for this app: remove it. */
const INVALID_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
/** Worth trying again shortly. */
const TRANSIENT = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unknown-error',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'app/network-error',
  'app/network-timeout',
]);
/** The server's own credentials or project are wrong: nothing will succeed until fixed. */
const CONFIG = new Set([
  'app/invalid-credential',
  'messaging/authentication-error',
  'messaging/third-party-auth-error',
  'messaging/invalid-credential',
]);
/**
 * The token was issued for another Firebase project (for example from before the project was
 * changed). That token can never work here; but if every token fails like this, the server's
 * own project is wrong instead, and nothing is removed.
 */
const OTHER_PROJECT = 'messaging/mismatched-credential';

export function classify(
  code: string | undefined,
  message = '',
): 'invalid_token' | 'other_project' | 'transient' | 'config' | 'permanent' {
  if (!code) return 'transient';
  if (code === OTHER_PROJECT) return 'other_project';
  if (INVALID_TOKEN.has(code)) return 'invalid_token';
  // FCM answers INVALID_ARGUMENT both for a malformed token and for a bad message: only the
  // former is the token's fault.
  if (code === 'messaging/invalid-argument' && /registration token/i.test(message)) return 'invalid_token';
  if (TRANSIENT.has(code)) return 'transient';
  if (CONFIG.has(code)) return 'config';
  return 'permanent';
}

export interface SendStats {
  accepted: number;
  invalidTokens: number;
  failed: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorCode: string | null;
}

export interface FcmSenderOptions {
  dryRun?: boolean;
  /** Attempts per token for transient errors (first try included). */
  attempts?: number;
  /** Base backoff in ms (doubled each retry, with jitter). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onConfigError?: (code: string) => void;
}

/**
 * Sends one message to many tokens with the Admin SDK (`sendEach`), retrying only transient
 * failures with bounded exponential backoff. Permanent failures are never retried; invalid
 * tokens are reported so they can be removed.
 */
export class FcmAdminSender {
  readonly stats: SendStats = {
    accepted: 0,
    invalidTokens: 0,
    failed: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorCode: null,
  };

  constructor(
    private readonly messaging: MessagingLike,
    private readonly o: FcmSenderOptions = {},
  ) {}

  /** One outcome per message, in order. Batches of at most 500 (the FCM limit per call). */
  async send(messages: Message[]): Promise<TokenOutcome[]> {
    const out: TokenOutcome[] = [];
    for (let i = 0; i < messages.length; i += 500) out.push(...(await this.sendBatch(messages.slice(i, i + 500))));
    return out;
  }

  private async sendBatch(messages: Message[]): Promise<TokenOutcome[]> {
    const outcomes: TokenOutcome[] = messages.map(() => 'failed');
    let pending = messages.map((_, i) => i);
    const otherProject: number[] = [];
    const attempts = Math.max(1, this.o.attempts ?? 3);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 1; attempt <= attempts && pending.length; attempt++) {
      if (attempt > 1) {
        const base = (this.o.backoffMs ?? 500) * 2 ** (attempt - 2);
        await sleep(base + Math.floor(Math.random() * base * 0.3));
      }
      let responses: Array<{ success: boolean; error?: { code?: string; message?: string } }>;
      try {
        ({ responses } = await this.messaging.sendEach(
          pending.map((i) => messages[i]),
          this.o.dryRun,
        ));
      } catch (err) {
        // The whole request failed (credentials, network): every pending token shares the fate.
        const e = err as { code?: string; message?: string };
        const kind = classify(e.code, e.message);
        this.failure(e.code ?? 'unknown');
        if (kind === 'config') this.o.onConfigError?.(e.code ?? 'unknown');
        if (kind === 'transient') continue;
        break;
      }
      const retry: number[] = [];
      responses.forEach((r, j) => {
        const i = pending[j];
        if (r.success) {
          outcomes[i] = 'accepted';
          return;
        }
        const kind = classify(r.error?.code, r.error?.message);
        this.failure(r.error?.code ?? 'unknown');
        if (kind === 'invalid_token') outcomes[i] = 'invalid_token';
        else if (kind === 'other_project') otherProject.push(i);
        else if (kind === 'transient') retry.push(i);
        else if (kind === 'config') this.o.onConfigError?.(r.error?.code ?? 'unknown');
      });
      pending = retry;
    }
    if (otherProject.length) {
      if (outcomes.includes('accepted')) for (const i of otherProject) outcomes[i] = 'invalid_token';
      else this.o.onConfigError?.(OTHER_PROJECT);
    }
    for (const o of outcomes) {
      if (o === 'accepted') this.stats.accepted++;
      else if (o === 'invalid_token') this.stats.invalidTokens++;
      else this.stats.failed++;
    }
    if (outcomes.includes('accepted')) this.stats.lastSuccessAt = new Date();
    return outcomes;
  }

  private failure(code: string) {
    this.stats.lastFailureAt = new Date();
    this.stats.lastErrorCode = code;
  }
}

/** The real Admin SDK messaging client for a configuration. */
export function adminMessaging(config: Exclude<PushConfig, { mode: 'none' }>): MessagingLike {
  return getMessaging(pushApp(config));
}
