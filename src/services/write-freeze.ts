import type { NextFunction, Request, Response } from 'express';
import { logger } from '../config/logger';

/**
 * Coordination between backups and the rest of the API (single API instance).
 *
 * - Write freeze: when MongoDB cannot provide a snapshot read (standalone server), a backup
 *   pauses API writes so the database and the file store are captured at one point in time.
 *   New write requests get 503 + Retry-After; in-flight writes are allowed to finish first.
 * - Deferred file deletion: while any backup runs, deleted files are removed only after it ends,
 *   so a file whose metadata is in the backup cannot disappear before its bytes are copied.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
let inFlightWrites = 0;
let frozen = false;
let backupActive = false;
const deferredDeletes: Array<() => Promise<void>> = [];

export function writeFreezeGuard(req: Request, res: Response, next: NextFunction) {
  if (READ_METHODS.has(req.method)) return next();
  if (frozen) {
    res.setHeader('Retry-After', '30');
    res.status(503).json({
      error: {
        code: 'MAINTENANCE',
        message: 'A backup is being taken. Changes are paused for a moment; please try again shortly.',
        requestId: req.requestId,
      },
    });
    return;
  }
  inFlightWrites++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlightWrites--;
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

export function writesFrozen() {
  return frozen;
}

/** Stops new API writes and waits (bounded) for in-flight ones to finish. */
export async function freezeWrites(timeoutMs = 30_000): Promise<void> {
  frozen = true;
  const started = Date.now();
  while (inFlightWrites > 0) {
    if (Date.now() - started > timeoutMs) {
      frozen = false;
      throw new Error(`Could not pause writes: ${inFlightWrites} request(s) still running after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function unfreezeWrites() {
  frozen = false;
}

export function setBackupActive(active: boolean) {
  backupActive = active;
  if (!active) void flushDeferredDeletes();
}

export function isBackupActive() {
  return backupActive;
}

/** Runs `del` now, or after the running backup finishes. */
export async function deleteWhenSafe(del: () => Promise<void>): Promise<void> {
  if (!backupActive) return del();
  deferredDeletes.push(del);
}

async function flushDeferredDeletes() {
  while (deferredDeletes.length && !backupActive) {
    const del = deferredDeletes.shift()!;
    await del().catch((err) => logger.warn({ err }, 'Deferred file deletion failed'));
  }
}
