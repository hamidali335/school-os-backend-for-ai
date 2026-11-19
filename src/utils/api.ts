import { OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType } from 'zod';
import { PERMISSION_FEATURE, type FeatureKey } from '../config/entitlements';
import type { Permission, PlatformRole, SchoolRole } from '../config/permissions';
import { assertEntitled } from '../modules/subscriptions/entitlements.service';
import { authenticatePlatform, authenticateSchool } from '../middleware/authenticate';
import type { PlatformContext, SchoolContext } from '../types/context';
import { AppError, forbidden } from './errors';
import { ErrorResponse, PaginationMeta, z } from './zod';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Infer<T> = T extends ZodType ? z.output<T> : undefined;

export interface Paginated<T> {
  items: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface BaseRoute<P, Q, B> {
  method: Method;
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  params?: P;
  query?: Q;
  body?: B;
  /** Schema of `data` in the success envelope (or of each item when `paginated`). */
  response?: ZodType;
  paginated?: boolean;
  status?: number;
  /** Non-JSON response (e.g. PDF/CSV). The handler writes the response itself. */
  produces?:
    | 'application/pdf'
    | 'text/csv'
    | 'application/octet-stream'
    | 'image/png'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  /** multipart/form-data upload with a single file field. */
  upload?: { middleware: RequestHandler; field: string; extraFields?: ZodType };
  middleware?: RequestHandler[];
}

interface PublicRoute<P, Q, B> extends BaseRoute<P, Q, B> {
  auth: 'public';
  handler: (args: HandlerArgs<P, Q, B, undefined>) => Promise<unknown> | unknown;
}

interface SchoolRoute<P, Q, B> extends BaseRoute<P, Q, B> {
  auth: 'school';
  /** All listed permissions are required. */
  permission?: Permission | Permission[];
  /** Optionally restrict to specific roles (in addition to permissions). */
  roles?: SchoolRole[];
  /**
   * Plan features this route needs, in addition to those implied by its permissions
   * (PERMISSION_FEATURE). `null` turns the permission-derived check off for this route.
   */
  feature?: FeatureKey | FeatureKey[] | null;
  allowInactiveSubscription?: boolean;
  handler: (args: HandlerArgs<P, Q, B, SchoolContext>) => Promise<unknown> | unknown;
}

interface PlatformRoute<P, Q, B> extends BaseRoute<P, Q, B> {
  auth: 'platform';
  platformRoles?: PlatformRole[];
  handler: (args: HandlerArgs<P, Q, B, PlatformContext>) => Promise<unknown> | unknown;
}

export interface HandlerArgs<P, Q, B, C> {
  req: Request;
  res: Response;
  ctx: C;
  params: Infer<P>;
  query: Infer<Q>;
  body: Infer<B>;
}

export type ApiRoute<P, Q, B> = PublicRoute<P, Q, B> | SchoolRoute<P, Q, B> | PlatformRoute<P, Q, B>;

const DATA_ENVELOPE = (schema: ZodType) => z.object({ data: schema });
const PAGE_ENVELOPE = (schema: ZodType) => z.object({ data: z.array(schema), meta: PaginationMeta });

/** Features a school route needs: explicit ones, plus those its permissions belong to. */
export function routeFeatures(def: {
  permission?: Permission | Permission[];
  feature?: FeatureKey | FeatureKey[] | null;
}): FeatureKey[] {
  if (def.feature === null) return [];
  const out = new Set<FeatureKey>(def.feature ? ([] as FeatureKey[]).concat(def.feature) : []);
  for (const p of def.permission ? ([] as Permission[]).concat(def.permission) : []) {
    const f = PERMISSION_FEATURE.get(p);
    if (f) out.add(f);
  }
  return [...out];
}

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parseOrThrow(schema: ZodType, value: unknown, where: string) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Invalid request ${where}`,
      result.error.issues.map((i) => ({ path: [where, ...i.path].join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * A versioned API surface. Every route registered here is simultaneously mounted on the
 * Express router and described in the OpenAPI registry, so the published documentation
 * always matches what the server actually validates and enforces.
 */
export class Api {
  readonly router = Router();
  readonly registry: OpenAPIRegistry;

  constructor(
    readonly prefix: string,
    registry?: OpenAPIRegistry,
  ) {
    this.registry = registry ?? new OpenAPIRegistry();
  }

  route<
    P extends ZodType | undefined = undefined,
    Q extends ZodType | undefined = undefined,
    B extends ZodType | undefined = undefined,
  >(def: ApiRoute<P, Q, B>): void {
    const chain: RequestHandler[] = [...(def.middleware ?? [])];

    if (def.auth === 'school') {
      chain.push(authenticateSchool({ allowInactiveSubscription: def.allowInactiveSubscription }));
      const required = def.permission ? (Array.isArray(def.permission) ? def.permission : [def.permission]) : [];
      const roles = def.roles;
      const features = routeFeatures(def);
      if (required.length || roles || features.length) {
        chain.push((req, _res, next) => {
          const ctx = req.ctx as SchoolContext;
          if (roles && !roles.includes(ctx.role)) throw forbidden();
          for (const p of required) if (!ctx.permissions.has(p)) throw forbidden();
          // Both are needed: the role permission AND the school's subscription entitlement.
          assertEntitled({ features: ctx.entitlements, eligible: ctx.subscriptionEligible }, features);
          next();
        });
      }
    } else if (def.auth === 'platform') {
      chain.push(authenticatePlatform());
      if (def.platformRoles) {
        const allowed = def.platformRoles;
        chain.push((req, _res, next) => {
          if (!allowed.includes((req.ctx as PlatformContext).role)) throw forbidden();
          next();
        });
      }
    }

    if (def.upload) chain.push(def.upload.middleware);

    const handler = async (req: Request, res: Response, _next: NextFunction) => {
      const params = def.params ? parseOrThrow(def.params, req.params, 'params') : undefined;
      const query = def.query ? parseOrThrow(def.query, req.query, 'query') : undefined;
      const body = def.body ? parseOrThrow(def.body, req.body, 'body') : undefined;
      const result = await (def.handler as (a: any) => unknown)({
        req,
        res,
        ctx: req.ctx,
        params,
        query,
        body,
      });
      if (res.headersSent) return;
      if (def.paginated) {
        const page = result as Paginated<unknown>;
        res.status(def.status ?? 200).json({ data: page.items, meta: page.meta });
      } else if (def.status === 204) {
        res.status(204).end();
      } else {
        res.status(def.status ?? 200).json({ data: result ?? null });
      }
    };

    this.router[def.method](def.path, ...chain, handler);
    this.document(def);
  }

  private document(def: ApiRoute<any, any, any>) {
    const permission = 'permission' in def && def.permission ? ([] as Permission[]).concat(def.permission) : [];
    const roles = 'roles' in def && def.roles ? def.roles : undefined;
    const platformRoles = 'platformRoles' in def && def.platformRoles ? def.platformRoles : undefined;

    const accessNotes: string[] = [];
    if (def.auth === 'public') accessNotes.push('**Auth:** none');
    if (def.auth === 'school') accessNotes.push('**Auth:** school user bearer token');
    if (def.auth === 'platform') accessNotes.push('**Auth:** platform admin bearer token');
    if (permission.length) accessNotes.push(`**Permissions:** ${permission.map((p) => `\`${p}\``).join(', ')}`);
    const planFeatures = def.auth === 'school' ? routeFeatures(def) : [];
    if (planFeatures.length) accessNotes.push(`**Plan features:** ${planFeatures.map((f) => `\`${f}\``).join(', ')}`);
    if (roles) accessNotes.push(`**Roles:** ${roles.map((r) => `\`${r}\``).join(', ')}`);
    if (platformRoles) accessNotes.push(`**Platform roles:** ${platformRoles.map((r) => `\`${r}\``).join(', ')}`);

    const successStatus = def.status ?? 200;
    const responses: RouteConfig['responses'] = {};
    if (def.produces) {
      responses[successStatus] = {
        description: 'File download',
        content: { [def.produces]: { schema: { type: 'string', format: 'binary' } } },
      };
    } else if (successStatus === 204) {
      responses[204] = { description: 'No content' };
    } else {
      const dataSchema = def.response ?? z.any();
      responses[successStatus] = {
        description: 'Success',
        content: {
          'application/json': { schema: def.paginated ? PAGE_ENVELOPE(dataSchema) : DATA_ENVELOPE(dataSchema) },
        },
      };
    }
    const err = (description: string) => ({ description, content: { 'application/json': { schema: ErrorResponse } } });
    responses[400] = err('Validation error (`VALIDATION_ERROR`) or bad request');
    if (def.auth !== 'public') {
      responses[401] = err('Missing, invalid or expired token (`UNAUTHORIZED`, `TOKEN_EXPIRED`)');
      responses[403] = err(
        'Not permitted (`FORBIDDEN`, `SCHOOL_SUSPENDED`, `ACCOUNT_DISABLED`, or `FEATURE_NOT_IN_PLAN` when the school’s plan does not include a feature)',
      );
    }
    if (def.path.includes(':')) responses[404] = err('Resource not found in your school (`NOT_FOUND`)');
    if (def.method !== 'get' && def.auth === 'school') {
      responses[402] = err('School subscription inactive; writes blocked (`SUBSCRIPTION_INACTIVE`)');
    }
    responses[429] = err('Rate limited');

    const request: RouteConfig['request'] = {};
    if (def.params) request.params = def.params as any;
    if (def.query) request.query = def.query as any;
    if (def.body) request.body = { content: { 'application/json': { schema: def.body } }, required: true };
    if (def.upload) {
      const fields = (def.upload.extraFields as any) ?? z.object({});
      request.body = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: fields.extend({ [def.upload.field]: z.any().openapi({ type: 'string', format: 'binary' }) }),
          },
        },
      };
    }

    this.registry.registerPath({
      method: def.method,
      path: toOpenApiPath(this.prefix + def.path),
      tags: def.tags,
      summary: def.summary,
      description: [def.description, accessNotes.join('  \n')].filter(Boolean).join('\n\n'),
      security: def.auth === 'public' ? [] : [{ [def.auth === 'platform' ? 'platformBearer' : 'schoolBearer']: [] }],
      request,
      responses,
    });
  }
}
