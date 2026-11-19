import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Section, TeachingAssignment } from '../src/modules/academics/academics.models';
import { Employee } from '../src/modules/employees/employee.model';
import { AccountToken, User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

const addTeacher = (fx: SchoolFixture, firstName: string) =>
  api(t.app, fx.ownerToken, 'post', '/employees', {
    campusId: fx.campusId,
    firstName,
    designation: 'Teacher',
    staffType: 'teaching',
  });

describe('Deleting a staff member added by mistake', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 1 });
    other = await buildSchool(t.app, { students: 1 });
  });

  it('deletes an unused teacher with their pending login and setup, after showing what goes', async () => {
    const emp = await addTeacher(s, 'Wrong Entry');
    await api(t.app, s.ownerToken, 'post', '/academics/teaching-assignments', {
      sectionId: s.sectionB,
      subjectId: s.englishId,
      teacherId: emp._id,
    });
    await api(t.app, s.ownerToken, 'patch', `/academics/sections/${s.sectionB}`, { classTeacherId: emp._id });

    const check = await api(t.app, s.ownerToken, 'get', `/employees/${emp._id}/deletion-check`);
    expect(check).toMatchObject({ canDelete: true, blockers: [] });
    expect(check.willRemove).toMatchObject({ teachingAssignments: 1, classTeacherOf: [expect.any(String)] });
    expect(check.willRemove.login).toBeTruthy();

    await api(t.app, s.ownerToken, 'delete', `/employees/${emp._id}`, { reason: 'Added the wrong person' });

    expect(await Employee.countDocuments({ _id: emp._id }).setOptions({ crossTenant: true } as never)).toBe(0);
    expect(await User.countDocuments({ _id: emp.account.userId }).setOptions({ crossTenant: true } as never)).toBe(0);
    expect(
      await AccountToken.countDocuments({ userId: emp.account.userId }).setOptions({ crossTenant: true } as never),
    ).toBe(0);
    expect(
      await TeachingAssignment.countDocuments({ teacherId: emp._id }).setOptions({ crossTenant: true } as never),
    ).toBe(0);
    const section = await Section.findById(s.sectionB)
      .setOptions({ crossTenant: true } as never)
      .lean();
    expect(section?.classTeacherId).toBeUndefined();

    // The activation link sent earlier no longer works.
    const inspect = await request(t.app)
      .post('/api/v1/auth/account-link/inspect')
      .send({ token: emp.account.activation.token });
    expect(inspect.body.error.code).toBe('INVALID_TOKEN');

    // The deletion is audited with the reason.
    const audit = await api(t.app, s.ownerToken, 'get', '/audit-logs?action=employee.deleted');
    expect(audit[0].summary).toContain('Added the wrong person');
  });

  it('refuses to delete a teacher with history and points to resigned/terminated instead', async () => {
    // The fixture teacher has signed in already.
    const check = await api(t.app, s.ownerToken, 'get', `/employees/${s.teacherEmployeeId}/deletion-check`);
    expect(check.canDelete).toBe(false);
    expect(check.blockers.map((b: { kind: string }) => b.kind)).toContain('login_used');

    const res = await request(t.app)
      .delete(`/api/v1/employees/${s.teacherEmployeeId}`)
      .set(auth(s.ownerToken))
      .send({ reason: 'Trying anyway' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IN_USE');
    expect(res.body.error.message).toMatch(/resigned or terminated/);
    expect(await Employee.countDocuments({ _id: s.teacherEmployeeId }).setOptions({ crossTenant: true } as never)).toBe(
      1,
    );
  });

  it('requires a reason, the manage permission and the same school', async () => {
    const emp = await addTeacher(s, 'Another Mistake');
    const noReason = await request(t.app).delete(`/api/v1/employees/${emp._id}`).set(auth(s.ownerToken)).send({});
    expect(noReason.status).toBe(400);

    const asTeacher = await request(t.app)
      .delete(`/api/v1/employees/${emp._id}`)
      .set(auth(s.teacherToken))
      .send({ reason: 'nope' });
    expect(asTeacher.status).toBe(403);

    const otherSchool = await request(t.app)
      .delete(`/api/v1/employees/${emp._id}`)
      .set(auth(other.ownerToken))
      .send({ reason: 'nope' });
    expect(otherSchool.status).toBe(404);

    expect(await Employee.countDocuments({ _id: emp._id }).setOptions({ crossTenant: true } as never)).toBe(1);
  });
});
