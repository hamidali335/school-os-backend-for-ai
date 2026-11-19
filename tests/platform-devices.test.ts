import crypto from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { configWarnings, env, type Env } from '../src/config/env';
import { hashPassword } from '../src/modules/auth/tokens';
import { PlatformAdmin } from '../src/modules/platform-admin/platform-admin.model';
import { addDevice, listDevices, PlatformDevice, removeDevice } from '../src/modules/platform-admin/platform-devices';
import { PASSWORD, useTestApp } from './helpers';

/**
 * Trusted devices (PLATFORM_DEVICE_ONLY, docs/PLATFORM_REMOTE_ACCESS.md): only a browser holding
 * the key of a device registered on the server may use the platform API, from any network.
 */
useTestApp();

let app: Express;
let email: string;

beforeAll(async () => {
  // Device-only app, with an IP allow-list that would admit this test client: it must not be used.
  const saved = { ...env };
  Object.assign(env, { PLATFORM_DEVICE_ONLY: true, PLATFORM_ALLOWED_IPS: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] });
  app = createApp();
  Object.assign(env, saved);
  email = `platform.${crypto.randomUUID().slice(0, 8)}@platform.test`;
  await PlatformAdmin.create({
    name: 'Owner',
    email,
    role: 'platform_owner',
    passwordHash: await hashPassword(PASSWORD),
  });
});

const login = (headers: Record<string, string> = {}) =>
  request(app).post('/api/v1/platform/auth/login').set(headers).send({ email, password: PASSWORD });
const enroll = (code: string) => request(app).post('/api/v1/platform/devices/enroll').send({ code });

describe('only registered devices reach the platform API', () => {
  it('an unregistered device gets a plain 404, even from an allow-listed address with the right password', async () => {
    const res = await login();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await login({ 'X-Platform-Device': 'garbage' })).status).toBe(404);
    expect((await login({ 'X-Platform-Device': `${'a'.repeat(24)}.${'b'.repeat(43)}` })).status).toBe(404);
  });

  it('a backup download link opens without the device key (the browser cannot send it); its token is the proof', async () => {
    // Reaches the route: a made-up token is refused by the route itself, not hidden as "not found".
    const res = await request(app).get(`/api/v1/platform/backups/download?token=${'x'.repeat(43)}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('LINK_EXPIRED');
    // Only that route: the backup list still needs a registered device.
    expect((await request(app).get('/api/v1/platform/backups')).status).toBe(404);
    expect((await request(app).post('/api/v1/platform/backups/download')).status).toBe(404);
  });

  it('set up with the one-time code, then login, refresh, me and logout work; the password is still required', async () => {
    const { code } = await addDevice('My laptop');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await enroll('WRONG-CODE-0000')).body.error.code).toBe('INVALID_SETUP_CODE');
    const set = await enroll(code.toLowerCase().replace(/-/g, ' ')); // typed loosely: still accepted
    expect(set.status).toBe(200);
    expect(set.body.data.name).toBe('My laptop');
    const device = { 'X-Platform-Device': set.body.data.deviceKey as string };
    expect((await enroll(code)).status).toBe(400); // single use

    // Only the key's hash is stored.
    const row = await PlatformDevice.findOne({ name: 'My laptop' }).select('+keyHash +setupCodeHash').lean();
    expect(row!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(set.body.data.deviceKey).not.toContain(row!.keyHash);
    expect(row!.setupCodeHash).toBeNull();

    expect(
      (await request(app).post('/api/v1/platform/auth/login').set(device).send({ email, password: 'Wrong-pass-1A' }))
        .status,
    ).toBe(401);
    const ok = await login(device);
    expect(ok.status).toBe(200);
    const bearer = { Authorization: `Bearer ${ok.body.data.accessToken}` };
    expect((await request(app).get('/api/v1/platform/auth/me').set(device).set(bearer)).status).toBe(200);
    // A stolen platform session is useless on another device.
    expect((await request(app).get('/api/v1/platform/auth/me').set(bearer)).status).toBe(404);
    const refreshed = await request(app)
      .post('/api/v1/platform/auth/refresh')
      .set(device)
      .send({ refreshToken: ok.body.data.refreshToken });
    expect(refreshed.status).toBe(200);
    const out = await request(app)
      .post('/api/v1/platform/auth/logout')
      .set(device)
      .set({ Authorization: `Bearer ${refreshed.body.data.accessToken}` })
      .send({ refreshToken: refreshed.body.data.refreshToken });
    expect(out.status).toBeLessThan(300);

    // Removing the device on the server: its key stops working at once.
    expect(await removeDevice('My laptop')).toBe(true);
    expect((await login(device)).status).toBe(404);
  });

  it('a new code for the same device disables its old key; expired codes do not work', async () => {
    const first = await enroll((await addDevice('Office PC')).code);
    const oldKey = { 'X-Platform-Device': first.body.data.deviceKey as string };
    expect((await login(oldKey)).status).toBe(200);
    const again = await addDevice('Office PC');
    expect((await login(oldKey)).status).toBe(404);
    expect((await enroll(again.code)).status).toBe(200);

    const stale = await addDevice('Old tablet', new Date(Date.now() - 20 * 60_000));
    expect((await enroll(stale.code)).status).toBe(400);
    const rows = await listDevices();
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['Office PC', 'Old tablet']));
  });

  it('school apps are not affected, and browsers may send the device header', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect(
      (await request(app).post('/api/v1/auth/login').send({ email: 'nobody@school.test', password: 'Wrong-pass-123' }))
        .status,
    ).toBe(401);
    const pre = await request(app)
      .options('/api/v1/platform/auth/login')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-platform-device');
    expect(String(pre.headers['access-control-allow-headers'])).toMatch(/X-Platform-Device/i);
  });

  it('configuration warnings', () => {
    const w = configWarnings({
      ...env,
      NODE_ENV: 'production',
      TRUST_PROXY: 1,
      PLATFORM_DEVICE_ONLY: true,
      PLATFORM_ALLOWED_IPS: ['1.2.3.4'],
    } as Env).join(' ');
    expect(w).toMatch(/PLATFORM_ALLOWED_IPS is ignored because PLATFORM_DEVICE_ONLY is on/);
    expect(w).not.toMatch(/Neither Cloudflare Access/);
  });
});
