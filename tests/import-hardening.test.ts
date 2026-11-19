import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS, type Permission } from '../src/config/permissions';
import { FEATURE_KEYS } from '../src/config/entitlements';
import { Section } from '../src/modules/academics/academics.models';
import { Campus } from '../src/modules/campuses/campus.model';
import { Employee } from '../src/modules/employees/employee.model';
import { inspectZip, preflightXlsx, readSpreadsheet } from '../src/modules/imports/import-files';
import { phoneKey } from '../src/modules/imports/import-values';
import { ImportJob, ImportRow } from '../src/modules/imports/import.models';
import {
  _processJobForTests,
  duplicateKeyMessage,
  recoverInterruptedImports,
  withReadSlot,
} from '../src/modules/imports/imports.service';
import { parentsProcessor } from '../src/modules/imports/processors/parents';
import { DEFAULT_OPTIONS } from '../src/modules/imports/processors/types';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import type { SchoolContext } from '../src/types/context';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createUser, login, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

const t = useTestApp();
let s: SchoolFixture;
let ownerId: string;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  ownerId = String((await User.findOne({ schoolId: s.schoolId, role: 'school_owner' }).lean())!._id);
  // These tests admit many students: lift the fixture's 30-seat sections.
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: 200 } });
});

const ctxFor = (permissions: Iterable<Permission>, extra: Partial<SchoolContext> = {}): SchoolContext => ({
  kind: 'school',
  userId: ownerId,
  schoolId: s.schoolId,
  role: 'school_owner',
  name: 'Owner',
  email: 'owner@example.test',
  campusIds: [],
  permissions: new Set(permissions),
  entitlements: new Set(FEATURE_KEYS),
  subscriptionEligible: true,
  ...extra,
});

const upload = async (token: string, type: string, content: string | Buffer, name = 'f.csv') => {
  const res = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', type)
    .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  // Rows are prepared in the background: wait like the import screen does.
  if (res.status === 201) await waitStaged(t.app, token, res.body.data.job._id);
  return res;
};

async function check(token: string, type: string, csv: string, options: Record<string, unknown> = {}) {
  const up = await upload(token, type, csv);
  expect(up.status).toBe(201);
  const id = up.body.data.job._id as string;
  const res = await checkAndWait(t.app, token, id, {
    mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field })),
    options,
  });
  return { id, summary: res.summary, columns: up.body.data.columns };
}

async function waitDone(token: string, id: string) {
  for (let i = 0; i < 400; i++) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('import did not finish');
}

async function run(token: string, type: string, csv: string, options: Record<string, unknown> = {}) {
  const c = await check(token, type, csv, options);
  await api(t.app, token, 'post', `/imports/${c.id}/run`, { confirm: true });
  return { ...c, job: await waitDone(token, c.id) };
}

async function rows(token: string, id: string) {
  const res = await request(t.app).get(`/api/v1/imports/${id}/rows?limit=100`).set(auth(token));
  return res.body.data as Array<{
    rowNo: number;
    check: string;
    result: string;
    issues: Array<{ level: string; message: string }>;
  }>;
}
const messages = (r: { issues: Array<{ message: string }> }) => r.issues.map((i) => i.message).join(' | ');

async function admit(firstName: string, lastName: string, extra: Record<string, unknown> = {}) {
  return api(t.app, s.ownerToken, 'post', '/students', {
    campusId: s.campusId,
    sessionId: s.sessionId,
    classId: s.classId,
    sectionId: s.sectionA,
    firstName,
    lastName,
    gender: 'male',
    ...extra,
  });
}

