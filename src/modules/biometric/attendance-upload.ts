import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import type { SchoolContext } from '../../types/context';
import { formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { readSpreadsheet } from '../imports/import-files';
import { normaliseHeader } from '../imports/import-fields';
import { nameKey, parseDate, personNameKey } from '../imports/import-values';
import { isSchoolDay, WEEKDAY_NAMES, isoWeekdayOf, workingDays } from '../schools/school-days';
import { schoolTimezone } from '../schools/timezone';
import { PunchEvent, StaffAttendance, STAFF_ATTENDANCE_STATUSES } from './biometric.models';
import { detectDateOrder, parseClock, parsePunchTime, type DateOrder } from './punch-values';
import { recomputeStaffDay } from './staff-attendance.service';

type Ctx = SchoolContext;
type Status = (typeof STAFF_ATTENDANCE_STATUSES)[number];
export type UploadFormat = 'punches' | 'daily' | 'grid';

/**
 * Staff attendance from an uploaded file (Excel, CSV or PDF), without registering a device. Three
 * kinds of file are recognised from their columns:
 * - punches: a machine log, one row per punch (ID/name + date and time); a day is present, or late
 *   when the first punch is after "late after";
 * - daily: one row per person per day (date + status and/or time in/out);
 * - grid: a monthly register, one row per person and one column per day (P / A / L / LT / HD).
 * Nothing is saved by the preview. Saving marks each day by hand (punches never overwrite it), only
 * for staff of the user's campuses, never in the future or on an off day.
 */

/** Remembered "this name / ID in an uploaded file is this staff member". */
const StaffUploadLinkSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      key: { type: String, required: true },
      employeeId: { type: ObjectId, ref: 'Employee', required: true },
    },
    baseOptions,
  ),
);
StaffUploadLinkSchema.index({ schoolId: 1, key: 1 }, { unique: true });
export const StaffUploadLink = model('StaffUploadLink', StaffUploadLinkSchema);

export const UPLOAD_LIMITS = { maxRows: 20_000, maxEntries: 10_000 };

const COLS = {
  id: [
    'emp no',
    'employee no',
    'employee number',
    'emp id',
    'employee id',
    'staff id',
    'staff no',
    'ac no',
    'acno',
    'user id',
    'userid',
    'enroll no',
    'enrollno',
    'enrollment no',
    'enrolment no',
    'pin',
    'badge',
    'emp code',
    'employee code',
    'code',
    'id',
    'no',
    'person id',
    'personnel id',
  ],
  name: [
    'name',
    'employee name',
    'emp name',
    'staff name',
    'teacher',
    'teacher name',
    'full name',
    'person name',
    'user name',
    'employee',
  ],
  date: ['date', 'att date', 'attendance date', 'punch date', 'log date', 'day date'],
  dateTime: [
    'date time',
    'datetime',
    'date and time',
    'punch time',
    'check time',
    'log time',
    'att time',
    'timestamp',
    'record time',
    'clock time',
    'time',
  ],
  in: [
    'in',
    'time in',
    'in time',
    'check in',
    'checkin',
    'clock in',
    'arrival',
    'first in',
    'first punch',
    'on duty',
    'duty in',
    'entry',
  ],
  out: [
    'out',
    'time out',
    'out time',
    'check out',
    'checkout',
    'clock out',
    'departure',
    'last out',
    'last punch',
    'off duty',
    'duty out',
    'exit',
  ],
  status: [
    'status',
    'attendance',
    'att',
    'att status',
    'attendance status',
    'remarks',
    'remark',
    'present absent',
    'p a',
  ],
};
const findCol = (headers: string[], names: string[]) => headers.findIndex((h) => names.includes(normaliseHeader(h)));

/** P / A / L / LT / HD and the words schools use for them; null = no mark (holiday, off, blank). */
export function parseStatus(raw: string): Status | null | undefined {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[.\s]+/g, ' ')
    .trim();
  if (
    !v ||
    [
      '-',
      '--',
      'h',
      'hol',
      'holiday',
      'off',
      'wo',
      'w',
      'weekend',
      'sunday',
      'closed',
      'vacation',
      'n a',
      'na',
    ].includes(v)
  )
    return null;
  if (['p', 'present', 'pr', '✓', '✔', 'yes', 'y', 'on time', 'ontime', 'duty'].includes(v)) return 'present';
  if (['a', 'ab', 'abs', 'absent', 'x', 'no', 'n'].includes(v)) return 'absent';
  if (
    [
      'l',
      'lv',
      'leave',
      'cl',
      'sl',
      'el',
      'casual leave',
      'sick leave',
      'earned leave',
      'short leave',
      'on leave',
      'ml',
    ].includes(v)
  )
    return 'leave';
  if (['lt', 'late', 'late coming', 'late arrival', 'lc'].includes(v)) return 'late';
  if (['hd', 'half', 'half day', 'halfday', '1/2', 'h d'].includes(v)) return 'half_day';
  return undefined; // not a status we know
}

