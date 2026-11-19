/**
 * Turning spreadsheet cells into the values the application stores. Deterministic: the same
 * input always gives the same result, and anything that cannot be read with confidence is an
 * error the user sees (never a guess). Cells arrive as trimmed strings (see import-files.ts).
 */

export type Parsed<T> = { ok: true; value: T; note?: string } | { ok: false; error: string };

const ok = <T>(value: T, note?: string): Parsed<T> => ({ ok: true, value, ...(note ? { note } : {}) });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

/** Collapse inner whitespace; enforce the field's maximum length. */
export function parseText(raw: string, max: number, min = 1): Parsed<string> {
  const v = raw.replace(/\s+/g, ' ').trim();
  if (v.length < min) return fail(min > 1 ? `Must be at least ${min} characters` : 'Is empty');
  if (v.length > max) return fail(`Is too long (${v.length} characters; at most ${max})`);
  return ok(v);
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function isoFrom(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // 31 Feb
  return date.toISOString().slice(0, 10);
}

/** Two-digit years: 00–(this year) are 20xx, the rest 19xx. */
function fullYear(y: string, now = new Date()) {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n <= now.getUTCFullYear() % 100 ? 2000 + n : 1900 + n;
}

/**
 * Dates as schools write them. Numeric dates are read day-first (31/12/2015), the convention in
 * Pakistan; YYYY-MM-DD is always year-month-day. A spreadsheet date cell arrives as YYYY-MM-DD.
 * An Excel serial number (e.g. 42370) is accepted when the column holds dates.
 */
export function parseDate(raw: string): Parsed<string> {
  const v = raw.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(v);
  if (m) return dateOrFail(isoFrom(+m[1], +m[2], +m[3]), v);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(v);
  if (m) return dateOrFail(isoFrom(fullYear(m[3]), +m[2], +m[1]), v);
  m = /^(\d{1,2})[- ./]?([A-Za-z]{3,9})[- ./,]*(\d{2}|\d{4})$/.exec(v);
  if (m && MONTHS[m[2].toLowerCase()]) return dateOrFail(isoFrom(fullYear(m[3]), MONTHS[m[2].toLowerCase()], +m[1]), v);
  m = /^([A-Za-z]{3,9})[- ./]?(\d{1,2})(?:st|nd|rd|th)?[- ./,]+(\d{4})$/.exec(v);
  if (m && MONTHS[m[1].toLowerCase()]) return dateOrFail(isoFrom(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), v);
  if (/^\d{4,5}(\.\d+)?$/.test(v)) {
    const serial = Math.floor(Number(v));
    if (serial >= 1 && serial < 80000) {
      // Excel's day 1 is 1900-01-01 and it counts a non-existent 29 Feb 1900.
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return ok(d.toISOString().slice(0, 10), `read "${v}" as an Excel date`);
    }
  }
  return fail(`"${v}" is not a date we can read. Use YYYY-MM-DD, e.g. 2015-03-12`);
}

function dateOrFail(iso: string | null, raw: string): Parsed<string> {
  return iso ? ok(iso) : fail(`"${raw}" is not a real calendar date`);
}

/** A date of birth must be in the past and plausible for a school. */
export function parseBirthDate(raw: string, today: string): Parsed<string> {
  const d = parseDate(raw);
  if (!d.ok) return d;
  if (d.value > today) return fail(`Date of birth ${d.value} is in the future`);
  if (d.value < '1940-01-01') return fail(`Date of birth ${d.value} is too far in the past`);
  return d;
}

/** Same rule as the API's phone validation (phonePk). */
const PHONE_RE = /^\+?[0-9][0-9\- ]{7,16}$/;

/**
 * Phone numbers. Spaces, dashes and brackets are removed. Two common spreadsheet damages are
 * repaired, each with a visible note: a Pakistani mobile that lost its leading 0 (3001234567 →
 * 03001234567, Excel drops it in number cells) and 92…/0092… without the "+".
 */
export function parsePhone(raw: string): Parsed<string> {
  const original = raw.trim();
  let v = original.replace(/[\s\-().]/g, '');
  if (/^\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, ''); // number cell exported as 3001234567.0
  let note: string | undefined;
  if (/^3\d{9}$/.test(v)) {
    v = `0${v}`;
    note = `added the leading 0 (${v})`;
  } else if (/^0092\d{10}$/.test(v)) {
    v = `+${v.slice(2)}`;
  } else if (/^92\d{10}$/.test(v)) {
    v = `+${v}`;
  }
  if (!PHONE_RE.test(v)) return fail(`"${original}" is not a valid phone number, e.g. 03001234567`);
  return ok(v, note);
}

/**
 * Identity key of a phone number, for recognising the same number written differently:
 * "03001234567", "+923001234567", "923001234567", "00923001234567" and "0300-123 4567" all
 * give "pk:3001234567". Other numbers compare by their digits. Never stored; only compared.
 */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  const pk = /^(?:0092|92|0)?(3\d{9})$/.exec(digits);
  return pk ? `pk:${pk[1]}` : digits;
}

