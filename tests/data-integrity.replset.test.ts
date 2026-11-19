import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { mongoTopology, transactionsSupported } from '../src/database/transactions';
import { parseKey } from '../src/modules/backups/backup-crypto';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { School } from '../src/modules/schools/school.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { ApprovalRequest } from '../src/modules/approvals/approval.model';
import { restoreBackup } from '../src/modules/backups/restore';
import { crashAtCheckpoint } from './fault/crash';
import { api, buildSchool } from './fixtures';
import { auth, createPlatformAdmin, PASSWORD, useTestApp } from './helpers';

/**
 * Runs on a single-node replica set (the minimum production topology). Each crash test kills a
 * separate process half-way through a real workflow and then inspects the database.
 */
const t = useTestApp();

async function ownerUserId(schoolId: string) {
  const u = await User.findOne({ schoolId, role: 'school_owner' }).select('_id').lean();
  return u!._id.toString();
}

describe('Data integrity on a replica set', () => {
  let s: Awaited<ReturnType<typeof buildSchool>>;
  let invoiceId = '';

  it('detects the replica set and enables transactions', async () => {
    expect(mongoTopology()).toBe('replicaSet');
    expect(transactionsSupported()).toBe(true);
    s = await buildSchool(t.app, { students: 3 });
    await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    const inv = await api(t.app, s.accountantToken, 'get', '/fees/invoices?period=2026-09');
    invoiceId = inv[0]._id;
  });

  it('payment: a crash after the balance update leaves neither the balance change nor a payment; the retry records it once', async () => {
    const before = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    await crashAtCheckpoint('payment', {
      schoolId: s.schoolId,
      userId: await ownerUserId(s.schoolId),
      invoiceId,
      amount: 1500,
      idempotencyKey: 'crash-retry-1',
    });
    const after = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    expect(after!.balance).toBe(before!.balance);
    expect(after!.paid).toBe(before!.paid);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId })).toBe(0);

    // The client retries with the same idempotency key (it never got an answer). The killed
    // process's open transaction holds the invoice until the server aborts it, so this can wait.
    const retry = await request(t.app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1500, method: 'cash', idempotencyKey: 'crash-retry-1' });
    expect(retry.status).toBe(201);
    const replay = await request(t.app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1500, method: 'cash', idempotencyKey: 'crash-retry-1' });
    expect(replay.status).toBe(201);
    expect(replay.body.data.replayed).toBe(true);
    const final = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    expect(final!.balance).toBe(before!.balance - 1500);
    const payments = await Payment.find({ schoolId: s.schoolId, invoiceId }).lean();
    expect(payments).toHaveLength(1);
    expect(payments[0].receiptNo).toBeTruthy();
  }, 120_000);

  it('payment: an error between writes rolls everything back (no compensation needed)', async () => {
    const before = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    const spy = vi.spyOn(Payment, 'create').mockRejectedValueOnce(new Error('simulated write failure'));
    const res = await request(t.app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 100, method: 'cash' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error.message).not.toContain('simulated'); // no internals leaked
    const after = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    expect(after!.balance).toBe(before!.balance);
    expect(after!.paid).toBe(before!.paid);
  });

  it('payment: concurrent payments never over-settle and always match the invoice', async () => {
    const inv = await Invoice.findOne({ schoolId: s.schoolId, _id: { $ne: invoiceId } }).lean();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(t.app)
          .post(`/api/v1/fees/invoices/${inv!._id}/payments`)
          .set(auth(s.accountantToken))
          .send({ amount: Math.ceil(inv!.balance / 3), method: 'cash', idempotencyKey: `concurrent-payment-${i}` }),
      ),
    );
    const ok = results.filter((r) => r.status === 201).length;
    if (!ok) throw new Error(JSON.stringify(results.map((r) => [r.status, r.body.error?.code, r.body.error?.debug])));
    expect(ok).toBeGreaterThan(0);
    for (const r of results) expect([201, 409, 422]).toContain(r.status);
    const final = await Invoice.findOne({ schoolId: s.schoolId, _id: inv!._id }).lean();
    const paid = (await Payment.find({ schoolId: s.schoolId, invoiceId: inv!._id }).lean()).reduce(
      (a, p) => a + p.amount,
      0,
    );
    expect(final!.paid).toBe(paid);
    expect(final!.balance).toBeGreaterThanOrEqual(0);
    expect(final!.paid + final!.balance + final!.waiver).toBe(inv!.total + inv!.waiver);
  }, 60_000);

  it('reversal approval: a crash after marking the payment reversed changes nothing; approving again works', async () => {
    const pay = await Payment.findOne({ schoolId: s.schoolId, invoiceId, status: 'valid' }).lean();
    const req = await api(t.app, s.accountantToken, 'post', `/fees/payments/${pay!._id}/reversal-requests`, {
      reason: 'Entered against the wrong student',
    });
    const before = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    await crashAtCheckpoint('reversal', {
      schoolId: s.schoolId,
      userId: await ownerUserId(s.schoolId),
      approvalId: req._id,
    });
    expect((await Payment.findOne({ schoolId: s.schoolId, _id: pay!._id }).lean())!.status).toBe('valid');
    expect((await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean())!.balance).toBe(before!.balance);
    expect((await ApprovalRequest.findOne({ schoolId: s.schoolId, _id: req._id }).lean())!.status).toBe('pending');

    const decided = await api(t.app, s.ownerToken, 'post', `/approvals/${req._id}/decision`, { decision: 'approve' });
    expect(decided.status).toBe('executed');
    expect((await Payment.findOne({ schoolId: s.schoolId, _id: pay!._id }).lean())!.status).toBe('reversed');
    expect((await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean())!.balance).toBe(
      before!.balance + pay!.amount,
    );
  }, 120_000);

  it('onboarding: a crash before the Admin account exists leaves no half-created school', async () => {
    const code = `CR${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await crashAtCheckpoint('onboarding', { code, email: `crash.${code.toLowerCase()}@example.test` });
    expect(await School.countDocuments({ code })).toBe(0);
  }, 120_000);

  it('admission: a crash before the parent login exists leaves no student or parent behind', async () => {
    const phone = '+923005559876';
    await crashAtCheckpoint('admission', {
      schoolId: s.schoolId,
      userId: await ownerUserId(s.schoolId),
      student: {
        campusId: s.campusId,
        firstName: 'Crash',
        lastName: 'Admission',
        gender: 'female',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionA,
        guardians: [{ parent: { name: 'Crash Parent', phone }, isPrimary: true }],
      },
    });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Crash' })).toBe(0);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone })).toBe(0);
    // The same admission succeeds afterwards (no duplicate admission number / parent conflict).
    const res = await request(t.app)
      .post('/api/v1/students')
      .set(auth(s.ownerToken))
      .send({
        campusId: s.campusId,
        firstName: 'Crash',
        lastName: 'Admission',
        gender: 'female',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionA,
        guardians: [{ parent: { name: 'Crash Parent', phone }, isPrimary: true }],
      });
    expect(res.status).toBe(201);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone })).toBe(1);
  }, 120_000);

  it('takes a snapshot-consistent backup without pausing writes, and it restores exactly', async () => {
    const owner = await createPlatformAdmin(t.app, 'platform_owner');
    const res = await request(t.app).post('/api/v1/platform/backups').set(auth(owner.token));
    expect(res.status).toBe(202);
    // Writes keep working while the backup runs (no write freeze on a replica set).
    const during = await request(t.app)
      .post('/api/v1/academics/classes')
      .set(auth(s.ownerToken))
      .send({ campusId: s.campusId, name: 'Written during backup', level: 7 });
    expect(during.status).toBe(201);
    let job: any;
    for (let i = 0; i < 300; i++) {
      job = (await request(t.app).get(`/api/v1/platform/backups/${res.body.data.backupId}`).set(auth(owner.token))).body
        .data;
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.status).toBe('completed');
    expect(job.consistency).toBe('snapshot');
    expect(job.manifest.database.snapshotClusterTime).toBeTruthy();

    const link = await request(t.app)
      .post(`/api/v1/platform/backups/${job.backupId}/download-link`)
      .set(auth(owner.token))
      .send({ password: PASSWORD });
    const dl = await request(t.app)
      .get(link.body.data.url.replace(/^.*\/api\/v1/, '/api/v1'))
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (x: Buffer) => c.push(x));
        r.on('end', () => cb(null, Buffer.concat(c)));
      });
    const dir = path.resolve('storage-test', `rs-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, link.body.data.fileName);
    fs.writeFileSync(archive, dl.body as Buffer);
    const manifestFile = path.join(dir, 'manifest.json');
    fs.writeFileSync(
      manifestFile,
      JSON.stringify(await api(t.app, owner.token, 'get', `/platform/backups/${job.backupId}/manifest`)),
    );
    const targetDb = `schoolos_test_rsrestore_${crypto.randomBytes(3).toString('hex')}`;
    const report = await restoreBackup({
      archive,
      manifest: manifestFile,
      key: parseKey(env.BACKUP_ENCRYPTION_KEY!),
      targetUri: process.env.MONGODB_URI!.replace(/schoolos_test_[0-9a-f]+/, targetDb),
      confirmTarget: targetDb,
      storageDir: path.join(dir, 'storage'),
      workDir: path.join(dir, 'work'),
    });
    expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(report.ok).toBe(true);
    await mongoose.connection.getClient().db(targetDb).dropDatabase();
  }, 120_000);
});