// ───────────────────────────── C1 ─────────────────────────────
describe('C1: the same phone in different formats is one parent (and one login)', () => {
  it('the phone key treats 03…, +92…, 92…, 0092… and dashed forms as one number', () => {
    const k = phoneKey('03007770001');
    for (const v of ['+923007770001', '923007770001', '00923007770001', '0300-777 0001', '(0300) 7770001'])
      expect(phoneKey(v)).toBe(k);
    expect(phoneKey('03007770002')).not.toBe(k);
    expect(phoneKey('042-35761234')).toBe('04235761234'); // landlines compare by digits
  });

  it('an existing parent stored as +92… is reused by every format in the file', async () => {
    await admit('Manual', 'Child', {
      guardians: [{ parent: { name: 'Same Father', phone: '+923007770001' }, relation: 'father', isPrimary: true }],
    });
    const { job, id } = await run(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section,Father Name,Father Mobile,Mother Name,Mother Mobile\n' +
        'Format One,Male,Class 5,A,Same Father,03007770001,,\n' +
        'Format Two,Female,Class 5,A,Same Father,0300-777 0001,,\n' +
        'Format Three,Male,Class 5,B,Same Father,923007770001,Same Mother,+923007770001\n',
    );
    expect(job.result).toMatchObject({ created: 3, failed: 0 });
    const parents = await Parent.find({ schoolId: s.schoolId, name: { $in: ['Same Father', 'Same Mother'] } }).lean();
    expect(parents).toHaveLength(1);
    expect(parents[0].phone).toBe('+923007770001'); // the stored number is not rewritten
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: parents[0]._id })).toBe(1);
    const kids = await Student.find({ schoolId: s.schoolId, firstName: 'Format' }).lean();
    expect(kids).toHaveLength(3);
    for (const k of kids) {
      expect(k.guardians).toHaveLength(1); // the mother's number was the father's: not added twice
      expect(String(k.guardians[0].parentId)).toBe(String(parents[0]._id));
    }
    const r3 = (await rows(s.ownerToken, id)).find((r) => r.rowNo === 4)!;
    expect(messages(r3)).toMatch(/same number as the parent phone/);
  });

  it('a new parent written two ways in one file becomes one record with the first spelling', async () => {
    const { job } = await run(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section,Father Name,Father Mobile\nNew One,Male,Class 5,A,New Father,03117770002\nNew Two,Male,Class 5,A,New Father,+92 311 7770002\n',
    );
    expect(job.result).toMatchObject({ created: 2 });
    const p = await Parent.find({ schoolId: s.schoolId, name: 'New Father' }).lean();
    expect(p.map((x) => x.phone)).toEqual(['03117770002']);
    expect(await User.countDocuments({ schoolId: s.schoolId, parentId: p[0]._id })).toBe(1);
  });

  it('several existing parents with one number: a single name match is used, otherwise the row needs review', async () => {
    await Parent.create([
      { schoolId: s.schoolId, name: 'Shared Uncle', phone: '03227770003' },
      { schoolId: s.schoolId, name: 'Shared Aunt', phone: '+923227770003' },
    ]);
    const { id, summary } = await check(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section,Guardian Name,Guardian Phone\nKid Uncle,Male,Class 5,A,Shared Uncle,03227770003\nKid Unknown,Male,Class 5,A,Somebody Else,03227770003\n',
    );
    expect(summary).toMatchObject({ create: 1, invalid: 1 });
    const r = await rows(s.ownerToken, id);
    expect(messages(r.find((x) => x.rowNo === 3)!)).toMatch(/2 parents in the system have this phone number/);
  });
});

