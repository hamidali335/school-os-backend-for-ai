/**
 * CSV export with spreadsheet formula-injection protection: cells starting with
 * = + - @ (or tab/CR) are prefixed with an apostrophe so Excel treats them as text.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: Array<{ key: string; header: string }>, rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(','));
  // BOM so Excel opens UTF-8 (Urdu names) correctly.
  return '﻿' + lines.join('\r\n');
}
