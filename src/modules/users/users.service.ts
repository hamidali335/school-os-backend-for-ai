import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { inTransaction } from '../../database/transactions';
import {
  isRetiredRole,
  NON_DELEGABLE_PERMISSIONS,
  RETIRED_SCHOOL_ROLES,
  ROLE_GRANTS,
  STAFF_ROLES,
  type Permission,
  type SchoolRole,
} from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { paginate, textSearchFilter } from '../../utils/pagination';
import { assertManyRefs, assertRefs, findOwned, oid, scope } from '../../utils/tenant';
import { logger } from '../../config/logger';
import { audit } from '../audit/audit.service';
import { hashPassword, revokeAllForSubject } from '../auth/tokens';
import { Campus } from '../campuses/campus.model';
import { Employee } from '../employees/employee.model';
import { Parent, Student } from '../students/student.models';
import { getSchoolLimits, planLimitError } from '../subscriptions/limits.service';
import { AccountToken, StaffRole, User, USER_PUBLIC_FIELDS, type UserStatus } from './user.model';
import { assertAdminRemains } from './user-lifecycle.service';

export function generateTempPassword(): string {
  // 4 groups, guaranteed upper/lower/digit — satisfies the password policy.
  const raw = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  return `Tmp-${raw.slice(0, 4)}A${raw.slice(4, 8)}9z`;
}

/** Hash of a random secret nobody knows: the account cannot sign in until activated. */
async function unusablePasswordHash() {
  return hashPassword(crypto.randomBytes(32).toString('base64url'));
}

export const ACTIVATION_TTL_DAYS = 7;
export const RESET_TTL_HOURS = 48;
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function assertCanGrant(ctx: SchoolContext, role: SchoolRole) {
  if (!ROLE_GRANTS[ctx.role].includes(role)) throw forbidden(`Your role cannot manage ${role} accounts`);
}

const STAFF_ROLE_LIST = [...STAFF_ROLES];

async function assertStaffLimit(ctx: Pick<SchoolContext, 'schoolId'>) {
  // Sequential on purpose: can run inside a transaction, which cannot run operations in parallel.
  const limits = await getSchoolLimits(ctx.schoolId);
  const count = await User.countDocuments(
    scope(ctx, { role: { $in: STAFF_ROLE_LIST }, status: { $in: ['active', 'pending'] } }),
  );
  if (count >= limits.maxStaffUsers) throw planLimitError('active staff accounts', limits.maxStaffUsers);
}

/** "+92 300-1234567" → "03001234567". Used as the sign-in username for parents. */
export function normalisePhoneUsername(phone: string): string {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('92') && d.length === 12) d = `0${d.slice(2)}`;
  return d;
}

export function normaliseUsername(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

/** First free username based on `base` (base, base-2, base-3, ...). */
async function uniqueUsername(ctx: Pick<SchoolContext, 'schoolId'>, base: string): Promise<string> {
  const clean = normaliseUsername(base) || 'user';
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? clean : `${clean}-${i}`;
    if (!(await User.exists(scope(ctx, { username: candidate })))) return candidate;
  }
  return `${clean}-${crypto.randomBytes(3).toString('hex')}`;
}

async function emailAvailable(ctx: Pick<SchoolContext, 'schoolId'>, email?: string | null) {
  if (!email) return false;
  return !(await User.exists(scope(ctx, { email: email.toLowerCase() })));
}

async function assertCustomRole(ctx: SchoolContext, role: SchoolRole, customRoleId?: string | null) {
  if (role !== 'staff') {
    if (customRoleId) throw badRequest('A custom role can only be assigned to staff accounts');
    return;
  }
  if (!customRoleId) throw badRequest('customRoleId is required for staff accounts');
  if (!ctx.permissions.has('roles:manage')) throw forbidden('Only the school Admin can assign custom roles');
  const r = await StaffRole.findOne(scope(ctx, { _id: oid(customRoleId) }))
    .select('_id')
    .lean();
  if (!r) throw badRequest('customRoleId does not exist in this school', undefined, 'INVALID_REFERENCE');
}

