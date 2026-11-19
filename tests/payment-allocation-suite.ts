import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { headBreakdown } from '../src/modules/fees/fee-calc';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

/**
 * Payments recorded at the same moment on one invoice, each saying which fees it settles: a fee
 * line can never be allocated more than is owed on it, the invoice balance always equals total
 * minus the valid payments, and every payment kept has its audit entry. Shared by the standalone
 * (no transactions) and replica-set (transactions) test projects. All data is synthetic.
 */
export function paymentAllocationSuite() {
  const t = useTestApp();
  let s: SchoolFixture;

  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 2 });
  });

  async function invoiceWithTransport(studentIdx: number) {
    const preview = await api(
      t.app,
      s.ownerToken,
      'get',
      `/fees/students/${s.students[studentIdx]}/invoice-preview?period=2026-10`,
    );
    const transport =
      preview.perStudentHeads.find((h: { name: string }) => h.name === 'Transport Fee') ??
      (await api(t.app, s.ownerToken, 'post', '/fees/heads', {
        name: 'Transport Fee',
        code: 'TRANSPORT',
        frequency: 'monthly',
        billing: 'per_student',
      }));
    return api(t.app, s.accountantToken, 'post', `/fees/students/${s.students[studentIdx]}/invoices`, {
      period: '2026-10',
      extraItems: [{ feeHeadId: transport._id, amount: 2500 }],
    });
  }

  /** The invoice, its valid payments and its fee lines, as stored. */
  async function state(invoiceId: string) {
    const invoice = (await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean())!;
    const payments = await Payment.find({ schoolId: s.schoolId, invoiceId, status: 'valid' }).lean();
    return { invoice, payments, lines: headBreakdown(invoice as never, payments as never) };
  }

  describe('Payments recorded at the same moment on one invoice', () => {
    it('two cashiers allocating the same fee: it is never paid twice; balances and audit agree', async () => {
      const inv = await invoiceWithTransport(0);
      const detail = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${inv._id}`);
      const admission = detail.breakdown.find((l: { name: string }) => l.name === 'Admission Fee').line;
      // Five requests at once, each putting Rs 6,000 on the Rs 10,000 admission fee. The invoice
      // balance (Rs 17,500) covers two of them, so only the fee line itself can refuse the second.
      const answers = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(t.app)
            .post(`/api/v1/fees/invoices/${inv._id}/payments`)
            .set(auth(s.accountantToken))
            .send({ amount: 6000, method: 'cash', headAllocations: [{ line: admission, amount: 6000 }] }),
        ),
      );
      const ok = answers.filter((r) => r.status === 201);
      expect(ok, answers.map((r) => `${r.status} ${r.body?.error?.code ?? ''}`).join(', ')).toHaveLength(1);
      for (const r of answers.filter((x) => x.status !== 201)) expect([400, 409]).toContain(r.status);

      const { invoice, payments, lines } = await state(inv._id);
      expect(payments).toHaveLength(1);
      expect(lines.find((l) => l.name === 'Admission Fee')).toMatchObject({ paid: 6000, outstanding: 4000 });
      // What the staff allocated on each line never exceeds the line.
      const allocated = payments.flatMap((p) => p.headAllocations ?? []).filter((a) => a.line === admission);
      expect(allocated.reduce((n, a) => n + (a.amount ?? 0), 0)).toBeLessThanOrEqual(10000);
      // No line is paid beyond what it costs; the invoice agrees with its payments.
      for (const l of lines) expect(l.paid + l.waived).toBeLessThanOrEqual(l.net);
      expect(invoice.paid).toBe(payments.reduce((n, p) => n + p.amount, 0));
      expect(invoice.balance).toBe(invoice.total - invoice.paid);
      expect(invoice.status).toBe('partial');
      expect(invoice).not.toHaveProperty('paymentLock'); // released
      expect(
        await AuditLog.countDocuments({
          schoolId: s.schoolId,
          action: 'payment.record',
          entityId: String(payments[0]._id),
        }),
      ).toBe(1);
    });

    it('different fees at the same moment both go through; the invoice is then fully paid, never over', async () => {
      const inv = await invoiceWithTransport(1);
      const detail = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${inv._id}`);
      const line = (name: string) => detail.breakdown.find((l: { name: string }) => l.name === name).line;
      const pay = (amount: number, allocation: Array<{ line: string; amount: number }>) =>
        request(t.app)
          .post(`/api/v1/fees/invoices/${inv._id}/payments`)
          .set(auth(s.accountantToken))
          .send({ amount, method: 'cash', headAllocations: allocation });
      const answers = await Promise.all([
        pay(10000, [{ line: line('Admission Fee'), amount: 10000 }]),
        pay(5000, [{ line: line('Tuition Fee'), amount: 5000 }]),
        pay(2500, [{ line: line('Transport Fee'), amount: 2500 }]),
        pay(2500, [{ line: line('Transport Fee'), amount: 2500 }]), // the same fee again: refused
      ]);
      expect(answers.map((r) => r.status).filter((x) => x === 201)).toHaveLength(3);
      const { invoice, lines } = await state(inv._id);
      expect(lines.every((l) => l.outstanding === 0 && l.paid === l.net)).toBe(true);
      expect(invoice).toMatchObject({ paid: 17500, balance: 0, status: 'paid' });
      // A payment on a settled invoice is refused.
      expect((await pay(100, [])).status).toBe(409);
    });
  });
}