/** "08:01", "8:01 AM", "08:01:33" or an Excel time (0.334) → "08:01"; null if not a time. */
export function parseHHmm(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^0?\.\d+$/.test(v)) {
    const minutes = Math.round(Number(v) * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const c = parseClock(v.replace(/^.*\s(?=\d{1,2}:\d{2})/, ''));
  return c ? `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}` : null;
}

/* ───────────────────────────── Reading the file ───────────────────────────── */

type Table = { kind: 'xlsx' | 'csv' | 'pdf'; rows: string[][]; title: string; notes: string[] };

// Native import(): pdf.js is an ES module, and this project compiles to CommonJS.
const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const PDFJS = 'pdfjs-dist/legacy/build/pdf.mjs';
/** Native import first; where that is not available (test sandboxes), the bundler's import(). */
async function loadPdfJs() {
  try {
    return await importEsm(PDFJS);
  } catch {
    return import(PDFJS as string);
  }
}

/** A PDF's text, rebuilt into lines and cells from where each word sits on the page. */
async function readPdf(buffer: Buffer): Promise<string[][]> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  const lines: string[][] = [];
  for (let p = 1; p <= doc.numPages && p <= 60; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = (content.items as Array<{ str: string; transform: number[]; width: number }>)
      .filter((i) => i.str.trim())
      .map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Array<typeof items> = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r[0].y - it.y) < 3);
      if (row) row.push(it);
      else rows.push([it]);
    }
    for (const r of rows) {
      r.sort((a, b) => a.x - b.x);
      const cells: string[] = [];
      let end = -Infinity;
      for (const it of r) {
        if (cells.length && it.x - end < 4) cells[cells.length - 1] += ` ${it.s}`;
        else cells.push(it.s);
        end = it.x + it.w;
      }
      lines.push(cells);
    }
  }
  await doc.destroy();
  return lines;
}

async function readTable(buffer: Buffer, fileName: string): Promise<Table> {
  const isPdf = /\.pdf$/i.test(fileName) || buffer.subarray(0, 5).toString() === '%PDF-';
  if (isPdf) {
    if (buffer.length > 5 * 1024 * 1024) throw badRequest('The file is larger than 5 MB', { field: 'file' });
    let lines: string[][];
    try {
      lines = await readPdf(buffer);
    } catch {
      throw badRequest('This PDF cannot be read. Export the attendance as Excel or CSV instead.', { field: 'file' });
    }
    if (!lines.length)
      throw badRequest(
        'This PDF has no text (it is probably a scanned image). Export the attendance as Excel or CSV instead.',
        { field: 'file' },
      );
    return { kind: 'pdf', rows: lines, title: lines.slice(0, 5).flat().join(' '), notes: [] };
  }
  const sheet = await readSpreadsheet(buffer, fileName);
  return {
    kind: sheet.kind,
    rows: [sheet.headers, ...sheet.rows.map((r) => r.values)],
    title: sheet.sheetName ?? '',
    notes: sheet.notes,
  };
}

/* ───────────────────────────── Recognising the layout ───────────────────────────── */

type Layout = {
  format: UploadFormat;
  header: number;
  headers: string[];
  id: number;
  name: number;
  date: number;
  dateTime: number;
  in: number;
  out: number;
  status: number;
  dayCols: Array<{ col: number; day: number }>;
};

/** Grid day headings: "1", "01", "1 Mon", "Mon 1", "1-Nov", "01/11". */
function dayOfHeading(h: string): number | null {
  const v = h.trim();
  const m =
    /^(?:[a-z]{2,3}\s*)?(\d{1,2})(?:\s*[a-z]{2,3})?$/i.exec(v) ?? /^(\d{1,2})[-/ ](?:\d{1,2}|[a-z]{3,9})$/i.exec(v);
  const d = m ? Number(m[1]) : NaN;
  return d >= 1 && d <= 31 ? d : null;
}