export type CredentialMode = 'temporary_password' | 'activation_link' | 'password';

export interface CreateUserInput {
  name: string;
  email?: string;
  username?: string;
  phone?: string;
  role: SchoolRole;
  password?: string;
  /** Default: temporary password when no password is given (existing behaviour). */
  credential?: CredentialMode;
  customRoleId?: string;
  campusIds?: string[];
  employeeId?: string;
  parentId?: string;
  provisionedBy?: 'manual' | 'staff_registration' | 'admission' | 'onboarding';
}

export interface ProvisionResult {
  user: Record<string, unknown>;
  /** Returned exactly once; never stored in plain text. */
  temporaryPassword?: string;
  /** Activation token (to build the activation link); returned exactly once. */
  activation?: { token: string; expiresAt: string };
}

/**
 * The single account-creation path. Manual creation, teacher auto-provisioning and admission
 * auto-provisioning all go through here, so validation, duplicate protection and auditing are
 * identical everywhere. Duplicate logins for the same staff/parent record are blocked
 * by both a pre-check and a unique index (safe under concurrent or repeated requests).
 */
export async function createUser(ctx: SchoolContext, input: CreateUserInput): Promise<ProvisionResult> {
  assertCanGrant(ctx, input.role);
  if (STAFF_ROLES.has(input.role)) await assertStaffLimit(ctx);
  if (input.role === 'parent' && !input.parentId) throw badRequest('parentId is required for parent accounts');
  if (input.role === 'teacher' && !input.employeeId) throw badRequest('employeeId is required for teacher accounts');
  if (input.role !== 'parent' && input.parentId) throw badRequest('parentId is only valid for parent accounts');
  if (!STAFF_ROLES.has(input.role) && input.employeeId) throw badRequest('employeeId is only valid for staff accounts');
  if (!input.email && !input.username) throw badRequest('Provide an email or a username for the account');
  await assertCustomRole(ctx, input.role, input.customRoleId);
  await assertRefs(ctx, [
    [Employee, input.employeeId, 'employeeId'],
    [Parent, input.parentId, 'parentId'],
  ]);
  if (input.campusIds?.length) await assertManyRefs(ctx, Campus, input.campusIds, 'campus');
  for (const [field, val] of [
    ['employeeId', input.employeeId],
    ['parentId', input.parentId],
  ] as const) {
    if (val && (await User.exists(scope(ctx, { [field]: oid(val) }))))
      throw conflict(`A login already exists for this ${field.replace('Id', '')}`, undefined, 'DUPLICATE');
  }
  if (input.email && !(await emailAvailable(ctx, input.email)))
    throw conflict('Another account in this school already uses this email', { field: 'email' }, 'DUPLICATE');
  const username = input.username ? normaliseUsername(input.username) : undefined;
  if (username && (await User.exists(scope(ctx, { username }))))
    throw conflict('This username is already taken', { field: 'username' }, 'DUPLICATE');

  const mode: CredentialMode = input.password ? 'password' : (input.credential ?? 'temporary_password');
  if (mode === 'password' && !input.password) throw badRequest('password is required');
  const tempPassword = mode === 'temporary_password' ? generateTempPassword() : undefined;
  const passwordHash =
    mode === 'activation_link' ? await unusablePasswordHash() : await hashPassword(input.password ?? tempPassword!);
  const status: UserStatus = mode === 'activation_link' ? 'pending' : 'active';

  const user = await User.create({
    schoolId: ctx.schoolId,
    name: input.name,
    email: input.email?.toLowerCase(),
    username,
    phone: input.phone,
    role: input.role,
    customRoleId: input.customRoleId,
    status,
    passwordHash,
    mustChangePassword: mode !== 'activation_link',
    campusIds: input.campusIds ?? [],
    employeeId: input.employeeId,
    parentId: input.parentId,
    provisionedBy: input.provisionedBy ?? 'manual',
  }).catch((err) => {
    if (err?.code === 11000) throw duplicateLoginError(err);
    throw err;
  });

  try {
    if (input.employeeId)
      await Employee.updateOne(scope(ctx, { _id: oid(input.employeeId) }), { $set: { userId: user._id } });
    if (input.parentId)
      await Parent.updateOne(scope(ctx, { _id: oid(input.parentId) }), { $set: { userId: user._id } });
  } catch (err) {
    if (inTransaction()) throw err;
    // Do not leave a login that its staff/parent record does not point to.
    await User.deleteOne(scope(ctx, { _id: user._id }));
    throw err;
  }

  const activation = mode === 'activation_link' ? await issueAccountToken(ctx, user._id, 'activation') : undefined;
  await audit(ctx, {
    action: 'user.create',
    entityType: 'User',
    entityId: user._id,
    metadata: { role: input.role, credential: mode, provisionedBy: input.provisionedBy ?? 'manual' },
  });
  const publicUser = await User.findOne(scope(ctx, { _id: user._id }))
    .select(USER_PUBLIC_FIELDS)
    .lean();
  return { user: publicUser as Record<string, unknown>, temporaryPassword: tempPassword, activation };
}

