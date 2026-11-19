import type { Request, Response, NextFunction } from 'express';
import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';

export const API_VERSION = '1.0.0';
export let MIN_CLIENT_VERSION = '1.0.0';
export const RECOMMENDED_CLIENT_VERSION = '1.0.0';

export function getMinClientVersion(): string {
  return process.env.MIN_DESKTOP_CLIENT_VERSION || MIN_CLIENT_VERSION;
}

export function setMinClientVersionForTesting(version: string) {
  MIN_CLIENT_VERSION = version;
  process.env.MIN_DESKTOP_CLIENT_VERSION = version;
}

export function compareVersions(v1: string, v2: string): number {
  const p1 = v1.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = v2.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export function clientVersionGuard(req: Request, res: Response, next: NextFunction) {
  const clientType = req.headers['x-client-type'];
  if (clientType === 'desktop') {
    const minVersion = getMinClientVersion();
    const clientVersion = req.headers['x-client-version'] as string | undefined;
    if (!clientVersion || compareVersions(clientVersion, minVersion) < 0) {
      return res.status(426).json({
        error: {
          code: 'CLIENT_UPGRADE_REQUIRED',
          message: `Desktop client version "${clientVersion || 'unknown'}" is below minimum supported version "${minVersion}". Please update your application.`,
          minClientVersion: minVersion,
          recommendedClientVersion: minVersion,
        },
      });
    }
  }
  next();
}

export function registerMetaRoutes(api: Api) {
  api.route({
    method: 'get',
    path: '/meta/compat',
    tags: ['System Metadata'],
    auth: 'public',
    summary: 'Check API and desktop client compatibility specifications',
    response: z.object({
      apiVersion: z.string(),
      minClientVersion: z.string(),
      recommendedClientVersion: z.string(),
      capabilities: z.array(z.string()),
    }),
    handler: () => ({
      apiVersion: API_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
      recommendedClientVersion: RECOMMENDED_CLIENT_VERSION,
      capabilities: ['sync_v2', 'sequence_feed', 'consistent_snapshot', 'atomic_batches'],
    }),
  });
}
