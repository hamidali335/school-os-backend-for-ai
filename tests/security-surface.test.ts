import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildAllowList, ipAllowed, platformNetworkGuard } from '../src/middleware/platform-network';
import { collectInventory } from '../scripts/endpoint-inventory';

describe('Platform network allow-list (compensating control for missing MFA)', () => {
  it('matches addresses and CIDR ranges, including IPv4-mapped IPv6', () => {
    const list = buildAllowList(['127.0.0.1', '192.168.1.0/24', 'fd00::/8'])!;
    expect(ipAllowed(list, '127.0.0.1')).toBe(true);
    expect(ipAllowed(list, '::ffff:192.168.1.77')).toBe(true);
    expect(ipAllowed(list, '192.168.2.1')).toBe(false);
    expect(ipAllowed(list, 'fd12::1')).toBe(true);
    expect(ipAllowed(list, '8.8.8.8')).toBe(false);
    expect(ipAllowed(list, undefined)).toBe(false);
    expect(() => buildAllowList(['not-an-ip'])).toThrow();
    expect(() => buildAllowList(['10.0.0.0/33'])).toThrow();
    expect(buildAllowList([])).toBeNull();
  });

  it('hides the platform API (404) from other addresses, using the proxy-reported client IP', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/v1/platform', platformNetworkGuard(['192.168.1.0/24']));
    app.get('/api/v1/platform/overview', (_req, res) => res.json({ ok: true }));
    const inside = await request(app).get('/api/v1/platform/overview').set('X-Forwarded-For', '192.168.1.20');
    expect(inside.status).toBe(200);
    const outside = await request(app).get('/api/v1/platform/overview').set('X-Forwarded-For', '203.0.113.9');
    expect(outside.status).toBe(404);
    // A spoofed left-most X-Forwarded-For does not help: with one trusted proxy, the proxy's
    // own (right-most) entry is the client address.
    const spoofed = await request(app)
      .get('/api/v1/platform/overview')
      .set('X-Forwarded-For', '192.168.1.20, 203.0.113.9');
    expect(spoofed.status).toBe(404);
  });
});

describe('Endpoint security inventory (regression guard)', () => {
  it('only the expected endpoints are reachable without a token', async () => {
    const rows = await collectInventory();
    const pub = rows
      .filter((r) => r.auth === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(pub).toEqual(
      [
        'GET /',
        'GET /api/v1',
        'GET /api/v1/licensing/public-key',
        'GET /api/v1/meta/compat',
        'GET /api/v1/platform/backups/download',
        'GET /api/v1/public/certificates/verify',
        'GET /api/v1/sync/health',
        'GET /health',
        'GET /health/ready',
        // Connector API: authenticated by a device's connector key, rate-limited per device.
        'POST /api/v1/biometric/ingest',
        'POST /api/v1/auth/account-link/inspect',
        'POST /api/v1/auth/account-link/redeem',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/platform/auth/login',
        'POST /api/v1/platform/auth/logout',
        'POST /api/v1/platform/auth/refresh',
        // One-time setup code for a trusted console device (PLATFORM_DEVICE_ONLY); rate-limited.
        'POST /api/v1/platform/devices/enroll',
      ].sort(),
    );
  });

  it('every platform path uses platform authentication (never a school token)', async () => {
    const rows = await collectInventory();
    const wrong = rows.filter((r) => r.path.startsWith('/api/v1/platform/') && r.auth === 'school');
    expect(wrong).toEqual([]);
  });

  it('backup endpoints are restricted to the platform owner and rate-limited', async () => {
    const rows = (await collectInventory()).filter(
      (r) => r.path.startsWith('/api/v1/platform/backups') && r.auth !== 'public',
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) expect(r.platformRoles).toEqual(['platform_owner']);
    for (const r of rows.filter((x) => x.method !== 'GET')) expect(r.rateLimits).toContain('backupLimiter');
  });

  it('every mutating school endpoint validates its input or path', async () => {
    const rows = await collectInventory();
    const unvalidated = rows
      .filter((r) => r.auth === 'school' && r.method !== 'GET' && !r.body && !r.params && !r.upload)
      .map((r) => `${r.method} ${r.path}`);
    // Bodyless actions on the caller's own data (no client input to validate).
    expect(unvalidated.sort()).toEqual(
      [
        'POST /api/v1/auth/logout-all',
        // Remove this school's logo / reset its document design (school:settings, no input).
        'DELETE /api/v1/school/branding/documents',
        'DELETE /api/v1/school/branding/logo',
        'POST /api/v1/fees/late-fees/apply',
        'POST /api/v1/notifications/read-all',
      ].sort(),
    );
  });
});
