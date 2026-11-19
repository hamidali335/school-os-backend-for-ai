import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env';
import { Section } from '../src/modules/academics/academics.models';
import { IMPORT_LANES } from '../src/modules/imports/import-lanes';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { School } from '../src/modules/schools/school.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Import benchmark (not part of the normal run: set IMPORT_BENCHMARK=1).
 *
 * Imports a representative students file into this file's private test database with a
 * simulated network latency added to every database operation, then checks the result:
 * every student once, one parent record and one login per phone number, siblings linked to the
 * same parent. Scenarios: IMPORT_BENCHMARK_SCENARIOS="latencyMs:rows,..." (default "2:5000,140:5000").
 *
 * Latency: Windows timers fire up to ~15 ms late, so the delay sleeps short and then waits
 * precisely; the latency actually applied is measured and reported.
 */
const enabled = process.env.IMPORT_BENCHMARK === '1';
const t = useTestApp();
let s: SchoolFixture;
const SCENARIOS = (process.env.IMPORT_BENCHMARK_SCENARIOS ?? '2:5000,140:5000').split(',').map((x) => {
  const [latency, rows] = x.split(':').map(Number);
  return { latency, rows };
});

beforeAll(async () => {
  if (!enabled) return;
  s = await buildSchool(t.app, { students: 1 });
  const plan = await Plan.create({
    code: `bench-${Date.now()}`,
    name: 'Bench',
    priceMonthlyPkr: 0,
    limits: { maxStudents: 100_000 },
  });
  await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
  const sessionId = s.sessionId;
  for (let level = 1; level <= 10; level++) {
    if (level === 5) continue; // Class 5 comes with the fixture
    const cls = await api(t.app, s.ownerToken, 'post', '/academics/classes', {
      campusId: s.campusId,
      name: `Class ${level}`,
      level,
    });
    for (const name of ['A', 'B', 'C', 'D'])
      await api(t.app, s.ownerToken, 'post', '/academics/sections', { classId: cls._id, sessionId, name });
  }
  for (const name of ['C', 'D'])
    await api(t.app, s.ownerToken, 'post', '/academics/sections', { classId: s.classId, sessionId, name });
  // As in the school's own file: sections without a capacity.
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: null } });
}, 600_000);

/**
 * A school's file: ~30% of students have a brother or sister in the file (same father phone),
 * a third have no admission number (numbered by the school), a third list the mother with her
 * own phone, a fifth of families give an email, and 2% have left.
 */
function csv(prefix: string, n: number, phoneBase: number) {
  const families = Math.ceil(n * 0.7);
  const lines = [
    'Admission No,Student Name *,Gender *,Class *,Section *,Parent Name,Parent Phone,Parent Email,Mother Name,Mother Phone,Status',
  ];
  for (let i = 0; i < n; i++) {
    const f = (i * 7919) % families; // siblings spread through the file, not next to each other
    const phone = `03${String(phoneBase + f).padStart(9, '0')}`;
    const mother = f % 3 === 0 ? `Mother${prefix}${f},03${String(phoneBase + 500_000 + f).padStart(9, '0')}` : ',';
    lines.push(
      [
        i % 3 === 0 ? '' : `${prefix}-${i}`,
        `Kid${prefix} ${i}`,
        i % 2 ? 'Male' : 'Female',
        `Class ${1 + (i % 10)}`,
        'ABCD'[i % 4],
        `Father${prefix} ${f}`,
        phone,
        f % 5 === 0 ? `family${prefix.toLowerCase()}${f}@example.test` : '',
        mother,
        i % 50 === 0 ? 'Left' : 'Active',
      ].join(','),
    );
  }
  return { body: `${lines.join('\n')}\n`, families };
}

/** Delay every database operation by `ms`; returns the latency actually applied (mean, ms). */
function simulateLatency(ms: number) {
  const C = mongoose.mongo.Collection.prototype as any;
  const methods = [
    'findOne',
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'countDocuments',
    'bulkWrite',
    'deleteOne',
    'deleteMany',
    'aggregate',
    'find',
  ];
  const S = mongoose.mongo.ClientSession.prototype as any;
  const originals: Array<[any, string, any]> = [];
  let applied = 0;
  let ops = 0;
  // findOne and countDocuments are built on find and aggregate: delay the outer call only.
  let internal = 0;
  const wait = async () => {
    const until = performance.now() + ms;
    if (ms > 20) await new Promise((r) => setTimeout(r, ms - 17));
    while (performance.now() < until) await new Promise((r) => setImmediate(r));
    applied += performance.now() - (until - ms);
    ops++;
  };
  for (const m of methods) {
    const orig = C[m];
    originals.push([C, m, orig]);
    if (m === 'find' || m === 'aggregate') {
      // Cursors: delay the first batch (one round trip); later batches are rare here.
      C[m] = function (...a: any[]) {
        const cursor = orig.apply(this, a);
        if (internal) return cursor;
        let delayed = false;
        const once = async () => {
          if (delayed) return;
          delayed = true;
          await wait();
        };
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => {
          await once();
          return toArray();
        };
        const next = cursor.next.bind(cursor);
        cursor.next = async () => {
          await once();
          return next();
        };
        return cursor;
      };
    } else
      C[m] = async function (...a: any[]) {
        await wait();
        internal++;
        try {
          return orig.apply(this, a); // the inner find/aggregate is created synchronously here
        } finally {
          internal--;
        }
      };
  }
  for (const m of ['commitTransaction', 'abortTransaction']) {
    const orig = S[m];
    originals.push([S, m, orig]);
    S[m] = async function (...a: any[]) {
      await wait();
      return orig.apply(this, a);
    };
  }
  return {
    restore: () => originals.forEach(([o, m, f]) => (o[m] = f)),
    stats: () => ({ ops, meanAppliedMs: ops ? +(applied / ops).toFixed(1) : 0 }),
  };
}

