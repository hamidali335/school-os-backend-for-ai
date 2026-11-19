import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { studentSearchFilter } from '../src/modules/messaging/messaging.service';
import { invoiceIsOverdue } from '../src/modules/fees/fees.service';
import { auth, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/** Contact search, messaging roles, homework class names, list isOverdue, section capabilities. */
const t = useTestApp();
let f: SchoolFixture;
const today = todayInTz('Asia/Karachi');
const day = (n: number) => formatDateOnly(addDays(parseDateOnly(today), n));

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 4 }); // Student0..3 "Test"; Ayesha teaches Maths in A
});

describe('contact search', () => {
  it('every word must match: full names work, single words behave as before', () => {
    expect(studentSearchFilter('')).toEqual({});
    expect(studentSearchFilter('  Rida   Javed ')).toMatchObject({ $and: [expect.any(Object), expect.any(Object)] });
    expect((studentSearchFilter('a b c d e f g').$and as unknown[]).length).toBe(5);
  });

  it('regex characters are escaped (no injection, no crash)', async () => {
    const res = await request(t.app)
      .get('/api/v1/messages/contacts?q=' + encodeURIComponent('(.*'))
      .set(auth(f.ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.students).toEqual([]);
  });

  it('"Student0 Test" finds exactly that student; "Test" still finds all', async () => {
    const full = await api(t.app, f.ownerToken, 'get', `/messages/contacts?q=${encodeURIComponent('Student0 Test')}`);
    expect(full.students.map((s: { name: string }) => s.name)).toEqual(['Student0 Test']);
    const one = await api(t.app, f.ownerToken, 'get', '/messages/contacts?q=Test');
    expect(one.students).toHaveLength(4);
  });

  it('a teacher still only finds students in their own sections', async () => {
    const res = await api(t.app, f.teacherToken, 'get', `/messages/contacts?q=${encodeURIComponent('Student2 Test')}`);
    expect(res.students).toEqual([]); // Student2 is in section B, Ayesha teaches A
  });
});

describe('messaging roles', () => {
  it('accountants get 403 on the conversation list and unread count, not an empty list', async () => {
    for (const url of ['/api/v1/messages/conversations', '/api/v1/messages/unread-count']) {
      const res = await request(t.app).get(url).set(auth(f.accountantToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('teachers, parents and leadership still list conversations', async () => {
    for (const token of [f.teacherToken, f.parentToken, f.principalToken, f.adminToken]) {
      expect((await request(t.app).get('/api/v1/messages/conversations').set(auth(token))).status).toBe(200);
    }
  });
});

describe('homework class names', () => {
  it('list and detail include the class name; sectionId.classId stays an id', async () => {
    const hw = await api(t.app, f.teacherToken, 'post', '/homework', {
      sectionId: f.sectionA,
      subjectId: f.mathId,
      title: 'Fractions',
      description: 'Exercise 4.2',
      dueDate: day(3),
    });
    const list = await api(t.app, f.parentToken, 'get', '/homework');
    const row = list.find((h: { _id: string }) => h._id === hw._id);
    expect(row.className).toBe('Class 5');
    expect(typeof row.sectionId.classId).toBe('string');
    const detail = await api(t.app, f.parentToken, 'get', `/homework/${hw._id}`);
    expect(detail.className).toBe('Class 5');
  });
});

describe('invoice isOverdue', () => {
  it('follows the detail rule exactly', () => {
    const now = parseDateOnly('2026-10-25');
    const past = parseDateOnly('2026-10-10');
    const future = parseDateOnly('2026-11-10');
    expect(invoiceIsOverdue({ balance: 100, status: 'unpaid', dueDate: past }, now)).toBe(true);
    expect(invoiceIsOverdue({ balance: 100, status: 'partial', dueDate: past }, now)).toBe(true);
    expect(invoiceIsOverdue({ balance: 0, status: 'paid', dueDate: past }, now)).toBe(false);
    expect(invoiceIsOverdue({ balance: 100, status: 'waived', dueDate: past }, now)).toBe(false);
    expect(invoiceIsOverdue({ balance: 100, status: 'unpaid', dueDate: future }, now)).toBe(false);
    expect(invoiceIsOverdue({ balance: 100, status: 'unpaid', dueDate: now }, now)).toBe(false); // due today
  });

  it('list rows agree with the detail endpoint', async () => {
    await api(t.app, f.ownerToken, 'post', '/fees/invoices/generate', { period: today.slice(0, 7) });
    const rows = await api(t.app, f.ownerToken, 'get', '/fees/invoices?limit=50');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows.slice(0, 5)) {
      expect(typeof r.isOverdue).toBe('boolean');
      const d = await api(t.app, f.ownerToken, 'get', `/fees/invoices/${r._id}`);
      expect(r.isOverdue).toBe(d.isOverdue);
    }
  });
});

describe('section capabilities for substitutes', () => {
  it('a homework-only cover lists the section without attendance, and saving attendance is refused', async () => {
    const ayeshaId = f.teacherEmployeeId;
    const bilalId = (await api(t.app, f.otherTeacherToken, 'get', '/auth/me')).user.employeeId;
    await api(t.app, f.ownerToken, 'post', '/substitutes', {
      originalTeacherId: ayeshaId,
      substituteTeacherId: bilalId,
      sectionId: f.sectionA,
      subjectId: f.mathId,
      startDate: today,
      endDate: day(1),
      reason: 'Workshop',
      capabilities: ['homework'],
    });
    const mine = await api(t.app, f.otherTeacherToken, 'get', '/academics/my-sections');
    const secA = mine.find((s: { _id: string }) => s._id === f.sectionA);
    expect(secA.capabilities).toEqual(['homework', 'view']);

    const roster = await api(t.app, f.otherTeacherToken, 'get', `/attendance/sections/${f.sectionA}?date=${today}`);
    const res = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(f.otherTeacherToken))
      .send({
        sectionId: f.sectionA,
        date: today,
        records: [{ studentId: roster.students[0].studentId, status: 'present' }],
      });
    expect(res.status).toBe(403);
  });

  it('the class teacher gets every capability for their section', async () => {
    const mine = await api(t.app, f.teacherToken, 'get', '/academics/my-sections');
    expect(mine.find((s: { _id: string }) => s._id === f.sectionA).capabilities).toEqual([
      'attendance',
      'homework',
      'marks',
      'view',
    ]);
  });
});
