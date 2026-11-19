/**
 * Pure helpers for the timetable import (no database, no framework imports).
 * Turns the free-form text found in a CSV cell into days, times and lookup keys.
 */

/** Lower-case and drop spaces / punctuation so "Mont-I", "mont i" and "MONT.I" match. */
export const norm = (s: string): string => s.toLowerCase().replace(/[\s\-_.,()'"/\\]+/g, '');

const DAY_BY_KEY: Record<string, number> = {
  mon: 1, monday: 1, '1': 1,
  tue: 2, tues: 2, tuesday: 2, '2': 2,
  wed: 3, wednesday: 3, '3': 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, '4': 4,
  fri: 5, friday: 5, '5': 5,
  sat: 6, saturday: 6, '6': 6,
  sun: 7, sunday: 7, '7': 7,
};

export interface DayParse {
  days: number[];
  /** True when the cell named several days (a range, a list or "All"). */
  group: boolean;
  error?: string;
}

/**
 * Accepts: "Monday", "Mon", "1", "Mon-Fri", "Mon,Wed,Fri", "Mon-Thu, Sat", "All".
 * "All" means every working day of the school.
 */
export function parseDays(input: string, workingDays: number[]): DayParse {
  const text = input.trim().toLowerCase();
  if (!text) return { days: [], group: false, error: 'Day is required' };
  if (/^(all|every\s*day|everyday|daily|all\s*(school\s*)?days)$/.test(text)) {
    return { days: [...workingDays].sort((a, b) => a - b), group: true };
  }
  const out = new Set<number>();
  let group = false;
  for (const token of text.split(/[,;&/]|\band\b/).map((t) => t.trim()).filter(Boolean)) {
    const parts = token.split(/\s*(?:-|–|—|\bto\b)\s*/).filter(Boolean);
    if (parts.length === 1) {
      const d = DAY_BY_KEY[norm(parts[0])];
      if (!d) return { days: [], group, error: `"${parts[0]}" is not recognised (use Monday, Mon, 1-7, Mon-Fri, or All)` };
      out.add(d);
    } else if (parts.length === 2) {
      const a = DAY_BY_KEY[norm(parts[0])];
      const b = DAY_BY_KEY[norm(parts[1])];
      if (!a || !b) return { days: [], group, error: `"${token}" is not a valid range` };
      if (a > b) return { days: [], group, error: `"${token}" must go forward, e.g. Mon-Fri` };
      for (let d = a; d <= b; d++) out.add(d);
      group = true;
    } else {
      return { days: [], group, error: `"${token}" is not recognised` };
    }
  }
  if (out.size > 1) group = true;
  return { days: [...out].sort((a, b) => a - b), group };
}

export type TimeParse = { ok: true; value: string; assumedPm: boolean } | { ok: false; error: string };

/**
 * Accepts "08:45", "8:45", "8.45", "08:45:00", "8:45 AM", "1:30 PM", "13:30".
 * A time without AM/PM between 1:00 and 6:59 is read as the afternoon (school hours).
 */
export function parseTime(input: string): TimeParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Time is required' };
  const s = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/a\.?m\.?$/, 'am')
    .replace(/p\.?m\.?$/, 'pm')
    .replace(/(\d)\.(\d)/g, '$1:$2');
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?$/.exec(s);
  if (!m) return { ok: false, error: `Time "${raw}" is not valid (use 08:45 or 8:45 AM)` };
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const mer = m[3];
  if (min > 59) return { ok: false, error: `Time "${raw}" is not valid` };
  let assumedPm = false;
  if (mer) {
    if (h < 1 || h > 12) return { ok: false, error: `Time "${raw}" is not valid` };
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
  } else {
    if (h > 23) return { ok: false, error: `Time "${raw}" is not valid` };
    if (h >= 1 && h <= 6) {
      h += 12;
      assumedPm = true;
    }
  }
  return { ok: true, value: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, assumedPm };
}

const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** [1,2,3,4,5] -> "Mon–Fri"; [1,3] -> "Mon, Wed". */
export function dayLabel(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < d.length; ) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
    if (j - i >= 2) parts.push(`${SHORT_DAYS[d[i] - 1]}–${SHORT_DAYS[d[j] - 1]}`);
    else for (let k = i; k <= j; k++) parts.push(SHORT_DAYS[d[k] - 1]);
    i = j + 1;
  }
  return parts.join(', ');
}
