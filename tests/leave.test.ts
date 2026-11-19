import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../src/utils/dates';
import { AuditLog } from '../src/modules/audit/audit.model';
import { LeaveRequest } from '../src/modules/leave/leave.model';
import { activateAndLogin, auth, PASSWORD, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Leave requests: parents for their own children; class teachers review; administrators decide
 * (never their own); history and audit for every step; no automatic attendance.
 */
const t = useTestApp();
let f: SchoolFixture;
let other: SchoolFixture;
let parentB: string; // parent of Student2 (section B)
const today = todayInTz('Asia/Karachi');
const day = (n: number) => formatDateOnly(addDays(parseDateOnly(today), n));
let offset = 10; // each test uses fresh dates so overlap rules do not interfere

const call = (token: string, method: 'get' | 'post', url: string, body?: object) =>
  (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body);

async function submit(token: string, studentId: string, from = day(offset), to = day(offset + 1)) {
  offset += 3;
  return call(token, 'post', '/leave-requests', { studentId, from, to, reason: 'Family wedding in Lahore' });
}

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 4 }); // 0,1 in A (Ayesha class teacher); 2,3 in B
  other = await buildSchool(t.app, { students: 1 });
  const accountB = f.admissionAccounts[2].find((a: { role: string }) => a.role === 'parent');
  parentB = await activateAndLogin(t.app, accountB, PASSWORD, f.code);
});

describe('submitting', () => {
  it('a parent requests leave for their own child; history, audit and notification are recorded', async () => {
    const res = await submit(f.parentToken, f.students[0]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'pending', days: 2, reason: 'Family wedding in Lahore' });
    expect(res.body.data.history).toEqual([expect.objectContaining({ action: 'submitted', byRole: 'parent' })]);
    expect(
      await AuditLog.exists({ schoolId: f.schoolId, action: 'leave.submit', entityId: res.body.data._id }),
    ).toBeTruthy();
    const notes = await api(t.app, f.teacherToken, 'get', '/notifications?limit=50');
    expect(notes.some((n: { link?: string }) => n.link === `/leave-requests/${res.body.data._id}`)).toBe(true);
  });

  it("a parent cannot request leave for another family's child (404)", async () => {
    const res = await submit(f.parentToken, f.students[2]);
    expect(res.status).toBe(404);
  });

  it('staff cannot submit (parents only)', async () => {
    for (const token of [f.teacherToken, f.ownerToken, f.accountantToken]) {
      expect((await submit(token, f.students[0])).status).toBe(403);
    }
  });

  it('dates are validated: order, length, how far back and ahead', async () => {
    const bad = [
      { from: day(5), to: day(4) },
      { from: day(1), to: day(31) },
      { from: day(-8), to: day(-8) },
      { from: day(121), to: day(121) },
      { from: '2026-02-30', to: '2026-03-01' },
    ];
    for (const b of bad) {
      const res = await call(f.parentToken, 'post', '/leave-requests', {
        studentId: f.students[0],
        ...b,
        reason: 'Testing dates',
      });
      expect(res.status).toBe(400);
    }
    expect(
      (
        await call(f.parentToken, 'post', '/leave-requests', {
          studentId: f.students[0],
          from: day(-7),
          to: day(-7),
          reason: 'Fever last week',
        })
      ).status,
    ).toBe(201);
  });

  it('overlapping requests are refused; adjacent ones are fine', async () => {
    const first = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: day(90),
      to: day(92),
      reason: 'Trip one',
    });
    expect(first.status).toBe(201);
    const overlap = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: day(92),
      to: day(94),
      reason: 'Trip two',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
    const adjacent = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: day(95),
      to: day(95),
      reason: 'Next day',
    });
    expect(adjacent.status).toBe(201);
  });

  it('simultaneous duplicate submissions create exactly one request', async () => {
    const body = { studentId: f.students[0], from: day(100), to: day(101), reason: 'Double tap' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(f.parentToken, 'post', '/leave-requests', body)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(
      await LeaveRequest.countDocuments({
        schoolId: f.schoolId,
        studentId: f.students[0],
        from: parseDateOnly(day(100)),
      }),
    ).toBe(1);
  });
});

