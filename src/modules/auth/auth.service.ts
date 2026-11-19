import { env } from '../../config/env';
import { RETIRED_SCHOOL_ROLES, isRetiredRole, type SchoolRole } from '../../config/permissions';
import { accountInactive, mobileFeatureFor, permissionsFor, retiredAccount } from '../../middleware/authenticate';
import type { PlatformContext, SchoolContext } from '../../types/context';
import { AppError, badRequest, forbidden, unauthorized } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { AuditLog } from '../audit/audit.model';
import { PlatformAdmin, PLATFORM_ADMIN_PUBLIC_FIELDS } from '../platform-admin/platform-admin.model';
import { School } from '../schools/school.model';
import { User, USER_PUBLIC_FIELDS } from '../users/user.model';
import {
  hashPassword,
  issueRefreshToken,
  revokeAllForSubject,
  revokeRefreshToken,
  rotateRefreshToken,
  signPlatformAccessToken,
  signSchoolAccessToken,
  verifyPassword,
} from './tokens';

interface Meta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /** The X-Client-App value (empty for the website). */
  clientApp?: string;
}

const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
const locked = () =>
  new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${env.LOCKOUT_MINUTES} minutes.`);

function lockoutUpdate(failedLoginCount: number) {
  const count = failedLoginCount + 1;
  return count >= env.MAX_FAILED_LOGINS
    ? { $set: { failedLoginCount: 0, lockUntil: new Date(Date.now() + env.LOCKOUT_MINUTES * 60_000) } }
    : { $set: { failedLoginCount: count } };
}

async function schoolSession(
  user: { _id: any; schoolId: any; role: string; tokenVersion?: number },
  meta: Meta,
  familyId?: string,
) {
  const accessToken = signSchoolAccessToken({
    userId: user._id.toString(),
    schoolId: user.schoolId.toString(),
    role: user.role as SchoolRole,
    tokenVersion: user.tokenVersion ?? 0,
  });
  const refresh = await issueRefreshToken({
    subjectType: 'user',
    subjectId: user._id,
    schoolId: user.schoolId,
    familyId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
  };
}

export async function loginSchoolUser(
  input: { email?: string; username?: string; password: string; schoolCode?: string },
  meta: Meta,
) {
  // The sign-in identifier is an email, or a username (phone / admission no / employee no).
  const id = (input.email ?? input.username ?? '').trim().toLowerCase();
  const filter: Record<string, unknown> = id.includes('@') ? { email: id } : { username: id };
  if (input.schoolCode) {
    const school = await School.findOne({ code: input.schoolCode.toUpperCase() }).select('_id').lean();
    if (!school) {
      await verifyPassword(input.password, null);
      throw invalidCredentials();
    }
    filter.schoolId = school._id;
  }
  const candidates = await User.find({ ...filter, role: { $nin: RETIRED_SCHOOL_ROLES } })
    .setOptions({ crossTenant: true })
    .select('+passwordHash +failedLoginCount +lockUntil')
    .limit(5)
    .lean();

  if (candidates.length > 1) {
    throw badRequest(
      'This sign-in ID is registered at more than one school. Please provide schoolCode.',
      undefined,
      'SCHOOL_CODE_REQUIRED',
    );
  }
  const user = candidates[0];
  if (!user) {
    // A retired student login gets a clear pointer to the parent portal, but only with the
    // right password, so the message never reveals which sign-in IDs exist.
    const retired = await User.findOne({ ...filter, role: { $in: RETIRED_SCHOOL_ROLES } })
      .setOptions({ crossTenant: true })
      .select('+passwordHash')
      .lean();
    if (await verifyPassword(input.password, retired?.passwordHash ?? null)) throw retiredAccount();
    throw invalidCredentials();
  }
  if (user.lockUntil && user.lockUntil.getTime() > Date.now()) throw locked();

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    await User.updateOne({ _id: user._id, schoolId: user.schoolId }, lockoutUpdate(user.failedLoginCount ?? 0));
    await AuditLog.create({
      schoolId: user.schoolId,
      actorType: 'user',
      actorId: user._id,
      actorName: user.name,
      actorRole: user.role,
      action: 'auth.login_failed',
      outcome: 'failure',
      ip: meta.ip,
      requestId: meta.requestId,
    });
    throw invalidCredentials();
  }
  if (user.status !== 'active') throw accountInactive(user.status);

  const school = await School.findById(user.schoolId).select('name code status subscription').lean();
  if (!school) throw invalidCredentials();
  if (school.status !== 'active') {
    throw new AppError(403, 'SCHOOL_SUSPENDED', 'This school account is not active. Please contact support.');
  }
  // Mobile app: parents and teachers only. Checked after the password, so the answer never
  // reveals an account's role to someone without its credentials; no tokens are issued.
  try {
    mobileFeatureFor(meta.clientApp ?? '', user.role as SchoolRole);
  } catch (err) {
    await AuditLog.create({
      schoolId: user.schoolId,
      actorType: 'user',
      actorId: user._id,
      actorName: user.name,
      actorRole: user.role,
      action: 'auth.mobile_login_refused',
      outcome: 'failure',
      ip: meta.ip,
      requestId: meta.requestId,
      metadata: { clientApp: meta.clientApp },
    });
    throw err;
  }

  await User.updateOne(
    { _id: user._id, schoolId: user.schoolId },
    { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockUntil: 1 } },
  );
  await AuditLog.create({
    schoolId: user.schoolId,
    actorType: 'user',
    actorId: user._id,
    actorName: user.name,
    actorRole: user.role,
    action: 'auth.login',
    ip: meta.ip,
    requestId: meta.requestId,
  });

  const tokens = await schoolSession(user, meta);
  const { passwordHash: _p, failedLoginCount: _f, lockUntil: _l, tokenVersion: _t, ...publicUser } = user as any;
  return {
    ...tokens,
    user: publicUser,
    school: { _id: school._id, name: school.name, code: school.code },
    permissions: [...(await permissionsFor(user.schoolId, user.role as SchoolRole, user.customRoleId))],
  };
}

export async function refreshSchoolSession(refreshToken: string, meta: Meta) {
  const rotated = await rotateRefreshToken(refreshToken, 'user', meta);
  const user = await User.findOne({ _id: rotated.subjectId, schoolId: rotated.schoolId })
    .select('schoolId role status tokenVersion')
    .lean();
  if (!user || user.status !== 'active' || isRetiredRole(user.role)) {
    await revokeRefreshToken(rotated.token);
    throw unauthorized('Session is no longer valid');
  }
  const school = await School.findById(user.schoolId).select('status').lean();
  if (!school || school.status !== 'active') {
    await revokeRefreshToken(rotated.token);
    throw new AppError(403, 'SCHOOL_SUSPENDED', 'This school account is not active.');
  }
  try {
    mobileFeatureFor(meta.clientApp ?? '', user.role as SchoolRole);
  } catch (err) {
    // The session stays valid for the website; this app just gets no new tokens.
    await revokeRefreshToken(rotated.token);
    throw err;
  }
  return {
    accessToken: signSchoolAccessToken({
      userId: user._id.toString(),
      schoolId: user.schoolId.toString(),
      role: user.role as SchoolRole,
      tokenVersion: user.tokenVersion ?? 0,
    }),
    tokenType: 'Bearer' as const,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken: rotated.token,
    refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
  };
}

export async function getSchoolMe(ctx: SchoolContext) {
  const [user, school] = await Promise.all([
    User.findOne({ _id: ctx.userId, schoolId: ctx.schoolId }).select(USER_PUBLIC_FIELDS).lean(),
    School.findById(ctx.schoolId)
      .select(
        'name code city status subscription.status subscription.trialEndsAt settings.currentSessionId settings.timezone settings.currency settings.ui',
      )
      .lean(),
  ]);
  return { user, school, permissions: [...ctx.permissions], entitlements: [...ctx.entitlements] };
}

export async function changeSchoolPassword(
  ctx: SchoolContext,
  currentPassword: string,
  newPassword: string,
  meta: Meta,
) {
  const user = await User.findOne({ _id: ctx.userId, schoolId: ctx.schoolId }).select('+passwordHash').lean();
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  if (currentPassword === newPassword) throw badRequest('New password must differ from the current password');
  const updated = await User.findOneAndUpdate(
    { _id: ctx.userId, schoolId: ctx.schoolId },
    { $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' },
  ).lean();
  await revokeAllForSubject('user', ctx.userId, 'password_changed');
  await audit(ctx, { action: 'auth.password_changed', entityType: 'User', entityId: ctx.userId });
  return schoolSession(updated!, meta);
}

export async function logoutAllSchool(ctx: SchoolContext) {
  await User.updateOne({ _id: ctx.userId, schoolId: ctx.schoolId }, { $inc: { tokenVersion: 1 } });
  await revokeAllForSubject('user', ctx.userId, 'logout_all');
  await audit(ctx, { action: 'auth.logout_all', entityType: 'User', entityId: ctx.userId });
}

// ───────────────────────── Platform administrators ─────────────────────────

async function platformSession(admin: { _id: any; role: string; tokenVersion?: number }, meta: Meta) {
  const refresh = await issueRefreshToken({
    subjectType: 'platform',
    subjectId: admin._id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return {
    accessToken: signPlatformAccessToken({
      adminId: admin._id.toString(),
      role: admin.role as PlatformContext['role'],
      tokenVersion: admin.tokenVersion ?? 0,
    }),
    tokenType: 'Bearer' as const,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
  };
}

export async function loginPlatformAdmin(input: { email: string; password: string }, meta: Meta) {
  const admin = await PlatformAdmin.findOne({ email: input.email })
    .select('+passwordHash +failedLoginCount +lockUntil')
    .lean();
  if (!admin) {
    await verifyPassword(input.password, null);
    throw invalidCredentials();
  }
  if (admin.lockUntil && admin.lockUntil.getTime() > Date.now()) throw locked();
  if (!(await verifyPassword(input.password, admin.passwordHash))) {
    await PlatformAdmin.updateOne({ _id: admin._id }, lockoutUpdate(admin.failedLoginCount ?? 0));
    await AuditLog.create({
      actorType: 'platform_admin',
      actorId: admin._id,
      actorName: admin.name,
      actorRole: admin.role,
      action: 'platform.auth.login_failed',
      outcome: 'failure',
      ip: meta.ip,
      requestId: meta.requestId,
    });
    throw invalidCredentials();
  }
  if (admin.status !== 'active') throw forbidden('This platform account has been disabled');
  await PlatformAdmin.updateOne(
    { _id: admin._id },
    { $set: { failedLoginCount: 0, lastLoginAt: new Date(), lastLoginIp: meta.ip }, $unset: { lockUntil: 1 } },
  );
  await AuditLog.create({
    actorType: 'platform_admin',
    actorId: admin._id,
    actorName: admin.name,
    actorRole: admin.role,
    action: 'platform.auth.login',
    ip: meta.ip,
    requestId: meta.requestId,
  });
  const tokens = await platformSession(admin, meta);
  return { ...tokens, admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role } };
}

export async function refreshPlatformSession(refreshToken: string, meta: Meta) {
  const rotated = await rotateRefreshToken(refreshToken, 'platform', meta);
  const admin = await PlatformAdmin.findById(rotated.subjectId).select('role status tokenVersion').lean();
  if (!admin || admin.status !== 'active') {
    await revokeRefreshToken(rotated.token);
    throw unauthorized('Session is no longer valid');
  }
  return {
    accessToken: signPlatformAccessToken({
      adminId: admin._id.toString(),
      role: admin.role as PlatformContext['role'],
      tokenVersion: admin.tokenVersion ?? 0,
    }),
    tokenType: 'Bearer' as const,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken: rotated.token,
    refreshTokenExpiresAt: rotated.expiresAt.toISOString(),
  };
}

export async function getPlatformMe(ctx: PlatformContext) {
  return PlatformAdmin.findById(ctx.adminId).select(PLATFORM_ADMIN_PUBLIC_FIELDS).lean();
}

export async function changePlatformPassword(
  ctx: PlatformContext,
  currentPassword: string,
  newPassword: string,
  meta: Meta,
) {
  const admin = await PlatformAdmin.findById(ctx.adminId).select('+passwordHash').lean();
  if (!admin || !(await verifyPassword(currentPassword, admin.passwordHash))) {
    throw new AppError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  const updated = await PlatformAdmin.findByIdAndUpdate(
    ctx.adminId,
    { $set: { passwordHash: await hashPassword(newPassword) }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' },
  ).lean();
  await revokeAllForSubject('platform', ctx.adminId, 'password_changed');
  await audit(ctx, { action: 'platform.auth.password_changed', entityType: 'PlatformAdmin', entityId: ctx.adminId });
  return platformSession(updated!, meta);
}
