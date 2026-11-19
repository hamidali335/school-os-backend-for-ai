import crypto from 'node:crypto';

/**
 * Verifies the Cloudflare Access token that Cloudflare adds to every request that passed an
 * Access application (header `Cf-Access-Jwt-Assertion`). Used for the platform API
 * (platform-network.ts): it proves the browser signed in through Access (identity + one-time
 * code) before the request reached this server, from any network. docs/PLATFORM_REMOTE_ACCESS.md.
 *
 * Checked: RS256 signature against the team's published keys, issuer, audience (the Access
 * application's AUD tag), expiry and not-before, and optionally the signed-in e-mail. Anything
 * else (missing header, unknown key, keys unavailable) fails closed.
 */

export interface AccessConfig {
  /** https://<team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  audience: string;
  /** Lower-case e-mails allowed in; empty = whoever the Access policy lets in. */
  emails: string[];
}

type Jwk = crypto.JsonWebKey & { kid?: string };

export type AccessFailure =
  | 'missing'
  | 'malformed'
  | 'bad_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'email_not_allowed'
  | 'keys_unavailable';

export type AccessResult = { ok: true; email: string | null } | { ok: false; reason: AccessFailure };

const KEYS_TTL_MS = 10 * 60_000;
/** Do not hammer Cloudflare when a token names an unknown key. */
const MIN_REFRESH_MS = 30_000;
const SKEW_S = 60;

export class AccessVerifier {
  private keys = new Map<string, crypto.KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly config: AccessConfig,
    private readonly fetchKeys: (url: string) => Promise<{ keys?: Jwk[] }> = defaultFetchKeys,
    private readonly now: () => number = Date.now,
  ) {}

  private certsUrl() {
    return `${this.config.teamDomain.replace(/\/+$/, '')}/cdn-cgi/access/certs`;
  }

  private async refresh(force: boolean) {
    const age = this.now() - this.fetchedAt;
    if (!force && this.keys.size && age < KEYS_TTL_MS) return;
    if (force && this.fetchedAt && age < MIN_REFRESH_MS) return;
    this.inflight ??= (async () => {
      try {
        const body = await this.fetchKeys(this.certsUrl());
        const next = new Map<string, crypto.KeyObject>();
        for (const k of body.keys ?? []) {
          if (k.kty !== 'RSA' || !k.kid) continue;
          next.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
        }
        if (next.size) this.keys = next;
        this.fetchedAt = this.now();
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  async verify(token: string | undefined): Promise<AccessResult> {
    if (!token) return { ok: false, reason: 'missing' };
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: 'malformed' };
    let header: { alg?: string; kid?: string };
    let claims: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string };
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (header.alg !== 'RS256') return { ok: false, reason: 'bad_algorithm' };
    try {
      await this.refresh(false);
      if (header.kid && !this.keys.has(header.kid)) await this.refresh(true); // keys rotated
    } catch {
      if (!this.keys.size) return { ok: false, reason: 'keys_unavailable' };
    }
    const key = header.kid ? this.keys.get(header.kid) : undefined;
    if (!key) return { ok: false, reason: this.keys.size ? 'unknown_key' : 'keys_unavailable' };
    const signed = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!signed) return { ok: false, reason: 'bad_signature' };
    if (claims.iss !== this.config.teamDomain.replace(/\/+$/, '')) return { ok: false, reason: 'wrong_issuer' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.audience)) return { ok: false, reason: 'wrong_audience' };
    const nowS = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S <= nowS) return { ok: false, reason: 'expired' };
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > nowS) return { ok: false, reason: 'not_yet_valid' };
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
    if (this.config.emails.length && (!email || !this.config.emails.includes(email)))
      return { ok: false, reason: 'email_not_allowed' };
    return { ok: true, email };
  }
}

async function defaultFetchKeys(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Cloudflare Access keys: HTTP ${res.status}`);
  return (await res.json()) as { keys?: Jwk[] };
}