/**
 * Turn a MongoDB duplicate-key error into a message naming what actually collided, instead of
 * guessing. An unexpected key (e.g. a stale index left in the database) is logged loudly.
 */
function duplicateLoginError(err: { keyPattern?: Record<string, unknown>; message?: string }) {
  const keys = Object.keys(err.keyPattern ?? {}).filter((k) => k !== 'schoolId');
  const field = keys[0];
  if (field === 'email')
    return conflict('Another account in this school already uses this email', { field }, 'DUPLICATE');
  if (field === 'username') return conflict('This username is already taken', { field }, 'DUPLICATE');
  if (field === 'employeeId') return conflict('A login already exists for this staff member', { field }, 'DUPLICATE');
  if (field === 'parentId') return conflict('A login already exists for this parent', { field }, 'DUPLICATE');
  if (field === 'studentId') return conflict('A login already exists for this student', { field }, 'DUPLICATE');
  logger.error(
    { keyPattern: err.keyPattern, msg: err.message?.slice(0, 300) },
    'Unexpected duplicate key creating a login (stale index? run `npm run db:indexes`)',
  );
  return conflict('This login could not be created because of a conflicting record', { fields: keys }, 'DUPLICATE');
}

/** Remove a login created moments ago (used to roll back a failed multi-step operation). */
export async function rollbackCreatedUser(ctx: Pick<SchoolContext, 'schoolId'>, userId: unknown) {
  if (!userId || inTransaction()) return;
  await AccountToken.deleteMany(scope(ctx, { userId }));
  await User.deleteOne(scope(ctx, { _id: userId }));
}

/**
 * Creates (or rotates) a single-use token. Any earlier unused token of the same purpose is
 * invalidated, so only the most recently shared link works.
 */
