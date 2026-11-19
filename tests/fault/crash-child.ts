/**
 * Fault-injection child process for crash tests (tests/*crash*.test.ts). Never run by hand.
 *
 * Runs one real workflow against the test database given in MONGODB_URI, stops at a checkpoint
 * between two of its database writes, prints "CHECKPOINT" and waits forever. The parent test
 * then kills this process (a hard kill: no cleanup, no error handlers) and inspects the data.
 *
 *   argv: <scenario> <json args>
 */
import mongoose from 'mongoose';
import { ROLE_PERMISSIONS } from '../../src/config/permissions';
import { connectDatabase } from '../../src/database/connection';
import type { SchoolContext } from '../../src/types/context';

if (!process.env.MONGODB_URI?.includes('schoolos_test_'))
  throw new Error('crash-child only runs against test databases');

const hang = (): Promise<never> => {
  process.stdout.write('CHECKPOINT\n');
  return new Promise<never>(() => undefined);
};

function ctxFor(schoolId: string, userId: string): SchoolContext {
  return {
    kind: 'school',
    userId,
    schoolId,
    role: 'school_owner',
    name: 'Crash test',
    email: 'crash@example.test',
    campusIds: [],
    permissions: ROLE_PERMISSIONS.school_owner,
    entitlements: new Set(),
    subscriptionEligible: true,
  };
}

async function main() {
  const [scenario, json] = process.argv.slice(2);
  const args = JSON.parse(json ?? '{}');
  await connectDatabase();
  if (scenario === 'payment') {
    // Checkpoint: invoice balance already reduced, payment + receipt not yet written.
    const { Payment } = await import('../../src/modules/fees/fees.models');
    (Payment as any).create = hang;
    const { recordPayment } = await import('../../src/modules/fees/fees.service');
    await recordPayment(ctxFor(args.schoolId, args.userId), args.invoiceId, {
      amount: args.amount,
      method: 'cash',
      idempotencyKey: args.idempotencyKey,
    });
  } else if (scenario === 'onboarding') {
    // Checkpoint: school and campus written, Admin account not yet.
    const { User } = await import('../../src/modules/users/user.model');
    (User as any).create = hang;
    const { onboardSchool } = await import('../../src/modules/schools/schools.service');
    await onboardSchool({
      name: 'Crash School',
      code: args.code,
      owner: { name: 'Crash Admin', email: args.email, password: 'Crash-Test-Pass-1' },
    });
  } else if (scenario === 'admission') {
    // Checkpoint: parent and student written, parent login not yet.
    const { User } = await import('../../src/modules/users/user.model');
    (User as any).create = hang;
    const { createStudent } = await import('../../src/modules/students/students.service');
    await createStudent(ctxFor(args.schoolId, args.userId), args.student);
  } else if (scenario === 'reversal') {
    // Checkpoint: payment marked reversed, invoice balance not yet restored.
    const { Invoice } = await import('../../src/modules/fees/fees.models');
    (Invoice as any).findOneAndUpdate = hang;
    const { decideApproval } = await import('../../src/modules/approvals/approvals.service');
    await import('../../src/modules/approvals/handlers').then((m) => m.registerApprovalHandlers());
    await decideApproval(ctxFor(args.schoolId, args.userId), args.approvalId, 'approve');
  } else throw new Error(`unknown scenario ${scenario}`);
  process.stdout.write('FINISHED\n');
  await mongoose.disconnect();
}

main().catch((err) => {
  process.stdout.write(`ERROR ${err?.message}\n`);
  process.exit(1);
});
