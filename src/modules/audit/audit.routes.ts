import type { Api } from '../../utils/api';
import { localDayRange } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { paginate } from '../../utils/pagination';
import { oid } from '../../utils/tenant';
import { docBase, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { AuditLog } from './audit.model';

export const AuditRes = z
  .object({
    ...docBase,
    actorType: z.enum(['user', 'platform_admin', 'system', 'ai']),
    actorId: objectId().optional(),
    actorName: z.string().optional(),
    actorRole: z.string().optional(),
    action: z.string(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    summary: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    outcome: z.enum(['success', 'failure']),
    ip: z.string().optional(),
    requestId: z.string().optional(),
  })
  .openapi('AuditLog');

export function registerAuditRoutes(api: Api) {
  api.route({
    method: 'get',
    path: '/audit-logs',
    tags: ['Audit'],
    auth: 'school',
    permission: 'audit:read',
    summary: "The school's audit trail",
    query: paginationQuery.extend({
      action: z.string().max(80).optional(),
      actorId: objectId().optional(),
      entityType: z.string().max(60).optional(),
      entityId: z.string().max(40).optional(),
      from: isoDate().optional(),
      to: isoDate().optional(),
    }),
    response: AuditRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      // Explicit tenant filter (AuditLog also holds platform-level events with no schoolId).
      const filter: Record<string, unknown> = { schoolId: oid(ctx.schoolId) };
      if (query.action) filter.action = query.action;
      if (query.actorId) filter.actorId = oid(query.actorId);
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = query.entityId;
      if (query.from || query.to) {
        const tz = await schoolTimezone(ctx.schoolId);
        filter.createdAt = {
          ...(query.from ? { $gte: localDayRange(query.from, query.from, tz).start } : {}),
          ...(query.to ? { $lt: localDayRange(query.to, query.to, tz).end } : {}),
        };
      }
      return paginate(AuditLog, filter, { page: query.page, limit: query.limit, sort: { createdAt: -1 } });
    },
  });
}
