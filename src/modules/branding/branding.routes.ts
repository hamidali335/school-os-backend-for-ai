import multer from 'multer';
import { renderCertificate, renderChallan, renderReceipt, renderReport } from '../../services/pdf';
import type { Api } from '../../utils/api';
import { badRequest } from '../../utils/errors';
import { z } from '../../utils/zod';
import { addDays } from '../../utils/dates';
import { DocumentSettingsPatch, DocumentSettingsSchema } from './document-settings';
import {
  getBranding,
  LOGO_MAX_BYTES,
  loadBrand,
  logoBytes,
  removeLogo,
  resetDocumentSettings,
  setLogo,
  updateDocumentSettings,
} from './branding.service';

const BrandingRes = z
  .object({
    logo: z.object({ width: z.number(), height: z.number(), updatedAt: z.string().nullable() }).nullable(),
    documents: DocumentSettingsSchema,
  })
  .openapi('SchoolBranding');

/** Logos only: PNG, JPEG or WebP, 2 MB. The content is decoded and re-encoded on the server. */
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype))
      return cb(badRequest('The logo must be a PNG, JPG or WebP image', { field: 'file' }));
    cb(null, true);
  },
}).single('file');

const DOC_KINDS = ['challan', 'installment_challan', 'receipt', 'certificate', 'report'] as const;

/** Sample content for previews: the school's real name and logo, clearly fictional records. */
function sampleChallan(installment: boolean) {
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  return {
    bankDetails: 'Your bank details from Settings → Fees appear here',
    invoiceNo: 'SAMPLE-0001',
    period: today.toISOString().slice(0, 7),
    issueDate: today,
    dueDate: addDays(today, 9),
    studentName: 'Ayesha Khan (sample)',
    admissionNo: 'ADM-00001',
    fatherName: 'Imran Khan',
    className: 'Class 5',
    sectionName: 'A',
    items: [
      { name: 'Tuition Fee', amount: 6500 },
      { name: 'Computer Lab', amount: 500 },
      { name: 'Examination Fee', amount: 1000 },
    ],
    subtotal: 8000,
    concession: 800,
    waiver: 0,
    lateFee: 0,
    total: 7200,
    paid: installment ? 2400 : 0,
    balance: installment ? 4800 : 7200,
    status: installment ? 'partial' : 'unpaid',
    ...(installment
      ? { installment: { no: 2, count: 3, amount: 2400, paid: 0, outstanding: 2400, dueDate: addDays(today, 39) } }
      : {}),
  };
}

export function registerBrandingRoutes(api: Api) {
  const tags = ['School branding'];

  api.route({
    method: 'get',
    path: '/school/branding',
    tags,
    auth: 'school',
    summary: "This school's logo details and document design settings",
    response: BrandingRes,
    handler: ({ ctx }) => getBranding(ctx),
  });

  api.route({
    method: 'get',
    path: '/school/branding/logo',
    tags,
    auth: 'school',
    summary: "This school's logo (PNG). 404 when none is uploaded",
    description: 'Only ever returns the logo of the signed-in user’s own school.',
    produces: 'image/png',
    handler: async ({ ctx, res }) => {
      const png = await logoBytes(ctx.schoolId);
      if (!png) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo uploaded' } });
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(png);
    },
  });

  api.route({
    method: 'put',
    path: '/school/branding/logo',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Upload or replace the school logo',
    description:
      'multipart/form-data with one `file` field: PNG, JPG or WebP, at most 2 MB, 32–6000 px. The image is decoded, checked and stored as a PNG (max 600 px) for documents.',
    upload: { middleware: logoUpload, field: 'file' },
    response: BrandingRes,
    handler: ({ ctx, req }) => {
      if (!req.file) throw badRequest('file is required', { field: 'file' });
      return setLogo(ctx, req.file);
    },
  });

  api.route({
    method: 'delete',
    path: '/school/branding/logo',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Remove the school logo (documents fall back to the school name only)',
    response: BrandingRes,
    handler: ({ ctx }) => removeLogo(ctx),
  });

  api.route({
    method: 'patch',
    path: '/school/branding/documents',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Change document design settings (partial; validated)',
    body: DocumentSettingsPatch,
    response: BrandingRes,
    handler: ({ ctx, body }) => updateDocumentSettings(ctx, body),
  });

  api.route({
    method: 'delete',
    path: '/school/branding/documents',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Restore the default document design',
    response: BrandingRes,
    handler: ({ ctx }) => resetDocumentSettings(ctx),
  });

  api.route({
    method: 'post',
    path: '/school/branding/documents/preview',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Preview a document with unsaved design settings (PDF; nothing is saved)',
    description:
      'Renders sample content with the school’s logo and the given settings over the saved ones, using the same renderer as real documents, so the preview matches the printed output.',
    body: z.object({ kind: z.enum(DOC_KINDS), settings: DocumentSettingsPatch.optional() }),
    produces: 'application/pdf',
    handler: async ({ ctx, body, res }) => {
      const brand = await loadBrand(ctx.schoolId, body.settings);
      let pdf: Buffer;
      if (body.kind === 'challan' || body.kind === 'installment_challan')
        pdf = await renderChallan(sampleChallan(body.kind === 'installment_challan'), brand);
      else if (body.kind === 'receipt')
        pdf = await renderReceipt(
          {
            receiptNo: 'RCP-SAMPLE-01',
            receivedAt: new Date(),
            studentName: 'Ayesha Khan (sample)',
            admissionNo: 'ADM-00001',
            className: 'Class 5 · Section A',
            invoiceNo: 'SAMPLE-0001',
            period: new Date().toISOString().slice(0, 7),
            amount: 2400,
            method: 'cash',
            reference: '-',
            balanceAfter: 4800,
            receivedBy: ctx.name,
            status: 'valid',
          },
          brand,
        );
      else if (body.kind === 'certificate')
        pdf = await renderCertificate(
          {
            title: 'Character Certificate',
            serialNo: 'CERT-SAMPLE-00001',
            issueDate: new Date(),
            body: `This is to certify that Ayesha Khan (sample), daughter of Imran Khan, Admission No. ADM-00001, is a student of ${brand.schoolName} in Class 5.

To the best of our knowledge and according to the school record, the conduct and character of the student have remained excellent. The school has no adverse record against her name.

This certificate is issued on the request of the parent/guardian. We wish Ayesha Khan a bright and successful future.`,
            details: [
              ['Admission No.', 'ADM-00001'],
              ['Class', 'Class 5'],
              ['Academic Session', '2026-2027'],
              ['Conduct', 'Excellent'],
            ],
            emphasis: ['Ayesha Khan', 'ADM-00001', 'Class 5', 'excellent'],
            salutation: 'To whom it may concern',
            issuedBy: ctx.name,
          },
          brand,
        );
      else
        pdf = await renderReport(
          {
            title: 'Fee collection (sample)',
            subtitle: 'Grouped by day',
            columns: [
              { key: 'key', label: 'Date', width: 2 },
              { key: 'count', label: 'Payments', align: 'right' },
              { key: 'total', label: 'Amount (Rs)', align: 'right', width: 1.5 },
            ],
            rows: Array.from({ length: 8 }, (_, i) => ({
              key: `Day ${i + 1}`,
              count: 3 + i,
              total: ((3 + i) * 2400).toLocaleString('en-PK'),
            })),
            totals: { key: 'Total', count: 52, total: (52 * 2400).toLocaleString('en-PK') },
          },
          brand,
        );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="preview-${body.kind}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    },
  });
}
