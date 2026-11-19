import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { Types } from 'mongoose';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };

/** 24-char hex MongoDB ObjectId. */
export const objectId = () =>
  z
    .string()
    .regex(/^[a-f\d]{24}$/i, 'Must be a valid id')
    .openapi({ example: '6650f1c2a1b2c3d4e5f60718', format: 'objectid' });

/** A real calendar day (2026-02-31 is refused here, not later as a server error). */
const isCalendarDate = (v: string) => {
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export const isoDate = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Must be a date in YYYY-MM-DD format', abort: true })
    .refine(isCalendarDate, 'Must be a real calendar date')
    .openapi({ example: '2026-10-13', format: 'date' });

export const isoDateTime = () => z.string().datetime({ offset: true }).openapi({ example: '2026-10-13T08:00:00.000Z' });

export const timeHHmm = () =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time in HH:mm (24h) format')
    .openapi({ example: '08:30' });

export const billingPeriod = () =>
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month in YYYY-MM format')
    .openapi({ example: '2026-10' });

/** Whole Pakistani rupees. Money is stored as integers to avoid floating-point errors. */
export const amountPkr = () => z.number().int('Amounts are whole rupees').min(0).openapi({ example: 4500 });

export const phonePk = () =>
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\- ]{7,16}$/, 'Must be a valid phone number')
    .openapi({ example: '+923001234567' });

export const email = () => z.string().trim().toLowerCase().email().max(254);

export const password = () =>
  z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(128)
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[0-9]/, 'Password must contain a digit');

export const idParams = z.object({ id: objectId() });

export const toObjectId = (id: string | Types.ObjectId) => (typeof id === 'string' ? new Types.ObjectId(id) : id);

/** Query-string boolean ("true"/"false"). */
export const queryBool = () =>
  z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional();

/** Generic mongo document envelope fields appearing on every resource. */
export const docBase = {
  _id: objectId(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
};

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_ERROR' }),
      message: z.string(),
      details: z.any().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('ErrorResponse');

export const PaginationMeta = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi('PaginationMeta');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
