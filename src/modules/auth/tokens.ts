import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env } from '../../config/env';
import type { PlatformRole, SchoolRole } from '../../config/permissions';
import { AppError, unauthorized } from '../../utils/errors';
import { compareInWorker, hashInWorker } from './password-hasher';
import { RefreshToken } from './refresh-token.model';

const ISSUER = 'school-os';
export const SCHOOL_AUDIENCE = 'school-os:school';
export const PLATFORM_AUDIENCE = 'school-os:platform';

/**
 * Real-strength hashing (cost >= 8) runs in worker threads so logins never block the event
 * loop; the very cheap test cost stays inline to keep the test suite fast.
 */
const useWorkers = () => env.BCRYPT_ROUNDS >= 8 || process.env.FORCE_PASSWORD_WORKERS === 'true';
const hash = (plain: string) =>
  useWorkers() ? hashInWorker(plain, env.BCRYPT_ROUNDS) : bcrypt.hash(plain, env.BCRYPT_ROUNDS);
const compare = (plain: string, h: string) => (useWorkers() ? compareInWorker(plain, h) : bcrypt.compare(plain, h));

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

// Used to keep login timing similar when the account does not exist.
let dummyHash: string | undefined;
export async function verifyPassword(plain: string, stored: string | undefined | null): Promise<boolean> {
  if (!stored) {
    dummyHash ??= await hash('timing-equaliser-not-a-password');
    await compare(plain, dummyHash);
    return false;
  }
  return compare(plain, stored);
}

export interface SchoolAccessClaims {
  sub: string;
  sid: string;
  role: SchoolRole;
  tv: number;
  typ: 'school';
}
export interface PlatformAccessClaims {
  sub: string;
  role: PlatformRole;
  tv: number;
  typ: 'platform';
}

export function signSchoolAccessToken(input: {
  userId: string;
  schoolId: string;
  role: SchoolRole;
  tokenVersion: number;
}) {
  const claims: Omit<SchoolAccessClaims, 'sub'> = {
    sid: input.schoolId,
    role: input.role,
    tv: input.tokenVersion,
    typ: 'school',
  };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    subject: input.userId,
    audience: SCHOOL_AUDIENCE,
    issuer: ISSUER,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    algorithm: 'HS256',
  });
}

export function signPlatformAccessToken(input: { adminId: string; role: PlatformRole; tokenVersion: number }) {
  const claims: Omit<PlatformAccessClaims, 'sub'> = { role: input.role, tv: input.tokenVersion, typ: 'platform' };
  return jwt.sign(claims, env.JWT_PLATFORM_SECRET, {
    subject: input.adminId,
    audience: PLATFORM_AUDIENCE,
    issuer: ISSUER,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    algorithm: 'HS256',
  });
}

function verify<T>(token: string, secret: string, audience: string): T {
  try {
    return jwt.verify(token, secret, { audience, issuer: ISSUER, algorithms: ['HS256'] }) as T;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw unauthorized('Access token expired', 'TOKEN_EXPIRED');
    throw unauthorized('Invalid access token');
  }
}

export const verifySchoolAccessToken = (token: string) =>
  verify<SchoolAccessClaims>(token, env.JWT_ACCESS_SECRET, SCHOOL_AUDIENCE);
export const verifyPlatformAccessToken = (token: string) =>
  verify<PlatformAccessClaims>(token, env.JWT_PLATFORM_SECRET, PLATFORM_AUDIENCE);

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export interface IssueRefreshInput {
  subjectType: 'user' | 'platform';
  subjectId: Types.ObjectId | string;
  schoolId?: Types.ObjectId | string;
  familyId?: string;
  ip?: string;
  userAgent?: string;
}

export async function issueRefreshToken(input: IssueRefreshInput): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(48).toString('base64url');
  const ttlMs =
    input.subjectType === 'platform'
      ? env.PLATFORM_REFRESH_TOKEN_TTL_HOURS * 3600_000
      : env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600_000;
  const expiresAt = new Date(Date.now() + ttlMs);
  await RefreshToken.create({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    schoolId: input.schoolId,
    tokenHash: sha256(token),
    familyId: input.familyId ?? crypto.randomUUID(),
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300),
  });
  return { token, expiresAt };
}

/**
 * Exchange a refresh token for a new one. Atomically marks the presented token as rotated
 * so two concurrent refreshes cannot both succeed. Reusing a rotated token revokes every
 * session in its family.
 */
export async function rotateRefreshToken(
  rawToken: string,
  subjectType: 'user' | 'platform',
  meta: { ip?: string; userAgent?: string },
) {
  const tokenHash = sha256(rawToken);
  const now = new Date();
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, subjectType, rotatedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { rotatedAt: now } },
    { returnDocument: 'after' },
  ).lean();

  if (!claimed) {
    const existing = await RefreshToken.findOne({ tokenHash }).lean();
    if (existing && existing.subjectType === subjectType && (existing.rotatedAt || existing.revokedAt)) {
      await RefreshToken.updateMany(
        { familyId: existing.familyId, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'reuse_detected' } },
      );
    }
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
  }

  const next = await issueRefreshToken({
    subjectType,
    subjectId: claimed.subjectId,
    schoolId: claimed.schoolId ?? undefined,
    familyId: claimed.familyId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { subjectId: claimed.subjectId.toString(), schoolId: claimed.schoolId?.toString(), ...next };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const existing = await RefreshToken.findOne({ tokenHash: sha256(rawToken) }).lean();
  if (!existing) return;
  await RefreshToken.updateMany(
    { familyId: existing.familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

export async function revokeAllForSubject(subjectType: 'user' | 'platform', subjectId: string, reason: string) {
  await RefreshToken.updateMany(
    { subjectType, subjectId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}
