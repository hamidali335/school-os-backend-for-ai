import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { SchoolClass, Section } from '../src/modules/academics/academics.models';
import { Employee } from '../src/modules/employees/employee.model';
import { suggestMapping } from '../src/modules/imports/import-fields';
import { inspectZip, readSpreadsheet } from '../src/modules/imports/import-files';
import { parseDate, parsePhone, parseStudentStatus } from '../src/modules/imports/import-values';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import { recoverInterruptedImports } from '../src/modules/imports/imports.service';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  other = await buildSchool(t.app, { students: 1 });
});

/** The school's own export, as attached by the user (one real row). */
const USER_EXPORT = `SID,Student Name,Father/Guard,Class,Session,Feeplanlist,Mother Mobile,Father/Guard Mobile,DOB,Gender,Status
664,Muhammad Hamza Bilal,Muhammad Bilal,P.G,2025-2026,P.G To K.G-2 Fee Structure,3293903346,03293903346,04-Feb-2022,Male,Currently Enrolled
`;

const upload = async (token: string, type: string, content: string | Buffer, name = 'file.csv') => {
  const res = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', type)
    .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  // Rows are prepared in the background: wait like the import screen does.
  if (res.status === 201) await waitStaged(t.app, token, res.body.data.job._id);
  return res;
};

const mappingOf = (columns: Array<{ column: number; field: string | null }>) =>
  columns.map((c) => ({ column: c.column, field: c.field }));

async function waitDone(token: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import did not finish');
}

async function importCsv(token: string, type: string, csv: string, options: Record<string, unknown> = {}) {
  const up = await upload(token, type, csv);
  expect(up.status).toBe(201);
  const check = await checkAndWait(t.app, token, up.body.data.job._id, {
    mapping: mappingOf(up.body.data.columns),
    options,
  });
  return { id: up.body.data.job._id as string, columns: up.body.data.columns, check };
}

