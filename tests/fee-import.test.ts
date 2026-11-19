import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { suggestMapping } from '../src/modules/imports/import-fields';
import { parseFeeAmount, personNameKey } from '../src/modules/imports/import-values';
import { previousMonth } from '../src/modules/imports/processors/fees';
import { School } from '../src/modules/schools/school.model';
import { Student } from '../src/modules/students/student.models';
import { todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { checkAndWait, waitStaged } from './import-helpers';

const t = useTestApp();
let s: SchoolFixture;
/** The month the previous dues are up to, and the first month billed in School OS. */
const duesUpTo = previousMonth(todayInTz('Asia/Karachi'));
const firstBilled = todayInTz('Asia/Karachi').slice(0, 7);

type RowView = {
  rowNo: number;
  check: string;
  result: string;
  issues: Array<{ level: string; message: string }>;
  changes: any[];
};

async function upload(token: string, csv: string) {
  const res = await request(t.app)
    .post('/api/v1/imports')
    .set(auth(token))
    .field('type', 'fees')
    .attach('file', Buffer.from(csv), 'fees.csv');
  if (res.status === 201) await waitStaged(t.app, token, res.body.data.job._id);
  return res;
}

async function check(token: string, csv: string, options: Record<string, unknown> = {}) {
  const up = await upload(token, csv);
  expect(up.status).toBe(201);
  const id = up.body.data.job._id as string;
  const mapping = up.body.data.columns.map((c: any) => ({ column: c.column, field: c.field }));
  const res = await checkAndWait(t.app, token, id, { mapping, options: { duesUpTo, ...options } });
  return { id, columns: up.body.data.columns, ...res };
}

async function rowsOf(token: string, id: string) {
  const res = await request(t.app).get(`/api/v1/imports/${id}/rows?filter=all&limit=100`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.data as RowView[];
}

async function run(token: string, id: string) {
  await api(t.app, token, 'post', `/imports/${id}/run`, { confirm: true });
  for (let i = 0; i < 200; i++) {
    const job = await api(t.app, token, 'get', `/imports/${id}`);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import did not finish');
}

const issues = (r: RowView) => r.issues.map((i) => `${i.level}: ${i.message}`).join(' | ');

async function admit(firstName: string, lastName: string, father: string, phone: string, sectionId = s.sectionA) {
  const st = await api(t.app, s.ownerToken, 'post', '/students', {
    campusId: s.campusId,
    firstName,
    lastName,
    gender: 'male',
    sessionId: s.sessionId,
    classId: s.classId,
    sectionId,
    guardians: [{ parent: { name: father, phone }, isPrimary: true }],
  });
  return { id: st._id as string, admissionNo: st.admissionNo as string };
}

describe('Fee import: reading amounts and names', () => {
  it('reads amounts as schools write them', () => {
    expect(parseFeeAmount('2500')).toMatchObject({ ok: true, value: 2500 });
    expect(parseFeeAmount('Rs 2,500/-')).toMatchObject({ ok: true, value: 2500 });
    expect(parseFeeAmount('3000 + 600')).toMatchObject({
      ok: true,
      value: 3600,
      note: expect.stringContaining('added up'),
    });
    expect(parseFeeAmount('6400+2400+ 2800')).toMatchObject({ ok: true, value: 11600 });
    expect(parseFeeAmount('---')).toMatchObject({ ok: true, value: 0 });
    expect(parseFeeAmount('—')).toMatchObject({ ok: true, value: 0 });
    expect(parseFeeAmount('2500.00')).toMatchObject({ ok: true, value: 2500 });
    expect(parseFeeAmount('2500.5').ok).toBe(false);
    expect(parseFeeAmount('-500')).toMatchObject({ ok: false, error: expect.stringContaining('Advance') });
    expect(parseFeeAmount('two thousand').ok).toBe(false);
    expect(parseFeeAmount('2000000', 1_000_000).ok).toBe(false);
  });

  it('treats the short forms of Muhammad as the same name', () => {
    expect(personNameKey('M. Ali Raza')).toBe(personNameKey('Muhammad Ali Raza'));
    expect(personNameKey('Mohd Ali')).toBe(personNameKey('MUHAMMAD ALI'));
    expect(personNameKey('Ali Raza')).not.toBe(personNameKey('Ali Rehman'));
  });

  it('maps a school’s own dues statement: Fee → Monthly Fee, Outstanding → Previous Dues', () => {
    const headers = [
      'Sr.',
      'Class',
      "Student's Name",
      "Father's Name",
      'Fee',
      'Books',
      'Fund',
      'S.N. Card',
      'Arrears',
      'Total',
      'Paid',
      'Outstanding',
      'Date',
      'Contact',
    ];
    const m = Object.fromEntries(suggestMapping('fees', headers).map((c) => [c.header, c.field]));
    expect(m).toMatchObject({
      Class: 'className',
      "Student's Name": 'studentName',
      "Father's Name": 'fatherName',
      Fee: 'monthlyFee',
      Outstanding: 'arrears',
      Contact: 'parentPhone',
      Arrears: null,
      Paid: null,
      Total: null,
    });
    const paid = suggestMapping('fees', headers).find((c) => c.header === 'Paid');
    expect(paid?.ignoredReason).toMatch(/Payments are not imported/);
    // A statement with only an Arrears column still maps it.
    expect(suggestMapping('fees', ['Name', 'Class', 'Arrears']).find((c) => c.header === 'Arrears')?.field).toBe(
      'arrears',
    );
  });
});

describe('Fee import: end to end', () => {
  let hamza: { id: string; admissionNo: string };
  let aliKhan: { id: string; admissionNo: string };
  let aliAhmed: { id: string; admissionNo: string };
  let sara: { id: string; admissionNo: string };

  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 2 });
    hamza = await admit('Muhammad', 'Hamza', 'Bilal Ahmed', '03111111111');
    aliKhan = await admit('Ali', 'Raza', 'Raza Khan', '03222222222');
    aliAhmed = await admit('Ali', 'Raza', 'Raza Ahmed', '03333333333', s.sectionB);
    sara = await admit('Sara', 'Noor', 'Noor Hassan', '03444444444');
  });

  it('downloads a template whose headings map themselves', async () => {
    const res = await request(t.app).get('/api/v1/imports/templates/fees?format=csv').set(auth(s.ownerToken));
    expect(res.status).toBe(200);
    const header = res.text.split('\n')[0];
    expect(header).toContain('Student Name *');
    expect(header).toContain('Monthly Fee');
    expect(header).toContain('Previous Dues');
    const m = suggestMapping('fees', header.trim().split(','));
    expect(m.every((c) => c.field)).toBe(true);
  });

  it('checks every row: finds students, tells same names apart, explains every problem, saves nothing', async () => {
    const csv = [
      'Admission No,Student Name,Father Name,Class,Contact,Monthly Fee,Previous Dues',
      `,M. Hamza,Bilal Ahmed,Class 5,03111111111,3000,6000 + 600`, // 2: "M." = Muhammad
      `,Ali Raza,Raza Ahmed,class-5,,2500,0`, // 3: same name twice in the class: father tells them apart
      `,Ali Raza,,Class 5,,2000,`, // 4: same name, nothing to tell them apart
      `${sara.admissionNo},Sara Noor,Someone Else,Class 5,03999999999,,4500`, // 5: by admission no; father differs (warning)
      `,Zain Malik,,Class 5,,1500,`, // 6: not in School OS
      `,Sara Noor,,Class 9,,1500,`, // 7: no such class
      `,M. Hamza,,Class 5,,3000,`, // 8: same student as row 2
      `,Student0 Test,,Class 5,,,-200`, // 9: advance (negative)
      `,Student1 Test,,Class 5,,,`, // 10: nothing to import
      `,Student1 Test,,Class 5,,1800,two hundred`, // 11: unreadable amount
    ].join('\n');
    const { id, summary, warnings } = await check(s.ownerToken, csv);
    const rows = await rowsOf(s.ownerToken, id);
    const row = (n: number) => rows.find((r) => r.rowNo === n)!;

    expect(row(2).check).toBe('create');
    expect(issues(row(2))).toMatch(/"M\. Hamza" matched to Muhammad Hamza/);
    expect(issues(row(2))).toMatch(/added up to Rs 6,600/);
    expect(row(2).changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'Monthly Fee', from: 'class fee Rs 5,000', to: 'Rs 3,000' }),
        expect.objectContaining({ field: 'Previous Dues', from: '—', to: 'Rs 6,600' }),
      ]),
    );
    expect(row(3).check).toBe('create');
    expect(issues(row(3))).toMatch(/told apart by the father’s name/);
    expect(row(4).check).toBe('invalid');
    expect(issues(row(4))).toMatch(/2 students named Ali Raza in Class 5 .*Add the Admission No/);
    expect(row(5).check).toBe('create');
    expect(issues(row(5))).toMatch(/warning: Father Name: "Someone Else" in the file; in School OS: Noor Hassan/);
    expect(issues(row(5))).toMatch(/warning: Parent Phone/);
    expect(issues(row(6))).toMatch(/no student named Zain Malik in Class 5/);
    expect(issues(row(7))).toMatch(/"Class 9" is not a class/);
    expect(row(8).check).toBe('duplicate');
    expect(issues(row(8))).toMatch(/also on row 2/);
    expect(issues(row(9))).toMatch(/Advance payments cannot be imported/);
    expect(issues(row(10))).toMatch(/Enter a Monthly Fee or Previous Dues/);
    expect(issues(row(11))).toMatch(/"two hundred" is not an amount/);
    expect(summary).toMatchObject({ create: 3, invalid: 6, duplicate: 1 });
    // Totals to compare with the school's register; the fee head used is named.
    expect(warnings.join('\n')).toMatch(
      /monthly fees for 2 students \(together Rs 5,500 a month\), previous dues for 2 students \(together Rs 11,100\)/,
    );
    expect(warnings.join('\n')).toMatch(/Monthly Fee sets the fee head "Tuition Fee"/);
    // Checking saved nothing.
    expect(await Invoice.countDocuments({ kind: 'opening', schoolId: s.schoolId })).toBe(0);
    expect((await Student.findOne({ schoolId: s.schoolId, _id: hamza.id }).lean())!.customFees).toEqual([]);
  });

  it('imports: own monthly fee and one "Previous dues" invoice per student; a repeated import adds nothing', async () => {
    const csv = [
      'Student Name,Father Name,Class,Monthly Fee,Previous Dues,Notes',
      'M. Hamza,Bilal Ahmed,Class 5,3000,6000 + 600,includes annual charges',
      'Ali Raza,Raza Ahmed,Class 5,2500,0,',
      `Sara Noor,,Class 5,,4500,`,
    ].join('\n');
    const first = await check(s.ownerToken, csv);
    expect(first.summary).toMatchObject({ create: 3, invalid: 0 });
    const job = await run(s.ownerToken, first.id);
    expect(job).toMatchObject({ status: 'completed', result: { created: 3, failed: 0 } });

    const h = (await Student.findOne({ schoolId: s.schoolId, _id: hamza.id }).lean())!;
    expect(h.customFees).toEqual([
      expect.objectContaining({ feeHeadId: expect.anything(), amount: 3000, source: 'import' }),
    ]);
    expect(String(h.customFees[0].feeHeadId)).toBe(s.tuitionHeadId);
    const opening = await Invoice.findOne({ schoolId: s.schoolId, studentId: hamza.id, kind: 'opening' }).lean();
    expect(opening).toMatchObject({
      total: 6600,
      balance: 6600,
      paid: 0,
      status: 'unpaid',
      period: duesUpTo,
      notes: 'includes annual charges',
    });
    expect(opening!.items[0].name).toMatch(/^Previous dues \(up to /);
    // 0 dues: no invoice. Untouched: the other Ali Raza.
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, studentId: aliAhmed.id, kind: 'opening' })).toBe(0);
    expect((await Student.findOne({ schoolId: s.schoolId, _id: aliAhmed.id }).lean())!.customFees[0].amount).toBe(2500);
    expect((await Student.findOne({ schoolId: s.schoolId, _id: aliKhan.id }).lean())!.customFees).toEqual([]);

    // The same file again: nothing new.
    const again = await check(s.ownerToken, csv);
    expect(again.summary).toMatchObject({ create: 0, update: 0, unchanged: 3 });
    expect(await Invoice.countDocuments({ schoolId: s.schoolId, studentId: hamza.id, kind: 'opening' })).toBe(1);

    // The ledger shows the own fee and the previous dues.
    const ledger = await api(t.app, s.ownerToken, 'get', `/fees/students/${hamza.id}/ledger`);
    expect(ledger.ownFees).toEqual([expect.objectContaining({ name: 'Tuition Fee', amount: 3000, source: 'import' })]);
    expect(ledger.entries[0]).toMatchObject({ label: 'Previous dues', debit: 6600 });
    expect(ledger.summary.outstanding).toBe(6600);
  });

  it('"add new" keeps what is set; "update" changes unpaid dues and fees, never paid ones', async () => {
    const csv = [
      'Student Name,Father Name,Class,Monthly Fee,Previous Dues',
      'M. Hamza,Bilal Ahmed,Class 5,3200,7000',
    ].join('\n');
    const keep = await check(s.ownerToken, csv);
    const [kept] = await rowsOf(s.ownerToken, keep.id);
    expect(kept.check).toBe('exists');
    expect(issues(kept)).toMatch(/already has an own fee of Rs 3,000; kept/);
    expect(issues(kept)).toMatch(/previous dues of Rs 6,600 already recorded; kept/);

    const upd = await check(s.ownerToken, csv, { mode: 'upsert' });
    expect(upd.summary).toMatchObject({ update: 1 });
    expect((await run(s.ownerToken, upd.id)).result).toMatchObject({ updated: 1 });
    expect(await Invoice.findOne({ schoolId: s.schoolId, studentId: hamza.id, kind: 'opening' }).lean()).toMatchObject({
      total: 7000,
      balance: 7000,
    });
    expect((await Student.findOne({ schoolId: s.schoolId, _id: hamza.id }).lean())!.customFees[0].amount).toBe(3200);

    // Once something is paid against the previous dues, an import cannot change them.
    const opening = await Invoice.findOne({ schoolId: s.schoolId, studentId: hamza.id, kind: 'opening' }).lean();
    await api(t.app, s.ownerToken, 'post', `/fees/invoices/${opening!._id}/payments`, { amount: 1000, method: 'cash' });
    const paid = await check(s.ownerToken, csv.replace('7000', '8000'), { mode: 'upsert' });
    const [row] = await rowsOf(s.ownerToken, paid.id);
    expect(row.check).toBe('invalid');
    expect(issues(row)).toMatch(/Rs 1,000 has already been paid against the previous dues of Rs 7,000/);
  });

  it('bills the own monthly fee; the challan shows previous dues and the total payable', async () => {
    const gen = await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', {
      period: firstBilled,
      studentIds: [hamza.id, sara.id],
    });
    expect(gen.created).toBe(2);
    const inv = await Invoice.findOne({
      schoolId: s.schoolId,
      studentId: hamza.id,
      kind: 'regular',
      period: firstBilled,
    }).lean();
    // Own fee 3,200 instead of the class's 5,000 (plus the class's one-time admission fee).
    expect(inv!.items.find((i) => i.name === 'Tuition Fee')!.amount).toBe(3200);

    const detail = await api(t.app, s.ownerToken, 'get', `/fees/invoices/${inv!._id}`);
    expect(detail.previousDues.amount).toBe(6000); // 7,000 previous dues − 1,000 paid
    expect(detail.previousDues.invoices).toHaveLength(1);
    const pdf = await request(t.app).get(`/api/v1/fees/invoices/${inv!._id}/challan.pdf`).set(auth(s.ownerToken));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
  });

  it('one payment for the whole voucher settles the oldest dues first, with a receipt per invoice', async () => {
    const opening = await Invoice.findOne({ schoolId: s.schoolId, studentId: hamza.id, kind: 'opening' }).lean();
    const month = await Invoice.findOne({
      schoolId: s.schoolId,
      studentId: hamza.id,
      kind: 'regular',
      period: firstBilled,
    }).lean();
    const owed = opening!.balance + month!.balance;

    const over = await request(t.app)
      .post(`/api/v1/fees/students/${hamza.id}/payments`)
      .set(auth(s.ownerToken))
      .send({ amount: owed + 1, method: 'cash' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERPAYMENT');

    const part = 6000 + 500; // all previous dues, part of this month
    const body = { amount: part, method: 'cash', idempotencyKey: 'counter-pay-0001' };
    const res = await api(t.app, s.ownerToken, 'post', `/fees/students/${hamza.id}/payments`, body);
    expect(res.payments.map((p: any) => p.amount)).toEqual([6000, 500]);
    expect(new Set(res.payments.map((p: any) => p.receiptNo)).size).toBe(2);
    expect(res.remaining).toBe(owed - part);
    expect(await Invoice.findOne({ schoolId: s.schoolId, _id: opening!._id }).lean()).toMatchObject({
      status: 'paid',
      balance: 0,
    });
    expect(await Invoice.findOne({ schoolId: s.schoolId, _id: month!._id }).lean()).toMatchObject({
      status: 'partial',
      paid: 500,
    });

    // A retry of the same request records nothing new.
    const retry = await api(t.app, s.ownerToken, 'post', `/fees/students/${hamza.id}/payments`, body);
    expect(retry.replayed).toBe(true);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, studentId: hamza.id })).toBe(3); // 1,000 earlier + 2 now

    // Fully paid: nothing left as previous dues on the challan.
    const detail = await api(t.app, s.ownerToken, 'get', `/fees/invoices/${month!._id}`);
    expect(detail.previousDues.amount).toBe(0);
  });

  it('never adds a late fee to previous dues', async () => {
    await School.updateOne({ _id: s.schoolId }, { $set: { 'settings.fees.lateFeeAmount': 300 } });
    await Invoice.updateMany({ schoolId: s.schoolId }, { $set: { dueDate: new Date('2020-01-01') } });
    await api(t.app, s.ownerToken, 'post', '/fees/late-fees/apply');
    const saraOpening = await Invoice.findOne({ schoolId: s.schoolId, studentId: sara.id, kind: 'opening' }).lean();
    expect(saraOpening).toMatchObject({ lateFee: 0, total: 4500 });
    const saraMonth = await Invoice.findOne({ schoolId: s.schoolId, studentId: sara.id, kind: 'regular' }).lean();
    expect(saraMonth!.lateFee).toBe(300);
  });

  it('bills a student with an own fee even when the class has no fee structure', async () => {
    const cls = await api(t.app, s.ownerToken, 'post', '/academics/classes', {
      campusId: s.campusId,
      name: 'Class 6',
      level: 6,
    });
    const sec = await api(t.app, s.ownerToken, 'post', '/academics/sections', {
      classId: cls._id,
      sessionId: s.sessionId,
      name: 'A',
    });
    const st = await api(t.app, s.ownerToken, 'post', '/students', {
      campusId: s.campusId,
      firstName: 'Hiba',
      lastName: 'Amir',
      gender: 'female',
      sessionId: s.sessionId,
      classId: cls._id,
      sectionId: sec._id,
      guardians: [{ parent: { name: 'M. Amir', phone: '03555555555' }, isPrimary: true }],
    });
    const imp = await check(s.ownerToken, 'Student Name,Class,Monthly Fee\nHiba Amir,Class 6,2500');
    await run(s.ownerToken, imp.id);
    const gen = await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', {
      period: firstBilled,
      classId: cls._id,
    });
    expect(gen).toMatchObject({ created: 1, skippedNoStructure: 0 });
    const inv = await Invoice.findOne({ schoolId: s.schoolId, studentId: st._id, period: firstBilled }).lean();
    expect(inv!.items).toEqual([expect.objectContaining({ name: 'Tuition Fee', amount: 2500 })]);
  });

  it('only users who manage fees can import them', async () => {
    const types = await api(t.app, s.teacherToken, 'get', '/imports/types');
    expect(types.find((x: any) => x.type === 'fees').allowed).toBe(false);
    const res = await upload(s.teacherToken, 'Student Name,Class,Monthly Fee\nSara Noor,Class 5,100');
    expect(res.status).toBe(403);
  });
});

describe('Fee import: a school without a monthly fee head', () => {
  it('creates "Monthly Fee" once and says so before importing', async () => {
    const fresh = await buildSchool(t.app, { students: 2 });
    // Make the fixture's tuition head inactive: the school has no monthly head left.
    await api(t.app, fresh.ownerToken, 'patch', `/fees/heads/${fresh.tuitionHeadId}`, { isActive: false });
    s = fresh;
    const { id, warnings } = await check(
      fresh.ownerToken,
      'Student Name,Class,Monthly Fee\nStudent0 Test,Class 5,1800\nStudent1 Test,Class 5,1900',
    );
    expect(warnings.join('\n')).toMatch(/"Monthly Fee" \(code MONTHLY\) will be created/);
    expect((await run(fresh.ownerToken, id)).result).toMatchObject({ created: 2 });
    const heads = await api(t.app, fresh.ownerToken, 'get', '/fees/heads?limit=50');
    const monthly = (heads.items ?? heads).filter((h: any) => h.code === 'MONTHLY');
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({ frequency: 'monthly', isActive: true });
  });
});
