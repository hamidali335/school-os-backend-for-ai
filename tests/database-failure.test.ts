import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { connectDatabase } from '../src/database/connection';
import { isDatabaseUnavailable } from '../src/middleware/error-handler';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { api, buildSchool } from './fixtures';
import { auth } from './helpers';

/**
 * Database outages against a MongoDB process owned by this file, so it can be stopped and
 * restarted mid-test (the shared test server is never touched).
 */
const dbPath = path.resolve('storage-test', `dbfail-${crypto.randomBytes(3).toString('hex')}`);
fs.mkdirSync(dbPath, { recursive: true });
let mongod: MongoMemoryServer;
let app: ReturnType<typeof createApp>;
let lastWrite = '';

afterAll(async () => {
  await mongoose.disconnect().catch(() => undefined);
  await mongod?.stop({ doCleanup: true, force: true }).catch(() => undefined);
});

async function waitUntil(fn: () => Promise<boolean>, ms = 30_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn().catch(() => false)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not reached');
}

describe('Database failure and recovery', () => {
  let s: Awaited<ReturnType<typeof buildSchool>>;
  let invoiceId = '';

  it('starts against its own MongoDB and serves requests', async () => {
    mongod = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger' } });
    await connectDatabase(`${mongod.getUri()}schoolos_test_dbfail`);
    await mongoose.connection.syncIndexes();
    app = createApp();
    s = await buildSchool(app, { students: 2 });
    await api(app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    invoiceId = (await api(app, s.accountantToken, 'get', '/fees/invoices?period=2026-09'))[0]._id;
    expect((await request(app).get('/health/ready')).status).toBe(200);
  });

  it('acknowledged writes survive an abrupt MongoDB stop (journaled write concern)', async () => {
    // Written immediately before a hard stop: with w:1 and no journal acknowledgement this was
    // lost on restart (seen in the full suite). The connection now requires journaled writes.
    const res = await request(app)
      .post('/api/v1/academics/classes')
      .set(auth(s.ownerToken))
      .send({ campusId: s.campusId, name: 'Written just before the crash', level: 8 });
    expect(res.status).toBe(201);
    lastWrite = res.body.data._id;
  });

  it('during an outage: liveness stays 200, readiness 503, requests fail with a controlled 503 and no internals', async () => {
    await mongod.stop({ doCleanup: false, force: false });
    const live = await request(app).get('/health');
    expect(live.status).toBe(200); // a process manager must not restart-loop on a DB outage

    const readyMs = await waitUntil(async () => (await request(app).get('/health/ready')).status === 503);
    const ready = await request(app).get('/health/ready');
    expect(ready.body.data.status).toBe('not_ready');
    expect(readyMs).toBeLessThan(30_000);

    const started = Date.now();
    const res = await request(app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1000, method: 'cash', idempotencyKey: 'during-outage-1' });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('5');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/mongodb:\/\/|127\.0\.0\.1|ECONNREFUSED|stack|Mongo[A-Za-z]*Error/);
    expect(elapsed).toBeLessThan(15_000); // bounded by bufferTimeoutMS / serverSelectionTimeoutMS (10 s)
    console.log(`[evidence] readiness turned 503 after ${readyMs} ms; write during outage failed after ${elapsed} ms`);
  }, 60_000);

  it('recovers automatically when MongoDB returns; the failed payment left no trace and the retry applies once', async () => {
    await mongod.start(true);
    const ms = await waitUntil(async () => (await request(app).get('/health/ready')).status === 200, 60_000);
    console.log(`[evidence] readiness back to 200 ${ms} ms after MongoDB restarted`);
    expect(
      await mongoose.connection
        .db!.collection('classes')
        .countDocuments({ _id: new mongoose.Types.ObjectId(lastWrite) }),
    ).toBe(1);
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, _id: invoiceId })).toBe(1);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId })).toBe(0);
    const before = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    const retry = await request(app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(s.accountantToken))
      .send({ amount: 1000, method: 'cash', idempotencyKey: 'during-outage-1' });
    expect(retry.status).toBe(201);
    const after = await Invoice.findOne({ schoolId: s.schoolId, _id: invoiceId }).lean();
    expect(after!.balance).toBe(before!.balance - 1000);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId })).toBe(1);
    // Sessions issued before the outage still work (nothing was lost on restart).
    expect((await request(app).get('/api/v1/auth/me').set(auth(s.ownerToken))).status).toBe(200);
  }, 90_000);

  it('classifies driver connectivity errors as unavailable, and other errors not', () => {
    for (const name of [
      'MongoServerSelectionError',
      'MongoNetworkError',
      'MongoWaitQueueTimeoutError',
      'MongoPoolClearedError',
    ])
      expect(isDatabaseUnavailable(Object.assign(new Error('x'), { name }))).toBe(true);
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error('Operation `users.findOne()` buffering timed out after 10000ms'), {
          name: 'MongooseError',
        }),
      ),
    ).toBe(true);
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error('E11000 duplicate key'), { name: 'MongoServerError', code: 11000 }),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(new TypeError('bug'))).toBe(false);
  });

  it('the API refuses to start while MongoDB is unreachable and exits non-zero (for the process manager to retry)', async () => {
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/server.ts')], {
        cwd: path.resolve('storage-test'), // no .env here
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MONGODB_URI: 'mongodb://127.0.0.1:1/schoolos_test_unreachable',
          PORT: '0',
          LOG_LEVEL: 'silent',
        },
        stdio: 'ignore',
      });
      child.on('exit', (c) => resolve(c));
    });
    expect(code).toBe(1);
    console.log(`[evidence] startup with MongoDB down exited with code ${code} after ${Date.now() - started} ms`);
  }, 60_000);
});
