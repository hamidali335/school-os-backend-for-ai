import { SCHOOL_ROLES } from '../../config/permissions';
import { objectId, z } from '../../utils/zod';
import { USER_STATUSES } from './user.model';

/** Result of automatic account provisioning (teacher, staff or parent login). */
export const ProvisionedAccountRes = z
  .object({
    role: z.enum(SCHOOL_ROLES),
    userId: objectId(),
    name: z.string(),
    loginId: z.string().openapi({ description: 'Email or username used to sign in' }),
    status: z.enum(USER_STATUSES),
    created: z.boolean().openapi({ description: 'False when an existing login was reused (no duplicate created)' }),
    activation: z
      .object({ token: z.string(), expiresAt: z.string() })
      .optional()
      .openapi({ description: 'Single-use activation token, returned only when the login was just created' }),
  })
  .openapi('ProvisionedAccount');

export const AccountSummaryRes = z
  .object({
    userId: objectId(),
    loginId: z.string(),
    email: z.string().optional(),
    username: z.string().optional(),
    role: z.enum(SCHOOL_ROLES),
    status: z.enum(USER_STATUSES),
    lastLoginAt: z.string().nullable(),
  })
  .openapi('AccountSummary');
