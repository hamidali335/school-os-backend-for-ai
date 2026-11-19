import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Employee } from '../src/modules/employees/employee.model';
import { Parent, Student } from '../src/modules/students/student.models';
import { User } from '../src/modules/users/user.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { activateAndLogin, auth, login, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;

const status = async (token: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: unknown) =>
  (await (request(t.app) as any)[method](`/api/v1${url}`).set(auth(token)).send(body)).status as number;

describe('Accounts: automatic provisioning, activation and status', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 2 });
    other = await buildSchool(t.app, { students: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('provisions a pending teacher login on registration that works only after activation', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Sana',
      designation: 'Teacher',
      staffType: 'teaching',
      email: 'sana.teacher@example.test',
    });
    expect(emp.account).toMatchObject({ role: 'teacher', status: 'pending', created: true });
    expect(emp.account.activation.token).toBeTruthy();
    expect(emp.userId).toBe(emp.account.userId);

    // No usable password exists before activation: sign-in fails like any wrong password.
    const before = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'sana.teacher@example.test', password: PASSWORD });
    expect(before.status).toBe(401);

    const inspect = await request(t.app)
      .post('/api/v1/auth/account-link/inspect')
      .send({ token: emp.account.activation.token });
    expect(inspect.status).toBe(200);
    expect(inspect.body.data).toMatchObject({ purpose: 'activation', name: 'Sana' });

    const token = await activateAndLogin(t.app, emp.account, PASSWORD, s.code);
    const me = await api(t.app, token, 'get', '/auth/me');
    expect(me.user.status).toBe('active');
    expect(me.user.employeeId).toBe(emp._id);

    // Single use: the same link cannot be redeemed twice.
    const again = await request(t.app)
      .post('/api/v1/auth/account-link/redeem')
      .send({ token: emp.account.activation.token, password: 'Another-Pass-123' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
  });

  it('never stores activation tokens or passwords in readable form', async () => {
    const u = await User.findOne({ schoolId: s.schoolId, role: 'teacher' }).select('+passwordHash').lean();
    expect(u!.passwordHash).toMatch(/^\$2[aby]\$/);
    const { AccountToken } = await import('../src/modules/users/user.model');
    const tok = await AccountToken.findOne({ schoolId: s.schoolId }).lean();
    expect(tok!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not create a login for non-teaching staff unless asked, and never duplicates one', async () => {
    const clerk = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Imran',
      designation: 'Clerk',
      staffType: 'non_teaching',
    });
    expect(clerk.account).toBeNull();
    expect(await User.countDocuments({ schoolId: s.schoolId, employeeId: clerk._id })).toBe(0);

    // Explicit creation needs a role choice for non-teaching staff.
    expect(await status(s.ownerToken, 'post', `/employees/${clerk._id}/account`, {})).toBe(400);
    // Repeated and concurrent requests produce exactly one login.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        (request(t.app) as any)
          .post(`/api/v1/employees/${clerk._id}/account`)
          .set(auth(s.ownerToken))
          .send({ role: 'accountant' }),
      ),
    );
    expect(results.filter((r: any) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results as any[]) expect([200, 409]).toContain(r.status);
    expect(await User.countDocuments({ schoolId: s.schoolId, employeeId: clerk._id })).toBe(1);
    const repeat = await api(t.app, s.ownerToken, 'post', `/employees/${clerk._id}/account`, { role: 'accountant' });
    expect(repeat.created).toBe(false);
  });

  it('reuses one parent login for siblings and supports sign-in with the phone number', async () => {
    const phone = '+923331112233';
    const mk = (firstName: string) =>
      api(t.app, s.ownerToken, 'post', '/students', {
        campusId: s.campusId,
        firstName,
        gender: 'male',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionB,
        guardians: [{ parent: { name: 'Shared Parent', phone }, isPrimary: true }],
      });
    const first = await mk('Elder');
    const second = await mk('Younger');
    const p1 = first.accounts.find((a: any) => a.role === 'parent');
    const p2 = second.accounts.find((a: any) => a.role === 'parent');
    expect(p1.created).toBe(true);
    expect(p2.created).toBe(false);
    expect(p2.userId).toBe(p1.userId);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone })).toBe(1);
    expect(await User.countDocuments({ schoolId: s.schoolId, role: 'parent', name: 'Shared Parent' })).toBe(1);
    expect(p1.loginId).toBe('03331112233');

    const parentToken = await activateAndLogin(t.app, p1, PASSWORD, s.code);
    const kids = await api(t.app, parentToken, 'get', '/students');
    expect(kids.map((k: any) => k.firstName).sort()).toEqual(['Elder', 'Younger']);
    // Students get no login of their own: the parent account covers both children.
    expect(first.accounts.map((a: any) => a.role)).toEqual(['parent']);
    expect(second.accounts.map((a: any) => a.role)).toEqual(['parent']);
    expect(await User.countDocuments({ schoolId: s.schoolId, role: 'student' })).toBe(0);
  });

  it('rolls back the whole admission when a login cannot be created (no orphans)', async () => {
    const original = User.create.bind(User);
    vi.spyOn(User, 'create').mockImplementation((async (doc: any, ...rest: any[]) => {
      if (doc?.role === 'parent') throw new Error('simulated failure');
      return (original as any)(doc, ...rest);
    }) as any);
    const phone = '+923449998877';
    const before = {
      students: await Student.countDocuments({ schoolId: s.schoolId }),
      users: await User.countDocuments({ schoolId: s.schoolId }),
    };
    const res = await request(t.app)
      .post('/api/v1/students')
      .set(auth(s.ownerToken))
      .send({
        campusId: s.campusId,
        firstName: 'Rollback',
        gender: 'female',
        sessionId: s.sessionId,
        classId: s.classId,
        sectionId: s.sectionB,
        guardians: [{ parent: { name: 'New Parent', phone }, isPrimary: true }],
      });
    expect(res.status).toBe(500);
    expect(await Student.countDocuments({ schoolId: s.schoolId })).toBe(before.students);
    expect(await User.countDocuments({ schoolId: s.schoolId })).toBe(before.users);
    expect(await Parent.countDocuments({ schoolId: s.schoolId, phone })).toBe(0);
  });

  it('blocks suspended and disabled accounts immediately and on login', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Temp',
      designation: 'Teacher',
      staffType: 'teaching',
    });
    const token = await activateAndLogin(t.app, emp.account, PASSWORD, s.code);
    expect(await status(token, 'get', '/auth/me')).toBe(200);
    await api(t.app, s.ownerToken, 'patch', `/users/${emp.account.userId}`, {
      status: 'suspended',
      statusReason: 'Leave',
    });
    const res = await request(t.app).get('/api/v1/auth/me').set(auth(token));
    expect(res.status).toBe(401); // token version bumped: session ends at once
    const relogin = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ username: emp.account.loginId, password: PASSWORD, schoolCode: s.code });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('ACCOUNT_SUSPENDED');
    // A blocked account cannot be reached with a new link either.
    expect(await status(s.ownerToken, 'post', `/users/${emp.account.userId}/access-link`)).toBe(409);
  });

  it('disables the login of staff who leave', async () => {
    const emp = await api(t.app, s.ownerToken, 'post', '/employees', {
      campusId: s.campusId,
      firstName: 'Leaving',
      designation: 'Teacher',
      staffType: 'teaching',
    });
    await api(t.app, s.ownerToken, 'patch', `/employees/${emp._id}`, { status: 'resigned' });
    const u = await User.findOne({ schoolId: s.schoolId, employeeId: emp._id }).lean();
    expect(u!.status).toBe('disabled');
  });

  it('issues password-reset links that rotate (old link stops working)', async () => {
    const u = await User.findOne({ schoolId: s.schoolId, role: 'teacher', status: 'active' }).lean();
    const first = await api(t.app, s.ownerToken, 'post', `/users/${u!._id}/access-link`);
    const second = await api(t.app, s.ownerToken, 'post', `/users/${u!._id}/access-link`);
    expect(first.purpose).toBe('password_reset');
    const old = await request(t.app).post('/api/v1/auth/account-link/inspect').send({ token: first.token });
    expect(old.status).toBe(400);
    const ok = await request(t.app)
      .post('/api/v1/auth/account-link/redeem')
      .send({ token: second.token, password: 'Brand-New-Pass-1' });
    expect(ok.status).toBe(200);
  });

  it('does not let anyone change their own status or role', async () => {
    const me = await api(t.app, s.principalToken, 'get', '/auth/me');
    expect(
      await status(s.ownerToken, 'patch', `/users/${(await api(t.app, s.ownerToken, 'get', '/auth/me')).user._id}`, {
        status: 'disabled',
      }),
    ).toBe(400);
    expect(await status(s.principalToken, 'patch', `/users/${me.user._id}`, { role: 'school_admin' })).toBe(403);
  });
});