describe('who can see what', () => {
  let idA: string;
  let idB: string;
  beforeAll(async () => {
    idA = (await submit(f.parentToken, f.students[0])).body.data._id;
    idB = (await submit(parentB, f.students[2])).body.data._id;
  });

  it("parents see only their own children's requests", async () => {
    const mine = (await api(t.app, f.parentToken, 'get', '/leave-requests?limit=100')).map(
      (r: { _id: string }) => r._id,
    );
    expect(mine).toContain(idA);
    expect(mine).not.toContain(idB);
    expect((await call(f.parentToken, 'get', `/leave-requests/${idB}`)).status).toBe(404);
  });

  it('the class teacher sees their section only; another teacher sees nothing', async () => {
    const ayesha = (await api(t.app, f.teacherToken, 'get', '/leave-requests?limit=100')).map(
      (r: { _id: string }) => r._id,
    );
    expect(ayesha).toContain(idA);
    expect(ayesha).not.toContain(idB);
    expect((await call(f.teacherToken, 'get', `/leave-requests/${idB}`)).status).toBe(404);
    expect(await api(t.app, f.otherTeacherToken, 'get', '/leave-requests')).toEqual([]);
  });

  it('administrators see all; accountants have no access', async () => {
    const all = (await api(t.app, f.principalToken, 'get', '/leave-requests?limit=100')).map(
      (r: { _id: string }) => r._id,
    );
    expect(all).toEqual(expect.arrayContaining([idA, idB]));
    expect((await call(f.accountantToken, 'get', '/leave-requests')).status).toBe(403);
  });

  it('class and section filters narrow the list and never widen what a user may see', async () => {
    const ids = async (token: string, qs: string) =>
      (await api(t.app, token, 'get', `/leave-requests?limit=100&${qs}`)).map((r: { _id: string }) => r._id);
    const inA = await ids(f.principalToken, `sectionId=${f.sectionA}`);
    expect(inA).toContain(idA);
    expect(inA).not.toContain(idB);
    expect(await ids(f.principalToken, `sectionId=${f.sectionB}`)).toEqual(expect.arrayContaining([idB]));
    expect(await ids(f.principalToken, `classId=${f.classId}`)).toEqual(expect.arrayContaining([idA, idB]));
    // Ayesha is class teacher of A only: asking for B gives nothing, not B's requests.
    expect(await ids(f.teacherToken, `sectionId=${f.sectionB}`)).toEqual([]);
    expect(await ids(f.parentToken, `classId=${f.classId}`)).not.toContain(idB);
    expect((await call(f.principalToken, 'get', '/leave-requests?sectionId=not-an-id')).status).toBe(400);
  });

  it('another school can never see or decide them (tenant isolation)', async () => {
    expect((await call(other.ownerToken, 'get', `/leave-requests/${idA}`)).status).toBe(404);
    expect(
      (await call(other.ownerToken, 'post', `/leave-requests/${idA}/decision`, { decision: 'approve' })).status,
    ).toBe(404);
    expect(
      (await api(t.app, other.ownerToken, 'get', '/leave-requests')).map((r: { _id: string }) => r._id),
    ).not.toContain(idA);
  });
});

