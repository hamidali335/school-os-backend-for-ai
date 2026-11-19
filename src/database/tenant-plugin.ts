import type { Schema } from 'mongoose';

/**
 * Tenant guard. Applied to every school-owned collection.
 *
 * Any query, update, delete or aggregation against a tenant collection MUST filter by
 * `schoolId`. If application code forgets, the operation throws instead of silently
 * reading or writing across schools. Platform-level code that legitimately needs
 * cross-tenant aggregates passes `{ crossTenant: true }` in the query options.
 */
const QUERY_HOOKS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

export class TenantScopeError extends Error {
  constructor(model: string, op: string) {
    super(`Tenant scope violation: ${op} on ${model} without schoolId filter`);
    this.name = 'TenantScopeError';
  }
}

function hasSchoolFilter(filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return false;
  if (filter.schoolId !== undefined && filter.schoolId !== null) return true;
  const and = filter.$and;
  if (Array.isArray(and)) return and.some((f) => hasSchoolFilter(f as Record<string, unknown>));
  return false;
}

function schoolIdOf(filter: Record<string, unknown>): unknown {
  if (filter.schoolId !== undefined && filter.schoolId !== null) return filter.schoolId;
  for (const f of (filter.$and as Array<Record<string, unknown>>) ?? []) {
    const found = schoolIdOf(f);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Populated references are fetched with a separate query on the referenced model. Copy
 * the parent's schoolId into each populate match so those queries are tenant-scoped too:
 * a reference that somehow points at another school's document resolves to null.
 * (Convention: tenant documents only populate tenant models.)
 */
function scopePopulate(query: any, schoolId: unknown) {
  const populate = query._mongooseOptions?.populate as Record<string, { match?: unknown }> | undefined;
  if (!populate) return;
  for (const opts of Object.values(populate)) {
    if (typeof opts.match === 'function') continue;
    opts.match = { ...((opts.match as object) ?? {}), schoolId };
  }
}

export function tenantPlugin(schema: Schema): void {
  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function tenantGuard(this: any) {
      const opts = this.getOptions?.() ?? {};
      if (opts.crossTenant) return;
      const filter = this.getFilter();
      if (!hasSchoolFilter(filter)) {
        throw new TenantScopeError(this.model?.modelName ?? 'unknown', hook);
      }
      scopePopulate(this, schoolIdOf(filter));
    });
  }

  schema.pre('aggregate', function tenantAggregateGuard(this: any) {
    if (this.options?.crossTenant) return;
    const first = this.pipeline()[0];
    if (!first || !first.$match || !hasSchoolFilter(first.$match)) {
      throw new TenantScopeError(this._model?.modelName ?? 'unknown', 'aggregate');
    }
  });
  // Inserts (save / create / insertMany) are covered by `schoolId: { required: true }`
  // on every tenant schema, which Mongoose validates before writing.
}
