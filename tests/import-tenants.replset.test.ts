import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

/**
 * Two schools importing the same file at the same moment (same admission numbers and parent
 * phones): each school gets its own students, parents and logins; nothing crosses over.
 */
const t = useTestApp();
let a: SchoolFixture;
let b: SchoolFixture;

beforeAll(async () => {
  a = await buildSchool(t.app, { students: 1 });
  b = await buildSchool(t.app, { students: 1 });
  await Section.updateMany({ schoolId: { $in: [a.schoolId, b.schoolId] } }, { $set: { capacity: null } });
});

const csv =
  'Admission No,Student Name,Gender,Class,Section,Father Name,Father Phone\n' +
  Array.from(
    { length: 60 },
    (_, i) =>
      `TEN-${i},Tenant Kid${i},Male,Class 5,${i % 2 ? 'A' : 'B'},Tenant Father${i % 20},0333${String(5000000 + (i % 20))}`,
  ).join('\n') +
  '\n';

async function checked(s: SchoolFixture) {
  const up = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(s.ownerToken))
    .field('type', 'students')
    .attach('file', Buffer.from(csv), 't.csv');
  const id = up.body.data.job._id as string;
  await waitStaged(t.app, s.ownerToken, id);
  await checkAndWait(t.app, s.ownerToken, id, {
    mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
  });
  return id;
}
async function done(s: SchoolFixture, id: string) {
  for (;;) {
    const job = await api(t.app, s.ownerToken, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Imports of two schools at once', () => {
  it('each school gets its own records, with nothing shared or leaked', async () => {
    const [ia, ib] = [await checked(a), await checked(b)];
    await Promise.all([
      api(t.app, a.ownerToken, 'post', `/imports/${ia}/run`, { confirm: true }),
      api(t.app, b.ownerToken, 'post', `/imports/${ib}/run`, { confirm: true }),
    ]);
    const [ja, jb] = await Promise.all([done(a, ia), done(b, ib)]);
    expect(ja.result).toMatchObject({ created: 60, failed: 0 });
    expect(jb.result).toMatchObject({ created: 60, failed: 0 });
    for (const [s, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const kids = await Student.find({ schoolId: s.schoolId, firstName: 'Tenant' }).lean();
      const parents = await Parent.find({ schoolId: s.schoolId, name: /^Tenant Father/ }).lean();
      expect(kids).toHaveLength(60);
      expect(parents).toHaveLength(20);
      const own = new Set(parents.map((p) => String(p._id)));
      for (const k of kids) for (const g of k.guardians) expect(own.has(String(g.parentId))).toBe(true);
      expect(await User.countDocuments({ schoolId: s.schoolId, parentId: { $in: parents.map((p) => p._id) } })).toBe(
        20,
      );
      // The other school's import and rows are not visible here.
      expect(
        (
          await request(t.app)
            .get(`/api/v1/imports/${s === a ? ib : ia}`)
            .set(auth(s.ownerToken))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(t.app)
            .get(`/api/v1/imports/${s === a ? ib : ia}/rows`)
            .set(auth(s.ownerToken))
        ).status,
      ).toBe(404);
      const otherKids = await Student.find({ schoolId: other.schoolId, firstName: 'Tenant' }).select('_id').lean();
      expect(otherKids.some((o) => kids.some((k) => String(k._id) === String(o._id)))).toBe(false);
    }
  });
});