// ───────────────────────────── C2 ─────────────────────────────
describe('C2: students already in the system are recognised even with another admission number', () => {
  it('same name and date of birth under a different admission number is skipped by default', async () => {
    await admit('Ali', 'Raza', { dateOfBirth: '2015-01-01' });
    const csv = 'SID,Student Name,Gender,Class,Section,DOB\nOLD-77,Ali Raza,Male,Class 5,A,2015-01-01\n';
    const first = await check(s.ownerToken, 'students', csv);
    expect(first.summary).toMatchObject({ duplicate: 1, create: 0 });
    expect(messages((await rows(s.ownerToken, first.id))[0])).toMatch(
      /Likely already in the system: Ali Raza \(ADM-\d+\) has the same name and date of birth; skipped/,
    );
    // Update mode never updates an uncertain match.
    const upsert = await check(s.ownerToken, 'students', csv, { mode: 'upsert' });
    expect(upsert.summary).toMatchObject({ duplicate: 1, update: 0 });
    // Import anyway, explicitly.
    const anyway = await run(s.ownerToken, 'students', csv, { skipPossibleDuplicates: false });
    expect(anyway.job.result).toMatchObject({ created: 1 });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Ali', lastName: 'Raza' })).toBe(2);
  });

  it('same name and a parent phone in another format is a likely duplicate', async () => {
    await admit('Sana', 'Phone', {
      guardians: [{ parent: { name: 'Phone Dad', phone: '+923337770004' }, relation: 'father', isPrimary: true }],
    });
    const { summary } = await check(
      s.ownerToken,
      'students',
      'Admission No,Student Name,Gender,Class,Section,Father Name,Father Mobile\nX-9,Sana Phone,Female,Class 5,A,Phone Dad,0333-7770004\n',
    );
    expect(summary).toMatchObject({ duplicate: 1 });
  });

  it('leading zeros: 123 = 00123 with the same name is a duplicate; with another name it needs review', async () => {
    await admit('Zero', 'Padded', { admissionNo: '00123' });
    const same = await check(
      s.ownerToken,
      'students',
      'Admission No,Student Name,Gender,Class,Section\n123,Zero Padded,Male,Class 5,A\n',
    );
    expect(same.summary).toMatchObject({ duplicate: 1 });
    expect(messages((await rows(s.ownerToken, same.id))[0])).toMatch(/same admission number apart from leading zeros/);
    const other = await check(
      s.ownerToken,
      'students',
      'Admission No,Student Name,Gender,Class,Section\n123,Different Kid,Male,Class 5,A\n',
    );
    expect(other.summary).toMatchObject({ invalid: 1 });
    expect(messages((await rows(s.ownerToken, other.id))[0])).toMatch(
      /matches 00123 in the system apart from leading zeros/,
    );
    // Even "import anyway" never creates the conflicting number.
    const forced = await check(
      s.ownerToken,
      'students',
      'Admission No,Student Name,Gender,Class,Section\n123,Different Kid,Male,Class 5,A\n',
      {
        skipPossibleDuplicates: false,
      },
    );
    expect(forced.summary).toMatchObject({ invalid: 1 });
  });

  it('the same student twice in one file (same name and date of birth) is reported against the first row', async () => {
    const { summary, id } = await check(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section,DOB\nTwin Check,Male,Class 5,A,2016-02-02\nTwin Check,Male,Class 5,A,2016-02-02\n',
    );
    expect(summary).toMatchObject({ create: 1, duplicate: 1 });
    expect(messages((await rows(s.ownerToken, id)).find((r) => r.rowNo === 3)!)).toMatch(/same student as row 2/);
  });
});

// ───────────────────────────── C3 ─────────────────────────────
describe('C3: oversized and malicious workbooks are refused before the parser loads them', () => {
  // ExcelJS's internal reader (the same module instance the library uses), to prove it is never called.
  const XLSX_MODULE = 'exceljs/lib/xlsx/xlsx.js';
  let XLSX: { prototype: { load: (...a: unknown[]) => unknown } };
  beforeAll(async () => {
    XLSX = ((await import(XLSX_MODULE)) as { default: typeof XLSX }).default;
  });
  afterEach(() => vi.restoreAllMocks());

  async function minimalXlsx(sheetXml: string) {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    );
    zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook/>');
    zip.file('xl/worksheets/sheet1.xml', sheetXml);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('control: the spy sees the parser when a valid workbook is read', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data').addRow(['Name', 'Class']);
    wb.getWorksheet('Data')!.addRow(['Ali', 'Class 5']);
    const load = vi.spyOn(XLSX.prototype, 'load');
    const sheet = await readSpreadsheet(Buffer.from(await wb.xlsx.writeBuffer()), 'ok.xlsx');
    expect(sheet.rows).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('too many rows: refused from the XML count, the workbook is never parsed', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    for (let i = 0; i < 6000; i++) ws.addRow(['x']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const load = vi.spyOn(XLSX.prototype, 'load');
    await expect(readSpreadsheet(buf, 'big.xlsx')).rejects.toThrow(/more than 5,000 rows/);
    expect(load).not.toHaveBeenCalled();
  });

  it('too many cells in few rows: refused before parsing', async () => {
    const cells = '<c r="A1"><v>1</v></c>'.repeat(260_000);
    const buf = await minimalXlsx(`<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`);
    expect(buf.length).toBeLessThan(5 * 1024 * 1024);
    const load = vi.spyOn(XLSX.prototype, 'load');
    await expect(readSpreadsheet(buf, 'wide.xlsx')).rejects.toThrow(/more than 250,000 filled cells/);
    expect(load).not.toHaveBeenCalled();
  });

  it('a decompression bomb is refused by its declared size, and by the hard cap when it lies about it', async () => {
    const huge = `<worksheet><sheetData>${' '.repeat(40 * 1024 * 1024)}</sheetData></worksheet>`;
    const honest = await minimalXlsx(huge);
    expect(honest.length).toBeLessThan(1024 * 1024);
    await expect(readSpreadsheet(honest, 'bomb.xlsx')).rejects.toThrow(/unsafe size/);
    // The same file with its size fields forged to look tiny: decompression stops at the cap.
    const forged = Buffer.from(honest);
    const eocd = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let p = forged.readUInt32LE(eocd + 16);
    for (let i = 0; i < forged.readUInt16LE(eocd + 10); i++) {
      forged.writeUInt32LE(100, p + 24); // uncompressed size in the central directory
      p += 46 + forged.readUInt16LE(p + 28) + forged.readUInt16LE(p + 30) + forged.readUInt16LE(p + 32);
    }
    expect(inspectZip(forged).every((e) => e.size === 100)).toBe(true);
    expect(() => preflightXlsx(forged)).toThrow(/unsafe size/);
  });

  it('at most two files are read at once per process', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = withReadSlot(() => gate);
    const b = withReadSlot(() => gate);
    await expect(withReadSlot(async () => 'third')).rejects.toMatchObject({ status: 429, code: 'IMPORT_BUSY' });
    release();
    await Promise.all([a, b]);
    await expect(withReadSlot(async () => 'after')).resolves.toBe('after');
  });

  it('uploads are rate limited per user (20 per 15 minutes)', async () => {
    const user = await createUser(s.schoolId, 'principal');
    const token = await login(t.app, user.email, undefined, s.code);
    process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await upload(token, 'classes', 'Class,Section\nRL,A\n')).status);
      expect(statuses.slice(0, 20).every((x) => x === 201)).toBe(true);
      expect(statuses[20]).toBe(429);
      // Another user is not affected.
      expect((await upload(s.ownerToken, 'classes', 'Class,Section\nRL,A\n')).status).toBe(201);
    } finally {
      delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
    }
  });
});

