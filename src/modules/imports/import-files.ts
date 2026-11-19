import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { badRequest } from '../../utils/errors';

/**
 * Reading uploaded spreadsheets (.xlsx and .csv) into plain text cells. The real content is
 * checked, never the file name or browser-supplied type alone. Nothing in a file is executed:
 * formulas are not evaluated (the value Excel saved is used), macro-enabled workbooks and the old
 * binary .xls format are refused, and zip archives are inspected for decompression bombs before
 * they are opened.
 */
export const IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 5000,
  maxColumns: 100,
  /** Longer cells are cut here when stored; field rules reject over-long values anyway. */
  maxCellChars: 2000,
  /** Everything in the workbook, uncompressed. Real 5,000-row files are well under this. */
  maxUnzippedBytes: 30 * 1024 * 1024,
  /** One worksheet or the shared-strings part, uncompressed. */
  maxPartBytes: 25 * 1024 * 1024,
  /** Filled cells in any one worksheet (e.g. 5,000 rows × 50 columns). */
  maxCells: 250_000,
  maxZipEntries: 2000,
} as const;

export interface ParsedSheet {
  kind: 'xlsx' | 'csv';
  sheetName?: string;
  /** Spreadsheet row number (1-based) of the header row. */
  headerRow: number;
  headers: string[];
  rows: Array<{ rowNo: number; values: string[] }>;
  /** File-level remarks shown to the user (sheet used, formulas, encoding…). */
  notes: string[];
}

const unsupported = (message: string) => badRequest(message, { field: 'file' }, 'IMPORT_UNSUPPORTED_FILE');

export async function readSpreadsheet(buffer: Buffer, fileName: string): Promise<ParsedSheet> {
  if (!buffer.length) throw unsupported('The file is empty');
  if (buffer.length > IMPORT_LIMITS.maxBytes)
    throw unsupported('The file is larger than 5 MB. Split it into smaller files');
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  const isZip = buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
  const isOle = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  if (isOle || ext === 'xls')
    throw unsupported(
      'Old Excel files (.xls) are not supported. Open the file in Excel and use Save As → Excel Workbook (.xlsx) or CSV',
    );
  if (ext === 'xlsm' || ext === 'xlsb')
    throw unsupported('Macro-enabled or binary workbooks are not accepted. Save the file as .xlsx or CSV');
  if (ext === 'xlsx') {
    if (!isZip) throw unsupported('This file is not a real Excel (.xlsx) file');
    return readXlsx(buffer);
  }
  if (ext === 'csv' || ext === 'txt' || ext === 'dat') {
    if (isZip) throw unsupported('This file is an Excel workbook named as CSV. Rename it to .xlsx or save it as CSV');
    return readCsv(buffer, ext === 'txt' || ext === 'dat');
  }
  throw unsupported('Only Excel (.xlsx), CSV (.csv) and text (.txt, .dat) files can be imported');
}

/* ───────────────────────────── Zip inspection ───────────────────────────── */

export interface ZipEntry {
  name: string;
  size: number;
  compressed: number;
  method: number;
  offset: number;
}

/** Lists a zip's entries from its central directory without decompressing anything. */
export function inspectZip(buffer: Buffer): ZipEntry[] {
  const min = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unsupported('The Excel file is damaged (it is not a complete workbook)');
  const count = buffer.readUInt16LE(eocd + 10);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff)
    throw unsupported('This Excel file is too large or unusual to import');
  if (count > IMPORT_LIMITS.maxZipEntries)
    throw unsupported('This Excel file has too many internal parts to import safely');
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50)
      throw unsupported('The Excel file is damaged (its contents list is unreadable)');
    const method = buffer.readUInt16LE(p + 10);
    const compressed = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const offset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, size, compressed, method, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompress one zip entry with a hard output cap. The cap holds even when the zip's own size
 * fields are false (a "zip bomb" that claims to be small): decompression stops at the cap.
 */
