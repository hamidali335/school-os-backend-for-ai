import mongoose from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { MessageLog } from '../src/modules/communications/communications.models';
import { Payment } from '../src/modules/fees/fees.models';
import { School } from '../src/modules/schools/school.model';
import { todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { useTestApp } from './helpers';

/**
 * Records stored with real UTC timestamps around Pakistan midnight must be reported under
 * the local calendar day. Pakistan (UTC+5) day D runs from (D-1)T19:00Z to DT19:00Z, so
 * 00:00–04:59 PKT falls on the previous UTC date.
 */
const t = useTestApp();
let s: SchoolFixture;
const { ObjectId } = mongoose.Types;

// Amounts are distinct powers of ten so every sum identifies exactly which records it includes.
const AROUND_MIDNIGHT = [
  { at: '2026-03-14T18:59:59.999Z', pkt: '14 Mar 23:59:59.999', day: '2026-03-14', amount: 1 },
  { at: '2026-03-14T19:00:00.000Z', pkt: '15 Mar 00:00', day: '2026-03-15', amount: 10 },
  { at: '2026-03-14T22:30:00.000Z', pkt: '15 Mar 03:30', day: '2026-03-15', amount: 100 },
  { at: '2026-03-14T23:59:59.000Z', pkt: '15 Mar 04:59:59', day: '2026-03-15', amount: 1_000 },
  { at: '2026-03-15T00:00:00.000Z', pkt: '15 Mar 05:00', day: '2026-03-15', amount: 10_000 },
  { at: '2026-03-15T18:59:59.999Z', pkt: '15 Mar 23:59:59.999', day: '2026-03-15', amount: 100_000 },
  { at: '2026-03-15T19:00:00.000Z', pkt: '16 Mar 00:00', day: '2026-03-16', amount: 1_000_000 },
];
const sumFor = (day: string) => AROUND_MIDNIGHT.filter((r) => r.day === day).reduce((n, r) => n + r.amount, 0);

async function insertPayments(schoolId: string, rows: Array<{ at: string; amount: number }>) {
  await Payment.collection.insertMany(
    rows.map((r, i) => ({
      schoolId: new ObjectId(schoolId),
      invoiceId: new ObjectId(),
      studentId: new ObjectId(),
      receiptNo: `TZ-${Date.now()}-${i}`,
      amount: r.amount,
      method: 'cash',
      status: 'valid',
      receivedAt: new Date(r.at),
      createdAt: new Date(r.at),
      updatedAt: new Date(r.at),
    })),
  );
}

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  await insertPayments(s.schoolId, AROUND_MIDNIGHT);
  await MessageLog.collection.insertMany(
    AROUND_MIDNIGHT.map((r) => ({
      schoolId: new ObjectId(s.schoolId),
      channel: 'sms',
      to: '+923001234567',
      body: 'tz test',
      status: 'sent',
      costPkr: r.amount,
      createdAt: new Date(r.at),
      updatedAt: new Date(r.at),
    })),
  );
});

