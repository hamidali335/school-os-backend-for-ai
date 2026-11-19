import crypto from 'node:crypto';

/**
 * The short-lived OIDC identity token our own server signs for Google Workload Identity
 * Federation (docs/FCM_KEYLESS.md). Google checks it when exchanging it (signature against the
 * JWKS uploaded to the provider, issuer, audience, expiry, attribute condition); these checks let
 * the server and the check tool find a wrong setup before Google refuses it. Nothing here logs or
 * returns the token itself.
 */

export class OidcTokenError extends Error {
  constructor(
    readonly code:
      | 'MALFORMED'
      | 'BAD_ALGORITHM'
      | 'UNKNOWN_KEY'
      | 'BAD_SIGNATURE'
      | 'WRONG_ISSUER'
      | 'WRONG_AUDIENCE'
      | 'WRONG_SUBJECT'
      | 'EXPIRED'
      | 'NOT_YET_VALID'
      | 'LIFETIME_TOO_LONG',
    message: string,
  ) {
    super(message);
  }
}

export interface OidcClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export interface Jwks {
  keys: Array<crypto.JsonWebKey & { kid?: string; alg?: string; use?: string }>;
}

export interface Expected {
  issuer: string;
  audience: string;
  subject: string;
  /** Longest accepted lifetime (exp - iat). Default 1 hour. */
  maxLifetimeSeconds?: number;
  /** Seconds of clock difference tolerated. Default 60. */
  skewSeconds?: number;
  /** Unix seconds; tests only. */
  now?: number;
}

const b64json = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** Header and claims without checking anything (to read exp/iat). Throws MALFORMED. */
export function decodeOidcToken(token: string): { header: Record<string, unknown>; claims: OidcClaims } {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new OidcTokenError('MALFORMED', 'Not a signed JWT');
  try {
    const header = b64json(parts[0]);
    const claims = b64json(parts[1]) as unknown as OidcClaims;
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number')
      throw new OidcTokenError('MALFORMED', 'exp and iat must be numbers');
    return { header, claims };
  } catch (err) {
    if (err instanceof OidcTokenError) throw err;
    throw new OidcTokenError('MALFORMED', 'Header or claims are not valid JSON');
  }
}

/** Checks lifetime and expiry only (what the API can check without the JWKS). */
export function checkOidcTimes(
  claims: Pick<OidcClaims, 'iat' | 'exp'>,
  o: Pick<Expected, 'maxLifetimeSeconds' | 'skewSeconds' | 'now'> = {},
) {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const skew = o.skewSeconds ?? 60;
  if (claims.exp - claims.iat > (o.maxLifetimeSeconds ?? 3600))
    throw new OidcTokenError('LIFETIME_TOO_LONG', 'The token is valid for longer than allowed');
  if (claims.iat > now + skew)
    throw new OidcTokenError('NOT_YET_VALID', 'The token was issued in the future (check the clock)');
  if (claims.exp <= now) throw new OidcTokenError('EXPIRED', 'The token has expired');
}

/** Full verification: RS256 signature against the JWKS, issuer, audience, subject and times. */
export function verifyOidcToken(token: string, jwks: Jwks, expected: Expected): OidcClaims {
  const { header, claims } = decodeOidcToken(token);
  if (header.alg !== 'RS256') throw new OidcTokenError('BAD_ALGORITHM', 'Only RS256 tokens are accepted');
  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new OidcTokenError('UNKNOWN_KEY', 'The token was signed with a key that is not in the JWKS');
  const [h, p, s] = token.trim().split('.');
  const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  if (!ok) throw new OidcTokenError('BAD_SIGNATURE', 'The signature does not match the JWKS key');
  if (claims.iss !== expected.issuer) throw new OidcTokenError('WRONG_ISSUER', 'Unexpected issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expected.audience)) throw new OidcTokenError('WRONG_AUDIENCE', 'Unexpected audience');
  if (claims.sub !== expected.subject) throw new OidcTokenError('WRONG_SUBJECT', 'Unexpected subject');
  checkOidcTimes(claims, expected);
  return claims;
}
