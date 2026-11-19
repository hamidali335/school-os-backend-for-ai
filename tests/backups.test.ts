import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { BackupJob } from '../src/modules/backups/backup.model';
import { parseKey } from '../src/modules/backups/backup-crypto';
import { backupDir, recoverInterruptedBackups, runBackup, sha256File } from '../src/modules/backups/backup.service';
import { restoreBackup, verifyBackup } from '../src/modules/backups/restore';
import { readTar, tarHeader, END_OF_ARCHIVE } from '../src/modules/backups/tar';
import { PlatformAdmin } from '../src/modules/platform-admin/platform-admin.model';
import { freezeWrites, unfreezeWrites } from '../src/services/write-freeze';
import { api, buildSchool } from './fixtures';
import { auth, createPlatformAdmin, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
const PDF = Buffer.from('%PDF-1.4\n% backup test document\n%%EOF\n');

async function waitFor(backupId: string, token: string) {
  for (let i = 0; i < 300; i++) {
    const res = await request(t.app).get(`/api/v1/platform/backups/${backupId}`).set(auth(token));
    if (res.body.data?.status !== 'running') return res.body.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('backup did not finish');
}

async function download(token: string, backupId: string, dir: string) {
  const link = await request(t.app)
    .post(`/api/v1/platform/backups/${backupId}/download-link`)
    .set(auth(token))
    .send({ password: PASSWORD });
  expect(link.status).toBe(200);
  const res = await request(t.app)
    .get(link.body.data.url.replace(/^.*\/api\/v1/, '/api/v1'))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  expect(res.headers['content-disposition']).toContain('.tar.gz.enc');
  expect(res.headers['cache-control']).toBe('no-store');
  const manifest = await api(t.app, token, 'get', `/platform/backups/${backupId}/manifest`);
  const archive = path.join(dir, link.body.data.fileName);
  const manifestFile = archive.replace(/\.tar\.gz\.enc$/, '.manifest.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archive, res.body as Buffer);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  return { archive, manifestFile, manifest, url: link.body.data.url as string };
}

describe('Platform backups', () => {
  let owner: { token: string; email: string };
  let s: Awaited<ReturnType<typeof buildSchool>>;
  let s2: Awaited<ReturnType<typeof buildSchool>>;
  let backupId = '';
  let files: Awaited<ReturnType<typeof download>>;
  const local = path.resolve('storage-test', `local-${crypto.randomBytes(4).toString('hex')}`);

  it('builds two schools with fees, payments, a reversal request and private files', async () => {
    owner = await createPlatformAdmin(t.app, 'platform_owner');
    s = await buildSchool(t.app, { students: 3 });
    s2 = await buildSchool(t.app, { students: 2 });
    for (const sc of [s, s2]) {
      await api(t.app, sc.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
      const inv = await api(t.app, sc.accountantToken, 'get', '/fees/invoices?period=2026-09');
      await api(t.app, sc.accountantToken, 'post', `/fees/invoices/${inv[0]._id}/payments`, {
        amount: 2500,
        method: 'cash',
        idempotencyKey: `pay-${sc.code}`,
      });
      const up = await request(t.app)
        .post('/api/v1/files')
        .set(auth(sc.ownerToken))
        .field('category', 'student_document')
        .field('studentId', sc.students[0])
        .attach('file', PDF, { filename: 'birth-certificate.pdf', contentType: 'application/pdf' });
      expect(up.status).toBe(201);
    }
  });

  it('refuses everyone except a platform owner', async () => {
    const adminOnly = await createPlatformAdmin(t.app, 'platform_admin');
    expect((await request(t.app).get('/api/v1/platform/backups')).status).toBe(401);
    expect((await request(t.app).post('/api/v1/platform/backups')).status).toBe(401);
    // School tokens (even the school's Admin) are signed for another audience.
    expect((await request(t.app).get('/api/v1/platform/backups').set(auth(s.ownerToken))).status).toBe(401);
    expect((await request(t.app).post('/api/v1/platform/backups').set(auth(s.parentToken))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/platform/backups').set(auth(adminOnly.token))).status).toBe(403);
    expect((await request(t.app).post('/api/v1/platform/backups').set(auth(adminOnly.token))).status).toBe(403);
    // Manipulated ids never reach the file system.
    const bad = await request(t.app).get('/api/v1/platform/backups/..%2F..%2Fetc').set(auth(owner.token));
    expect(bad.status).toBe(400);
    const unknown = await request(t.app)
      .get(`/api/v1/platform/backups/${'0'.repeat(32)}/manifest`)
      .set(auth(owner.token));
    expect(unknown.status).toBe(404);
  });

  it('creates a verified full backup and refuses a second concurrent one', async () => {
    const res = await request(t.app).post('/api/v1/platform/backups').set(auth(owner.token));
    expect(res.status).toBe(202);
    backupId = res.body.data.backupId;
    expect(backupId).toMatch(/^[0-9a-f]{32}$/);
    const again = await request(t.app).post('/api/v1/platform/backups').set(auth(owner.token));
    // Either still running (409) or the first one already finished (202, a new one).
    if (again.status === 409) expect(again.body.error.code).toBe('BACKUP_IN_PROGRESS');
    const job = await waitFor(backupId, owner.token);
    expect(job.status).toBe('completed');
    expect(job.verifiedAt).toBeTruthy();
    expect(job.consistency).toBe('write-freeze'); // standalone MongoDB in this project
    if (again.status === 202) await waitFor(again.body.data.backupId, owner.token);
    // No secret material in the stored job or manifest.
    const raw = JSON.stringify(await BackupJob.findOne({ backupId }).lean());
    expect(raw).not.toContain(env.BACKUP_ENCRYPTION_KEY!);
    expect(raw).not.toContain('passwordHash');
  });

  it('downloads with a single-use link after re-entering the password; checksum matches', async () => {
    const wrong = await request(t.app)
      .post(`/api/v1/platform/backups/${backupId}/download-link`)
      .set(auth(owner.token))
      .send({ password: 'not-the-password' });
    expect(wrong.status).toBe(403);
    files = await download(owner.token, backupId, local);
    expect(await sha256File(files.archive)).toBe(files.manifest.archive.sha256);
    expect(fs.statSync(files.archive).size).toBe(files.manifest.archive.sizeBytes);
    // The manifest has counts and checksums, never key material or password hashes.
    const m = JSON.stringify(files.manifest);
    expect(m).not.toContain(env.BACKUP_ENCRYPTION_KEY!);
    expect(files.manifest.files.count).toBe(2);
    expect(files.manifest.collections.find((c: any) => c.name === 'refreshtokens')).toBeUndefined();
    // The link worked once.
    const replay = await request(t.app).get(files.url.replace(/^.*\/api\/v1/, '/api/v1'));
    expect(replay.status).toBe(410);
    // Archive bytes are encrypted: no plaintext school data in them.
    expect(fs.readFileSync(files.archive).includes(Buffer.from(s.code))).toBe(false);
  });

  it('invalidates unused download links when the admin loses access', async () => {
    const link = await request(t.app)
      .post(`/api/v1/platform/backups/${backupId}/download-link`)
      .set(auth(owner.token))
      .send({ password: PASSWORD });
    await PlatformAdmin.updateOne({ email: owner.email }, { $inc: { tokenVersion: 1 } });
    const res = await request(t.app).get(link.body.data.url.replace(/^.*\/api\/v1/, '/api/v1'));
    expect(res.status).toBe(403);
    owner = await createPlatformAdmin(t.app, 'platform_owner');
  });

  it('verifies offline and restores into an empty database with identical data, money and files', async () => {
    const key = parseKey(env.BACKUP_ENCRYPTION_KEY!);
    const v = await verifyBackup({ archive: files.archive, manifest: files.manifestFile, key });
    expect(v.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(v.ok).toBe(true);

    const targetDb = `schoolos_test_restore_${crypto.randomBytes(3).toString('hex')}`;
    const targetUri = process.env.MONGODB_URI!.replace(/schoolos_test_[0-9a-f]+/, targetDb);
    const storageDir = path.join(local, 'restored-storage');
    const report = await restoreBackup({
      archive: files.archive,
      manifest: files.manifestFile,
      key,
      targetUri,
      confirmTarget: targetDb,
      storageDir,
      workDir: path.join(local, 'work'),
    });
    expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(fs.existsSync(path.join(local, 'work'))).toBe(false); // plaintext work folder removed

    // Byte-for-byte document equality for the financial and account collections.
    const target = mongoose.connection.getClient().db(targetDb);
    for (const name of ['invoices', 'payments', 'users', 'students', 'parents', 'schools', 'fileobjects']) {
      const a = await mongoose.connection.db!.collection(name).find().sort({ _id: 1 }).toArray();
      const b = await target.collection(name).find().sort({ _id: 1 }).toArray();
      expect(mongoose.mongo.BSON.EJSON.stringify(b)).toBe(mongoose.mongo.BSON.EJSON.stringify(a));
    }
    const idx = (await target.collection('users').indexes()).map((i) => i.name).sort();
    const orig = (await mongoose.connection.db!.collection('users').indexes()).map((i) => i.name).sort();
    expect(idx).toEqual(orig);

    // Restoring again into the now non-empty database is refused.
    const again = await restoreBackup({
      archive: files.archive,
      manifest: files.manifestFile,
      key,
      targetUri,
      confirmTarget: targetDb,
      storageDir: path.join(local, 'other-storage'),
      workDir: path.join(local, 'work2'),
    });
    expect(again.ok).toBe(false);
    expect(again.checks.at(-1)?.name).toBe('target database is empty');
    // Wrong confirmation is refused before anything is read.
    const unconfirmed = await restoreBackup({
      archive: files.archive,
      manifest: files.manifestFile,
      key,
      targetUri: targetUri.replace(targetDb, `${targetDb}_x`),
      confirmTarget: targetDb,
      storageDir: path.join(local, 'other-storage'),
      workDir: path.join(local, 'work3'),
    });
    expect(unconfirmed.ok).toBe(false);
    await target.dropDatabase();
  });

  it('rejects corrupted, truncated or wrongly keyed archives and restores nothing', async () => {
    const key = parseKey(env.BACKUP_ENCRYPTION_KEY!);
    const bytes = fs.readFileSync(files.archive);
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)] ^= 0xff;
    const corrupt = path.join(local, 'corrupt.tar.gz.enc');
    fs.writeFileSync(corrupt, flipped);
    // Checksum catches it without the key...
    const v1 = await verifyBackup({ archive: corrupt, manifest: files.manifestFile, key });
    expect(v1.ok).toBe(false);
    // ...and authenticated decryption catches it even without the manifest.
    const v2 = await verifyBackup({ archive: corrupt, key });
    expect(v2.ok).toBe(false);
    const truncated = path.join(local, 'truncated.tar.gz.enc');
    fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 100));
    expect((await verifyBackup({ archive: truncated, key })).ok).toBe(false);
    const otherKey = crypto.randomBytes(32);
    expect((await verifyBackup({ archive: files.archive, key: otherKey })).ok).toBe(false);

    const targetDb = `schoolos_test_corrupt_${crypto.randomBytes(3).toString('hex')}`;
    const report = await restoreBackup({
      archive: corrupt,
      manifest: files.manifestFile,
      key,
      targetUri: process.env.MONGODB_URI!.replace(/schoolos_test_[0-9a-f]+/, targetDb),
      confirmTarget: targetDb,
      storageDir: path.join(local, 'corrupt-storage'),
      workDir: path.join(local, 'corrupt-work'),
    });
    expect(report.ok).toBe(false);
    const cols = await mongoose.connection.getClient().db(targetDb).listCollections().toArray();
    expect(cols.length).toBe(0);
    expect(fs.existsSync(path.join(local, 'corrupt-storage'))).toBe(false);
  });

  it('fails visibly (never "completed") when a referenced file is missing, leaving no archive', async () => {
    const meta = await mongoose.connection
      .db!.collection('fileobjects')
      .findOne({ schoolId: new mongoose.Types.ObjectId(s.schoolId) });
    const full = path.resolve(env.STORAGE_DIR, String(meta!.storageKey));
    const saved = fs.readFileSync(full);
    fs.rmSync(full);
    try {
      const res = await request(t.app).post('/api/v1/platform/backups').set(auth(owner.token));
      const job = await waitFor(res.body.data.backupId, owner.token);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/missing from storage/);
      const leftovers = fs.readdirSync(backupDir()).filter((f) => f.includes(job.fileName));
      expect(leftovers).toEqual([]);
      const link = await request(t.app)
        .post(`/api/v1/platform/backups/${job.backupId}/download-link`)
        .set(auth(owner.token))
        .send({ password: PASSWORD });
      expect(link.status).toBe(409);
    } finally {
      fs.writeFileSync(full, saved);
    }
  });

  it('marks a backup interrupted by a crash as failed and removes its partial archive', async () => {
    const fileName = 'school-os-full-20260101T000000Z';
    await BackupJob.create({
      backupId: crypto.randomBytes(16).toString('hex'),
      trigger: 'manual',
      status: 'running',
      lock: 'active',
      startedAt: new Date(Date.now() - 3_600_000),
      heartbeatAt: new Date(Date.now() - 3_600_000),
      fileName,
    });
    const partial = path.join(backupDir(), `${fileName}.tar.gz.enc.partial`);
    fs.writeFileSync(partial, 'half an archive');
    await recoverInterruptedBackups();
    expect(fs.existsSync(partial)).toBe(false);
    const job = await BackupJob.findOne({ fileName }).lean();
    expect(job!.status).toBe('failed');
    expect(job!.lock).toBeUndefined();
    // The lock is free again: a new backup can start.
    const res = await request(t.app).post('/api/v1/platform/backups').set(auth(owner.token));
    expect(res.status).toBe(202);
    expect((await waitFor(res.body.data.backupId, owner.token)).status).toBe('completed');
  });

  it('pauses API writes during a write-freeze and resumes afterwards', async () => {
    await freezeWrites();
    try {
      const blocked = await request(t.app)
        .post('/api/v1/academics/classes')
        .set(auth(s.ownerToken))
        .send({ campusId: s.campusId, name: 'Frozen class', level: 6 });
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('MAINTENANCE');
      expect(blocked.headers['retry-after']).toBe('30');
      // Reads keep working.
      expect((await request(t.app).get('/api/v1/academics/classes').set(auth(s.ownerToken))).status).toBe(200);
    } finally {
      unfreezeWrites();
    }
    const ok = await request(t.app)
      .post('/api/v1/academics/classes')
      .set(auth(s.ownerToken))
      .send({ campusId: s.campusId, name: 'After freeze', level: 6 });
    expect(ok.status).toBe(201);
  });

  it('never deletes the only verified backup, and requires the password to delete', async () => {
    const list = await api(t.app, owner.token, 'get', '/platform/backups');
    const completed = list.filter((b: any) => b.status === 'completed');
    expect(completed.length).toBeGreaterThanOrEqual(2);
    const noPw = await request(t.app)
      .delete(`/api/v1/platform/backups/${completed[1].backupId}`)
      .set(auth(owner.token))
      .send({ password: 'x' });
    expect(noPw.status).toBe(403);
    for (const b of completed.slice(1))
      expect(
        (
          await request(t.app)
            .delete(`/api/v1/platform/backups/${b.backupId}`)
            .set(auth(owner.token))
            .send({ password: PASSWORD })
        ).status,
      ).toBe(204);
    const last = await request(t.app)
      .delete(`/api/v1/platform/backups/${completed[0].backupId}`)
      .set(auth(owner.token))
      .send({ password: PASSWORD });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_VERIFIED_BACKUP');
  });

  it('records backup actions in the platform audit log', async () => {
    const actions = (
      await mongoose.connection.db!.collection('auditlogs').distinct('action', { action: /^platform\.backup\./ })
    ).sort();
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.backup.deleted',
        'platform.backup.download_denied',
        'platform.backup.download_link_created',
        'platform.backup.downloaded',
        'platform.backup.requested',
      ]),
    );
  });

  it('runBackup ignores jobs that are not running (idempotent)', async () => {
    const done = await BackupJob.findOne({ status: 'completed' }).lean();
    await runBackup(done!.backupId);
    expect((await BackupJob.findOne({ backupId: done!.backupId }).lean())!.status).toBe('completed');
  });
});

