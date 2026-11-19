import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AccessVerifier, type AccessConfig } from './cloudflare-access';
import { verifyDeviceKey } from '../modules/platform-admin/platform-devices';

/**
 * Who may reach the platform administration API (`/api/v1/platform/*`, including its login).
 * Platform administrators have no MFA of their own yet, so the API is closed to the internet
 * unless one of these is configured (docs/PLATFORM_REMOTE_ACCESS.md):
 *
 *   - Cloudflare Access (PLATFORM_ACCESS_TEAM_DOMAIN + PLATFORM_ACCESS_AUD): every request must
 *     carry a valid Access token for that application, from any network. This is the identity
 *     check (e-mail one-time code or your identity provider) in front of the password, so the
 *     console works from anywhere. The IP allow-list is then not used: it would bring back the
 *     "only from home" restriction and adds nothing an attacker could not get round with a VPN.
 *   - Trusted devices (PLATFORM_DEVICE_ONLY=true): every request must carry the key of a device
 *     registered on the server (header X-Platform-Device), from any network. Only setting up a
 *     device with its one-time code is open (POST /platform/devices/enroll).
 *   - Otherwise PLATFORM_ALLOWED_IPS: client IPs/CIDRs (LAN or VPN). The client address is
 *     `req.ip`, so TRUST_PROXY must match the proxy setup.
 *
 * With Access and/or trusted devices on, each configured check must pass and the IP list is not used.
 *
 * Refused requests get a plain 404, as if the API did not exist.
 */
export function buildAllowList(entries: string[]): net.BlockList | null {
  if (!entries.length) return null;
  const list = new net.BlockList();
  for (const raw of entries) {
    const [addr, bits] = raw.split('/');
    const family = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!family) throw new Error(`PLATFORM_ALLOWED_IPS: not an IP address or CIDR: ${raw}`);
    if (bits === undefined) list.addAddress(addr, family);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 'ipv4' ? 32 : 128))
        throw new Error(`PLATFORM_ALLOWED_IPS: invalid prefix length: ${raw}`);
      list.addSubnet(addr, prefix, family);
    }
  }
  return list;
}

export function ipAllowed(list: net.BlockList, ip: string | undefined): boolean {
  if (!ip) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return list.check(mapped[1], 'ipv4');
  if (net.isIPv4(ip)) return list.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return list.check(ip, 'ipv6');
  return false;
}

/** Cloudflare Access settings for the platform API, or null when not configured. */
export function accessConfigFromEnv(e = env): AccessConfig | null {
  if (!e.PLATFORM_ACCESS_TEAM_DOMAIN || !e.PLATFORM_ACCESS_AUD) return null;
  return {
    teamDomain: e.PLATFORM_ACCESS_TEAM_DOMAIN.replace(/\/+$/, ''),
    audience: e.PLATFORM_ACCESS_AUD,
    emails: e.PLATFORM_ACCESS_EMAILS.map((x) => x.toLowerCase()),
  };
}

/** Platform route open without a device key: setting up a device with its one-time code. */
export const DEVICE_ENROLL_PATH = '/devices/enroll';
/**
 * Also open without a device key: a backup download. The browser opens it as a plain link, which
 * cannot carry the key; the single-use, 2-minute token in the link can only be created by a signed-in
 * owner on a registered device (POST /backups/:id/download-link), so it is the proof instead.
 */
export const BACKUP_DOWNLOAD_PATH = '/backups/download';

export function platformNetworkGuard(
  entries: string[] = env.PLATFORM_ALLOWED_IPS,
  opts: { access?: AccessConfig | null; verifier?: AccessVerifier; deviceOnly?: boolean } = {},
) {
  const access = opts.access === undefined ? accessConfigFromEnv() : opts.access;
  const verifier = access ? (opts.verifier ?? new AccessVerifier(access)) : null;
  const deviceOnly = opts.deviceOnly ?? env.PLATFORM_DEVICE_ONLY;
  const list = access || deviceOnly ? null : buildAllowList(entries);
  return (req: Request, res: Response, next: NextFunction) => {
    const refuse = (reason: string) => {
      logger.warn({ ip: req.ip, path: req.path, reason, requestId: req.requestId }, 'Platform API request refused');
      notFound(req, res);
    };
    void (async () => {
      if (verifier) {
        const r = await verifier.verify(req.get('cf-access-jwt-assertion'));
        if (!r.ok) return refuse(`access_${r.reason}`);
      }
      if (deviceOnly) {
        const enrolling = req.method === 'POST' && req.path === DEVICE_ENROLL_PATH;
        const downloading = req.method === 'GET' && req.path === BACKUP_DOWNLOAD_PATH;
        if (!enrolling && !downloading && !(await verifyDeviceKey(req.get('x-platform-device'))))
          return refuse('device_not_registered');
      }
      if (list && !ipAllowed(list, req.ip)) return refuse('address_not_allowed');
      next();
    })().catch(() => refuse('guard_error'));
  };
}

function notFound(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl.split('?')[0]} not found`,
      requestId: req.requestId,
    },
  });
}
