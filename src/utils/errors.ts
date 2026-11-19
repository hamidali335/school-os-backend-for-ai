export type ErrorDetails = Record<string, unknown> | Array<Record<string, unknown>> | undefined;

/**
 * Operational error with a stable machine-readable code. Everything thrown on purpose by
 * application code should be an AppError so the client receives a predictable shape.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: ErrorDetails, code = 'BAD_REQUEST') =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (message: string, details?: ErrorDetails, code = 'CONFLICT') =>
  new AppError(409, code, message, details);
export const unprocessable = (message: string, details?: ErrorDetails, code = 'UNPROCESSABLE') =>
  new AppError(422, code, message, details);
/**
 * The operation needs something to be set up first (a current session, a fee structure...).
 * `details.setup` names it, so screens can link to the page where it is done.
 */
export const setupRequired = (message: string, setup: string, details: Record<string, unknown> = {}) =>
  new AppError(422, 'SETUP_REQUIRED', message, { setup, ...details });
export const tooMany = (message: string, code = 'RATE_LIMITED') => new AppError(429, code, message);
export const unavailable = (message: string, code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, message);

/** Stable error codes the frontends can branch on. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_DISABLED',
  'FORBIDDEN',
  'SCHOOL_SUSPENDED',
  'SUBSCRIPTION_INACTIVE',
  'PLAN_LIMIT_REACHED',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE',
  'TIMETABLE_CONFLICT',
  'UNPROCESSABLE',
  'SETUP_REQUIRED',
  'APPROVAL_REQUIRED',
  'RATE_LIMITED',
  'AI_UNAVAILABLE',
  'AI_LIMIT_REACHED',
  'AI_PROVIDER_ERROR',
  'CHANNEL_PAUSED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