describe.skipIf(!enabled)('Import benchmark', () => {
  for (const [k, sc] of SCENARIOS.entries()) {
    it(
      `${sc.rows} rows at ${sc.latency} ms database latency`,
      async () => {
        const prefix = `B${k}${sc.latency}`;
        const file = csv(prefix, sc.rows, 100_000_000 + k * 1_000_000);
        const up = await request(t.app)
          .post('/api/v1/imports')
          .set(auth(s.ownerToken))
          .field('type', 'students')
          .attach('file', Buffer.from(file.body), 'bench.csv');
        expect(up.status).toBe(201);
        const id = up.body.data.job._id as string;
        await waitStaged(t.app, s.ownerToken, id, 600_000);
        const chk = await checkAndWait(t.app, s.ownerToken, id, {
          mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
        });
        expect(chk.summary.invalid).toBe(0);

        // Production password cost for the parent logins (tests otherwise use 4 rounds), and the lanes.
        const rounds = env.BCRYPT_ROUNDS;
        const lanes = IMPORT_LANES.DEFAULT;
        env.BCRYPT_ROUNDS = Number(process.env.IMPORT_BENCHMARK_BCRYPT_ROUNDS ?? rounds);
        IMPORT_LANES.DEFAULT = Number(process.env.IMPORT_BENCHMARK_LANES ?? lanes);
        const latency = simulateLatency(sc.latency);
        const t0 = performance.now();
        let job: any;
        try {
          const run = await request(t.app)
            .post(`/api/v1/imports/${id}/run`)
            .set(auth(s.ownerToken))
            .send({ confirm: true });
          expect(run.status).toBe(202);
          for (;;) {
            job = await ImportJob.findOne({ schoolId: s.schoolId, _id: id }).lean();
            if (job && job.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 1000));
          }
        } finally {
          latency.restore();
          env.BCRYPT_ROUNDS = rounds;
          IMPORT_LANES.DEFAULT = lanes;
        }
        const ms = performance.now() - t0;

        // The result, read without latency.
        const students = await Student.find({ schoolId: s.schoolId, firstName: `Kid${prefix}` })
          .select('guardians admissionNo status')
          .lean();
        const parents = await Parent.find({ schoolId: s.schoolId, name: { $regex: `^(Father|Mother)${prefix}` } })
          .select('phone')
          .lean();
        const phones = new Set(parents.map((p) => p.phone));
        const logins = await User.countDocuments({
          schoolId: s.schoolId,
          parentId: { $in: parents.map((p) => p._id) },
        });
        const failedRows = await ImportRow.find({ schoolId: s.schoolId, jobId: id, result: { $ne: 'created' } })
          .select('rowNo result resultMessage')
          .limit(5)
          .lean();
        const report = {
          rows: sc.rows,
          simulatedLatencyMs: sc.latency,
          bcryptRounds: Number(process.env.IMPORT_BENCHMARK_BCRYPT_ROUNDS ?? rounds),
          lanes: Number(process.env.IMPORT_BENCHMARK_LANES ?? lanes),
          ...latency.stats(),
          status: job.status,
          result: job.result,
          minutes: +(ms / 60_000).toFixed(2),
          msPerRow: +(ms / sc.rows).toFixed(1),
          students: students.length,
          parents: parents.length,
          distinctParentPhones: phones.size,
          parentLogins: logins,
          firstProblems: failedRows,
        };
        console.log(`IMPORT_BENCHMARK ${JSON.stringify(report)}`);
        expect(job.status).toBe('completed');
        expect(students.length).toBe(sc.rows);
        expect(new Set(students.map((x) => x.admissionNo)).size).toBe(sc.rows);
        expect(parents.length).toBe(phones.size); // one parent record per phone number
        expect(logins).toBe(parents.length); // one login per parent
        const mothers = Math.ceil(file.families / 3);
        expect(parents.length).toBe(file.families + mothers);
      },
      4 * 3600_000,
    );
  }
});
