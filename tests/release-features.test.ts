import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model';
import { StaffAttendance } from '../src/modules/biometric/biometric.models';
import { parseHHmm, parseStatus } from '../src/modules/biometric/attendance-upload';
import { Invoice } from '../src/modules/fees/fees.models';
import { School } from '../src/modules/schools/school.model';
import { Student } from '../src/modules/students/student.models';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, createTestSchool, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
const today = todayInTz('Asia/Karachi');
const iso = (d: Date) => formatDateOnly(d);
/** The most recent past weekday (1 = Monday … 7 = Sunday), at least one day ago. */
function lastWeekday(dow: number) {
  let d = addDays(parseDateOnly(today), -1);
  while (((d.getUTCDay() + 6) % 7) + 1 !== dow) d = addDays(d, -1);
  return iso(d);
}
const monday = lastWeekday(1);
const sunday = lastWeekday(7);
const thisPeriod = today.slice(0, 7);

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const get = (token: string, url: string) =>
  request(t.app).get(`/api/v1${url}`).set(auth(token)).buffer(true).parse(binary);
const pdfPages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
async function sheets(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}
const headerOf = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1);

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 4 });
});

describe('own monthly fee: set, change, remove', () => {
  it('sets an own fee that the next invoices use, records why, and can remove it', async () => {
    const id = s.students[0];
    const set = await api(t.app, s.accountantToken, 'put', `/fees/students/${id}/own-fee`, {
      feeHeadId: s.tuitionHeadId,
      amount: 3200,
      reason: 'Sibling discount agreed with the owner',
    });
    expect(set).toMatchObject({ from: null, to: 3200 });
    const changed = await api(t.app, s.accountantToken, 'put', `/fees/students/${id}/own-fee`, {
      feeHeadId: s.tuitionHeadId,
      amount: 3500,
      reason: 'Corrected',
    });
    expect(changed).toMatchObject({ from: 3200, to: 3500 });
    const ledger = await api(t.app, s.ownerToken, 'get', `/fees/students/${id}/ledger`);
    expect(ledger.ownFees).toEqual([expect.objectContaining({ amount: 3500, source: 'manual' })]);
    const events = await AuditLog.find({ schoolId: s.schoolId, action: 'fees.own_fee_set' }).lean();
    expect(events.some((e) => (e.metadata as any)?.reason === 'Corrected')).toBe(true);

    await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', { period: thisPeriod, studentIds: [id] });
    const inv = await Invoice.findOne({ schoolId: s.schoolId, studentId: id, period: thisPeriod }).lean();
    expect(inv!.items.find((i) => i.name === 'Tuition Fee')!.amount).toBe(3500);

    const removed = await api(t.app, s.ownerToken, 'put', `/fees/students/${id}/own-fee`, {
      feeHeadId: s.tuitionHeadId,
      amount: null,
      reason: 'Back to the class fee',
    });
    expect(removed).toMatchObject({ from: 3500, to: null });
    expect((await Student.findOne({ schoolId: s.schoolId, _id: id }).lean())!.customFees).toEqual([]);
  });

  it('only monthly fee heads, only with fees:manage, and a reason is required', async () => {
    const heads = await api(t.app, s.ownerToken, 'get', '/fees/heads?limit=50');
    const oneTime = (heads.items ?? heads).find((h: any) => h.frequency === 'one_time');
    const bad = await request(t.app)
      .put(`/api/v1/fees/students/${s.students[1]}/own-fee`)
      .set(auth(s.ownerToken))
      .send({ feeHeadId: oneTime._id, amount: 100, reason: 'test' });
    expect(bad.status).toBe(400);
    const teacher = await request(t.app)
      .put(`/api/v1/fees/students/${s.students[1]}/own-fee`)
      .set(auth(s.teacherToken))
      .send({ feeHeadId: s.tuitionHeadId, amount: 100, reason: 'test' });
    expect(teacher.status).toBe(403);
    const noReason = await request(t.app)
      .put(`/api/v1/fees/students/${s.students[1]}/own-fee`)
      .set(auth(s.ownerToken))
      .send({ feeHeadId: s.tuitionHeadId, amount: 100, reason: '' });
    expect(noReason.status).toBe(400);
  });
});