describe('review and decision', () => {
  it('the class teacher can add a review note but cannot approve or reject', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    const reviewed = await call(f.teacherToken, 'post', `/leave-requests/${id}/review`, {
      note: 'Parent told me in person',
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.status).toBe('pending');
    expect(reviewed.body.data.history.map((h: { action: string }) => h.action)).toEqual(['submitted', 'reviewed']);
    expect((await call(f.teacherToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' })).status).toBe(
      403,
    );
    // Not this section's class teacher: 404 on review.
    expect((await call(f.otherTeacherToken, 'post', `/leave-requests/${id}/review`, { note: 'Hmm' })).status).toBe(404);
  });

  it('administrators approve with a note; the parent is told; history and audit are kept', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    const res = await call(f.adminToken, 'post', `/leave-requests/${id}/decision`, {
      decision: 'approve',
      note: 'Enjoy the wedding',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', decisionNote: 'Enjoy the wedding' });
    expect(res.body.data.decidedByName).toBeTruthy();
    expect(res.body.data.history.at(-1)).toMatchObject({
      action: 'approved',
      note: 'Enjoy the wedding',
      byRole: 'school_admin',
    });
    expect(await AuditLog.exists({ schoolId: f.schoolId, action: 'leave.approved', entityId: id })).toBeTruthy();
    const notes = await api(t.app, f.parentToken, 'get', '/notifications?limit=50');
    expect(
      notes.some(
        (n: { title: string; link?: string }) => n.title === 'Leave approved' && n.link === `/leave-requests/${id}`,
      ),
    ).toBe(true);
  });

  it('accountants and parents cannot decide', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    expect(
      (await call(f.accountantToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' })).status,
    ).toBe(403);
    expect((await call(f.parentToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' })).status).toBe(
      403,
    );
  });

  it('nobody decides their own request', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    // Simulate a request recorded as the principal's own (e.g. a principal who is also a guardian).
    const me = await api(t.app, f.principalToken, 'get', '/auth/me');
    await LeaveRequest.updateOne({ _id: id, schoolId: f.schoolId }, { $set: { requestedBy: me.user._id } });
    const res = await call(f.principalToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' });
    expect(res.status).toBe(403);
  });

  it('only one decision is ever recorded, even when two administrators decide at once', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    const [a, b] = await Promise.all([
      call(f.principalToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' }),
      call(f.adminToken, 'post', `/leave-requests/${id}/decision`, { decision: 'reject' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const doc = await LeaveRequest.findOne({ _id: id, schoolId: f.schoolId }).lean();
    expect(doc!.history.filter((h) => h.action === 'approved' || h.action === 'rejected')).toHaveLength(1);
  });

  it('invalid transitions are refused', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    await api(t.app, f.adminToken, 'post', `/leave-requests/${id}/decision`, {
      decision: 'reject',
      note: 'Exams that week',
    });
    expect((await call(f.adminToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' })).status).toBe(
      409,
    );
    expect((await call(f.parentToken, 'post', `/leave-requests/${id}/cancel`, {})).status).toBe(409);
    expect((await call(f.teacherToken, 'post', `/leave-requests/${id}/review`, { note: 'Late note' })).status).toBe(
      409,
    );
  });
});

describe('cancelling', () => {
  it('the parent who asked can withdraw a pending request; another parent cannot', async () => {
    const id = (await submit(f.parentToken, f.students[0])).body.data._id;
    expect((await call(parentB, 'post', `/leave-requests/${id}/cancel`, {})).status).toBe(404);
    expect((await call(f.teacherToken, 'post', `/leave-requests/${id}/cancel`, {})).status).toBe(403);
    const res = await call(f.parentToken, 'post', `/leave-requests/${id}/cancel`, { note: 'Plans changed' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    // A cancelled request no longer blocks new requests for the same dates.
    const again = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: res.body.data.from.slice(0, 10),
      to: res.body.data.to.slice(0, 10),
      reason: 'Back on again',
    });
    expect(again.status).toBe(201);
  });
});

describe('attendance register', () => {
  it('shows approved leave as a hint and never marks anyone automatically', async () => {
    const res = await call(f.parentToken, 'post', '/leave-requests', {
      studentId: f.students[0],
      from: today,
      to: today,
      reason: 'Doctor appointment',
    });
    const id = res.status === 201 ? res.body.data._id : undefined;
    if (id) await api(t.app, f.adminToken, 'post', `/leave-requests/${id}/decision`, { decision: 'approve' });
    const roster = await api(t.app, f.teacherToken, 'get', `/attendance/sections/${f.sectionA}?date=${today}`);
    const row = roster.students.find((s: { studentId: string }) => s.studentId === f.students[0]);
    expect(row.onApprovedLeave).toBe(true);
    expect(row.status).toBeNull(); // not marked
    const otherRow = roster.students.find((s: { studentId: string }) => s.studentId === f.students[1]);
    expect(otherRow.onApprovedLeave).toBe(false);
  });
});
