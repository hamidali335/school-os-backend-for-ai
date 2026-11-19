import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  allocatePayment,
  billableItems,
  computeTotals,
  concessionAmount,
  installmentStatus,
  splitInstallments,
  statusFor,
} from '../src/modules/fees/fee-calc';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();

describe('Fee calculations (pure)', () => {
  const items = [
    { name: 'Tuition', amount: 5000, concessionApplies: true },
    { name: 'Lab', amount: 1000 },
  ];

  it('applies percent and fixed concessions only to concession-eligible items', () => {
    expect(concessionAmount(items, { type: 'percent', value: 25 })).toBe(1250);
    expect(concessionAmount(items, { type: 'fixed', value: 7000 })).toBe(5000);
    expect(concessionAmount(items, { type: 'none', value: 50 })).toBe(0);
    expect(concessionAmount(items, { type: 'percent', value: 150 })).toBe(5000);
  });

  it('computes totals with waiver and late fee, never below zero', () => {
    expect(computeTotals({ items, concession: { type: 'percent', value: 10 }, waiver: 200, lateFee: 300 })).toEqual({
      subtotal: 6000,
      concession: 500,
      waiver: 200,
      lateFee: 300,
      total: 5600,
    });
    expect(computeTotals({ items, waiver: 99999 }).total).toBe(0);
    expect(() => computeTotals({ items: [{ name: 'x', amount: 10.5 }] })).toThrow();
  });

  it('derives invoice status', () => {
    expect(statusFor(1000, 0)).toBe('unpaid');
    expect(statusFor(1000, 400)).toBe('partial');
    expect(statusFor(1000, 1000)).toBe('paid');
    expect(statusFor(0, 0, 500)).toBe('waived');
  });

  it('splits installments exactly and allocates payments earliest-first', () => {
    const plan = splitInstallments(10000, 3, new Date('2026-10-10'), 30);
    expect(plan.map((p) => p.amount)).toEqual([3333, 3333, 3334]);
    expect(plan.reduce((s, p) => s + p.amount, 0)).toBe(10000);
    expect(allocatePayment(plan, 0, 5000)).toEqual([
      { installmentNo: 1, amount: 3333 },
      { installmentNo: 2, amount: 1667 },
    ]);
    expect(allocatePayment(plan, 5000, 3000)).toEqual([
      { installmentNo: 2, amount: 1666 },
      { installmentNo: 3, amount: 1334 },
    ]);
    const status = installmentStatus(plan, 5000, new Date('2026-11-15'));
    expect(status.map((s) => s.status)).toEqual(['paid', 'overdue', 'due']);
  });

  it('bills monthly items every month, annual items in billing months, one-time items once', () => {
    const structure = [
      { name: 'Tuition', frequency: 'monthly' },
      { name: 'Annual', frequency: 'annual', billingMonths: [4] },
      { name: 'Admission', frequency: 'one_time' },
    ];
    expect(billableItems(structure, '2026-04', true).map((i) => i.name)).toEqual(['Tuition', 'Annual', 'Admission']);
    expect(billableItems(structure, '2026-05', false).map((i) => i.name)).toEqual(['Tuition']);
  });
});