describe('Fee-collection report uses the school’s local day', () => {
  it('a single day includes 00:00–04:59 PKT and excludes the neighbouring days', async () => {
    const r = await api(
      t.app,
      s.ownerToken,
      'get',
      '/reports/fee-collection?from=2026-03-15&to=2026-03-15&groupBy=day',
    );
    expect(r.total).toBe(sumFor('2026-03-15')); // 111,110
    expect(r.count).toBe(5);
    expect(r.rows).toEqual([{ key: '2026-03-15', total: sumFor('2026-03-15'), count: 5 }]);
  });

  it('groups each payment under its Pakistan date', async () => {
    const r = await api(
      t.app,
      s.ownerToken,
      'get',
      '/reports/fee-collection?from=2026-03-14&to=2026-03-16&groupBy=day',
    );
    expect(r.rows).toEqual([
      { key: '2026-03-14', total: sumFor('2026-03-14'), count: 1 },
      { key: '2026-03-15', total: sumFor('2026-03-15'), count: 5 },
      { key: '2026-03-16', total: sumFor('2026-03-16'), count: 1 },
    ]);
  });

  it('financial summary and the payments list use the same boundaries', async () => {
    const summary = await api(t.app, s.ownerToken, 'get', '/accounts/summary?from=2026-03-15&to=2026-03-15');
    expect(summary.feeCollections).toBe(sumFor('2026-03-15'));
    expect(summary.feePaymentsCount).toBe(5);
    expect(summary.monthly).toEqual([
      expect.objectContaining({ month: '2026-03', feeCollections: sumFor('2026-03-15') }),
    ]);
    const list = await api(t.app, s.ownerToken, 'get', '/fees/payments?from=2026-03-15&to=2026-03-15&limit=50');
    expect(list.map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([
      10, 100, 1_000, 10_000, 100_000,
    ]);
  });
});

describe('Messaging cost report uses the school’s local day', () => {
  it('counts messages sent 00:00–04:59 PKT under the Pakistan date', async () => {
    const day = await api(t.app, s.ownerToken, 'get', '/communications/costs?from=2026-03-15&to=2026-03-15');
    expect(day.totalPkr).toBe(sumFor('2026-03-15'));
    const before = await api(t.app, s.ownerToken, 'get', '/communications/costs?from=2026-03-14&to=2026-03-14');
    expect(before.totalPkr).toBe(sumFor('2026-03-14'));
    const after = await api(t.app, s.ownerToken, 'get', '/communications/costs?from=2026-03-16&to=2026-03-16');
    expect(after.totalPkr).toBe(sumFor('2026-03-16'));
  });
});

describe('Dashboard “collected today”', () => {
  it('starts at local midnight, whatever the current UTC date', async () => {
    const before = (await api(t.app, s.ownerToken, 'get', '/dashboard')).fees.collectedToday;
    // Pakistan midnight computed independently of the code under test (fixed UTC+5).
    const todayStart = new Date(`${todayInTz('Asia/Karachi')}T00:00:00+05:00`);
    await insertPayments(s.schoolId, [
      { at: todayStart.toISOString(), amount: 7 }, // 00:00 PKT today: counted
      { at: new Date(todayStart.getTime() - 1).toISOString(), amount: 500 }, // 23:59:59.999 PKT yesterday: not counted
    ]);
    const after = (await api(t.app, s.ownerToken, 'get', '/dashboard')).fees.collectedToday;
    expect(after - before).toBe(7);
  });
});

describe('Per-school timezone', () => {
  it('a school configured for another zone gets that zone’s day boundaries', async () => {
    const dubai = await buildSchool(t.app, { students: 1 });
    await School.updateOne({ _id: dubai.schoolId }, { $set: { 'settings.timezone': 'Asia/Dubai' } }); // UTC+4
    await insertPayments(dubai.schoolId, [
      { at: '2026-03-14T19:30:00.000Z', amount: 3 }, // 23:30 on the 14th in Dubai (00:30 on the 15th in Pakistan)
      { at: '2026-03-14T20:00:00.000Z', amount: 40 }, // 00:00 on the 15th in Dubai
    ]);
    const r = await api(
      t.app,
      dubai.ownerToken,
      'get',
      '/reports/fee-collection?from=2026-03-15&to=2026-03-15&groupBy=day',
    );
    expect(r.total).toBe(40);
    expect(r.rows).toEqual([{ key: '2026-03-15', total: 40, count: 1 }]);
  });
});

describe('Stored timestamps are not changed', () => {
  it('payments keep the exact instant they were recorded with', async () => {
    const stored = await Payment.find({ schoolId: s.schoolId, receiptNo: /^TZ-/ }).sort({ receivedAt: 1 }).lean();
    expect(stored.slice(0, AROUND_MIDNIGHT.length).map((p) => p.receivedAt.toISOString())).toEqual(
      AROUND_MIDNIGHT.map((r) => r.at),
    );
  });
});