function detectLayout(rows: string[][]): Layout {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const headers = rows[r];
    const id = findCol(headers, COLS.id);
    const name = findCol(headers, COLS.name);
    if (id < 0 && name < 0) continue;
    const dayCols = headers
      .map((h, col) => ({ col, day: col === id || col === name ? null : dayOfHeading(h) }))
      .filter((d): d is { col: number; day: number } => d.day !== null);
    const base = {
      header: r,
      headers,
      id,
      name,
      date: findCol(headers, COLS.date),
      dateTime: findCol(headers, COLS.dateTime),
      in: findCol(headers, COLS.in),
      out: findCol(headers, COLS.out),
      status: findCol(headers, COLS.status),
      dayCols,
    };
    if (dayCols.length >= 5) return { ...base, format: 'grid' };
    if (base.date >= 0 && (base.in >= 0 || base.out >= 0 || base.status >= 0)) return { ...base, format: 'daily' };
    if (base.dateTime >= 0 || base.date >= 0) return { ...base, format: 'punches' };
  }
  throw badRequest(
    'The file’s columns were not recognised. It needs a staff column (Employee No, ID or Name) and either: Date + Status/Time in/Time out (one row per day), Date and time (one row per punch), or day columns 1…31 with P/A/L marks (monthly register).',
    { field: 'file' },
    'UPLOAD_UNRECOGNISED',
  );
}

/** The month of a grid: chosen, else from the file's title ("November 2026", "11/2026"), else none. */
function gridMonth(title: string, chosen?: string): string | null {
  if (chosen) return chosen;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,.-]*(\d{4})\b/i.exec(title);
  if (m) return `${m[2]}-${String(months.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}`;
  const n = /\b(\d{1,2})[/-](\d{4})\b/.exec(title);
  if (n && Number(n[1]) >= 1 && Number(n[1]) <= 12) return `${n[2]}-${n[1].padStart(2, '0')}`;
  return null;
}

/* ───────────────────────────── Preview ───────────────────────────── */

export interface PreviewEntry {
  staffKey: string;
  employeeId: string | null;
  date: string;
  status: Status;
  in?: string;
  out?: string;
  punches?: number;
  existing?: { status: string; source: string } | null;
  /** Why this day will not be saved (off day, future, unknown staff…). */
  skip?: string;
}

