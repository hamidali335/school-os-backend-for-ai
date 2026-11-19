import type { Model } from 'mongoose';
import type { ZodObject, ZodType } from 'zod';
import type { Permission } from '../config/permissions';
import type { SchoolContext } from '../types/context';
import { audit } from '../modules/audit/audit.service';
import type { Api } from './api';
import { conflict, notFound } from './errors';
import { paginate, textSearchFilter } from './pagination';
import { assertRefs, campusScope, findOwned, oid, scope } from './tenant';
import { idParams, objectId, paginationQuery, z } from './zod';

type Ref = [Model<any>, string | undefined | null, string];

export interface CrudOptions {
  path: string;
  tag: string;
  label: string;
  model: Model<any>;
  read: Permission;
  write: Permission;
  createSchema: ZodObject<any>;
  updateSchema?: ZodObject<any>;
  response: ZodType;
  /** Extra list filters accepted in the query string, mapped to a Mongo filter. */
  filters?: { schema: ZodObject<any>; toFilter: (q: any) => Record<string, unknown> };
  searchFields?: string[];
  sort?: Record<string, 1 | -1>;
  /** Restrict reads to campuses the user can access (model must have campusId). */
  campusScoped?: boolean;
  refs?: (body: any) => Ref[];
  /** Throw if the record is still referenced and must not be deleted. */
  beforeDelete?: (ctx: SchoolContext, doc: any) => Promise<void>;
  /** Mutate the document data before insert/update (e.g. derive fields). */
  prepare?: (
    ctx: SchoolContext,
    body: any,
    existing?: any,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  afterCreate?: (ctx: SchoolContext, doc: any) => Promise<void>;
  afterUpdate?: (ctx: SchoolContext, doc: any, before: any) => Promise<void>;
  populate?: Array<{ path: string; select: string }>;
  disableDelete?: boolean;
}

/**
 * Generates list/get/create/update/delete endpoints for a simple tenant-owned resource.
 * Every operation is scoped by the caller's schoolId and verifies referenced ids belong to
 * the same school.
 */
export function crudRoutes(api: Api, o: CrudOptions) {
  const tags = [o.tag];
  const listQuery = paginationQuery.extend({ q: z.string().max(100).optional() }).extend(o.filters?.schema.shape ?? {});

  api.route({
    method: 'get',
    path: o.path,
    tags,
    auth: 'school',
    permission: o.read,
    summary: `List ${o.label}s`,
    query: listQuery,
    response: o.response,
    paginated: true,
    handler: async ({ ctx, query }) => {
      const q = query as any;
      const filter: Record<string, unknown> = scope(ctx, o.filters ? o.filters.toFilter(q) : {});
      if (o.campusScoped) Object.assign(filter, campusScope(ctx));
      // Each word may match a different field ("Hamid Ali" over name; "Lahore Main" over name and city).
      const match = o.searchFields?.length ? textSearchFilter(q.q, o.searchFields) : undefined;
      if (match) filter.$or = match.$or;
      return paginate(o.model, filter, { page: q.page, limit: q.limit, sort: o.sort, populate: o.populate });
    },
  });

  api.route({
    method: 'get',
    path: `${o.path}/:id`,
    tags,
    auth: 'school',
    permission: o.read,
    summary: `Get a ${o.label}`,
    params: idParams,
    response: o.response,
    handler: async ({ ctx, params }) => {
      const filter = { _id: oid(params.id), ...scope(ctx), ...(o.campusScoped ? campusScope(ctx) : {}) };
      const q = o.model.findOne(filter);
      for (const p of o.populate ?? []) q.populate(p.path, p.select);
      const doc = await q.lean();
      if (!doc) throw notFound(o.label);
      return doc;
    },
  });

  api.route({
    method: 'post',
    path: o.path,
    tags,
    auth: 'school',
    permission: o.write,
    summary: `Create a ${o.label}`,
    body: o.createSchema,
    response: o.response,
    status: 201,
    handler: async ({ ctx, body }) => {
      if (o.refs) await assertRefs(ctx, o.refs(body));
      const data = o.prepare ? await o.prepare(ctx, body) : body;
      const doc = await o.model.create({ ...data, schoolId: ctx.schoolId });
      await audit(ctx, {
        action: `${o.model.modelName.toLowerCase()}.create`,
        entityType: o.model.modelName,
        entityId: doc._id,
      });
      if (o.afterCreate) await o.afterCreate(ctx, doc);
      return doc.toObject();
    },
  });

  api.route({
    method: 'patch',
    path: `${o.path}/:id`,
    tags,
    auth: 'school',
    permission: o.write,
    summary: `Update a ${o.label}`,
    params: idParams,
    body: (o.updateSchema ?? o.createSchema.partial()) as ZodObject<any>,
    response: o.response,
    handler: async ({ ctx, params, body }) => {
      const existing = await findOwned(o.model, ctx, params.id, o.label);
      if (o.refs) await assertRefs(ctx, o.refs(body));
      const data = o.prepare ? await o.prepare(ctx, body, existing) : body;
      const doc = await o.model
        .findOneAndUpdate(
          { _id: existing._id, ...scope(ctx) },
          { $set: data },
          { returnDocument: 'after', runValidators: true },
        )
        .lean();
      await audit(ctx, {
        action: `${o.model.modelName.toLowerCase()}.update`,
        entityType: o.model.modelName,
        entityId: existing._id,
        metadata: { fields: Object.keys(body as object) },
      });
      if (o.afterUpdate && doc) await o.afterUpdate(ctx, doc, existing);
      return doc;
    },
  });

  if (!o.disableDelete) {
    api.route({
      method: 'delete',
      path: `${o.path}/:id`,
      tags,
      auth: 'school',
      permission: o.write,
      summary: `Delete a ${o.label}`,
      description: 'Fails with 409 CONFLICT when other records still reference it.',
      params: idParams,
      status: 204,
      handler: async ({ ctx, params }) => {
        const existing = await findOwned(o.model, ctx, params.id, o.label);
        if (o.beforeDelete) await o.beforeDelete(ctx, existing);
        await o.model.deleteOne({ _id: existing._id, ...scope(ctx) });
        await audit(ctx, {
          action: `${o.model.modelName.toLowerCase()}.delete`,
          entityType: o.model.modelName,
          entityId: existing._id,
        });
      },
    });
  }
}

/** Helper for beforeDelete: refuse if any of the given (model, field) pairs still reference the id. */
export function refuseIfReferenced(checks: Array<[Model<any>, string, string]>) {
  return async (ctx: SchoolContext, doc: { _id: unknown }) => {
    for (const [model, field, label] of checks) {
      if (await model.exists({ ...scope(ctx), [field]: doc._id })) {
        throw conflict(`Cannot delete: still referenced by ${label}`);
      }
    }
  };
}

export const refId = objectId;
