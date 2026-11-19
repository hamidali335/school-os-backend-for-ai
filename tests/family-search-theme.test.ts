import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { Student } from '../src/modules/students/student.models';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let siblingId: string;
let parentPhone: string;

const pdf = (token: string, url: string) =>
  request(t.app)
    .get(`/api/v1${url}`)
    .set(auth(token))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
  // A sibling of student 0 (same parent), in section B.
  const sib = await api(t.app, s.ownerToken, 'post', '/students', {
    campusId: s.campusId,
    sessionId: s.sessionId,
    classId: s.classId,
    sectionId: s.sectionB,
    firstName: 'Sibling',
    lastName: 'Zero',
    gender: 'female',
    guardians: [{ parentId: s.parentIds[0], relation: 'father', isPrimary: true }],
  });
  siblingId = sib._id;
  await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-10' });
  const parent = await api(t.app, s.ownerToken, 'get', `/parents/${s.parentIds[0]}`);
  parentPhone = parent.phone;
});

describe('Family voucher', () => {
  it('lists each child separately; the family total is the sum of each invoice’s own challan amount', async () => {
    const fam = await api(t.app, s.accountantToken, 'get', `/fees/family/${s.parentIds[0]}`);
    expect(fam.children.map((c: any) => c.studentId).sort()).toEqual([s.students[0], siblingId].sort());
    // Student 1 has another parent and is never included.
    expect(fam.children.some((c: any) => c.studentId === s.students[1])).toBe(false);
    for (const c of fam.children) {
      expect(c.invoices.length).toBeGreaterThan(0);
      expect(c.payable).toBe(c.invoices.reduce((a: number, i: any) => a + i.payableNow, 0));
      for (const i of c.invoices) {
        const inv = await Invoice.findOne({ schoolId: s.schoolId, _id: i.invoiceId }).lean();
        expect(i.payableNow).toBe(inv!.balance); // not split: payable = balance
      }
    }
    expect(fam.total).toBe(fam.children.reduce((a: number, c: any) => a + c.payable, 0));
  });

  it('a partial payment on one child stays on that child’s invoice and reduces only their amount', async () => {
    const before = await api(t.app, s.accountantToken, 'get', `/fees/family/${s.parentIds[0]}`);
    const child = before.children.find((c: any) => c.studentId === siblingId);
    const inv = child.invoices[0];
    await api(t.app, s.accountantToken, 'post', `/fees/invoices/${inv.invoiceId}/payments`, {
      amount: 1000,
      method: 'cash',
    });
    const after = await api(t.app, s.accountantToken, 'get', `/fees/family/${s.parentIds[0]}`);
    const sameChild = after.children.find((c: any) => c.studentId === siblingId);
    const otherChild = after.children.find((c: any) => c.studentId === s.students[0]);
    expect(sameChild.payable).toBe(child.payable - 1000);
    expect(otherChild.payable).toBe(before.children.find((c: any) => c.studentId === s.students[0]).payable);
    expect(after.total).toBe(before.total - 1000);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, invoiceId: inv.invoiceId })).toBe(1);
  });

  it('downloads a family voucher PDF (optionally for chosen children); the single challan still works', async () => {
    const all = await pdf(s.accountantToken, `/fees/family/${s.parentIds[0]}/voucher.pdf`);
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toBe('application/pdf');
    expect(all.body.subarray(0, 5).toString()).toBe('%PDF-');
    const one = await pdf(s.accountantToken, `/fees/family/${s.parentIds[0]}/voucher.pdf?studentIds=${siblingId}`);
    expect(one.status).toBe(200);
    expect(one.body.length).toBeLessThan(all.body.length);
    const inv = await Invoice.findOne({ schoolId: s.schoolId, studentId: s.students[0] }).lean();
    const single = await pdf(s.accountantToken, `/fees/invoices/${inv!._id}/challan.pdf`);
    expect(single.status).toBe(200);
    // Nothing due for the chosen child: a clear error.
    const none = await request(t.app)
      .get(`/api/v1/fees/family/${s.parentIds[0]}/voucher.pdf?studentIds=${s.students[1]}`)
      .set(auth(s.accountantToken));
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NOTHING_DUE');
  });

  it('is isolated: other schools get 404, a parent sees only their own family, teachers cannot', async () => {
    expect((await request(t.app).get(`/api/v1/fees/family/${s.parentIds[0]}`).set(auth(other.ownerToken))).status).toBe(
      404,
    );
    expect(
      (await request(t.app).get(`/api/v1/fees/family/${s.parentIds[0]}/voucher.pdf`).set(auth(other.accountantToken)))
        .status,
    ).toBe(404);
    const own = await request(t.app).get(`/api/v1/fees/family/${s.parentIds[0]}`).set(auth(s.parentToken));
    expect(own.status).toBe(200);
    expect((await request(t.app).get(`/api/v1/fees/family/${s.parentIds[1]}`).set(auth(s.parentToken))).status).toBe(
      403,
    );
    expect((await request(t.app).get(`/api/v1/fees/family/${s.parentIds[0]}`).set(auth(s.teacherToken))).status).toBe(
      403,
    );
  });
});

