import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env } from '../../config/env';
import { databaseState, pingDatabase } from '../../database/connection';
import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';

const startedAt = new Date();

const ServiceInfo = z
  .object({
    name: z.string(),
    version: z.string(),
    apiBaseUrl: z.string(),
    docs: z.string(),
    openapi: z.string(),
    health: z.string(),
    readiness: z.string(),
    auth: z.object({ schoolLogin: z.string(), platformLogin: z.string() }),
    instance: z
      .object({
        name: z.string().nullable(),
        database: z.string().nullable(),
      })
      .openapi({
        description:
          'Which backend and database answered: INSTANCE_NAME, and a short fingerprint of the connected database (a hash; never the address or credentials). Two apps showing different fingerprints are using different data.',
      }),
  })
  .openapi('ServiceInfo');

/** Non-secret identity of this instance, so clients can show which backend and database they reach. */
export function instanceInfo() {
  const c = mongoose.connection;
  const database =
    c.readyState === 1 && c.name
      ? crypto.createHash('sha256').update(`${c.host}/${c.name}`).digest('hex').slice(0, 8)
      : null;
  return { name: env.INSTANCE_NAME ?? null, database };
}

function serviceInfo(apiPrefix: string) {
  return {
    name: 'School OS API',
    version: process.env.npm_package_version ?? '1.0.0',
    apiBaseUrl: apiPrefix,
    docs: '/api-docs',
    openapi: '/api-docs.json',
    health: '/health',
    readiness: '/health/ready',
    auth: { schoolLogin: `POST ${apiPrefix}/auth/login`, platformLogin: `POST ${apiPrefix}/platform/auth/login` },
    instance: instanceInfo(),
  };
}

/** Friendly index responses so `/` and `/api/v1` explain where to go instead of returning 404. */
export function registerIndexRoutes(root: Api, api: Api) {
  root.route({
    method: 'get',
    path: '/',
    tags: ['Health'],
    auth: 'public',
    summary: 'Service index (links to docs, health and login endpoints)',
    response: ServiceInfo,
    handler: () => serviceInfo(api.prefix),
  });
  api.route({
    method: 'get',
    path: '/',
    tags: ['Health'],
    auth: 'public',
    summary: 'API v1 index (links to docs, health and login endpoints)',
    response: ServiceInfo,
    handler: () => serviceInfo(api.prefix),
  });
}

export function registerHealthRoutes(root: Api) {
  root.route({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    auth: 'public',
    summary: 'Liveness check',
    description: 'Returns 200 while the process is running. Does not touch the database.',
    response: z.object({
      status: z.literal('ok'),
      uptimeSeconds: z.number(),
      startedAt: z.string(),
      timestamp: z.string(),
      version: z.string(),
    }),
    handler: () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: startedAt.toISOString(),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
    }),
  });

  root.route({
    method: 'get',
    path: '/health/ready',
    tags: ['Health'],
    auth: 'public',
    summary: 'Readiness check (database connectivity)',
    description: 'Returns 200 when MongoDB answers a ping, otherwise 503. Use for load-balancer readiness probes.',
    response: z.object({
      status: z.enum(['ready', 'not_ready']),
      database: z.object({ state: z.string(), latencyMs: z.number().nullable() }),
    }),
    handler: async ({ res }) => {
      const ping = await pingDatabase();
      const body = {
        status: ping.ok ? ('ready' as const) : ('not_ready' as const),
        database: { state: databaseState(), latencyMs: ping.latencyMs },
      };
      if (!ping.ok) {
        res.status(503).json({ data: body });
        return;
      }
      return body;
    },
  });
}
