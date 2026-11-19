import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { REFRESH_PER_SESSION, REFRESH_WINDOW_MS } from '../src/middleware/rate-limit';
import { createTestSchool, createUser, PASSWORD, useTestApp, type TestSchool } from './helpers';

/**
 * POST /auth/refresh rate limits: per session family (survives rotation and network changes)
 * and per client IP (survives session rotation), separate from the sign-in limiter.
 */
const t = useTestApp();
let school: TestSchool;
let ipCounter = 10;
/** A fresh client address per test, so tests do not share buckets in the in-memory store. */
const nextIp = () => `203.0.113.${ipCounter++}`;

async function signIn(email: string, ip: string) {
  const res = await request(t.app)
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.refreshToken as string;
}

const refresh = (token: string, ip: string) =>
  request(t.app).post('/api/v1/auth/refresh').set('X-Forwarded-For', ip).send({ refreshToken: token });

beforeAll(async () => {
  school = await createTestSchool(t.app);
  // Behind one trusted proxy (the production setup), req.ip comes from X-Forwarded-For.
  t.app.set('trust proxy', 1);
  process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
});
afterAll(() => {
  delete process.env.ENABLE_RATE_LIMIT_IN_TESTS;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('per-session refresh limit', () => {
  it('allows 20 refreshes per session family in 15 minutes, then answers 429', async () => {
    const { email } = await createUser(school.schoolId, 'teacher');
    const ip = nextIp();
    let token = await signIn(email, ip);
    for (let i = 0; i < REFRESH_PER_SESSION; i++) {
      const res = await refresh(token, ip);
      expect(res.status).toBe(200);
      token = res.body.data.refreshToken;
    }
    const blocked = await refresh(token, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('cannot be bypassed by switching networks (the family is the key, not the IP)', async () => {
    const { email } = await createUser(school.schoolId, 'parent');
    let token = await signIn(email, nextIp());
    for (let i = 0; i < REFRESH_PER_SESSION; i++) {
      const res = await refresh(token, nextIp());
      expect(res.status).toBe(200);
      token = res.body.data.refreshToken;
    }
    expect((await refresh(token, nextIp())).status).toBe(429);
  });

  it('limits one session without affecting other sessions from the same network', async () => {
    const ip = nextIp();
    const a = await createUser(school.schoolId, 'teacher');
    const b = await createUser(school.schoolId, 'teacher');
    let tokenA = await signIn(a.email, ip);
    const tokenB = await signIn(b.email, ip);
    for (let i = 0; i < REFRESH_PER_SESSION; i++) tokenA = (await refresh(tokenA, ip)).body.data.refreshToken;
    expect((await refresh(tokenA, ip)).status).toBe(429);
    expect((await refresh(tokenB, ip)).status).toBe(200);
  });

  it('many sessions behind one school network are not limited by each other', async () => {
    const ip = nextIp();
    const tokens = await Promise.all(
      Array.from({ length: 25 }, async () => signIn((await createUser(school.schoolId, 'parent')).email, ip)),
    );
    const statuses = await Promise.all(tokens.map(async (tok) => (await refresh(tok, ip)).status));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('resets after the 15-minute window', async () => {
    const { email } = await createUser(school.schoolId, 'teacher');
    const ip = nextIp();
    let token = await signIn(email, ip);
    for (let i = 0; i < REFRESH_PER_SESSION; i++) token = (await refresh(token, ip)).body.data.refreshToken;
    expect((await refresh(token, ip)).status).toBe(429);
    const later = Date.now() + REFRESH_WINDOW_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await refresh(token, ip)).status).toBe(200);
  });

  it('counts concurrent requests exactly once each', async () => {
    const { email } = await createUser(school.schoolId, 'teacher');
    const ip = nextIp();
    const token = await signIn(email, ip);
    // The same token sent 25 times at once: only one rotation succeeds (single use), the others
    // are refused; whatever the outcome, no more than 20 are let through to the handler.
    const statuses = await Promise.all(Array.from({ length: 25 }, async () => (await refresh(token, ip)).status));
    expect(statuses.filter((s) => s === 429)).toHaveLength(25 - REFRESH_PER_SESSION);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  });
});

describe('per-connection refresh limit', () => {
  it('caps all refreshes from one IP, so rotating sessions does not help', async () => {
    const original = env.AUTH_REFRESH_IP_MAX;
    (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = 12;
    try {
      const ip = nextIp();
      const tokens = await Promise.all(
        Array.from({ length: 13 }, async () => signIn((await createUser(school.schoolId, 'parent')).email, nextIp())),
      );
      const statuses: number[] = [];
      for (const tok of tokens) statuses.push((await refresh(tok, ip)).status);
      expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
      expect(statuses[12]).toBe(429);
    } finally {
      (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = original;
    }
  });

  it('does not trust a forged X-Forwarded-For chain beyond the configured proxy', async () => {
    const original = env.AUTH_REFRESH_IP_MAX;
    (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = 3;
    try {
      const real = nextIp();
      const statuses: number[] = [];
      // With one trusted proxy, only the last hop counts; prepending fake addresses changes nothing.
      for (let i = 0; i < 4; i++) {
        const res = await request(t.app)
          .post('/api/v1/auth/refresh')
          .set('X-Forwarded-For', `198.51.100.${i}, ${real}`)
          .send({ refreshToken: `unknown-token-${'x'.repeat(30)}-${i}` });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = original;
    }
  });
});

describe('refresh limits are separate from sign-in and leak nothing', () => {
  it('refreshes do not consume the sign-in limit, which stays at 10 per email and IP', async () => {
    const { email } = await createUser(school.schoolId, 'teacher');
    const ip = nextIp();
    let token = await signIn(email, ip); // 1 sign-in attempt
    for (let i = 0; i < 15; i++) token = (await refresh(token, ip)).body.data.refreshToken;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push(
        (
          await request(t.app)
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', ip)
            .send({ email, password: 'wrong-password' })
        ).status,
      );
    }
    // 15 refreshes did not count: attempts 2–10 are still evaluated (401, then 423 once the account
    // locks after 5 failures), and only the 11th overall attempt hits the sign-in limit (429).
    expect(statuses.slice(0, 9).every((s) => s === 401 || s === 423)).toBe(true);
    expect(statuses[9]).toBe(429);
  });

  it('revoked, reused and unknown tokens get the same 401 without revealing which', async () => {
    const { email } = await createUser(school.schoolId, 'parent');
    const ip = nextIp();
    const first = await signIn(email, ip);
    const second = (await refresh(first, ip)).body.data.refreshToken as string;
    await request(t.app).post('/api/v1/auth/logout').send({ refreshToken: second });
    const reused = await refresh(first, ip);
    const revoked = await refresh(second, ip);
    const unknown = await refresh(`never-issued-${'y'.repeat(40)}`, ip);
    for (const res of [reused, revoked, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe(unknown.body.error.message);
    }
  });

  it('a 429 looks the same for a real session and an unknown token', async () => {
    const original = env.AUTH_REFRESH_IP_MAX;
    (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = 1;
    try {
      const { email } = await createUser(school.schoolId, 'parent');
      const real = await signIn(email, nextIp());
      const ipA = nextIp();
      const ipB = nextIp();
      await refresh(`warm-${'z'.repeat(40)}`, ipA);
      await refresh(`warm-${'z'.repeat(40)}`, ipB);
      const a = await refresh(real, ipA);
      const b = await refresh(`never-issued-${'q'.repeat(40)}`, ipB);
      expect(a.status).toBe(429);
      expect(b.status).toBe(429);
      expect({ ...a.body.error, requestId: undefined }).toEqual({ ...b.body.error, requestId: undefined });
    } finally {
      (env as { AUTH_REFRESH_IP_MAX: number }).AUTH_REFRESH_IP_MAX = original;
    }
  });
});
