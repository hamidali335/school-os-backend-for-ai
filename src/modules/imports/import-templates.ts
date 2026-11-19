import ExcelJS from 'exceljs';
import { toCsv } from '../../utils/csv';
import { TYPE_DEFS, type FieldDef, type ImportType } from './import-fields';
import { IMPORT_LIMITS } from './import-files';

/**
 * Downloadable templates. Column headings are the field labels (required ones end in " *"),
 * so a filled-in template maps itself. Row 2 holds an example; the importer recognises and
 * skips it if it is left in.
 */
const headingOf = (f: FieldDef) => (f.required ? `${f.label} *` : f.label);
const templateFields = (type: ImportType) => TYPE_DEFS[type].fields.filter((f) => f.inTemplate !== false);

const GENERAL_RULES = [
  'Keep the first row (the column headings) as it is. Add one record per row, starting on row 3 (or replace the example on row 2).',
  'Columns marked * must be filled in on every row. Leave other cells empty if you do not have the information.',
  'Dates: YYYY-MM-DD is best (2015-03-12). 12/03/2015 is read as 12 March 2015 (day first). 12-Mar-2015 also works.',
  'Phone numbers: 03001234567 or +923001234567. Phone and ID columns are formatted as text so Excel keeps the leading 0.',
  'Names of classes, sections, sessions and campuses must match the names in the system (case and spaces do not matter).',
  'Nothing is saved until you have checked the preview and confirmed. Rows with problems are listed with their row number.',
  `At most ${IMPORT_LIMITS.maxRows.toLocaleString('en')} rows and 5 MB per file. Formulas are not run: Excel’s saved value is used.`,
];

export async function templateXlsx(type: ImportType): Promise<Buffer> {
  const def = TYPE_DEFS[type];
  const fields = templateFields(type);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'School OS';
  wb.created = new Date(0);

  const data = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  data.columns = fields.map((f) => ({
    header: headingOf(f),
    key: f.key,
    width: Math.max(14, Math.min(40, headingOf(f).length + 6)),
    ...(f.textColumn ? { style: { numFmt: '@' } } : {}),
  }));
  const head = data.getRow(1);
  head.font = { bold: true, color: { argb: 'FF1F2937' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  fields.forEach((f, i) => {
    const cell = head.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: f.required ? 'FFFDE68A' : 'FFE5E7EB' } };
    cell.note = `${f.required ? 'Required. ' : ''}${f.description}`;
  });
  const example = data.addRow(Object.fromEntries(fields.map((f) => [f.key, f.example])));
  example.font = { italic: true, color: { argb: 'FF6B7280' } };
  // Dropdowns and formats on the first 2,000 data rows.
  fields.forEach((f, i) => {
    const col = data.getColumn(i + 1).letter;
    if (f.options)
      (data as unknown as { dataValidations: { add: (ref: string, v: object) => void } }).dataValidations.add(
        `${col}2:${col}2001`,
        {
          type: 'list',
          allowBlank: !f.required,
          formulae: [`"${f.options.join(',')}"`],
          showErrorMessage: true,
          errorTitle: f.label,
          error: `Choose one of: ${f.options.join(', ')}`,
        },
      );
  });

  const guide = wb.addWorksheet('Instructions');
  guide.columns = [{ width: 26 }, { width: 12 }, { width: 80 }, { width: 22 }];
  guide.addRow([`${def.label} — import template`]).font = { bold: true, size: 14 };
  guide.addRow([def.description]);
  guide.addRow([`Existing records are recognised by: ${def.identifier}.`]);
  guide.addRow([]);
  guide.addRow(['How to fill it in']).font = { bold: true };
  for (const rule of GENERAL_RULES) guide.addRow([`• ${rule}`]);
  for (const line of def.guide ?? []) guide.addRow([`• ${line}`]);
  if (def.oneOf?.some((g) => g.includes('fullName')))
    guide.addRow([
      '• Instead of one name column you may also upload a file with separate First name and Last name columns.',
    ]);
  guide.addRow([]);
  const th = guide.addRow(['Column', 'Required', 'What to enter', 'Example']);
  th.font = { bold: true };
  th.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });
  for (const f of fields) {
    const r = guide.addRow([
      f.label,
      f.required ? 'Yes *' : 'No',
      f.description + (f.options ? ` Allowed: ${f.options.join(', ')}.` : ''),
      f.example,
    ]);
    r.alignment = { wrapText: true, vertical: 'top' };
  }
  for (let i = 1; i <= 4; i++) guide.getColumn(i).alignment = { wrapText: true, vertical: 'top' };
  guide.getRow(1).alignment = { wrapText: false };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function templateCsv(type: ImportType): string {
  const fields = templateFields(type);
  return toCsv(
    fields.map((f) => ({ key: f.key, header: headingOf(f) })),
    [Object.fromEntries(fields.map((f) => [f.key, f.example]))],
  );
}
