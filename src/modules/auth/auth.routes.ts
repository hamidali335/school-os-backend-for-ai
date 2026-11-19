import { readClientApp } from '../../middleware/authenticate';
import { authIpLimiter, authLimiter, refreshIpLimiter, refreshSessionLimiter } from '../../middleware/rate-limit';
import type { Api } from '../../utils/api';
import { email, objectId, password, z } from '../../utils/zod';
import { SCHOOL_ROLES, PERMISSIONS, PLATFORM_ROLES } from '../../config/permissions';
import { USER_STATUSES } from '../users/user.model';
import { inspectAccountToken, redeemAccountToken } from '../users/users.service';
import * as svc from './auth.service';
import { revokeRefreshToken } from './tokens';

const TokenPair = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().openapi({ description: 'Access token lifetime in seconds' }),
    refreshToken: z.string().openapi({ description: 'Opaque, single-use. Rotates on every refresh.' }),
    refreshTokenExpiresAt: z.string(),
  })
  .openapi('TokenPair');

export const SchoolUserSchema = z
  .object({
    _id: objectId(),
    schoolId: objectId(),
    name: z.string(),
    email: z.string().optional(),
    username: z.string().optional(),
    phone: z.string().optional(),
    role: z.enum(SCHOOL_ROLES),
    customRoleId: z.any().optional(),
    status: z.enum(USER_STATUSES),
    statusReason: z.string().optional(),
    archivedAt: z.string().optional(),
    archivedReason: z.string().optional(),
    campusIds: z.array(objectId()),
    employeeId: objectId().optional(),
    parentId: objectId().optional(),
    provisionedBy: z.string().optional(),
    activatedAt: z.string().optional(),
    mustChangePassword: z.boolean().optional(),
    lastLoginAt: z.string().optional(),
  })
  .openapi('SchoolUser');

const LoginBody = z
  .object({
    email: email().optional(),
    username: z.string().trim().toLowerCase().min(3).max(60).optional().openapi({
      description:
        'Sign-in ID for accounts without email: phone (parents), admission no (students), employee no (staff)',
    }),
    password: z.string().min(1).max(128),
    schoolCode: z.string().trim().max(20).optional().openapi({
      description:
        'Required only when the same sign-in ID exists at more than one school (error SCHOOL_CODE_REQUIRED).',
    }),
  })
  .refine((v) => Boolean(v.email) !== Boolean(v.username), {
    message: 'Provide either email or username',
    path: ['email'],
  })
  .openapi('SchoolLoginRequest');

const TokenBody = z.object({ token: z.string().trim().min(20).max(200) });

const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const ChangePasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password() });

const meta = (req: { ip?: string; headers: Record<string, any>; requestId: string }) => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'] as string | undefined,
  requestId: req.requestId,
  clientApp: readClientApp(req.headers),
});