describe('Fees API', () => {
  let s: SchoolFixture;
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
  });

  it('generates invoices idempotently with one-time charges on the first invoice only', async () => {
    const first = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    expect(first.created).toBe(4);
    const again = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    expect(again.created).toBe(0);
    expect(again.skippedExisting).toBe(4);
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${first.invoiceIds[0]}`);
    expect(inv.total).toBe(15000); // tuition 5000 + admission 10000
    const oct = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-10' });
    const octInv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${oct.invoiceIds[0]}`);
    expect(octInv.total).toBe(5000);
    expect(octInv.items).toHaveLength(1);
  });

  it('records partial and full payments atomically and rejects overpayment', async () => {
    const list = await api(t.app, s.accountantToken, 'get', `/fees/invoices?period=2026-10&studentId=${s.students[1]}`);
    const id = list[0]._id;
    const p1 = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/payments`, {
      amount: 2000,
      method: 'cash',
    });
    expect(p1.invoice.status).toBe('partial');
    expect(p1.invoice.balance).toBe(3000);
    expect(p1.payment.receiptNo).toMatch(/^RCP-/);

    const over = await request(t.app)
      .post(`/api/v1/fees/invoices/${id}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 3001, method: 'cash' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERPAYMENT');

    const p2 = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/payments`, {
      amount: 3000,
      method: 'bank_transfer',
      reference: 'HBL-123',
    });
    expect(p2.invoice.status).toBe('paid');
    expect(p2.invoice.balance).toBe(0);
    const paidAgain = await request(t.app)
      .post(`/api/v1/fees/invoices/${id}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1, method: 'cash' });
    expect(paidAgain.status).toBe(409);
  });

  it('replays a payment with the same idempotency key instead of charging twice', async () => {
    const list = await api(t.app, s.accountantToken, 'get', `/fees/invoices?period=2026-10&studentId=${s.students[2]}`);
    const id = list[0]._id;
    const body = { amount: 1000, method: 'cash', idempotencyKey: 'retry-key-0001' };
    const a = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/payments`, body);
    const b = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/payments`, body);
    expect(b.replayed).toBe(true);
    expect(b.payment._id).toBe(a.payment._id);
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${id}`);
    expect(inv.paid).toBe(1000);
  });

  it('never over-settles an invoice under concurrent payments', async () => {
    const list = await api(t.app, s.accountantToken, 'get', `/fees/invoices?period=2026-10&studentId=${s.students[3]}`);
    const id = list[0]._id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(t.app)
          .post(`/api/v1/fees/invoices/${id}/payments`)
          .set(auth(s.accountantToken))
          .send({ amount: 5000, method: 'cash' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${id}`);
    expect(inv.paid).toBe(5000);
    expect(inv.balance).toBe(0);
    expect(inv.payments).toHaveLength(1);
  });

  it('applies a waiver only after approval by someone other than the requester', async () => {
    const list = await api(t.app, s.accountantToken, 'get', `/fees/invoices?period=2026-09&studentId=${s.students[0]}`);
    const id = list[0]._id;
    const approval = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/waiver-requests`, {
      amount: 2500,
      reason: 'Hardship case approved by committee',
    });
    expect(approval.status).toBe('pending');
    let inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${id}`);
    expect(inv.waiver).toBe(0); // unchanged until approved

    const dup = await request(t.app)
      .post(`/api/v1/fees/invoices/${id}/waiver-requests`)
      .set(auth(s.accountantToken))
      .send({ amount: 100, reason: 'duplicate request' });
    expect(dup.status).toBe(409);

    const byAccountant = await request(t.app)
      .post(`/api/v1/approvals/${approval._id}/decision`)
      .set(auth(s.accountantToken))
      .send({ decision: 'approve' });
    expect(byAccountant.status).toBe(403);

    const decided = await api(t.app, s.principalToken, 'post', `/approvals/${approval._id}/decision`, {
      decision: 'approve',
      note: 'OK',
    });
    expect(decided.status).toBe('executed');
    expect(decided.result.newBalance).toBe(12500);
    inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${id}`);
    expect(inv.waiver).toBe(2500);
    expect(inv.total).toBe(12500);
  });

  it('applies standing concessions to future invoices after approval', async () => {
    const approval = await api(
      t.app,
      s.accountantToken,
      'post',
      `/fees/students/${s.students[0]}/concession-requests`,
      { type: 'percent', value: 20, reason: 'Sibling concession' },
    );
    await api(t.app, s.principalToken, 'post', `/approvals/${approval._id}/decision`, { decision: 'approve' });
    const gen = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', {
      period: '2026-11',
      studentIds: [s.students[0]],
    });
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${gen.invoiceIds[0]}`);
    expect(inv.concession).toBe(1000);
    expect(inv.total).toBe(4000);
  });

  it('splits an invoice into installments and tracks them from payments', async () => {
    const gen = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', {
      period: '2026-11',
      studentIds: [s.students[1]],
    });
    const id = gen.invoiceIds[0];
    const bad = await request(t.app)
      .post(`/api/v1/fees/invoices/${id}/installments`)
      .set(auth(s.accountantToken))
      .send({
        plan: [
          { amount: 1000, dueDate: '2026-11-10' },
          { amount: 1000, dueDate: '2026-12-10' },
        ],
      });
    expect(bad.status).toBe(422);
    const inst = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/installments`, {
      count: 2,
      firstDueDate: '2026-11-10',
      intervalDays: 30,
    });
    expect(inst.installments.map((i: any) => i.amount)).toEqual([2500, 2500]);
    const pay = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${id}/payments`, {
      amount: 3000,
      method: 'cash',
    });
    expect(pay.payment.allocations).toEqual([
      { installmentNo: 1, amount: 2500 },
      { installmentNo: 2, amount: 500 },
    ]);
  });

  it('produces a consistent ledger and outstanding report', async () => {
    const ledger = await api(t.app, s.accountantToken, 'get', `/fees/students/${s.students[0]}/ledger`);
    expect(ledger.summary.outstanding).toBe(ledger.summary.totalBilled - ledger.summary.totalPaid);
    expect(ledger.entries.at(-1).balance).toBe(ledger.summary.outstanding);
    const out = await api(t.app, s.accountantToken, 'get', '/fees/outstanding');
    const sum = out.students.reduce((acc: number, r: any) => acc + r.balance, 0);
    expect(out.totals.balance).toBe(sum);
  });

  it('lets parents see only their own child’s invoices and ledger', async () => {
    const mine = await api(t.app, s.parentToken, 'get', '/fees/invoices');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((i: any) => (i.studentId._id ?? i.studentId) === s.students[0])).toBe(true);
    const other = await request(t.app).get(`/api/v1/fees/students/${s.students[1]}/ledger`).set(auth(s.parentToken));
    expect(other.status).toBe(404);
    const pay = await request(t.app)
      .post(`/api/v1/fees/invoices/${mine[0]._id}/payments`)
      .set(auth(s.parentToken))
      .send({ amount: 1, method: 'cash' });
    expect(pay.status).toBe(403);
  });

  it('applies late fees once per overdue invoice', async () => {
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { fees: { lateFeeAmount: 500, lateFeeGraceDays: 0 } });
    const r1 = await api(t.app, s.accountantToken, 'post', '/fees/late-fees/apply');
    expect(r1.applied).toBeGreaterThan(0);
    const r2 = await api(t.app, s.accountantToken, 'post', '/fees/late-fees/apply');
    expect(r2.applied).toBe(0);
  });

  it('serves challan and receipt PDFs', async () => {
    const list = await api(t.app, s.accountantToken, 'get', '/fees/payments');
    const receipt = await request(t.app)
      .get(`/api/v1/fees/payments/${list[0]._id}/receipt.pdf`)
      .set(auth(s.accountantToken));
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
    expect(receipt.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
