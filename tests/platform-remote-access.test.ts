import crypto from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { configWarnings, env, type Env } from '../src/config/env';
import { AccessVerifier, type AccessConfig } from '../src/middleware/cloudflare-access';
import { PlatformAdmin } from '../src/modules/platform-admin/platform-admin.model';
import { hashPassword } from '../src/modules/auth/tokens';
import { PASSWORD, useTestApp } from './helpers';

/**
 * The platform console from any network behind Cloudflare Access (docs/PLATFORM_REMOTE_ACCESS.md):
 * every platform API request must carry a valid Access token for the configured application.
 * Cloudflare is replaced by local keys; nothing is fetched from the internet.
 */
useTestApp();

const TEAM = 'https://schoolos-test.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const OWNER = 'owner@schoolos.test';
const config: AccessConfig = { teamDomain: TEAM, audience: AUD, emails: [OWNER] };

const signer = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [{ ...(signer.publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }],
};
const now = () => Math.floor(Date.now() / 1000);

function token(over: Record<string, unknown> = {}, opts: { key?: crypto.KeyObject; kid?: string; alg?: string } = {}) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64({
    iss: TEAM,
    aud: [AUD],
    email: OWNER,
    iat: now(),
    nbf: now(),
    exp: now() + 600,
    type: 'app',
    ...over,
  });
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? signer.privateKey)
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}

describe('Cloudflare Access token verification', () => {
  const verifier = () => new AccessVerifier(config, async () => jwks);

  it('accepts a token Cloudflare signed for this application and e-mail', async () => {
    expect(await verifier().verify(token())).toEqual({ ok: true, email: OWNER });
    expect(await verifier().verify(token({ email: 'Owner@SchoolOS.test' }))).toMatchObject({ ok: true });
  });

  it('refuses everything else, failing closed', async () => {
    const v = verifier();
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'missing'],
      ['not-a-jwt', 'malformed'],
      [token({}, { alg: 'HS256' }), 'bad_algorithm'],
      [token({}, { key: stranger.privateKey }), 'bad_signature'],
      [token({}, { kid: 'unknown' }), 'unknown_key'],
      [token({ iss: 'https://evil.cloudflareaccess.com' }), 'wrong_issuer'],
      [token({ aud: ['b'.repeat(64)] }), 'wrong_audience'],
      [token({ exp: now() - 3600 }), 'expired'],
      [token({ nbf: now() + 3600 }), 'not_yet_valid'],
      [token({ email: 'someone@else.test' }), 'email_not_allowed'],
      [token({ email: undefined }), 'email_not_allowed'],
    ];
    for (const [tok, reason] of cases) expect(await v.verify(tok)).toEqual({ ok: false, reason });
  });

  it('cannot reach Cloudflare for the keys: refused, not let through', async () => {
    const v = new AccessVerifier(config, async () => Promise.reject(new Error('offline')));
    expect(await v.verify(token())).toEqual({ ok: false, reason: 'keys_unavailable' });
  });

  it('caches the keys, and fetches again (rate limited) when Cloudflare rotates them', async () => {
    let clock = Date.now();
    const fetchKeys = vi.fn(async () => jwks);
    const v = new AccessVerifier(config, fetchKeys, () => clock);
    await v.verify(token());
    await v.verify(token());
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    await v.verify(token({}, { kid: 'new-key' })); // unknown key, but just fetched: no new request
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await v.verify(token({}, { kid: 'new-key' }));
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });
});

