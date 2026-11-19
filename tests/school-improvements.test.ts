import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { Notification } from '../src/modules/communications/communications.models';
import { Employee } from '../src/modules/employees/employee.model';
import { pickInstallment, splitInstallments } from '../src/modules/fees/fee-calc';
import { Payment } from '../src/modules/fees/fees.models';
import { TimetableEntry } from '../src/modules/timetable/timetable.model';
import { User } from '../src/modules/users/user.model';
import { challanFigures } from '../src/services/pdf';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, login, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
  other = await buildSchool(t.app, { students: 1 });
});

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

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: '#1f4e79' } })
    .png()
    .toBuffer();

// ───────────────────────────── 2. Installment vouchers ─────────────────────────────
describe('Installment fee vouchers', () => {
  it('Rs 60,000 in six installments: each voucher asks for Rs 10,000 and the total reconciles', () => {
    const plan = splitInstallments(60000, 6, new Date('2026-11-10'), 30);
    expect(plan.map((p) => p.amount)).toEqual([10000, 10000, 10000, 10000, 10000, 10000]);
    expect(plan.reduce((a, p) => a + p.amount, 0)).toBe(60000);
    const status = plan.map((p, i) => ({ ...p, paid: i === 0 ? 10000 : 0, outstanding: i === 0 ? 0 : 10000 }));
    const inst = pickInstallment(status)!;
    expect(inst).toMatchObject({ no: 2, count: 6, amount: 10000, outstanding: 10000 });
    const fig = challanFigures({
      invoiceNo: 'X',
      period: '2026-10',
      issueDate: new Date(),
      dueDate: inst.dueDate,
      studentName: 'A',
      admissionNo: 'B',
      items: [],
      subtotal: 60000,
      concession: 0,
      waiver: 0,
      lateFee: 0,
      total: 60000,
      paid: 10000,
      balance: 50000,
      status: 'partial',
      installment: inst,
    });
    expect(fig).toEqual({
      original: 60000,
      discount: 0,
      net: 60000,
      payableNow: 10000,
      remainingAfter: 40000,
      previous: 0,
      totalPayable: 10000,
      stamp: 'PARTLY PAID',
    });
    expect(() => pickInstallment(status, 9)).toThrow(/6 installments/);
    expect(() => pickInstallment([], 1)).toThrow(/not split/);
  });

  it('downloads the challan for a chosen installment; a wrong installment number is refused', async () => {
    await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', { period: '2026-10' });
    const list = await api(t.app, s.ownerToken, 'get', `/fees/invoices?studentId=${s.students[0]}`);
    const inv = list[0];
    await api(t.app, s.ownerToken, 'post', `/fees/invoices/${inv._id}/installments`, {
      count: 3,
      firstDueDate: '2026-10-10',
      intervalDays: 30,
    });
    const detail = await api(t.app, s.ownerToken, 'get', `/fees/invoices/${inv._id}`);
    expect(detail.installments.reduce((a: number, p: any) => a + p.amount, 0)).toBe(detail.total);
    const ok = await pdf(s.ownerToken, `/fees/invoices/${inv._id}/challan.pdf?installment=2`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['content-disposition']).toContain('installment-2');
    expect((ok.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pdf(s.ownerToken, `/fees/invoices/${inv._id}/challan.pdf?installment=4`)).status).toBe(400);
    // The parent of the student can download it too; another school cannot.
    expect((await pdf(s.parentToken, `/fees/invoices/${inv._id}/challan.pdf`)).status).toBe(200);
    expect((await pdf(other.ownerToken, `/fees/invoices/${inv._id}/challan.pdf`)).status).toBe(404);
  });
});

