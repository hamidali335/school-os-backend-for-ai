import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from '../utils/errors';
import { deleteWhenSafe } from './write-freeze';

/**
 * Private local file storage. Files are written under STORAGE_DIR, which is never mounted
 * as a static directory. Swap this module for S3/GCS/Azure Blob in multi-server deployments.
 */
const root = path.resolve(env.STORAGE_DIR);

export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

/** Magic-number check so a renamed executable cannot pass as a PDF/image. */
function sniff(buf: Buffer, declared: string): boolean {
  const hex = buf.subarray(0, 8).toString('hex');
  if (declared === 'application/pdf') return buf.subarray(0, 5).toString() === '%PDF-';
  if (declared === 'image/png') return hex.startsWith('89504e47');
  if (declared === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (declared === 'image/webp')
    return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  if (declared.includes('openxmlformats')) return hex.startsWith('504b0304');
  if (declared === 'application/msword' || declared === 'application/vnd.ms-excel') return hex.startsWith('d0cf11e0');
  if (declared === 'text/plain') return !buf.subarray(0, 512).includes(0);
  return false;
}

export const uploadSingle = (field = 'file') =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) return cb(badRequest(`File type ${file.mimetype} is not allowed`));
      cb(null, true);
    },
  }).single(field);

export async function saveBuffer(
  schoolId: string,
  category: string,
  buffer: Buffer,
  mimeType: string,
  originalName: string,
) {
  if (!sniff(buffer, mimeType)) throw badRequest('File content does not match its declared type');
  const ext = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '')
    .slice(0, 8);
  const key = path.posix.join(schoolId, category, `${crypto.randomUUID()}${ext}`);
  const full = path.join(root, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer, { mode: 0o600 });
  return { storageKey: key, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

export async function readFile(storageKey: string): Promise<Buffer> {
  const full = path.resolve(root, storageKey);
  // Defence in depth against path traversal via a tampered storageKey.
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return fs.readFile(full);
}

export async function deleteFile(storageKey: string): Promise<void> {
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) return;
  // While a backup runs, keep the bytes until it has copied them (see services/write-freeze.ts).
  await deleteWhenSafe(() => fs.rm(full, { force: true }));
}

/** Absolute path of the private file store (used by backups). */
export function storageRoot() {
  return root;
}

/** Safe Content-Disposition filename. */
export function dispositionName(name: string) {
  const ascii = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 120))}`;
}
