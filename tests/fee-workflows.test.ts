import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { headBreakdown, invoiceLines, validateHeadAllocation } from '../src/modules/fees/fee-calc';
import { Invoice } from '../src/modules/fees/fees.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
const X = { crossTenant: true } as never;

describe('Fee-head breakdown (pure)', () => {
  const invoice = {
    items: [
      { name: 'Admission Fee', amount: 4000 },
      { name: 'Tuition Fee', amount: 6000, concessionApplies: true },
    ],
    concession: 0,
    waiver: 0,
    lateFee: 0,
    balance: 2000,
  };

  it('Rs 10,000 invoice, Rs 8,000 paid: one invoice, Rs 2,000 outstanding, traced to its fee', () => {
    const lines = headBreakdown(invoice, [{ amount: 8000 }]);
    expect(lines.map((l) => [l.name, l.paid, l.outstanding, l.status])).toEqual([
      ['Admission Fee', 4000, 0, 'paid'],
      ['Tuition Fee', 4000, 2000, 'partial'],
    ]);
    expect(lines.reduce((s, l) => s + l.outstanding, 0)).toBe(invoice.balance);
  });

  it('honours a staff allocation: tuition paid first leaves admission outstanding', () => {
    const lines = headBreakdown(invoice, [{ amount: 6000, headAllocations: [{ line: '1', amount: 6000 }] }]);
    expect(lines.find((l) => l.line === '1')?.status).toBe('paid');
    expect(lines.find((l) => l.line === '0')?.outstanding).toBe(4000);
  });

  it('puts the concession on the lines it applies to, and a waiver after payments', () => {
    const lines = invoiceLines({ ...invoice, concession: 1500, lateFee: 300 });
    expect(lines.map((l) => [l.name, l.net])).toEqual([
      ['Admission Fee', 4000],
      ['Tuition Fee', 4500],
      ['Late fee', 300],
    ]);
    const withWaiver = headBreakdown({ ...invoice, waiver: 1000, balance: 1000 }, [{ amount: 8000 }]);
    expect(withWaiver.reduce((s, l) => s + l.outstanding, 0)).toBe(1000);
  });

  it('rejects allocations that do not add up or exceed what is outstanding', () => {
    const lines = headBreakdown(invoice, []);
    expect(() => validateHeadAllocation(lines, [{ line: '0', amount: 3000 }], 4000)).toThrow(/adds up to Rs 3000/);
    expect(() => validateHeadAllocation(lines, [{ line: '0', amount: 5000 }], 5000)).toThrow(/Only Rs 4000/);
    expect(() => validateHeadAllocation(lines, [{ line: '9', amount: 1 }], 1)).toThrow(/Unknown/);
  });
});

