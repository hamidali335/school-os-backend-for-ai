import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { FeeStructure } from '../src/modules/fees/fees.models';
import { auth, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * The school's default fee structure: new classes start with a copy, nothing is overwritten,
 * repeats never duplicate, and filling in classes without a structure is explicit and previewed.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let annualHead: string;
let perStudentHead: string;

const call = (token: string, method: 'get' | 'put' | 'post' | 'delete', url: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);
const newClass = (name: string, level: number) =>
  api(t.app, f.ownerToken, 'post', '/academics/classes', { campusId: f.campusId, name, level });

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
  annualHead = (
    await api(t.app, f.ownerToken, 'post', '/fees/heads', {
      name: 'Yearly Charges',
      code: 'YEARLY',
      frequency: 'annual',
    })
  )._id;
  perStudentHead = (
    await api(t.app, f.ownerToken, 'post', '/fees/heads', {
      name: 'School bus',
      code: 'BUS',
      frequency: 'monthly',
      billing: 'per_student',
    })
  )._id;
});

describe('without a default', () => {
  it('a new class gets no structure and no invented amounts', async () => {
    const cls = await newClass('Class 1', 1);
    expect(await FeeStructure.countDocuments({ schoolId: f.schoolId, classId: cls._id })).toBe(0);
    expect(await api(t.app, f.ownerToken, 'get', `/fees/default-template?sessionId=${f.sessionId}`)).toBeNull();
  });
});

describe('setting the default', () => {
  it('follows the class-structure rules', async () => {
    const perStudent = await call(f.ownerToken, 'put', '/fees/default-template', {
      sessionId: f.sessionId,
      name: 'Standard fees',
      items: [{ feeHeadId: perStudentHead, amount: 2000 }],
    });
    expect(perStudent.status).toBe(400);
    const noMonth = await call(f.ownerToken, 'put', '/fees/default-template', {
      sessionId: f.sessionId,
      name: 'Standard fees',
      items: [{ feeHeadId: annualHead, amount: 5000 }],
    });
    expect(noMonth.status).toBe(400);
    expect(
      (
        await call(f.teacherToken, 'put', '/fees/default-template', {
          sessionId: f.sessionId,
          name: 'Teacher attempt',
          items: [{ feeHeadId: f.tuitionHeadId, amount: 1 }],
        })
      ).status,
    ).toBe(403);
  });

  it('saves, with an audit entry', async () => {
    const tpl = await api(t.app, f.ownerToken, 'put', '/fees/default-template', {
      sessionId: f.sessionId,
      name: 'Standard fees',
      items: [
        { feeHeadId: f.tuitionHeadId, amount: 6500 },
        { feeHeadId: annualHead, amount: 5000, billingMonths: [4] },
      ],
    });
    expect(tpl.items).toHaveLength(2);
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'fee_template.save' })).toBeTruthy();
  });
});

describe('new classes', () => {
  it('start with a copy of the default, which they can then change', async () => {
    const cls = await newClass('Class 2', 2);
    const s = await FeeStructure.findOne({ schoolId: f.schoolId, classId: cls._id, sessionId: f.sessionId }).lean();
    expect(s!.name).toBe('Standard fees');
    expect(s!.items.map((i) => i.amount).sort()).toEqual([5000, 6500]);
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'fee_structure.from_template' })).toBeTruthy();
    // The class's own change is kept, and a later template change does not touch it.
    await api(t.app, f.ownerToken, 'put', '/fees/structures', {
      sessionId: f.sessionId,
      classId: cls._id,
      name: 'Class 2 fees',
      items: [{ feeHeadId: f.tuitionHeadId, amount: 7000 }],
    });
    await api(t.app, f.ownerToken, 'put', '/fees/default-template', {
      sessionId: f.sessionId,
      name: 'Standard fees',
      items: [{ feeHeadId: f.tuitionHeadId, amount: 9999 }],
    });
    const after = await FeeStructure.findOne({ schoolId: f.schoolId, classId: cls._id, sessionId: f.sessionId }).lean();
    expect(after!.items.map((i) => i.amount)).toEqual([7000]);
  });
});

describe('applying the default to classes without a structure', () => {
  it('preview changes nothing and says what would happen', async () => {
    const before = await FeeStructure.countDocuments({ schoolId: f.schoolId });
    const p = await api(t.app, f.ownerToken, 'get', `/fees/default-template/preview?sessionId=${f.sessionId}`);
    expect(p.hasTemplate).toBe(true);
    const byName = Object.fromEntries(p.classes.map((c: { name: string; action: string }) => [c.name, c.action]));
    expect(byName['Class 1']).toBe('create'); // created before the default existed
    expect(byName['Class 2']).toBe('keep');
    expect(byName['Class 5']).toBe('keep'); // the fixture's class already has a structure
    expect(await FeeStructure.countDocuments({ schoolId: f.schoolId })).toBe(before);
  });

  it('apply fills in only the missing ones, even when repeated at once', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => call(f.ownerToken, 'post', '/fees/default-template/apply', { sessionId: f.sessionId })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.flatMap((r) => r.body.data.created)).toEqual(['Class 1']);
    const classes = await api(t.app, f.ownerToken, 'get', '/academics/classes?limit=50');
    for (const c of classes)
      expect(await FeeStructure.countDocuments({ schoolId: f.schoolId, classId: c._id, sessionId: f.sessionId })).toBe(
        1,
      );
  });
});

describe('isolation and safety', () => {
  it('another school sees nothing, and its new classes get nothing from this default', async () => {
    expect(await api(t.app, other.ownerToken, 'get', `/fees/default-template?sessionId=${other.sessionId}`)).toBeNull();
    expect(
      (await call(other.ownerToken, 'get', `/fees/default-template?sessionId=${f.sessionId}`)).body.data,
    ).toBeNull();
    const cls = await api(t.app, other.ownerToken, 'post', '/academics/classes', {
      campusId: other.campusId,
      name: 'Class 9',
      level: 9,
    });
    expect(await FeeStructure.countDocuments({ schoolId: other.schoolId, classId: cls._id })).toBe(0);
  });

  it('a fee head the default uses cannot be deleted', async () => {
    const tuition = await call(f.ownerToken, 'delete', `/fees/heads/${f.tuitionHeadId}`);
    expect(tuition.status).toBe(409);
  });
});
