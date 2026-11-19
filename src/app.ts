import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env, isProd } from './config/env';
import { logger } from './config/logger';
import './types/context';
import { buildOpenApiDocument } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { platformNetworkGuard } from './middleware/platform-network';
import { globalLimiter } from './middleware/rate-limit';
import { writeFreezeGuard } from './services/write-freeze';
import { requestId } from './middleware/request-id';
import { registerHealthRoutes, registerIndexRoutes } from './modules/health/health.routes';
import { registerModuleRoutes } from './modules';
import { clientVersionGuard } from './modules/meta/meta.routes';
import { Api } from './utils/api';

export const API_PREFIX = '/api/v1';

function corsOrigin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
  // Non-browser clients (curl, server-to-server) send no Origin header.
  if (!origin) return cb(null, true);
  if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
  // Development only: this machine and devices on the local network (e.g. testing on a phone),
  // whatever address the router gives this PC today. Production uses CORS_ORIGINS alone.
  if (!isProd && isLocalDevOrigin(origin)) return cb(null, true);
  return cb(null, false);
}

/** http://localhost, 127.0.0.1 or a private LAN IPv4 (10.x, 172.16–31.x, 192.168.x), any port. */
export function isLocalDevOrigin(origin: string) {
  const m = /^http:\/\/([^/:]+)(:\d+)?$/.exec(origin);
  if (!m) return false;
  const host = m[1];
  if (host === 'localhost' || host === '127.0.0.1') return true;
  const ip = host.split('.').map(Number);
  if (ip.length !== 4 || ip.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168);
}

export function buildApis() {
  const registry = new OpenAPIRegistry();
  const root = new Api('', registry);
  registerHealthRoutes(root);
  const api = new Api(API_PREFIX, registry);
  registerIndexRoutes(root, api);
  registerModuleRoutes(api);
  return { root, api, registry, openapi: buildOpenApiDocument(registry) };
}

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      customProps: (req) => {
        const ctx = (req as express.Request).ctx;
        return ctx?.kind === 'school' ? { schoolId: ctx.schoolId, userId: ctx.userId } : {};
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  const { root, api, openapi } = buildApis();

  // API docs — served before helmet's strict CSP, which would block Swagger UI assets.
  if (env.API_DOCS_ENABLED) {
    app.get('/api-docs.json', (_req, res) => res.json(openapi));
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: `${env.APP_NAME} API` }));
  }

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigin,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // X-Platform-Device: the platform console's trusted-device key (platform-devices.ts).
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Platform-Device'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After', 'Content-Disposition'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(globalLimiter);

  // Browsers request this automatically; answer quietly instead of logging a 404.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.use(root.router);
  app.use(`${API_PREFIX}/platform`, platformNetworkGuard());
  app.use(writeFreezeGuard);
  app.use(API_PREFIX, clientVersionGuard);
  app.use(API_PREFIX, api.router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