describe('Fee workflows', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
    other = await buildSchool(t.app, { students: 1 });
  });

  it('offers common fee heads without duplicating ones the school already has', async () => {
    const list = await api(t.app, s.ownerToken, 'get', '/fees/default-heads');
    expect(list.find((d: any) => d.code === 'TUITION').exists).toBe(true); // fixture already has TUITION
    expect(list.find((d: any) => d.code === 'ANNUAL').exists).toBe(true);
    expect(list.find((d: any) => d.code === 'TRANSPORT').exists).toBe(false);
    expect(list.every((d: any) => !('amount' in d))).toBe(true);

    const added = await api(t.app, s.ownerToken, 'post', '/fees/default-heads', {
      codes: ['TUITION', 'EXAM', 'TRANSPORT'],
    });
    expect(added.created.sort()).toEqual(['EXAM', 'TRANSPORT']);
    expect(added.skipped.map((x: any) => x.code)).toEqual(['TUITION']);
    const again = await api(t.app, s.ownerToken, 'post', '/fees/default-heads', { codes: ['EXAM', 'TRANSPORT'] });
    expect(again.created).toEqual([]);
    const heads = await api(t.app, s.ownerToken, 'get', '/fees/heads?limit=100');
    expect(heads.filter((h: any) => h.code === 'EXAM')).toHaveLength(1);
    expect(heads.find((h: any) => h.code === 'TRANSPORT').billing).toBe('per_student');

    const asTeacher = await request(t.app)
      .post('/api/v1/fees/default-heads')
      .set(auth(s.teacherToken))
      .send({ codes: ['UNIFORM'] });
    expect(asTeacher.status).toBe(403);
  });

  it('keeps per-student fees out of class structures', async () => {
    const heads = await api(t.app, s.ownerToken, 'get', '/fees/heads?limit=100');
    const transport = heads.find((h: any) => h.code === 'TRANSPORT');
    const res = await request(t.app)
      .put('/api/v1/fees/structures')
      .set(auth(s.ownerToken))
      .send({
        sessionId: s.sessionId,
        classId: s.classId,
        name: 'x',
        items: [{ feeHeadId: transport._id, amount: 2000 }],
      });
    expect(res.status).toBe(400);
  });

  let invoiceId: string;

  it('previews and creates one student invoice, with a per-student charge, and refuses a duplicate', async () => {
    const preview = await api(
      t.app,
      s.accountantToken,
      'get',
      `/fees/students/${s.students[0]}/invoice-preview?period=2026-10`,
    );
    expect(preview.existingInvoice).toBeNull();
    expect(preview.firstInvoice).toBe(true);
    expect(preview.items.map((i: any) => [i.name, i.amount])).toEqual([
      ['Tuition Fee', 5000],
      ['Admission Fee', 10000],
    ]);
    expect(preview.totals.total).toBe(15000);
    const transport = preview.perStudentHeads.find((h: any) => h.name === 'Transport Fee');

    const inv = await api(t.app, s.accountantToken, 'post', `/fees/students/${s.students[0]}/invoices`, {
      period: '2026-10',
      extraItems: [{ feeHeadId: transport._id, amount: 2500 }],
    });
    invoiceId = inv._id;
    expect(inv.total).toBe(17500);
    expect(inv.kind).toBe('regular');

    const dup = await request(t.app)
      .post(`/api/v1/fees/students/${s.students[0]}/invoices`)
      .set(auth(s.accountantToken))
      .send({ period: '2026-10' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    expect(dup.body.error.details.invoiceId).toBe(invoiceId);

    // Class-wide generation afterwards skips this student and never bills transport to the class.
    const bulk = await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', {
      period: '2026-10',
      sectionId: s.sectionA,
    });
    expect(bulk.skippedExisting).toBe(1);
    expect(bulk.created).toBe(1);
    const sibling = await Invoice.findOne({ studentId: s.students[1], period: '2026-10' }).setOptions(X).lean();
    expect(sibling?.items.map((i) => i.name)).toEqual(['Tuition Fee', 'Admission Fee']);
  });

  it('records a partial payment against the original invoice and allocates it to fees', async () => {
    // Allocate Rs 10,000 to admission + transport explicitly; tuition stays unpaid.
    const detail = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${invoiceId}`);
    const line = (name: string) => detail.breakdown.find((l: any) => l.name === name).line;
    const bad = await request(t.app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 10000, method: 'cash', headAllocations: [{ line: line('Admission Fee'), amount: 9000 }] });
    expect(bad.status).toBe(400);

    const paid = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${invoiceId}/payments`, {
      amount: 10000,
      method: 'bank_transfer',
      reference: 'TRX-778',
      headAllocations: [
        { line: line('Admission Fee'), amount: 7500 },
        { line: line('Transport Fee'), amount: 2500 },
      ],
    });
    expect(paid.invoice.total).toBe(17500); // the original invoice is unchanged
    expect(paid.invoice.paid).toBe(10000);
    expect(paid.invoice.balance).toBe(7500);
    expect(paid.invoice.status).toBe('partial');
    expect(await Invoice.countDocuments({ studentId: s.students[0] }).setOptions(X)).toBe(1);

    const after = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${invoiceId}`);
    const by = Object.fromEntries(after.breakdown.map((l: any) => [l.name, [l.paid, l.outstanding, l.status]]));
    expect(by['Transport Fee']).toEqual([2500, 0, 'paid']);
    expect(by['Admission Fee']).toEqual([7500, 2500, 'partial']);
    expect(by['Tuition Fee']).toEqual([0, 5000, 'unpaid']);
    expect(after.breakdown.reduce((n: number, l: any) => n + l.outstanding, 0)).toBe(after.balance);
  });

  it('shows the ledger with totals that agree with the invoices, and the challan with the same figures', async () => {
    const ledger = await api(t.app, s.accountantToken, 'get', `/fees/students/${s.students[0]}/ledger`);
    expect(ledger.summary).toMatchObject({ totalBilled: 17500, totalPaid: 10000, outstanding: 7500 });
    expect(ledger.payments[0]).toMatchObject({ reference: 'TRX-778', invoiceNo: ledger.invoices[0].invoiceNo });
    expect(ledger.invoices[0].breakdown.length).toBe(3);

    const ch = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${invoiceId}/challan`);
    expect(ch.challan.invoiceNo).toBe(ledger.invoices[0].invoiceNo);
    expect(ch.challan.items.map((i: any) => i.amount)).toEqual([5000, 10000, 2500]);
    expect(ch.figures).toMatchObject({ net: 17500, payableNow: 7500 });
    expect(ch.school.name).toBeTruthy();
  });

  it('never changes an existing invoice when the fee structure changes', async () => {
    await api(t.app, s.ownerToken, 'put', '/fees/structures', {
      sessionId: s.sessionId,
      classId: s.classId,
      name: 'Class 5 fees',
      items: [{ feeHeadId: s.tuitionHeadId, amount: 9999 }],
    });
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices/${invoiceId}`);
    expect(inv.total).toBe(17500);
    expect(inv.items[0].amount).toBe(5000);
  });

  it('keeps students and invoices of other schools out of reach', async () => {
    const preview = await request(t.app)
      .get(`/api/v1/fees/students/${other.students[0]}/invoice-preview?period=2026-10`)
      .set(auth(s.accountantToken));
    expect(preview.status).toBe(404);
    const challan = await request(t.app).get(`/api/v1/fees/invoices/${invoiceId}/challan`).set(auth(other.ownerToken));
    expect(challan.status).toBe(404);
  });
});