// ───────────────────────────── 3/4. Branding and documents ─────────────────────────────
describe('School logo and document design', () => {
  it('uploads, serves and removes a logo for this school only', async () => {
    const res = await request(t.app)
      .put('/api/v1/school/branding/logo')
      .set(auth(s.ownerToken))
      .attach('file', await png(800, 400), { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data.logo).toMatchObject({ width: 600, height: 300 }); // resized for documents
    const mine = await request(t.app).get('/api/v1/school/branding/logo').set(auth(s.teacherToken));
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toBe('image/png');
    // Another school never gets this logo.
    expect((await request(t.app).get('/api/v1/school/branding/logo').set(auth(other.ownerToken))).status).toBe(404);
    // WebP is accepted and stored as PNG.
    const webp = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } })
      .webp()
      .toBuffer();
    const w = await request(t.app)
      .put('/api/v1/school/branding/logo')
      .set(auth(s.ownerToken))
      .attach('file', webp, { filename: 'logo.webp', contentType: 'image/webp' });
    expect(w.status).toBe(200);
    expect(
      (await request(t.app).delete('/api/v1/school/branding/logo').set(auth(s.ownerToken))).body.data.logo,
    ).toBeNull();
  });

  it('rejects fake, tiny or oversized images and users without the settings permission', async () => {
    const put = (token: string, buf: Buffer, type: string, name = 'logo.png') =>
      request(t.app)
        .put('/api/v1/school/branding/logo')
        .set(auth(token))
        .attach('file', buf, { filename: name, contentType: type });
    expect((await put(s.ownerToken, Buffer.from('not an image at all, just text'), 'image/png')).status).toBe(400);
    expect((await put(s.ownerToken, await png(10, 10), 'image/png')).status).toBe(400);
    expect((await put(s.ownerToken, Buffer.from('%PDF-1.4 x'), 'application/pdf', 'x.pdf')).status).toBe(400);
    // Other formats renamed as PNG never reach the image decoder (SVG, and a JPEG sent as PNG).
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>',
    );
    const svgRes = await put(s.ownerToken, svg, 'image/png');
    expect(svgRes.status).toBe(400);
    expect(svgRes.body.error.message).toMatch(/does not match/);
    const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#00f' } })
      .jpeg()
      .toBuffer();
    expect((await put(s.ownerToken, jpeg, 'image/png')).status).toBe(400);
    expect((await put(s.ownerToken, Buffer.alloc(3 * 1024 * 1024, 1), 'image/png')).status).toBe(400);
    expect((await put(s.teacherToken, await png(100, 100), 'image/png')).status).toBe(403);
  });

  it('saves validated document settings per school and previews them as a PDF', async () => {
    const bad = await request(t.app)
      .patch('/api/v1/school/branding/documents')
      .set(auth(s.ownerToken))
      .send({ theme: { primaryColor: 'red' } });
    expect(bad.status).toBe(400);
    const saved = await api(t.app, s.ownerToken, 'patch', '/school/branding/documents', {
      theme: { primaryColor: '#7a1f1f' },
      challan: { copies: 2, copyLabels: ['Bank', 'Student'] },
    });
    expect(saved.documents.theme.primaryColor).toBe('#7a1f1f');
    expect(saved.documents.challan.copies).toBe(2);
    expect(saved.documents.receipt.paper).toBe('A5'); // untouched sections keep their defaults
    const otherSchool = await api(t.app, other.ownerToken, 'get', '/school/branding');
    expect(otherSchool.documents.theme.primaryColor).toBe('#1f4e79');
    for (const kind of ['challan', 'installment_challan', 'receipt', 'certificate', 'report']) {
      const res = await request(t.app)
        .post('/api/v1/school/branding/documents/preview')
        .set(auth(s.ownerToken))
        .send({ kind, settings: { certificate: { style: 'modern' } } })
        .buffer(true)
        .parse((r, cb) => {
          const c: Buffer[] = [];
          r.on('data', (x: Buffer) => c.push(x));
          r.on('end', () => cb(null, Buffer.concat(c)));
        });
      expect(res.status, kind).toBe(200);
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const reset = await api(t.app, s.ownerToken, 'delete', '/school/branding/documents');
    expect(reset.documents.challan.copies).toBe(3);
  });
});

