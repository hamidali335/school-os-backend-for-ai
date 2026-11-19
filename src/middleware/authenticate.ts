import type { NextFunction, Request, Response } from 'express';
import type { Types } from 'mongoose';
import {
  effectivePermissions,
  isRetiredRole,
  ROLE_PERMISSIONS,
  type Permission,
  type SchoolRole,
} from '../config/permissions';
import { PlatformAdmin } from '../modules/platform-admin/platform-admin.model';
import { School } from '../modules/schools/school.model';
import { StaffRole, User } from '../modules/users/user.model';
import { verifyPlatformAccessToken, verifySchoolAccessToken } from '../modules/auth/tokens';
import {
  assertEntitled,
  computeEntitlements,
  planForEntitlements,
  subscriptionEligible,
  type SubscriptionLike,
} from '../modules/subscriptions/entitlements.service';
import type { FeatureKey } from '../config/entitlements';
import { AppError, forbidden, unauthorized } from '../utils/errors';
import type { PlatformContext, SchoolContext } from '../types/context';

function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) throw unauthorized();
  const token = header.slice(7).trim();
  if (!token) throw unauthorized();
  return token;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function accountInactive(status: string | null | undefined) {
  if (status === 'pending')
    return new AppError(403, 'ACCOUNT_PENDING', 'This account has not been activated yet. Use your activation link.');
  if (status === 'suspended')
    return new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact the school office.');
  return new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
}

/** A retired student login: the parent portal now covers everything it did. */
export function retiredAccount() {
  return new AppError(
    403,
    'ACCOUNT_RETIRED',
    'Student accounts are no longer used. Please sign in with your parent’s account to see school information.',
  );
}

/**
 * Effective permissions, re-read on every request so a change to a custom role (or removing it)
 * takes effect immediately without waiting for tokens to expire.
 */
export async function permissionsFor(
  schoolId: string | Types.ObjectId,
  role: SchoolRole,
  customRoleId?: Types.ObjectId | string | null,
): Promise<ReadonlySet<Permission>> {
  if (role !== 'staff' || !customRoleId) return ROLE_PERMISSIONS[role];
  const custom = await StaffRole.findOne({ _id: customRoleId, schoolId }).select('permissions').lean();
  return effectivePermissions(role, custom?.permissions ?? []);
}

/** Is the school's subscription currently allowing writes? (The same policy decides premium-feature eligibility.) */
export function subscriptionAllowsWrites(
  sub: { status?: string | null; trialEndsAt?: Date | null } | null | undefined,
) {
  return subscriptionEligible(sub);
}

/**
 * Dedicated mobile apps identify themselves with this header. Web portals never send it, so
 * they keep working on every plan for every role.
 *
 * Policy (approved): the mobile app is for **parents and teachers only**. The decision uses the
 * role verified from the database, never anything the client declares:
 * - `mobile` (sent by the app from sign-in onwards): parent → `mobile.parent_app`,
 *   teacher → `mobile.teacher_app`, every other role → 403 MOBILE_ROLE_NOT_ALLOWED.
 * - `parent-mobile` / `teacher-mobile` (older builds): accepted only for that exact role.
 * - Any other value → 403 Unknown client application.
 *
 * Limitation: a header cannot prove which program sends it. A staff member who omits it is
 * treated like the website, where staff already have full access, so no privilege is gained.
 */
export const CLIENT_APP_HEADER = 'x-client-app';
const ROLE_FEATURE: Partial<Record<SchoolRole, FeatureKey>> = {
  parent: 'mobile.parent_app',
  teacher: 'mobile.teacher_app',
};
const LEGACY_CLIENT_ROLE: Record<string, SchoolRole> = { 'parent-mobile': 'parent', 'teacher-mobile': 'teacher' };

export function readClientApp(headers: Record<string, unknown>): string {
  const raw = headers[CLIENT_APP_HEADER];
  return String(Array.isArray(raw) ? raw[0] : (raw ?? ''))
    .trim()
    .toLowerCase();
}

/**
 * The mobile plan feature this request needs, or null for the website. Throws 403 when the
 * declared client is unknown or the verified role may not use the mobile app.
 */