export async function issueAccountToken(
  ctx: Pick<SchoolContext, 'schoolId'> & Partial<Pick<SchoolContext, 'userId'>>,
  userId: Types.ObjectId | string,
  purpose: 'activation' | 'password_reset',
) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt =
    purpose === 'activation'
      ? new Date(Date.now() + ACTIVATION_TTL_DAYS * 86_400_000)
      : new Date(Date.now() + RESET_TTL_HOURS * 3_600_000);
  await AccountToken.updateMany(scope(ctx, { userId: oid(userId), purpose, usedAt: null }), {
    $set: { usedAt: new Date(), expiresAt: new Date() },
  });
  await AccountToken.create({
    schoolId: ctx.schoolId,
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt,
    createdBy: ctx.userId,
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

const invalidToken = () =>
  new AppError(400, 'INVALID_TOKEN', 'This link is invalid or has expired. Ask the school office for a new one.');

async function loadToken(token: string) {
  if (!token || token.length < 20 || token.length > 200) throw invalidToken();
  const doc = await AccountToken.findOne({ tokenHash: sha256(token) })
    .setOptions({ crossTenant: true })
    .lean();
  if (!doc || doc.usedAt || doc.expiresAt.getTime() < Date.now()) throw invalidToken();
  const user = await User.findOne({ _id: doc.userId, schoolId: doc.schoolId })
    .select('name email username role status schoolId')
    .lean();
  if (!user || user.status === 'disabled' || user.status === 'suspended' || isRetiredRole(user.role))
    throw invalidToken();
  return { doc, user };
}

/** Public: what the activation/reset page shows before the password is chosen. */
export async function inspectAccountToken(token: string) {
  const { doc, user } = await loadToken(token);
  const { School } = await import('../schools/school.model');
  const school = await School.findById(user.schoolId).select('name code status').lean();
  if (!school || school.status !== 'active') throw invalidToken();
  return {
    purpose: doc.purpose,
    name: user.name,
    loginId: user.email ?? user.username ?? '',
    username: user.username ?? null,
    email: user.email ?? null,
    school: { name: school.name, code: school.code },
    expiresAt: doc.expiresAt.toISOString(),
  };
}

/** Public: consume a token and set the password. Atomic claim prevents double use. */
export async function redeemAccountToken(token: string, password: string, meta: { ip?: string; requestId?: string }) {
  const { doc, user } = await loadToken(token);
  const claimed = await AccountToken.findOneAndUpdate(
    { _id: doc._id, schoolId: doc.schoolId, usedAt: null },
    { $set: { usedAt: new Date() } },
  ).lean();
  if (!claimed) throw invalidToken();
  const set: Record<string, unknown> = {
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    failedLoginCount: 0,
  };
  if (user.status === 'pending') {
    set.status = 'active';
    set.activatedAt = new Date();
  }
  await User.updateOne(
    { _id: user._id, schoolId: doc.schoolId },
    { $set: set, $unset: { lockUntil: 1 }, $inc: { tokenVersion: 1 } },
  );
  await revokeAllForSubject('user', user._id.toString(), doc.purpose === 'activation' ? 'activated' : 'password_reset');
  await audit(
    { kind: 'system', schoolId: doc.schoolId.toString(), label: `account:${user._id.toString()}` },
    {
      action: doc.purpose === 'activation' ? 'user.activated' : 'user.password_reset_completed',
      entityType: 'User',
      entityId: user._id,
      metadata: { ip: meta.ip, requestId: meta.requestId },
    },
  );
  return { loginId: user.email ?? user.username ?? '', role: user.role };
}

export async function listUsers(
  ctx: SchoolContext,
  q: {
    page: number;
    limit: number;
    role?: SchoolRole;
    status?: string;
    q?: string;
    archived?: 'exclude' | 'only' | 'include';
  },
) {
  // Retired logins (old student accounts) are history only and never listed.
  const filter: Record<string, unknown> = scope(ctx, { role: q.role ?? { $nin: RETIRED_SCHOOL_ROLES } });
  // Archived accounts (people who have left) are hidden unless asked for.
  const archived = q.archived ?? 'exclude';
  if (archived === 'exclude') filter.archivedAt = null;
  else if (archived === 'only') filter.archivedAt = { $ne: null };
  if (q.status) filter.status = q.status;
  const match = textSearchFilter(q.q, ['name'], ['email', 'username']);
  if (match) filter.$or = match.$or;
  return paginate(User, filter, {
    page: q.page,
    limit: q.limit,
    select: USER_PUBLIC_FIELDS,
    sort: { name: 1 },
    populate: { path: 'customRoleId', select: 'name' },
  });
}

export async function getUser(ctx: SchoolContext, id: string) {
  return findUser(ctx, id, USER_PUBLIC_FIELDS);
}

/** A login this user may manage: in this school, not retired, and a role they can grant. */
export async function findUserForManagement(ctx: SchoolContext, id: string) {
  const target = await findUser(ctx, id);
  assertCanGrant(ctx, target.role as SchoolRole);
  return target;
}

/** A login in this school. Retired logins (old student accounts) are treated as not found. */
async function findUser(ctx: SchoolContext, id: string, select?: string) {
  const user = await findOwned(User, ctx, id, 'User', select);
  if (isRetiredRole(user.role)) throw userNotFound();
  return user;
}

export async function updateUser(
  ctx: SchoolContext,
  id: string,
  input: Partial<{
    name: string;
    phone: string;
    role: SchoolRole;
    status: 'active' | 'suspended' | 'disabled';
    statusReason: string;
    campusIds: string[];
    customRoleId: string | null;
  }>,
) {
  const target = await findUser(ctx, id);
  assertCanGrant(ctx, target.role as SchoolRole);
  const isSelf = target._id.toString() === ctx.userId;
  if (input.role) {
    assertCanGrant(ctx, input.role);
    if (STAFF_ROLES.has(target.role as SchoolRole) !== STAFF_ROLES.has(input.role)) {
      throw badRequest('Cannot convert between staff and parent accounts');
    }
  }
  if (isSelf && (input.status !== undefined || input.role || input.customRoleId !== undefined)) {
    throw badRequest('You cannot change your own role, permissions or account status');
  }
  const nextRole = (input.role ?? target.role) as SchoolRole;
  if (input.customRoleId !== undefined || input.role) {
    const nextCustom = input.customRoleId === undefined ? target.customRoleId?.toString() : input.customRoleId;
    await assertCustomRole(ctx, nextRole, nextRole === 'staff' ? nextCustom : null);
  }
  if (input.status === 'active' && target.status === 'pending')
    throw badRequest('Pending accounts become active when the person opens their activation link');
  if (input.status === 'active' && target.archivedAt)
    throw conflict('Restore this account from the archive first', undefined, 'ARCHIVED');
  // Suspending, disabling or demoting an Admin must leave the school with an active Admin.
  if ((input.status && input.status !== 'active') || (input.role && input.role !== target.role))
    await assertAdminRemains(ctx, target);
  if (input.status === 'active' && target.status !== 'active' && STAFF_ROLES.has(target.role as SchoolRole))
    await assertStaffLimit(ctx);
  if (input.campusIds?.length) await assertManyRefs(ctx, Campus, input.campusIds, 'campus');

  const set: Record<string, unknown> = { ...input };
  const unset: Record<string, 1> = {};
  if (nextRole !== 'staff' && target.customRoleId) unset.customRoleId = 1;
  if (input.customRoleId === null) {
    delete set.customRoleId;
    unset.customRoleId = 1;
  }
  if (input.status === 'active') unset.statusReason = 1;
  const blocking = input.status === 'disabled' || input.status === 'suspended';
  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length) update.$unset = unset;
  // Role or status change invalidates existing sessions immediately.
  if (input.role || blocking) update.$inc = { tokenVersion: 1 };
  const updated = await User.findOneAndUpdate(scope(ctx, { _id: target._id }), update, {
    returnDocument: 'after',
    runValidators: true,
  })
    .select(USER_PUBLIC_FIELDS)
    .lean();
  if (input.role || blocking) await revokeAllForSubject('user', target._id.toString(), 'account_changed');
  await audit(ctx, {
    action: input.status && input.status !== target.status ? `user.status_${input.status}` : 'user.update',
    entityType: 'User',
    entityId: target._id,
    metadata: {
      fields: Object.keys(input),
      ...(input.role ? { fromRole: target.role, toRole: input.role } : {}),
      ...(input.customRoleId !== undefined ? { customRoleId: input.customRoleId } : {}),
    },
  });
  return updated;
}

/**
 * Correct the sign-in email (or username) of a login, e.g. when it was mistyped at admission.
 * Works for pending and active accounts: a pending account's activation link keeps working,
 * and an active user signs in with the new email from now on. The linked staff/parent record's
 * contact email is updated too when it held the old address.
 */
export async function changeSignIn(
  ctx: SchoolContext,
  id: string,
  input: { email?: string | null; username?: string | null },
) {
  const target = await findUser(ctx, id);
  assertCanGrant(ctx, target.role as SchoolRole);
  const nextEmail = input.email === undefined ? (target.email ?? null) : input.email ? input.email.toLowerCase() : null;
  const nextUsername =
    input.username === undefined
      ? (target.username ?? null)
      : input.username
        ? normaliseUsername(input.username)
        : null;
  if (!nextEmail && !nextUsername) throw badRequest('An account needs an email or a username to sign in with');
  if (nextEmail && nextEmail !== target.email) {
    if (await User.exists(scope(ctx, { email: nextEmail, _id: { $ne: target._id } })))
      throw conflict('Another account in this school already uses this email', { field: 'email' }, 'DUPLICATE');
  }
  if (nextUsername && nextUsername !== target.username) {
    if (await User.exists(scope(ctx, { username: nextUsername, _id: { $ne: target._id } })))
      throw conflict('This username is already taken', { field: 'username' }, 'DUPLICATE');
  }
  if (nextEmail === (target.email ?? null) && nextUsername === (target.username ?? null)) {
    return User.findOne(scope(ctx, { _id: target._id }))
      .select(USER_PUBLIC_FIELDS)
      .lean();
  }
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (nextEmail) set.email = nextEmail;
  else unset.email = 1;
  if (nextUsername) set.username = nextUsername;
  else unset.username = 1;
  const updated = await User.findOneAndUpdate(
    scope(ctx, { _id: target._id }),
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { returnDocument: 'after', runValidators: true },
  )
    .select(USER_PUBLIC_FIELDS)
    .lean()
    .catch((err) => {
      if (err?.code === 11000) throw duplicateLoginError(err);
      throw err;
    });
  // Keep the staff/parent contact email in step when it was the same (mistyped) address.
  if (target.email && nextEmail !== target.email) {
    if (target.employeeId)
      await Employee.updateOne(scope(ctx, { _id: target.employeeId, email: target.email }), {
        ...(nextEmail ? { $set: { email: nextEmail } } : { $unset: { email: 1 } }),
      });
    if (target.parentId)
      await Parent.updateOne(scope(ctx, { _id: target.parentId, email: target.email }), {
        ...(nextEmail ? { $set: { email: nextEmail } } : { $unset: { email: 1 } }),
      });
  }
  await audit(ctx, {
    action: 'user.sign_in_changed',
    entityType: 'User',
    entityId: target._id,
    metadata: {
      ...(nextEmail !== (target.email ?? null) ? { fromEmail: target.email ?? null, toEmail: nextEmail } : {}),
      ...(nextUsername !== (target.username ?? null)
        ? { fromUsername: target.username ?? null, toUsername: nextUsername }
        : {}),
    },
  });
  return updated;
}

export async function resetUserPassword(ctx: SchoolContext, id: string) {
  const target = await findUser(ctx, id);
  assertCanGrant(ctx, target.role as SchoolRole);
  if (target._id.toString() === ctx.userId) throw badRequest('Use “Change password” for your own account');
  const temporaryPassword = generateTempPassword();
  await User.updateOne(scope(ctx, { _id: target._id }), {
    $set: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedLoginCount: 0,
      ...(target.status === 'pending' ? { status: 'active', activatedAt: new Date() } : {}),
    },
    $unset: { lockUntil: 1 },
    $inc: { tokenVersion: 1 },
  });
  await revokeAllForSubject('user', target._id.toString(), 'password_reset');
  await audit(ctx, { action: 'user.password_reset', entityType: 'User', entityId: target._id });
  return { temporaryPassword };
}

