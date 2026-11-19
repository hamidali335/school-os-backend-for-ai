import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { mongoTopology } from '../../database/transactions';
import { storageRoot } from '../../services/storage';
import { freezeWrites, setBackupActive, unfreezeWrites } from '../../services/write-freeze';
import type { PlatformContext } from '../../types/context';
import { AppError, conflict, notFound } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import {
  compareWithManifest,
  FORMAT,
  FORMAT_VERSION,
  listStorageFiles,
  readArchive,
  safeCollectionFile,
  writeArchive,
  type ArchiveSource,
  type BackupManifest,
  type CollectionEntry,
  type SchoolFinancials,
} from './archive';
import { keyId, parseKey } from './backup-crypto';
import { BackupJob, EXCLUDED_COLLECTIONS } from './backup.model';

const EJSON = mongoose.mongo.BSON.EJSON;
const HEARTBEAT_MS = 30_000;
const STALE_MS = 3 * 60_000;

export function backupDir() {
  return path.resolve(env.BACKUP_DIR);
}

export function backupsConfigured() {
  return Boolean(env.BACKUP_ENCRYPTION_KEY);
}

function requireKey(): Buffer {
  if (!env.BACKUP_ENCRYPTION_KEY)
    throw new AppError(
      503,
      'BACKUP_NOT_CONFIGURED',
      'Backups are not configured on this server (BACKUP_ENCRYPTION_KEY).',
    );
  return parseKey(env.BACKUP_ENCRYPTION_KEY);
}

export function archiveFileName(type: string, startedAt: Date) {
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `school-os-${type}-${stamp}`;
}

function paths(fileBase: string) {
  const dir = backupDir();
  return {
    archive: path.join(dir, `${fileBase}.tar.gz.enc`),
    partial: path.join(dir, `${fileBase}.tar.gz.enc.partial`),
    manifest: path.join(dir, `${fileBase}.manifest.json`),
    work: path.join(dir, '.work', fileBase),
  };
}

/** Git commit of the running code: APP_GIT_COMMIT, else read from .git without a subprocess. */
export function gitCommit(): string | null {
  if (env.APP_GIT_COMMIT) return env.APP_GIT_COMMIT;
  try {
    const gitDir = path.resolve(__dirname, '..', '..', '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    return (
      packed
        .split('\n')
        .find((l) => l.endsWith(` ${ref}`))
        ?.split(' ')[0] ?? null
    );
  } catch {
    return null;
  }
}

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

// ───────────────────────────── Starting a backup ─────────────────────────────