export function mobileFeatureFor(client: string, role: SchoolRole): FeatureKey | null {
  if (!client) return null;
  if (client !== 'mobile' && !(client in LEGACY_CLIENT_ROLE)) throw forbidden('Unknown client application');
  const feature = ROLE_FEATURE[role];
  const legacyRole = LEGACY_CLIENT_ROLE[client];
  if (!feature || (legacyRole && legacyRole !== role)) {
    throw new AppError(
      403,
      'MOBILE_ROLE_NOT_ALLOWED',
      'The mobile app is for parents and teachers. Please use the school website to sign in.',
    );
  }
  return feature;
}

/**
 * Builds the school context for an access token, re-checking everything against the database:
 * a disabled user, a revoked token version, a suspended school or a plan change applies
 * immediately. Shared by HTTP requests and the call signaling socket, so both enforce the same
 * rules. The tenant (schoolId) comes exclusively from the verified token.
 */
export async function schoolContextFromToken(
  token: string,
  req: {
    method: string;
    headers: Record<string, unknown>;
    ip?: string;
    requestId?: string;
    allowInactiveSubscription?: boolean;
  },
): Promise<SchoolContext> {
  const claims = verifySchoolAccessToken(token);
  if (claims.typ !== 'school') throw unauthorized('Invalid access token');

  const user = await User.findOne({ _id: claims.sub, schoolId: claims.sid })
    .select('name email username role customRoleId status tokenVersion campusIds employeeId parentId')
    .lean();
  if (!user || user.tokenVersion !== claims.tv) throw unauthorized('Session is no longer valid');
  if (isRetiredRole(user.role)) throw retiredAccount();
  if (user.status !== 'active') throw accountInactive(user.status);

  const school = await School.findById(claims.sid).select('status subscription').lean();
  if (!school) throw unauthorized('Session is no longer valid');
  if (school.status === 'suspended') {
    throw new AppError(403, 'SCHOOL_SUSPENDED', 'This school account is suspended. Please contact support.');
  }
  if (school.status === 'pending') {
    throw new AppError(403, 'SCHOOL_SUSPENDED', 'This school account has not been activated yet.');
  }
  if (
    !req.allowInactiveSubscription &&
    !READ_METHODS.has(req.method) &&
    !subscriptionAllowsWrites(school.subscription)
  ) {
    throw new AppError(
      402,
      'SUBSCRIPTION_INACTIVE',
      'The school subscription is inactive. Data is read-only until the subscription is renewed.',
    );
  }

  // Entitlements come from the saved subscription and plan on every request, never from the
  // token, so plan changes and revocations apply to the very next request of every user.
  const plan = await planForEntitlements(school.subscription?.planId);
  const ent = computeEntitlements(school.subscription as SubscriptionLike, plan);
  const feature = mobileFeatureFor(readClientApp(req.headers), user.role as SchoolRole);
  if (feature) assertEntitled(ent, [feature]);

  const role = user.role as SchoolRole;
  return {
    kind: 'school',
    userId: user._id.toString(),
    schoolId: claims.sid,
    role,
    name: user.name,
    email: user.email ?? user.username ?? '',
    campusIds: (user.campusIds ?? []).map((c) => c.toString()),
    permissions: await permissionsFor(claims.sid, role, user.customRoleId),
    entitlements: ent.features,
    subscriptionEligible: ent.eligible,
    employeeId: user.employeeId?.toString(),
    parentId: user.parentId?.toString(),
    ip: req.ip,
    requestId: req.requestId,
  };
}

/** Authenticates a school user (see schoolContextFromToken). */
export function authenticateSchool(options: { allowInactiveSubscription?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.ctx = await schoolContextFromToken(bearer(req), {
      method: req.method,
      headers: req.headers,
      ip: req.ip,
      requestId: req.requestId,
      allowInactiveSubscription: options.allowInactiveSubscription,
    });
    next();
  };
}

export function authenticatePlatform() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const claims = verifyPlatformAccessToken(bearer(req));
    if (claims.typ !== 'platform') throw unauthorized('Invalid access token');
    const admin = await PlatformAdmin.findById(claims.sub).select('name email role status tokenVersion').lean();
    if (!admin || admin.tokenVersion !== claims.tv) throw unauthorized('Session is no longer valid');
    if (admin.status !== 'active') throw forbidden('This platform account has been disabled');
    const ctx: PlatformContext = {
      kind: 'platform',
      adminId: admin._id.toString(),
      role: admin.role as PlatformContext['role'],
      name: admin.name,
      email: admin.email,
      ip: req.ip,
      requestId: req.requestId,
    };
    req.ctx = ctx;
    next();
  };
}