// ───────────────────────────── H1 / M1 ─────────────────────────────
describe('H1 and M1: imports are visible to their uploader or all-campus users; reports hold only imported columns', () => {
  it('a principal limited to another campus cannot see, read, run, stop or download someone else’s import', async () => {
    const { id } = await check(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section,Father Name,Father Mobile,Medical Notes\nPrivate Kid,Female,Class 5,A,Private Father,03110000001,Asthma\n',
    );
    const campusB = await Campus.create({ schoolId: s.schoolId, name: 'Campus B', code: 'CB' });
    const limited = await createUser(s.schoolId, 'principal', { campusIds: [String(campusB._id)] });
    const token = await login(t.app, limited.email, undefined, s.code);
    const list = await request(t.app).get('/api/v1/imports').set(auth(token));
    expect(list.body.data.some((j: any) => j._id === id)).toBe(false);
    for (const [method, url, body] of [
      ['get', `/api/v1/imports/${id}`],
      ['get', `/api/v1/imports/${id}/rows`],
      ['get', `/api/v1/imports/${id}/report.csv?all=true`],
      ['post', `/api/v1/imports/${id}/check`, { mapping: [] }],
      ['post', `/api/v1/imports/${id}/run`, { confirm: true }],
      ['post', `/api/v1/imports/${id}/stop`, {}],
    ] as const) {
      const res = await (request(t.app) as any)[method](url).set(auth(token)).send(body);
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    // Their own import: visible to them and to all-campus staff, not to another limited user.
    const own = await upload(token, 'classes', 'Class,Section\nOwn,A\n');
    const ownId = own.body.data.job._id;
    expect((await request(t.app).get(`/api/v1/imports/${ownId}`).set(auth(token))).status).toBe(200);
    expect((await request(t.app).get(`/api/v1/imports/${ownId}`).set(auth(s.ownerToken))).status).toBe(200);
    const other = await createUser(s.schoolId, 'principal', { campusIds: [String(campusB._id)] });
    const otherToken = await login(t.app, other.email, undefined, s.code);
    expect((await request(t.app).get(`/api/v1/imports/${ownId}`).set(auth(otherToken))).status).toBe(404);
    // Back to one campus for the other tests in this file.
    await Campus.deleteOne({ schoolId: s.schoolId, _id: campusB._id });
  });

  it('the error report contains only the imported columns; ignored columns are blanked when the import ends', async () => {
    const csv =
      'Student Name,Gender,Class,Section,Medical Notes,CNIC of neighbour\nReport Kid,Male,Class 5,A,Asthma,35202-1111111-9\nBad Kid,Male,Nope,A,Diabetes,35202-2222222-9\n';
    const up = await upload(s.ownerToken, 'students', csv);
    const id = up.body.data.job._id;
    // Map only the four known fields; the other two columns are not imported.
    await checkAndWait(t.app, s.ownerToken, id, {
      mapping: up.body.data.columns.map((c: any) => ({ column: c.column, field: c.column < 4 ? c.field : null })),
    });
    const report = await request(t.app).get(`/api/v1/imports/${id}/report.csv?all=true`).set(auth(s.ownerToken));
    expect(report.text.split(/\r?\n/)[0]).toBe('﻿Row,Outcome,Problems,Student Name,Gender,Class,Section');
    expect(report.text).not.toMatch(/Asthma|Diabetes|35202/);
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    await waitDone(s.ownerToken, id);
    const stored = await ImportRow.find({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(id) }).lean();
    for (const r of stored) {
      expect(r.values[4]).toBe('');
      expect(r.values[5]).toBe('');
      expect(r.values[0]).not.toBe('');
    }
  });
});

// ───────────────────────────── H2 ─────────────────────────────
describe('H2: runs hold a lease and rows are claimed atomically', () => {
  const csv = (prefix: string, n: number) =>
    'Student Name,Gender,Class,Section\n' +
    Array.from({ length: n }, (_, i) => `${prefix} Kid${i},Male,Class 5,${i % 2 ? 'A' : 'B'}`).join('\n') +
    '\n';

  it('a second process cannot run an import whose lease another run holds', async () => {
    const { id } = await check(s.ownerToken, 'students', csv('Lease', 20));
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    // A rogue loop (another process) with its own id: it must do nothing.
    await _processJobForTests(ctxFor(ROLE_PERMISSIONS.school_owner), id, 'rogue-runner');
    const job = await waitDone(s.ownerToken, id);
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ created: 20, failed: 0 });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Lease' })).toBe(20);
    expect(
      await ImportRow.countDocuments({
        schoolId: s.schoolId,
        jobId: new mongoose.Types.ObjectId(id),
        claimedBy: 'rogue-runner',
      }),
    ).toBe(0);
  });

  it('two loops that both think they own the import never save a row twice', async () => {
    const { id } = await check(s.ownerToken, 'students', csv('Twinloop', 24));
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id },
      { $set: { status: 'running', runnerId: 'same', heartbeatAt: new Date() } },
    );
    const ctx = ctxFor(ROLE_PERMISSIONS.school_owner);
    await Promise.all([_processJobForTests(ctx, id, 'same'), _processJobForTests(ctx, id, 'same')]);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Twinloop' })).toBe(24);
    const r = await rows(s.ownerToken, id);
    expect(r.filter((x) => x.result === 'created')).toHaveLength(24);
  });

  it('startup recovery leaves a live run alone and takes over only a stalled one', async () => {
    const live = await check(s.ownerToken, 'classes', 'Class,Section\nClass 13,A\n');
    const stalled = await check(s.ownerToken, 'classes', 'Class,Section\nClass 14,A\n');
    // (A school can only have one running import, so the two cases are checked in turn.)
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: live.id },
      { $set: { status: 'running', runnerId: 'x', heartbeatAt: new Date() } },
    );
    await recoverInterruptedImports();
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: live.id }).lean())!.status).toBe('running');
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: live.id }, { $set: { status: 'validated' } });
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: stalled.id },
      { $set: { status: 'running', runnerId: 'y', heartbeatAt: new Date(Date.now() - 10 * 60_000) } },
    );
    await recoverInterruptedImports();
    expect((await ImportJob.findOne({ schoolId: s.schoolId, _id: stalled.id }).lean())!.status).toBe('interrupted');
    const view = await api(t.app, s.ownerToken, 'get', `/imports/${stalled.id}`);
    expect(view).toMatchObject({ status: 'interrupted', canResume: true });
    await api(t.app, s.ownerToken, 'post', `/imports/${stalled.id}/run`, { confirm: true });
    expect((await waitDone(s.ownerToken, stalled.id)).result).toMatchObject({ created: 1 });
  });

  it('a stalled run (no heartbeat for minutes) is shown as interrupted and can be resumed without duplicates', async () => {
    const { id } = await check(
      s.ownerToken,
      'students',
      'Student Name,Gender,Class,Section\nStall One,Male,Class 5,A\nStall Two,Female,Class 5,B\n',
    );
    const jobId = new mongoose.Types.ObjectId(id);
    // The dead run had saved row 2 under a reserved number, and was mid-way on row 3.
    await admit('Stall', 'One', { admissionNo: 'STALL-1' });
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 2 },
      {
        $set: {
          result: 'processing',
          check: 'create',
          assignedKey: 'STALL-1',
          claimedBy: 'dead',
          claimedAt: new Date(Date.now() - 30 * 60_000),
        },
      },
    );
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 3 },
      {
        $set: {
          result: 'processing',
          check: 'create',
          claimedBy: 'dead',
          claimedAt: new Date(Date.now() - 30 * 60_000),
        },
      },
    );
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: jobId },
      { $set: { status: 'running', runnerId: 'dead', heartbeatAt: new Date(Date.now() - 30 * 60_000) } },
    );
    expect(await api(t.app, s.ownerToken, 'get', `/imports/${id}`)).toMatchObject({
      status: 'interrupted',
      canResume: true,
    });
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.result).toMatchObject({ created: 2, failed: 0 });
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Stall', lastName: 'One' })).toBe(1);
    expect(await Student.countDocuments({ schoolId: s.schoolId, firstName: 'Stall', lastName: 'Two' })).toBe(1);
  });

  it('a row another run claimed moments ago is left alone and the import stays resumable', async () => {
    const { id } = await check(s.ownerToken, 'classes', 'Class,Section\nClass 16,A\nClass 16,B\n');
    const jobId = new mongoose.Types.ObjectId(id);
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 3 },
      { $set: { result: 'processing', check: 'create', claimedBy: 'busy', claimedAt: new Date() } },
    );
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const first = await waitDone(s.ownerToken, id);
    expect(first.status).toBe('interrupted');
    expect(first.error).toMatch(/1 row\(s\) were still being saved/);
    // Later (the other claim is old): resuming finishes it.
    await ImportRow.updateOne(
      { schoolId: s.schoolId, jobId, rowNo: 3 },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } },
    );
    await api(t.app, s.ownerToken, 'post', `/imports/${id}/run`, { confirm: true });
    const done = await waitDone(s.ownerToken, id);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ created: 2 });
  });
});

