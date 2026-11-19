import { Types, type Model } from 'mongoose';
import { SELF_SCOPED_ROLES } from '../config/permissions';
import type { SchoolContext, SystemContext } from '../types/context';
import { badRequest, forbidden, notFound } from './errors';

type TenantCtx = Pick<SchoolContext, 'schoolId'> | SystemContext;

export const oid = (id: string | Types.ObjectId) => (typeof id === 'string' ? new Types.ObjectId(id) : id);

/** Base filter for every tenant query. The schoolId always comes from the authenticated context. */
export function scope(ctx: TenantCtx, extra?: Record<string, unknown>): any {
  return { schoolId: oid(ctx.schoolId), ...(extra ?? {}) };
}

/**
 * Restrict a filter to the campuses the user may access. Users with no campus restriction
 * see every campus of their school.
 */
export function campusScope(ctx: SchoolContext, field = 'campusId'): Record<string, unknown> {
  if (!ctx.campusIds.length) return {};
  return { [field]: { $in: ctx.campusIds.map(oid) } };
}

export function assertCampusAccess(ctx: SchoolContext, campusId: string | Types.ObjectId | undefined | null) {
  if (!ctx.campusIds.length || !campusId) return;
  if (!ctx.campusIds.includes(campusId.toString())) throw forbidden('You do not have access to this campus');
}

/**
 * Load a document by id, guaranteeing it belongs to the caller's school. A foreign id
 * yields 404 — never a hint that the record exists in another tenant.
 */
export type LeanDoc<M> = M extends Model<infer Raw, any, any, any, any, any> ? Raw & { _id: Types.ObjectId } : any;

export async function findOwned<M extends Model<any>>(
  model: M,
  ctx: TenantCtx,
  id: string | Types.ObjectId,
  label: string,
  projection?: string,
): Promise<LeanDoc<M>> {
  if (!Types.ObjectId.isValid(id)) throw notFound(label);
  const q = model.findOne({ _id: oid(id), schoolId: oid(ctx.schoolId) } as any);
  if (projection) q.select(projection);
  const doc = await q.lean();
  if (!doc) throw notFound(label);
  return doc as LeanDoc<M>;
}

/**
 * Verify that ids supplied in a request body (e.g. classId, sectionId) belong to the
 * caller's school before they are written. Prevents linking to another tenant's records.
 */
export async function assertRefs(
  ctx: TenantCtx,
  refs: Array<[Model<any>, string | Types.ObjectId | undefined | null, string]>,
): Promise<void> {
  for (const [model, id, label] of refs) {
    if (id === undefined || id === null) continue;
    if (!Types.ObjectId.isValid(id)) throw badRequest(`Invalid ${label} id`);
    const exists = await model.exists({ _id: oid(id), schoolId: oid(ctx.schoolId) });
    if (!exists) throw badRequest(`${label} does not exist in this school`, { field: label }, 'INVALID_REFERENCE');
  }
}

export async function assertManyRefs(
  ctx: TenantCtx,
  model: Model<any>,
  ids: Array<string | Types.ObjectId>,
  label: string,
) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return;
  if (unique.some((id) => !Types.ObjectId.isValid(id))) throw badRequest(`Invalid ${label} id`);
  const count = await model.countDocuments({ _id: { $in: unique.map(oid) }, schoolId: oid(ctx.schoolId) });
  if (count !== unique.length)
    throw badRequest(`One or more ${label} ids do not exist in this school`, undefined, 'INVALID_REFERENCE');
}

export const isSelfScoped = (ctx: SchoolContext) => SELF_SCOPED_ROLES.has(ctx.role);
