import { z } from '../../utils/zod';

/**
 * How a school's printable documents look (challans, receipts, certificates, reports).
 * Only these validated options exist, so no setting can break a layout or hide a required
 * field: amounts, dates, numbers and names are always printed. Saved per school.
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f4e79');
const label = (max: number) => z.string().trim().max(max);

export const DocumentSettingsSchema = z
  .object({
    theme: z.object({
      primaryColor: hex,
      accentColor: hex,
      fontFamily: z.enum(['helvetica', 'times', 'courier']),
      fontScale: z.number().min(0.85).max(1.25),
    }),
    header: z.object({
      logoPosition: z.enum(['left', 'center', 'right', 'none']),
      logoSize: z.enum(['small', 'medium', 'large']),
      showAddress: z.boolean(),
      showPhone: z.boolean(),
      showEmail: z.boolean(),
      tagline: label(80),
    }),
    page: z.object({ margin: z.enum(['narrow', 'normal', 'wide']) }),
    footer: z.object({ text: label(200), showGeneratedNote: z.boolean() }),
    challan: z.object({
      copies: z.number().int().min(1).max(4),
      copyLabels: z.array(label(24)).max(4),
      paper: z.enum(['A4', 'Legal', 'Letter']),
      orientation: z.enum(['landscape', 'portrait']),
      showItemBreakdown: z.boolean(),
      showBankDetails: z.boolean(),
      instructions: label(300),
      signatureLabel: label(40),
    }),
    receipt: z.object({ paper: z.enum(['A5', 'A4']), signatureLabel: label(40) }),
    certificate: z.object({
      style: z.enum(['classic', 'modern', 'minimal']),
      orientation: z.enum(['landscape', 'portrait']),
      signatureLabels: z.array(label(40)).max(3),
    }),
    /** Result cards: wording and which optional blocks print. Marks, totals and grades always print. */
    reportCard: z.object({
      title: label(60),
      showPosition: z.boolean(),
      showAttendance: z.boolean(),
      showGradingScale: z.boolean(),
      showClassAverage: z.boolean(),
      showSubjectRemarks: z.boolean(),
      signatureLabels: z.array(label(40)).max(3),
      note: label(300),
    }),
  })
  .openapi('DocumentSettings');

export type DocumentSettings = z.infer<typeof DocumentSettingsSchema>;

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  theme: { primaryColor: '#1f4e79', accentColor: '#e8eef5', fontFamily: 'helvetica', fontScale: 1 },
  header: {
    logoPosition: 'left',
    logoSize: 'medium',
    showAddress: true,
    showPhone: true,
    showEmail: false,
    tagline: '',
  },
  page: { margin: 'normal' },
  footer: { text: '', showGeneratedNote: true },
  challan: {
    copies: 3,
    copyLabels: ['Bank Copy', 'School Copy', 'Student Copy'],
    paper: 'A4',
    orientation: 'landscape',
    showItemBreakdown: true,
    showBankDetails: true,
    instructions: 'Please pay before the due date. A late fee may apply after the due date.',
    signatureLabel: 'Cashier / Bank Officer',
  },
  receipt: { paper: 'A5', signatureLabel: 'Accountant' },
  certificate: { style: 'classic', orientation: 'landscape', signatureLabels: ['Class Teacher', 'Principal'] },
  reportCard: {
    title: 'Result Card',
    showPosition: true,
    showAttendance: true,
    showGradingScale: true,
    showClassAverage: false,
    showSubjectRemarks: true,
    signatureLabels: ['Class Teacher', 'Principal', 'Parent / Guardian'],
    note: '',
  },
};

/** Partial update shape: each section and field optional. */
export const DocumentSettingsPatch = z
  .object({
    theme: DocumentSettingsSchema.shape.theme.partial(),
    header: DocumentSettingsSchema.shape.header.partial(),
    page: DocumentSettingsSchema.shape.page.partial(),
    footer: DocumentSettingsSchema.shape.footer.partial(),
    challan: DocumentSettingsSchema.shape.challan.partial(),
    receipt: DocumentSettingsSchema.shape.receipt.partial(),
    certificate: DocumentSettingsSchema.shape.certificate.partial(),
    reportCard: DocumentSettingsSchema.shape.reportCard.partial(),
  })
  .partial()
  .openapi('DocumentSettingsPatch');
export type DocumentSettingsPatchInput = z.infer<typeof DocumentSettingsPatch>;

/** Stored settings (possibly partial or from an older version) merged over the defaults. */
export function resolveDocumentSettings(stored: unknown, patch?: DocumentSettingsPatchInput): DocumentSettings {
  const s = (stored ?? {}) as Partial<Record<keyof DocumentSettings, Record<string, unknown>>>;
  const out = {} as Record<keyof DocumentSettings, unknown>;
  for (const k of Object.keys(DEFAULT_DOCUMENT_SETTINGS) as Array<keyof DocumentSettings>) {
    const candidate = { ...DEFAULT_DOCUMENT_SETTINGS[k], ...(s[k] ?? {}), ...(patch?.[k] ?? {}) };
    // A section that no longer validates (e.g. an option removed in a later version) falls
    // back to its defaults; the other sections keep the school's choices.
    const parsed = DocumentSettingsSchema.shape[k].safeParse(candidate);
    out[k] = parsed.success ? parsed.data : DEFAULT_DOCUMENT_SETTINGS[k];
  }
  return out as DocumentSettings;
}