/** Admission or employee numbers that differ only by leading zeros ("00123" and "123"). */
export const numberKey = (s: string) => (/^\d+$/.test(s.trim()) ? s.trim().replace(/^0+(?=\d)/, '') : null);

/** CNIC: 13 digits, stored as xxxxx-xxxxxxx-x. */
export function parseCnic(raw: string): Parsed<string> {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(digits)) return fail(`"${raw.trim()}" is not a CNIC (13 digits, xxxxx-xxxxxxx-x)`);
  return ok(`${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseEmail(raw: string): Parsed<string> {
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL_RE.test(v)) return fail(`"${raw.trim()}" is not a valid email address`);
  return ok(v);
}

/** Look a value up in a table of accepted words (case and punctuation insensitive). */
function lookup<T extends string>(raw: string, table: Record<string, T>, what: string, accepted: string): Parsed<T> {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const v = table[key];
  return v ? ok(v) : fail(`"${raw.trim()}" is not a recognised ${what}. Use ${accepted}`);
}

export const parseGender = (raw: string) =>
  lookup(
    raw,
    { m: 'male', male: 'male', boy: 'male', f: 'female', female: 'female', girl: 'female', other: 'other', o: 'other' },
    'gender',
    'Male, Female or Other',
  );

export const parseRelation = (raw: string) =>
  lookup(
    raw,
    {
      father: 'father',
      f: 'father',
      dad: 'father',
      mother: 'mother',
      m: 'mother',
      mom: 'mother',
      guardian: 'guardian',
      g: 'guardian',
      other: 'other',
      uncle: 'other',
      aunt: 'other',
      brother: 'other',
      sister: 'other',
      grandfather: 'other',
      grandmother: 'other',
    },
    'relation',
    'Father, Mother, Guardian or Other',
  );

export const parseStudentStatus = (raw: string) =>
  lookup(
    raw,
    {
      active: 'active',
      enrolled: 'active',
      'currently enrolled': 'active',
      current: 'active',
      studying: 'active',
      present: 'active',
      regular: 'active',
      left: 'left',
      withdrawn: 'left',
      'struck off': 'left',
      'struck off roll': 'left',
      dropped: 'left',
      'drop out': 'left',
      transferred: 'left',
      graduated: 'graduated',
      'passed out': 'graduated',
      alumni: 'graduated',
      suspended: 'suspended',
    },
    'student status',
    'Active (Enrolled), Left, Graduated or Suspended',
  );

export const parseStaffType = (raw: string) =>
  lookup(
    raw,
    {
      teaching: 'teaching',
      teacher: 'teaching',
      academic: 'teaching',
      faculty: 'teaching',
      'non teaching': 'non_teaching',
      nonteaching: 'non_teaching',
      'non academic': 'non_teaching',
      admin: 'non_teaching',
      administration: 'non_teaching',
      support: 'non_teaching',
      staff: 'non_teaching',
    },
    'staff type',
    'Teaching or Non-teaching',
  );

export const parseEmployeeStatus = (raw: string) =>
  lookup(
    raw,
    {
      active: 'active',
      working: 'active',
      current: 'active',
      'on leave': 'on_leave',
      leave: 'on_leave',
      resigned: 'resigned',
      left: 'resigned',
      terminated: 'terminated',
    },
    'staff status',
    'Active, On leave, Resigned or Terminated',
  );

/** Whole rupees: "Rs 5,000", "5000", "5,000.00". */
export function parseAmount(raw: string): Parsed<number> {
  const v = raw
    .replace(/rs\.?|pkr|,|\s/gi, '')
    .replace(/\.0+$/, '')
    .trim();
  if (!/^\d+$/.test(v)) return fail(`"${raw.trim()}" is not an amount in whole rupees`);
  const n = Number(v);
  if (n > 10_000_000) return fail(`${n} is too large`);
  return ok(n);
}

export function parseInteger(raw: string, min: number, max: number, what: string): Parsed<number> {
  const v = raw.trim().replace(/\.0+$/, '');
  if (!/^-?\d+$/.test(v)) return fail(`"${raw.trim()}" is not a whole number`);
  const n = Number(v);
  if (n < min || n > max) return fail(`${what} must be between ${min} and ${max}`);
  return ok(n);
}

/**
 * Ordering level of a class from its name, when no level column is given: Playgroup -2,
 * Nursery -1, Prep/KG 0, "Class 5"/"Grade 5"/"5" 5. Anything else needs an explicit level.
 */
export function levelFromClassName(name: string): number | null {
  const n = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (/^(p ?g|play ?group|playgroup|play)( \d)?$/.test(n)) return -2;
  if (/^(nursery|nur)( \d)?$/.test(n)) return -1;
  if (/^(prep|k ?g|kindergarten|kg)( ?\d)?$/.test(n)) return 0;
  const num = /^(?:class|grade|std|standard)? ?(\d{1,2})(?:st|nd|rd|th)?$/.exec(n);
  if (num && Number(num[1]) <= 20) return Number(num[1]);
  return null;
}

/**
 * Comparison key for names of classes, sections, sessions and campuses: case, spaces and
 * punctuation are ignored, so "P.G" = "PG", "Class-5" = "class 5", "2025-2026" = "2025 2026".
 */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const MUHAMMAD = new Set(['m', 'md', 'mhd', 'mohd', 'muhd', 'muhammad', 'mohammad', 'muhammed', 'mohammed', 'mohamed']);

/**
 * A looser key for people's names, used only when the exact name (nameKey) finds nobody:
 * the usual short forms of Muhammad are the same ("M. Ali" = "Muhammad Ali" = "Mohd Ali").
 */
export const personNameKey = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (MUHAMMAD.has(w) ? 'muhammad' : w))
    .join('');

/**
 * A fee amount in whole rupees as schools write it in registers: "Rs 2,500", "2500/-",
 * "3000 + 600" (added up), "-" or "nil" (0). Negative amounts (advance payments) are refused.
 */
export function parseFeeAmount(raw: string, max = 10_000_000): Parsed<number> {
  const original = raw.trim();
  const v = original
    .replace(/rs\.?|pkr|\/-|,|\s/gi, '')
    .replace(/(\d)\.0+(?=\+|$)/g, '$1')
    .toLowerCase();
  if (/^[-–—]+$/.test(v) || v === 'nil' || v === 'none')
    return ok(0, original === '0' ? undefined : `"${original}" read as 0`);
  if (/^-\d/.test(v))
    return fail(`"${original}" is negative. Advance payments cannot be imported: enter 0 and note the advance`);
  const parts = v.split('+');
  if (!parts.every((p) => /^\d+$/.test(p)))
    return fail(`"${original}" is not an amount in whole rupees (e.g. 2500 or 3000+600)`);
  const n = parts.reduce((s, p) => s + Number(p), 0);
  if (n > max) return fail(`Rs ${n.toLocaleString('en-PK')} is too large (at most Rs ${max.toLocaleString('en-PK')})`);
  return ok(n, parts.length > 1 ? `${original} added up to Rs ${n.toLocaleString('en-PK')}` : undefined);
}
