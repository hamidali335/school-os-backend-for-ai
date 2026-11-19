import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { MulterError } from 'multer';
import { isProd } from '../config/env';
import { logger } from '../config/logger';
import { TenantScopeError } from '../database/tenant-plugin';
import { ErrorEvent } from '../modules/health/error-event.model';
import { AppError } from '../utils/errors';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: req.requestId },
  });
}

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : `Upload error: ${err.message}`;
    return new AppError(400, 'VALIDATION_ERROR', message);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(
      400,
      'VALIDATION_ERROR',
      'Invalid data',
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return new AppError(400, 'VALIDATION_ERROR', `Invalid value for ${err.path}`);
  }
  const anyErr = err as { code?: number; keyValue?: Record<string, unknown>; type?: string; status?: number };
  if (anyErr?.code === 11000) {
    // Report which field collided, never the value (may be personal data).
    return new AppError(409, 'DUPLICATE', 'A record with the same unique value already exists', {
      fields: Object.keys(anyErr.keyValue ?? {}).filter((k) => k !== 'schoolId'),
    });
  }
  if (anyErr?.type === 'entity.parse.failed') return new AppError(400, 'BAD_REQUEST', 'Malformed JSON body');
  if (anyErr?.type === 'entity.too.large') return new AppError(413, 'BAD_REQUEST', 'Request body too large');
  if (isDatabaseUnavailable(err)) {
    // Outage, failover or pool exhaustion: a temporary condition the client may retry. Never
    // echo the driver message (it can contain host names).
    return new AppError(
      503,
      'SERVICE_UNAVAILABLE',
      'The service is temporarily unavailable. Please try again shortly.',
    );
  }
  if (err instanceof TenantScopeError) {
    // A programming error — treat as 500 but log distinctly.
    logger.fatal({ err }, 'Tenant scope violation blocked');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

const DB_UNAVAILABLE = new Set([
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoPoolClearedError',
  'MongoWaitQueueTimeoutError',
  'MongooseServerSelectionError',
]);

/** Errors meaning MongoDB could not be reached, as opposed to a bad query or a bug. */
export function isDatabaseUnavailable(err: unknown): boolean {
  const e = err as { name?: string; message?: string; errorLabels?: string[] | Set<string> } | null;
  if (!e) return false;
  if (e.name && DB_UNAVAILABLE.has(e.name)) return true;
  // Mongoose buffers operations while disconnected and gives up after bufferTimeoutMS.
  if (e.name === 'MongooseError' && /buffering timed out|Client must be connected/i.test(e.message ?? '')) return true;
  const labels = e.errorLabels instanceof Set ? [...e.errorLabels] : (e.errorLabels ?? []);
  return labels.includes('ResetPool');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const appErr = normalize(err);
  // Deliberate operational errors (e.g. AI_UNAVAILABLE 503) are expected outcomes, tracked
  // by their own subsystems; only unexpected failures are logged as errors and recorded.
  const unexpected = !(err instanceof AppError) && appErr.status >= 500 && appErr.code !== 'SERVICE_UNAVAILABLE';
  if (unexpected) {
    logger.error({ err, requestId: req.requestId, path: req.path }, 'Request failed');
    const schoolId = req.ctx?.kind === 'school' ? req.ctx.schoolId : undefined;
    ErrorEvent.create({
      requestId: req.requestId,
      method: req.method,
      route: req.route?.path ?? req.path,
      status: appErr.status,
      code: appErr.code,
      message: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      schoolId,
      source: 'api',
    }).catch(() => undefined);
  } else if (appErr.status >= 500) {
    logger.warn(
      {
        code: appErr.code,
        status: appErr.status,
        requestId: req.requestId,
        cause: err instanceof Error ? err.name : undefined,
      },
      'Request unavailable',
    );
    if (appErr.code === 'SERVICE_UNAVAILABLE') res.setHeader('Retry-After', '5');
  } else {
    logger.debug({ code: appErr.code, status: appErr.status, requestId: req.requestId }, 'Request rejected');
  }
  if (res.headersSent) return;
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      ...(!isProd && unexpected && err instanceof Error ? { debug: err.message } : {}),
      requestId: req.requestId,
    },
  });
}