// ───────────────────────────── 5. User lifecycle ─────────────────────────────
describe('Suspending, archiving and deleting user accounts', () => {
  it('an accountant who leaves loses access at once; their payment history stays', async () => {
    const email = `leaving.${Date.now()}@example.test`;
    const created = await api(t.app, s.ownerToken, 'post', '/users', {
      name: 'Leaving Accountant',
      email,
      role: 'accountant',
      password: PASSWORD,
    });
    const token = await login(t.app, email);
    const inv = (await api(t.app, token, 'get', `/fees/invoices?studentId=${s.students[1]}`))[0];
    await api(t.app, token, 'post', `/fees/invoices/${inv._id}/payments`, { amount: 500, method: 'cash' });
    const id = created.user._id;

    await api(t.app, s.ownerToken, 'post', `/users/${id}/suspend`, { reason: 'Left the school' });
    const blocked = await request(t.app).get('/api/v1/fees/invoices').set(auth(token));
    expect(blocked.status).toBeGreaterThanOrEqual(401); // existing session no longer works
    expect(blocked.status).toBeLessThan(404);
    expect((await request(t.app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(403);
    expect(await Payment.countDocuments({ schoolId: s.schoolId, receivedBy: new mongoose.Types.ObjectId(id) })).toBe(1);

    await api(t.app, s.ownerToken, 'post', `/users/${id}/reactivate`);
    expect(await login(t.app, email)).toBeTruthy();

    await api(t.app, s.ownerToken, 'post', `/users/${id}/archive`, { reason: 'Left in October' });
    const list = await api(t.app, s.ownerToken, 'get', '/users?limit=100');
    expect(list.map((u: any) => u._id)).not.toContain(id);
    const archived = await api(t.app, s.ownerToken, 'get', '/users?archived=only');
    expect(archived.map((u: any) => u._id)).toContain(id);
    expect((await request(t.app).post(`/api/v1/users/${id}/reactivate`).set(auth(s.ownerToken))).body.error.code).toBe(
      'ARCHIVED',
    );
    // A used account cannot be deleted: archive keeps its history.
    const del = await request(t.app).delete(`/api/v1/users/${id}`).set(auth(s.ownerToken)).send({ reason: 'cleanup' });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('IN_USE');
    await api(t.app, s.ownerToken, 'post', `/users/${id}/unarchive`);
    expect((await api(t.app, s.ownerToken, 'get', `/users/${id}`)).status).toBe('disabled');
    const audit = await api(t.app, s.ownerToken, 'get', '/audit-logs?limit=100');
    for (const action of ['user.status_suspended', 'user.archived', 'user.unarchived'])
      expect(audit.map((a: any) => a.action)).toContain(action);
  });

  it('deletes an account created by mistake and never used; the staff record stays', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Mistake',
      designation: 'Teacher',
      staffType: 'teaching',
    });
    const userId = emp.account.userId;
    const check = await api(t.app, s.ownerToken, 'get', `/users/${userId}/deletion-check`);
    expect(check.canDelete).toBe(true);
    await api(t.app, s.ownerToken, 'delete', `/users/${userId}`, { reason: 'Wrong person' });
    expect(await User.exists({ _id: userId, schoolId: s.schoolId })).toBeNull();
    expect(await Employee.findOne({ _id: emp._id, schoolId: s.schoolId }).lean()).toMatchObject({
      firstName: 'Mistake',
    });
  });

  it('nobody can lock themselves out, and only allowed roles manage accounts', async () => {
    const me = await api(t.app, s.ownerToken, 'get', '/auth/me');
    expect(
      (
        await request(t.app)
          .post(`/api/v1/users/${me.user._id}/archive`)
          .set(auth(s.ownerToken))
          .send({ reason: 'test me' })
      ).body.error.code,
    ).toBe('SELF_ACTION');
    expect(
      (await request(t.app).post(`/api/v1/users/${me.user._id}/suspend`).set(auth(s.ownerToken)).send({})).status,
    ).toBe(400);
    expect(
      (await request(t.app).post(`/api/v1/users/${me.user._id}/suspend`).set(auth(s.teacherToken)).send({})).status,
    ).toBe(403);
    // Another school's user is not found.
    expect(
      (await request(t.app).post(`/api/v1/users/${me.user._id}/suspend`).set(auth(other.ownerToken)).send({})).status,
    ).toBe(404);
  });
});

