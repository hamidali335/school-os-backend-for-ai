import crypto from 'node:crypto';
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env, isTest } from '../config/env';
import { RefreshToken } from '../modules/auth/refresh-token.model';

/**
 * In-memory rate limiting suits a single instance. When running several instances behind a
 * load balancer, configure a shared store (e.g. Redis) — see docs/DEPLOYMENT.md.
 */
const handler = (_req: Request, res: any) =>
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.', requestId: _req.requestId },
  });

const skipInTests = () => isTest && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true';

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
});

/** Login / refresh / password endpoints: keyed by IP + submitted email. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => {
    const id = req.body?.email ?? req.body?.username;
    const email = typeof id === 'string' ? id.toLowerCase().slice(0, 254) : '';
    return `${ipKeyGenerator(req.ip ?? '')}|${email}`;
  },
});

/**
 * Per-IP ceiling across all identifiers on auth endpoints. The per-identifier limiter above
 * can be sidestepped by rotating emails (credential stuffing); this bounds the total.
 */
export const authIpLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT_MAX * 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => `ip|${ipKeyGenerator(req.ip ?? '')}`,
});

/**
 * POST /auth/refresh has its own buckets, separate from sign-in (a refresh body carries no
 * email, so the sign-in limiter keyed every refresh behind one NAT to the same `IP|` bucket).
 *
 * - Per session: keyed by the refresh-token **family** (stable across rotations), so neither
 *   rotating tokens nor switching networks resets it. 20 per 15 min; a healthy client needs ~4.
 * - Per connection: keyed by the client IP as resolved under TRUST_PROXY (never a raw
 *   X-Forwarded-For), so rotating sessions cannot exceed it. AUTH_REFRESH_IP_MAX per 15 min.
 *
 * Unknown or malformed tokens are keyed by their hash; they fail with 401 in the handler. Both
 * limiters answer with the same RATE_LIMITED body, so a 429 says nothing about whether a
 * session exists.
 */
export const REFRESH_WINDOW_MS = 15 * 60_000;
export const REFRESH_PER_SESSION = 20;

export const refreshIpLimiter = rateLimit({
  windowMs: REFRESH_WINDOW_MS,
  limit: () => env.AUTH_REFRESH_IP_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => `refresh-ip|${ipKeyGenerator(req.ip ?? '')}`,
});

export const refreshSessionLimiter = rateLimit({
  windowMs: REFRESH_WINDOW_MS,
  limit: REFRESH_PER_SESSION,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: async (req) => {
    const raw = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.slice(0, 200) : '';
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const known = raw ? await RefreshToken.findOne({ tokenHash }).select('familyId').lean() : null;
    return known ? `refresh-family|${known.familyId}` : `refresh-token|${tokenHash}`;
  },
});

/** AI endpoints: per authenticated user (falls back to IP). */
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.AI_RATE_LIMIT_PER_MINUTE,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => {
    const auth = req.headers.authorization ?? '';
    return auth ? `tok:${auth.slice(-32)}` : ipKeyGenerator(req.ip ?? '');
  },
});

/** Platform backup actions (create / download link / delete): per authenticated admin or IP. */
export const backupLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => {
    const auth = req.headers.authorization ?? '';
    return auth ? `bk:${auth.slice(-32)}` : `bk-ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
});

/** Unauthenticated lookups (certificate verification): bounds enumeration of serial numbers. */
export const publicLookupLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => `lookup|${ipKeyGenerator(req.ip ?? '')}`,
});

/**
 * Import uploads: reading a workbook is expensive, so each user may upload at most 20 files per
 * 15 minutes. Keyed by the signed-in user (runs after authentication), falling back to the IP.
 */
export const importUploadLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => {
    const userId = (req.ctx as { userId?: string } | undefined)?.userId;
    return userId ? `import-upload|${userId}` : `import-upload|${ipKeyGenerator(req.ip ?? '')}`;
  },
});

/**
 * Connector API (POST /biometric/ingest): each device key may send 120 requests per minute
 * (up to 1,000 punches each), far above what a school's machines produce, while a stolen or
 * misbehaving key cannot flood the API. Keyed by the device in the key, else the IP.
 */
export const connectorLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler,
  skip: skipInTests,
  keyGenerator: (req) => {
    const m = /^Bearer sbk_([a-f\d]{24})_/.exec(req.headers.authorization ?? '');
    return m ? `connector|${m[1]}` : `connector-ip|${ipKeyGenerator(req.ip ?? '')}`;
  },
});
