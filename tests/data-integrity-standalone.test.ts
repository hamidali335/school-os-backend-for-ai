import { describe, expect, it, vi } from 'vitest';
import { assertSupportedTopology, mongoTopology, transactionsSupported } from '../src/database/transactions';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { recordPayment } from '../src/modules/fees/fees.service';
import { User } from '../src/modules/users/user.model';
import { crashAtCheckpoint } from './fault/crash';
import { api, buildSchool } from './fixtures';
import { useTestApp } from './helpers';

/**
 * Evidence for the documented limitation of a STANDALONE MongoDB server, and for the startup
 * gate that keeps production off it. Compare tests/data-integrity.replset.test.ts, where the
 * same crash leaves no trace.
 */
const t = useTestApp();

describe('Standalone MongoDB (no transactions)', () => {
  it('is detected as standalone', () => {
    expect(mongoTopology()).toBe('standalone');
    expect(transactionsSupported()).toBe(false);
  });

  it('compensates invoice balance when payment creation fails on standalone', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    const [inv] = await api(t.app, s.accountantToken, 'get', '/fees/invoices?period=2026-09');
    const initialBalance = inv.balance;

    const spy = vi.spyOn(Payment, 'create').mockImplementationOnce(() => {
      throw new Error('Simulated payment write failure on standalone');
    });

    const ctx = {
      schoolId: s.schoolId,
      campusIds: [],
      userId: s.accountantId,
      name: 'Accountant',
      role: 'accountant',
    } as any;

    await expect(
      recordPayment(ctx, inv._id, {
        amount: 500,
        method: 'cash',
        idempotencyKey: 'fail-compensation-test-1',
      }),
    ).rejects.toThrow('Simulated payment write failure on standalone');

    spy.mockRestore();

    const after = await Invoice.findOne({ schoolId: s.schoolId, _id: inv._id }).lean();
    expect(after!.balance).toBe(initialBalance);
    expect(after!.paid).toBe(0);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId: inv._id })).toBe(0);
  });

  it('LIMITATION: a process killed between the balance update and the payment write leaves the balance reduced with no payment', async () => {
    const s = await buildSchool(t.app, { students: 1 });
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    const [inv] = await api(t.app, s.accountantToken, 'get', '/fees/invoices?period=2026-09');
    const owner = await User.findOne({ schoolId: s.schoolId, role: 'school_owner' }).lean();
    await crashAtCheckpoint('payment', {
      schoolId: s.schoolId,
      userId: owner!._id.toString(),
      invoiceId: inv._id,
      amount: 700,
      idempotencyKey: 'standalone-crash',
    });
    const after = await Invoice.findOne({ schoolId: s.schoolId, _id: inv._id }).lean();
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId: inv._id })).toBe(0);
    // This drift is why production requires a replica set (or an explicit, documented opt-out).
    expect(inv.balance - after!.balance).toBe(700);
  }, 60_000);

  it('production refuses to start on standalone unless explicitly allowed (all 4 cases)', () => {
    // Case 1: replicaSet in production (passes)
    expect(() => assertSupportedTopology({ production: true, allowStandalone: false }, 'replicaSet')).not.toThrow();

    // Case 2: sharded in production (passes)
    expect(() => assertSupportedTopology({ production: true, allowStandalone: false }, 'sharded')).not.toThrow();

    // Case 3: standalone in production with override (passes)
    expect(() => assertSupportedTopology({ production: true, allowStandalone: true }, 'standalone')).not.toThrow();

    // Case 4: standalone in production without override (throws)
    expect(() => assertSupportedTopology({ production: true, allowStandalone: false }, 'standalone')).toThrow(
      /replica set/,
    );

    // Non-production standalone
    expect(() => assertSupportedTopology({ production: false, allowStandalone: false }, 'standalone')).not.toThrow();
  });
});
