/**
 * Calendar dates (attendance days, due dates) are stored as UTC midnight of the school's
 * local calendar day so that "2026-10-13" means the same day everywhere.
 */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's calendar date in the given IANA timezone, as YYYY-MM-DD. */
export function todayInTz(timeZone = 'Asia/Karachi', now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function startOfMonthUtc(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

export function endOfMonthUtc(period: string): Date {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
}

export function currentPeriod(timeZone = 'Asia/Karachi', now = new Date()): string {
  return todayInTz(timeZone, now).slice(0, 7);
}

/** Minutes since midnight for "HH:mm". */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function dayRange(from: string, to: string): { from: Date; to: Date } {
  return { from: parseDateOnly(from), to: parseDateOnly(to) };
}

export const DEFAULT_TIMEZONE = 'Asia/Karachi';

/** Offset of `timeZone` from UTC, in milliseconds, at the instant `at`. */
function tzOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)!.value);
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wallAsUtc - (at.getTime() - at.getUTCMilliseconds());
}

/**
 * The UTC instant at which local calendar day `date` (YYYY-MM-DD) begins in `timeZone`.
 * For "2026-10-15" in Asia/Karachi (UTC+5) this is 2026-10-14T19:00:00Z.
 *
 * Use it for real timestamps (createdAt, receivedAt). Calendar-date fields are stored as UTC
 * midnight of the local day (see parseDateOnly) and must keep using that.
 */
export function startOfLocalDay(date: string, timeZone = DEFAULT_TIMEZONE): Date {
  const wall = parseDateOnly(date).getTime();
  // The second pass corrects for an offset change (daylight saving) between guess and result.
  const guess = wall - tzOffsetMs(timeZone, new Date(wall));
  return new Date(wall - tzOffsetMs(timeZone, new Date(guess)));
}

/**
 * UTC bounds for local calendar days `from`..`to` (both inclusive) in `timeZone`, for a
 * half-open timestamp query: `{ $gte: start, $lt: end }`.
 */
export function localDayRange(from: string, to: string, timeZone = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  return {
    start: startOfLocalDay(from, timeZone),
    end: startOfLocalDay(formatDateOnly(addDays(parseDateOnly(to), 1)), timeZone),
  };
}

/** UTC instant at which local month `period` (YYYY-MM) begins in `timeZone`. */
export function startOfLocalMonth(period: string, timeZone = DEFAULT_TIMEZONE): Date {
  return startOfLocalDay(`${period}-01`, timeZone);
}

/**
 * The instant at which the clock in `timeZone` shows the given local date and time (e.g. a
 * punch "2026-10-15 08:01:33" from a machine set to Pakistan time). Two passes, as
 * startOfLocalDay, so a daylight-saving change between guess and result is corrected.
 */
export function localWallTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone = DEFAULT_TIMEZONE,
): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const guess = asUtc - tzOffsetMs(timeZone, new Date(asUtc));
  return new Date(asUtc - tzOffsetMs(timeZone, new Date(guess)));
}
