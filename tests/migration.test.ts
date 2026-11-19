import { beforeAll, describe, expect, it } from 'vitest';
import { backfillHomework, duplicateLogins } from '../scripts/migrate-accounts-homework';
import { Homework } from '../src/modules/homework/homework.models';
import { User } from '../src/modules/users/user.model';
import { buildSchool, type SchoolFixture } from './fixtures';
import { useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;

describe('October 2026 data migration', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 1 });
    const owner = await User.findOne({ schoolId: s.schoolId, role: 'school_owner' }).lean();
    const base = {
      schoolId: s.schoolId,
      sessionId: s.sessionId,
      campusId: s.campusId,
      createdBy: owner!._id,
      description: 'Saved before the fix',
      assignedOn: new Date(),
      dueDate: new Date(),
    };
    // Legacy rows exactly like the bug produced: no teacherId at all.
    await Homework.create([
      { ...base, sectionId: s.sectionA, subjectId: s.mathId, title: 'Legacy maths' }, // has a subject teacher
      { ...base, sectionId: s.sectionB, subjectId: s.englishId, title: 'Legacy english' }, // nobody teaches it
    ]);
  });

  it('dry run reports without changing anything', async () => {
    const r = await backfillHomework(false);
    expect(r).toEqual({ missing: 2, fixable: 1, updated: 0 });
    expect(await Homework.countDocuments({ schoolId: s.schoolId, teacherId: { $exists: true } })).toBe(0);
  });

  it('apply attributes only what can be attributed, and is idempotent', async () => {
    expect(await backfillHomework(true)).toEqual({ missing: 2, fixable: 1, updated: 1 });
    const maths = await Homework.findOne({ schoolId: s.schoolId, title: 'Legacy maths' }).lean();
    expect(String(maths!.teacherId)).toBe(s.teacherEmployeeId);
    expect(maths!.teacherSource).toBe('backfill');
    expect(await backfillHomework(true)).toEqual({ missing: 1, fixable: 0, updated: 0 });
  });

  it('finds no duplicate logins in a healthy database', async () => {
    expect(await duplicateLogins()).toBe(0);
  });
});