function readEntry(buffer: Buffer, e: ZipEntry, cap: number): Buffer {
  if (e.offset + 30 > buffer.length || buffer.readUInt32LE(e.offset) !== 0x04034b50)
    throw unsupported('The Excel file is damaged (a part of it is missing)');
  const start = e.offset + 30 + buffer.readUInt16LE(e.offset + 26) + buffer.readUInt16LE(e.offset + 28);
  const data = buffer.subarray(start, start + e.compressed);
  if (e.method === 0) {
    if (data.length > cap) throw unsupported('A sheet in this workbook is too large to import safely');
    return data;
  }
  if (e.method !== 8) throw unsupported('This Excel file uses an unusual compression and cannot be read');
  try {
    return inflateRawSync(data, { maxOutputLength: cap });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw unsupported('A sheet in this workbook expands to an unsafe size and was not opened');
    throw unsupported('The Excel file is damaged and could not be read');
  }
}

const countMatches = (xml: string, re: RegExp) => {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(xml)) n++;
  return n;
};

/**
 * Cheap checks before the workbook is parsed: every worksheet is decompressed (capped) and its
 * rows and cells are counted from the XML, so an oversized file is refused before the parser
 * builds anything in memory. Returns the counts (for tests and logs).
 */
export function preflightXlsx(buffer: Buffer, entries = inspectZip(buffer)) {
  const sheets: Array<{ name: string; rows: number; cells: number }> = [];
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    const isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(lower);
    if (!isSheet && lower !== 'xl/sharedstrings.xml') continue;
    const part = readEntry(buffer, e, IMPORT_LIMITS.maxPartBytes);
    if (!isSheet) continue;
    const xml = part.toString('utf8');
    const rows = countMatches(xml, /<(?:\w+:)?row[\s>]/g);
    const cells = countMatches(xml, /<(?:\w+:)?c[\s>]/g);
    if (rows > IMPORT_LIMITS.maxRows + 20)
      throw unsupported(
        `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString('en')} rows. Split it into smaller files`,
      );
    if (cells > IMPORT_LIMITS.maxCells)
      throw unsupported(
        `A sheet has more than ${IMPORT_LIMITS.maxCells.toLocaleString('en')} filled cells. Remove the columns or sheets you do not need`,
      );
    sheets.push({ name: e.name, rows, cells });
  }
  return sheets;
}

async function readXlsx(buffer: Buffer): Promise<ParsedSheet> {
  const entries = inspectZip(buffer);
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total > IMPORT_LIMITS.maxUnzippedBytes)
    throw unsupported('This Excel file expands to an unsafe size and was not opened');
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml'))
    throw unsupported('This file is not a real Excel (.xlsx) workbook');
  if ([...names].some((n) => n.endsWith('vbaproject.bin')))
    throw unsupported('Workbooks containing macros are not accepted. Save the file as .xlsx without macros, or as CSV');
  preflightXlsx(buffer, entries);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw unsupported('The Excel file could not be read. Open it in Excel, save it again as .xlsx, and retry');
  }
  const sheets = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  const sheet =
    sheets.find((ws) => ws.name.trim().toLowerCase() === 'data') ??
    sheets.find((ws) => !/instruction|guide|help|read ?me/i.test(ws.name) && ws.actualRowCount > 0);
  if (!sheet) throw unsupported('The workbook has no sheet with data');
  const notes: string[] = [];
  const others = sheets.filter(
    (ws) => ws !== sheet && ws.actualRowCount > 0 && !/instruction|guide|help/i.test(ws.name),
  );
  notes.push(
    others.length
      ? `Read the sheet "${sheet.name}". Other sheets were not read: ${others.map((o) => `"${o.name}"`).join(', ')}.`
      : `Read the sheet "${sheet.name}".`,
  );
  let formulas = 0;
  let errors = 0;
  const grid: string[][] = [];
  const lastRow = Math.min(sheet.rowCount, IMPORT_LIMITS.maxRows + 20);
  const width = Math.min(sheet.columnCount, IMPORT_LIMITS.maxColumns + 1);
  if (sheet.columnCount > IMPORT_LIMITS.maxColumns)
    throw unsupported(
      `The sheet has more than ${IMPORT_LIMITS.maxColumns} columns. Remove the columns you do not need`,
    );
  for (let r = 1; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    const out: string[] = [];
    for (let c = 1; c <= width; c++) {
      const { text, formula, error } = cellText(row.getCell(c).value);
      if (formula) formulas++;
      if (error) errors++;
      out.push(text);
    }
    grid.push(out);
  }
  if (sheet.rowCount > IMPORT_LIMITS.maxRows + 20) grid.push(['__too_many__']);
  if (formulas)
    notes.push(`${formulas} cell(s) contain formulas. Their saved values were used; formulas are never run.`);
  if (errors) notes.push(`${errors} cell(s) show an Excel error (such as #N/A) and were read as empty.`);
  const table = tableFrom(grid);
  return { kind: 'xlsx', sheetName: sheet.name, ...table, notes: [...notes, ...table.notes] };
}

