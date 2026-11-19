import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { recoverInterruptedImports } from '../src/modules/imports/imports.service';
import { classesProcessor } from '../src/modules/imports/processors/classes';
import { School } from '../src/modules/schools/school.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitChecked, waitStaged } from './import-helpers';

/**
 * Regression tests for three import fixes:
 * 1. "Check rows" runs in the background (it timed out on a slow database);
 * 2. left and graduated students are imported at the active-student limit, with their status
 *    saved from the start;
 * 3. a parent whose child cannot be linked is not left behind.
 */
const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
});
afterEach(() => vi.restoreAllMocks());

const upload = async (type: string, content: string) => {
  const res = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', type)
    .attach('file', Buffer.from(content), 'file.csv');
  expect(res.status).toBe(201);
  await waitStaged(t.app, s.ownerToken, res.body.data.job._id);
  return { id: res.body.data.job._id as string, mapping: mappingOf(res.body.data.columns) };
};
const mappingOf = (columns: Array<{ column: number; field: string | null }>) =>
  columns.map((c) => ({ column: c.column, field: c.field }));
const startCheck = (id: string, body: object) =>
  request(t.app).post(`/api/v1/imports/${id}/check`).set(auth(s.ownerToken)).send(body);
const getJob = (id: string) => api(t.app, s.ownerToken, 'get', `/imports/${id}`);
const jobDoc = (id: string) => ImportJob.findOne({ schoolId: s.schoolId, _id: new mongoose.Types.ObjectId(id) }).lean();
const rowsOf = (id: string) =>
  ImportRow.find({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id) })
    .sort({ rowNo: 1 })
    .lean();