async function rows(token: string, id: string, filter = 'all') {
  const res = await request(t.app).get(`/api/v1/imports/${id}/rows?filter=${filter}&limit=100`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.data as Array<{
    rowNo: number;
    check: string;
    result: string;
    issues: Array<{ level: string; message: string }>;
    changes: any[];
  }>;
}

describe('Column matching and value reading', () => {
  it('maps the school’s own export (different names and order) without a template', () => {
    const headers = USER_EXPORT.split('\n')[0].split(',');
    const m = Object.fromEntries(suggestMapping('students', headers).map((c) => [c.header, c.field]));
    expect(m).toEqual({
      SID: 'admissionNo',
      'Student Name': 'fullName',
      'Father/Guard': 'parentName',
      Class: 'className',
      Session: 'sessionName',
      Feeplanlist: null,
      'Mother Mobile': 'motherPhone',
      'Father/Guard Mobile': 'parentPhone',
      DOB: 'dateOfBirth',
      Gender: 'gender',
      Status: 'status',
    });
    const fee = suggestMapping('students', headers).find((c) => c.header === 'Feeplanlist')!;
    expect(fee.ignoredReason).toMatch(/fee structure/i);
    // Other wordings of the same fields.
    const alt = suggestMapping('students', [
      'Student Full Name',
      "Father's Full Name",
      'Grade Name',
      'Group Name',
      'Contact No',
      'Previous School',
    ]);
    expect(alt.map((c) => c.field)).toEqual([
      'fullName',
      'parentName',
      'className',
      'sectionName',
      'parentPhone',
      'previousSchool',
    ]);
    // Remembered choices win over guesses.
    expect(suggestMapping('students', ['Contact No'], { 'contact no': '__ignore' })[0].field).toBeNull();
  });

  it('reads dates, phones and statuses as schools write them, and refuses what it cannot read', () => {
    expect(parseDate('04-Feb-2022')).toMatchObject({ ok: true, value: '2022-02-04' });
    expect(parseDate('12/03/2015')).toMatchObject({ ok: true, value: '2015-03-12' }); // day first
    expect(parseDate('2015-03-12')).toMatchObject({ ok: true, value: '2015-03-12' });
    expect(parseDate('March 5, 2016')).toMatchObject({ ok: true, value: '2016-03-05' });
    expect(parseDate('42370')).toMatchObject({ ok: true, value: '2016-01-01' }); // Excel serial
    expect(parseDate('31/02/2015').ok).toBe(false);
    expect(parseDate('yesterday').ok).toBe(false);
    expect(parsePhone('3293903346')).toMatchObject({ ok: true, value: '03293903346' }); // Excel dropped the 0
    expect(parsePhone('0329-390 3346')).toMatchObject({ ok: true, value: '03293903346' });
    expect(parsePhone('923001234567')).toMatchObject({ ok: true, value: '+923001234567' });
    expect(parsePhone('12ab').ok).toBe(false);
    expect(parseStudentStatus('Currently Enrolled')).toMatchObject({ ok: true, value: 'active' });
    expect(parseStudentStatus('Struck off')).toMatchObject({ ok: true, value: 'left' });
    expect(parseStudentStatus('maybe').ok).toBe(false);
  });
});

describe('Reading files safely', () => {
  it('finds the heading row below a report title, handles semicolons, quotes and line breaks', async () => {
    const csv =
      'Manage Students report\r\n\r\nName;Class;"Notes"\r\n"Ali; Khan";5;"line one\nline two"\r\n;;\r\nSara;6;=1+1\r\n';
    const sheet = await readSpreadsheet(Buffer.from(csv), 'students.csv');
    expect(sheet.headerRow).toBe(3);
    expect(sheet.headers).toEqual(['Name', 'Class', 'Notes']);
    expect(sheet.rows).toEqual([
      { rowNo: 4, values: ['Ali; Khan', '5', 'line one line two'] },
      { rowNo: 6, values: ['Sara', '6', '=1+1'] },
    ]);
  });

  it('refuses old .xls, renamed, damaged, macro and unsupported files by their content', async () => {
    const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(100)]);
    await expect(readSpreadsheet(ole, 'students.xlsx')).rejects.toThrow(/\.xls/);
    await expect(readSpreadsheet(Buffer.from('a,b\n1,2'), 'students.xlsx')).rejects.toThrow(/not a real Excel/);
    await expect(readSpreadsheet(Buffer.from('%PDF-1.4\n\0\0binary'), 'students.csv')).rejects.toThrow(
      /not a text CSV/,
    );
    await expect(readSpreadsheet(Buffer.from('hello'), 'students.pdf')).rejects.toThrow(/Only Excel/);
    await expect(readSpreadsheet(Buffer.alloc(0), 'a.csv')).rejects.toThrow(/empty/);
    // A real workbook carrying a VBA project is refused before it is opened.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').addRow(['Name']);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
    zip.file('xl/vbaProject.bin', 'macro');
    const macro = await zip.generateAsync({ type: 'nodebuffer' });
    expect(inspectZip(macro).some((e) => e.name === 'xl/vbaProject.bin')).toBe(true);
    await expect(readSpreadsheet(macro, 'students.xlsx')).rejects.toThrow(/macros/);
    // Too many rows.
    const big = 'Name\n' + 'x\n'.repeat(5001);
    await expect(readSpreadsheet(Buffer.from(big), 'big.csv')).rejects.toThrow(/more than 5,000 rows/);
  });

  it('API: an unsupported file gets a clear 400 and nothing is created', async () => {
    const before = await ImportJob.countDocuments({ schoolId: s.schoolId });
    const res = await upload(s.ownerToken, 'students', Buffer.from('not a workbook'), 'students.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_UNSUPPORTED_FILE');
    expect(await ImportJob.countDocuments({ schoolId: s.schoolId })).toBe(before);
    const empty = await upload(s.ownerToken, 'students', 'Name,Class\n', 'e.csv');
    expect(empty.body.error.code).toBe('IMPORT_EMPTY');
  });
});

