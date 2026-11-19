import type { Permission, PlatformRole, SchoolRole } from '../config/permissions';

export interface SchoolContext {
  kind: 'school';
  userId: string;
  schoolId: string;
  role: SchoolRole;
  name: string;
  email: string;
  /** Empty array means access to every campus of the school. */
  campusIds: string[];
  permissions: ReadonlySet<Permission>;
  /** Features the school's subscription currently includes (see src/config/entitlements.ts). */
  entitlements: ReadonlySet<string>;
  subscriptionEligible: boolean;
  employeeId?: string;
  parentId?: string;
  ip?: string;
  requestId?: string;
}

export interface PlatformContext {
  kind: 'platform';
  adminId: string;
  role: PlatformRole;
  name: string;
  email: string;
  ip?: string;
  requestId?: string;
}

/** Context for scheduler/automation work executed without a user. */
export interface SystemContext {
  kind: 'system';
  schoolId: string;
  label: string;
}

export type RequestContext = SchoolContext | PlatformContext;

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    ctx?: RequestContext;
  }
}