/** One cell as text. Dates become YYYY-MM-DD; formulas give their saved result. */
export function cellText(value: unknown): { text: string; formula?: boolean; error?: boolean } {
  if (value === null || value === undefined) return { text: '' };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { text: '' };
    // Excel stores the clock time as shown (ExcelJS returns it as UTC). A date-only cell stays a
    // date; a time-only cell (day 0, 1899-12-30/31) is just the time; otherwise date and time.
    const iso = value.toISOString();
    const time = iso.slice(11, 19);
    if (time === '00:00:00') return { text: iso.slice(0, 10) };
    if (iso.startsWith('1899-12-3')) return { text: time };
    return { text: `${iso.slice(0, 10)} ${time}` };
  }
  if (typeof value === 'number') return { text: Number.isFinite(value) ? numberText(value) : '' };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  if (typeof value === 'string') return { text: clean(value) };
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('formula' in v || 'sharedFormula' in v) return { ...cellText(v.result), formula: true };
    if (Array.isArray(v.richText))
      return { text: clean((v.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('')) };
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return { text: '', error: true };
  }
  return { text: '' };
}

/** Numbers without exponent notation (a 13-digit CNIC typed as a number stays intact). */
function numberText(n: number) {
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? BigInt(n).toString() : String(n);
  return String(Number(n.toFixed(6)));
}

function clean(s: string) {
  // Control characters (other than tab/newline, which become spaces) are removed.
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim()
    .slice(0, IMPORT_LIMITS.maxCellChars);
}

/* ───────────────────────────── CSV ───────────────────────────── */

function readCsv(buffer: Buffer, plainText = false): ParsedSheet {
  if (buffer.includes(0)) throw unsupported('This file is not a text CSV file');
  const notes: string[] = [];
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Excel on Windows saves "CSV" in the Windows-1252 code page.
    text = new TextDecoder('windows-1252').decode(buffer);
    notes.push(
      'The file was not saved as UTF-8; it was read as Windows (ANSI) text. Save as "CSV UTF-8" if Urdu text looks wrong.',
    );
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const { delimiter, found } = detectDelimiter(text);
  // A .txt export without commas, semicolons or tabs (attendance machines often write columns
  // separated by spaces): split each line at runs of spaces.
  const grid =
    plainText && !found
      ? text
          .split(/\r\n|\n|\r/)
          .slice(0, IMPORT_LIMITS.maxRows + 21)
          .map((line) => (line.trim() ? line.trim().split(/\s+/) : []))
      : parseCsv(text, delimiter, IMPORT_LIMITS.maxRows + 20);
  if (plainText && !found) notes.push('Columns were read as separated by spaces.');
  if (grid.some((r) => r.length > IMPORT_LIMITS.maxColumns))
    throw unsupported(`The file has more than ${IMPORT_LIMITS.maxColumns} columns. Remove the columns you do not need`);
  const table = tableFrom(grid.map((r) => r.map(clean)));
  return { kind: 'csv', ...table, notes: [...notes, ...table.notes] };
}

