import { beforeAll, describe, expect, it } from 'vitest';
import { activateAndLogin, PASSWORD, userToken } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { useTestApp } from './helpers';

/**
 * Announcement list and detail are filtered on the server by the same audience rules as
 * delivery: role, and for parents the class/section/campus of one of their children. Drafts and
 * announcements awaiting approval are only for senders (and approvers for the latter).
 */
const t = useTestApp();
let f: SchoolFixture;
let parentA: string; // child in Class 5 A
let parentB: string; // child in Class 5 B
let class6: string;
let campus2: string;
const ids: Record<string, string> = {};

async function publish(title: string, audience: Record<string, unknown>) {
  const ann = await api(t.app, f.ownerToken, 'post', '/communications/announcements', {
    title,
    body: `${title} body`,
    audience,
    channels: ['in_app'],
  });
  await api(t.app, f.ownerToken, 'post', `/communications/announcements/${ann._id}/publish`);
  return ann._id as string;
}

const list = async (token: string, query = '') =>
  ((await api(t.app, token, 'get', `/communications/announcements?limit=100${query}`)) as Array<{ _id: string }>).map(
    (a) => a._id,
  );
const detailStatus = async (token: string, id: string) =>
  (
    await (
      await import('supertest')
    )
      .default(t.app)
      .get(`/api/v1/communications/announcements/${id}`)
      .set({ Authorization: `Bearer ${token}` })
  ).status;

beforeAll(async () => {
  f = await buildSchool(t.app, { students: 4 }); // students 0,1 in section A; 2,3 in section B
  parentA = f.parentToken;
  const accountB = f.admissionAccounts[2].find((a: { role: string }) => a.role === 'parent');
  parentB = await activateAndLogin(t.app, accountB, PASSWORD, f.code);
  class6 = (
    await api(t.app, f.ownerToken, 'post', '/academics/classes', { campusId: f.campusId, name: 'Class 6', level: 6 })
  )._id;
  // The test plan allows one campus; a second one is created directly for targeting tests.
  const { Campus } = await import('../src/modules/campuses/campus.model');
  campus2 = (await Campus.create({ schoolId: f.schoolId, name: 'North campus', code: 'N2' }))._id.toString();

  ids.allParents = await publish('All parents', { roles: ['parent'] });
  ids.class5 = await publish('Class 5 parents', { roles: ['parent'], classIds: [f.classId] });
  ids.class6 = await publish('Class 6 parents', { roles: ['parent'], classIds: [class6] });
  ids.sectionA = await publish('Section A parents', { roles: ['parent'], sectionIds: [f.sectionA] });
  ids.sectionB = await publish('Section B parents', { roles: ['parent'], sectionIds: [f.sectionB] });
  ids.campus1 = await publish('Main campus parents', { roles: ['parent'], campusIds: [f.campusId] });
  ids.campus2 = await publish('North campus parents', { roles: ['parent'], campusIds: [campus2] });
  ids.teachers = await publish('Teachers only', { roles: ['teacher'] });
  ids.draft = (
    await api(t.app, f.ownerToken, 'post', '/communications/announcements', {
      title: 'Draft for parents',
      body: 'Not published yet',
      audience: { roles: ['parent', 'teacher'] },
    })
  )._id;
});

describe('parents', () => {
  it('see only announcements whose class, section and campus targets match their child', async () => {
    const seen = await list(parentA);
    expect(seen).toEqual(expect.arrayContaining([ids.allParents, ids.class5, ids.sectionA, ids.campus1]));
    for (const hidden of [ids.class6, ids.sectionB, ids.campus2, ids.teachers, ids.draft])
      expect(seen).not.toContain(hidden);
  });

  it('the other section sees its own and not section A', async () => {
    const seen = await list(parentB);
    expect(seen).toContain(ids.sectionB);
    expect(seen).not.toContain(ids.sectionA);
  });

  it('cannot open another class, section, campus, role or a draft by id (404)', async () => {
    for (const id of [ids.class6, ids.sectionB, ids.campus2, ids.teachers, ids.draft])
      expect(await detailStatus(parentA, id)).toBe(404);
    expect(await detailStatus(parentA, ids.sectionA)).toBe(200);
  });

  it('a status filter cannot widen what they see', async () => {
    expect(await list(parentA, '&status=draft')).toEqual([]);
    expect(await list(parentA, '&status=published')).not.toContain(ids.class6);
  });

  it('pagination never reveals hidden announcements', async () => {
    const pages: string[] = [];
    for (let page = 1; page <= 5; page++) {
      pages.push(
        ...(
          (await api(t.app, parentA, 'get', `/communications/announcements?limit=2&page=${page}`)) as Array<{
            _id: string;
          }>
        ).map((a) => a._id),
      );
    }
    expect(new Set(pages)).toEqual(new Set(await list(parentA)));
  });

  it('a parent whose children are in two classes sees both', async () => {
    // Enrol a second child of parent A into Class 6.
    const secC6 = await api(t.app, f.ownerToken, 'post', '/academics/sections', {
      classId: class6,
      sessionId: f.sessionId,
      name: 'A',
      capacity: 30,
    });
    await api(t.app, f.ownerToken, 'post', '/students', {
      campusId: f.campusId,
      firstName: 'Sibling',
      lastName: 'Test',
      gender: 'male',
      sessionId: f.sessionId,
      classId: class6,
      sectionId: secC6._id,
      guardians: [{ parentId: f.parentIds[0], relation: 'father', isPrimary: true }],
    });
    const seen = await list(parentA);
    expect(seen).toEqual(expect.arrayContaining([ids.class5, ids.class6]));
  });
});