export function registerAuthRoutes(api: Api) {
  const tags = ['Auth'];

  api.route({
    method: 'post',
    path: '/auth/login',
    tags,
    auth: 'public',
    summary: 'Log in as a school user',
    description:
      'Returns a short-lived access token and a rotating refresh token. After 5 failed attempts the account is locked temporarily (`ACCOUNT_LOCKED`, HTTP 423).',
    middleware: [authIpLimiter, authLimiter],
    body: LoginBody,
    response: TokenPair.extend({
      user: SchoolUserSchema,
      school: z.object({ _id: objectId(), name: z.string(), code: z.string() }),
      permissions: z.array(z.enum(PERMISSIONS)),
    }),
    handler: ({ req, body }) => svc.loginSchoolUser(body, meta(req)),
  });

  api.route({
    method: 'post',
    path: '/auth/account-link/inspect',
    tags,
    auth: 'public',
    summary: 'Check an activation or password-reset link before choosing a password',
    description: 'Fails with 400 `INVALID_TOKEN` when the link is unknown, used, expired or the account is blocked.',
    middleware: [authIpLimiter, authLimiter],
    body: TokenBody,
    response: z.object({
      purpose: z.enum(['activation', 'password_reset']),
      name: z.string(),
      loginId: z.string(),
      username: z.string().nullable(),
      email: z.string().nullable(),
      school: z.object({ name: z.string(), code: z.string() }),
      expiresAt: z.string(),
    }),
    handler: ({ body }) => inspectAccountToken(body.token),
  });

  api.route({
    method: 'post',
    path: '/auth/account-link/redeem',
    tags,
    auth: 'public',
    summary: 'Activate an account (or reset a password) with a single-use link',
    description:
      'Sets the password, activates a pending account and signs out all existing sessions. Each link works once.',
    middleware: [authIpLimiter, authLimiter],
    body: TokenBody.extend({ password: password() }),
    response: z.object({ loginId: z.string(), role: z.enum(SCHOOL_ROLES) }),
    handler: ({ req, body }) => redeemAccountToken(body.token, body.password, meta(req)),
  });

  api.route({
    method: 'post',
    path: '/auth/refresh',
    tags,
    auth: 'public',
    summary: 'Exchange a refresh token for a new token pair',
    description: 'Refresh tokens are single use. Re-using an old refresh token revokes the whole session family.',
    middleware: [refreshIpLimiter, refreshSessionLimiter],
    body: RefreshBody,
    response: TokenPair,
    handler: ({ req, body }) => svc.refreshSchoolSession(body.refreshToken, meta(req)),
  });

  api.route({
    method: 'post',
    path: '/auth/logout',
    tags,
    auth: 'public',
    summary: 'Revoke a refresh token session',
    body: RefreshBody,
    status: 204,
    handler: async ({ body }) => {
      await revokeRefreshToken(body.refreshToken);
    },
  });

  api.route({
    method: 'post',
    path: '/auth/logout-all',
    tags,
    auth: 'school',
    allowInactiveSubscription: true,
    summary: 'Sign out of every device (invalidates all access and refresh tokens)',
    status: 204,
    handler: ({ ctx }) => svc.logoutAllSchool(ctx),
  });

  api.route({
    method: 'get',
    path: '/auth/me',
    tags,
    auth: 'school',
    summary: 'Current user, school summary, effective permissions and plan features',
    response: z.object({
      user: SchoolUserSchema,
      school: z.object({ _id: objectId(), name: z.string(), code: z.string() }).passthrough(),
      permissions: z.array(z.enum(PERMISSIONS)),
      entitlements: z
        .array(z.string())
        .openapi({ description: 'Plan features the school currently has (see GET /entitlements for details)' }),
    }),
    handler: ({ ctx }) => svc.getSchoolMe(ctx),
  });

  api.route({
    method: 'post',
    path: '/auth/change-password',
    tags,
    auth: 'school',
    allowInactiveSubscription: true,
    summary: 'Change own password',
    description: 'Revokes all other sessions and returns a fresh token pair.',
    middleware: [authIpLimiter, authLimiter],
    body: ChangePasswordBody,
    response: TokenPair,
    handler: ({ req, ctx, body }) => svc.changeSchoolPassword(ctx, body.currentPassword, body.newPassword, meta(req)),
  });

  // ───────────── Platform owner / admin authentication (separate identity) ─────────────
  const ptags = ['Platform Auth'];

  api.route({
    method: 'post',
    path: '/platform/auth/login',
    tags: ptags,
    auth: 'public',
    summary: 'Log in as a platform administrator',
    description:
      'Platform tokens are signed with a different secret and audience; they are rejected by school endpoints and vice versa.',
    middleware: [authIpLimiter, authLimiter],
    body: z.object({ email: email(), password: z.string().min(1).max(128) }),
    response: TokenPair.extend({
      admin: z.object({ _id: objectId(), name: z.string(), email: z.string(), role: z.enum(PLATFORM_ROLES) }),
    }),
    handler: ({ req, body }) => svc.loginPlatformAdmin(body, meta(req)),
  });

  api.route({
    method: 'post',
    path: '/platform/auth/refresh',
    tags: ptags,
    auth: 'public',
    summary: 'Rotate a platform refresh token',
    middleware: [authIpLimiter, authLimiter],
    body: RefreshBody,
    response: TokenPair,
    handler: ({ req, body }) => svc.refreshPlatformSession(body.refreshToken, meta(req)),
  });

  api.route({
    method: 'post',
    path: '/platform/auth/logout',
    tags: ptags,
    auth: 'public',
    summary: 'Revoke a platform refresh token session',
    body: RefreshBody,
    status: 204,
    handler: async ({ body }) => {
      await revokeRefreshToken(body.refreshToken);
    },
  });

  api.route({
    method: 'get',
    path: '/platform/auth/me',
    tags: ptags,
    auth: 'platform',
    summary: 'Current platform administrator',
    response: z
      .object({ _id: objectId(), name: z.string(), email: z.string(), role: z.enum(PLATFORM_ROLES) })
      .passthrough(),
    handler: ({ ctx }) => svc.getPlatformMe(ctx),
  });

  api.route({
    method: 'post',
    path: '/platform/auth/change-password',
    tags: ptags,
    auth: 'platform',
    summary: 'Change own platform password',
    middleware: [authIpLimiter, authLimiter],
    body: ChangePasswordBody,
    response: TokenPair,
    handler: ({ req, ctx, body }) => svc.changePlatformPassword(ctx, body.currentPassword, body.newPassword, meta(req)),
  });
}
