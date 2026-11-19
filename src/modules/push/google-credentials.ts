import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { checkOidcTimes, decodeOidcToken, OidcTokenError } from './oidc-token';

/** The only scope the API asks Google for: sending FCM messages. */
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Where FCM access tokens come from for keyless push (docs/FCM_KEYLESS.md). A key file is read by the Admin SDK instead (fcm-admin.ts). */
export interface AccessTokenSource {
  readonly mode: 'service_account_file' | 'adc';
  token(): Promise<string>;
}

export type FcmCredentialMode = 'none' | 'service_account_file' | 'adc';

/**
 * Which credentials push uses:
 *   FCM_CREDENTIALS=adc                    → Application Default Credentials (keyless Workload
 *                                            Identity Federation via GOOGLE_APPLICATION_CREDENTIALS)
 *   FCM_CREDENTIALS=service_account_file   → the downloaded key in FCM_SERVICE_ACCOUNT_FILE
 *   not set                                → the key file when FCM_SERVICE_ACCOUNT_FILE is set
 *                                            (as before), otherwise push is off
 */
export function fcmCredentialMode(e: {
  FCM_CREDENTIALS?: string;
  FCM_SERVICE_ACCOUNT_FILE?: string;
}): FcmCredentialMode {
  if (e.FCM_CREDENTIALS === 'adc') return 'adc';
  if (e.FCM_CREDENTIALS === 'service_account_file') return e.FCM_SERVICE_ACCOUNT_FILE ? 'service_account_file' : 'none';
  return e.FCM_SERVICE_ACCOUNT_FILE ? 'service_account_file' : 'none';
}

/**
 * Application Default Credentials through google-auth-library. On the school's own server this is
 * Workload Identity Federation: GOOGLE_APPLICATION_CREDENTIALS names an external_account
 * configuration (no secret in it) whose credential source is a file holding a short-lived OIDC
 * token that a separate signer (another Linux user, its own key) refreshes. Google exchanges that
 * token and lets the API act as the FCM sender service account. No Google key exists anywhere.
 */
export class AdcSource implements AccessTokenSource {
  readonly mode = 'adc' as const;
  private readonly auth: GoogleAuth;

  constructor(private readonly configFile = process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    this.auth = new GoogleAuth({ scopes: [FCM_SCOPE], ...(configFile ? { keyFilename: configFile } : {}) });
  }

  async token(): Promise<string> {
    this.preflight();
    const value = await this.auth.getAccessToken();
    if (!value) throw new Error('Google returned no access token');
    return value;
  }

  /**
   * For a file-sourced external account: the OIDC token must exist and still be valid, so a
   * stopped signer is reported plainly instead of as a refusal from Google.
   */
  preflight() {
    if (!this.configFile) return; // ambient ADC (for example on Google Cloud)
    let config: { type?: string; credential_source?: { file?: string } };
    try {
      config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS does not point to a readable JSON file');
    }
    const tokenFile = config.type === 'external_account' ? config.credential_source?.file : undefined;
    if (!tokenFile) return;
    let raw: string;
    try {
      raw = fs.readFileSync(tokenFile, 'utf8');
    } catch {
      throw new Error('The OIDC token file is missing or unreadable: is school-os-oidc.timer running?');
    }
    try {
      checkOidcTimes(decodeOidcToken(raw).claims);
    } catch (err) {
      const code = err instanceof OidcTokenError ? err.code : 'MALFORMED';
      throw new Error(`The OIDC token file is not usable (${code}): is school-os-oidc.timer running?`);
    }
  }
}
