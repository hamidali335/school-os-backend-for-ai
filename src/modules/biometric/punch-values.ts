import { localWallTimeToInstant, todayInTz } from '../../utils/dates';

/**
 * Reading punch times and types from attendance exports. Exports differ by machine and by the
 * PC's regional settings, so the day/month order of dates like 03/04/2026 cannot be guessed from
 * one row: it is decided for the whole file (see detectDateOrder) or chosen by the user.
 */

export type DateOrder = 'dmy' | 'mdy';

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };
/** How a date was read: day first, month first, year first (2026-10-24), or an exact time with its zone. */
export type ReadAs = DateOrder | 'ymd' | 'zoned';
export type ParsedPunchTime =
  | {
      ok: true;
      at: Date;
      localDate: string;
      readAs: ReadAs;
      /** The date could be read both ways (03/04/2026): the order used is the file's or the chosen one. */
      ambiguous: boolean;
    }
  | { ok: false; error: string; ambiguous?: boolean };

const MAX_FUTURE_MS = 24 * 3600_000;

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;
const YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const XMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp]\.?[Mm]\.?)?$/;

/** "08:01", "8:01:33 PM" → hour, minute, second; null when it is not a time. */
export function parseClock(raw: string): { hour: number; minute: number; second: number } | null {
  const m = TIME.exec(raw.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] ?? 0);
  const ampm = m[4]?.toLowerCase().replace(/\./g, '');
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/** Splits "2026-10-24 08:01:33" or "24/10/2026 8:01 PM" into its date part and time part. */
function splitDateTime(raw: string): { date: string; time: string } {
  const s = raw.trim().replace(/\s+/g, ' ');
  const i = s.search(/[ T]\d{1,2}:\d{2}/);
  return i < 0 ? { date: s, time: '' } : { date: s.slice(0, i), time: s.slice(i + 1) };
}

/** The first two numbers of a dd/mm/yyyy-like date, to decide the day/month order. */
export function dateParts(raw: string): { a: number; b: number } | null {
  const { date } = splitDateTime(raw);
  const m = XMY.exec(date);
  return m ? { a: Number(m[1]), b: Number(m[2]) } : null;
}

/**
 * The day/month order of a whole file: a first number above 12 means day first, a second
 * number above 12 means month first. Null when no row decides it; 'mixed' when rows disagree.
 */
export function detectDateOrder(values: string[]): DateOrder | 'mixed' | null {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const p = dateParts(v);
    if (!p) continue;
    if (p.a > 12 && p.b <= 12) dmy = true;
    else if (p.b > 12 && p.a <= 12) mdy = true;
  }
  if (dmy && mdy) return 'mixed';
  return dmy ? 'dmy' : mdy ? 'mdy' : null;
}

function calendarDay(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * One punch time from a date-and-time cell, or a date cell plus a time cell. Times without a
 * time zone are the school's local time (the machine's clock); "...Z" or "+05:00" are exact.
 */
export function parsePunchTime(
  dateTimeRaw: string,
  timeRaw: string | undefined,
  opts: { order: DateOrder | null; timeZone: string; now?: Date },
): ParsedPunchTime {
  const now = opts.now ?? new Date();
  const raw = dateTimeRaw.trim();
  if (!raw) return { ok: false, error: 'is empty' };
  let at: Date;
  let readAs: ReadAs = 'zoned';
  let ambiguous = false;
  const zoned = !timeRaw ? ISO_WITH_ZONE.exec(raw) : null;
  if (zoned) {
    const [, y, mo, d, h, mi, s, zone] = zoned;
    if (!calendarDay(Number(y), Number(mo), Number(d))) return { ok: false, error: `"${raw}" is not a real date` };
    const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${s ?? '00'}${zone.toUpperCase() === 'Z' ? 'Z' : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`;
    at = new Date(iso);
    if (Number.isNaN(at.getTime())) return { ok: false, error: `"${raw}" is not a valid time` };
  } else {
    const parts = timeRaw ? { date: raw, time: timeRaw.trim() } : splitDateTime(raw);
    if (!parts.time)
      return { ok: false, error: `"${raw}" has no time of day (add a Time column, or use date and time together)` };
    const clock = parseClock(parts.time);
    if (!clock) return { ok: false, error: `"${parts.time}" is not a time of day` };
    let wall: Wall;
    const ymd = YMD.exec(parts.date);
    const xmy = XMY.exec(parts.date);
    if (ymd) {
      wall = { year: Number(ymd[1]), month: Number(ymd[2]), day: Number(ymd[3]), ...clock };
      readAs = 'ymd';
    } else if (xmy) {
      const a = Number(xmy[1]);
      const b = Number(xmy[2]);
      // A number above 12 can only be the day: such a date is read that way whatever the order.
      const order = a > 12 ? 'dmy' : b > 12 ? 'mdy' : opts.order;
      ambiguous = a <= 12 && b <= 12 && a !== b;
      if (!order)
        return {
          ok: false,
          ambiguous: true,
          error: `"${parts.date}" could be day/month or month/day: choose the date order in the options`,
        };
      readAs = order;
      wall =
        order === 'dmy'
          ? { year: Number(xmy[3]), month: b, day: a, ...clock }
          : { year: Number(xmy[3]), month: a, day: b, ...clock };
    } else return { ok: false, error: `"${parts.date}" is not a date (use for example 2026-10-24 or 24/10/2026)` };
    if (!calendarDay(wall.year, wall.month, wall.day))
      return { ok: false, error: `"${parts.date}" is not a real date` };
    at = localWallTimeToInstant(wall, opts.timeZone);
  }
  if (at.getUTCFullYear() < 2000) return { ok: false, error: 'is before the year 2000 (is the machine’s clock set?)' };
  if (at.getTime() > now.getTime() + MAX_FUTURE_MS)
    return { ok: false, error: 'is in the future (is the machine’s clock right?)' };
  return { ok: true, at, localDate: todayInTz(opts.timeZone, at), readAs, ambiguous };
}

/** "2026-10-24 08:01:33": an instant as the school's clock shows it (for previews). */
export function wallTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const IN_WORDS = new Set(['in', 'i', 'checkin', 'clockin', 'cin', 'signin', 'entry', 'punchin', 'timein']);
const OUT_WORDS = new Set(['out', 'o', 'checkout', 'clockout', 'cout', 'signout', 'exit', 'punchout', 'timeout']);

/**
 * "Check In", "C/Out", "IN" → in/out. Anything else, including numeric state codes (their
 * meaning differs between machines and settings), is kept as given and treated as unknown:
 * an unknown punch still shows the staff member was there, but is never read as arrival or
 * departure.
 */
export function parsePunchType(raw: string): 'in' | 'out' | 'unknown' {
  const k = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (IN_WORDS.has(k)) return 'in';
  if (OUT_WORDS.has(k)) return 'out';
  return 'unknown';
}