async function run(id: string) {
  await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
  for (let i = 0; i < 400; i++) {
    const job = await getJob(id);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('import did not finish');
}

/** Make each batch of check results slow to save, as over the internet to a shared cloud database. */
function slowCheckSaves(ms = 300) {
  const original = ImportRow.bulkWrite.bind(ImportRow);
  return vi.spyOn(ImportRow, 'bulkWrite').mockImplementation((async (...args: Parameters<typeof original>) => {
    await new Promise((r) => setTimeout(r, ms));
    return original(...args);
  }) as never);
}

const classesCsv = (prefix: string, n: number) =>
  'Class,Section\n' + Array.from({ length: n }, (_, i) => `Class ${(i % 10) + 1},${prefix}${i}`).join('\n') + '\n';

/* ───────────────────────────── 1. Check rows in the background ───────────────────────────── */

describe('Checking runs in the background', () => {
  it('answers at once, shows progress, then saves the summary; nothing outside the import changes', async () => {
    const { id, mapping } = await upload('classes', classesCsv('BG', 600));
    slowCheckSaves(400);
    const before = {
      students: await Student.countDocuments({ schoolId: s.schoolId }),
      parents: await Parent.countDocuments({ schoolId: s.schoolId }),
      users: await User.countDocuments({ schoolId: s.schoolId }),
    };
    const startedAt = Date.now();
    const res = await startCheck(id, { mapping });
    expect(res.status).toBe(200);
    // Three batches at 400 ms each would take over a second: the response does not wait.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(res.body.data.summary).toBeNull();
    expect(res.body.data.job).toMatchObject({ status: 'checking', summary: null, progress: { total: 600 } });
    // Rows, the report and the run wait until checking has finished.
    for (const url of [`/api/v1/imports/${id}/rows`, `/api/v1/imports/${id}/report.csv`]) {
      const r = await request(t.app).get(url).set(auth(s.ownerToken));
      expect(r.status, url).toBe(409);
      expect(r.body.error.code).toBe('IMPORT_CHECKING');
    }
    const early = await request(t.app)
      .post(`/api/v1/imports/${id}/run`)
      .set(auth(s.ownerToken))
      .send({ confirm: true });
    expect(early.status).toBe(409);
    const done = await waitChecked(t.app, s.ownerToken, id);
    expect(done).toMatchObject({ status: 'validated', error: null, summary: { total: 600, create: 600 } });
    expect((await rowsOf(id)).every((r) => r.check === 'create')).toBe(true);
    expect(await Student.countDocuments({ schoolId: s.schoolId })).toBe(before.students);
    expect(await Parent.countDocuments({ schoolId: s.schoolId })).toBe(before.parents);
    expect(await User.countDocuments({ schoolId: s.schoolId })).toBe(before.users);
    // Checked imports run as before.
    vi.restoreAllMocks();
    expect((await run(id)).result).toMatchObject({ created: 600, failed: 0 });
  }, 60_000);

  it('a retry, a refresh or a second tab joins the running check instead of starting another', async () => {
    const { id, mapping } = await upload('classes', classesCsv('RETRY', 500));
    slowCheckSaves(200);
    const plan = vi.spyOn(classesProcessor, 'plan');
    // Two requests at the same moment, then a repeat while it runs.
    const [a, b] = await Promise.all([startCheck(id, { mapping }), startCheck(id, { mapping })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const again = await startCheck(id, { mapping });
    expect(again.status).toBe(200);
    expect(again.body.data.job.status).toBe('checking');
    // Different columns while checking are refused rather than mixed into the running check.
    const other = await startCheck(id, { mapping, options: { mode: 'upsert' } });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IMPORT_CHECKING');
    const done = await waitChecked(t.app, s.ownerToken, id);
    expect(done).toMatchObject({ status: 'validated', summary: { total: 500, create: 500 } });
    expect(plan).toHaveBeenCalledTimes(1);
    // Checking again afterwards gives the same result.
    const rechecked = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(rechecked.summary).toEqual(done.summary);
    expect(plan).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('if checking fails, the import returns to the column step with the reason and can be checked again', async () => {
    const { id, mapping } = await upload('classes', classesCsv('FAILCHK', 10));
    vi.spyOn(classesProcessor, 'plan').mockRejectedValueOnce(new Error('simulated database error'));
    expect((await startCheck(id, { mapping })).status).toBe(200);
    const failed = await waitChecked(t.app, s.ownerToken, id);
    expect(failed).toMatchObject({ status: 'analyzed', summary: null });
    expect(failed.error).toMatch(/Checking the rows failed/);
    expect(failed.error).not.toMatch(/simulated/); // internal errors are not shown
    const ok = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(ok.job).toMatchObject({ status: 'validated', error: null });
    expect(ok.summary).toMatchObject({ total: 10, create: 10 });
  });

  it('a check stopped by a server restart can be checked again; a live check elsewhere is left alone', async () => {
    const { id, mapping } = await upload('classes', classesCsv('CRASHCHK', 10));
    // As if the process stopped while checking: status checking, no heartbeat for minutes.
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id },
      { $set: { status: 'checking', runnerId: 'gone', heartbeatAt: new Date(Date.now() - 10 * 60_000) } },
    );
    const seen = await getJob(id);
    expect(seen.status).toBe('analyzed');
    expect(seen.error).toMatch(/Checking stopped/);
    // A live check (recent heartbeat) is not touched by the startup recovery.
    const live = await upload('classes', classesCsv('LIVECHK', 5));
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: live.id },
      { $set: { status: 'checking', runnerId: 'alive', heartbeatAt: new Date() } },
    );
    await recoverInterruptedImports();
    expect(await jobDoc(id)).toMatchObject({ status: 'analyzed', runnerId: null, summary: null });
    expect((await jobDoc(id))!.error).toMatch(/Checking stopped/);
    expect(await jobDoc(live.id)).toMatchObject({ status: 'checking', runnerId: 'alive' });
    // The live check refuses other columns; the stopped one is simply checked again.
    expect((await startCheck(live.id, { mapping: live.mapping, options: { mode: 'upsert' } })).status).toBe(409);
    const again = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(again.job).toMatchObject({ status: 'validated', error: null, summary: { total: 10, create: 10 } });
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: live.id }, { $set: { status: 'analyzed' } });
  });

  it('a stalled check is taken over by a new one; the stalled one can no longer write the result', async () => {
    const { id, mapping } = await upload('classes', classesCsv('TAKEOVER', 10));
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id },
      { $set: { status: 'checking', runnerId: 'stalled', heartbeatAt: new Date(Date.now() - 10 * 60_000) } },
    );
    const res = await startCheck(id, { mapping });
    expect(res.status).toBe(200);
    const after = await jobDoc(id);
    expect(after!.runnerId).not.toBe('stalled');
    await waitChecked(t.app, s.ownerToken, id);
    // A write conditional on the stalled check's ownership matches nothing.
    const stale = await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id, status: 'checking', runnerId: 'stalled' },
      { $set: { status: 'validated' } },
    );
    expect(stale.matchedCount).toBe(0);
    expect(await getJob(id)).toMatchObject({ status: 'validated', summary: { total: 10 } });
  });

  it('stopping while checking cancels the import and removes its rows', async () => {
    const { id, mapping } = await upload('classes', classesCsv('STOPCHK', 750));
    slowCheckSaves(300);
    expect((await startCheck(id, { mapping })).status).toBe(200);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/stop`);
    const job = await waitChecked(t.app, s.ownerToken, id);
    expect(job.status).toBe('cancelled');
    for (let i = 0; i < 50 && (await rowsOf(id)).length > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await rowsOf(id)).toHaveLength(0);
  }, 60_000);
});

/* ───────────────────────────── 2. Plan limit and initial status ───────────────────────────── */

describe('Students who are not active at the active-student limit', () => {
  /** Put the school on a plan that allows exactly as many active students as it has now. */
  async function atLimit() {
    const active = await Student.countDocuments({ schoolId: s.schoolId, status: 'active' });
    const plan = await Plan.create({
      code: `full-${Date.now()}`,
      name: 'Full',
      priceMonthlyPkr: 0,
      limits: { maxStudents: active },
    });
    const school = await School.findById(s.schoolId).select('subscription.planId').lean();
    await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
    return {
      active,
      restore: () =>
        School.updateOne(
          { _id: s.schoolId },
          school?.subscription?.planId
            ? { $set: { 'subscription.planId': school.subscription.planId } }
            : { $unset: { 'subscription.planId': 1 } },
        ),
    };
  }

  it('left and graduated rows are imported with their own status; active rows are refused; preview and run agree', async () => {
    const limit = await atLimit();
    try {
      const { id, mapping } = await upload(
        'students',
        'Admission No,Student Name,Gender,Class,Section,Status\n' +
          'LIM-1,Left Kid,Male,Class 5,A,Left\n' +
          'LIM-2,Graduated Kid,Female,Class 5,A,Graduated\n' +
          'LIM-3,Transferred Kid,Male,Class 5,A,Transferred\n' +
          'LIM-4,Active Kid,Female,Class 5,A,Active\n' +
          'LIM-5,Default Kid,Male,Class 5,A,\n',
      );
      const check = await checkAndWait(t.app, s.ownerToken, id, { mapping });
      expect(check.summary).toMatchObject({ total: 5, create: 3, invalid: 2 });
      const checked = await rowsOf(id);
      expect(checked.map((r) => r.check)).toEqual(['create', 'create', 'create', 'invalid', 'invalid']);
      expect(checked[3].issues.some((i) => /plan allows/.test(i.message ?? ''))).toBe(true);
      const done = await run(id);
      // The run agrees with the preview: the same three rows are added.
      expect(done.result).toMatchObject({ created: 3, failed: 2 });
      const kids = await Student.find({ schoolId: s.schoolId, admissionNo: /^LIM-/ }).sort({ admissionNo: 1 }).lean();
      expect(kids.map((k) => [k.admissionNo, k.status])).toEqual([
        ['LIM-1', 'left'],
        ['LIM-2', 'graduated'],
        ['LIM-3', 'left'],
      ]);
      for (const k of kids) {
        expect(k.statusChangedAt).toBeInstanceOf(Date);
        expect(k.leavingReason).toBe('Imported');
      }
      expect(await Student.countDocuments({ schoolId: s.schoolId, status: 'active' })).toBe(limit.active);
      // Saved with that status from the start: no status change is recorded afterwards.
      const audits = await AuditLog.find({
        schoolId: s.schoolId,
        entityId: { $in: kids.map((k) => String(k._id)) },
      }).lean();
      expect(audits.map((a) => a.action).sort()).toEqual(['student.create', 'student.create', 'student.create']);
      expect(audits.every((a) => (a.metadata as { status?: string }).status !== 'active')).toBe(true);
    } finally {
      await limit.restore();
    }
  });

  it('admissions at the limit are still refused, as before', async () => {
    const limit = await atLimit();
    try {
      const res = await request(t.app).post('/api/v1/students').set(auth(s.ownerToken)).send({
        campusId: s.campusId,
        firstName: 'Over',
        gender: 'male',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionA,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED');
    } finally {
      await limit.restore();
    }
  });

  it('a full section takes left students but not active ones; under the limit active rows are active', async () => {
    const section = await Section.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      classId: s.classId,
      sessionId: s.sessionId,
      name: 'Tiny',
      capacity: 1,
    });
    try {
      const { id, mapping } = await upload(
        'students',
        'Admission No,Student Name,Gender,Class,Section,Status\n' +
          'CAP-1,First Kid,Male,Class 5,Tiny,Active\n' +
          'CAP-2,Left Kid,Male,Class 5,Tiny,Left\n' +
          'CAP-3,Second Kid,Female,Class 5,Tiny,Active\n',
      );
      const check = await checkAndWait(t.app, s.ownerToken, id, { mapping });
      expect(check.summary).toMatchObject({ total: 3, create: 2, invalid: 1 });
      expect((await rowsOf(id)).map((r) => r.check)).toEqual(['create', 'create', 'invalid']);
      expect((await run(id)).result).toMatchObject({ created: 2, failed: 1 });
      const kids = await Student.find({ schoolId: s.schoolId, admissionNo: /^CAP-/ }).sort({ admissionNo: 1 }).lean();
      expect(kids.map((k) => [k.admissionNo, k.status])).toEqual([
        ['CAP-1', 'active'],
        ['CAP-2', 'left'],
      ]);
      expect(kids[0].statusChangedAt).toBeUndefined();
      expect(kids[0].leavingReason).toBeUndefined();
    } finally {
      await Student.deleteMany({ schoolId: s.schoolId, admissionNo: /^CAP-/ });
      await Section.deleteOne({ schoolId: s.schoolId, _id: section._id });
    }
  });

  it('"Inactive" is still not a recognised status (its meaning is unchanged)', async () => {
    const { id, mapping } = await upload(
      'students',
      'Admission No,Student Name,Gender,Class,Section,Status\nINA-1,Inactive Kid,Male,Class 5,A,Inactive\n',
    );
    const check = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(check.summary).toMatchObject({ total: 1, invalid: 1 });
  });
});

/* ───────────────────────────── 3. Parents and their links ───────────────────────────── */

describe('A parent whose child cannot be linked is not left behind', () => {
  /** A student of this school with the given number of guardians. */
  async function studentWith(guardians: number, admissionNo: string) {
    const parents = await Parent.insertMany(
      Array.from({ length: guardians }, (_, i) => ({
        schoolId: s.schoolId,
        name: `Guardian ${admissionNo} ${i}`,
        phone: `0399${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      })),
    );
    return Student.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      admissionNo,
      firstName: 'Kid',
      lastName: admissionNo,
      gender: 'male',
      guardians: parents.map((p, i) => ({ parentId: p._id, relation: 'guardian', isPrimary: i === 0 })),
    });
  }
  const guardiansOf = async (id: unknown) =>
    (await Student.findOne({ schoolId: s.schoolId, _id: id }).lean())!.guardians.map((g) => String(g.parentId));

  it('a child filled up after the check: the row fails, and no parent record is created', async () => {
    const kid = await studentWith(3, 'GRD-1');
    const { id, mapping } = await upload(
      'parents',
      `Name,Phone,Relation,Children\nLate Parent,03117770001,Father,GRD-1\n`,
    );
    const check = await checkAndWait(t.app, s.ownerToken, id, { mapping });
    expect(check.summary).toMatchObject({ create: 1 });
    // Someone adds a fourth guardian between the check and the run.
    const fourth = await Parent.create({ schoolId: s.schoolId, name: 'Fourth', phone: '03117770009' });
    await Student.updateOne(
      { schoolId: s.schoolId, _id: kid._id },
      { $push: { guardians: { parentId: fourth._id, relation: 'other', isPrimary: false } } },
    );
    const done = await run(id);
    expect(done.result).toMatchObject({ created: 0, failed: 1 });
    const [row] = await rowsOf(id);
    expect(row.result).toBe('rejected');
    expect(row.resultMessage).toMatch(/GRD-1 already has 4 parents or guardians/);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone: '03117770001' })).toBe(0);
    expect(await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'parent.create' })).toBe(0);
    expect(await guardiansOf(kid._id)).toHaveLength(4);
  });

  it('a link that fails part-way (concurrent change) undoes the earlier links and the new parent', async () => {
    const first = await studentWith(0, 'GRD-2');
    const second = await studentWith(1, 'GRD-3');
    const { id, mapping } = await upload(
      'parents',
      `Name,Phone,Relation,Children\nRace Parent,03117770002,Mother,"GRD-2, GRD-3"\n`,
    );
    expect((await checkAndWait(t.app, s.ownerToken, id, { mapping })).summary).toMatchObject({ create: 1 });
    // The second student fills up at the moment of linking (after the up-front check passed).
    const original = Student.updateOne.bind(Student);
    vi.spyOn(Student, 'updateOne').mockImplementation(((filter: any, update: any, ...rest: any[]) => {
      if (update?.$push?.guardians && String(filter?._id) === String(second._id))
        return original({ ...filter, _id: new mongoose.Types.ObjectId() }, update, ...rest); // matches nothing: as if a fourth guardian won the race
      return original(filter, update, ...rest);
    }) as never);
    const done = await run(id);
    vi.restoreAllMocks();
    expect(done.result).toMatchObject({ created: 0, failed: 1 });
    expect((await rowsOf(id))[0].resultMessage).toMatch(/GRD-3 already has 4/);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone: '03117770002' })).toBe(0);
    expect(await guardiansOf(first._id)).toHaveLength(0);
    expect(await guardiansOf(second._id)).toHaveLength(1);
    expect(
      await AuditLog.countDocuments({
        schoolId: s.schoolId,
        entityId: { $in: [String(first._id), String(second._id)] },
      }),
    ).toBe(0);
  });

  it('an existing parent is not updated when a child cannot be linked', async () => {
    const existing = await Parent.create({ schoolId: s.schoolId, name: 'Old Name', phone: '03117770003' });
    const full = await studentWith(4, 'GRD-4');
    const free = await studentWith(0, 'GRD-5');
    // The check already refuses a child with four guardians.
    const refused = await upload('parents', `Name,Phone,Relation,Children\nNew Name,03117770003,Father,GRD-4\n`);
    const refusedCheck = await checkAndWait(t.app, s.ownerToken, refused.id, {
      mapping: refused.mapping,
      options: { mode: 'upsert' },
    });
    expect(refusedCheck.summary).toMatchObject({ invalid: 1 });
    // A child that fills up after the check: the update is not applied either.
    const { id, mapping } = await upload(
      'parents',
      `Name,Phone,Relation,Children\nNew Name,03117770003,Father,GRD-5\n`,
    );
    expect(
      (await checkAndWait(t.app, s.ownerToken, id, { mapping, options: { mode: 'upsert' } })).summary,
    ).toMatchObject({ update: 1 });
    await Student.updateOne({ schoolId: s.schoolId, _id: free._id }, { $set: { guardians: full.guardians } });
    expect((await run(id)).result).toMatchObject({ updated: 0, failed: 1 });
    expect((await Parent.findOne({ schoolId: s.schoolId, _id: existing._id }).lean())!.name).toBe('Old Name');
    expect(await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'parent.update' })).toBe(0);
  });

  it('siblings are still linked to one parent record, with one audit entry per change', async () => {
    const a = await studentWith(0, 'SIB-1');
    const b = await studentWith(2, 'SIB-2');
    const { id, mapping } = await upload(
      'parents',
      `Name,Phone,Relation,Children\nSibling Parent,03117770004,Father,"SIB-1, SIB-2"\n`,
    );
    expect((await checkAndWait(t.app, s.ownerToken, id, { mapping })).summary).toMatchObject({ create: 1 });
    expect((await run(id)).result).toMatchObject({ created: 1, failed: 0 });
    const parent = await Parent.findOne({ schoolId: s.schoolId, phone: '03117770004' }).lean();
    expect(parent).toBeTruthy();
    const kidA = await Student.findOne({ schoolId: s.schoolId, _id: a._id }).lean();
    const kidB = await Student.findOne({ schoolId: s.schoolId, _id: b._id }).lean();
    expect(kidA!.guardians).toEqual([
      expect.objectContaining({ parentId: parent!._id, relation: 'father', isPrimary: true }),
    ]);
    expect(kidB!.guardians).toHaveLength(3);
    expect(kidB!.guardians[2]).toMatchObject({ parentId: parent!._id, relation: 'father', isPrimary: false });
    expect(
      await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'parent.create', entityId: String(parent!._id) }),
    ).toBe(1);
    expect(
      await AuditLog.countDocuments({
        schoolId: s.schoolId,
        action: 'student.update',
        entityId: { $in: [String(a._id), String(b._id)] },
      }),
    ).toBe(2);
    // Parent records added by an import still have no login.
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parent!._id })).toBe(0);
  });
});
