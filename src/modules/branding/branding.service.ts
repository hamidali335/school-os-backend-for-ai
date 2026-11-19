import sharp from 'sharp';
import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import { deleteFile, readFile, saveBuffer } from '../../services/storage';
import type { Brand } from '../../services/pdf';
import type { SchoolContext } from '../../types/context';
import { badRequest } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { School } from '../schools/school.model';
import { resolveDocumentSettings, type DocumentSettingsPatchInput } from './document-settings';

/**
 * School branding: the school's own logo and document design. Everything is keyed by the
 * school id from the signed-in user's token, so one school can never read or change another's
 * branding, and the platform's own branding is separate (it lives in the frontends).
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIN_PX = 32;
const LOGO_MAX_PX = 6000;
/** Stored size: large enough to print sharply, small enough to embed in every PDF. */
const LOGO_STORE_PX = 600;

/**
 * The real file type from its first bytes. Checked before the image decoder sees the file, so
 * only PNG, JPEG and WebP ever reach it (never SVG, HEIF, TIFF or other formats it could parse).
 */
export function sniffLogoType(buffer: Buffer): 'png' | 'jpeg' | 'webp' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

/**
 * Decode, validate and normalise an uploaded logo to PNG. Re-encoding drops metadata and any
 * content that is not image pixels, and proves the file really is an image.
 */
export async function normaliseLogo(buffer: Buffer, mimeType: string) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType))
    throw badRequest('The logo must be a PNG, JPG or WebP image', { field: 'file' });
  if (buffer.length > LOGO_MAX_BYTES) throw badRequest('The logo must be 2 MB or smaller', { field: 'file' });
  const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[mimeType];
  if (sniffLogoType(buffer) !== expected)
    throw badRequest('The file content does not match its type', { field: 'file' });
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buffer, { limitInputPixels: LOGO_MAX_PX * LOGO_MAX_PX }).metadata();
  } catch {
    throw badRequest('This file is not a readable image', { field: 'file' });
  }
  if (meta.format !== expected) throw badRequest('The file content does not match its type', { field: 'file' });
  if (!meta.width || !meta.height || meta.width < LOGO_MIN_PX || meta.height < LOGO_MIN_PX)
    throw badRequest(`The logo must be at least ${LOGO_MIN_PX}×${LOGO_MIN_PX} pixels`, { field: 'file' });
  if (meta.width > LOGO_MAX_PX || meta.height > LOGO_MAX_PX)
    throw badRequest(`The logo must be at most ${LOGO_MAX_PX}×${LOGO_MAX_PX} pixels`, { field: 'file' });
  const png = await sharp(buffer, { limitInputPixels: LOGO_MAX_PX * LOGO_MAX_PX })
    .rotate()
    .resize({ width: LOGO_STORE_PX, height: LOGO_STORE_PX, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });
  return { png: png.data, width: png.info.width, height: png.info.height };
}

export async function getBranding(ctx: SchoolContext) {
  const school = await School.findById(ctx.schoolId).select('branding settings.documents').lean();
  const logo = school?.branding?.logo?.storageKey ? school.branding.logo : null;
  return {
    logo: logo
      ? { width: logo.width ?? 0, height: logo.height ?? 0, updatedAt: logo.updatedAt?.toISOString() ?? null }
      : null,
    documents: resolveDocumentSettings(school?.settings?.documents),
  };
}

export async function setLogo(ctx: SchoolContext, file: { buffer: Buffer; mimetype: string }) {
  const { png, width, height } = await normaliseLogo(file.buffer, file.mimetype);
  const stored = await saveBuffer(ctx.schoolId, 'branding', png, 'image/png', 'logo.png');
  const before = await School.findById(ctx.schoolId).select('branding.logo.storageKey').lean();
  await School.updateOne(
    { _id: ctx.schoolId },
    {
      $set: {
        'branding.logo': { storageKey: stored.storageKey, width, height, size: stored.size, updatedAt: new Date() },
      },
    },
  );
  // The old file is removed only after the new one is recorded.
  const old = before?.branding?.logo?.storageKey;
  if (old && old !== stored.storageKey) await deleteFile(old).catch(() => undefined);
  await audit(ctx, {
    action: 'school.logo_updated',
    entityType: 'School',
    entityId: ctx.schoolId,
    metadata: { width, height },
  });
  return getBranding(ctx);
}

export async function removeLogo(ctx: SchoolContext) {
  const before = await School.findById(ctx.schoolId).select('branding.logo.storageKey').lean();
  await School.updateOne({ _id: ctx.schoolId }, { $unset: { 'branding.logo': 1 } });
  if (before?.branding?.logo?.storageKey) await deleteFile(before.branding.logo.storageKey).catch(() => undefined);
  await audit(ctx, { action: 'school.logo_removed', entityType: 'School', entityId: ctx.schoolId });
  return getBranding(ctx);
}

export async function logoBytes(schoolId: string | Types.ObjectId): Promise<Buffer | null> {
  const school = await School.findById(schoolId).select('branding.logo.storageKey').lean();
  const key = school?.branding?.logo?.storageKey;
  if (!key) return null;
  try {
    return await readFile(key);
  } catch (err) {
    logger.warn({ err, schoolId: String(schoolId) }, 'School logo file is missing');
    return null;
  }
}

export async function updateDocumentSettings(ctx: SchoolContext, patch: DocumentSettingsPatchInput) {
  const school = await School.findById(ctx.schoolId).select('settings.documents').lean();
  const next = resolveDocumentSettings(school?.settings?.documents, patch);
  await School.updateOne({ _id: ctx.schoolId }, { $set: { 'settings.documents': next } });
  await audit(ctx, {
    action: 'school.documents_updated',
    entityType: 'School',
    entityId: ctx.schoolId,
    metadata: { sections: Object.keys(patch) },
  });
  return getBranding(ctx);
}

export async function resetDocumentSettings(ctx: SchoolContext) {
  await School.updateOne({ _id: ctx.schoolId }, { $unset: { 'settings.documents': 1 } });
  await audit(ctx, { action: 'school.documents_reset', entityType: 'School', entityId: ctx.schoolId });
  return getBranding(ctx);
}

/** Everything a PDF needs to look like this school's document. */
export async function loadBrand(schoolId: string | Types.ObjectId, patch?: DocumentSettingsPatchInput): Promise<Brand> {
  const school = await School.findById(schoolId).select('name address city phone email settings.documents').lean();
  return {
    schoolName: school?.name ?? '',
    address: [school?.address, school?.city].filter(Boolean).join(', ') || null,
    phone: school?.phone ?? null,
    email: school?.email ?? null,
    logo: await logoBytes(schoolId),
    settings: resolveDocumentSettings(school?.settings?.documents, patch),
  };
}
