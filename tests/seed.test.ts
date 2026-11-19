import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { runSeed } from '../scripts/seed';
import { useTestApp } from './helpers';

const t = useTestApp();
const PASSWORD = 'Demo-Seed-Pass-2026';

async function counts() {
  const db = mongoose.connection.db!;
  const names = [
    'schools',
    'campuses',
    'users',
    'students',
    'parents',
    'employees',
    'classes',
    'sections',
    'invoices',
    'payments',
    'attendancerecords',
    'inquiries',
    'marks',
    'timetableentries',
    'expenses',
    'automationrules',
  ];
  const out: Record<string, number> = {};
  for (const n of names) out[n] = await db.collection(n).countDocuments();
  return out;
}

describe('Demo seed', () => {
  it('creates the Bright Future demo school and is idempotent', async () => {
    const first = await runSeed(PASSWORD, { quiet: true });
    expect(first.students).toBeGreaterThan(80);
    const c1 = await counts();
    expect(c1.schools).toBe(1);
    expect(c1.payments).toBeGreaterThan(0);
    expect(c1.attendancerecords).toBeGreaterThan(1000);

    await runSeed(PASSWORD, { quiet: true });
    const c2 = await counts();
    expect(c2).toEqual(c1);
  }, 180_000);

  it('demo accounts can log in and see consistent data', async () => {
    const login = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'principal@brightfuture.example', password: PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken;
    const dash = await request(t.app)
      .get('/api/v1/dashboard')
      .set({ Authorization: `Bearer ${token}` });
    expect(dash.status).toBe(200);
    expect(dash.body.data.students.active).toBeGreaterThan(80);
    const parent = await request(t.app)
      .post('/api/v1/auth/login')
      .send({ email: 'parent@brightfuture.example', password: PASSWORD });
    const kids = await request(t.app)
      .get('/api/v1/students')
      .set({ Authorization: `Bearer ${parent.body.data.accessToken}` });
    expect(kids.body.data.length).toBe(1);
  });
});
