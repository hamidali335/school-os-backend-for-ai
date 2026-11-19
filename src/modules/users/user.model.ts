import { model, Schema } from 'mongoose';
import { PERMISSIONS, STORED_SCHOOL_ROLES } from '../../config/permissions';
import { ObjectId, baseOptions, tenantField, withTenant } from '../../database/schema-helpers';

/**
 * Account lifecycle:
 * - `pending`   created automatically (teacher, parent); no usable password until the
 *               person opens their activation link and chooses one.
 * - `active`    can sign in.
 * - `suspended` temporarily blocked (e.g. staff on long leave); sessions are revoked.
 * - `disabled`  permanently blocked (left the school); sessions are revoked.
 */
export const USER_STATUSES = ['pending', 'active', 'suspended', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const UserSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      // Optional for parents, who usually sign in with a username (their phone number).
      email: { type: String, trim: true, lowercase: true },
      /** Alternative sign-in identifier, unique per school (lower-case). */
      username: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      passwordHash: { type: String, required: true, select: false },
      // Includes retired roles so historical documents (e.g. old student logins) still validate.
      role: { type: String, enum: STORED_SCHOOL_ROLES, required: true, index: true },
      /** Custom role (staff accounts only) that supplies the account's permissions. */
      customRoleId: { type: ObjectId, ref: 'StaffRole' },
      status: { type: String, enum: USER_STATUSES, default: 'active' },
      statusReason: { type: String },
      /** Status to restore when the linked student/staff record is taken out of the archive. */
      statusBeforeArchive: { type: String, enum: USER_STATUSES },
      /** Set when the person has left: hidden from the normal user list, kept for history. */
      archivedAt: { type: Date },
      archivedReason: { type: String },
      campusIds: { type: [ObjectId], ref: 'Campus', default: [] },
      employeeId: { type: ObjectId, ref: 'Employee' },
      parentId: { type: ObjectId, ref: 'Parent' },
      /** Only on retired student logins (kept for history); new logins never link a student. */
      studentId: { type: ObjectId, ref: 'Student' },
      /** How the account came to exist (audit/UX only). */
      provisionedBy: { type: String, enum: ['manual', 'staff_registration', 'admission', 'onboarding'] },
      activatedAt: { type: Date },
      mustChangePassword: { type: Boolean, default: false },
      tokenVersion: { type: Number, default: 0 },
      failedLoginCount: { type: Number, default: 0, select: false },
      lockUntil: { type: Date, select: false },
      lastLoginAt: { type: Date },
    },
    baseOptions,
  ),
);
UserSchema.pre('validate', function requireIdentifier() {
  if (!this.email && !this.username) this.invalidate('email', 'An account needs an email or a username');
});
// Partial unique indexes: accounts without an email (or username) do not collide with each other.
UserSchema.index(
  { schoolId: 1, email: 1 },
  { unique: true, name: 'school_email_unique', partialFilterExpression: { email: { $type: 'string' } } },
);
UserSchema.index(
  { schoolId: 1, username: 1 },
  { unique: true, name: 'school_username_unique', partialFilterExpression: { username: { $type: 'string' } } },
);
// One login per staff / parent / student record, even under concurrent or repeated requests.
UserSchema.index(
  { schoolId: 1, employeeId: 1 },
  {
    unique: true,
    name: 'school_employee_login_unique',
    partialFilterExpression: { employeeId: { $type: 'objectId' } },
  },
);
UserSchema.index(
  { schoolId: 1, parentId: 1 },
  { unique: true, name: 'school_parent_login_unique', partialFilterExpression: { parentId: { $type: 'objectId' } } },
);
UserSchema.index(
  { schoolId: 1, studentId: 1 },
  { unique: true, name: 'school_student_login_unique', partialFilterExpression: { studentId: { $type: 'objectId' } } },
);
// Login looks a user up by email or username before the school is known.
UserSchema.index({ email: 1 });
UserSchema.index({ username: 1 });

export const User = model('User', UserSchema);

/** Fields safe to return to API clients. */
export const USER_PUBLIC_FIELDS =
  '_id schoolId name email username phone role customRoleId status statusReason archivedAt archivedReason campusIds employeeId parentId studentId provisionedBy activatedAt mustChangePassword lastLoginAt createdAt updatedAt';

/**
 * A school-defined role for administrative staff (e.g. Receptionist). Its permissions are the
 * only privileges a `staff` account receives beyond the minimal base set.
 */
const StaffRoleSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      name: { type: String, required: true, trim: true },
      description: { type: String, trim: true },
      permissions: { type: [{ type: String, enum: PERMISSIONS }], default: [] },
      createdBy: { type: ObjectId, ref: 'User' },
      updatedBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
StaffRoleSchema.index({ schoolId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const StaffRole = model('StaffRole', StaffRoleSchema);

/**
 * Single-use, expiring token for account activation or password reset. Only a SHA-256 hash is
 * stored; the raw token is handed to the administrator once to share with the account holder.
 */
const AccountTokenSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      userId: { type: ObjectId, ref: 'User', required: true },
      purpose: { type: String, enum: ['activation', 'password_reset'], required: true },
      tokenHash: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      usedAt: { type: Date },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
AccountTokenSchema.index({ tokenHash: 1 }, { unique: true });
AccountTokenSchema.index({ schoolId: 1, userId: 1, purpose: 1 });
// Expired tokens are useless; let MongoDB remove them a day after expiry.
AccountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
export const AccountToken = model('AccountToken', AccountTokenSchema);