export async function previewUpload(
  ctx: Ctx,
  file: { buffer: Buffer; originalname: string },
  opts: { month?: string; dateOrder?: DateOrder; lateAfter?: string },
) {
  const timeZone = await schoolTimezone(ctx.schoolId);
  const today = todayInTz(timeZone);
  const days = await workingDays(ctx.schoolId);
  const table = await readTable(file.buffer, file.originalname);
  if (table.rows.length > UPLOAD_LIMITS.maxRows)
    throw badRequest(
      `The file has more than ${UPLOAD_LIMITS.maxRows.toLocaleString('en')} rows. Split it into smaller files.`,
    );
  const L = detectLayout(table.rows);
  const body = table.rows.slice(L.header + 1).filter((r) => r.some((c) => c?.trim()));
  const notes = [...table.notes];
  const cell = (r: string[], c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
  const staffKeyOf = (r: string[]) => {
    const id = cell(r, L.id);
    const name = cell(r, L.name);
    return { key: id ? `id:${nameKey(id)}` : name ? `name:${personNameKey(name)}` : '', id, name };
  };

  // Day/month order for dates like 03/04/2026: chosen, else decided from the whole file.
  const dateCells = body.map((r) => cell(r, L.date >= 0 ? L.date : L.dateTime)).filter(Boolean);
  const detected = detectDateOrder(dateCells);
  const order: DateOrder | null = opts.dateOrder ?? (detected === 'mixed' ? null : detected);
  if (detected === 'mixed' && !opts.dateOrder)
    notes.push('Dates are written both day-first and month-first: choose the date order.');
  const readDay = (raw: string): string | null => {
    if (!raw) return null;
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(raw.trim());
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const o = a > 12 ? 'dmy' : b > 12 ? 'mdy' : order;
      if (!o) return null;
      const [d, mo] = o === 'dmy' ? [a, b] : [b, a];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const p = parseDate(raw.split(/[ T]/)[0]);
    return p.ok ? p.value : null;
  };
  const late = (t?: string) => Boolean(opts.lateAfter && t && t > opts.lateAfter);

  type Acc = {
    staffKey: string;
    label: string;
    date: string;
    status?: Status;
    times: string[];
    in?: string;
    out?: string;
    problem?: string;
  };
  const acc = new Map<string, Acc>();
  const labels = new Map<string, { id: string; name: string }>();
  const unreadable: string[] = [];
  const add = (k: { key: string; id: string; name: string }, date: string, patch: Partial<Acc>) => {
    labels.set(k.key, { id: k.id, name: k.name });
    const id = `${k.key}|${date}`;
    const cur = acc.get(id) ?? { staffKey: k.key, label: k.id || k.name, date, times: [] };
    acc.set(id, { ...cur, ...patch, times: [...cur.times, ...(patch.times ?? [])] });
  };

  let month: string | null = null;
  if (L.format === 'grid') {
    month = gridMonth(table.title, opts.month);
    if (!month)
      throw badRequest(
        'Choose the month of this register (the file does not say which month it is).',
        { field: 'month' },
        'UPLOAD_MONTH_REQUIRED',
      );
    const [y, mo] = month.split('-').map(Number);
    for (const r of body) {
      const k = staffKeyOf(r);
      if (!k.key) continue;
      for (const { col, day } of L.dayCols) {
        const dt = new Date(Date.UTC(y, mo - 1, day));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== day) continue; // e.g. 31 in a 30-day month
        const date = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const raw = cell(r, col);
        const s = parseStatus(raw);
        if (s === null) continue;
        if (s === undefined) {
          if (unreadable.length < 20) unreadable.push(`"${raw}" (${k.id || k.name}, ${date})`);
          continue;
        }
        add(k, date, { status: s });
      }
    }
  } else if (L.format === 'daily') {
    for (const r of body) {
      const k = staffKeyOf(r);
      const date = readDay(cell(r, L.date));
      if (!k.key || !date) continue;
      const tin = parseHHmm(cell(r, L.in)) ?? undefined;
      const tout = parseHHmm(cell(r, L.out)) ?? undefined;
      const raw = cell(r, L.status);
      let s = raw ? parseStatus(raw) : null;
      if (s === undefined) {
        if (unreadable.length < 20) unreadable.push(`"${raw}" (${k.id || k.name}, ${date})`);
        s = null;
      }
      if (!s && (tin || tout)) s = late(tin) ? 'late' : 'present';
      if (s === 'present' && late(tin)) s = 'late';
      if (!s) continue;
      add(k, date, { status: s, in: tin, out: tout });
    }
  } else {
    for (const r of body) {
      const k = staffKeyOf(r);
      if (!k.key) continue;
      // A date-and-time column; or a Date column with a separate Time column; or Date + Time in.
      const dt = cell(r, L.dateTime);
      const hasDateInDt = /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(dt);
      const raw = L.dateTime >= 0 && (hasDateInDt || L.date < 0) ? dt : cell(r, L.date);
      const timeRaw = raw === dt ? undefined : (L.dateTime >= 0 ? dt : cell(r, L.in)) || undefined;
      const p = parsePunchTime(raw, timeRaw, { order, timeZone });
      if (!p.ok) {
        if (unreadable.length < 20) unreadable.push(`"${raw}" (${k.id || k.name}): ${p.error}`);
        continue;
      }
      const wall = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(p.at);
      add(k, p.localDate, { times: [wall] });
    }
    for (const a of acc.values()) {
      a.times.sort();
      a.in = a.times[0];
      a.out = a.times.length > 1 ? a.times[a.times.length - 1] : undefined;
      a.status = late(a.in) ? 'late' : 'present';
    }
  }
  if (unreadable.length)
    notes.push(`Not read (left out): ${unreadable.join('; ')}${unreadable.length >= 20 ? ' …' : ''}`);
  if (acc.size > UPLOAD_LIMITS.maxEntries)
    throw badRequest(
      `More than ${UPLOAD_LIMITS.maxEntries.toLocaleString('en')} staff days in one file. Split it by month.`,
    );

  // ── Who is who ──
  const staff = await Employee.find(scope(ctx, { status: { $in: ['active', 'on_leave'] }, ...campusScope(ctx) }))
    .select('employeeNo firstName lastName designation')
    .sort({ firstName: 1 })
    .lean();
  const links = await StaffUploadLink.find(scope(ctx, { key: { $in: [...labels.keys()] } })).lean();
  const linked = new Map(links.map((l) => [l.key, String(l.employeeId)]));
  const staffIds = new Set(staff.map((s) => String(s._id)));
  const nameOf = (s: (typeof staff)[number]) => `${s.firstName} ${s.lastName ?? ''}`.trim();
  const digits = (v: string) => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  const unique = <T>(list: T[]) => (list.length === 1 ? list[0] : undefined);
  const matches = [...labels].map(([key, l]) => {
    const saved = linked.get(key);
    if (saved && staffIds.has(saved)) return { key, ...l, employeeId: saved, matchedBy: 'saved' as const };
    if (l.id) {
      const exact = unique(staff.filter((s) => nameKey(s.employeeNo) === nameKey(l.id)));
      const byDigits = digits(l.id) ? unique(staff.filter((s) => digits(s.employeeNo) === digits(l.id))) : undefined;
      const hit = exact ?? byDigits;
      if (hit) return { key, ...l, employeeId: String(hit._id), matchedBy: 'employee no' as const };
    }
    if (l.name) {
      const hit = unique(staff.filter((s) => personNameKey(nameOf(s)) === personNameKey(l.name)));
      if (hit) return { key, ...l, employeeId: String(hit._id), matchedBy: 'name' as const };
    }
    return { key, ...l, employeeId: null, matchedBy: null };
  });
  const employeeOf = new Map(matches.map((m) => [m.key, m.employeeId]));

  // ── Each day ──
  const entries = [...acc.values()].sort((a, b) => a.label.localeCompare(b.label) || a.date.localeCompare(b.date));
  const dates = entries.map((e) => e.date);
  const existing = entries.length
    ? await StaffAttendance.find(
        scope(ctx, {
          employeeId: { $in: [...new Set([...employeeOf.values()].filter(Boolean))].map((id) => oid(id!)) },
          date: {
            $gte: parseDateOnly(dates.reduce((a, b) => (a < b ? a : b))),
            $lte: parseDateOnly(dates.reduce((a, b) => (a > b ? a : b))),
          },
        }),
      )
        .select('employeeId date status source')
        .lean()
    : [];
  const existingOf = new Map(
    existing.map((x) => [`${x.employeeId}|${formatDateOnly(x.date)}`, { status: x.status, source: x.source }]),
  );
  const out: PreviewEntry[] = entries.map((e) => {
    const employeeId = employeeOf.get(e.staffKey) ?? null;
    const skip =
      e.date > today
        ? 'In the future'
        : !isSchoolDay(days, e.date)
          ? `${WEEKDAY_NAMES[isoWeekdayOf(e.date) - 1]} is an off day`
          : !employeeId
            ? 'Staff member not found: choose who this is'
            : undefined;
    return {
      staffKey: e.staffKey,
      employeeId,
      date: e.date,
      status: e.status!,
      ...(e.in ? { in: e.in } : {}),
      ...(e.out ? { out: e.out } : {}),
      ...(L.format === 'punches' ? { punches: e.times.length } : {}),
      existing: employeeId ? (existingOf.get(`${employeeId}|${e.date}`) ?? null) : null,
      ...(skip ? { skip } : {}),
    };
  });
  const count = (f: (e: PreviewEntry) => boolean) => out.filter(f).length;
  return {
    format: L.format,
    fileKind: table.kind,
    fileName: file.originalname,
    month,
    dateOrder: order,
    columns: Object.fromEntries(
      (['id', 'name', 'date', 'dateTime', 'in', 'out', 'status'] as const)
        .filter((k) => L[k] >= 0)
        .map((k) => [k, L.headers[L[k]]]),
    ) as Record<string, string>,
    notes,
    staff: matches.map((m) => ({
      key: m.key,
      id: m.id,
      name: m.name,
      employeeId: m.employeeId,
      matchedBy: m.matchedBy,
      days: count((e) => e.staffKey === m.key),
    })),
    employees: staff.map((s) => ({
      _id: String(s._id),
      name: nameOf(s),
      employeeNo: s.employeeNo,
      designation: s.designation,
    })),
    entries: out,
    summary: {
      staff: matches.length,
      matched: matches.filter((m) => m.employeeId).length,
      days: out.length,
      ready: count((e) => !e.skip),
      replaces: count((e) => !e.skip && Boolean(e.existing) && e.existing!.status !== e.status),
      offDays: count((e) => Boolean(e.skip?.includes('off day'))),
      future: count((e) => e.skip === 'In the future'),
      unmatched: count((e) => !e.employeeId),
    },
  };
}