/**
 * New single-use link for the account holder: an activation link for pending accounts, a
 * password-reset link otherwise. The previous link of the same kind stops working.
 */
export async function issueAccessLink(ctx: SchoolContext, id: string) {
  const target = await findUser(ctx, id);
  assertCanGrant(ctx, target.role as SchoolRole);
  if (target._id.toString() === ctx.userId) throw badRequest('Use “Change password” for your own account');
  if (target.status === 'disabled' || target.status === 'suspended')
    throw conflict('Reactivate the account before sending a new link');
  const purpose = target.status === 'pending' ? 'activation' : 'password_reset';
  const link = await issueAccountToken(ctx, target._id, purpose);
  await audit(ctx, { action: `user.${purpose}_link_issued`, entityType: 'User', entityId: target._id });
  return { purpose, ...link };
}

// ─────────────────────────── Custom roles ───────────────────────────

export async function listStaffRoles(ctx: SchoolContext) {
  const roles = await StaffRole.find(scope(ctx)).sort({ name: 1 }).lean();
  const counts = await User.aggregate([
    { $match: scope(ctx, { customRoleId: { $in: roles.map((r) => r._id) } }) },
    { $group: { _id: '$customRoleId', count: { $sum: 1 } } },
  ]);
  const byRole = new Map(counts.map((c) => [String(c._id), c.count as number]));
  return roles.map((r) => ({ ...r, userCount: byRole.get(r._id.toString()) ?? 0 }));
}