export async function startBackup(trigger: 'manual' | 'schedule', ctx?: PlatformContext) {
  requireKey();
  const startedAt = new Date();
  const backupId = crypto.randomBytes(16).toString('hex');
  let job;
  try {
    job = await BackupJob.create({
      backupId,
      trigger,
      status: 'running',
      lock: 'active',
      phase: 'starting',
      requestedBy: ctx?.adminId,
      requestedByName: ctx?.name ?? 'Scheduled backup',
      startedAt,
      fileName: archiveFileName('full', startedAt),
      keyId: keyId(requireKey()),
      heartbeatAt: startedAt,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict('A backup is already running. Wait for it to finish.', undefined, 'BACKUP_IN_PROGRESS');
    throw err;
  }
  if (ctx)
    await audit(ctx, {
      action: 'platform.backup.requested',
      entityType: 'Backup',
      entityId: backupId,
      summary: trigger,
    });
  void runBackup(job.backupId).catch((err) => logger.error({ err, backupId }, 'Backup crashed'));
  return job.toObject();
}

async function setPhase(backupId: string, phase: string) {
  await BackupJob.updateOne({ backupId, status: 'running' }, { $set: { phase, heartbeatAt: new Date() } });
}

// ───────────────────────────── Running a backup ─────────────────────────────

/** Runs a job to completion: `completed` only after the archive re-read verified, else `failed`. */
export async function runBackup(backupId: string): Promise<void> {
  const job = await BackupJob.findOne({ backupId }).lean();
  if (!job || job.status !== 'running') return;
  const key = requireKey();
  const p = paths(job.fileName!);
  const started = Date.now();
  const heartbeat = setInterval(() => {
    void BackupJob.updateOne({ backupId, status: 'running' }, { $set: { heartbeatAt: new Date() } }).catch(
      () => undefined,
    );
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let timer: NodeJS.Timeout | undefined;
  setBackupActive(true);
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Backup timed out after ${env.BACKUP_TIMEOUT_MINUTES} minutes`)),
        env.BACKUP_TIMEOUT_MINUTES * 60_000,
      );
    });
    const manifest = await Promise.race([produce(job as any, key, p), timeout]);
    // Atomic completion: the final name and the `completed` status appear only after verification.
    await fs.promises.rename(p.partial, p.archive);
    await fs.promises.writeFile(p.manifest, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await BackupJob.updateOne(
      { backupId },
      {
        $set: {
          status: 'completed',
          phase: 'completed',
          finishedAt: new Date(),
          verifiedAt: new Date(),
          durationMs: Date.now() - started,
          sizeBytes: manifest.archive!.sizeBytes,
          sha256: manifest.archive!.sha256,
          consistency: manifest.database.consistency,
          manifest: summariseManifest(manifest),
        },
        $unset: { lock: 1 },
      },
    );
    logger.info(
      { backupId, ms: Date.now() - started, bytes: manifest.archive!.sizeBytes },
      'Backup completed and verified',
    );
    await applyRetention().catch((err) => logger.error({ err }, 'Backup retention failed'));
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logger.error({ err, backupId }, 'Backup failed');
    await fs.promises.rm(p.partial, { force: true }).catch(() => undefined);
    await BackupJob.updateOne(
      { backupId },
      {
        $set: {
          status: 'failed',
          phase: 'failed',
          error: message,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        },
        $unset: { lock: 1 },
      },
    ).catch((e) => logger.error({ err: e, backupId }, 'Could not record backup failure'));
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    unfreezeWrites();
    setBackupActive(false);
    await fs.promises.rm(p.work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Keeps the job document small; the full manifest (file list) lives next to the archive. */
function summariseManifest(m: BackupManifest) {
  return {
    formatVersion: m.formatVersion,
    app: m.app,
    database: m.database,
    collections: m.collections.map((c) => ({ name: c.name, documents: c.documents })),
    files: { count: m.files.count, bytes: m.files.bytes, skipped: m.files.skipped.length },
  };
}

async function assertDiskSpace(estimate: number) {
  const st = await fs.promises.statfs(backupDir());
  const free = st.bavail * st.bsize;
  const needed = Math.ceil(estimate * 1.5) + 512 * 1024 * 1024;
  if (free < needed)
    throw new Error(
      `Not enough free disk space for a backup: ${Math.round(free / 1e6)} MB free, about ${Math.round(needed / 1e6)} MB needed`,
    );
}

async function produce(
  job: { backupId: string; startedAt: Date; fileName: string },
  key: Buffer,
  p: ReturnType<typeof paths>,
): Promise<BackupManifest> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected');
  await fs.promises.mkdir(p.work, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.join(p.work, 'db'), { recursive: true, mode: 0o700 });

  const stats = await db.stats();
  const storage = await listStorageFiles(storageRoot());
  await assertDiskSpace((stats.dataSize ?? 0) + storage.files.reduce((s, f) => s + f.size, 0));

  const build = await db.admin().command({ buildInfo: 1 });
  const topology = mongoTopology();
  const wantSnapshot =
    env.BACKUP_CONSISTENCY === 'snapshot' ||
    (env.BACKUP_CONSISTENCY === 'auto' && (topology === 'replicaSet' || topology === 'sharded'));

  await setPhase(job.backupId, 'exporting database');
  let exported: Awaited<ReturnType<typeof exportDatabase>>;
  let consistency: 'snapshot' | 'write-freeze';
  let files: Array<{ key: string; size: number }>;
  if (wantSnapshot) {
    const session = mongoose.connection.getClient().startSession({ snapshot: true });
    try {
      exported = await exportDatabase(p.work, session);
      consistency = 'snapshot';
    } catch (err) {
      if (env.BACKUP_CONSISTENCY === 'snapshot' || !isSnapshotUnsupported(err)) throw err;
      logger.warn({ err }, 'Snapshot reads unavailable; falling back to pausing writes for the backup');
      exported = await frozen(() => exportDatabase(p.work));
      consistency = 'write-freeze';
    } finally {
      await session.endSession().catch(() => undefined);
    }
    // Files deleted since the snapshot are kept until the backup ends (deferred deletion).
    files = (await listStorageFiles(storageRoot())).files;
  } else {
    // Writes stay paused only while the database is read and the file list is taken; files
    // cannot be deleted until the backup ends, and later uploads are simply not included.
    const res = await frozen(async () => ({
      e: await exportDatabase(p.work),
      f: await listStorageFiles(storageRoot()),
    }));
    exported = res.e;
    files = res.f.files;
    consistency = 'write-freeze';
  }

  // Every file the backed-up metadata points to must be in the archive.
  const present = new Set(files.map((f) => f.key));
  const missing = exported.referencedKeys.filter((k) => !present.has(k));
  if (missing.length)
    throw new Error(
      `${missing.length} file(s) referenced by the database are missing from storage (first: ${missing[0]})`,
    );

  const manifest: BackupManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    backupId: job.backupId,
    type: 'full',
    createdAt: new Date(job.startedAt).toISOString(),
    app: { name: env.APP_NAME, version: appVersion(), gitCommit: gitCommit(), node: process.version },
    database: {
      name: db.databaseName,
      serverVersion: build.version,
      topology,
      consistency,
      ...(exported.snapshotTime ? { snapshotClusterTime: exported.snapshotTime } : {}),
    },
    encryption: { algorithm: 'AES-256-GCM', keyId: keyId(key) },
    collections: exported.collections,
    files: { count: 0, bytes: 0, entries: [], skipped: storage.skipped, referencedMissing: 0 },
    integrity: exported.integrity,
    restore: {
      minimumMongoVersion: build.version.split('.').slice(0, 1).join('.') + '.0',
      notes: [
        'Restore with `npm run backup:restore` from the same application version (app.gitCommit), into an EMPTY database.',
        'Needs the backup encryption key with the keyId above. Keys are never stored in backups.',
        'Not included: refresh tokens (users sign in again), server secrets (.env), TLS certificates, external provider accounts.',
        'AI provider keys saved in the panel are encrypted with SETTINGS_ENCRYPTION_KEY (or a key derived from JWT_PLATFORM_SECRET); keep the same value or re-enter them.',
      ],
    },
  };

  await setPhase(job.backupId, 'writing archive');
  const fileEntries: BackupManifest['files']['entries'] = [];
  const dbChecks = new Map(exported.collections.map((c) => [c.file, c]));
  const root = storageRoot();
  async function* sources(): AsyncGenerator<ArchiveSource> {
    for (const c of exported.collections)
      yield { name: c.file, kind: 'path', path: path.join(p.work, c.file), size: c.bytes };
    for (const f of files) yield { name: `files/${f.key}`, kind: 'path', path: path.join(root, f.key), size: f.size };
    manifest.files.entries = fileEntries;
    manifest.files.count = fileEntries.length;
    manifest.files.bytes = fileEntries.reduce((s, f) => s + f.size, 0);
    manifest.completedAt = new Date().toISOString();
    yield { name: 'manifest.json', kind: 'buffer', data: Buffer.from(JSON.stringify(manifest, null, 2)) };
  }
  const out = fs.createWriteStream(p.partial, { mode: 0o600, flags: 'wx' });
  const written = await writeArchive(out, key, sources(), (name, sha256, size) => {
    if (name.startsWith('files/')) fileEntries.push({ key: name.slice(6), size, sha256 });
    else if (dbChecks.has(name) && dbChecks.get(name)!.sha256 !== sha256)
      throw new Error(`Export of ${name} changed while it was archived`);
  });

  // Verification: read the archive back from disk exactly as a restore would.
  await setPhase(job.backupId, 'verifying');
  const onDisk = await sha256File(p.partial);
  if (onDisk !== written.sha256) throw new Error('Archive on disk does not match what was written');
  const read = await readArchive(p.partial, key);
  if (read.manifest.backupId !== job.backupId) throw new Error('Archive manifest does not belong to this backup');
  const problems = compareWithManifest(read.entries, manifest);
  if (problems.length) throw new Error(`Archive verification failed: ${problems.slice(0, 3).join('; ')}`);

  return {
    ...manifest,
    archive: { fileName: `${job.fileName}.tar.gz.enc`, sizeBytes: written.bytes, sha256: written.sha256 },
  };
}

async function frozen<T>(fn: () => Promise<T>): Promise<T> {
  await freezeWrites();
  try {
    return await fn();
  } finally {
    unfreezeWrites();
  }
}

function isSnapshotUnsupported(err: unknown) {
  const e = err as { code?: number; codeName?: string; message?: string };
  return (
    e?.codeName === 'InvalidOptions' ||
    e?.codeName === 'NotImplemented' ||
    /snapshot/i.test(e?.message ?? '') ||
    e?.code === 72
  );
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c as Buffer);
  return hash.digest('hex');
}

const emptyFinancials = (): SchoolFinancials => ({
  invoices: 0,
  invoiceTotal: 0,
  invoicePaid: 0,
  invoiceBalance: 0,
  invoiceWaiver: 0,
  validPayments: 0,
  validPaymentAmount: 0,
  reversedPayments: 0,
});

const num = (v: unknown) => (typeof v === 'number' ? v : Number((v as any)?.toString?.() ?? 0)) || 0;

/** Exports every non-system collection (also ones no model declares) as canonical EJSON lines. */
async function exportDatabase(work: string, session?: mongoose.mongo.ClientSession) {
  const db = mongoose.connection.db!;
  const infos = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c: any) => c.type !== 'view' && !c.name.startsWith('system.') && !EXCLUDED_COLLECTIONS.has(c.name))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  const collections: CollectionEntry[] = [];
  const financials: Record<string, SchoolFinancials> = {};
  const usersByRole: Record<string, number> = {};
  let guardianLinks = 0;
  const referencedKeys: string[] = [];
  let snapshotTime: string | undefined;

  for (const [i, info] of infos.entries()) {
    const name = (info as any).name as string;
    const file = safeCollectionFile(name, i);
    const target = path.join(work, file);
    const out = fs.createWriteStream(target, { mode: 0o600 });
    const hash = crypto.createHash('sha256');
    let documents = 0;
    let bytes = 0;
    const cursor = db.collection(name).find({}, { session, batchSize: 1000 });
    for await (const doc of cursor) {
      const line = Buffer.from(EJSON.stringify(doc, { relaxed: false }) + '\n');
      hash.update(line);
      bytes += line.length;
      documents++;
      if (!out.write(line)) await new Promise<void>((r) => out.once('drain', () => r()));
      const sid = String((doc as any).schoolId ?? '');
      if (name === 'invoices') {
        const f = (financials[sid] ??= emptyFinancials());
        f.invoices++;
        f.invoiceTotal += num(doc.total);
        f.invoicePaid += num(doc.paid);
        f.invoiceBalance += num(doc.balance);
        f.invoiceWaiver += num(doc.waiver);
      } else if (name === 'payments') {
        const f = (financials[sid] ??= emptyFinancials());
        if (doc.status === 'reversed') f.reversedPayments++;
        else {
          f.validPayments++;
          f.validPaymentAmount += num(doc.amount);
        }
      } else if (name === 'users') usersByRole[String(doc.role)] = (usersByRole[String(doc.role)] ?? 0) + 1;
      else if (name === 'students') guardianLinks += Array.isArray(doc.guardians) ? doc.guardians.length : 0;
      else if (name === 'fileobjects' && typeof doc.storageKey === 'string') referencedKeys.push(doc.storageKey);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    // The driver records the cluster time the snapshot was taken at after the first read.
    const at = (session as unknown as { snapshotTime?: { toString(): string } } | undefined)?.snapshotTime;
    if (at && !snapshotTime) snapshotTime = at.toString();
    const indexes = (await db.collection(name).listIndexes().toArray()) as Array<Record<string, unknown>>;
    collections.push({
      name,
      file,
      documents,
      bytes,
      sha256: hash.digest('hex'),
      options: ((info as any).options ?? {}) as Record<string, unknown>,
      indexes,
    });
  }
  for (const f of Object.values(financials))
    for (const k of Object.keys(f) as Array<keyof SchoolFinancials>) f[k] = Math.round(f[k] * 100) / 100;
  return { collections, integrity: { financials, usersByRole, guardianLinks }, referencedKeys, snapshotTime };
}

// ───────────────────────────── Retention / recovery ─────────────────────────────

/**
 * Keeps the newest BACKUP_RETENTION_COUNT completed backups on the server. The newest verified
 * backup is never removed (retention count is at least 1). Copies already downloaded to another
 * computer are not affected.
 */
export async function applyRetention() {
  const completed = await BackupJob.find({ status: 'completed' })
    .sort({ startedAt: -1 })
    .select('backupId fileName')
    .lean();
  for (const old of completed.slice(Math.max(1, env.BACKUP_RETENTION_COUNT))) {
    await removeFiles(old.fileName!);
    await BackupJob.updateOne(
      { backupId: old.backupId, status: 'completed' },
      { $set: { status: 'deleted', deletedAt: new Date(), deleteReason: 'retention' } },
    );
    logger.info({ backupId: old.backupId }, 'Backup removed by retention policy');
  }
}

async function removeFiles(fileBase: string) {
  const p = paths(fileBase);
  await fs.promises.rm(p.archive, { force: true });
  await fs.promises.rm(p.manifest, { force: true });
}

/**
 * At startup: a backup whose process died (no heartbeat) can never finish. Mark it failed and
 * remove its partial archive and work folder so it cannot be mistaken for a usable backup.
 */
export async function recoverInterruptedBackups() {
  await fs.promises.mkdir(backupDir(), { recursive: true, mode: 0o700 });
  const stale = await BackupJob.find({
    status: 'running',
    $or: [{ heartbeatAt: { $lt: new Date(Date.now() - STALE_MS) } }, { heartbeatAt: null }],
  }).lean();
  for (const job of stale) {
    const p = paths(job.fileName!);
    await fs.promises.rm(p.partial, { force: true });
    await fs.promises.rm(p.work, { recursive: true, force: true });
    await BackupJob.updateOne(
      { backupId: job.backupId, status: 'running' },
      {
        $set: {
          status: 'failed',
          phase: 'failed',
          error: 'Interrupted: the server stopped while the backup was running',
          finishedAt: new Date(),
        },
        $unset: { lock: 1 },
      },
    );
    logger.warn({ backupId: job.backupId }, 'Marked interrupted backup as failed');
  }
}

export async function deleteBackup(ctx: PlatformContext, backupId: string) {
  const job = await BackupJob.findOne({ backupId }).lean();
  if (!job || job.status === 'deleted') throw notFound('Backup');
  if (job.status === 'running') throw conflict('A running backup cannot be deleted', undefined, 'BACKUP_IN_PROGRESS');
  if (job.status === 'completed') {
    const others = await BackupJob.countDocuments({ status: 'completed', backupId: { $ne: backupId } });
    if (others === 0)
      throw conflict(
        'This is the only verified backup on the server. Create a newer backup before deleting it.',
        undefined,
        'LAST_VERIFIED_BACKUP',
      );
  }
  if (job.fileName) await removeFiles(job.fileName);
  await BackupJob.updateOne(
    { backupId },
    { $set: { status: 'deleted', deletedAt: new Date(), deletedBy: ctx.adminId, deleteReason: 'manual' } },
  );
  await audit(ctx, { action: 'platform.backup.deleted', entityType: 'Backup', entityId: backupId });
}

export function archivePath(job: { fileName?: string | null }) {
  if (!job.fileName) return null;
  return paths(job.fileName).archive;
}

export function manifestPath(job: { fileName?: string | null }) {
  if (!job.fileName) return null;
  return paths(job.fileName).manifest;
}

// ───────────────────────────── Schedule ─────────────────────────────

let scheduleTimer: NodeJS.Timeout | undefined;

/** Starts a full backup whenever the newest completed one is older than BACKUP_INTERVAL_HOURS. */
export async function scheduledBackupTick(now = new Date()) {
  if (!backupsConfigured()) return;
  const due = new Date(now.getTime() - env.BACKUP_INTERVAL_HOURS * 3_600_000);
  const [recent, running, recentFailure] = await Promise.all([
    BackupJob.exists({ status: 'completed', startedAt: { $gt: due } }),
    BackupJob.exists({ status: 'running' }),
    // After a failure, wait an hour before trying again (failures are visible in the panel).
    BackupJob.exists({
      status: 'failed',
      trigger: 'schedule',
      startedAt: { $gt: new Date(now.getTime() - 3_600_000) },
    }),
  ]);
  if (recent || running || recentFailure) return;
  await startBackup('schedule').catch((err) => logger.error({ err }, 'Scheduled backup could not start'));
}

export function startBackupScheduler() {
  if (scheduleTimer || !env.BACKUP_SCHEDULE_ENABLED || !backupsConfigured()) return;
  scheduleTimer = setInterval(
    () => void scheduledBackupTick().catch((err) => logger.error({ err }, 'Backup schedule tick failed')),
    10 * 60_000,
  );
  scheduleTimer.unref();
  setTimeout(() => void scheduledBackupTick().catch(() => undefined), 60_000).unref();
}

export function stopBackupScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = undefined;
}
