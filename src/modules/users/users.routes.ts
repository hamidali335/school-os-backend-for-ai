import {
  DELEGABLE_PERMISSIONS,
  PERMISSION_CATALOGUE,
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  SCHOOL_ROLES,
} from '../../config/permissions';
import type { Api } from '../../utils/api';
import { docBase, email, idParams, objectId, paginationQuery, password, phonePk, z } from '../../utils/zod';
import { SchoolUserSchema } from '../auth/auth.routes';
import { USER_STATUSES } from './user.model';
import * as svc from './users.service';
import * as lifecycleSvc from './user-lifecycle.service';

const AccessLink = z
  .object({
    token: z.string().openapi({ description: 'Single-use secret. Build the link as `<school app>/activate?token=…`.' }),
    expiresAt: z.string(),
  })
  .openapi('AccountAccessLink');

const StaffRoleRes = z
  .object({
    ...docBase,
    name: z.string(),
    description: z.string().optional(),
    permissions: z.array(z.enum(PERMISSIONS)),
    userCount: z.number(),
  })
  .openapi('StaffRole');

const RoleBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

export function registerUserRoutes(api: Api) {
  const tags = ['Users'];

  api.route({
    method: 'get',
    path: '/users',
    tags,
    auth: 'school',
    permission: 'users:read',
    summary: 'List login accounts in the school',
    query: paginationQuery.extend({
      role: z.enum(SCHOOL_ROLES).optional(),
      status: z.enum(USER_STATUSES).optional(),
      q: z.string().max(100).optional(),
      archived: z
        .enum(['exclude', 'only', 'include'])
        .optional()
        .openapi({ description: 'Archived accounts (people who have left): hidden by default' }),
    }),
    response: SchoolUserSchema,
    paginated: true,
    handler: ({ ctx, query }) => svc.listUsers(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/users/:id',
    tags,
    auth: 'school',
    permission: 'users:read',
    summary: 'Get a user account',
    params: idParams,
    response: SchoolUserSchema,
    handler: ({ ctx, params }) => svc.getUser(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/users',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Create a login account',
    description:
      'Role grants are enforced: the Admin can create any role; principals cannot create Admins/principals; office administrators can create teacher and parent accounts. ' +
      'Teachers must link `employeeId`, parents `parentId` (students do not get logins). `staff` accounts need a `customRoleId` (Admin only). ' +
      'Credentials: `password` sets one directly; otherwise `credential` chooses a one-time temporary password (default, returned once in `temporaryPassword`) ' +
      'or an activation link (account stays `pending` until the person opens it; token returned once in `activation`).',
    body: z
      .object({
        name: z.string().trim().min(2).max(100),
        email: email().optional(),
        username: z
          .string()
          .trim()
          .min(3)
          .max(40)
          .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash and underscore only')
          .optional(),
        phone: phonePk().optional(),
        role: z.enum(SCHOOL_ROLES),
        password: password().optional(),
        credential: z.enum(['temporary_password', 'activation_link']).optional(),
        customRoleId: objectId().optional(),
        campusIds: z.array(objectId()).max(20).optional(),
        employeeId: objectId().optional(),
        parentId: objectId().optional(),
      })
      .refine((v) => v.email || v.username, { message: 'Provide an email or a username', path: ['email'] }),
    response: z.object({
      user: SchoolUserSchema,
      temporaryPassword: z.string().optional(),
      activation: AccessLink.optional(),
    }),
    status: 201,
    handler: ({ ctx, body }) => svc.createUser(ctx, { ...body, provisionedBy: 'manual' }),
  });

  api.route({
    method: 'patch',
    path: '/users/:id',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Update a user (name, phone, role, custom role, status, campus access)',
    description:
      'Changing role, suspending or disabling an account signs the user out everywhere immediately. ' +
      'Nobody can change their own role, permissions or status. Assigning a custom role requires the Admin.',
    params: idParams,
    body: z
      .object({
        name: z.string().trim().min(2).max(100),
        phone: phonePk(),
        role: z.enum(SCHOOL_ROLES),
        customRoleId: objectId().nullable(),
        status: z.enum(['active', 'suspended', 'disabled']),
        statusReason: z.string().trim().max(200),
        campusIds: z.array(objectId()).max(20),
      })
      .partial(),
    response: SchoolUserSchema,
    handler: ({ ctx, params, body }) => svc.updateUser(ctx, params.id, body),
  });

  const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
  const lifecycle = (
    path: string,
    summary: string,
    description: string,
    handler: (ctx: any, id: string, body: any) => Promise<unknown>,
    body?: typeof Reason | ReturnType<typeof Reason.partial>,
  ) =>
    api.route({
      method: 'post',
      path,
      tags,
      auth: 'school',
      permission: 'users:manage',
      summary,
      description,
      params: idParams,
      ...(body ? { body } : {}),
      response: SchoolUserSchema,
      handler: ({ ctx, params, body: b }: any) => handler(ctx, params.id, b ?? {}),
    });

  lifecycle(
    '/users/:id/suspend',
    'Suspend an account (access stops immediately)',
    'Signs the person out everywhere at once and refuses every further request. Records linked to the account are kept. Refused for your own account and for the last active Admin (`LAST_ADMIN`).',
    (ctx, id, b) => lifecycleSvc.suspendUser(ctx, id, b.reason),
    Reason.partial(),
  );
  lifecycle(
    '/users/:id/reactivate',
    'Reactivate a suspended or disabled account',
    'Archived accounts must be restored from the archive first.',
    (ctx, id) => lifecycleSvc.reactivateUser(ctx, id),
  );
  lifecycle(
    '/users/:id/archive',
    'Archive an account (the person has left)',
    'Access stops at once and the account leaves the normal user list (`GET /users?archived=only` shows it). Payments it received, attendance it marked and its audit history are kept.',
    (ctx, id, b) => lifecycleSvc.archiveUser(ctx, id, b.reason),
    Reason,
  );
  lifecycle(
    '/users/:id/unarchive',
    'Restore an archived account to the user list (it stays disabled until reactivated)',
    '',
    (ctx, id) => lifecycleSvc.unarchiveUser(ctx, id),
  );

  api.route({
    method: 'get',
    path: '/users/:id/deletion-check',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Can this account be deleted? (only accounts created by mistake and never used)',
    params: idParams,
    response: z.object({
      canDelete: z.boolean(),
      blockers: z.array(z.object({ kind: z.string(), label: z.string() })),
    }),
    handler: ({ ctx, params }) => lifecycleSvc.checkUserDeletion(ctx, params.id),
  });

  api.route({
    method: 'delete',
    path: '/users/:id',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Delete an account created by mistake (never used)',
    description:
      'Refused with 409 `IN_USE` once the account has been used to sign in: archive it instead. The linked staff or parent record is kept; only its login is removed.',
    params: idParams,
    body: Reason,
    status: 204,
    handler: ({ ctx, params, body }) => lifecycleSvc.deleteUser(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/users/:id/reset-password',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: "Reset a user's password to a one-time temporary password",
    params: idParams,
    response: z.object({ temporaryPassword: z.string() }),
    handler: ({ ctx, params }) => svc.resetUserPassword(ctx, params.id),
  });

  api.route({
    method: 'patch',
    path: '/users/:id/sign-in',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Change the email (or username) a teacher, student, parent or staff member signs in with',
    description:
      'For correcting a mistyped sign-in email, before or after the portal account is activated. ' +
      'Pass `null` to remove an identifier; at least one of email or username must remain. ' +
      'Duplicates in the school are rejected (409 `DUPLICATE`). The linked staff/parent contact email is updated when it held the old address.',
    params: idParams,
    body: z
      .object({
        email: email().nullable().optional(),
        username: z.string().trim().min(3).max(40).nullable().optional(),
      })
      .refine((v) => v.email !== undefined || v.username !== undefined, { message: 'Provide email or username' }),
    response: SchoolUserSchema,
    handler: ({ ctx, params, body }) => svc.changeSignIn(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/users/:id/access-link',
    tags,
    auth: 'school',
    permission: 'users:manage',
    summary: 'Issue a single-use activation link (pending accounts) or password-reset link',
    description:
      'Activation links last 7 days, reset links 48 hours. Issuing a new link invalidates the previous one. The token is returned once and stored only as a hash.',
    params: idParams,
    response: AccessLink.extend({ purpose: z.enum(['activation', 'password_reset']) }),
    handler: ({ ctx, params }) => svc.issueAccessLink(ctx, params.id),
  });

  // ─────────────────────────── Roles & permissions ───────────────────────────
  const rtags = ['Roles & permissions'];

  api.route({
    method: 'get',
    path: '/roles/catalogue',
    tags: rtags,
    auth: 'school',
    permission: 'users:read',
    summary: 'Permission catalogue grouped by module, and the built-in roles with their permissions',
    response: z.object({
      modules: z.array(
        z.object({
          module: z.string(),
          label: z.string(),
          permissions: z.array(
            z.object({
              key: z.enum(PERMISSIONS),
              action: z.string(),
              label: z.string(),
              delegable: z.boolean(),
            }),
          ),
        }),
      ),
      builtInRoles: z.array(
        z.object({ role: z.enum(SCHOOL_ROLES), label: z.string(), permissions: z.array(z.enum(PERMISSIONS)) }),
      ),
    }),
    handler: () => ({
      modules: PERMISSION_CATALOGUE.map((m) => ({
        ...m,
        permissions: m.permissions.map((p) => ({ ...p, delegable: DELEGABLE_PERMISSIONS.includes(p.key) })),
      })),
      builtInRoles: SCHOOL_ROLES.map((role) => ({
        role,
        label: ROLE_LABELS[role],
        permissions: [...ROLE_PERMISSIONS[role]],
      })),
    }),
  });

  api.route({
    method: 'get',
    path: '/roles',
    tags: rtags,
    auth: 'school',
    permission: 'users:read',
    summary: 'Custom staff roles defined by the school',
    response: z.array(StaffRoleRes),
    handler: ({ ctx }) => svc.listStaffRoles(ctx),
  });

  api.route({
    method: 'post',
    path: '/roles',
    tags: rtags,
    auth: 'school',
    permission: 'roles:manage',
    summary: 'Create a custom staff role (Admin only)',
    description:
      '`roles:manage` can never be placed in a custom role, so delegated users cannot grant themselves privileges.',
    body: RoleBody,
    response: StaffRoleRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createStaffRole(ctx, body),
  });

  api.route({
    method: 'patch',
    path: '/roles/:id',
    tags: rtags,
    auth: 'school',
    permission: 'roles:manage',
    summary: 'Change a custom role (takes effect on the next request of every account using it)',
    params: idParams,
    body: RoleBody.partial(),
    response: StaffRoleRes,
    handler: ({ ctx, params, body }) => svc.updateStaffRole(ctx, params.id, body),
  });

  api.route({
    method: 'delete',
    path: '/roles/:id',
    tags: rtags,
    auth: 'school',
    permission: 'roles:manage',
    summary: 'Delete a custom role that no account uses',
    params: idParams,
    status: 204,
    handler: ({ ctx, params }) => svc.deleteStaffRole(ctx, params.id),
  });
}
