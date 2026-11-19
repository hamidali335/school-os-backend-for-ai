/**
 * One-off data migration for the accounts/permissions/homework release. Safe to re-run.
 *
 *   npm run migrate:2026-10            # dry run: report only, changes nothing
 *   npm run migrate:2026-10 -- --apply # apply the data changes
 *
 * Then run `npm run db:indexes` to switch the users email index to the new partial index and
 * create the new unique "one login per staff/parent/student" indexes.
 *
 * What it does:
 * 1. Reports duplicate logins for the same employee/parent/student. The new unique indexes
 *    cannot be built while duplicates exist; resolve them (disable/merge) before db:indexes.
 * 2. Homework saved without a teacher (the "Teacher: —" bug) is attributed to the current
 *    subject teacher of its section, when one exists (teacherSource = "backfill").
 *    Homework that already has a teacher is never changed.
 */
import mongoose from 'mongoose';
import '../src/app';
import { connectDatabase } from '../src/database/connection';
import { TeachingAssignment } from '../src/modules/academics/academics.models';
import { Homework } from '../src/modules/homework/homework.models';
import { User } from '../src/modules/users/user.model';

const X = { crossTenant: true } as const;

export async function duplicateLogins() {
  let total = 0;
  for (const field of ['employeeId', 'parentId', 'studentId'] as const) {
    const dups = await User.aggregate([
      { $match: { [field]: { $type: 'objectId' } } },
      { $group: { _id: { schoolId: '$schoolId', ref: `$${field}` }, users: { $push: '$_id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]).option(X);
    for (const d of dups)
      console.log(`  DUPLICATE ${field}: school ${d._id.schoolId} ${field}=${d._id.ref} users=${d.users.join(',')}`);
    total += dups.length;
  }
  return total;
}

export async function backfillHomework(apply: boolean) {
  const missing = await Homework.find({ $or: [{ teacherId: { $exists: false } }, { teacherId: null }] })
    .setOptions(X)
    .select('schoolId sectionId subjectId')
    .lean();
  let fixable = 0;
  let updated = 0;
  for (const hw of missing) {
    const ta = await TeachingAssignment.findOne({
      schoolId: hw.schoolId,
      sectionId: hw.sectionId,
      subjectId: hw.subjectId,
    })
      .select('teacherId')
      .lean();
    if (!ta) continue;
    fixable++;
    if (apply) {
      const r = await Homework.updateOne(
        { _id: hw._id, schoolId: hw.schoolId, $or: [{ teacherId: { $exists: false } }, { teacherId: null }] },
        { $set: { teacherId: ta.teacherId, teacherSource: 'backfill' } },
      );
      updated += r.modifiedCount;
    }
  }
  return { missing: missing.length, fixable, updated };
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDatabase();
  console.log(apply ? 'Applying migration…' : 'Dry run (use --apply to change data)…');
  const dups = await duplicateLogins();
  console.log(
    dups
      ? `  ${dups} duplicate login group(s) must be resolved before "npm run db:indexes".`
      : '  No duplicate logins.',
  );
  const hw = await backfillHomework(apply);
  console.log(
    `  Homework without a teacher: ${hw.missing}; can be attributed from current assignments: ${hw.fixable}` +
      (apply ? `; updated: ${hw.updated}` : ''),
  );
  console.log('  Remaining unattributed homework is shown with "No teacher assigned" until a teacher is assigned.');
}

if (require.main === module)
  main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(err);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
