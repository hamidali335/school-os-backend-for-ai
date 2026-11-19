import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import {
  DeviceRegisterRequestSchema,
  DeviceRegisterResponseSchema,
  ResolveConflictRequestSchema,
  SnapshotPageQuerySchema,
  SnapshotPageResponseSchema,
  StartSnapshotResponseSchema,
  SyncChangesQuerySchema,
  SyncChangesResponseSchema,
  SyncPullRequestSchema,
  SyncPullResponseSchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
} from './sync.schemas';
import * as syncSvc from './sync.service';

export function registerSyncRoutes(api: Api) {
  const tags = ['Synchronization'];

  api.route({
    method: 'get',
    path: '/sync/health',
    tags,
    auth: 'public',
    summary: 'Synchronization endpoint health check',
    response: z.object({ status: z.literal('ok'), serverTime: z.string() }),
    handler: () => ({ status: 'ok' as const, serverTime: new Date().toISOString() }),
  });

  api.route({
    method: 'post',
    path: '/sync/batch/push',
    tags,
    auth: 'school',
    summary: 'Push batch mutations from desktop application to cloud',
    description: 'Ingests bounded batch of client outbox events with topological dependency ordering and idempotency.',
    body: SyncPushRequestSchema,
    response: SyncPushResponseSchema,
    handler: ({ ctx, req, body }) => {
      const deviceId = req.headers['x-device-id'] as string | undefined;
      return syncSvc.pushBatch(ctx, body, deviceId);
    },
  });

  api.route({
    method: 'post',
    path: '/sync/batch/pull',
    tags,
    auth: 'school',
    permission: 'sync:pull',
    summary: 'Pull incremental changes from cloud to desktop application',
    description: 'Returns incremental change feed with cursor progression and loopback suppression.',
    body: SyncPullRequestSchema,
    response: SyncPullResponseSchema,
    handler: ({ ctx, req, body }) => {
      const deviceId = req.headers['x-device-id'] as string | undefined;
      return syncSvc.pullChanges(ctx, body, deviceId);
    },
  });

  api.route({
    method: 'get',
    path: '/sync/changes',
    tags,
    auth: 'school',
    permission: 'sync:pull',
    summary: 'Sequence-based incremental change stream',
    query: SyncChangesQuerySchema,
    response: SyncChangesResponseSchema,
    handler: ({ ctx, req, query }) => {
      const deviceId = req.headers['x-device-id'] as string | undefined;
      return syncSvc.getChanges(ctx, query, deviceId);
    },
  });

  api.route({
    method: 'post',
    path: '/sync/snapshot/start',
    tags,
    auth: 'school',
    permission: 'sync:pull',
    summary: 'Start consistent snapshot download session',
    body: z.object({}).optional(),
    response: StartSnapshotResponseSchema,
    handler: ({ ctx }) => syncSvc.startSnapshot(ctx),
  });

  api.route({
    method: 'get',
    path: '/sync/snapshot/:id/page',
    tags,
    auth: 'school',
    permission: 'sync:pull',
    summary: 'Fetch paginated entity slice from snapshot session',
    params: z.object({ id: z.string() }),
    query: SnapshotPageQuerySchema,
    response: SnapshotPageResponseSchema,
    handler: ({ ctx, params, query }) => syncSvc.getSnapshotPage(ctx, params.id, query),
  });

  api.route({
    method: 'post',
    path: '/sync/devices/register',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Register a desktop workstation and issue sync device credentials',
    body: DeviceRegisterRequestSchema,
    response: DeviceRegisterResponseSchema,
    handler: ({ ctx, body }) => syncSvc.registerDevice(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/sync/conflicts',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'List unresolved synchronization conflicts for school',
    response: z.array(z.any()),
    handler: ({ ctx }) => syncSvc.listConflicts(ctx),
  });

  api.route({
    method: 'post',
    path: '/sync/conflicts/:conflictId/resolve',
    tags,
    auth: 'school',
    permission: 'school:settings',
    summary: 'Resolve synchronization conflict with administrator decision',
    params: z.object({ conflictId: z.string() }),
    body: ResolveConflictRequestSchema,
    response: z.object({
      success: z.boolean(),
      conflictId: z.string(),
      status: z.string(),
      strategy: z.string(),
    }),
    handler: ({ ctx, params, body }) => syncSvc.resolveConflict(ctx, params.conflictId, body),
  });
}