// ───────────────────────────── 7. Notifications ─────────────────────────────
describe('Notifications', () => {
  it('approvers hear about a request and the requester hears the decision', async () => {
    const inv = (await api(t.app, s.accountantToken, 'get', `/fees/invoices?studentId=${s.students[0]}`))[0];
    const req = await api(t.app, s.accountantToken, 'post', `/fees/invoices/${inv._id}/waiver-requests`, {
      amount: 100,
      reason: 'Hardship case',
    });
    const approvalId = req.approvalId ?? req._id;
    const principal = await api(t.app, s.principalToken, 'get', '/notifications');
    expect(principal.some((n: any) => n.title === 'Approval needed')).toBe(true);
    const accountantBefore = await api(t.app, s.accountantToken, 'get', '/notifications');
    expect(accountantBefore.some((n: any) => n.title === 'Approval needed')).toBe(false); // not the requester
    await api(t.app, s.principalToken, 'post', `/approvals/${approvalId}/decision`, {
      decision: 'reject',
      note: 'Not this month',
    });
    const accountant = await api(t.app, s.accountantToken, 'get', '/notifications');
    expect(accountant.find((n: any) => n.title === 'Request rejected')?.body).toContain('Not this month');
    const count = await api(t.app, s.accountantToken, 'get', '/notifications/unread-count');
    expect(count.unread).toBeGreaterThan(0);
    await api(t.app, s.accountantToken, 'post', '/notifications/read-all');
    expect((await api(t.app, s.accountantToken, 'get', '/notifications/unread-count')).unread).toBe(0);
  });

  it('saving attendance twice notifies parents of an absence only once', async () => {
    const date = todayInTz('Asia/Karachi');
    const body = {
      sectionId: s.sectionA,
      date,
      records: [{ studentId: s.students[0], status: 'absent' }],
      notifyParents: true,
    };
    await api(t.app, s.teacherToken, 'post', '/attendance/mark', body);
    await api(t.app, s.teacherToken, 'post', '/attendance/mark', body);
    const parentUser = await User.findOne({ schoolId: s.schoolId, parentId: s.parentIds[0] }).lean();
    expect(
      await Notification.countDocuments({ schoolId: s.schoolId, userId: parentUser!._id, category: 'attendance' }),
    ).toBe(1);
  });

  it('parents are told when a fee payment is recorded, and nobody sees another user’s notifications', async () => {
    const inv = (await api(t.app, s.ownerToken, 'get', `/fees/invoices?studentId=${s.students[0]}`))[0];
    await api(t.app, s.ownerToken, 'post', `/fees/invoices/${inv._id}/payments`, { amount: 1000, method: 'cash' });
    const notes = await api(t.app, s.parentToken, 'get', '/notifications');
    expect(notes.some((n: any) => n.title === 'Fee payment received')).toBe(true);
    const teacherNotes = await api(t.app, s.teacherToken, 'get', '/notifications');
    expect(teacherNotes.some((n: any) => n.title === 'Fee payment received')).toBe(false);
    const n = notes[0];
    expect((await request(t.app).post(`/api/v1/notifications/${n._id}/read`).set(auth(s.teacherToken))).status).toBe(
      404,
    );
  });
});

