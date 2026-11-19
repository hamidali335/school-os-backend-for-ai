import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { toCsv } from '../src/utils/csv';
import { todayInTz } from '../src/utils/dates';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
const today = todayInTz('Asia/Karachi');

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 4 });
  await api(t.app, s.accountantToken, 'post', '/fees/invoices/generate', { period: today.slice(0, 7) });
});

describe('Dashboards', () => {
  it('returns the admin dashboard with action items computed from data', async () => {
    const d = await api(t.app, s.principalToken, 'get', '/dashboard');
    expect(d.role).toBe('admin');
    expect(d.students.active).toBe(4);
    expect(d.staff.teaching).toBe(2);
    expect(d.fees.currentPeriodBilled).toBe(60000);
    expect(d.actions.find((a: any) => a.type === 'attendance_unmarked').count).toBe(2);
  });

  it('returns role-specific dashboards for teacher, accountant and parent', async () => {
    const teacher = await api(t.app, s.teacherToken, 'get', '/dashboard');
    expect(teacher.role).toBe('teacher');
    expect(teacher.sections).toHaveLength(1);
    const accountant = await api(t.app, s.accountantToken, 'get', '/dashboard');
    expect(accountant.role).toBe('accountant');
    const parent = await api(t.app, s.parentToken, 'get', '/dashboard');
    expect(parent.role).toBe('parent');
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0].fees.outstanding).toBe(15000);
  });
});

describe('Reports', () => {
  it('produces enrolment and fee-collection reports', async () => {
    const enr = await api(t.app, s.principalToken, 'get', '/reports/enrollment');
    expect(enr.totals.students).toBe(4);
    expect(enr.sections[0].utilisation).toBeCloseTo(6.7, 1);
    const inv = await api(t.app, s.accountantToken, 'get', `/fees/invoices?studentId=${s.students[0]}`);
    await api(t.app, s.accountantToken, 'post', `/fees/invoices/${inv[0]._id}/payments`, {
      amount: 4000,
      method: 'cash',
    });
    const col = await api(
      t.app,
      s.principalToken,
      'get',
      `/reports/fee-collection?from=${today}&to=${today}&groupBy=method`,
    );
    expect(col.total).toBe(4000);
    expect(col.rows[0]).toMatchObject({ key: 'cash', total: 4000 });
  });

  it('exports CSV with spreadsheet formula injection neutralised', async () => {
    const csv = toCsv(
      [
        { key: 'name', header: 'Name' },
        { key: 'amount', header: 'Amount' },
      ],
      [
        { name: '=HYPERLINK("http://evil")', amount: -50 },
        { name: 'Ali, "Khan"', amount: 10 },
      ],
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(',-50');
    expect(csv).toContain('"Ali, ""Khan"""');
    const res = await request(t.app).get('/api/v1/reports/outstanding?format=csv').set(auth(s.principalToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\r\n').length).toBe(5);
  });

  it('denies reports to roles without reports:read', async () => {
    expect(
      (await request(t.app).get(`/api/v1/reports/finance?from=${today}&to=${today}`).set(auth(s.teacherToken))).status,
    ).toBe(403);
    expect((await request(t.app).get('/api/v1/reports/enrollment').set(auth(s.parentToken))).status).toBe(403);
  });
});
