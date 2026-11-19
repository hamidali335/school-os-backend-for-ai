import { beforeAll, describe, expect, it } from 'vitest';
import { Employee } from '../src/modules/employees/employee.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { searchWords, textSearchFilter } from '../src/utils/pagination';
import { useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Full-name search: names are stored in separate fields (firstName/lastName), so "Usman Bukhari"
 * used to find nothing while "Usman" worked. Every word now has to match one of the name fields.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let usman: string;

const ids = (rows: Array<{ _id: string }>) => rows.map((r) => r._id);

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 3 });
  other = await buildSchool(t.app, { students: 1 });
  usman = f.students[0];
  await Student.updateOne({ schoolId: f.schoolId, _id: usman }, { $set: { firstName: 'Usman', lastName: 'Bukhari' } });
  await Student.updateOne(
    { schoolId: f.schoolId, _id: f.students[1] },
    { $set: { firstName: 'Usman', lastName: 'Ghani' } },
  );
  // Same name in another school: never visible here.
  await Student.updateOne(
    { schoolId: other.schoolId, _id: other.students[0] },
    { $set: { firstName: 'Usman', lastName: 'Bukhari' } },
  );
  await Parent.updateOne({ schoolId: f.schoolId, _id: f.parentIds[0] }, { $set: { name: 'Hamid  Ali Shah' } });
});

describe('the shared helper', () => {
  it('collapses spaces, caps words and escapes regex characters', () => {
    expect(searchWords('  Usman   Bukhari ')).toEqual(['Usman', 'Bukhari']);
    expect(searchWords('a b c d e f g')).toHaveLength(5);
    const filter = textSearchFilter('a.b (c', ['name'])!;
    const words = (filter.$or[0] as { $and: Array<{ $or: Array<{ name: RegExp }> }> }).$and;
    expect(words[0].$or[0].name.test('a.b')).toBe(true);
    expect(words[0].$or[0].name.test('axb')).toBe(false); // "." is literal
    expect(textSearchFilter('   ', ['name'])).toBeUndefined();
  });
});

describe('students', () => {
  const search = async (q: string, token = f.ownerToken) =>
    ids(await api(t.app, token, 'get', `/students?limit=50&q=${encodeURIComponent(q)}`));

  it('finds a student by full name, in any order, case and spacing', async () => {
    for (const q of ['Usman Bukhari', 'usman bukhari', '  Usman   Bukhari ', 'Bukhari Usman', 'bukh usm']) {
      const found = await search(q);
      expect(found, q).toContain(usman);
      expect(found, q).not.toContain(f.students[1]); // Usman Ghani is not "Usman Bukhari"
    }
  });

  it('single names and partial names still work; other fields still work', async () => {
    expect(await search('Usman')).toEqual(expect.arrayContaining([usman, f.students[1]]));
    expect(await search('bukhari')).toContain(usman);
    const admissionNo = (await api(t.app, f.ownerToken, 'get', `/students/${usman}`)).admissionNo;
    expect(await search(admissionNo)).toContain(usman);
  });

  it("finds students by a parent's full name", async () => {
    const parentOf = await search('hamid ali');
    expect(parentOf.length).toBeGreaterThan(0);
    expect(await search('Ali Hamid')).toEqual(parentOf);
  });

  it('never returns another school’s student with the same name', async () => {
    const found = await search('Usman Bukhari');
    expect(found).not.toContain(other.students[0]);
    expect(await search('Usman Bukhari', other.ownerToken)).toEqual([other.students[0]]);
  });

  it('a teacher still sees only their own sections', async () => {
    const all = await search('Usman', f.ownerToken);
    const teacher = await search('Usman', f.otherTeacherToken);
    expect(teacher.every((id) => all.includes(id))).toBe(true);
  });
});

describe('other lists', () => {
  it('parents by full name', async () => {
    const rows = await api(t.app, f.ownerToken, 'get', '/parents?limit=50&q=Hamid%20Ali');
    expect(ids(rows)).toContain(f.parentIds[0]);
    expect(ids(await api(t.app, f.ownerToken, 'get', '/parents?limit=50&q=shah%20hamid'))).toContain(f.parentIds[0]);
  });

  it('staff by full name; employee number still works', async () => {
    const found = ids(await api(t.app, f.ownerToken, 'get', '/employees?limit=50&q=Ayesha%20Khan'));
    expect(found).toContain(f.teacherEmployeeId);
    const emp = await Employee.findOne({ schoolId: f.schoolId, _id: f.teacherEmployeeId }).lean();
    expect(ids(await api(t.app, f.ownerToken, 'get', `/employees?limit=50&q=${emp!.employeeNo}`))).toContain(
      f.teacherEmployeeId,
    );
    expect(await api(t.app, f.ownerToken, 'get', '/employees?limit=50&q=Ayesha%20Bilal')).toEqual([]);
  });

  it('admission inquiries by full name', async () => {
    const inq = await api(t.app, f.ownerToken, 'post', '/admissions/inquiries', {
      campusId: f.campusId,
      studentName: 'Hamid Ali',
      parentName: 'Ali Raza',
      phone: '03001234567',
    });
    expect(ids(await api(t.app, f.ownerToken, 'get', '/admissions/inquiries?q=hamid%20ali'))).toContain(inq._id);
  });

  it("fee invoices by the student's full name", async () => {
    await api(t.app, f.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    const rows = await api(t.app, f.accountantToken, 'get', '/fees/invoices?limit=50&q=Usman%20Bukhari');
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (r: { studentId: { _id: string } | string }) => String((r.studentId as any)._id ?? r.studentId) === usman,
      ),
    ).toBe(true);
  });
});
