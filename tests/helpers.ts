import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll } from 'vitest';
import { createApp } from '../src/app';
import type { SchoolRole } from '../src/config/permissions';
import { assertSafeTestDatabaseUri, connectDatabase } from '../src/database/connection';
import { hashPassword } from '../src/modules/auth/tokens';
import { PlatformAdmin } from '../src/modules/platform-admin/platform-admin.model';
import { onboardSchool } from '../src/modules/schools/schools.service';
import { User } from '../src/modules/users/user.model';

export const PASSWORD = 'Test-Password-123';

export interface TestCtx {
  app: Express;
}

/** Connects to this file's private test database and builds the app. */
export function useTestApp(): TestCtx {
  const ctx = {} as TestCtx;
  beforeAll(async () => {
    assertSafeTestDatabaseUri(process.env.MONGODB_URI || '');
    await connectDatabase();
    await mongoose.connection.syncIndexes();
    ctx.app = createApp();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  return ctx;
}

export interface TestSchool {
  schoolId: string;
  campusId: string;
  code: string;
  ownerEmail: string;
  ownerToken: string;
}

let counter = 0;
export async function createTestSchool(
  app: Express,
  code = `T${Date.now().toString(36).toUpperCase()}${counter++}`,
): Promise<TestSchool> {
  const ownerEmail = `owner.${code.toLowerCase()}@example.test`;
  const result = await onboardSchool({
    name: `Test School ${code}`,
    code,
    city: 'Bahawalpur',
    owner: { name: `Owner ${code}`, email: ownerEmail, password: PASSWORD },
  });
  const ownerToken = await login(app, ownerEmail, PASSWORD);
  return {
    schoolId: result.school._id.toString(),
    campusId: result.campus._id.toString(),
    code,
    ownerEmail,
    ownerToken,
  };
}

export async function createUser(
  schoolId: string,
  role: SchoolRole,
  extra: Partial<{ employeeId: string; parentId: string; studentId: string; email: string; campusIds: string[] }> = {},
) {
  const email = extra.email ?? `${role}.${Math.random().toString(36).slice(2, 9)}@example.test`;
  const user = await User.create({
    schoolId,
    name: `${role} user`,
    email,
    passwordHash: await hashPassword(PASSWORD),
    role,
    employeeId: extra.employeeId,
    parentId: extra.parentId,
    studentId: extra.studentId,
    campusIds: extra.campusIds ?? [],
  });
  return { userId: user._id.toString(), email };
}

/** Sign in with an email, or with a username (phone / admission no / employee no). */
export async function login(app: Express, email: string, password = PASSWORD, schoolCode?: string): Promise<string> {
  const id = email.includes('@') ? { email } : { username: email };
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ ...id, password, schoolCode });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

/** Complete an activation link the way the account holder would, then sign in. */
export async function activateAndLogin(
  app: Express,
  account: { loginId: string; activation?: { token: string } },
  password = PASSWORD,
  schoolCode?: string,
): Promise<string> {
  if (!account.activation) throw new Error('Account has no activation token');
  const res = await request(app)
    .post('/api/v1/auth/account-link/redeem')
    .send({ token: account.activation.token, password });
  if (res.status !== 200) throw new Error(`Activation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return login(app, account.loginId, password, schoolCode);
}

export async function userToken(
  app: Express,
  schoolId: string,
  role: SchoolRole,
  extra: Parameters<typeof createUser>[2] = {},
) {
  const u = await createUser(schoolId, role, extra);
  return { ...u, token: await login(app, u.email) };
}

export async function createPlatformAdmin(app: Express, role: 'platform_owner' | 'platform_admin' = 'platform_owner') {
  const email = `${role}.${Math.random().toString(36).slice(2, 8)}@platform.test`;
  await PlatformAdmin.create({ name: role, email, role, passwordHash: await hashPassword(PASSWORD) });
  const res = await request(app).post('/api/v1/platform/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Platform login failed: ${JSON.stringify(res.body)}`);
  return { email, token: res.body.data.accessToken as string };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Put a school on a plan with exactly these features (test setup; the platform API is tested
 * separately). Plans are created once per code and reused.
 */
export async function assignPlan(schoolId: string, code: string, features: readonly string[]) {
  const { Plan } = await import('../src/modules/subscriptions/plan.model');
  const { School } = await import('../src/modules/schools/school.model');
  const { invalidatePlanCache } = await import('../src/modules/subscriptions/entitlements.service');
  const plan = await Plan.findOneAndUpdate(
    { code },
    {
      $set: { features: [...features] },
      $setOnInsert: {
        name: code,
        priceMonthlyPkr: 0,
        prices: { monthly: { amount: 0, enabled: true }, yearly: { amount: 0, enabled: false } },
      },
    },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  await School.updateOne({ _id: schoolId }, { $set: { 'subscription.planId': plan!._id } });
  invalidatePlanCache();
  return plan!;
}
