import PDFDocument from 'pdfkit';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '../modules/branding/document-settings';
import { escapeRegex } from '../utils/pagination';

/**
 * Printable documents (challans, receipts, certificates, report tables), rendered on the
 * server so the PDF a school downloads is exactly what prints. Every document shares one
 * branded layout: the school's own logo and details, its colours, font and margins
 * (DocumentSettings, saved per school). Amounts, dates and numbers are always printed; the
 * settings only change presentation.
 */

export interface Brand {
  schoolName: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** PNG bytes of the school's logo (normalised on upload), or null for no logo. */
  logo?: Buffer | null;
  settings?: DocumentSettings;
}

const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Calendar dates are stored at UTC midnight: format in UTC so the day never shifts. */
export const fmtDate = (date: Date | string | undefined | null) => {
  if (!date) return '-';
  const x = new Date(date);
  return `${String(x.getUTCDate()).padStart(2, '0')} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
const fmtPeriod = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return m ? `${MONTHS[m - 1]} ${y}` : p;
};

const FONTS = {
  helvetica: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' },
  times: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' },
  courier: { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique' },
} as const;
const MARGINS = { narrow: 22, normal: 34, wide: 50 } as const;
const LOGO_PX = { small: 30, medium: 42, large: 58 } as const;

type Doc = PDFKit.PDFDocument;

function toBuffer(build: (doc: Doc) => void, options: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, ...options });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

/** Drawing helpers bound to one school's brand. */
function kit(doc: Doc, brand: Brand) {
  const s = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  const f = FONTS[s.theme.fontFamily];
  const size = (n: number) => n * s.theme.fontScale;
  const text = (
    str: string,
    x: number,
    y: number,
    o: {
      w: number;
      size?: number;
      bold?: boolean;
      italic?: boolean;
      color?: string;
      align?: 'left' | 'center' | 'right';
      lines?: number;
    } = { w: 100 },
  ) => {
    doc
      .font(o.bold ? f.bold : o.italic ? f.italic : f.regular)
      .fontSize(size(o.size ?? 9))
      .fillColor(o.color ?? '#111111');
    const h = doc.heightOfString(str, { width: o.w });
    const lineH = doc.currentLineHeight(true);
    const maxH = o.lines ? lineH * o.lines : h;
    doc.text(str, x, y, {
      width: o.w,
      align: o.align ?? 'left',
      height: maxH,
      ellipsis: true,
      lineBreak: (o.lines ?? 2) > 1,
    });
    return Math.min(h, maxH);
  };

  /** School header: logo and details. Returns the y below it. */
  const header = (x: number, y: number, w: number, opts: { compact?: boolean } = {}) => {
    const logoSize = opts.compact ? Math.min(LOGO_PX[s.header.logoSize], 34) : LOGO_PX[s.header.logoSize];
    const showLogo = Boolean(brand.logo) && s.header.logoPosition !== 'none';
    const details = [
      s.header.showAddress ? brand.address : null,
      [s.header.showPhone && brand.phone ? `Ph: ${brand.phone}` : null, s.header.showEmail ? brand.email : null]
        .filter(Boolean)
        .join('  ·  '),
    ].filter((v): v is string => Boolean(v));
    const nameSize = opts.compact ? 11 : 16;
    const centered = s.header.logoPosition === 'center' || !showLogo;
    let textX = x;
    let textW = w;
    let top = y;
    if (showLogo) {
      try {
        if (s.header.logoPosition === 'center') {
          doc.image(brand.logo!, x + (w - logoSize) / 2, y, {
            fit: [logoSize, logoSize],
            align: 'center',
            valign: 'center',
          });
          top = y + logoSize + 3;
        } else if (s.header.logoPosition === 'right') {
          doc.image(brand.logo!, x + w - logoSize, y, { fit: [logoSize, logoSize], align: 'right', valign: 'center' });
          textW = w - logoSize - 8;
        } else {
          doc.image(brand.logo!, x, y, { fit: [logoSize, logoSize], valign: 'center' });
          textX = x + logoSize + 8;
          textW = w - logoSize - 8;
        }
      } catch {
        // A logo that cannot be decoded is skipped rather than failing the document.
      }
    }
    const align = centered ? 'center' : 'left';
    let cy = top;
    cy +=
      text(brand.schoolName, textX, cy, {
        w: textW,
        size: nameSize,
        bold: true,
        color: s.theme.primaryColor,
        align,
        lines: 2,
      }) + 1;
    if (s.header.tagline)
      cy += text(s.header.tagline, textX, cy, {
        w: textW,
        size: opts.compact ? 7 : 9,
        italic: true,
        color: '#444444',
        align,
        lines: 1,
      });
    for (const line of details)
      cy += text(line, textX, cy, { w: textW, size: opts.compact ? 6.5 : 8.5, color: '#444444', align, lines: 1 });
    const bottom = Math.max(cy, showLogo && s.header.logoPosition !== 'center' ? y + logoSize : cy) + 4;
    doc
      .moveTo(x, bottom)
      .lineTo(x + w, bottom)
      .lineWidth(1.2)
      .strokeColor(s.theme.primaryColor)
      .stroke();
    return bottom + 6;
  };

  /** Label/value rows in a grid of `cols` columns. */
  const fields = (rows: Array<[string, string]>, x: number, y: number, w: number, cols = 2, fs = 8) => {
    const colW = w / cols;
    let cy = y;
    for (let i = 0; i < rows.length; i += cols) {
      let rowH = 0;
      rows.slice(i, i + cols).forEach(([k, v], j) => {
        const cx = x + j * colW;
        text(k, cx, cy, { w: colW - 4, size: fs - 1.5, color: '#666666', lines: 1 });
        const h = text(v || '-', cx, cy + size(fs - 1) + 1, { w: colW - 4, size: fs, bold: true, lines: 2 });
        rowH = Math.max(rowH, size(fs - 1) + 1 + h);
      });
      cy += rowH + 3;
    }
    return cy;
  };

  /** Two-column amount table with a header bar. Rows marked `strong` are emphasised. */
  const amounts = (
    title: string,
    rows: Array<{ label: string; value: string; strong?: boolean; muted?: boolean }>,
    x: number,
    y: number,
    w: number,
    fs = 8,
  ) => {
    const rowH = size(fs) + 5;
    doc.rect(x, y, w, rowH).fill(s.theme.primaryColor);
    text(title, x + 4, y + 2.5, { w: w - 8, size: fs, bold: true, color: '#ffffff', lines: 1 });
    let cy = y + rowH;
    rows.forEach((r, i) => {
      if (r.strong) doc.rect(x, cy, w, rowH).fill(s.theme.accentColor);
      else if (i % 2 === 1) doc.rect(x, cy, w, rowH).fill('#f7f7f7');
      const color = r.muted ? '#666666' : '#111111';
      text(r.label, x + 4, cy + 2.5, { w: w * 0.6 - 4, size: fs, bold: r.strong, color, lines: 1 });
      text(r.value, x + w * 0.6, cy + 2.5, {
        w: w * 0.4 - 4,
        size: fs,
        bold: r.strong,
        color,
        align: 'right',
        lines: 1,
      });
      cy += rowH;
    });
    doc
      .rect(x, y, w, cy - y)
      .lineWidth(0.6)
      .strokeColor('#bbbbbb')
      .stroke();
    return cy + 4;
  };

  const footer = (x: number, y: number, w: number, note: string, fs = 7) => {
    const parts = [s.footer.text, s.footer.showGeneratedNote ? note : ''].filter(Boolean);
    if (!parts.length) return y;
    return y + text(parts.join('  ·  '), x, y, { w, size: fs, color: '#777777', align: 'center', lines: 2 });
  };

  const signature = (label: string, x: number, y: number, w: number, fs = 7.5) => {
    doc
      .moveTo(x, y)
      .lineTo(x + w, y)
      .lineWidth(0.6)
      .strokeColor('#555555')
      .stroke();
    text(label, x, y + 2, { w, size: fs, color: '#555555', align: 'center', lines: 1 });
  };

  /**
   * A table with a header bar: the first column is text, the others are right-aligned amounts.
   * Rows marked strong (totals) are emphasised. Returns the y below the table.
   */
  const table = (
    title: string,
    head: string[],
    rows: Array<{ cells: string[]; strong?: boolean }>,
    x: number,
    y: number,
    w: number,
    fs = 8.5,
  ) => {
    const rowH = size(fs) + 6;
    const first = w * 0.4;
    const col = (w - first) / (head.length - 1);
    const cellX = (i: number) => (i === 0 ? x + 4 : x + first + col * (i - 1));
    const cellW = (i: number) => (i === 0 ? first - 8 : col - 4);
    doc.rect(x, y, w, rowH).fill(s.theme.primaryColor);
    text(title, x + 4, y + 3, { w: w - 8, size: fs, bold: true, color: '#ffffff', lines: 1 });
    let cy = y + rowH;
    head.forEach((h, i) =>
      text(h, cellX(i), cy + 3, {
        w: cellW(i),
        size: fs - 0.5,
        bold: true,
        color: '#444444',
        align: i ? 'right' : 'left',
        lines: 1,
      }),
    );
    cy += rowH;
    rows.forEach((r, ri) => {
      if (r.strong) doc.rect(x, cy, w, rowH).fill(s.theme.accentColor);
      else if (ri % 2 === 0) doc.rect(x, cy, w, rowH).fill('#f7f7f7');
      r.cells.forEach((c, i) =>
        text(c, cellX(i), cy + 3, {
          w: cellW(i),
          size: fs,
          bold: r.strong || (i === 2 && !r.strong),
          align: i ? 'right' : 'left',
          lines: 1,
        }),
      );
      cy += rowH;
    });
    doc
      .rect(x, y, w, cy - y)
      .lineWidth(0.5)
      .strokeColor('#cccccc')
      .stroke();
    return cy;
  };

  return { s, f, size, text, header, fields, amounts, table, footer, signature };
}

// ───────────────────────────── Fee challan ─────────────────────────────

export interface ChallanData {
  bankDetails?: string;
  invoiceNo: string;
  period: string;
  issueDate: Date;
  /** Due date of what this challan asks for (the installment's, when it is one). */
  dueDate: Date;
  studentName: string;
  admissionNo: string;
  fatherName?: string;
  className?: string;
  sectionName?: string;
  rollNo?: string;
  items: Array<{ name: string; amount: number }>;
  subtotal: number;
  concession: number;
  waiver: number;
  lateFee: number;
  /** Net payable for the whole invoice (after discounts, including any late fee). */
  total: number;
  paid: number;
  balance: number;
  status: string;
  /** Present when the invoice is split: this challan is for one installment. */
  installment?: { no: number; count: number; amount: number; paid: number; outstanding: number; dueDate: Date };
  /** The student's other unpaid invoices up to this month (single challan only, not the family voucher). */
  previousDues?: { amount: number; invoices: Array<{ invoiceNo: string; period: string; balance: number }> };
}

/** The figures a challan prints, in one place so screen, PDF and payment agree. */
export function challanFigures(c: ChallanData) {
  const discount = c.concession + c.waiver;
  const original = c.subtotal + c.lateFee;
  const payableNow = c.installment ? c.installment.outstanding : c.balance;
  const previous = c.previousDues?.amount ?? 0;
  return {
    original,
    discount,
    net: c.total,
    payableNow,
    remainingAfter: Math.max(0, c.balance - payableNow),
    previous,
    totalPayable: payableNow + previous,
    /** Of everything this voucher asks for: PAID, PARTLY PAID or UNPAID. */
    stamp: (payableNow + previous === 0 ? 'PAID' : c.paid > 0 ? 'PARTLY PAID' : 'UNPAID') as
      'PAID' | 'PARTLY PAID' | 'UNPAID',
  };
}

/** Fee challan: several copies (bank, school, student…) side by side on one page. */
export function renderChallan(c: ChallanData, brand: Brand): Promise<Buffer> {
  return renderChallans([c], brand);
}

/** Several challans in one PDF, one page each (e.g. a whole class or section to print at once). */
export function renderChallans(list: ChallanData[], brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  const cs = set.challan;
  return toBuffer(
    (doc) => {
      list.forEach((c, page) => {
        if (page > 0) doc.addPage({ size: cs.paper, layout: cs.orientation, margin: 0 });
        const k = kit(doc, brand);
        const m = MARGINS[set.page.margin];
        const pageW = doc.page.width;
        const pageH = doc.page.height;
        const copies = cs.copies;
        const gap = 14;
        const across = cs.orientation === 'landscape' || copies === 1;
        const boxW = across ? (pageW - 2 * m - gap * (copies - 1)) / copies : pageW - 2 * m;
        const boxH = across ? pageH - 2 * m : (pageH - 2 * m - gap * (copies - 1)) / copies;
        const fig = challanFigures(c);
        const compact = boxW < 300;
        const fs = compact ? 7.5 : 8.5;
        const labels = Array.from({ length: copies }, (_, i) => cs.copyLabels[i] || `Copy ${i + 1}`);

        labels.forEach((copyLabel, i) => {
          const x = across ? m + i * (boxW + gap) : m;
          const y = across ? m : m + i * (boxH + gap);
          const pad = 8;
          const ix = x + pad;
          const iw = boxW - 2 * pad;
          // Copy label strip.
          doc.rect(x, y, boxW, k.size(fs) + 6).fill(set.theme.primaryColor);
          k.text(copyLabel.toUpperCase(), ix, y + 3, {
            w: iw,
            size: fs,
            bold: true,
            color: '#ffffff',
            align: 'center',
            lines: 1,
          });
          let cy = y + k.size(fs) + 12;
          cy = k.header(ix, cy, iw, { compact: true });
          k.text(
            c.installment ? `FEE CHALLAN — INSTALLMENT ${c.installment.no} OF ${c.installment.count}` : 'FEE CHALLAN',
            ix,
            cy,
            {
              w: iw,
              size: fs + 1.5,
              bold: true,
              align: 'center',
              lines: 1,
            },
          );
          cy += k.size(fs + 1.5) + 6;
          cy = k.fields(
            [
              ['Challan No', c.invoiceNo],
              ['Billing month', fmtPeriod(c.period)],
              ['Issue date', fmtDate(c.issueDate)],
              ['Due date', fmtDate(c.dueDate)],
              ['Student', c.studentName],
              ['Admission No', c.admissionNo],
              ['Father / Guardian', c.fatherName ?? '-'],
              [
                'Class',
                [c.className, c.sectionName ? `Section ${c.sectionName}` : null].filter(Boolean).join(' · ') || '-',
              ],
            ],
            ix,
            cy,
            iw,
            2,
            fs,
          );
          cy += 2;
          if (cs.showItemBreakdown && c.items.length) {
            cy = k.amounts(
              'Fee particulars',
              c.items.map((it) => ({ label: it.name, value: rs(it.amount) })),
              ix,
              cy,
              iw,
              fs,
            );
          }
          const summary: Array<{ label: string; value: string; strong?: boolean; muted?: boolean }> = [
            { label: 'Total fee', value: rs(fig.original) },
          ];
          if (fig.discount) summary.push({ label: 'Discount / concession', value: `- ${rs(fig.discount)}` });
          summary.push({ label: 'Net payable (whole invoice)', value: rs(fig.net) });
          if (c.installment) {
            if (c.paid) summary.push({ label: 'Paid so far (all installments)', value: rs(c.paid), muted: true });
            summary.push({ label: 'Outstanding (whole invoice)', value: rs(c.balance), muted: true });
            summary.push({
              label: `Installment ${c.installment.no} of ${c.installment.count}`,
              value: rs(c.installment.amount),
            });
            if (c.installment.paid)
              summary.push({ label: 'Already paid on this installment', value: `- ${rs(c.installment.paid)}` });
          } else if (c.paid) summary.push({ label: 'Already paid', value: `- ${rs(c.paid)}` });
          if (fig.previous) {
            summary.push({ label: `This month (${fmtPeriod(c.period)})`, value: rs(fig.payableNow) });
            const upTo = c.previousDues!.invoices.at(-1)?.period;
            summary.push({
              label: `Previous dues (unpaid${upTo ? ` up to ${fmtPeriod(upTo)}` : ''})`,
              value: rs(fig.previous),
            });
            summary.push({ label: 'TOTAL PAYABLE', value: rs(fig.totalPayable), strong: true });
          } else {
            summary.push({ label: 'AMOUNT PAYABLE', value: rs(fig.payableNow), strong: true });
            summary.push({ label: 'Remaining after this payment', value: rs(fig.remainingAfter), muted: true });
          }
          cy = k.amounts('Payment summary', summary, ix, cy, iw, fs);

          const stampColor = { PAID: '#1a7f37', 'PARTLY PAID': '#b45309', UNPAID: '#b42318' }[fig.stamp];
          k.text(fig.stamp, ix, cy, { w: iw, size: fs + 6, bold: true, color: stampColor, align: 'center', lines: 1 });
          cy += k.size(fs + 6) + 4;
          if (cs.showBankDetails && c.bankDetails)
            cy += k.text(`Pay at: ${c.bankDetails}`, ix, cy, { w: iw, size: fs - 0.5, lines: 3 }) + 3;
          if (cs.instructions)
            cy += k.text(cs.instructions, ix, cy, { w: iw, size: fs - 1, color: '#444444', lines: 3 }) + 3;

          // Side by side, each copy is only as tall as its content (no wasted paper); stacked
          // copies share the page height equally so each one stays in its own slot.
          const sigGap = cs.signatureLabel ? 34 : 6;
          const bottom = across ? Math.min(cy + sigGap + k.size(7) * 2 + 4, y + boxH - pad) : y + boxH - pad;
          doc
            .rect(x, y, boxW, bottom + pad - y)
            .lineWidth(0.8)
            .strokeColor('#888888')
            .stroke();
          k.footer(ix, bottom - k.size(7) * 2, iw, 'Computer-generated challan.', 6.5);
          if (cs.signatureLabel)
            k.signature(cs.signatureLabel, ix + iw * 0.45, bottom - k.size(7) * 2 - 18, iw * 0.55, fs - 1);

          // Dashed cut line between copies.
          if (i < copies - 1) {
            doc.save().dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#999999');
            if (across)
              doc
                .moveTo(x + boxW + gap / 2, m - 6)
                .lineTo(x + boxW + gap / 2, bottom + pad + 6)
                .stroke();
            else
              doc
                .moveTo(m - 6, y + boxH + gap / 2)
                .lineTo(pageW - m + 6, y + boxH + gap / 2)
                .stroke();
            doc.undash().restore();
          }
        });
      });
    },
    { size: cs.paper, layout: cs.orientation, margin: 0 },
  );
}

// ───────────────────────────── Family voucher ─────────────────────────────

export interface FamilyVoucherData {
  reference: string;
  issueDate: Date;
  parentName: string;
  parentPhone?: string;
  bankDetails?: string;
  children: Array<{
    name: string;
    admissionNo: string;
    className?: string | null;
    sectionName?: string | null;
    invoices: ChallanData[];
  }>;
}

/**
 * One voucher for all of a parent's children. Each child is listed separately with each
 * invoice's breakdown and payable amount (the same figures as that invoice's own challan,
 * see challanFigures); the family total is their sum. Ends with a cut-off bank/school copy.
 * Pages are added as needed; the copy strip never splits across pages.
 */
export function renderFamilyVoucher(v: FamilyVoucherData, brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  return toBuffer(
    (doc) => {
      const k = kit(doc, brand);
      const m = MARGINS[set.page.margin];
      const W = doc.page.width - 2 * m;
      const pageBottom = () => doc.page.height - m;
      const fs = 8.5;
      let y: number = m;
      const ensure = (h: number) => {
        if (y + h > pageBottom()) {
          doc.addPage();
          y = m;
        }
      };
      const perInvoice = v.children.map((c) => c.invoices.map((inv) => ({ inv, fig: challanFigures(inv) })));
      const childTotals = perInvoice.map((list) => list.reduce((s, x) => s + x.fig.payableNow, 0));
      const total = childTotals.reduce((a, b) => a + b, 0);
      const dueDates = v.children.flatMap((c) => c.invoices.map((i) => new Date(i.dueDate).getTime()));
      const due = dueDates.length ? new Date(Math.min(...dueDates)) : null;

      y = k.header(m, y, W);
      k.text('FAMILY FEE VOUCHER', m, y, { w: W, size: 13, bold: true, align: 'center', lines: 1 });
      y += k.size(13) + 8;
      y = k.fields(
        [
          ['Family reference', v.reference],
          ['Issue date', fmtDate(v.issueDate)],
          ['Parent / Guardian', v.parentName],
          ['Phone', v.parentPhone ?? '-'],
          ['Children on this voucher', String(v.children.length)],
          ['Pay by', due ? fmtDate(due) : '-'],
        ],
        m,
        y,
        W,
        3,
        fs,
      );
      y += 4;

      v.children.forEach((child, ci) => {
        const title = `${ci + 1}. ${child.name}  ·  Adm No ${child.admissionNo}${
          child.className ? `  ·  ${child.className}${child.sectionName ? ` ${child.sectionName}` : ''}` : ''
        }`;
        ensure(k.size(fs) * 6 + 40);
        doc.rect(m, y, W, k.size(fs + 1) + 8).fill(set.theme.accentColor);
        k.text(title, m + 6, y + 4, { w: W - 12, size: fs + 1, bold: true, color: set.theme.primaryColor, lines: 1 });
        y += k.size(fs + 1) + 12;
        perInvoice[ci].forEach(({ inv, fig }) => {
          const rows: Array<{ label: string; value: string; strong?: boolean; muted?: boolean }> = [];
          if (set.challan.showItemBreakdown)
            for (const it of inv.items) rows.push({ label: it.name, value: rs(it.amount) });
          if (inv.lateFee) rows.push({ label: 'Late fee', value: rs(inv.lateFee) });
          if (fig.discount) rows.push({ label: 'Discount / concession', value: `- ${rs(fig.discount)}` });
          rows.push({ label: 'Net payable (invoice)', value: rs(fig.net) });
          if (inv.paid) rows.push({ label: 'Already paid', value: `- ${rs(inv.paid)}`, muted: true });
          if (inv.installment)
            rows.push({
              label: `Installment ${inv.installment.no} of ${inv.installment.count} (due ${fmtDate(inv.installment.dueDate)})`,
              value: rs(inv.installment.amount),
              muted: true,
            });
          rows.push({ label: 'Payable now', value: rs(fig.payableNow), strong: true });
          const h = (rows.length + 1) * (k.size(fs) + 5) + 8;
          ensure(h);
          y = k.amounts(
            `Invoice ${inv.invoiceNo}  ·  ${fmtPeriod(inv.period)}  ·  due ${fmtDate(inv.dueDate)}`,
            rows,
            m,
            y,
            W,
            fs,
          );
        });
        ensure(k.size(fs + 1) + 10);
        k.text(`Payable for ${child.name}`, m, y, { w: W * 0.7, size: fs + 0.5, bold: true, lines: 1 });
        k.text(rs(childTotals[ci]), m + W * 0.7, y, {
          w: W * 0.3,
          size: fs + 0.5,
          bold: true,
          align: 'right',
          lines: 1,
        });
        y += k.size(fs + 0.5) + 12;
      });

      ensure(k.size(fs + 4) + 16);
      doc.rect(m, y, W, k.size(fs + 4) + 10).fill(set.theme.primaryColor);
      k.text('TOTAL PAYABLE FOR THE FAMILY', m + 8, y + 5, {
        w: W * 0.6,
        size: fs + 3,
        bold: true,
        color: '#ffffff',
        lines: 1,
      });
      k.text(rs(total), m + W * 0.6, y + 5, {
        w: W * 0.4 - 8,
        size: fs + 3,
        bold: true,
        color: '#ffffff',
        align: 'right',
        lines: 1,
      });
      y += k.size(fs + 4) + 16;
      const notes = [
        'Each child’s fees remain separate invoices. The school records your payment against each invoice listed above.',
        set.challan.showBankDetails && v.bankDetails ? `Pay at: ${v.bankDetails}` : '',
        set.challan.instructions,
      ].filter(Boolean);
      for (const n of notes) {
        ensure(k.size(fs) * 3);
        y += k.text(n, m, y, { w: W, size: fs - 0.5, color: '#444444', lines: 3 }) + 3;
      }

      // Bank / school copy: one strip with the essentials, kept together on one page.
      const lineH = k.size(fs - 0.5) + 4;
      const lines = v.children.flatMap((c, ci) =>
        perInvoice[ci].map(({ inv, fig }) => [`${c.name} (${c.admissionNo})`, inv.invoiceNo, rs(fig.payableNow)]),
      );
      const stripH = 26 + k.size(fs) * 3 + lines.length * lineH + 46;
      ensure(stripH + 14);
      y += 6;
      doc.save().dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#999999');
      doc
        .moveTo(m - 6, y)
        .lineTo(m + W + 6, y)
        .stroke();
      doc.undash().restore();
      k.text('cut here', m, y + 2, { w: W, size: 6, color: '#999999', align: 'right', lines: 1 });
      y += 10;
      const top = y;
      const label = (set.challan.copyLabels[0] || 'Bank Copy').toUpperCase();
      doc.rect(m, y, W, k.size(fs) + 6).fill(set.theme.primaryColor);
      k.text(`${label}  ·  FAMILY FEE VOUCHER  ·  ${v.reference}`, m + 6, y + 3, {
        w: W - 12,
        size: fs,
        bold: true,
        color: '#ffffff',
        lines: 1,
      });
      y += k.size(fs) + 10;
      k.text(`${brand.schoolName}  ·  Parent: ${v.parentName}${v.parentPhone ? ` (${v.parentPhone})` : ''}`, m + 6, y, {
        w: W - 12,
        size: fs - 0.5,
        lines: 1,
      });
      y += lineH + 2;
      for (const [who, invNo, amount] of lines) {
        k.text(who, m + 6, y, { w: W * 0.5, size: fs - 0.5, lines: 1 });
        k.text(invNo, m + W * 0.5, y, { w: W * 0.25, size: fs - 0.5, lines: 1 });
        k.text(amount, m + W * 0.75, y, { w: W * 0.25 - 6, size: fs - 0.5, align: 'right', lines: 1 });
        y += lineH;
      }
      k.text('TOTAL', m + 6, y + 2, { w: W * 0.5, size: fs, bold: true, lines: 1 });
      k.text(rs(total), m + W * 0.75, y + 2, { w: W * 0.25 - 6, size: fs, bold: true, align: 'right', lines: 1 });
      y += lineH + 18;
      if (set.challan.signatureLabel) k.signature(set.challan.signatureLabel, m + W * 0.6, y, W * 0.38, fs - 1);
      y += 14;
      doc
        .rect(m, top, W, y - top)
        .lineWidth(0.8)
        .strokeColor('#888888')
        .stroke();
      k.footer(m, y + 4, W, 'Computer-generated family voucher.', 6.5);
    },
    { size: 'A4', layout: 'portrait', margin: 0 },
  );
}

// ───────────────────────────── Receipt ─────────────────────────────

export interface ReceiptData {
  receiptNo: string;
  receivedAt: Date;
  studentName: string;
  admissionNo: string;
  className?: string;
  invoiceNo: string;
  period: string;
  amount: number;
  method: string;
  reference?: string;
  balanceAfter?: number;
  receivedBy?: string;
  status: string;
  /** Which fees this payment paid (from what was recorded with it). */
  breakdown?: {
    available: boolean;
    source: 'chosen' | 'automatic' | null;
    lines: Array<{ name: string; due: number; paidNow: number; remaining: number }>;
    unallocated: number;
  };
}

export function renderReceipt(r: ReceiptData, brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  return toBuffer(
    (doc) => {
      const k = kit(doc, brand);
      const m = MARGINS[set.page.margin];
      const w = doc.page.width - 2 * m;
      let y = k.header(m, m, w);
      k.text('FEE PAYMENT RECEIPT', m, y, { w, size: 13, bold: true, align: 'center', lines: 1 });
      y += k.size(13) + 8;
      if (r.status === 'reversed') {
        k.text('REVERSED — this payment was cancelled', m, y, {
          w,
          size: 11,
          bold: true,
          color: '#b42318',
          align: 'center',
          lines: 1,
        });
        y += k.size(11) + 8;
      }
      y = k.fields(
        [
          ['Receipt No', r.receiptNo],
          ['Date', fmtDate(r.receivedAt)],
          ['Student', r.studentName],
          ['Admission No', r.admissionNo],
          ['Class', r.className ?? '-'],
          ['Against challan', `${r.invoiceNo} (${fmtPeriod(r.period)})`],
        ],
        m,
        y,
        w,
        2,
        9.5,
      );
      y += 4;
      y = k.amounts(
        'Payment',
        [
          { label: 'Amount received', value: rs(r.amount), strong: true },
          { label: 'Payment method', value: r.method.replaceAll('_', ' ') },
          { label: 'Reference', value: r.reference ?? '-' },
          { label: 'Balance after this payment', value: r.balanceAfter !== undefined ? rs(r.balanceAfter) : '-' },
          { label: 'Received by', value: r.receivedBy ?? '-' },
        ],
        m,
        y,
        w,
        9.5,
      );
      const bd = r.breakdown;
      if (bd) {
        y += 8;
        if (bd.available) {
          const total = (key: 'due' | 'paidNow' | 'remaining') => bd.lines.reduce((t, l) => t + l[key], 0);
          y = k.table(
            'Fee breakdown',
            ['Fee head', 'Amount due', 'Paid now', 'Remaining'],
            [
              ...bd.lines.map((l) => ({
                cells: [l.name, rs(l.due), l.paidNow ? rs(l.paidNow) : '-', rs(l.remaining)],
              })),
              ...(bd.unallocated ? [{ cells: ['Not matched to a fee', '-', rs(bd.unallocated), '-'] }] : []),
              {
                cells: ['Total', rs(total('due')), rs(total('paidNow') + bd.unallocated), rs(total('remaining'))],
                strong: true,
              },
            ],
            m,
            y,
            w,
            9,
          );
          y += 3;
          k.text(
            bd.source === 'chosen'
              ? 'Fees chosen by the cashier when the payment was received.'
              : 'Applied to the outstanding fees in the order they appear on the challan.',
            m,
            y,
            { w, size: 7.5, color: '#666666', lines: 1 },
          );
        } else {
          k.text(
            'Fee breakdown: not recorded for this payment (received before fee-wise receipts were introduced). See the challan for the fees it covered.',
            m,
            y,
            { w, size: 8, italic: true, color: '#666666', lines: 2 },
          );
        }
      }
      const bottom = doc.page.height - m;
      if (set.receipt.signatureLabel) k.signature(set.receipt.signatureLabel, m + w * 0.6, bottom - 46, w * 0.4);
      k.footer(m, bottom - 20, w, 'Computer-generated receipt.');
    },
    { size: set.receipt.paper, margin: 0 },
  );
}

// ───────────────────────────── Certificate ─────────────────────────────

export interface CertificateData {
  title: string;
  serialNo: string;
  issueDate: Date;
  body: string;
  issuedBy: string;
  /** Particulars printed as a table under the text (e.g. admission no., dates of admission and leaving). */
  details?: Array<[string, string]>;
  /** Diagonal mark, e.g. PREVIEW for a certificate that is not issued. */
  watermark?: string;
  /** Values in the body printed in bold: the student's name, admission number, class, conduct... */
  emphasis?: string[];
  /** letter: a formal certificate (leaving, character…); award: name in large type under "presented to". */
  layout?: 'letter' | 'award';
  /** Award certificates: the student's name, printed large. */
  recipient?: string;
  /** Printed above the text of an open letter, e.g. "To whom it may concern". */
  salutation?: string;
}

/** Body text with bold runs, justified (letters) or centred (awards). Returns the y below it. */
function certificateBody(
  doc: Doc,
  k: ReturnType<typeof kit>,
  c: CertificateData,
  x: number,
  y: number,
  w: number,
  o: { size: number; align: 'justify' | 'center'; color?: string },
) {
  const paragraphs = c.body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  let cy = y;
  for (const [n, para] of paragraphs.entries()) {
    // Centred text is one plain run per paragraph (bold runs cannot be centred reliably).
    const parts = o.align === 'center' ? [{ text: para, strong: false }] : emphasised(para, c.emphasis ?? []);
    doc.fontSize(k.size(o.size)).fillColor(o.color ?? '#1f2328');
    parts.forEach((part, i) => {
      doc.font(part.strong ? k.f.bold : k.f.regular);
      const opts = { width: w, align: o.align, lineGap: o.size > 12 ? 5 : 3.5, continued: i < parts.length - 1 };
      if (i === 0) doc.text(part.text, x, cy, opts);
      else doc.text(part.text, opts);
    });
    cy = doc.y + (n < paragraphs.length - 1 ? k.size(o.size) * 0.7 : 0);
  }
  return cy;
}

/** Particulars as a ruled two-column table (label | value), shaded every other row. */
function particulars(
  doc: Doc,
  k: ReturnType<typeof kit>,
  rows: Array<[string, string]>,
  x: number,
  y: number,
  w: number,
  primary: string,
) {
  const perRow = rows.length > 4 ? 2 : 1;
  const cellW = w / perRow;
  const rowH = k.size(9.5) + 9;
  k.text('PARTICULARS (AS PER SCHOOL RECORD)', x, y, { w, size: 8, bold: true, color: primary, lines: 1 });
  let cy = y + k.size(8) + 5;
  const lines = Math.ceil(rows.length / perRow);
  for (let r = 0; r < lines; r++) {
    if (r % 2 === 0) doc.rect(x, cy, w, rowH).fill('#f5f6f8');
    for (let j = 0; j < perRow; j++) {
      const item = rows[r * perRow + j];
      if (!item) continue;
      const cx = x + j * cellW;
      k.text(item[0], cx + 6, cy + 4.5, { w: cellW * 0.42 - 8, size: 8.5, color: '#5b616b', lines: 1 });
      k.text(item[1] || '—', cx + cellW * 0.42, cy + 4.5, { w: cellW * 0.58 - 8, size: 9.5, bold: true, lines: 1 });
    }
    cy += rowH;
  }
  doc
    .rect(x, y + k.size(8) + 5, w, cy - (y + k.size(8) + 5))
    .lineWidth(0.6)
    .strokeColor('#c9ccd1')
    .stroke();
  if (perRow === 2)
    doc
      .moveTo(x + cellW, y + k.size(8) + 5)
      .lineTo(x + cellW, cy)
      .lineWidth(0.4)
      .strokeColor('#d8dbe0')
      .stroke();
  return cy;
}

/** A dashed circle for the school's stamp. */
function sealPlace(doc: Doc, k: ReturnType<typeof kit>, cx: number, cy: number, r: number) {
  doc
    .save()
    .dash(2.5, { space: 2.5 })
    .circle(cx, cy, r)
    .lineWidth(0.8)
    .strokeColor('#9aa0a8')
    .stroke()
    .undash()
    .restore();
  k.text('SCHOOL SEAL', cx - r, cy - k.size(6.5) / 2, {
    w: 2 * r,
    size: 6.5,
    color: '#9aa0a8',
    align: 'center',
    lines: 1,
  });
}

/** A rosette emblem for award certificates (drawn, so it needs no image). */
function rosette(doc: Doc, cx: number, cy: number, r: number, primary: string, accent: string) {
  doc.save();
  // Ribbon tails.
  doc
    .polygon(
      [cx - r * 0.55, cy + r * 0.4],
      [cx - r * 0.95, cy + r * 1.75],
      [cx - r * 0.45, cy + r * 1.45],
      [cx - r * 0.15, cy + r * 1.9],
      [cx - r * 0.05, cy + r * 0.6],
    )
    .fill(primary);
  doc
    .polygon(
      [cx + r * 0.55, cy + r * 0.4],
      [cx + r * 0.95, cy + r * 1.75],
      [cx + r * 0.45, cy + r * 1.45],
      [cx + r * 0.15, cy + r * 1.9],
      [cx + r * 0.05, cy + r * 0.6],
    )
    .fill(primary);
  // Scalloped edge.
  const points: Array<[number, number]> = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const rr = i % 2 ? r : r * 0.88;
    points.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  doc.polygon(...points).fill(accent);
  doc.circle(cx, cy, r * 0.74).fill(primary);
  doc
    .circle(cx, cy, r * 0.62)
    .lineWidth(0.8)
    .strokeColor('#ffffff')
    .stroke();
  // Five-pointed star.
  const star: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.2 : r * 0.46;
    star.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  doc.polygon(...star).fill('#ffffff');
  doc.restore();
}

export function renderCertificate(c: CertificateData, brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  const cert = set.certificate;
  const award = c.layout === 'award';
  return toBuffer(
    (doc) => {
      const k = kit(doc, brand);
      const W = doc.page.width;
      const H = doc.page.height;
      const primary = set.theme.primaryColor;
      // Awards use gold ornaments (readable on the warm paper); letters use the theme accent.
      const accent = award ? '#b8892b' : set.theme.accentColor;
      const landscape = W > H;

      if (award) {
        // Warm paper, a double frame with corner ornaments.
        doc.rect(0, 0, W, H).fill('#fffdf7');
        doc
          .rect(16, 16, W - 32, H - 32)
          .lineWidth(5)
          .strokeColor(primary)
          .stroke();
        doc
          .rect(26, 26, W - 52, H - 52)
          .lineWidth(1.4)
          .strokeColor(accent)
          .stroke();
        doc
          .rect(31, 31, W - 62, H - 62)
          .lineWidth(0.5)
          .strokeColor(primary)
          .stroke();
        for (const [x, y] of [
          [26, 26],
          [W - 26, 26],
          [26, H - 26],
          [W - 26, H - 26],
        ] as Array<[number, number]>)
          doc.polygon([x, y - 11], [x + 11, y], [x, y + 11], [x - 11, y]).fill(accent);
      } else if (cert.style === 'classic') {
        doc
          .rect(18, 18, W - 36, H - 36)
          .lineWidth(3)
          .strokeColor(primary)
          .stroke();
        doc
          .rect(25, 25, W - 50, H - 50)
          .lineWidth(0.8)
          .strokeColor(accent)
          .stroke();
      } else if (cert.style === 'modern') {
        doc.rect(0, 0, 18, H).fill(primary);
        doc.rect(18, 0, 5, H).fill(accent);
        doc.rect(0, H - 8, W, 8).fill(primary);
      } else {
        doc
          .moveTo(60, 46)
          .lineTo(W - 60, 46)
          .lineWidth(0.8)
          .strokeColor(primary)
          .stroke();
        doc
          .moveTo(60, H - 46)
          .lineTo(W - 60, H - 46)
          .lineWidth(0.8)
          .strokeColor(primary)
          .stroke();
      }

      const m = award ? (landscape ? 70 : 62) : cert.style === 'modern' ? 72 : 64;
      const w = W - 2 * m;
      // Centred header for a formal look, whatever the challan/receipt logo position is.
      const centred: Brand = {
        ...brand,
        settings: {
          ...set,
          header: { ...set.header, logoPosition: set.header.logoPosition === 'none' ? 'none' : 'center' },
        },
      };
      let y = kit(doc, centred).header(m, award ? 46 : 46, w, { compact: award && landscape });
      const sigY = H - (award ? 92 : 112);

      if (award) {
        y += landscape ? 6 : 14;
        const [first, rest] = /^certificate of /i.test(c.title)
          ? ['CERTIFICATE', `OF ${c.title.replace(/^certificate of /i, '').toUpperCase()}`]
          : [c.title.toUpperCase(), ''];
        doc
          .font(k.f.bold)
          .fontSize(k.size(landscape ? 34 : 30))
          .fillColor(primary);
        doc.text(first, m, y, { width: w, align: 'center', characterSpacing: 4, lineBreak: false });
        y += k.size(landscape ? 34 : 30) * 1.15;
        if (rest) {
          const tw = Math.min(
            w,
            doc.font(k.f.bold).fontSize(k.size(13)).widthOfString(rest, { characterSpacing: 3 }) + 40,
          );
          doc
            .moveTo(m + (w - tw) / 2 - 40, y + 7)
            .lineTo(m + (w - tw) / 2, y + 7)
            .lineWidth(0.8)
            .strokeColor(accent)
            .stroke();
          doc
            .moveTo(m + (w + tw) / 2, y + 7)
            .lineTo(m + (w + tw) / 2 + 40, y + 7)
            .lineWidth(0.8)
            .strokeColor(accent)
            .stroke();
          doc.fillColor(accent).text(rest, m, y, { width: w, align: 'center', characterSpacing: 3, lineBreak: false });
          y += k.size(13) + 16;
        } else y += 10;
        k.text('This certificate is proudly presented to', m, y, {
          w,
          size: 11.5,
          italic: true,
          color: '#5b616b',
          align: 'center',
          lines: 1,
        });
        y += k.size(11.5) + 10;
        if (c.recipient) {
          doc
            .font(k.f.bold)
            .fontSize(k.size(landscape ? 30 : 27))
            .fillColor('#1f2328');
          doc.text(c.recipient, m, y, { width: w, align: 'center', lineBreak: false, ellipsis: true });
          y += k.size(landscape ? 30 : 27) * 1.2;
          doc
            .moveTo(m + w * 0.22, y)
            .lineTo(m + w * 0.78, y)
            .lineWidth(1)
            .strokeColor(accent)
            .stroke();
          y += 8;
        }
        const line = (c.details ?? [])
          .filter(([, v]) => v)
          .map(([l, v]) => `${l}: ${v}`)
          .join('     •     ');
        if (line) {
          k.text(line, m, y, { w, size: 9.5, color: '#5b616b', align: 'center', lines: 1 });
          y += k.size(9.5) + 14;
        }
        certificateBody(doc, k, c, m + w * 0.08, y, w * 0.84, {
          size: landscape ? 12.5 : 12,
          align: 'center',
          color: '#2d333b',
        });
        rosette(doc, W / 2, sigY - 48, landscape ? 26 : 24, primary, accent);
      } else {
        y += 4;
        k.text(`Ref. No: ${c.serialNo}`, m, y, { w: w / 2, size: 9, color: '#5b616b', lines: 1 });
        k.text(`Date: ${fmtDate(c.issueDate)}`, m + w / 2, y, {
          w: w / 2,
          size: 9,
          color: '#5b616b',
          align: 'right',
          lines: 1,
        });
        y += k.size(9) + 16;
        doc.font(k.f.bold).fontSize(k.size(21)).fillColor(primary);
        doc.text(c.title.toUpperCase(), m, y, { width: w, align: 'center', characterSpacing: 2.2, lineBreak: false });
        y += k.size(21) * 1.25;
        doc
          .moveTo(W / 2 - 34, y)
          .lineTo(W / 2 + 34, y)
          .lineWidth(2)
          .strokeColor(accent)
          .stroke();
        y += 18;
        const details = c.details ?? [];
        // Long text with a particulars table gets a slightly smaller font so it never runs into the signatures.
        const bodySize = details.length > 4 || c.body.length > 700 ? 11 : 12.5;
        const bx = m + 18;
        const bw = w - 36;
        if (c.salutation) {
          doc.font(k.f.bold).fontSize(k.size(10)).fillColor('#1f2328');
          doc.text(c.salutation.toUpperCase(), bx, y, {
            width: bw,
            characterSpacing: 1.2,
            lineBreak: false,
          });
          y += k.size(10) + 12;
        }
        y = certificateBody(doc, k, c, bx, y, bw, { size: bodySize, align: 'justify' });
        if (details.length && y < sigY - 90) particulars(doc, k, details, bx, y + 16, bw, primary);
        sealPlace(doc, k, m + 46, sigY - 14, 30);
      }

      if (c.watermark) {
        doc.save();
        doc
          .rotate(-25, { origin: [W / 2, H / 2] })
          .font(k.f.bold)
          .fontSize(110)
          .fillColor('#dd3333')
          .fillOpacity(0.08);
        doc.text(c.watermark, 0, H / 2 - 60, { width: W, align: 'center', lineBreak: false });
        doc.restore();
        doc.fillOpacity(1);
      }
      const labels = cert.signatureLabels.length ? cert.signatureLabels : ['Principal'];
      if (award) {
        // Signatures either side of the emblem.
        const slotW = w * 0.3;
        const spots = labels.length === 1 ? [m + w - slotW] : [m, m + w - slotW];
        labels.slice(0, 2).forEach((l, i) => k.signature(l, spots[i], sigY, slotW, 9));
        k.text(`Certificate No. ${c.serialNo}  ·  ${fmtDate(c.issueDate)}`, m, sigY + 22, {
          w,
          size: 8,
          color: '#5b616b',
          align: 'center',
          lines: 1,
        });
      } else {
        const sigX = m + 110;
        const sigW = w - 110;
        const slot = sigW / labels.length;
        labels.forEach((l, i) => k.signature(l, sigX + i * slot + slot * 0.12, sigY, slot * 0.76, 9));
        k.text(`Issued by ${c.issuedBy}`, m, sigY + 24, { w, size: 7.5, color: '#7a8089', align: 'center', lines: 1 });
      }
      k.footer(m, H - (award ? 50 : 58), w, `Verify this certificate (No. ${c.serialNo}) on the school portal.`);
    },
    { layout: cert.orientation, margin: 0 },
  );
}

/** Splits text into plain and bold runs: every occurrence of an emphasised value is bold. */
export function emphasised(text: string, values: string[]): Array<{ text: string; strong: boolean }> {
  const wanted = [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 1))].sort(
    (a, b) => b.length - a.length,
  );
  if (!wanted.length) return [{ text, strong: false }];
  const rx = new RegExp(`(${wanted.map(escapeRegex).join('|')})`, 'g');
  return text
    .split(rx)
    .filter((t) => t !== '')
    .map((t) => ({ text: t, strong: wanted.includes(t) }));
}

// ───────────────────────────── Report table ─────────────────────────────

export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; width?: number }>;
  rows: Array<Record<string, string | number>>;
  totals?: Record<string, string | number>;
}

/** A tabular report with the school header, repeating column headers on each page. */
export function renderReport(r: ReportTable, brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  return toBuffer(
    (doc) => {
      const k = kit(doc, brand);
      const m = MARGINS[set.page.margin];
      const W = doc.page.width;
      const H = doc.page.height;
      const w = W - 2 * m;
      const weights = r.columns.map((c) => c.width ?? 1);
      const total = weights.reduce((a, b) => a + b, 0);
      const colW = weights.map((x) => (x / total) * w);
      const fs = 8.5;
      const rowH = k.size(fs) + 7;
      let y = k.header(m, m, w);
      k.text(r.title, m, y, { w, size: 13, bold: true, lines: 1 });
      y += k.size(13) + 2;
      if (r.subtitle) {
        k.text(r.subtitle, m, y, { w, size: 9, color: '#555555', lines: 1 });
        y += k.size(9) + 4;
      }
      const head = () => {
        doc.rect(m, y, w, rowH).fill(set.theme.primaryColor);
        let x = m;
        r.columns.forEach((c, i) => {
          k.text(c.label, x + 4, y + 3.5, {
            w: colW[i] - 8,
            size: fs,
            bold: true,
            color: '#ffffff',
            align: c.align ?? 'left',
            lines: 1,
          });
          x += colW[i];
        });
        y += rowH;
      };
      const row = (values: Record<string, string | number>, strong = false, shade = false) => {
        if (shade) doc.rect(m, y, w, rowH).fill(strong ? set.theme.accentColor : '#f6f6f6');
        let x = m;
        r.columns.forEach((c, i) => {
          const v = values[c.key];
          k.text(v === undefined || v === null ? '' : String(v), x + 4, y + 3.5, {
            w: colW[i] - 8,
            size: fs,
            bold: strong,
            align: c.align ?? 'left',
            lines: 1,
          });
          x += colW[i];
        });
        y += rowH;
      };
      head();
      r.rows.forEach((values, i) => {
        if (y + rowH > H - m - 24) {
          doc.addPage({ size: 'A4', margin: 0 });
          y = m;
          head();
        }
        row(values, false, i % 2 === 1);
      });
      if (!r.rows.length) {
        k.text('No data for the selected period.', m, y + 6, {
          w,
          size: 9,
          italic: true,
          color: '#666666',
          align: 'center',
          lines: 1,
        });
        y += rowH + 6;
      }
      if (r.totals) row(r.totals, true, true);
      // Page numbers and footer on every page.
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        k.footer(m, H - m + 4, w * 0.75, 'Computer-generated report.');
        k.text(`Page ${p - range.start + 1} of ${range.count}`, m + w * 0.75, H - m + 4, {
          w: w * 0.25,
          size: 7,
          color: '#777777',
          align: 'right',
          lines: 1,
        });
      }
    },
    { margin: 0 },
  );
}

// ───────────────────────────── Result card ─────────────────────────────

export interface ResultCardData {
  published: boolean;
  exam: { name: string; startDate: string | null; endDate: string | null };
  session: { name: string } | null;
  student: {
    name: string;
    admissionNo: string;
    rollNo: string | null;
    guardianName: string | null;
    guardianRelation: string | null;
    dateOfBirth: string | null;
    className: string | null;
    sectionName: string | null;
  };
  result: {
    totalObtained: number;
    totalMax: number;
    percentage: number;
    grade: string;
    remark?: string | null;
    passed: boolean;
    incomplete: boolean;
    subjects: Array<{
      subject: string;
      maxMarks: number;
      passMarks: number;
      obtained: number | null;
      isAbsent: boolean;
      percentage: number | null;
      grade: string | null;
      passed: boolean | null;
      notTaken?: boolean;
      remarks?: string | null;
    }>;
  };
  position: number | null;
  sectionSize: number;
  attendance: {
    present: number;
    absent: number;
    late: number;
    leave: number;
    excused: number;
    total: number;
    rate: number | null;
  };
  classAverages: Array<{ subject: string; averagePercent: number | null }>;
  gradingScale: Array<{ grade: string; minPercent: number; remark: string | null }>;
  passPercent: number;
}

/** What the result line says. Shared with the screen so both use the same words. */
export function resultLabel(r: { incomplete: boolean; passed: boolean }): string {
  if (r.incomplete) return 'Incomplete';
  return r.passed ? 'Pass' : 'Fail';
}

const RELATION_LABEL: Record<string, string> = { father: 'Father', mother: 'Mother', guardian: 'Guardian' };

/** One result card per page (A4 portrait). Unpublished results print with a DRAFT mark. */
export function renderResultCards(cards: ResultCardData[], brand: Brand): Promise<Buffer> {
  const set = brand.settings ?? DEFAULT_DOCUMENT_SETTINGS;
  const rc = set.reportCard;
  return toBuffer(
    (doc) => {
      const k = kit(doc, brand);
      const W = doc.page.width;
      const H = doc.page.height;
      const m = MARGINS[set.page.margin] + 6;
      const w = W - 2 * m;
      const primary = set.theme.primaryColor;
      const fs = 8.5;
      const rowH = k.size(fs) + 7;

      cards.forEach((c, index) => {
        if (index > 0) doc.addPage({ size: 'A4', margin: 0 });
        if (!c.published) {
          doc.save();
          doc
            .rotate(-35, { origin: [W / 2, H / 2] })
            .font(k.f.bold)
            .fontSize(96)
            .fillColor('#dd3333')
            .fillOpacity(0.08)
            .text('DRAFT', 0, H / 2 - 60, { width: W, align: 'center', lineBreak: false });
          doc.restore();
          doc.fillOpacity(1);
        }
        let y = k.header(m, m, w);
        k.text((rc.title || 'Result Card').toUpperCase(), m, y + 2, {
          w,
          size: 15,
          bold: true,
          color: primary,
          align: 'center',
          lines: 1,
        });
        y += k.size(15) + 6;
        const sub = [c.exam.name, c.session ? `Session ${c.session.name}` : null].filter(Boolean).join('  ·  ');
        k.text(sub, m, y, { w, size: 9.5, color: '#444444', align: 'center', lines: 1 });
        y += k.size(9.5) + 4;
        if (!c.published) {
          k.text('Draft: results are not published yet. Not for distribution.', m, y, {
            w,
            size: 8,
            color: '#b42318',
            align: 'center',
            lines: 1,
          });
          y += k.size(8) + 4;
        }
        y += 4;
        const relation = c.student.guardianRelation
          ? (RELATION_LABEL[c.student.guardianRelation] ?? 'Guardian')
          : 'Father / Guardian';
        const examDates = c.exam.startDate
          ? `${fmtDate(c.exam.startDate)}${c.exam.endDate ? ` to ${fmtDate(c.exam.endDate)}` : ''}`
          : '-';
        y = k.fields(
          [
            ['Student name', c.student.name],
            [`${relation}'s name`, c.student.guardianName ?? '-'],
            ['Admission no.', c.student.admissionNo],
            ['Roll no.', c.student.rollNo ?? '-'],
            ['Class', c.student.className ?? '-'],
            ['Section', c.student.sectionName ?? '-'],
            ['Date of birth', c.student.dateOfBirth ? fmtDate(c.student.dateOfBirth) : '-'],
            ['Exam dates', examDates],
          ],
          m,
          y,
          w,
          4,
          8.5,
        );
        y += 6;

        // Marks table.
        const cols: Array<{ label: string; wt: number; align: 'left' | 'right' | 'center' }> = [
          { label: 'Subject', wt: 2.6, align: 'left' },
          { label: 'Max', wt: 0.8, align: 'right' },
          { label: 'Pass', wt: 0.8, align: 'right' },
          { label: 'Obtained', wt: 1.1, align: 'right' },
          { label: '%', wt: 0.9, align: 'right' },
          { label: 'Grade', wt: 0.8, align: 'center' },
          ...(rc.showClassAverage ? [{ label: 'Class avg %', wt: 1, align: 'right' as const }] : []),
          ...(rc.showSubjectRemarks ? [{ label: 'Remarks', wt: 2.2, align: 'left' as const }] : []),
        ];
        const tw = cols.reduce((a, b) => a + b.wt, 0);
        const cw = cols.map((col) => (col.wt / tw) * w);
        const cell = (vals: string[], yy: number, opts: { bold?: boolean; color?: string } = {}) => {
          let x = m;
          vals.forEach((v, i) => {
            k.text(v, x + 4, yy + 3.5, {
              w: cw[i] - 8,
              size: fs,
              bold: opts.bold,
              color: opts.color,
              align: cols[i].align,
              lines: 1,
            });
            x += cw[i];
          });
        };
        const tableTop = y;
        doc.rect(m, y, w, rowH).fill(primary);
        cell(
          cols.map((col) => col.label),
          y,
          { bold: true, color: '#ffffff' },
        );
        y += rowH;
        const avgBy = new Map(c.classAverages.map((a) => [a.subject, a.averagePercent]));
        c.result.subjects.forEach((s, i) => {
          if (i % 2 === 1) doc.rect(m, y, w, rowH).fill('#f6f6f6');
          const obtained = s.notTaken
            ? 'Not taken'
            : s.isAbsent
              ? 'Absent'
              : s.obtained === null
                ? 'Not entered'
                : String(s.obtained);
          const avg = avgBy.get(s.subject);
          cell(
            [
              s.subject,
              s.notTaken ? '-' : String(s.maxMarks),
              s.notTaken ? '-' : String(s.passMarks),
              obtained,
              s.percentage === null ? '-' : s.percentage.toFixed(2),
              s.grade ?? '-',
              ...(rc.showClassAverage ? [avg == null ? '-' : avg.toFixed(1)] : []),
              ...(rc.showSubjectRemarks ? [s.remarks ?? ''] : []),
            ],
            y,
            { color: s.passed === false ? '#b42318' : undefined },
          );
          y += rowH;
        });
        doc.rect(m, y, w, rowH).fill(set.theme.accentColor);
        cell(
          [
            'Total',
            String(c.result.totalMax),
            '',
            String(c.result.totalObtained),
            c.result.percentage.toFixed(2),
            c.result.grade,
            ...(rc.showClassAverage ? [''] : []),
            ...(rc.showSubjectRemarks ? [''] : []),
          ],
          y,
          { bold: true },
        );
        y += rowH;
        doc
          .rect(m, tableTop, w, y - tableTop)
          .lineWidth(0.6)
          .strokeColor('#bbbbbb')
          .stroke();
        y += 8;

        // Summary.
        const summary: Array<[string, string]> = [
          ['Total marks', `${c.result.totalObtained} / ${c.result.totalMax}`],
          ['Percentage', `${c.result.percentage.toFixed(2)}%`],
          ['Grade', c.result.grade],
          ['Result', resultLabel(c.result)],
        ];
        if (rc.showPosition)
          summary.push(['Position in section', c.position ? `${c.position} of ${c.sectionSize}` : '-']);
        if (rc.showAttendance) {
          const counted = c.attendance.present + c.attendance.late + c.attendance.absent;
          summary.push([
            'Attendance',
            c.attendance.total
              ? `${c.attendance.present + c.attendance.late} of ${counted} days${c.attendance.rate === null ? '' : ` (${c.attendance.rate}%)`}`
              : 'No attendance recorded',
          ]);
        }
        y = k.fields(summary, m, y, w, 3, 9);
        if (c.result.remark && !c.result.incomplete) {
          k.text(`Remarks: ${c.result.remark}`, m, y + 2, { w, size: 9, italic: true, lines: 2 });
          y += k.size(9) * 2 + 6;
        }
        if (!c.result.passed && !c.result.incomplete) {
          const failed = c.result.subjects.filter((s) => s.passed === false).map((s) => s.subject);
          if (failed.length) {
            k.text(`Below pass marks in: ${failed.join(', ')}`, m, y, { w, size: 8.5, color: '#b42318', lines: 2 });
            y += k.size(8.5) * 2 + 4;
          }
        }
        if (rc.showGradingScale && c.gradingScale.length) {
          const scale = [...c.gradingScale]
            .sort((a, b) => b.minPercent - a.minPercent)
            .map((g) => `${g.grade}: ${g.minPercent}%+`)
            .join('   ');
          k.text(`Grading: ${scale}   ·   Overall pass mark ${c.passPercent}%`, m, y + 2, {
            w,
            size: 7.5,
            color: '#555555',
            lines: 2,
          });
          y += k.size(7.5) * 2 + 6;
        }
        if (rc.note) k.text(rc.note, m, y + 2, { w, size: 8, color: '#444444', lines: 3 });

        const labels = rc.signatureLabels.length ? rc.signatureLabels : ['Class Teacher', 'Principal'];
        const sigY = H - m - 52;
        const slot = w / labels.length;
        labels.forEach((l, i) => k.signature(l, m + i * slot + slot * 0.12, sigY, slot * 0.76, 8));
        k.footer(m, H - m - 18, w, 'Marks, totals and grades are calculated by the school system.');
      });
    },
    { margin: 0 },
  );
}