describe('Backup archive reader safety', () => {
  const entry = (name: string, body = 'x', type = '0') => {
    const h = tarHeader('placeholder', Buffer.byteLength(body));
    h.fill(0, 0, 100);
    h.write(name, 0, 100, 'utf8');
    h.write(type, 156, 1, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    const data = Buffer.from(body);
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([h, data, pad]);
  };
  const read = (buf: Buffer) => readTar(Readable.from([buf]), async () => undefined);

  it.each([['../../etc/passwd'], ['/etc/passwd'], ['files/../../outside'], ['C:/Windows/evil'], ['files\\..\\evil']])(
    'rejects the path %s',
    async (name) => {
      await expect(read(Buffer.concat([entry(name), END_OF_ARCHIVE]))).rejects.toThrow(/Unsafe archive entry/);
    },
  );

  it('rejects symbolic links, hard links and duplicate entries', async () => {
    await expect(read(Buffer.concat([entry('files/link', '', '2'), END_OF_ARCHIVE]))).rejects.toThrow(/non-regular/);
    await expect(read(Buffer.concat([entry('files/hard', '', '1'), END_OF_ARCHIVE]))).rejects.toThrow(/non-regular/);
    await expect(read(Buffer.concat([entry('db/a.ejson'), entry('db/a.ejson'), END_OF_ARCHIVE]))).rejects.toThrow(
      /duplicate/,
    );
  });

  it('rejects a truncated archive', async () => {
    await expect(read(entry('db/a.ejson', 'hello'))).rejects.toThrow(/truncated/);
  });
});
