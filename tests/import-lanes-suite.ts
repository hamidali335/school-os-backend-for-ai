import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEATURE_KEYS } from '../src/config/entitlements';
import { ROLE_PERMISSIONS } from '../src/config/permissions';
import { Section } from '../src/modules/academics/academics.models';
import { AuditLog } from '../src/modules/audit/audit.model';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { _processJobForTests, IMPORT_LEASE, recoverInterruptedImports } from '../src/modules/imports/imports.service';
import { School } from '../src/modules/schools/school.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { Plan } from '../src/modules/subscriptions/plan.model';
import { User } from '../src/modules/users/user.model';
import type { SchoolContext } from '../src/types/context';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, type TestCtx } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Students import saved in parallel lanes: identity, limits, stopping and takeover. Shared by
 * the standalone and the replica-set suites (the same rules hold with and without transactions).
 */
export function laneSuite(t: TestCtx) {
  let s: SchoolFixture;
  let ctx: SchoolContext;
  const HEARTBEAT = IMPORT_LEASE.HEARTBEAT_MS;

  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 1 });
    await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: null } });
    await usePlan(100_000);
    const owner = await User.findOne({ schoolId: s.schoolId, role: 'school_owner' }).lean();
    ctx = {
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    IMPORT_LEASE.HEARTBEAT_MS = HEARTBEAT;
  });

  async function usePlan(maxStudents: number) {
    const plan = await Plan.create({
      code: `lanes-${Date.now()}-${maxStudents}`,
      name: 'Lanes',
      priceMonthlyPkr: 0,
      limits: { maxStudents },
    });
    await School.updateOne({ _id: s.schoolId }, { $set: { 'subscription.planId': plan._id } });
    return plan;
  }

  async function checked(csv: string) {
    const up = await request(t.app)
      .post('/api/v1/imports')
      .set(auth(s.ownerToken))
      .field('type', 'students')
      .attach('file', Buffer.from(csv), 'lanes.csv');
    expect(up.status).toBe(201);
    const id = up.body.data.job._id as string;
    await waitStaged(t.app, s.ownerToken, id);
    const res = await checkAndWait(t.app, s.ownerToken, id, {
      mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    });
    return { id, summary: res.summary };
  }
  const run = (id: string) => api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
  async function waitDone(id: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
      if (job.status !== 'running') return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('import did not finish');
  }
  /** Each file's families get their own phone numbers. */
  const tags = new Map<string, number>();
  const rows = (id: string, filter: Record<string, unknown> = {}) =>
    ImportRow.find({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id), ...filter })
      .sort({ rowNo: 1 })
      .lean();

  /**
   * `n` students in `families` families (father phone shared by siblings, spread through the
   * file), every third family with a mother of her own number, every third row without an
   * admission number.
   */
  function file(
    tag: string,
    n: number,
    families: number,
    opts: { section?: string; status?: (i: number) => string; email?: (f: number) => string } = {},
  ) {
    if (!tags.has(tag)) tags.set(tag, tags.size);
    const base = 200_000_000 + tags.get(tag)! * 1000;
    const phone = (f: number, m = 0) => `03${String(base + m * 500 + f)}`;
    const lines = [
      'Admission No,Student Name,Gender,Class,Section,Father Name,Father Phone,Parent Email,Mother Name,Mother Phone,Status',
    ];
    for (let i = 0; i < n; i++) {
      const f = (i * 7) % families;
      lines.push(
        [
          i % 3 === 0 ? '' : `${tag}-${i}`,
          `${tag} Kid${i}`,
          i % 2 ? 'Male' : 'Female',
          'Class 5',
          opts.section ?? (i % 2 ? 'A' : 'B'),
          `${tag} Father${f}`,
          phone(f),
          opts.email?.(f) ?? '',
          f % 3 === 0 ? `${tag} Mother${f}` : '',
          f % 3 === 0 ? phone(f, 1) : '',
          opts.status?.(i) ?? 'Active',
        ].join(','),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  /** Every parent of the tag once per phone, one login each, and each student linked to its family's parents. */
  async function expectFamilies(tag: string, students: number, families: number) {
    const kids = await Student.find({ schoolId: s.schoolId, firstName: tag })
      .select('lastName admissionNo guardians')
      .lean();
    expect(kids).toHaveLength(students);
    expect(new Set(kids.map((k) => k.admissionNo)).size).toBe(students);
    const parents = await Parent.find({ schoolId: s.schoolId, name: { $regex: `^${tag} (Father|Mother)` } }).lean();
    expect(new Set(parents.map((p) => p.phone)).size).toBe(parents.length);
    expect(parents).toHaveLength(families + Math.ceil(families / 3));
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: { $in: parents.map((p) => p._id) } })).toBe(
      parents.length,
    );
    const byName = new Map(parents.map((p) => [p.name, String(p._id)]));
    for (const k of kids) {
      const i = Number(String(k.lastName).replace('Kid', ''));
      const f = (i * 7) % families;
      const linked = k.guardians.map((g) => String(g.parentId));
      expect(linked).toContain(byName.get(`${tag} Father${f}`));
      if (f % 3 === 0) expect(linked).toContain(byName.get(`${tag} Mother${f}`));
    }
    return { kids, parents };
  }

  describe('Students saved in lanes', () => {
    it('siblings in different parts of the file share one parent and one login; numbers follow the file', async () => {
      const { id, summary } = await checked(file('Lanesib', 90, 30));
      expect(summary).toMatchObject({ create: 90, invalid: 0 });
      await run(id);
      expect((await waitDone(id)).result).toMatchObject({ created: 90, failed: 0 });
      await expectFamilies('Lanesib', 90, 30);
      // Rows without an admission number are numbered in file order.
      const numbered = (await rows(id)).filter((r) => r.assignedKey).map((r) => Number(String(r.assignedKey).slice(4)));
      expect(numbered).toHaveLength(30);
      expect(numbered).toEqual([...numbered].sort((a, b) => a - b));
      expect(numbered[numbered.length - 1] - numbered[0]).toBe(29);
    });

    it('two families with one email: one login gets the email, as when saved one at a time', async () => {
      const { id } = await checked(
        file('Lanemail', 12, 6, { email: (f) => (f < 2 ? 'shared.lanes@example.test' : '') }),
      );
      await run(id);
      expect((await waitDone(id)).result).toMatchObject({ created: 12, failed: 0 });
      await expectFamilies('Lanemail', 12, 6);
      expect(await User.countDocuments({ schoolId: s.schoolId, email: 'shared.lanes@example.test' })).toBe(1);
    });

    it('a run that takes over leaves the families the other run is saving; a resume finishes, nothing twice', async () => {
      IMPORT_LEASE.HEARTBEAT_MS = 50;
      const original = Student.create.bind(Student);
      vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, 300));
        return (original as any)(...args);
      }) as never);
      const { id } = await checked(file('Lanetwo', 40, 15));
      const jobId = new mongoose.Types.ObjectId(id);
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: jobId },
        { $set: { status: 'running', runnerId: 'run-a', heartbeatAt: new Date() } },
      );
      const a = _processJobForTests(ctx, id, 'run-a');
      while ((await rows(id, { result: 'processing', claimedBy: 'run-a' })).length < 2)
        await new Promise((r) => setTimeout(r, 10));
      // Run B takes the import over while run A is still saving some rows.
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: jobId },
        { $set: { runnerId: 'run-b', heartbeatAt: new Date() } },
      );
      await new Promise((r) => setTimeout(r, 120)); // run A notices at its next heartbeat
      const b = _processJobForTests(ctx, id, 'run-b');
      await Promise.all([a, b]);
      vi.restoreAllMocks();
      const job = await ImportJob.findOne({ schoolId: s.schoolId, _id: jobId }).lean();
      expect(job!.status).toBe('interrupted'); // run B left run A's families for later
      // No row was saved by both runs, and no family was saved by both at once.
      const all = await rows(id);
      const byA = new Set(all.filter((r) => r.claimedBy === 'run-a').map((r) => r.rowNo));
      expect(byA.size).toBeGreaterThan(0);
      expect(all.every((r) => r.result !== 'failed')).toBe(true);
      // Resuming finishes the rest; every student once, one parent and one login per phone.
      await run(id);
      expect((await waitDone(id)).status).toBe('completed');
      await expectFamilies('Lanetwo', 40, 15);
      expect((await rows(id, { result: 'created' })).length).toBe(40);
    });

    it('a run whose heartbeat cannot be renewed stops starting rows before another run could take over', async () => {
      IMPORT_LEASE.HEARTBEAT_MS = 50;
      const stale = IMPORT_LEASE.STALE_MS;
      IMPORT_LEASE.STALE_MS = 600;
      const create = Student.create.bind(Student);
      vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, 100));
        return (create as any)(...args);
      }) as never);
      try {
        const { id } = await checked(file('Lanefence', 40, 40));
        await run(id);
        while ((await rows(id, { result: 'created' })).length < 4) await new Promise((r) => setTimeout(r, 10));
        // The database stops answering the heartbeat (the rows still save).
        const renew = ImportJob.findOneAndUpdate.bind(ImportJob);
        vi.spyOn(ImportJob, 'findOneAndUpdate').mockImplementation(((filter: any, update: any, ...rest: any[]) => {
          if (update?.$set?.heartbeatAt && update.$set['progress.total'] !== undefined)
            throw new Error('heartbeat timed out');
          return (renew as any)(filter, update, ...rest);
        }) as never);
        await new Promise((r) => setTimeout(r, 700)); // past half of STALE_MS: no new row starts
        const settled = (await rows(id, { result: { $ne: null } })).length;
        await new Promise((r) => setTimeout(r, 400));
        expect((await rows(id, { result: { $ne: null } })).length).toBe(settled);
        expect(settled).toBeLessThan(40);
        const job = await ImportJob.findOne({ schoolId: s.schoolId, _id: id }).lean();
        expect(job!.status).toBe('interrupted');
        vi.restoreAllMocks();
        IMPORT_LEASE.STALE_MS = stale;
        await run(id);
        expect((await waitDone(id)).status).toBe('completed');
        expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanefence' })).toBe(40);
      } finally {
        IMPORT_LEASE.STALE_MS = stale;
      }
    });

    it('rows that failed and a second import of the same file create nothing twice', async () => {
      // The first save of three rows fails unexpectedly (as a lost connection would).
      const original = Student.create.bind(Student);
      let failures = 0;
      vi.spyOn(Student, 'create').mockImplementation((async (doc: any, ...rest: any[]) => {
        if (doc?.firstName === 'Laneretry' && ['Kid4', 'Kid5', 'Kid6'].includes(doc.lastName) && failures < 3) {
          failures++;
          throw new Error('connection reset');
        }
        return (original as any)(doc, ...rest);
      }) as never);
      const csv = file('Laneretry', 24, 8);
      const first = await checked(csv);
      await run(first.id);
      expect((await waitDone(first.id)).result).toMatchObject({ created: 21, failed: 3 });
      vi.restoreAllMocks();
      // Nothing half-saved: the failed rows left no parent or login behind of their own.
      const second = await checked(csv);
      expect(second.summary).toMatchObject({ create: 3 });
      await run(second.id);
      expect((await waitDone(second.id)).result).toMatchObject({ created: 3, failed: 0 });
      await expectFamilies('Laneretry', 24, 8);
    });

    it('a failed parent login undoes only its row; the sibling after it in the file creates the parent', async () => {
      const original = User.create.bind(User);
      let failed = false;
      vi.spyOn(User, 'create').mockImplementation((async (doc: any, ...rest: any[]) => {
        if (!failed && String(doc?.name) === 'Lanelink Father0') {
          failed = true;
          throw new Error('login could not be saved');
        }
        return (original as any)(doc, ...rest);
      }) as never);
      const { id } = await checked(file('Lanelink', 12, 4));
      await run(id);
      const done = await waitDone(id);
      expect(done.result).toMatchObject({ created: 11, failed: 1 });
      const failedRow = (await rows(id, { result: 'failed' }))[0];
      expect(failedRow.rowNo).toBe(2); // the family's first row
      const father = await Parent.find({ schoolId: s.schoolId, name: 'Lanelink Father0' }).lean();
      expect(father).toHaveLength(1);
      expect(await User.countDocuments({ schoolId: s.schoolId, parentId: father[0]._id })).toBe(1);
      expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanelink', lastName: 'Kid0' })).toBe(0);
    });

    it('a failed audit entry does not fail the row (audit never throws) and saves the student', async () => {
      const original = AuditLog.create.bind(AuditLog);
      let n = 0;
      vi.spyOn(AuditLog, 'create').mockImplementation((async (doc: any, ...rest: any[]) => {
        if (doc?.action === 'student.create' && ++n === 3) throw new Error('audit store unavailable');
        return (original as any)(doc, ...rest);
      }) as never);
      const { id } = await checked(file('Laneaudit', 8, 4));
      await run(id);
      expect((await waitDone(id)).result).toMatchObject({ created: 8, failed: 0 });
      await expectFamilies('Laneaudit', 8, 4);
    });
  });

  describe('Limits stay exact with lanes', () => {
    /** Lower the limit after the run has checked its rows, so the rows meet it while being saved. */
    function changeWhenRunStarts(change: () => Promise<unknown>) {
      const original = ImportRow.bulkWrite.bind(ImportRow);
      let done = false;
      vi.spyOn(ImportRow, 'bulkWrite').mockImplementation((async (...args: any[]) => {
        const res = await (original as any)(...args);
        if (!done) {
          done = true;
          await change();
        }
        return res;
      }) as never);
    }

    it('the active-student limit: exactly up to the limit, never one more; left students still saved', async () => {
      const active = await Student.countDocuments({ schoolId: s.schoolId, status: 'active' });
      const { id, summary } = await checked(
        file('Lanelimit', 46, 23, { status: (i) => (i % 15 === 7 ? 'Left' : 'Active') }),
      );
      expect(summary).toMatchObject({ create: 46 });
      changeWhenRunStarts(() => usePlan(active + 9));
      await run(id);
      const done = await waitDone(id);
      expect(await Student.countDocuments({ schoolId: s.schoolId, status: 'active' })).toBe(active + 9);
      expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanelimit', status: 'left' })).toBe(3);
      expect(done.result).toMatchObject({ created: 12, failed: 34 });
      for (const r of await rows(id, { result: 'failed' })) expect(r.resultMessage).toMatch(/allows up to/);
      await usePlan(100_000);
    });

    it('a section capacity: exactly up to the capacity, never one more', async () => {
      const enrolled = await Student.countDocuments({ schoolId: s.schoolId, sectionId: s.sectionA, status: 'active' });
      const { id } = await checked(file('Lanecap', 30, 30, { section: 'A' }));
      changeWhenRunStarts(() =>
        Section.updateOne({ schoolId: s.schoolId, _id: s.sectionA }, { $set: { capacity: enrolled + 5 } }),
      );
      await run(id);
      const done = await waitDone(id);
      expect(await Student.countDocuments({ schoolId: s.schoolId, sectionId: s.sectionA, status: 'active' })).toBe(
        enrolled + 5,
      );
      expect(done.result).toMatchObject({ created: 5, failed: 25 });
      await Section.updateOne({ schoolId: s.schoolId, _id: s.sectionA }, { $set: { capacity: null } });
    });

    it('a second import of the same school waits: one import runs at a time', async () => {
      const original = Student.create.bind(Student);
      vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, 150));
        return (original as any)(...args);
      }) as never);
      const one = await checked(file('Laneone', 16, 16));
      const two = await checked(file('Lanetwin', 4, 4));
      await run(one.id);
      const res = await request(t.app)
        .post(`/api/v1/imports/${two.id}/run`)
        .set(auth(s.ownerToken))
        .send({ confirm: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IMPORT_ALREADY_RUNNING');
      expect((await waitDone(one.id)).result).toMatchObject({ created: 16 });
      vi.restoreAllMocks();
      await run(two.id);
      expect((await waitDone(two.id)).result).toMatchObject({ created: 4 });
    });
  });

  describe('Heartbeat, stopping, takeover and recovery', () => {
    function slowStudents(ms: number) {
      const original = Student.create.bind(Student);
      return vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, ms));
        return (original as any)(...args);
      }) as never);
    }
    const job = (id: string) => ImportJob.findOne({ schoolId: s.schoolId, _id: id }).lean();

    it('the heartbeat goes on while a single row takes longer than it', async () => {
      IMPORT_LEASE.HEARTBEAT_MS = 100;
      slowStudents(1200);
      const { id } = await checked(file('Laneslow', 1, 1));
      await run(id);
      await new Promise((r) => setTimeout(r, 400));
      const a = (await job(id))!.heartbeatAt!;
      await new Promise((r) => setTimeout(r, 400));
      const b = (await job(id))!.heartbeatAt!;
      expect(b.getTime()).toBeGreaterThan(a.getTime());
      expect((await job(id))!.status).toBe('running');
      expect((await waitDone(id)).result).toMatchObject({ created: 1 });
    });

    it('Stop: no new row starts; the rows being saved finish; nothing is left half-saved', async () => {
      IMPORT_LEASE.HEARTBEAT_MS = 50;
      slowStudents(100);
      const { id } = await checked(file('Lanestop', 60, 60));
      await run(id);
      while ((await rows(id, { result: 'created' })).length < 8) await new Promise((r) => setTimeout(r, 20));
      await api(t.app, s.ownerToken, 'post', `/imports/${id}/stop`);
      const done = await waitDone(id);
      expect(done.status).toBe('cancelled');
      const all = await rows(id);
      const created = all.filter((r) => r.result === 'created').length;
      expect(created).toBeLessThan(60);
      expect(all.filter((r) => r.result === 'processing')).toHaveLength(0);
      expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanestop' })).toBe(created);
      expect(done.result.created).toBe(created);
    });

    it('a run that lost its import to another run stops starting rows', async () => {
      IMPORT_LEASE.HEARTBEAT_MS = 50;
      slowStudents(100);
      const { id } = await checked(file('Lanelost', 60, 60));
      await run(id);
      while ((await rows(id, { result: 'created' })).length < 4) await new Promise((r) => setTimeout(r, 20));
      // Another process took the import over (as after a stall).
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: id },
        { $set: { runnerId: 'another-process', heartbeatAt: new Date() } },
      );
      await new Promise((r) => setTimeout(r, 600)); // a heartbeat, then the rows already started finish
      const settled = (await rows(id, { result: { $ne: null } })).length;
      await new Promise((r) => setTimeout(r, 600));
      expect((await rows(id, { result: { $ne: null } })).length).toBe(settled);
      expect(settled).toBeLessThan(60);
      expect((await job(id))!.runnerId).toBe('another-process');
      expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanelost' })).toBe(
        (await rows(id, { result: 'created' })).length,
      );
      // The other process "stops" too, so later tests can run an import.
      await ImportJob.updateOne({ schoolId: s.schoolId, _id: id }, { $set: { status: 'interrupted' } });
    });

    it('a stalled run whose stop was requested is cancelled, not offered for resuming', async () => {
      const { id } = await checked(file('Lanecancel', 2, 2));
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: id },
        {
          $set: {
            status: 'running',
            runnerId: 'dead',
            cancelRequested: true,
            heartbeatAt: new Date(Date.now() - 3_600_000),
          },
        },
      );
      expect((await api(t.app, s.ownerToken, 'get', `/imports/${id}`)).status).toBe('cancelled');
      const resume = await request(t.app)
        .post(`/api/v1/imports/${id}/run`)
        .set(auth(s.ownerToken))
        .send({ confirm: true });
      expect(resume.status).toBe(409);
      expect((await job(id))!.status).toBe('cancelled');
      expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lanecancel' })).toBe(0);
    });

    it('at startup, stalled runs are resumable, or cancelled if a stop was requested', async () => {
      const a = await checked(file('Lanerecova', 1, 1));
      const b = await checked(file('Lanerecovb', 1, 1));
      const old = new Date(Date.now() - 3_600_000);
      // One running import per school (unique index): one stalled run at a time.
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: a.id },
        { $set: { status: 'running', runnerId: 'dead', heartbeatAt: old } },
      );
      await recoverInterruptedImports();
      expect((await job(a.id))!.status).toBe('interrupted');
      await ImportJob.updateOne(
        { schoolId: s.schoolId, _id: b.id },
        { $set: { status: 'running', runnerId: 'dead2', cancelRequested: true, heartbeatAt: old } },
      );
      await recoverInterruptedImports();
      expect((await job(b.id))!.status).toBe('cancelled');
      expect((await job(b.id))!.finishedAt).toBeTruthy();
    });
  });
}
