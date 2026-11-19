import crypto from 'node:crypto';
import fs from 'node:fs';
import { backupLimiter } from '../../middleware/rate-limit';
import type { Api } from '../../utils/api';
import { AppError, conflict, forbidden, notFound } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { paginationQuery, z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { verifyPassword } from '../auth/tokens';
import { PlatformAdmin } from '../platform-admin/platform-admin.model';
import { BackupDownloadToken, BackupJob } from './backup.model';
import { archivePath, backupsConfigured, deleteBackup, manifestPath, startBackup } from './backup.service';

/**
 * Platform backups. Platform OWNER only, on top of the platform network allow-list
 * (PLATFORM_ALLOWED_IPS). There is deliberately no restore endpoint: restoring over the
 * running production database is unsafe, so restore is an offline tool run on a clean server
 * (`npm run backup:restore`, docs/BACKUP_RESTORE.md).
 */
const OWNER = ['platform_owner'] as const;
const BackupIdParams = z.object({ backupId: z.string().regex(/^[0-9a-f]{32}$/, 'Invalid backup id') });
const DOWNLOAD_TTL_MS = 2 * 60_000;

const BackupRes = z
  .object({
    backupId: z.string(),
    type: z.string(),
    trigger: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'deleted']),
    phase: z.string().optional(),
    requestedByName: z.string().optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    verifiedAt: z.string().optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
    fileName: z.string().optional(),
    sizeBytes: z.number().optional(),
    sha256: z.string().optional(),
    keyId: z.string().optional(),
    consistency: z.string().optional(),
    manifest: z.any().optional(),
    deletedAt: z.string().optional(),
    deleteReason: z.string().optional(),
  })
  .openapi('PlatformBackup');