/**
 * The separator: comma, semicolon (European Excel) or tab. The first ten non-empty lines are
 * looked at, since exports often start with a title line that has no separators at all.
 */
function detectDelimiter(text: string): { delimiter: string; found: boolean } {
  const lines = text
    .slice(0, 20_000)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim())
    .slice(0, 10);
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    for (const line of lines) {
      let count = 0;
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) count++;
      }
      if (count > bestCount) {
        best = d;
        bestCount = count;
      }
    }
  }
  return { delimiter: best, found: bestCount > 0 };
}

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF/LF/CR line ends, line breaks inside quotes. */
export function parseCsv(text: string, delimiter = ',', maxRecords = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > maxRecords) break;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ───────────────────────────── Header and rows ───────────────────────────── */

const colLetter = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A cell holding a date with a time of day: data, never a column heading. */
const DATA_TIME = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})[ T]\d{1,2}:\d{2}/;
const DATE_ONLY = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})$/;
const TIME_ONLY = /^\d{1,2}:\d{2}(:\d{2})?$/;
/** A row with a date and a time (in one cell, or a date cell and a time cell) is data, not headings. */
const looksLikeData = (row: string[]) =>
  row.some((c) => DATA_TIME.test(c)) || (row.some((c) => DATE_ONLY.test(c)) && row.some((c) => TIME_ONLY.test(c)));

/**
 * Finds the header row (exports often start with a report title) and returns the data rows
 * with their spreadsheet row numbers. Blank rows are skipped.
 */
function tableFrom(grid: string[][]): Omit<ParsedSheet, 'kind' | 'sheetName'> {
  if (
    grid.some((r) => r[0] === '__too_many__') ||
    grid.filter((r) => r.some(Boolean)).length > IMPORT_LIMITS.maxRows + 1
  )
    throw unsupported(
      `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString('en')} rows. Split it into smaller files`,
    );
  const filled = (r: string[]) => r.filter((c) => c !== '').length;
  const head = grid.slice(0, 10);
  const widest = Math.max(0, ...head.map(filled));
  if (widest === 0) throw unsupported('The file has no data');
  const headerIdx = head.findIndex((r) => filled(r) >= Math.max(2, Math.ceil(widest * 0.6)));
  const found = headerIdx < 0 ? head.findIndex((r) => filled(r) > 0) : headerIdx;
  // Column headings never contain a date with a time ("2026-10-24 08:01"): such a first row is
  // data, as in attendance exports that have no heading row. Columns are then named A, B, C…
  const headerless = looksLikeData(grid[found]);
  const hi = headerless ? found - 1 : found;
  const width = Math.max(...grid.slice(Math.max(hi, 0)).map((r) => r.length));
  const rawHeaders = Array.from({ length: width }, (_, i) => (headerless ? '' : (grid[hi][i] ?? '')));
  // Drop trailing columns that have neither a header nor any data.
  let lastCol = width - 1;
  while (lastCol >= 0 && !rawHeaders[lastCol] && !grid.slice(hi + 1).some((r) => (r[lastCol] ?? '') !== '')) lastCol--;
  const seen = new Map<string, number>();
  const headers = rawHeaders.slice(0, lastCol + 1).map((h, i) => {
    const base = h || `Column ${colLetter(i)}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows: ParsedSheet['rows'] = [];
  grid.slice(hi + 1).forEach((r, i) => {
    const values = headers.map((_, c) => r[c] ?? '');
    if (values.some((v) => v !== '')) rows.push({ rowNo: hi + 2 + i, values });
  });
  if (!headers.length) throw unsupported('The file has no column headings');
  const notes = headerless
    ? ['The file has no heading row: its columns are named Column A, Column B… Match each one to its field.']
    : hi > 0
      ? [`The column headings were found on row ${hi + 1}; the rows above were skipped.`]
      : [];
  return { headerRow: hi + 1, headers, rows, notes };
}
