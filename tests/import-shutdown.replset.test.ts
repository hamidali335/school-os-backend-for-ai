import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImportRow } from '../src/modules/imports/import.models';
import { _undrainForTests, drainImports } from '../src/modules/imports/imports.service';
import { Section } from '../src/modules/academics/academics.models';
import { Student } from '../src/modules/students/student.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/** A server shutdown during an import (a deploy): rows being saved finish, the import resumes at once. */
const t = useTestApp();
let s: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: null } });
});
afterEach(() => {
  vi.restoreAllMocks();
  _undrainForTests();
});

describe('Shutdown during an import', () => {
  it('leaves nothing half-saved and the import resumable straight away; the resume saves each row once', async () => {
    const csv =
      'Admission No,Student Name,Gender,Class,Section,Father Name,Father Phone\n' +
      Array.from(
        { length: 40 },
        (_, i) =>
          `DRAIN-${i},Drain Kid${i},Male,Class 5,${i % 2 ? 'A' : 'B'},Drain Father${i % 15},0345${String(7000000 + (i % 15))}`,
      ).join('\n') +
      '\n';
    const up = await request(t.app)
      .post('/api/v1/imports')
      .set(auth(s.ownerToken))
      .field('type', 'students')
      .attach('file', Buffer.from(csv), 'd.csv');
    const id = up.body.data.job._id as string;
    await waitStaged(t.app, s.ownerToken, id);
    await checkAndWait(t.app, s.ownerToken, id, {
      mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    });
    const original = Student.create.bind(Student);
    vi.spyOn(Student, 'create').mockImplementation((async (...args: any[]) => {
      await new Promise((r) => setTimeout(r, 150));
      return (original as any)(...args);
    }) as never);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const rows = (filter: object) =>
      ImportRow.countDocuments({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id), ...filter });
    while ((await rows({ result: 'created' })) < 5) await new Promise((r) => setTimeout(r, 20));

    await drainImports(10_000);
    const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
    expect(job.status).toBe('interrupted');
    expect(job.error).toMatch(/server restarted/);
    expect(await rows({ result: 'processing' })).toBe(0);
    const savedBefore = await rows({ result: 'created' });
    expect(savedBefore).toBeLessThan(40);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Drain' })).toBe(savedBefore);

    _undrainForTests();
    vi.restoreAllMocks();
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    for (;;) {
      const j = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
      if (j.status !== 'running') {
        expect(j.status).toBe('completed');
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Drain' })).toBe(40);
    expect(
      new Set(
        (await Student.find({ schoolId: s.schoolId, firstName: 'Drain' }).select('admissionNo').lean()).map(
          (k) => k.admissionNo,
        ),
      ).size,
    ).toBe(40);
  });
});