const PUBLIC_FIELDS =
  'backupId type trigger status phase requestedByName startedAt finishedAt verifiedAt durationMs error fileName sizeBytes sha256 keyId consistency manifest deletedAt deleteReason';

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function registerBackupRoutes(api: Api) {
  const tags = ['Platform Backups'];

  api.route({
    method: 'get',
    path: '/platform/backups/config',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    summary: 'Whether backups are configured on this server (no secret values)',
    response: z.object({ configured: z.boolean() }),
    handler: () => ({ configured: backupsConfigured() }),
  });

  api.route({
    method: 'get',
    path: '/platform/backups',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    summary: 'Backup history and status',
    query: paginationQuery.extend({ includeDeleted: z.enum(['true', 'false']).optional() }),
    response: BackupRes,
    paginated: true,
    handler: async ({ query }) =>
      paginate(BackupJob, query.includeDeleted === 'true' ? {} : { status: { $ne: 'deleted' } }, {
        page: query.page,
        limit: query.limit,
        sort: { startedAt: -1 },
        select: PUBLIC_FIELDS,
      }),
  });

  api.route({
    method: 'post',
    path: '/platform/backups',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    middleware: [backupLimiter],
    summary: 'Start a full backup (runs in the background; poll its status)',
    description:
      'Database + private files, encrypted. Becomes `completed` only after the archive was read back and every entry verified. One backup runs at a time (`BACKUP_IN_PROGRESS`).',
    status: 202,
    response: BackupRes,
    handler: async ({ ctx }) => {
      const job = await startBackup('manual', ctx);
      return BackupJob.findOne({ backupId: job.backupId }).select(PUBLIC_FIELDS).lean();
    },
  });

  // Registered before /:backupId so "download" is never parsed as an id.
  api.route({
    method: 'get',
    path: '/platform/backups/download',
    tags,
    auth: 'public',
    summary: 'Download a backup archive with a single-use link',
    description:
      'The link comes from `POST /platform/backups/{backupId}/download-link` and works once, for 2 minutes. The administrator who created it must still be an active platform owner with the same session generation, so revoking access (disable, password change, role change) also invalidates unused links.',
    query: z.object({ token: z.string().min(40).max(100) }),
    produces: 'application/octet-stream',
    handler: async ({ req, res, query }) => {
      const grant = await BackupDownloadToken.findOneAndUpdate(
        { tokenHash: hashToken(query.token), usedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!grant) throw new AppError(410, 'LINK_EXPIRED', 'This download link has expired or was already used.');
      const admin = await PlatformAdmin.findById(grant.adminId).select('name email role status tokenVersion').lean();
      if (
        !admin ||
        admin.status !== 'active' ||
        admin.role !== 'platform_owner' ||
        admin.tokenVersion !== grant.tokenVersion
      )
        throw forbidden('Your access to backups has changed. Sign in again.');
      const job = await BackupJob.findOne({ backupId: grant.backupId, status: 'completed' }).lean();
      const file = job && archivePath(job);
      if (!job || !file || !fs.existsSync(file)) throw notFound('Backup');
      const size = (await fs.promises.stat(file)).size;
      await audit(
        {
          kind: 'platform',
          adminId: admin._id.toString(),
          role: admin.role as 'platform_owner',
          name: admin.name,
          email: admin.email,
          ip: req.ip,
          requestId: req.requestId,
        },
        {
          action: 'platform.backup.downloaded',
          entityType: 'Backup',
          entityId: job.backupId,
          metadata: { bytes: size },
        },
      );
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(size));
      res.setHeader('Content-Disposition', `attachment; filename="${job.fileName}.tar.gz.enc"`);
      res.setHeader('Cache-Control', 'no-store');
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.on('error', reject);
        res.on('close', () => {
          stream.destroy();
          resolve();
        });
        stream.pipe(res);
      });
    },
  });

  api.route({
    method: 'get',
    path: '/platform/backups/:backupId',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    summary: 'Status and details of one backup',
    params: BackupIdParams,
    response: BackupRes,
    handler: async ({ params }) => {
      const job = await BackupJob.findOne({ backupId: params.backupId }).select(PUBLIC_FIELDS).lean();
      if (!job) throw notFound('Backup');
      return job;
    },
  });

  api.route({
    method: 'get',
    path: '/platform/backups/:backupId/manifest',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    summary: 'Manifest of a completed backup (checksums, counts, versions; no secrets)',
    params: BackupIdParams,
    response: z.any(),
    handler: async ({ ctx, params }) => {
      const job = await BackupJob.findOne({ backupId: params.backupId, status: 'completed' }).lean();
      const file = job && manifestPath(job);
      if (!job || !file || !fs.existsSync(file)) throw notFound('Backup');
      await audit(ctx, { action: 'platform.backup.manifest_downloaded', entityType: 'Backup', entityId: job.backupId });
      return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    },
  });

  api.route({
    method: 'post',
    path: '/platform/backups/:backupId/download-link',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    middleware: [backupLimiter],
    summary: 'Create a single-use, 2-minute download link (requires your password again)',
    params: BackupIdParams,
    body: z.object({ password: z.string().min(1).max(128) }),
    response: z.object({ url: z.string(), expiresAt: z.string(), fileName: z.string(), sizeBytes: z.number() }),
    handler: async ({ req, ctx, params, body }) => {
      const admin = await PlatformAdmin.findById(ctx.adminId).select('+passwordHash tokenVersion').lean();
      if (!admin || !(await verifyPassword(body.password, admin.passwordHash))) {
        await audit(ctx, {
          action: 'platform.backup.download_denied',
          entityType: 'Backup',
          entityId: params.backupId,
          outcome: 'failure',
        });
        throw new AppError(403, 'REAUTH_FAILED', 'Password is incorrect');
      }
      const job = await BackupJob.findOne({ backupId: params.backupId }).lean();
      if (!job) throw notFound('Backup');
      if (job.status !== 'completed') throw conflict(`This backup is ${job.status} and cannot be downloaded`);
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MS);
      await BackupDownloadToken.create({
        tokenHash: hashToken(token),
        backupId: job.backupId,
        adminId: ctx.adminId,
        tokenVersion: admin.tokenVersion ?? 0,
        expiresAt,
      });
      await audit(ctx, {
        action: 'platform.backup.download_link_created',
        entityType: 'Backup',
        entityId: job.backupId,
      });
      const base = req.baseUrl || '/api/v1';
      return {
        url: `${base}/platform/backups/download?token=${token}`,
        expiresAt: expiresAt.toISOString(),
        fileName: `${job.fileName}.tar.gz.enc`,
        sizeBytes: job.sizeBytes ?? 0,
      };
    },
  });

  api.route({
    method: 'delete',
    path: '/platform/backups/:backupId',
    tags,
    auth: 'platform',
    platformRoles: [...OWNER],
    middleware: [backupLimiter],
    summary: 'Delete a backup from the server (requires your password again)',
    description: 'The only remaining verified backup cannot be deleted (`LAST_VERIFIED_BACKUP`).',
    params: BackupIdParams,
    body: z.object({ password: z.string().min(1).max(128) }),
    status: 204,
    handler: async ({ ctx, params, body }) => {
      const admin = await PlatformAdmin.findById(ctx.adminId).select('+passwordHash').lean();
      if (!admin || !(await verifyPassword(body.password, admin.passwordHash)))
        throw new AppError(403, 'REAUTH_FAILED', 'Password is incorrect');
      await deleteBackup(ctx, params.backupId);
    },
  });
}