describe('Templates', () => {
  it('Excel template: required columns marked *, instructions sheet, and it maps itself; the example row is skipped', async () => {
    const res = await request(t.app)
      .get('/api/v1/imports/templates/students')
      .set(auth(s.ownerToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const sheet = await readSpreadsheet(res.body, 'template.xlsx');
    expect(sheet.sheetName).toBe('Data');
    expect(sheet.headers).toContain('Student Name *');
    expect(sheet.headers).toContain('Class *');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.getWorksheet('Instructions')).toBeTruthy();
    // Fill in one real row and upload it.
    const data = wb.getWorksheet('Data')!;
    const col = (h: string) => sheet.headers.indexOf(h) + 1;
    const row = data.getRow(3);
    row.getCell(col('Student Name *')).value = 'Template Kid';
    row.getCell(col('Gender *')).value = 'Female';
    row.getCell(col('Class *')).value = 'Class 5';
    row.getCell(col('Section *')).value = 'B';
    row.getCell(col('Date of Birth')).value = new Date(Date.UTC(2016, 4, 9));
    row.getCell(col('Parent Name')).value = 'Template Parent';
    row.getCell(col('Parent Phone')).value = 3001112223; // a number cell: the leading 0 is restored
    row.commit();
    const up = await upload(s.ownerToken, 'students', Buffer.from(await wb.xlsx.writeBuffer()), 'filled.xlsx');
    expect(up.status).toBe(201);
    expect(up.body.data.columns.filter((c: any) => c.field).every((c: any) => c.source === 'exact')).toBe(true);
    const id = up.body.data.job._id;
    const check = await checkAndWait(t.app, s.ownerToken, id, {
      mapping: mappingOf(up.body.data.columns),
    });
    expect(check.summary).toMatchObject({ total: 2, create: 1, exists: 1 });
    const r = await rows(s.ownerToken, id, 'ready');
    expect(r[0].issues.some((i) => /leading 0/.test(i.message))).toBe(true);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.result).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    const kid = await Student.findOne({ schoolId: s.schoolId, firstName: 'Template' }).lean();
    expect(kid?.dateOfBirth?.toISOString().slice(0, 10)).toBe('2016-05-09');
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone: '03001112223' })).toBe(1);
  });

  it('CSV template downloads with the same headings', async () => {
    const res = await request(t.app).get('/api/v1/imports/templates/staff?format=csv').set(auth(s.ownerToken));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Full Name *');
    expect(res.text).toContain('Staff Type *');
  });
});