describe('print the challans of a class or section in one PDF', () => {
  it('one page per open challan, filtered by section; paid ones only when asked; nothing → 404', async () => {
    await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', { period: thisPeriod });
    const all = await Invoice.find({ schoolId: s.schoolId, period: thisPeriod, kind: 'regular' }).lean();
    expect(all.length).toBe(4);
    const cls = await get(s.ownerToken, `/fees/challans.pdf?period=${thisPeriod}&classId=${s.classId}`);
    expect(cls.status).toBe(200);
    expect(cls.headers['content-type']).toContain('application/pdf');
    expect(pdfPages(cls.body)).toBe(4);
    const sec = await get(s.ownerToken, `/fees/challans.pdf?period=${thisPeriod}&sectionId=${s.sectionA}`);
    expect(pdfPages(sec.body)).toBe(2);

    // Pay one in full: left out of "open", included with include=all.
    const paidInv = all[0];
    await api(t.app, s.ownerToken, 'post', `/fees/invoices/${paidInv._id}/payments`, {
      amount: paidInv.balance,
      method: 'cash',
    });
    expect(
      pdfPages((await get(s.ownerToken, `/fees/challans.pdf?period=${thisPeriod}&classId=${s.classId}`)).body),
    ).toBe(3);
    expect(
      pdfPages(
        (await get(s.ownerToken, `/fees/challans.pdf?period=${thisPeriod}&classId=${s.classId}&include=all`)).body,
      ),
    ).toBe(4);

    const none = await get(s.ownerToken, `/fees/challans.pdf?period=2020-01`);
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body.toString()).error.code).toBe('NO_CHALLANS');
    const parent = await get(s.parentToken, `/fees/challans.pdf?period=${thisPeriod}`);
    expect(parent.status).toBe(403);
  });
});

describe('school days', () => {
  it('defaults to Monday–Saturday; attendance and timetable refuse off days', async () => {
    const fresh = await createTestSchool(t.app);
    const settings = await api(t.app, fresh.ownerToken, 'get', '/school/settings');
    expect(settings.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { workingDays: [1, 2, 3, 4, 5, 6] });

    const sundayMark = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, date: sunday, records: [{ studentId: s.students[0], status: 'present' }] });
    expect(sundayMark.status).toBe(422);
    expect(sundayMark.body.error.code).toBe('SCHOOL_CLOSED');
    const mondayMark = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(s.ownerToken))
      .send({ sectionId: s.sectionA, date: monday, records: [{ studentId: s.students[0], status: 'present' }] });
    expect(mondayMark.status).toBeLessThan(300);

    const lesson = { sectionId: s.sectionA, subjectId: s.mathId, dayOfWeek: 7, startTime: '08:00', endTime: '08:40' };
    const sundayLesson = await request(t.app).post('/api/v1/timetable').set(auth(s.ownerToken)).send(lesson);
    expect(sundayLesson.status).toBe(422);
    expect(sundayLesson.body.error.code).toBe('SCHOOL_CLOSED');

    // A Monday-to-Friday school: Saturday becomes an off day; Sunday a school day.
    const updated = await api(t.app, s.ownerToken, 'patch', '/school/settings', { workingDays: [1, 2, 3, 4, 5, 7] });
    expect(updated.workingDays).toEqual([1, 2, 3, 4, 5, 7]);
    expect((await request(t.app).post('/api/v1/timetable').set(auth(s.ownerToken)).send(lesson)).status).toBe(201);
    const dup = await request(t.app)
      .patch('/api/v1/school/settings')
      .set(auth(s.ownerToken))
      .send({ workingDays: [1, 1] });
    expect(dup.status).toBe(400);
    const empty = await request(t.app)
      .patch('/api/v1/school/settings')
      .set(auth(s.ownerToken))
      .send({ workingDays: [] });
    expect(empty.status).toBe(400);
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { workingDays: [1, 2, 3, 4, 5, 6] });
  });
});

