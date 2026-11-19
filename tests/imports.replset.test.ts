import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS } from '../src/config/permissions';
import { FEATURE_KEYS } from '../src/config/entitlements';
import { mongoTopology, transactionsSupported } from '../src/database/transactions';
import { Section } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { _processJobForTests } from '../src/modules/imports/imports.service';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import type { SchoolContext } from '../src/types/context';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * The import on a single-node replica set (the production topology): every admission runs in a
 * transaction there. Checks the identity rules, concurrent loops and resume in that mode.
 */
const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: 200 } });
});

async function checked(csv: string, options: Record<string, unknown> = {}) {
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', 'students')
    .attach('file', Buffer.from(csv), 'f.csv');
  expect(up.status).toBe(201);
  const id = up.body.data.job._id as string;
  await waitStaged(t.app, s.ownerToken, id);
  const res = await checkAndWait(t.app, s.ownerToken, id, {
    mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    options,
  });
  return { id, summary: res.summary };
}

async function waitDone(id: string) {
  for (let i = 0; i < 400; i++) {
    const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('import did not finish');
}

describe('Imports on a replica set', () => {
  it('runs with transactions', () => {
    expect(mongoTopology()).toBe('replicaSet');
    expect(transactionsSupported()).toBe(true);
  });

  it('phone formats share one parent and one login; a re-import with other numbers is recognised', async () => {
    await api(t.app, s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      firstName: 'Repl',
      lastName: 'Existing',
      gender: 'male',
      dateOfBirth: '2014-04-04',
      guardians: [{ parent: { name: 'Repl Father', phone: '+923449990001' }, relation: 'father', isPrimary: true }],
    });
    const csv =
      'SID,Student Name,Gender,Class,Section,DOB,Father Name,Father Mobile\n' +
      'R-1,Repl Existing,Male,Class 5,A,2014-04-04,Repl Father,03449990001\n' +
      'R-2,Repl Sibling,Female,Class 5,B,2016-06-06,Repl Father,0344-9990001\n';
    const { id, summary } = await checked(csv);
    expect(summary).toMatchObject({ create: 1, duplicate: 1 });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    expect((await waitDone(id)).result).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    const parents = await Parent.find({ schoolId: s.schoolId, name: 'Repl Father' }).lean();
    expect(parents).toHaveLength(1);
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parents[0]._id })).toBe(1);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Repl', lastName: 'Existing' })).toBe(1);
    const sib = await Student.findOne({ schoolId: s.schoolId, firstName: 'Repl', lastName: 'Sibling' }).lean();
    expect(String(sib!.guardians[0].parentId)).toBe(String(parents[0]._id));
  });

  it('two loops on the same import never save a row twice', async () => {
    const csv =
      'Student Name,Gender,Class,Section\n' +
      Array.from({ length: 16 }, (_, i) => `Replloop Kid${i},Male,Class 5,${i % 2 ? 'A' : 'B'}`).join('\n') +
      '\n';
    const { id } = await checked(csv);
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id },
      { $set: { status: 'running', runnerId: 'same', heartbeatAt: new Date() } },
    );
    const owner = await User.findOne({ schoolId: s.schoolId, role: 'school_owner' }).lean();
    const ctx: SchoolContext = {
      kind: 'school',
      userId: String(owner!._id),
      schoolId: s.schoolId,
      role: 'school_owner',
      name: 'Owner',
      email: owner!.email ?? '',
      campusIds: [],
      permissions: ROLE_PERMISSIONS.school_owner,
      entitlements: new Set(FEATURE_KEYS),
      subscriptionEligible: true,
    };
    await Promise.all([_processJobForTests(ctx, id, 'same'), _processJobForTests(ctx, id, 'same')]);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Replloop' })).toBe(16);
    expect(
      await ImportRow.countDocuments({
        schoolId: s.schoolId,
        jobId: new mongoose.Types.ObjectId(id),
        result: 'created',
      }),
    ).toBe(16);
  });

  it('a stalled run resumes without duplicates', async () => {
    const { id } = await checked(
      'Student Name,Gender,Class,Section\nReplstall One,Male,Class 5,A\nReplstall Two,Male,Class 5,B\n',
    );
    const jobId = new mongoose.Types.ObjectId(id);
    await api(t.app, s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      admissionNo: 'REPL-STALL-1',
      firstName: 'Replstall',
      lastName: 'One',
      gender: 'male',
    });
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 2 },
      {
        $set: {
          result: 'processing',
          check: 'create',
          assignedKey: 'REPL-STALL-1',
          claimedBy: 'dead',
          claimedAt: new Date(Date.now() - 3_600_000),
        },
      },
    );
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: jobId },
      { $set: { status: 'running', runnerId: 'dead', heartbeatAt: new Date(Date.now() - 3_600_000) } },
    );
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    expect((await waitDone(id)).result).toMatchObject({ created: 2, failed: 0 });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Replstall' })).toBe(2);
  });
});

describe('Import fixes on a replica set', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a parent whose second child cannot be linked is rolled back with its first link (transaction)', async () => {
    const make = (admissionNo: string) =>
      Student.create({
        schoolId: s.schoolId,
        campusId: s.campusId,
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionA,
        admissionNo,
        firstName: 'Txn',
        lastName: admissionNo,
        gender: 'female',
      });
    const first = await make('TXN-1');
    const second = await make('TXN-2');
    const up = await request(t.app)
      .post('/api/v1/imports')
      .set(auth(s.ownerToken))
      .field('type', 'parents')
      .attach(
        'file',
        Buffer.from('Name,Phone,Relation,Children\nTxn Parent,03127770001,Mother,"TXN-1, TXN-2"\n'),
        'p.csv',
      );
    expect(up.status).toBe(201);
    const id = up.body.data.job._id as string;
    await waitStaged(t.app, s.ownerToken, id);
    const check = await checkAndWait(t.app, s.ownerToken, id, {
      mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    });
    expect(check.summary).toMatchObject({ create: 1 });
    // The second child fills up at the moment of linking, inside the transaction.
    const original = Student.updateOne.bind(Student);
    vi.spyOn(Student, 'updateOne').mockImplementation(((filter: any, update: any, ...rest: any[]) => {
      if (update?.$push?.guardians && String(filter?._id) === String(second._id))
        return original({ ...filter, _id: new mongoose.Types.ObjectId() }, update, ...rest);
      return original(filter, update, ...rest);
    }) as never);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(id);
    vi.restoreAllMocks();
    expect(done.result).toMatchObject({ created: 0, failed: 1 });
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone: '03127770001' })).toBe(0);
    for (const kid of [first, second])
      expect((await Student.findOne({ schoolId: s.schoolId, _id: kid._id }).lean())!.guardians).toHaveLength(0);
    expect(
      await AuditLog.countDocuments({
        schoolId: s.schoolId,
        entityId: { $in: [String(first._id), String(second._id)] },
      }),
    ).toBe(0);
  });

  it('a left student is saved as left in one step (transaction)', async () => {
    const { id, summary } = await checked(
      'Admission No,Student Name,Gender,Class,Section,Status\nTXL-1,Txn Left,Male,Class 5,A,Left\n',
    );
    expect(summary).toMatchObject({ create: 1 });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    expect((await waitDone(id)).result).toMatchObject({ created: 1, failed: 0 });
    const kid = await Student.findOne({ schoolId: s.schoolId, admissionNo: 'TXL-1' }).lean();
    expect(kid).toMatchObject({ status: 'left', leavingReason: 'Imported' });
  });
});