describe('Search', () => {
  it('students: by name, admission no, and by the parent’s name or phone in any format', async () => {
    const kid = await Student.findOne({ schoolId: s.schoolId, _id: s.students[0] }).lean();
    const find = async (q: string) =>
      ((await api(t.app, s.ownerToken, 'get', `/students?q=${encodeURIComponent(q)}`)) as any[]).map((x) =>
        String(x._id),
      );
    expect(await find(kid!.admissionNo)).toEqual([s.students[0]]);
    expect(await find(kid!.firstName)).toContain(s.students[0]);
    const byPhone = await find(parentPhone.replace('+92', '0'));
    expect(byPhone.sort()).toEqual([s.students[0], siblingId].sort()); // both children of that parent
    expect(await find('nobody-like-this')).toEqual([]);
  });

  it('fee vouchers and payments: by challan or receipt number, student, or parent phone; combined with filters', async () => {
    const inv = await Invoice.findOne({ schoolId: s.schoolId, studentId: siblingId }).lean();
    const list = async (q: string, extra = '') =>
      ((await api(t.app, s.accountantToken, 'get', `/fees/invoices?q=${encodeURIComponent(q)}${extra}`)) as any[]).map(
        (x) => x.invoiceNo,
      );
    expect(await list(inv!.invoiceNo)).toEqual([inv!.invoiceNo]);
    expect(await list('Sibling')).toEqual([inv!.invoiceNo]);
    expect((await list(parentPhone)).length).toBe(2);
    expect(await list('Sibling', '&status=paid')).toEqual([]);
    const pay = await Payment.findOne({ schoolId: s.schoolId, invoiceId: inv!._id }).lean();
    const payments = await api(t.app, s.accountantToken, 'get', `/fees/payments?q=${pay!.receiptNo}`);
    expect(payments.map((p: any) => p.receiptNo)).toEqual([pay!.receiptNo]);
  });

  it('search never reaches another school, and parents see only their own family', async () => {
    // Both schools number admissions from ADM-00001: results must be this school's only.
    const theirs = await Student.findOne({ schoolId: other.schoolId }).lean();
    const found = (await api(t.app, s.ownerToken, 'get', `/students?q=${theirs!.admissionNo}`)) as any[];
    expect(found.length).toBeGreaterThan(0);
    for (const x of found) expect(x.schoolId).toBe(s.schoolId);
    const theirName = 'OnlyInOtherSchool';
    await Student.updateOne({ schoolId: other.schoolId, _id: theirs!._id }, { $set: { firstName: theirName } });
    expect(await api(t.app, s.ownerToken, 'get', `/students?q=${theirName}`)).toEqual([]);
    expect(await api(t.app, s.accountantToken, 'get', `/fees/invoices?q=${theirName}`)).toEqual([]);
    const mine = await api(t.app, s.parentToken, 'get', '/fees/invoices?q=Student');
    for (const i of mine) expect([s.students[0], siblingId]).toContain(String(i.studentId?._id ?? i.studentId));
  });

  it('staff: by phone and department; CNIC only for those allowed to see it', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Searchable',
      designation: 'Clerk',
      department: 'Front Office',
      staffType: 'non_teaching',
      phone: '03219876543',
      cnic: '35202-5555555-5',
    });
    const find = async (token: string, q: string) =>
      ((await api(t.app, token, 'get', `/employees?q=${encodeURIComponent(q)}`)) as any[]).map((x) => x._id);
    expect(await find(s.ownerToken, '0321-987 6543')).toEqual([emp._id]);
    expect(await find(s.ownerToken, 'front office')).toEqual([emp._id]);
    expect(await find(s.ownerToken, '35202-5555555')).toEqual([emp._id]);
    expect(await find(s.principalToken, 'Searchable')).toEqual([emp._id]);
  });
});

describe('Colour-coded interface setting', () => {
  it('is off by default, saved per school, and returned at sign-in', async () => {
    const me = await api(t.app, s.ownerToken, 'get', '/auth/me');
    expect(me.school.settings?.ui?.colorCoded ?? false).toBe(false);
    await api(t.app, s.ownerToken, 'patch', '/school/settings', { ui: { colorCoded: true } });
    expect((await api(t.app, s.teacherToken, 'get', '/auth/me')).school.settings.ui.colorCoded).toBe(true);
    // Other schools are unaffected; only school settings managers may change it.
    expect((await api(t.app, other.ownerToken, 'get', '/auth/me')).school.settings?.ui?.colorCoded ?? false).toBe(
      false,
    );
    const denied = await request(t.app)
      .patch('/api/v1/school/settings')
      .set(auth(s.teacherToken))
      .send({ ui: { colorCoded: false } });
    expect(denied.status).toBe(403);
    // Other settings are kept.
    const settings = await api(t.app, s.ownerToken, 'get', '/school/settings');
    expect(settings.timezone).toBeTruthy();
  });
});