function cleanPermissions(perms: Permission[]): Permission[] {
  const p = [...new Set(perms)];
  const blocked = p.filter((x) => NON_DELEGABLE_PERMISSIONS.has(x));
  if (blocked.length) throw forbidden(`These permissions cannot be delegated: ${blocked.join(', ')}`);
  return p;
}

export async function createStaffRole(
  ctx: SchoolContext,
  input: { name: string; description?: string; permissions: Permission[] },
) {
  const permissions = cleanPermissions(input.permissions);
  const role = await StaffRole.create({
    ...input,
    permissions,
    schoolId: ctx.schoolId,
    createdBy: ctx.userId,
  }).catch((err) => {
    if (err?.code === 11000) throw conflict('A role with this name already exists', undefined, 'DUPLICATE');
    throw err;
  });
  await audit(ctx, {
    action: 'role.create',
    entityType: 'StaffRole',
    entityId: role._id,
    summary: input.name,
    metadata: { permissions },
  });
  return { ...role.toObject(), userCount: 0 };
}

export async function updateStaffRole(
  ctx: SchoolContext,
  id: string,
  input: Partial<{ name: string; description: string; permissions: Permission[] }>,
) {
  const existing = await findOwned(StaffRole, ctx, id, 'Role');
  const set: Record<string, unknown> = { ...input, updatedBy: oid(ctx.userId) };
  if (input.permissions) set.permissions = cleanPermissions(input.permissions);
  const updated = await StaffRole.findOneAndUpdate(
    scope(ctx, { _id: existing._id }),
    { $set: set },
    { returnDocument: 'after', runValidators: true },
  )
    .lean()
    .catch((err) => {
      if (err?.code === 11000) throw conflict('A role with this name already exists', undefined, 'DUPLICATE');
      throw err;
    });
  const before = new Set<string>(existing.permissions ?? []);
  const after = new Set<string>((set.permissions as string[] | undefined) ?? existing.permissions ?? []);
  await audit(ctx, {
    action: 'role.update',
    entityType: 'StaffRole',
    entityId: existing._id,
    summary: updated?.name ?? undefined,
    metadata: {
      granted: [...after].filter((p) => !before.has(p)),
      revoked: [...before].filter((p) => !after.has(p)),
    },
  });
  const userCount = await User.countDocuments(scope(ctx, { customRoleId: existing._id }));
  return { ...updated, userCount };
}