describe('downloads of school data', () => {
  it('students and parents in the import template columns; every download is audited', async () => {
    const res = await get(s.ownerToken, '/exports/students');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/students-\d{4}-\d{2}-\d{2}\.xlsx/);
    const wb = await sheets(res.body);
    const ws = wb.getWorksheet('Students')!;
    expect(headerOf(ws).slice(0, 6)).toEqual([
      'Admission No',
      'Student Name *',
      'Gender *',
      'Date of Birth',
      'Class *',
      'Section *',
    ]);
    expect(ws.rowCount).toBe(1 + 4);
    expect(ws.getRow(2).getCell(5).value).toBe('Class 5');
    expect(ws.getRow(2).getCell(11).value).toBe('Parent 0');

    // A parent with no child is listed too (empty children column).
    await api(t.app, s.ownerToken, 'post', '/parents', { name: 'Loose Parent', phone: '03215550001' });
    const parents = (await sheets((await get(s.ownerToken, '/exports/parents')).body)).getWorksheet('Parents')!;
    expect(headerOf(parents)).toEqual([
      'Parent Name *',
      'Phone *',
      'Relation',
      'CNIC',
      'Email',
      'WhatsApp',
      'Occupation',
      'Address',
      'Children Admission Nos',
    ]);
    const loose = parents.getRows(2, parents.rowCount - 1)!.find((r) => r.getCell(1).value === 'Loose Parent');
    expect(loose?.getCell(9).value ?? '').toBe('');

    const csv = await get(s.ownerToken, '/exports/families?format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.toString()).toContain('Primary Guardian');
    expect(
      await AuditLog.countDocuments({ schoolId: s.schoolId, action: 'school.data_exported' }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('fees: summary per student with paid / outstanding, plus every invoice and payment', async () => {
    const wb = await sheets((await get(s.ownerToken, '/exports/fees')).body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Fee summary', 'Invoices', 'Payments', 'About']);
    const sum = wb.getWorksheet('Fee summary')!;
    const head = headerOf(sum);
    const col = (h: string) => head.indexOf(h) + 1;
    const rows = sum.getRows(2, sum.rowCount - 1)!;
    const billed = rows.reduce((a, r) => a + Number(r.getCell(col('Total Billed')).value || 0), 0);
    const outstanding = rows.reduce((a, r) => a + Number(r.getCell(col('Outstanding')).value || 0), 0);
    const inv = await Invoice.find({ schoolId: s.schoolId, status: { $ne: 'cancelled' } }).lean();
    expect(billed).toBe(inv.reduce((a, i) => a + i.total, 0));
    expect(outstanding).toBe(inv.reduce((a, i) => a + i.balance, 0));
    expect(wb.getWorksheet('Payments')!.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('staff, salaries and timetable; each needs its permission; "all" holds what the user may see', async () => {
    const staff = (await sheets((await get(s.ownerToken, '/exports/staff')).body)).getWorksheet('Staff')!;
    expect(headerOf(staff).slice(0, 4)).toEqual(['Employee No', 'Full Name *', 'Staff Type *', 'Designation *']);
    const pay = (await sheets((await get(s.ownerToken, '/exports/salaries')).body)).getWorksheet('Salaries')!;
    const ayesha = pay.getRows(2, pay.rowCount - 1)!.find((r) => String(r.getCell(2).value).startsWith('Ayesha'));
    expect(ayesha!.getCell(8).value).toBe(50000); // 45,000 basic + 5,000 allowances
    const tt = (await sheets((await get(s.ownerToken, '/exports/timetable')).body)).getWorksheet('Timetable')!;
    expect(headerOf(tt)).toEqual(['Class', 'Section', 'Day', 'Start', 'End', 'Subject', 'Teacher', 'Room']);

    expect((await get(s.adminToken, '/exports/salaries')).status).toBe(403);
    expect((await get(s.teacherToken, '/exports/students')).status).toBe(403);
    const admin = await sheets((await get(s.adminToken, '/exports/all')).body);
    const names = admin.worksheets.map((w) => w.name);
    expect(names).toContain('Students');
    expect(names).not.toContain('Salaries');
    expect(names).not.toContain('Fee summary');
    const about = admin.getWorksheet('About')!;
    expect(String(about.getRow(about.rowCount).getCell(1).value)).toMatch(/Not included \(no permission\)/);
    const list = await api(t.app, s.adminToken, 'get', '/exports');
    expect(list.find((d: any) => d.dataset === 'salaries').allowed).toBe(false);
  });
});

describe('parents not linked to any student', () => {
  it('lists only unlinked parents; they can be deleted, linked ones cannot', async () => {
    const res = await api(t.app, s.ownerToken, 'get', '/parents/unlinked');
    const names = res.items.map((p: any) => p.name);
    expect(names).toContain('Loose Parent');
    expect(names).not.toContain('Parent 0');
    const loose = res.items.find((p: any) => p.name === 'Loose Parent');
    expect((await request(t.app).delete(`/api/v1/parents/${loose._id}`).set(auth(s.ownerToken))).status).toBe(204);
    const linked = await request(t.app).delete(`/api/v1/parents/${s.parentIds[0]}`).set(auth(s.ownerToken));
    expect(linked.status).toBe(409);
  });
});

describe('staff attendance from an uploaded file', () => {
  let staffNos: Record<string, string> = {};
  beforeAll(async () => {
    const list = await api(t.app, s.ownerToken, 'get', '/employees?limit=50');
    for (const e of list.items ?? list) staffNos[e.firstName] = e.employeeNo;
  });
  const upload = (file: Buffer, name: string, fields: Record<string, string> = {}) => {
    let r = request(t.app).post('/api/v1/staff-attendance/upload/preview').set(auth(s.ownerToken));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', file, name);
  };

  it('reads values the way registers write them', () => {
    expect(parseStatus('P')).toBe('present');
    expect(parseStatus('Absent')).toBe('absent');
    expect(parseStatus('CL')).toBe('leave');
    expect(parseStatus('LT')).toBe('late');
    expect(parseStatus('HD')).toBe('half_day');
    expect(parseStatus('Holiday')).toBeNull();
    expect(parseStatus('?')).toBeUndefined();
    expect(parseHHmm('8:05 AM')).toBe('08:05');
    expect(parseHHmm('0.5')).toBe('12:00');
    expect(parseHHmm('later')).toBeNull();
  });

  it('daily sheet: matched by employee no, Sunday and future left out, then saved and shown', async () => {
    const future = iso(addDays(parseDateOnly(today), 3));
    const csv = [
      'Emp No,Name,Date,Time In,Time Out,Status',
      `${staffNos.Ayesha},Ayesha Khan,${monday},08:01,14:05,`,
      `${staffNos.Bilal},Bilal,${monday},,,Absent`,
      `${staffNos.Ayesha},Ayesha Khan,${sunday},08:00,13:00,`,
      `${staffNos.Ayesha},Ayesha Khan,${future},08:00,13:00,`,
    ].join('\n');
    const res = await upload(Buffer.from(csv), 'register.csv', { lateAfter: '08:00' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.data;
    expect(p.format).toBe('daily');
    expect(p.summary).toMatchObject({ staff: 2, matched: 2, days: 4, ready: 2, offDays: 1, future: 1 });
    const ay = p.entries.find((e: any) => e.date === monday && e.in);
    expect(ay).toMatchObject({ status: 'late', in: '08:01', out: '14:05' }); // after 08:00
    const ready = p.entries.filter((e: any) => !e.skip);
    const saved = await api(t.app, s.ownerToken, 'post', '/staff-attendance/upload/save', {
      fileName: 'register.csv',
      entries: ready.map((e: any) => ({
        employeeId: e.employeeId,
        date: e.date,
        status: e.status,
        in: e.in,
        out: e.out,
      })),
    });
    expect(saved).toMatchObject({ saved: 2, refused: [] });
    const rec = await StaffAttendance.findOne({
      schoolId: s.schoolId,
      employeeId: ay.employeeId,
      date: parseDateOnly(monday),
    }).lean();
    expect(rec).toMatchObject({ status: 'late', source: 'manual', times: { in: '08:01', out: '14:05' } });
    // Saving refuses an off day even if sent.
    const sun = await api(t.app, s.ownerToken, 'post', '/staff-attendance/upload/save', {
      fileName: 'x.csv',
      entries: [{ employeeId: ay.employeeId, date: sunday, status: 'present' }],
    });
    expect(sun.refused[0].reason).toBe('Off day');
  });

  it('monthly register grid: P/A/L marks per day; asks for the month when the file does not say', async () => {
    const [y, m] = monday.split('-');
    const d = Number(monday.slice(8));
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    const row = (name: string, mark: string) => [name, ...days.map((x) => (Number(x) === d ? mark : ''))].join(',');
    const csv = ['Name,' + days.join(','), row('Ayesha Khan', 'P'), row('Bilal', 'L')].join('\n');
    const noMonth = await upload(Buffer.from(csv), 'grid.csv');
    expect(noMonth.status).toBe(400);
    expect(noMonth.body.error.code).toBe('UPLOAD_MONTH_REQUIRED');
    const gridRes = await upload(Buffer.from(csv), 'grid.csv', { month: `${y}-${m}` });
    expect(gridRes.status, JSON.stringify(gridRes.body)).toBe(200);
    const p = gridRes.body.data;
    expect(p.format).toBe('grid');
    const byName = Object.fromEntries(
      p.entries.filter((e: any) => e.date === monday).map((e: any) => [e.staffKey, e.status]),
    );
    expect(Object.values(byName).sort()).toEqual(['leave', 'present']);
  });

  it('machine log: first and last punch per day; an unknown name is chosen once and remembered', async () => {
    const csv = [
      'AC-No,Name,Date Time',
      `9001,Mrs Ayesha,${monday} 07:55:10`,
      `9001,Mrs Ayesha,${monday} 13:30:00`,
      `9001,Mrs Ayesha,${monday} 10:15:00`,
    ].join('\n');
    const first = (await upload(Buffer.from(csv), 'machine.csv')).body.data;
    expect(first.format).toBe('punches');
    expect(first.staff[0]).toMatchObject({ id: '9001', employeeId: null, matchedBy: null });
    expect(first.entries[0]).toMatchObject({ date: monday, status: 'present', in: '07:55', out: '13:30', punches: 3 });
    expect(first.entries[0].skip).toMatch(/not found/);
    const ayesha = first.employees.find((e: any) => e.name.startsWith('Ayesha'));
    await api(t.app, s.ownerToken, 'post', '/staff-attendance/upload/save', {
      fileName: 'machine.csv',
      entries: [{ employeeId: ayesha._id, date: monday, status: 'present', in: '07:55', out: '13:30' }],
      links: [{ key: first.staff[0].key, employeeId: ayesha._id }],
    });
    const again = (await upload(Buffer.from(csv), 'machine.csv')).body.data;
    expect(again.staff[0]).toMatchObject({ employeeId: ayesha._id, matchedBy: 'saved' });
    expect(again.entries[0].existing).toMatchObject({ status: 'present', source: 'manual' });
  });

  it('reads a PDF report (text laid out in columns)', async () => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
    doc.fontSize(14).text('Staff Attendance Report', 50, 40);
    const cols = [50, 140, 300, 420];
    const line = (cells: string[], y: number) =>
      cells.forEach((c, i) => doc.fontSize(10).text(c, cols[i], y, { lineBreak: false }));
    line(['Emp No', 'Name', 'Date', 'Status'], 90);
    line([staffNos.Ayesha, 'Ayesha Khan', monday, 'Present'], 110);
    line([staffNos.Bilal, 'Bilal', monday, 'Leave'], 128);
    doc.end();
    const res = await upload(await done, 'report.pdf');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.data;
    expect(p.fileKind).toBe('pdf');
    expect(p.format).toBe('daily');
    expect(p.entries.map((e: any) => e.status).sort()).toEqual(['leave', 'present']);
    expect(p.summary.matched).toBe(2);
  });

  it('refuses files it cannot understand, with what it needs', async () => {
    const res = await upload(Buffer.from('Foo,Bar\n1,2'), 'x.csv');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UPLOAD_UNRECOGNISED');
    expect(
      (
        await request(t.app)
          .post('/api/v1/staff-attendance/upload/preview')
          .set(auth(s.teacherToken))
          .attach('file', Buffer.from('a'), 'a.csv')
      ).status,
    ).toBe(403);
  });
});

describe('certificates', () => {
  it('award certificates print as awards; previews still work for every type', async () => {
    await School.updateOne({ _id: s.schoolId }, { $set: { 'settings.currentSessionId': s.sessionId } });
    for (const type of ['achievement', 'character', 'leaving']) {
      const res = await request(t.app)
        .post('/api/v1/certificates/preview.pdf')
        .set(auth(s.ownerToken))
        .send({
          studentId: s.students[1],
          type,
          values: {
            'certificate.achievement': 'first position in the science fair',
            'certificate.conduct': 'Excellent',
            'student.leavingDate': monday,
            'student.dateOfBirth': '2015-03-12',
          },
        });
      expect(res.status, type).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    }
  });
});