// ───────────────────────────── H4 ─────────────────────────────
describe('H4: linking children needs permission to edit students and respects the four-guardian limit', () => {
  it('without students:manage, child links are refused per row', async () => {
    const kid = await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean();
    const ctx = ctxFor(['parents:manage', 'parents:read'], { role: 'staff' });
    const { rows: plans } = await parentsProcessor.plan(
      ctx,
      [{ rowNo: 2, cells: { name: 'Link Tester', phone: '03128880001', childAdmissionNos: kid!.admissionNo } }],
      DEFAULT_OPTIONS,
    );
    expect(plans[0].check).toBe('invalid');
    expect(plans[0].issues.map((i) => i.message).join(' ')).toMatch(/needs permission to edit students/);
    // Without children the same user can add the parent.
    const plain = await parentsProcessor.plan(
      ctx,
      [{ rowNo: 2, cells: { name: 'Link Tester', phone: '03128880001' } }],
      DEFAULT_OPTIONS,
    );
    expect(plain.rows[0].check).toBe('create');
  });

  it('a student with four guardians gets no fifth, at check time and when saving', async () => {
    const st = await admit('Four', 'Guardians');
    const ids = await Parent.create(
      [1, 2, 3, 4].map((i) => ({ schoolId: s.schoolId, name: `G${i} Parent`, phone: `0312000000${i}` })),
    );
    await Student.updateOne(
      { schoolId: s.schoolId, _id: st._id },
      { $set: { guardians: ids.map((p, i) => ({ parentId: p._id, relation: 'guardian', isPrimary: i === 0 })) } },
    );
    const { summary, id } = await check(
      s.ownerToken,
      'parents',
      `Name,Phone,Children\nFifth Parent,03129990005,${st.admissionNo}\n`,
    );
    expect(summary).toMatchObject({ invalid: 1 });
    expect(messages((await rows(s.ownerToken, id))[0])).toMatch(/already has 4 parents or guardians/);
    // Two rows each adding one guardian to a student with three: only the first fits.
    const st2 = await admit('Three', 'Guardians');
    await Student.updateOne(
      { schoolId: s.schoolId, _id: st2._id },
      {
        $set: {
          guardians: ids.slice(0, 3).map((p, i) => ({ parentId: p._id, relation: 'guardian', isPrimary: i === 0 })),
        },
      },
    );
    const two = await check(
      s.ownerToken,
      'parents',
      `Name,Phone,Children\nFourth A,03129990006,${st2.admissionNo}\nFourth B,03129990007,${st2.admissionNo}\n`,
    );
    expect(two.summary).toMatchObject({ create: 1, invalid: 1 });
  });
});