export async function deleteStaffRole(ctx: SchoolContext, id: string) {
  const existing = await findOwned(StaffRole, ctx, id, 'Role');
  if (await User.exists(scope(ctx, { customRoleId: existing._id })))
    throw conflict('Move the accounts using this role to another role before deleting it');
  await StaffRole.deleteOne(scope(ctx, { _id: existing._id }));
  await audit(ctx, { action: 'role.delete', entityType: 'StaffRole', entityId: existing._id, summary: existing.name });
}

// ───────────────────── Automatic provisioning helpers ─────────────────────

export interface ProvisionedAccount {
  role: SchoolRole;
  userId: string;
  name: string;
  loginId: string;
  status: UserStatus;
  created: boolean;
  activation?: { token: string; expiresAt: string };
}

function summarise(r: ProvisionResult, created: boolean): ProvisionedAccount {
  const u = r.user as {
    _id: unknown;
    role: SchoolRole;
    name: string;
    email?: string;
    username?: string;
    status: UserStatus;
  };
  return {
    role: u.role,
    userId: String(u._id),
    name: u.name,
    loginId: u.email ?? u.username ?? '',
    status: u.status,
    created,
    activation: r.activation,
  };
}

/** Provision a teacher/staff login for an employee. Idempotent: returns the existing login. */
export async function provisionEmployeeAccount(
  ctx: SchoolContext,
  employeeId: string,
  opts: { role?: SchoolRole; customRoleId?: string; provisionedBy?: CreateUserInput['provisionedBy'] } = {},
): Promise<ProvisionedAccount> {
  const emp = await findOwned(Employee, ctx, employeeId, 'Employee');
  const existing = await User.findOne(scope(ctx, { employeeId: emp._id }))
    .select(USER_PUBLIC_FIELDS)
    .lean();
  if (existing) return summarise({ user: existing as Record<string, unknown> }, false);
  if (['resigned', 'terminated'].includes(emp.status)) throw conflict('This staff member has left the school');
  const role = opts.role ?? (emp.staffType === 'teaching' ? 'teacher' : 'staff');
  if (!STAFF_ROLES.has(role) || role === 'school_owner') throw badRequest('Choose a staff role for this account');
  const email = (await emailAvailable(ctx, emp.email)) ? emp.email! : undefined;
  const result = await createUser(ctx, {
    name: `${emp.firstName} ${emp.lastName ?? ''}`.trim(),
    email,
    username: await uniqueUsername(ctx, emp.employeeNo),
    phone: emp.phone ?? undefined,
    role,
    customRoleId: opts.customRoleId,
    credential: 'activation_link',
    employeeId: emp._id.toString(),
    campusIds: role === 'teacher' ? [] : undefined,
    provisionedBy: opts.provisionedBy ?? 'staff_registration',
  });
  return summarise(result, true);
}

