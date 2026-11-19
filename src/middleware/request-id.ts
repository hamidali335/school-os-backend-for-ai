import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Correlation id. Accepts a well-formed `X-Request-Id` from the caller (so a frontend can
 * correlate its logs), otherwise generates one. Always echoed back in the response.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
