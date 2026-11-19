import { z } from '../../utils/zod';

export const SyncOperationEnum = z.enum(['INSERT', 'UPDATE', 'DELETE']);
export type SyncOperation = z.infer<typeof SyncOperationEnum>;

export const SyncPushEventSchema = z.object({
  eventId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  operation: SyncOperationEnum,
  payload: z.record(z.string(), z.any()),
  localVersion: z.number().int().min(1),
  baseVersion: z.number().int().optional(),
  idempotencyKey: z.string().min(1),
  deviceId: z.string().min(1),
  schemaVersion: z.number().int().default(1),
  dependencyId: z.string().nullable().optional(),
  createdAt: z.string().optional().default(() => new Date().toISOString()),
});
export type SyncPushEvent = z.infer<typeof SyncPushEventSchema>;

export const SyncPushRequestSchema = z.object({
  schoolId: z.string().optional(),
  events: z.array(SyncPushEventSchema).max(500),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const ConflictDetailsSchema = z.object({
  remotePayload: z.any(),
  conflictingFields: z.array(z.string()),
  reason: z.string(),
});

export const SyncPushEventAckSchema = z.object({
  eventId: z.string(),
  entityId: z.string(),
  status: z.enum(['synced', 'conflict', 'rejected']),
  serverVersion: z.number().int().optional(),
  permanent: z.boolean().optional(),
  errorCode: z.string().optional(),
  conflictDetails: ConflictDetailsSchema.optional(),
  errorMessage: z.string().optional(),
  retryAfterSeconds: z.number().int().optional(),
});
export type SyncPushEventAck = z.infer<typeof SyncPushEventAckSchema>;

export const SyncPushResponseSchema = z.object({
  success: z.boolean(),
  acknowledgedCount: z.number().int(),
  failedCount: z.number().int(),
  conflictCount: z.number().int(),
  events: z.array(SyncPushEventAckSchema),
  serverTime: z.string(),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

export const SyncPullRequestSchema = z.object({
  schoolId: z.string().optional(),
  cursors: z.record(z.string(), z.string()).optional().default({}),
  limit: z.number().int().min(1).max(500).optional().default(100),
});
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const RemoteChangeItemSchema = z.object({
  changeId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  operation: SyncOperationEnum,
  payload: z.any(),
  remoteVersion: z.number().int(),
  timestamp: z.string(),
  originDeviceId: z.string().optional(),
});
export type RemoteChangeItem = z.infer<typeof RemoteChangeItemSchema>;

export const SyncPullResponseSchema = z.object({
  success: z.boolean(),
  hasMore: z.boolean(),
  nextCursors: z.record(z.string(), z.string()),
  changes: z.array(RemoteChangeItemSchema),
  serverTime: z.string(),
});
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

// Sequence-based change feed schemas (Section 4)
export const SyncChangesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type SyncChangesQuery = z.infer<typeof SyncChangesQuerySchema>;

export const SyncChangeFeedItemSchema = z.object({
  seq: z.number().int(),
  version: z.number().int(),
  deleted: z.boolean(),
  entityType: z.string(),
  entityId: z.string(),
  operation: SyncOperationEnum,
  payload: z.any(),
  timestamp: z.string(),
  originDeviceId: z.string().optional(),
});
export type SyncChangeFeedItem = z.infer<typeof SyncChangeFeedItemSchema>;

export const SyncChangesResponseSchema = z.object({
  changes: z.array(SyncChangeFeedItemSchema),
  hasMore: z.boolean(),
  latestSeq: z.number().int(),
  minRetainedSeq: z.number().int(),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponseSchema>;

// Snapshot schemas
export const StartSnapshotResponseSchema = z.object({
  snapshotId: z.string(),
  seq: z.number().int(),
});
export type StartSnapshotResponse = z.infer<typeof StartSnapshotResponseSchema>;

export const SnapshotPageQuerySchema = z.object({
  entity: z.enum(['STUDENT', 'ATTENDANCE']),
  cursor: z.string().optional(),
});
export type SnapshotPageQuery = z.infer<typeof SnapshotPageQuerySchema>;

export const SnapshotPageResponseSchema = z.object({
  items: z.array(z.any()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type SnapshotPageResponse = z.infer<typeof SnapshotPageResponseSchema>;

export const DeviceRegisterRequestSchema = z.object({
  schoolId: z.string().optional(),
  deviceName: z.string().min(1).max(120),
  platform: z.enum(['windows_desktop', 'mobile', 'web', 'other']).default('windows_desktop'),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequestSchema>;

export const DeviceRegisterResponseSchema = z.object({
  success: z.boolean(),
  deviceId: z.string(),
  token: z.string().optional(),
  refreshToken: z.string().optional(),
  serverTime: z.string(),
  error: z.string().optional(),
});
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponseSchema>;

export const ResolveConflictRequestSchema = z.object({
  resolutionStrategy: z.enum(['local_wins', 'remote_wins', 'merged']),
  resolutionNotes: z.string().optional(),
});
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;
