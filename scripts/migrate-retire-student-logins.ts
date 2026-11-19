/**
 * Retires separate student logins. Parents now use the parent portal for everything about
 * their children, so students no longer get an account. Safe to re-run.
 *
 *   npm run migrate:retire-student-logins            # dry run: report only, changes nothing
 *   npm run migrate:retire-student-logins -- --apply # apply
 *
 * For every user with role "student", in every school:
 * - status becomes `disabled` with a clear reason, and `tokenVersion` is bumped, so any signed-in
 *   session stops working immediately; refresh tokens are revoked;
 * - unused activation / password-reset links are invalidated;
 * - the student record's `userId` pointer is cleared (nothing treats it as a live login).
 *
 * Nothing is deleted: the user document (name, sign-in ID, studentId link, timestamps) stays
 * for audit history, and the student record with all academic data is untouched. Parent
 * logins are not changed. A retired login that tries to sign in with its correct password is
 * told to use the parent's account.
 */
import mongoose from 'mongoose';
import '../src/app';
import { connectDatabase } from '../src/database/connection';
import { AuditLog } from '../src/modules/audit/audit.model';
import { revokeAllForSubject } from '../src/modules/auth/tokens';
import { Student } from '../src/modules/students/student.models';
import { AccountToken, User } from '../src/modules/users/user.model';

const X = { crossTenant: true } as const;
export const RETIRED_REASON = 'Student accounts retired: the parent account gives access to this student';

export async function retireStudentLogins(apply: boolean) {
  const users = await User.find({ role: 'student' })
    .setOptions(X)
    .select('_id schoolId name email username status statusReason studentId lastLoginAt activatedAt')
    .lean();
  const todo = users.filter((u) => u.status !== 'disabled' || u.statusReason !== RETIRED_REASON);
  const bySchool = new Map<string, { total: number; toRetire: number; everUsed: number }>();
  for (const u of users) {
    const k = String(u.schoolId);
    const row = bySchool.get(k) ?? { total: 0, toRetire: 0, everUsed: 0 };
    row.total++;
    if (todo.includes(u)) row.toRetire++;
    if (u.lastLoginAt || u.activatedAt) row.everUsed++;
    bySchool.set(k, row);
  }
  let retired = 0;
  if (apply) {
    for (const u of todo) {
      await User.updateOne(
        { _id: u._id, schoolId: u.schoolId },
        { $set: { status: 'disabled', statusReason: RETIRED_REASON }, $inc: { tokenVersion: 1 } },
      );
      await revokeAllForSubject('user', u._id.toString(), 'student_login_retired');
      await AccountToken.updateMany(
        { schoolId: u.schoolId, userId: u._id, usedAt: null },
        { $set: { usedAt: new Date(), expiresAt: new Date() } },
      );
      if (u.studentId)
        await Student.updateOne({ _id: u.studentId, schoolId: u.schoolId, userId: u._id }, { $unset: { userId: 1 } });
      await AuditLog.create({
        schoolId: u.schoolId,
        actorType: 'system',
        actorName: 'migration:retire-student-logins',
        action: 'user.student_login_retired',
        entityType: 'User',
        entityId: u._id.toString(),
        summary: `${u.name} (${u.email ?? u.username ?? 'no sign-in ID'})`,
        metadata: {
          previousStatus: u.status,
          studentId: u.studentId,
          everUsed: Boolean(u.lastLoginAt || u.activatedAt),
        },
      });
      retired++;
    }
  }
  return { total: users.length, toRetire: todo.length, retired, bySchool };
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDatabase();
  console.log(apply ? 'Retiring student logins…' : 'Dry run (use --apply to change data)…');
  const r = await retireStudentLogins(apply);
  for (const [schoolId, row] of r.bySchool)
    console.log(
      `  school ${schoolId}: ${row.total} student login(s), ${row.everUsed} ever used, ${row.toRetire} to retire`,
    );
  console.log(
    `  Total: ${r.total} student login(s); ${r.toRetire} need retiring` + (apply ? `; retired now: ${r.retired}` : ''),
  );
  console.log('  Student records, academic data and parent logins are not changed.');
}

if (require.main === module)
  main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(err);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
