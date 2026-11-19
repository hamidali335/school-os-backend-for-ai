/**
 * Academic Session Lifecycle Phase 1: Migration script to backfill StudentEnrollment records.
 *
 * Creates historical session enrollments for existing students based on their current placement.
 * Safe and idempotent: can be run repeatedly without duplicating or corrupting data.
 *
 * Usage:
 *   npm run migrate:session-enrollments            # Dry-run: report only, changes nothing
 *   npm run migrate:session-enrollments -- --apply # Apply migration to database
 */
import mongoose from 'mongoose';
import '../src/app';
import { connectDatabase } from '../src/database/connection';
import { Student, StudentEnrollment } from '../src/modules/students/student.models';

const X = { crossTenant: true } as const;

export interface MigrationSummary {
  totalStudents: number;
  alreadyEnrolled: number;
  created: number;
  skipped: number;
  unmapped: Array<{ studentId: string; admissionNo: string; schoolId: string; reason: string }>;
}

export async function migrateSessionEnrollments(apply: boolean): Promise<MigrationSummary> {
  const [students, existingEnrollments] = await Promise.all([
    Student.find({})
      .setOptions(X)
      .select('_id schoolId campusId admissionNo rollNo sessionId classId sectionId status statusChangedAt leavingReason admissionDate createdAt')
      .lean(),
    StudentEnrollment.find({})
      .setOptions(X)
      .select('studentId sessionId')
      .lean(),
  ]);

  const existingKeys = new Set(
    existingEnrollments.map((e) => `${String(e.studentId)}:${String(e.sessionId)}`),
  );

  const summary: MigrationSummary = {
    totalStudents: students.length,
    alreadyEnrolled: 0,
    created: 0,
    skipped: 0,
    unmapped: [],
  };

  const toCreate: Array<Record<string, unknown>> = [];

  for (const st of students) {
    if (!st.sessionId || !st.classId || !st.sectionId) {
      summary.skipped++;
      summary.unmapped.push({
        studentId: String(st._id),
        admissionNo: st.admissionNo,
        schoolId: String(st.schoolId),
        reason: 'Missing sessionId, classId, or sectionId',
      });
      continue;
    }

    const key = `${String(st._id)}:${String(st.sessionId)}`;
    if (existingKeys.has(key)) {
      summary.alreadyEnrolled++;
      continue;
    }

    summary.created++;
    existingKeys.add(key);

    toCreate.push({
      schoolId: st.schoolId,
      studentId: st._id,
      sessionId: st.sessionId,
      classId: st.classId,
      sectionId: st.sectionId,
      campusId: st.campusId,
      rollNo: st.rollNo,
      enrollmentDate: st.admissionDate ?? st.createdAt ?? new Date(),
      status: st.status === 'active' ? 'active' : (st.status as any),
      statusChangedAt: st.statusChangedAt,
      statusReason: st.leavingReason,
    });
  }

  if (apply && toCreate.length > 0) {
    await StudentEnrollment.insertMany(toCreate, { ordered: false });
  }

  return summary;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDatabase();
  console.log(apply ? '=== Applying Session Enrollments Migration ===' : '=== DRY RUN: Session Enrollments Migration ===');

  const summary = await migrateSessionEnrollments(apply);

  console.log(`Total students inspected:   ${summary.totalStudents}`);
  console.log(`Already enrolled:           ${summary.alreadyEnrolled}`);
  console.log(`${apply ? 'Enrollments created:' : 'Enrollments to create:'}      ${summary.created}`);
  console.log(`Skipped / unmapped:         ${summary.skipped}`);

  if (summary.unmapped.length > 0) {
    console.log('\nUnmapped records:');
    for (const u of summary.unmapped) {
      console.log(`  - Student ${u.admissionNo} (${u.studentId}) in school ${u.schoolId}: ${u.reason}`);
    }
  }

  if (!apply && summary.created > 0) {
    console.log('\nRun with --apply to write these enrollments.');
  }

  return 0;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await mongoose.disconnect();
      process.exit(code ?? 0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
}