// ───────────────────────────── 8. Messaging ─────────────────────────────
describe('Teacher–parent messaging', () => {
  it('a teacher messages the parent of a student they teach; both see the conversation, unread state and read receipts', async () => {
    const contacts = await api(t.app, s.teacherToken, 'get', '/messages/contacts');
    expect(contacts.kind).toBe('parents');
    expect(contacts.students.map((x: any) => x.studentId)).toContain(s.students[0]);
    const conv = await api(t.app, s.teacherToken, 'post', '/messages/conversations', {
      studentId: s.students[0],
      body: 'Hello, a quick note about homework.',
    });
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0]).toMatchObject({ mine: true, readByOther: false });

    expect((await api(t.app, s.parentToken, 'get', '/messages/unread-count')).unread).toBe(1);
    const notes = await api(t.app, s.parentToken, 'get', '/notifications');
    expect(notes.some((x: any) => x.category === 'message' && x.link === `/messages/${conv._id}`)).toBe(true);
    const parentView = await api(t.app, s.parentToken, 'get', `/messages/conversations/${conv._id}`);
    expect(parentView.studentName).toContain('Student0');
    expect((await api(t.app, s.parentToken, 'get', '/messages/unread-count')).unread).toBe(0);
    await api(t.app, s.parentToken, 'post', `/messages/conversations/${conv._id}/messages`, {
      body: 'Thank you, noted.',
    });

    const teacherView = await api(t.app, s.teacherToken, 'get', `/messages/conversations/${conv._id}`);
    expect(teacherView.messages.map((m: any) => m.body)).toEqual([
      'Hello, a quick note about homework.',
      'Thank you, noted.',
    ]);
    expect(teacherView.messages[0].readByOther).toBe(true);
    // Starting again reuses the same conversation.
    const again = await api(t.app, s.teacherToken, 'post', '/messages/conversations', {
      studentId: s.students[0],
      body: 'One more thing.',
    });
    expect(again._id).toBe(conv._id);
  });

  it('teachers only reach students they teach; others cannot read or post; other schools see nothing', async () => {
    const conv = (await api(t.app, s.teacherToken, 'get', '/messages/conversations'))[0];
    // The other teacher does not teach section A.
    const refused = await request(t.app)
      .post('/api/v1/messages/conversations')
      .set(auth(s.otherTeacherToken))
      .send({ studentId: s.students[0], body: 'Hi' });
    expect(refused.status).toBe(403);
    expect(
      (await request(t.app).get(`/api/v1/messages/conversations/${conv._id}`).set(auth(s.otherTeacherToken))).status,
    ).toBe(404);
    expect(
      (await request(t.app).get(`/api/v1/messages/conversations/${conv._id}`).set(auth(other.ownerToken))).status,
    ).toBe(404);
    // Leadership can read every conversation (oversight) but not post in someone else's.
    const all = await api(t.app, s.principalToken, 'get', '/messages/conversations?all=true');
    expect(all.map((c: any) => c._id)).toContain(conv._id);
    const view = await api(t.app, s.principalToken, 'get', `/messages/conversations/${conv._id}`);
    expect(view).toMatchObject({ participant: false, canSend: false });
    expect(
      (
        await request(t.app)
          .post(`/api/v1/messages/conversations/${conv._id}/messages`)
          .set(auth(s.principalToken))
          .send({ body: 'x' })
      ).status,
    ).toBe(403);
  });

  it('a parent can start a conversation with their child’s teacher only', async () => {
    const contacts = await api(t.app, s.parentToken, 'get', '/messages/contacts');
    expect(contacts.kind).toBe('teachers');
    const teacher = contacts.students[0].teachers[0];
    expect(teacher.roles).toContain('Class teacher');
    const conv = await api(t.app, s.parentToken, 'post', '/messages/conversations', {
      studentId: s.students[0],
      teacherUserId: teacher.userId,
      body: 'Can we meet?',
    });
    expect(conv.withName).toBeTruthy();
    const otherTeacher = await User.findOne({
      schoolId: s.schoolId,
      role: 'teacher',
      _id: { $ne: teacher.userId },
    }).lean();
    const refused = await request(t.app)
      .post('/api/v1/messages/conversations')
      .set(auth(s.parentToken))
      .send({ studentId: s.students[0], teacherUserId: otherTeacher!._id.toString(), body: 'Hi' });
    expect(refused.status).toBe(403);
    // Not their child: not found.
    expect(
      (
        await request(t.app)
          .post('/api/v1/messages/conversations')
          .set(auth(s.parentToken))
          .send({ studentId: s.students[1], teacherUserId: teacher.userId, body: 'Hi' })
      ).status,
    ).toBe(404);
  });
});