/* ───────────────────────────── Save ───────────────────────────── */

export async function saveUpload(
  ctx: Ctx,
  input: {
    fileName: string;
    entries: Array<{ employeeId: string; date: string; status: Status; in?: string; out?: string }>;
    links?: Array<{ key: string; employeeId: string }>;
  },
) {
  if (input.entries.length > UPLOAD_LIMITS.maxEntries)
    throw badRequest(`At most ${UPLOAD_LIMITS.maxEntries} days at once`);
  const timeZone = await schoolTimezone(ctx.schoolId);
  const today = todayInTz(timeZone);
  const days = await workingDays(ctx.schoolId);
  const ids = [
    ...new Set([...input.entries.map((e) => e.employeeId), ...(input.links ?? []).map((l) => l.employeeId)]),
  ];
  const staff = await Employee.find(scope(ctx, { _id: { $in: ids.map(oid) }, ...campusScope(ctx) }))
    .select('_id')
    .lean();
  const allowed = new Set(staff.map((s) => String(s._id)));
  const refused: Array<{ employeeId: string; date: string; reason: string }> = [];
  const seen = new Set<string>();
  const ops: Parameters<typeof StaffAttendance.bulkWrite>[0] = [];
  const note = `Uploaded from ${input.fileName}`.slice(0, 300);
  for (const e of input.entries) {
    const reason = !allowed.has(e.employeeId)
      ? 'Not a staff member of your campuses'
      : e.date > today
        ? 'In the future'
        : !isSchoolDay(days, e.date)
          ? 'Off day'
          : seen.has(`${e.employeeId}|${e.date}`)
            ? 'Twice in the upload'
            : null;
    if (reason) {
      refused.push({ employeeId: e.employeeId, date: e.date, reason });
      continue;
    }
    seen.add(`${e.employeeId}|${e.date}`);
    ops.push({
      updateOne: {
        filter: scope(ctx, { employeeId: oid(e.employeeId), date: parseDateOnly(e.date) }),
        update: {
          $set: {
            status: e.status,
            source: 'manual',
            note,
            times: { ...(e.in ? { in: e.in } : {}), ...(e.out ? { out: e.out } : {}) },
            markedBy: oid(ctx.userId),
            markedAt: new Date(),
            conflictDismissed: false,
          },
          $unset: { conflict: 1 },
          $setOnInsert: { schoolId: oid(ctx.schoolId), employeeId: oid(e.employeeId), date: parseDateOnly(e.date) },
        },
        upsert: true,
      },
    });
  }
  const result = ops.length ? await StaffAttendance.bulkWrite(ops, { ordered: false }) : null;
  // Days that also have machine punches: keep their punch summary up to date (the mark stays).
  const punched = await PunchEvent.find(
    scope(ctx, {
      employeeId: { $in: [...allowed].map(oid) },
      localDate: { $in: [...new Set(input.entries.map((e) => e.date))] },
    }),
  )
    .select('employeeId localDate')
    .lean();
  for (const k of new Set(punched.map((p) => `${p.employeeId}|${p.localDate}`))) {
    if (!seen.has(k)) continue;
    const [emp, date] = k.split('|');
    await recomputeStaffDay(ctx, emp, date);
  }
  for (const l of input.links ?? [])
    if (allowed.has(l.employeeId))
      await StaffUploadLink.updateOne(
        scope(ctx, { key: l.key }),
        { $set: { employeeId: oid(l.employeeId) }, $setOnInsert: { schoolId: oid(ctx.schoolId), key: l.key } },
        { upsert: true },
      );
  const saved = ops.length;
  await audit(ctx, {
    action: 'staff_attendance.upload',
    entityType: 'StaffAttendance',
    summary: `Uploaded staff attendance from ${input.fileName}: ${saved} days`,
    metadata: { fileName: input.fileName, saved, refused: refused.length, created: result?.upsertedCount ?? 0 },
  });
  return { saved, created: result?.upsertedCount ?? 0, updated: saved - (result?.upsertedCount ?? 0), refused };
}