describe('the platform API behind Cloudflare Access', () => {
  let app: Express;
  let email: string;
  const certs = vi.fn(async () => Response.json(jwks));

  beforeAll(async () => {
    // The guard reads its settings when the app is built: build one in Access mode, with an IP
    // allow-list that would admit this test client, to prove the list is not used.
    const saved = { ...env };
    Object.assign(env, {
      PLATFORM_ACCESS_TEAM_DOMAIN: TEAM,
      PLATFORM_ACCESS_AUD: AUD,
      PLATFORM_ACCESS_EMAILS: [OWNER],
      PLATFORM_ALLOWED_IPS: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
    });
    app = createApp();
    Object.assign(env, saved);
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === `${TEAM}/cdn-cgi/access/certs`
        ? certs()
        : Promise.reject(new Error(`unexpected fetch ${String(url)} ${init?.method ?? ''}`)),
    );
    email = `platform.${crypto.randomUUID().slice(0, 8)}@platform.test`;
    await PlatformAdmin.create({
      name: 'Owner',
      email,
      role: 'platform_owner',
      passwordHash: await hashPassword(PASSWORD),
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const access = () => ({ 'Cf-Access-Jwt-Assertion': token() });

  it('without Access, platform login is a plain 404 even from an allow-listed address', async () => {
    const res = await request(app).post('/api/v1/platform/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    const spoofed = await request(app)
      .post('/api/v1/platform/auth/login')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('Cf-Access-Jwt-Assertion', token({ aud: ['b'.repeat(64)] }))
      .send({ email, password: PASSWORD });
    expect(spoofed.status).toBe(404);
  });

  it('with Access: login, an authorized call, refresh and logout all work; the password is still required', async () => {
    expect(
      (
        await request(app)
          .post('/api/v1/platform/auth/login')
          .set(access())
          .send({ email, password: 'wrong-password-1A' })
      ).status,
    ).toBe(401);
    const login = await request(app)
      .post('/api/v1/platform/auth/login')
      .set(access())
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const { accessToken, refreshToken } = login.body.data;

    const me = await request(app)
      .get('/api/v1/platform/auth/me')
      .set(access())
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    // A stolen platform token is useless without Access, too.
    expect(
      (await request(app).get('/api/v1/platform/auth/me').set('Authorization', `Bearer ${accessToken}`)).status,
    ).toBe(404);

    const refreshed = await request(app).post('/api/v1/platform/auth/refresh').set(access()).send({ refreshToken });
    expect(refreshed.status).toBe(200);
    const out = await request(app)
      .post('/api/v1/platform/auth/logout')
      .set(access())
      .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
      .send({ refreshToken: refreshed.body.data.refreshToken });
    expect(out.status).toBeLessThan(300);
  });

  it('an Access token for someone not listed in PLATFORM_ACCESS_EMAILS is refused', async () => {
    const res = await request(app)
      .post('/api/v1/platform/auth/login')
      .set('Cf-Access-Jwt-Assertion', token({ email: 'intruder@example.test' }))
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(404);
  });

  it('school apps are not affected: their API needs no Access token', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@school.test', password: 'Wrong-pass-123' });
    expect(login.status).toBe(401); // reached the school login (not hidden behind Access)
  });
});

describe('configuration', () => {
  const base = { ...env, NODE_ENV: 'production', TRUST_PROXY: 1 } as Env;

  it('warns when the platform API has neither Access nor an allow-list, or Access without an e-mail list', () => {
    const none = configWarnings({
      ...base,
      PLATFORM_ALLOWED_IPS: [],
      PLATFORM_ACCESS_TEAM_DOMAIN: undefined,
      PLATFORM_ACCESS_AUD: undefined,
    });
    expect(none.join(' ')).toMatch(/Neither Cloudflare Access .* nor PLATFORM_ALLOWED_IPS/);
    const noEmails = configWarnings({
      ...base,
      PLATFORM_ACCESS_TEAM_DOMAIN: TEAM,
      PLATFORM_ACCESS_AUD: AUD,
      PLATFORM_ACCESS_EMAILS: [],
    });
    expect(noEmails.join(' ')).toMatch(/PLATFORM_ACCESS_EMAILS is empty/);
    const both = configWarnings({
      ...base,
      PLATFORM_ACCESS_TEAM_DOMAIN: TEAM,
      PLATFORM_ACCESS_AUD: AUD,
      PLATFORM_ACCESS_EMAILS: [OWNER],
      PLATFORM_ALLOWED_IPS: ['1.2.3.4'],
    });
    expect(both.join(' ')).toMatch(/PLATFORM_ALLOWED_IPS is ignored/);
    expect(both.join(' ')).not.toMatch(/Neither|EMAILS is empty/);
  });
});