/**
 * Provision the parent login for a guardian record. One parent account covers all of their
 * children: if the parent already has a login it is reused, never duplicated.
 */
export async function provisionParentAccount(
  ctx: SchoolContext,
  parentId: string,
  opts: { provisionedBy?: CreateUserInput['provisionedBy'] } = {},
): Promise<ProvisionedAccount> {
  const parent = await findOwned(Parent, ctx, parentId, 'Parent');
  const existing = await User.findOne(scope(ctx, { parentId: parent._id }))
    .select(USER_PUBLIC_FIELDS)
    .lean();
  if (existing) return summarise({ user: existing as Record<string, unknown> }, false);
  const email = (await emailAvailable(ctx, parent.email)) ? parent.email! : undefined;
  const result = await createUser(ctx, {
    name: parent.name,
    email,
    username: await uniqueUsername(ctx, normalisePhoneUsername(parent.phone)),
    phone: parent.phone,
    role: 'parent',
    credential: 'activation_link',
    parentId: parent._id.toString(),
    provisionedBy: opts.provisionedBy ?? 'admission',
  });
  return summarise(result, true);
}

/** Where a login exists for a record: used by UIs to show "Account: pending / active". */
export async function accountFor(ctx: SchoolContext, field: 'employeeId' | 'parentId', id: Types.ObjectId | string) {
  const u = await User.findOne(scope(ctx, { [field]: oid(id) }))
    .select('_id name email username role status lastLoginAt activatedAt')
    .lean();
  if (!u) return null;
  return {
    userId: u._id,
    loginId: u.email ?? u.username ?? '',
    email: u.email ?? undefined,
    username: u.username ?? undefined,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt ?? null,
  };
}

export const userNotFound = () => notFound('User');