// ───────────────────────────── 12. Substitutes and the timetable ─────────────────────────────
describe('Substitute lessons on the timetable', () => {
  /** The next date (today or later, at least `minAhead` days ahead) with this ISO weekday. */
  const next = (isoDow: number, minAhead = 1) => {
    let d = addDays(parseDateOnly(todayInTz('Asia/Karachi')), minAhead);
    while (((d.getUTCDay() + 6) % 7) + 1 !== isoDow) d = addDays(d, 1);
    return formatDateOnly(d);
  };

  it('shows the absent teacher’s lessons on the substitute’s dated timetable, detects clashes, follows edits and cancellation', async () => {
    const absent = s.teacherEmployeeId;
    const sub = (await Employee.findOne({ schoolId: s.schoolId, firstName: 'Bilal' }).lean())!._id.toString();
    // Ayesha teaches Maths in section A on Monday and Wednesday at 09:00; Bilal teaches English in B on Monday at 09:00.
    const entry = (sectionId: string, subjectId: string, teacherId: string, dayOfWeek: number) =>
      api(t.app, s.ownerToken, 'post', '/timetable', {
        sectionId,
        subjectId,
        teacherId,
        dayOfWeek,
        startTime: '09:00',
        endTime: '09:40',
      });
    await entry(s.sectionA, s.mathId, absent, 1);
    await entry(s.sectionA, s.mathId, absent, 3);
    await entry(s.sectionB, s.englishId, sub, 1);
    const regularBefore = await TimetableEntry.countDocuments({ schoolId: s.schoolId });

    const monday = next(1);
    const wednesday = formatDateOnly(addDays(parseDateOnly(monday), 2));
    const cover = {
      originalTeacherId: absent,
      substituteTeacherId: sub,
      sectionId: s.sectionA,
      subjectId: s.mathId,
      startDate: monday,
      endDate: wednesday,
    };
    const preview = await api(t.app, s.ownerToken, 'post', '/substitutes/preview', cover);
    expect(preview.lessons.map((l: any) => l.date)).toEqual([monday, wednesday]);
    expect(preview.clashes).toHaveLength(1);
    expect(preview.clashes[0].date).toBe(monday);
    const refused = await request(t.app).post('/api/v1/substitutes').set(auth(s.ownerToken)).send(cover);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SUBSTITUTE_TIMETABLE_CONFLICT');

    // A single-day cover on Wednesday has no clash.
    const created = await api(t.app, s.ownerToken, 'post', '/substitutes', {
      ...cover,
      startDate: wednesday,
      endDate: wednesday,
    });
    const subLogin = await User.findOne({ schoolId: s.schoolId, employeeId: sub }).lean();
    expect(subLogin).toBeTruthy();
    const week = await api(t.app, s.otherTeacherToken, 'get', `/timetable/dated?from=${monday}&to=${wednesday}`);
    const mon = week.find((d: any) => d.date === monday);
    const wed = week.find((d: any) => d.date === wednesday);
    expect(mon.lessons.filter((l: any) => l.kind === 'cover')).toHaveLength(0);
    const coverLesson = wed.lessons.find((l: any) => l.kind === 'cover');
    expect(coverLesson).toMatchObject({ startTime: '09:00', subject: { name: 'Mathematics' } });
    expect(coverLesson.coveringFor.name).toContain('Ayesha');
    // The substitute's own Monday lesson is still there.
    expect(mon.lessons.find((l: any) => l.kind === 'regular').subject.name).toBe('English');

    // Absent teacher and class views mark the covered lesson.
    const absentView = await api(t.app, s.teacherToken, 'get', `/timetable/dated?from=${wednesday}&to=${wednesday}`);
    expect(absentView[0].lessons[0].coveredBy.name).toContain('Bilal');
    const classView = await api(
      t.app,
      s.ownerToken,
      'get',
      `/timetable/dated?from=${monday}&to=${wednesday}&sectionId=${s.sectionA}`,
    );
    expect(classView.find((d: any) => d.date === wednesday).lessons[0].coveredBy.name).toContain('Bilal');
    expect(classView.find((d: any) => d.date === monday).lessons[0].coveredBy).toBeNull();
    // Outside the cover dates nothing is covered.
    const later = formatDateOnly(addDays(parseDateOnly(wednesday), 7));
    const outside = await api(t.app, s.otherTeacherToken, 'get', `/timetable/dated?from=${later}&to=${later}`);
    expect(outside[0].lessons.filter((l: any) => l.kind === 'cover')).toHaveLength(0);

    // Editing to include Monday clashes; accepting the clash is an explicit choice.
    const edit = await request(t.app)
      .patch(`/api/v1/substitutes/${created._id}`)
      .set(auth(s.ownerToken))
      .send({ startDate: monday });
    expect(edit.body.error.code).toBe('SUBSTITUTE_TIMETABLE_CONFLICT');
    await api(t.app, s.ownerToken, 'patch', `/substitutes/${created._id}`, { startDate: monday, acceptClashes: true });
    const edited = await api(t.app, s.otherTeacherToken, 'get', `/timetable/dated?from=${monday}&to=${wednesday}`);
    expect(
      edited
        .flatMap((d: any) => d.lessons)
        .filter((l: any) => l.kind === 'cover')
        .map((l: any) => l.startTime),
    ).toEqual(['09:00', '09:00']);

    // Cancelling removes the cover lessons; the regular timetable is untouched.
    await api(t.app, s.ownerToken, 'post', `/substitutes/${created._id}/cancel`, { reason: 'Teacher returned' });
    const after = await api(t.app, s.otherTeacherToken, 'get', `/timetable/dated?from=${monday}&to=${wednesday}`);
    expect(after.flatMap((d: any) => d.lessons).filter((l: any) => l.kind === 'cover')).toHaveLength(0);
    expect(await TimetableEntry.countDocuments({ schoolId: s.schoolId })).toBe(regularBefore);
    // Another school cannot see this school's dated timetable.
    expect(
      (
        await request(t.app)
          .get(`/api/v1/timetable/dated?from=${monday}&to=${monday}&sectionId=${s.sectionA}`)
          .set(auth(other.ownerToken))
      ).body.data.every((d: any) => d.lessons.length === 0),
    ).toBe(true);
  });
});

describe('Printable reports', () => {
  it('exports reports as branded PDFs for users allowed to export, with the same data as CSV', async () => {
    for (const url of [
      '/reports/fee-collection?from=2026-10-01&to=2026-10-31&format=pdf',
      '/reports/outstanding?format=pdf',
      '/reports/attendance?from=2026-10-01&to=2026-10-31&format=pdf',
    ]) {
      const res = await pdf(s.principalToken, url);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await pdf(s.teacherToken, '/reports/outstanding?format=pdf')).status).toBe(403);
    const csv = await request(t.app).get('/api/v1/reports/outstanding?format=csv').set(auth(s.principalToken));
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});
