import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Payment } from '../src/modules/fees/fees.models';
import { auth, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Receipts say which fees a payment paid: recorded when the payment is made (chosen by the
 * cashier, or the outstanding fees in challan order), never guessed afterwards. Older payments
 * without a record say so.
 */
const t = useTestApp();
let f: SchoolFixture;
let invoices: Array<{
  _id: string;
  studentId: { _id: string } | string;
  items: Array<{ name: string }>;
  total: number;
}>;

const invoiceOf = (i: number) =>
  invoices.find((x) => String((x.studentId as { _id: string })._id ?? x.studentId) === f.students[i])!;
const pay = (invoiceId: string, body: object) =>
  request(t.app).post(`/api/v1/fees/invoices/${invoiceId}/payments`).set(auth(f.accountantToken)).send(body);
const breakdown = async (paymentId: string) =>
  (await api(t.app, f.accountantToken, 'get', `/fees/payments/${paymentId}`)).breakdown;

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 3 });
  await api(t.app, f.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
  invoices = await api(t.app, f.accountantToken, 'get', '/fees/invoices?period=2026-09&limit=50');
});

describe('fee breakdown on receipts', () => {
  it('a partial payment without a choice settles fees in challan order, and says so', async () => {
    const inv = invoiceOf(0); // Tuition 5,000 + Admission 10,000 (first invoice)
    expect(inv.items.map((i) => i.name)).toEqual(['Tuition Fee', 'Admission Fee']);
    const res = await pay(inv._id, { amount: 7000, method: 'cash' });
    expect(res.status).toBe(201);
    const b = await breakdown(res.body.data.payment._id);
    expect(b).toEqual({
      available: true,
      source: 'automatic',
      unallocated: 0,
      lines: [
        { name: 'Tuition Fee', due: 5000, paidNow: 5000, remaining: 0 },
        { name: 'Admission Fee', due: 10000, paidNow: 2000, remaining: 8000 },
      ],
    });
  });

  it('the next payment starts from what the first left', async () => {
    const inv = invoiceOf(0);
    const res = await pay(inv._id, { amount: 8000, method: 'bank_transfer', reference: 'TRX-91' });
    const b = await breakdown(res.body.data.payment._id);
    expect(b.lines).toEqual([{ name: 'Admission Fee', due: 8000, paidNow: 8000, remaining: 0 }]);
  });

  it('a payment for chosen fees shows exactly those', async () => {
    const inv = invoiceOf(1);
    const lines = (await api(t.app, f.accountantToken, 'get', `/fees/invoices/${inv._id}`)).breakdown;
    const admission = lines.find((l: { name: string }) => l.name === 'Admission Fee');
    const res = await pay(inv._id, {
      amount: 4000,
      method: 'cash',
      headAllocations: [{ line: admission.line, amount: 4000 }],
    });
    expect(res.status).toBe(201);
    const b = await breakdown(res.body.data.payment._id);
    expect(b.source).toBe('chosen');
    expect(b.lines).toEqual([
      { name: 'Tuition Fee', due: 5000, paidNow: 0, remaining: 5000 },
      { name: 'Admission Fee', due: 10000, paidNow: 4000, remaining: 6000 },
    ]);
    const stored = await Payment.findOne({ schoolId: f.schoolId, _id: res.body.data.payment._id }).lean();
    expect(stored!.headAllocations.map((a) => a.amount)).toEqual([4000]);
  });

  it('an older payment without a recorded breakdown is not guessed', async () => {
    const inv = invoiceOf(2);
    const res = await pay(inv._id, { amount: 1000, method: 'cash' });
    const id = res.body.data.payment._id;
    // As payments were stored before this change.
    await Payment.updateOne(
      { schoolId: f.schoolId, _id: id },
      { $unset: { allocationSource: 1 }, $set: { headAllocations: [] } },
    );
    expect(await breakdown(id)).toEqual({ available: false, source: null, lines: [], unallocated: 0 });
  });

  it('the receipt PDF is produced for both kinds; other schools cannot open it', async () => {
    const payments = await Payment.find({ schoolId: f.schoolId }).select('_id').lean();
    for (const p of payments) {
      const res = await request(t.app)
        .get(`/api/v1/fees/payments/${p._id}/receipt.pdf`)
        .set(auth(f.accountantToken))
        .buffer(true);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const other = await buildSchool(t.app, { students: 1 });
    const res = await request(t.app).get(`/api/v1/fees/payments/${payments[0]._id}`).set(auth(other.accountantToken));
    expect(res.status).toBe(404);
  });

  it('a parent sees the breakdown of their own child’s payment only', async () => {
    const mine = await Payment.findOne({ schoolId: f.schoolId, studentId: f.students[0] }).lean();
    expect((await api(t.app, f.parentToken, 'get', `/fees/payments/${mine!._id}`)).breakdown.available).toBe(true);
    const notMine = await Payment.findOne({ schoolId: f.schoolId, studentId: f.students[1] }).lean();
    expect((await request(t.app).get(`/api/v1/fees/payments/${notMine!._id}`).set(auth(f.parentToken))).status).toBe(
      404,
    );
  });
});
