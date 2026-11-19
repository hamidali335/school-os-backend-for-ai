import { describe, expect, it } from 'vitest';
import { localDayRange, startOfLocalDay, startOfLocalMonth, todayInTz } from '../src/utils/dates';

const iso = (d: Date) => d.toISOString();
/** Is `instant` inside the local reporting day `day` (inclusive start, exclusive end)? */
const inDay = (instant: string, day: string, tz = 'Asia/Karachi') => {
  const { start, end } = localDayRange(day, day, tz);
  const t = new Date(instant).getTime();
  return t >= start.getTime() && t < end.getTime();
};

describe('Local reporting-day boundaries (Asia/Karachi, UTC+5)', () => {
  it('a Pakistan day starts at 19:00 UTC on the previous UTC date', () => {
    expect(iso(startOfLocalDay('2026-10-15', 'Asia/Karachi'))).toBe('2026-10-14T19:00:00.000Z');
    const { start, end } = localDayRange('2026-10-15', '2026-10-15', 'Asia/Karachi');
    expect(iso(start)).toBe('2026-10-14T19:00:00.000Z');
    expect(iso(end)).toBe('2026-10-15T19:00:00.000Z');
  });

  it('defaults to Asia/Karachi', () => {
    expect(iso(startOfLocalDay('2026-10-15'))).toBe('2026-10-14T19:00:00.000Z');
  });

  it.each([
    // [UTC instant, Pakistan wall time, expected local reporting day]
    ['2026-10-14T18:59:59.999Z', '14 Oct 23:59:59.999', '2026-10-14'],
    ['2026-10-14T19:00:00.000Z', '15 Oct 00:00 (midnight)', '2026-10-15'],
    ['2026-10-14T19:00:01.000Z', '15 Oct 00:00:01', '2026-10-15'],
    ['2026-10-14T21:30:00.000Z', '15 Oct 02:30 (UTC date still 14th)', '2026-10-15'],
    ['2026-10-14T23:59:59.999Z', '15 Oct 04:59:59.999 (UTC date still 14th)', '2026-10-15'],
    ['2026-10-15T00:00:00.000Z', '15 Oct 05:00 (UTC date becomes 15th)', '2026-10-15'],
    ['2026-10-15T18:59:59.999Z', '15 Oct 23:59:59.999', '2026-10-15'],
    ['2026-10-15T19:00:00.000Z', '16 Oct 00:00', '2026-10-16'],
  ])('%s (%s PKT) belongs to %s', (instant, _wall, day) => {
    expect(inDay(instant, day)).toBe(true);
    // ...and to no neighbouring day
    const prev = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(inDay(instant, prev)).toBe(false);
    expect(inDay(instant, next)).toBe(false);
    // The "today" a user in Pakistan sees at that instant is the same day.
    expect(todayInTz('Asia/Karachi', new Date(instant))).toBe(day);
  });

  it('multi-day ranges are inclusive of both end days', () => {
    const { start, end } = localDayRange('2026-10-01', '2026-10-31', 'Asia/Karachi');
    expect(iso(start)).toBe('2026-09-30T19:00:00.000Z');
    expect(iso(end)).toBe('2026-10-31T19:00:00.000Z');
  });

  it('months and years roll over at Pakistan midnight', () => {
    expect(iso(startOfLocalMonth('2026-11', 'Asia/Karachi'))).toBe('2026-10-31T19:00:00.000Z');
    expect(iso(startOfLocalDay('2027-01-01', 'Asia/Karachi'))).toBe('2026-12-31T19:00:00.000Z');
    expect(iso(startOfLocalDay('2028-03-01', 'Asia/Karachi'))).toBe('2028-02-29T19:00:00.000Z'); // leap year
  });
});

describe('Other school timezones', () => {
  it('uses the configured zone, not the server zone', () => {
    expect(iso(startOfLocalDay('2026-10-15', 'Asia/Dubai'))).toBe('2026-10-14T20:00:00.000Z');
    expect(iso(startOfLocalDay('2026-10-15', 'UTC'))).toBe('2026-10-15T00:00:00.000Z');
  });

  it('handles daylight-saving changes', () => {
    // New York: UTC-5 in winter, UTC-4 from 8 March 2026.
    expect(iso(startOfLocalDay('2026-03-08', 'America/New_York'))).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(startOfLocalDay('2026-03-09', 'America/New_York'))).toBe('2026-03-09T04:00:00.000Z');
    const { start, end } = localDayRange('2026-03-08', '2026-03-08', 'America/New_York');
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000); // the short day
  });

  it('rejects invalid calendar dates', () => {
    expect(() => startOfLocalDay('2026-02-30')).toThrow(RangeError);
  });
});