describe('staff', () => {
  it('teachers without send permission see published announcements for their role only', async () => {
    const seen = await list(f.teacherToken);
    expect(seen).toContain(ids.teachers);
    expect(seen).not.toContain(ids.allParents);
    expect(seen).not.toContain(ids.draft);
    expect(await list(f.teacherToken, '&status=draft')).toEqual([]);
    expect(await detailStatus(f.teacherToken, ids.draft)).toBe(404);
    expect(await detailStatus(f.teacherToken, ids.allParents)).toBe(404);
  });

  it('senders still see every status (regression)', async () => {
    const seen = await list(f.adminToken);
    expect(seen).toEqual(expect.arrayContaining([ids.draft, ids.class6, ids.teachers]));
    expect(await detailStatus(f.adminToken, ids.draft)).toBe(200);
  });

  it('an approver without send permission sees announcements awaiting approval, not drafts', async () => {
    const { Announcement } = await import('../src/modules/communications/communications.models');
    const pendingId = (
      await api(t.app, f.ownerToken, 'post', '/communications/announcements', {
        title: 'Pending one',
        body: 'Needs approval',
        audience: { roles: ['principal'] },
      })
    )._id;
    await Announcement.updateOne({ _id: pendingId, schoolId: f.schoolId }, { $set: { status: 'pending_approval' } });
    // A custom-role user with approvals:decide but not communications:send.
    const role = await api(t.app, f.ownerToken, 'post', '/roles', {
      name: 'Approver',
      permissions: ['communications:read', 'approvals:read', 'approvals:decide'],
    });
    const approver = await userToken(t.app, f.schoolId, 'staff');
    const { User } = await import('../src/modules/users/user.model');
    await User.updateOne({ _id: approver.userId, schoolId: f.schoolId }, { $set: { customRoleId: role._id } });
    const { login } = await import('./helpers');
    const token = await login(t.app, approver.email);
    // Their own role is "staff", so audience-for-principal items stay hidden; only role-matched ones show.
    await api(t.app, f.ownerToken, 'patch', `/communications/announcements/${ids.draft}`, {
      audience: { roles: ['staff'] },
    });
    await Announcement.updateOne({ _id: pendingId, schoolId: f.schoolId }, { $set: { 'audience.roles': ['staff'] } });
    const seen = await list(token);
    expect(seen).toContain(pendingId);
    expect(seen).not.toContain(ids.draft);
  });

  it('campus-restricted staff do not see announcements for other campuses', async () => {
    const restricted = await userToken(t.app, f.schoolId, 'teacher', { campusIds: [f.campusId] });
    const forC2 = await publish('Teachers, north campus', { roles: ['teacher'], campusIds: [campus2] });
    const forC1 = await publish('Teachers, main campus', { roles: ['teacher'], campusIds: [f.campusId] });
    const seen = await list(restricted.token);
    expect(seen).toContain(forC1);
    expect(seen).not.toContain(forC2);
  });
});

describe('delivery is unchanged', () => {
  it('only the targeted parents get the in-app notification', async () => {
    const id = await publish('Section B trip', { roles: ['parent'], sectionIds: [f.sectionB] });
    const notesA = (await api(t.app, parentA, 'get', '/notifications?limit=100')) as Array<{ link?: string }>;
    const notesB = (await api(t.app, parentB, 'get', '/notifications?limit=100')) as Array<{ link?: string }>;
    expect(notesB.some((n) => n.link === `/announcements/${id}`)).toBe(true);
    expect(notesA.some((n) => n.link === `/announcements/${id}`)).toBe(false);
  });
});
