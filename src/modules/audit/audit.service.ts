import { logger } from '../../config/logger';
import type { PlatformContext, SchoolContext, SystemContext } from '../../types/context';
import { AuditLog } from './audit.model';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | { toString(): string };
  summary?: string;
  metadata?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
  /** Mark actions proposed by AI (still executed under a human's authority). */
  viaAi?: boolean;
}

type Actor = SchoolContext | PlatformContext | SystemContext;

/**
 * Record an audit event. Never throws: an audit-write failure is logged loudly but must not
 * turn a completed business operation into an error response.
 */
export async function audit(actor: Actor, entry: AuditEntry): Promise<void> {
  try {
    await auditOrThrow(actor, entry);
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}

/**
 * Record an audit event, and fail if it cannot be written. For operations that must not be
 * reported as done without their record (e.g. undoing an import): the caller decides what a
 * failure means.
 */
export async function auditOrThrow(actor: Actor, entry: AuditEntry): Promise<void> {
  const base =
    actor.kind === 'school'
      ? {
          schoolId: actor.schoolId,
          actorType: entry.viaAi ? ('ai' as const) : ('user' as const),
          actorId: actor.userId,
          actorName: actor.name,
          actorRole: actor.role,
          ip: actor.ip,
          requestId: actor.requestId,
        }
      : actor.kind === 'platform'
        ? {
            schoolId: undefined,
            actorType: 'platform_admin' as const,
            actorId: actor.adminId,
            actorName: actor.name,
            actorRole: actor.role,
            ip: actor.ip,
            requestId: actor.requestId,
          }
        : { schoolId: actor.schoolId, actorType: 'system' as const, actorName: actor.label };
  await AuditLog.create({
    ...base,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId?.toString(),
    summary: entry.summary,
    metadata: entry.metadata,
    outcome: entry.outcome ?? 'success',
  });
}

/** Platform admin acting on a specific school: event is visible to both sides. */
export async function auditPlatformOnSchool(
  actor: PlatformContext,
  schoolId: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await AuditLog.create({
      schoolId,
      actorType: 'platform_admin',
      actorId: actor.adminId,
      actorName: actor.name,
      actorRole: actor.role,
      ip: actor.ip,
      requestId: actor.requestId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId?.toString(),
      summary: entry.summary,
      metadata: entry.metadata,
      outcome: entry.outcome ?? 'success',
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