describe('Roles and permissions (custom staff roles)', () => {
  let roleId: string;
  let staffToken: string;
  let staffUserId: string;

  beforeAll(async () => {
    if (!s) s = await buildSchool(t.app, { students: 2 });
  });

  it('lets only the Admin create roles, and never with roles:manage', async () => {
    expect(
      await status(s.principalToken, 'post', '/roles', { name: 'Receptionist', permissions: ['students:read'] }),
    ).toBe(403);
    expect(
      await status(s.ownerToken, 'post', '/roles', { name: 'Sneaky', permissions: ['students:read', 'roles:manage'] }),
    ).toBe(403);
    const role = await api(t.app, s.ownerToken, 'post', '/roles', {
      name: 'Receptionist',
      description: 'Front desk',
      permissions: ['students:read', 'admissions:read', 'admissions:manage', 'reports:read'],
    });
    roleId = role._id;
    expect(await status(s.ownerToken, 'post', '/roles', { name: 'receptionist', permissions: [] })).toBe(409);
  });

  it('enforces a custom role on the server, not just in the UI', async () => {
    const email = 'front.desk@example.test';
    const created = await api(t.app, s.ownerToken, 'post', '/users', {
      name: 'Front Desk',
      email,
      role: 'staff',
      customRoleId: roleId,
      password: PASSWORD,
    });
    staffUserId = created.user._id;
    staffToken = await login(t.app, email);
    const me = await api(t.app, staffToken, 'get', '/auth/me');
    expect(me.permissions).toContain('admissions:manage');
    expect(me.permissions).not.toContain('fees:read');

    expect(await status(staffToken, 'get', '/students')).toBe(200);
    expect(await status(staffToken, 'get', '/admissions/inquiries')).toBe(200);
    // Direct API calls to modules outside the role are refused.
    expect(await status(staffToken, 'get', '/fees/invoices')).toBe(403);
    expect(
      await status(staffToken, 'post', '/employees', {
        campusId: s.campusId,
        firstName: 'X',
        designation: 'X',
        staffType: 'teaching',
      }),
    ).toBe(403);
    expect(await status(staffToken, 'get', '/users')).toBe(403);
    // Cannot grant itself more: role management is Admin-only.
    expect(await status(staffToken, 'patch', `/roles/${roleId}`, { permissions: ['fees:read'] })).toBe(403);
    // Dashboard does not leak fee totals.
    const dash = await api(t.app, staffToken, 'get', '/dashboard');
    expect(dash.fees).toBeNull();
    // CSV export needs reports:export even with reports:read.
    expect(await status(staffToken, 'get', '/reports/attendance?from=2026-09-01&to=2026-09-30&format=csv')).toBe(403);
  });

  it('applies permission changes to existing sessions immediately', async () => {
    await api(t.app, s.ownerToken, 'patch', `/roles/${roleId}`, {
      permissions: ['students:read', 'admissions:read', 'admissions:manage', 'reports:read', 'fees:read'],
    });
    expect(await status(staffToken, 'get', '/fees/invoices')).toBe(200);
    await api(t.app, s.ownerToken, 'patch', `/roles/${roleId}`, { permissions: ['students:read'] });
    expect(await status(staffToken, 'get', '/fees/invoices')).toBe(403);
  });

  it('refuses deleting a role in use and keeps roles tenant-scoped', async () => {
    expect(await status(s.ownerToken, 'delete', `/roles/${roleId}`)).toBe(409);
    expect(await status(other.ownerToken, 'patch', `/roles/${roleId}`, { name: 'Hijack' })).toBe(404);
    expect(await status(other.ownerToken, 'post', `/users/${staffUserId}/access-link`)).toBe(404);
    // Another school's role cannot be assigned.
    expect(
      await status(other.ownerToken, 'post', '/users', {
        name: 'Xavier Other',
        email: 'x.other@example.test',
        role: 'staff',
        customRoleId: roleId,
        password: PASSWORD,
      }),
    ).toBe(400);
  });

  it('stops principals and delegated staff from creating custom-role accounts', async () => {
    expect(
      await status(s.principalToken, 'post', '/users', {
        name: 'Yasir Staff',
        email: 'y.staff@example.test',
        role: 'staff',
        customRoleId: roleId,
        password: PASSWORD,
      }),
    ).toBe(403);
  });

  it('exposes the permission catalogue for the management screen', async () => {
    const cat = await api(t.app, s.ownerToken, 'get', '/roles/catalogue');
    const keys = cat.modules.flatMap((m: any) => m.permissions.map((p: any) => p.key));
    expect(keys).toContain('fees:collect');
    expect(cat.modules.flatMap((m: any) => m.permissions).find((p: any) => p.key === 'roles:manage').delegable).toBe(
      false,
    );
    expect(cat.builtInRoles.find((r: any) => r.role === 'school_owner').label).toBe('Admin');
  });
});

describe('Employees still validate references across schools', () => {
  it('cannot create a login for another school’s employee', async () => {
    const foreign = await Employee.findOne({ schoolId: other.schoolId }).lean();
    expect(await status(s.ownerToken, 'post', `/employees/${foreign!._id}/account`, { role: 'teacher' })).toBe(404);
  });
});