// ───────────────────────────── M2 / M3 / M4 / M5 ─────────────────────────────
describe('M2–M5', () => {
  it('M2: staff with the same name and phone (any format) are likely duplicates; import anyway is explicit', async () => {
    await Employee.create({
      schoolId: s.schoolId,
      campusId: s.campusId,
      employeeNo: 'EMP-7001',
      firstName: 'Nadia',
      lastName: 'Khan',
      phone: '+923211234567',
      designation: 'Teacher',
      staffType: 'teaching',
    });
    const csv = 'Full Name,Designation,Staff Type,Phone\nNadia Khan,Teacher,Teaching,0321-1234567\n';
    const skipped = await check(s.ownerToken, 'staff', csv);
    expect(skipped.summary).toMatchObject({ duplicate: 1, create: 0 });
    expect(messages((await rows(s.ownerToken, skipped.id))[0])).toMatch(
      /Likely already in the system: Nadia Khan \(EMP-7001\) has the same name and phone/,
    );
    const anyway = await check(s.ownerToken, 'staff', csv, { skipPossibleDuplicates: false });
    expect(anyway.summary).toMatchObject({ create: 1 });
  });

  it('M3: student rows are checked with the admission form schema (e.g. last name length)', async () => {
    const longLast = 'X'.repeat(70);
    const { summary, id } = await check(
      s.ownerToken,
      'students',
      `Student Name,Gender,Class,Section\nShort ${longLast},Male,Class 5,A\n`,
    );
    expect(summary).toMatchObject({ invalid: 1 });
    expect(messages((await rows(s.ownerToken, id))[0])).toMatch(/Student name \(last word\)/);
  });

  it('M4: a duplicate-key clash gets a clear, actionable message', () => {
    const msg = duplicateKeyMessage({
      code: 11000,
      keyPattern: { schoolId: 1, admissionNo: 1 },
      keyValue: { schoolId: 'x', admissionNo: 'ADM-00042' },
    });
    expect(msg).toBe(
      'Not saved: a record with the same admission number (ADM-00042) already exists. It may have been added while the import was running; check the existing record or change this row and import it again.',
    );
    expect(
      duplicateKeyMessage({
        cause: { code: 11000, keyPattern: { schoolId: 1, employeeNo: 1 }, keyValue: { employeeNo: 'EMP-1' } },
        code: undefined,
      }),
    ).toMatch(/same employee number \(EMP-1\)/);
  });

  it('M5: an import whose rows expired cannot be resumed and says what to do; starting a run extends the rows’ lifetime', async () => {
    const { id } = await check(s.ownerToken, 'classes', 'Class,Section\nClass 17,A\n');
    await ImportJob.updateOne(
      { schoolId: s.schoolId, _id: id },
      { $set: { status: 'interrupted', rowsExpireAt: new Date(Date.now() - 60_000) } },
    );
    expect(await api(t.app, s.ownerToken, 'get', `/imports/${id}`)).toMatchObject({
      canResume: false,
      rowsAvailable: false,
    });
    const res = await request(t.app).post(`/api/v1/imports/${id}/run`).set(auth(s.ownerToken)).send({ confirm: true });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('IMPORT_EXPIRED');
    expect(res.body.error.message).toMatch(
      /Upload the file again: rows already in the system are recognised and skipped/,
    );
    // Close to expiry: starting extends the job and its rows by at least two days.
    const near = await check(s.ownerToken, 'classes', 'Class,Section\nClass 18,A\n');
    const soon = new Date(Date.now() + 60 * 60_000);
    await ImportJob.updateOne({ schoolId: s.schoolId, _id: near.id }, { $set: { rowsExpireAt: soon } });
    await ImportRow.updateMany(
      { schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(near.id) },
      { $set: { expiresAt: soon } },
    );
    await api(t.app, s.ownerToken, 'post', `/imports/${near.id}/run`, { confirm: true });
    await waitDone(s.ownerToken, near.id);
    const row = await ImportRow.findOne({ schoolId: s.schoolId, jobId: new mongoose.Types.ObjectId(near.id) }).lean();
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000);
  });
});