describe('Importing classes, then the school’s own student export', () => {
  it('classes and sections: creates new ones once, skips existing ones', async () => {
    const { id, check } = await importCsv(
      s.ownerToken,
      'classes',
      'Class,Section,Capacity\nP.G,A,30\nP.G,B,\nClass 5,A,\nP.G,A,\nWeird Class,A,\n',
    );
    expect(check.summary).toMatchObject({ total: 5, create: 2, exists: 1, duplicate: 1, invalid: 1 });
    const bad = (await rows(s.ownerToken, id, 'problems')).find((r) => r.rowNo === 6)!;
    expect(bad.issues[0].message).toMatch(/Level: needed/);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.result).toMatchObject({ created: 2, skipped: 2, failed: 1 });
    const pg = await SchoolClass.find({ schoolId: s.schoolId, name: 'P.G' }).lean();
    expect(pg).toHaveLength(1);
    expect(pg[0].level).toBe(-2);
    expect(await Section.countDocuments({ schoolId: s.schoolId, classId: pg[0]._id })).toBe(2);
  });

  it('the user’s export: unknown session and missing section are explained per row before anything is saved', async () => {
    const { id, check } = await importCsv(s.ownerToken, 'students', USER_EXPORT);
    expect(check.summary).toMatchObject({ total: 1, invalid: 1, ignoredColumns: ['Feeplanlist'] });
    const [row] = await rows(s.ownerToken, id);
    const text = row.issues.map((i) => i.message).join(' | ');
    expect(text).toMatch(/"2025-2026" is not an academic session/);
    expect(await Student.countDocuments({ schoolId: s.schoolId, admissionNo: '664' })).toBe(0);
  });

  it('imports it with a section chosen for all rows; siblings share one parent; problems are listed by row', async () => {
    const csv =
      USER_EXPORT.replace('2025-2026', '2026-2027') +
      // A sibling: same father, phone written differently, no admission number.
      ',Ayesha Bilal,Muhammad Bilal,P.G,2026-2027,,,0329-3903346,12/03/2021,F,Active\n' +
      // Problems: no gender; impossible date; same SID twice; an admission no already in the system.
      '700,No Gender Kid,Some Father,P.G,2026-2027,,,03001234567,2021-01-01,,Active\n' +
      '701,Bad Date Kid,Other Father,P.G,2026-2027,,,03007654321,31/02/2021,Male,Active\n' +
      '664,Same SID Kid,X Father,P.G,2026-2027,,,03009999999,2021-01-01,Male,Active\n' +
      `${(await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean())!.admissionNo},Existing Kid,Y Father,Class 5,2026-2027,,,03008888888,2016-01-01,Male,Active\n`;
    const { id, check } = await importCsv(s.ownerToken, 'students', csv, { sectionName: 'A' });
    expect(check.summary).toMatchObject({ total: 6, create: 2, invalid: 2, duplicate: 1, exists: 1 });
    const all = await rows(s.ownerToken, id);
    const msgs = (n: number) =>
      all
        .find((r) => r.rowNo === n)!
        .issues.map((i) => i.message)
        .join(' | ');
    expect(msgs(2)).toMatch(/Mother Phone: same number as the parent phone/);
    expect(msgs(4)).toMatch(/Gender is required/);
    expect(msgs(5)).toMatch(/"31\/02\/2021" is not a real calendar date/);
    expect(msgs(6)).toMatch(/also appears on row 2/);
    expect(msgs(7)).toMatch(/Already in the system/);
    // Nothing saved before confirmation.
    expect(await Student.countDocuments({ schoolId: s.schoolId, admissionNo: '664' })).toBe(0);
    // Confirmation is required.
    const noConfirm = await request(t.app).post(`/api/v1/imports/${id}/run`).set(auth(s.ownerToken)).send({});
    expect(noConfirm.status).toBe(400);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.result).toMatchObject({ created: 2, skipped: 2, failed: 2 });
    const hamza = await Student.findOne({ schoolId: s.schoolId, admissionNo: '664' }).lean();
    expect(hamza).toMatchObject({ firstName: 'Muhammad Hamza', lastName: 'Bilal', gender: 'male', status: 'active' });
    expect(hamza!.dateOfBirth!.toISOString().slice(0, 10)).toBe('2022-02-04');
    const ayesha = await Student.findOne({ schoolId: s.schoolId, firstName: 'Ayesha', lastName: 'Bilal' }).lean();
    expect(ayesha!.admissionNo).toMatch(/^ADM-/);
    const parents = await Parent.find({ schoolId: s.schoolId, phone: '03293903346' }).lean();
    expect(parents).toHaveLength(1);
    expect(String(hamza!.guardians[0].parentId)).toBe(String(parents[0]._id));
    expect(String(ayesha!.guardians[0].parentId)).toBe(String(parents[0]._id));
    expect(hamza!.guardians[0].relation).toBe('father'); // the column said "Father/Guard"
    // One parent login, not two.
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parents[0]._id })).toBe(1);
    // A finished import cannot run twice.
    const again = await request(t.app)
      .post(`/api/v1/imports/${id}/run`)
      .set(auth(s.ownerToken))
      .send({ confirm: true });
    expect(again.status).toBe(409);
  });

  it('the error report lists rows with their original values and reasons, safe to open in Excel', async () => {
    const csv = 'Student Name,Gender,Class,Section\n"=HYPERLINK(""http://x"")",Male,Nope,A\n';
    const { id } = await importCsv(s.ownerToken, 'students', csv);
    const res = await request(t.app).get(`/api/v1/imports/${id}/report.csv`).set(auth(s.ownerToken));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Row,Outcome,Problems,Student Name,Gender,Class,Section');
    expect(res.text).toMatch(/2,has errors,.*does not exist/);
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`); // formula neutralised
    expect(res.text).not.toMatch(/,=HYPERLINK/);
  });

  it('uploading the same file again finds the students already imported; update mode shows and applies changes', async () => {
    const csv = USER_EXPORT.replace('2025-2026', '2026-2027').replace(
      'Muhammad Hamza Bilal',
      'Muhammad Hamza Bilal Khan',
    );
    const first = await importCsv(s.ownerToken, 'students', csv, { sectionName: 'A' });
    expect(first.check.summary).toMatchObject({ exists: 1, create: 0 });
    const upsert = await importCsv(s.ownerToken, 'students', csv, { sectionName: 'A', mode: 'upsert' });
    expect(upsert.check.summary).toMatchObject({ update: 1 });
    const [r] = await rows(s.ownerToken, upsert.id, 'ready');
    expect(r.changes).toEqual([
      { field: 'First name', from: 'Muhammad Hamza', to: 'Muhammad Hamza Bilal' },
      { field: 'Last name', from: 'Bilal', to: 'Khan' },
    ]);
    await api(t.app, s.ownerToken, 'post', `/imports/${upsert.id}/run`, { confirm: true });
    expect((await waitDone(s.ownerToken, upsert.id)).result).toMatchObject({ updated: 1 });
    expect((await Student.findOne({ schoolId: s.schoolId, admissionNo: '664' }).lean())!.lastName).toBe('Khan');
  });

  it('a required field with no column is refused with the field names', async () => {
    const up = await upload(s.ownerToken, 'students', 'Student Name,Class\nAli,Class 5\n');
    const res = await request(t.app)
      .post(`/api/v1/imports/${up.body.data.job._id}/check`)
      .set(auth(s.ownerToken))
      .send({ mapping: mappingOf(up.body.data.columns) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IMPORT_REQUIRED_COLUMNS');
    expect(res.body.error.message).toMatch(/Gender/);
    // The same field for two columns is refused too.
    const dup = await request(t.app)
      .post(`/api/v1/imports/${up.body.data.job._id}/check`)
      .set(auth(s.ownerToken))
      .send({
        mapping: [
          { column: 0, field: 'fullName' },
          { column: 1, field: 'fullName' },
        ],
      });
    expect(dup.body.error.code).toBe('IMPORT_MAPPING_CONFLICT');
  });
});

describe('Parents and staff', () => {
  it('parents: links existing students by admission number; unknown admission numbers are errors', async () => {
    const admissionNo = (await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean())!.admissionNo;
    const { id, check } = await importCsv(
      s.ownerToken,
      'parents',
      `Name,Phone,Relation,Children\nSana Mother,03115556667,Mother,${admissionNo}\nGhost Parent,03115556668,Father,NOPE-1\n`,
    );
    expect(check.summary).toMatchObject({ create: 1, invalid: 1 });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    await waitDone(s.ownerToken, id);
    const sana = await Parent.findOne({ schoolId: s.schoolId, phone: '03115556667' }).lean();
    const kid = await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean();
    expect(kid!.guardians.some((g) => String(g.parentId) === String(sana!._id) && g.relation === 'mother')).toBe(true);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone: '03115556668' })).toBe(0);
  });

  it('staff: teachers get a pending login; duplicates in the file and existing staff are not added', async () => {
    const { id, check } = await importCsv(
      s.ownerToken,
      'staff',
      'Employee Name,Designation,Type,Mobile,CNIC\nNadia Imported,Teacher,Teacher,03211234567,35202-1111111-1\nNadia Twin,Teacher,Teaching,03211234568,3520211111111\nAkram Clerk,Clerk,Non teaching,,\n',
    );
    expect(check.summary).toMatchObject({ create: 2, duplicate: 1 });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    expect((await waitDone(s.ownerToken, id)).result).toMatchObject({ created: 2 });
    const nadia = await Employee.findOne({ schoolId: s.schoolId, firstName: 'Nadia' }).lean();
    expect(nadia!.employeeNo).toMatch(/^EMP-/);
    const login = await User.findOne({ schoolId: s.schoolId, employeeId: nadia!._id }).lean();
    expect(login).toMatchObject({ role: 'teacher', status: 'pending' });
    expect(
      await User.countDocuments({
        schoolId: s.schoolId,
        employeeId: (await Employee.findOne({ schoolId: s.schoolId, firstName: 'Akram' }).lean())!._id,
      }),
    ).toBe(0);
  });
});

describe('Access, isolation and recovery', () => {
  it('needs the same permission as adding records by hand; other schools never see an import', async () => {
    expect((await upload(s.teacherToken, 'students', USER_EXPORT)).status).toBe(403);
    expect((await upload(s.accountantToken, 'staff', USER_EXPORT)).status).toBe(403);
    const types = await api(t.app, s.teacherToken, 'get', '/imports/types');
    expect(types.find((x: any) => x.type === 'students').allowed).toBe(false);
    const up = await upload(s.ownerToken, 'students', USER_EXPORT);
    const id = up.body.data.job._id;
    expect((await request(t.app).get(`/api/v1/imports/${id}`).set(auth(other.ownerToken))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/imports/${id}/rows`).set(auth(other.ownerToken))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/imports/${id}/report.csv`).set(auth(other.ownerToken))).status).toBe(404);
    const history = await request(t.app).get('/api/v1/imports').set(auth(other.ownerToken));
    expect(history.body.data.every((j: any) => j._id !== id)).toBe(true);
    // Imports into another school are impossible: the school always comes from the login.
    expect(await ImportRow.countDocuments({ schoolId: other.schoolId, jobId: new mongoose.Types.ObjectId(id) })).toBe(
      0,
    );
  });

  it('only one import runs per school at a time', async () => {
    const a = await importCsv(s.ownerToken, 'classes', 'Class,Section\nClass 9,A\n');
    const b = await importCsv(s.ownerToken, 'classes', 'Class,Section\nClass 10,A\n');
    // A live run (recent heartbeat) blocks a second import in the same school.
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: a.id },
      { $set: { status: 'running', runnerId: 'live-run', heartbeatAt: new Date() } },
    );
    const res = await request(t.app)
      .post(`/api/v1/imports/${b.id}/run`)
      .set(auth(s.ownerToken))
      .send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IMPORT_ALREADY_RUNNING');
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: a.id }, { $set: { status: 'validated' } });
  });

  it('an import interrupted by a restart resumes without adding a row twice', async () => {
    const { id } = await importCsv(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section\nResume One,Male,Class 5,A\nResume Two,Female,Class 5,B\n',
    );
    // Simulate a crash right after row 2 was saved: it holds its reserved admission number.
    const jobId = new mongoose.Types.ObjectId(id);
    await api(t.app, s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      sessionId: s.sessionId,
      classId: s.classId,
      sectionId: s.sectionA,
      admissionNo: 'RESUME-1',
      firstName: 'Resume',
      lastName: 'One',
      gender: 'male',
    });
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 2 },
      { $set: { result: 'processing', assignedKey: 'RESUME-1' } },
    );
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: jobId }, { $set: { status: 'running' } });
    await recoverInterruptedImports();
    expect((await api(t.app, s.ownerToken, 'get', `/imports/${id}`)).status).toBe('interrupted');
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.result).toMatchObject({ created: 2, failed: 0 });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Resume', lastName: 'One' })).toBe(1);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Resume', lastName: 'Two' })).toBe(1);
    const r = await rows(s.ownerToken, id);
    expect(r.find((x) => x.rowNo === 2)!.result).toBe('created');
  });

  it('a check that is cancelled removes its rows; history shows the outcome', async () => {
    const up = await upload(s.ownerToken, 'classes', 'Class,Section\nClass 11,A\n');
    const id = up.body.data.job._id;
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/stop`);
    expect(await ImportRow.countDocuments({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id) })).toBe(0);
    const history = await request(t.app).get('/api/v1/imports?limit=50').set(auth(s.ownerToken));
    expect(history.body.data.find((j: any) => j._id === id).status).toBe('cancelled');
  });
});
