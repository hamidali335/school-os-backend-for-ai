/**
 * Built-in school roles. `school_owner` is presented as "Admin" in every user interface (the
 * key is kept for data compatibility). `staff` is an administrative account whose permissions
 * come entirely from a school-defined custom role (Receptionist, Office Administrator...).
 */
export const SCHOOL_ROLES = [
  'school_owner',
  'principal',
  'school_admin',
  'accountant',
  'teacher',
  'staff',
  'parent',
] as const;
export type SchoolRole = (typeof SCHOOL_ROLES)[number];

/**
 * Roles that can no longer be assigned or sign in, kept only so existing user documents still
 * validate and stay readable for audit history. Separate student logins were retired: parents
 * use the parent portal for everything about their children (see
 * scripts/migrate-retire-student-logins.ts).
 */
export const RETIRED_SCHOOL_ROLES = ['student'] as const;
/** Every role value a stored user document may hold. */
export const STORED_SCHOOL_ROLES = [...SCHOOL_ROLES, ...RETIRED_SCHOOL_ROLES] as const;
export const isRetiredRole = (role: string) => (RETIRED_SCHOOL_ROLES as readonly string[]).includes(role);

export const PLATFORM_ROLES = ['platform_owner', 'platform_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PERMISSIONS = [
  'dashboard:read',
  'school:read',
  'school:settings',
  'onboarding:manage',
  'campuses:read',
  'campuses:manage',
  'users:read',
  'users:manage',
  'roles:manage',
  'students:read',
  'students:manage',
  'students:export',
  'parents:read',
  'parents:manage',
  'admissions:read',
  'admissions:manage',
  'academics:read',
  'academics:manage',
  'timetable:read',
  'timetable:manage',
  'attendance:read',
  'attendance:mark',
  'attendance:manage',
  'leave:request',
  'leave:read',
  'leave:decide',
  'homework:read',
  'homework:manage',
  'homework:submit',
  'exams:read',
  'exams:manage',
  'marks:enter',
  'results:publish',
  'fees:read',
  'fees:manage',
  'fees:collect',
  'fees:discount',
  'fees:export',
  'accounts:read',
  'accounts:manage',
  'employees:read',
  'employees:manage',
  'payroll:manage',
  'substitutes:manage',
  'communications:read',
  'communications:send',
  'calls:use',
  'ai_calls:manage',
  'certificates:read',
  'certificates:issue',
  'files:read',
  'files:upload',
  'reports:read',
  'reports:export',
  'ai:use',
  'automations:read',
  'automations:manage',
  'approvals:read',
  'approvals:decide',
  'audit:read',
  'subscription:read',
  'sync:pull',
  'sync:push:attendance',
  'sync:push:payments',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];
const without = (...excluded: Permission[]) => ALL.filter((p) => !excluded.includes(p));

/**
 * Permissions that can never be placed in a custom role: managing roles is how privileges are
 * granted, so only the school Admin holds it. This blocks delegated users from escalating.
 */
// Calls follow the messaging relationships (parents, teachers, leadership), so a custom role
// cannot be given them.
export const NON_DELEGABLE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'roles:manage',
  'calls:use',
  // AI voice conversations: school leadership only.
  'ai_calls:manage',
]);

/** Permissions a school Admin may put into a custom role. */
export const DELEGABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => !NON_DELEGABLE_PERMISSIONS.has(p),
);

export const ROLE_PERMISSIONS: Record<SchoolRole, ReadonlySet<Permission>> = {
  school_owner: new Set(ALL),
  principal: new Set(without('subscription:read', 'roles:manage')),
  school_admin: new Set(
    without(
      'approvals:decide',
      'accounts:manage',
      'payroll:manage',
      'results:publish',
      'audit:read',
      'school:settings',
      'onboarding:manage',
      'roles:manage',
      'fees:export',
    ),
  ),
  accountant: new Set<Permission>([
    'dashboard:read',
    'school:read',
    'campuses:read',
    'students:read',
    'parents:read',
    'academics:read',
    'fees:read',
    'fees:manage',
    'fees:collect',
    'fees:discount',
    'fees:export',
    'accounts:read',
    'accounts:manage',
    'employees:read',
    'payroll:manage',
    'communications:read',
    'reports:read',
    'reports:export',
    'files:read',
    'files:upload',
    'ai:use',
    'approvals:read',
    'sync:pull',
    'sync:push:payments',
  ]),
  teacher: new Set<Permission>([
    'dashboard:read',
    'school:read',
    'campuses:read',
    'students:read',
    'academics:read',
    'timetable:read',
    'attendance:read',
    'attendance:mark',
    // Class teachers see and review (never decide) leave for their sections.
    'leave:read',
    'homework:read',
    'homework:manage',
    'exams:read',
    'marks:enter',
    'communications:read',
    // App voice calls with the parents of students they teach.
    'calls:use',
    'files:read',
    'files:upload',
    'ai:use',
    'sync:pull',
    'sync:push:attendance',
  ]),
  // Least privilege: a custom-role account gets nothing beyond this until the Admin grants it.
  staff: new Set<Permission>(['dashboard:read', 'school:read', 'campuses:read']),
  parent: new Set<Permission>([
    'dashboard:read',
    'school:read',
    'students:read',
    'timetable:read',
    'attendance:read',
    // Leave for their own children: request, follow up, withdraw while pending.
    'leave:request',
    'leave:read',
    'homework:read',
    'exams:read',
    'fees:read',
    'communications:read',
    // App voice calls with their children's teachers and the school office.
    'calls:use',
    'certificates:read',
    'files:read',
    // Parents hand in homework for their children (upload is limited to submission files).
    'homework:submit',
    'files:upload',
  ]),
};

/** Roles whose data visibility is limited to their own linked student records. */
export const SELF_SCOPED_ROLES: ReadonlySet<SchoolRole> = new Set(['parent']);

/** Staff roles (everyone who works at the school). */
export const STAFF_ROLES: ReadonlySet<SchoolRole> = new Set([
  'school_owner',
  'principal',
  'school_admin',
  'accountant',
  'teacher',
  'staff',
]);

/** Leadership plus configurable office staff (permission checks still apply on every route). */
export const ADMIN_ROLES: SchoolRole[] = ['school_owner', 'principal', 'school_admin', 'staff'];

/** Which roles a given role may create or modify. Prevents privilege escalation. */
export const ROLE_GRANTS: Record<SchoolRole, readonly SchoolRole[]> = {
  school_owner: ['school_owner', 'principal', 'school_admin', 'accountant', 'teacher', 'staff', 'parent'],
  principal: ['school_admin', 'accountant', 'teacher', 'parent'],
  school_admin: ['teacher', 'parent'],
  accountant: [],
  teacher: [],
  staff: ['teacher', 'parent'],
  parent: [],
};

export function hasPermission(role: SchoolRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Effective permissions of an account. A `staff` account gets its custom role's permissions on
 * top of the minimal base set; non-delegable permissions are always stripped from custom roles.
 */
export function effectivePermissions(role: SchoolRole, customPermissions?: readonly string[] | null): Set<Permission> {
  const out = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  if (role === 'staff' && customPermissions) {
    for (const p of customPermissions) {
      if ((PERMISSIONS as readonly string[]).includes(p) && !NON_DELEGABLE_PERMISSIONS.has(p as Permission)) {
        out.add(p as Permission);
      }
    }
  }
  return out;
}

export const ROLE_LABELS: Record<SchoolRole, string> = {
  school_owner: 'Admin',
  principal: 'Principal',
  school_admin: 'Office Administrator',
  accountant: 'Accountant',
  teacher: 'Teacher',
  staff: 'Staff (custom role)',
  parent: 'Parent',
};

export type PermissionAction = 'view' | 'create_edit' | 'approve' | 'export' | 'settings' | 'other';

/** Groups permissions into modules and actions for the permission-management screen. */
export const PERMISSION_CATALOGUE: Array<{
  module: string;
  label: string;
  permissions: Array<{ key: Permission; action: PermissionAction; label: string }>;
}> = [
  {
    module: 'dashboard',
    label: 'Dashboard',
    permissions: [{ key: 'dashboard:read', action: 'view', label: 'View dashboard' }],
  },
  {
    module: 'school',
    label: 'School profile & settings',
    permissions: [
      { key: 'school:read', action: 'view', label: 'View school profile' },
      { key: 'school:settings', action: 'settings', label: 'Change school profile and settings' },
      { key: 'onboarding:manage', action: 'settings', label: 'Use the setup guide' },
      { key: 'campuses:read', action: 'view', label: 'View campuses' },
      { key: 'campuses:manage', action: 'create_edit', label: 'Manage campuses' },
    ],
  },
  {
    module: 'users',
    label: 'Login accounts',
    permissions: [
      { key: 'users:read', action: 'view', label: 'View login accounts' },
      { key: 'users:manage', action: 'create_edit', label: 'Create, suspend and reset accounts' },
      { key: 'roles:manage', action: 'settings', label: 'Manage roles and permissions (Admin only)' },
    ],
  },
  {
    module: 'students',
    label: 'Students & parents',
    permissions: [
      { key: 'students:read', action: 'view', label: 'View students' },
      { key: 'students:manage', action: 'create_edit', label: 'Admit and edit students' },
      { key: 'students:export', action: 'export', label: 'Export student data' },
      { key: 'parents:read', action: 'view', label: 'View parents' },
      { key: 'parents:manage', action: 'create_edit', label: 'Manage parents' },
    ],
  },
  {
    module: 'admissions',
    label: 'Admissions',
    permissions: [
      { key: 'admissions:read', action: 'view', label: 'View inquiries' },
      { key: 'admissions:manage', action: 'create_edit', label: 'Manage inquiries' },
    ],
  },
  {
    module: 'staff',
    label: 'Staff & payroll',
    permissions: [
      { key: 'employees:read', action: 'view', label: 'View staff' },
      { key: 'employees:manage', action: 'create_edit', label: 'Add and edit staff' },
      { key: 'substitutes:manage', action: 'create_edit', label: 'Assign substitute teachers' },
      { key: 'payroll:manage', action: 'other', label: 'Manage payroll' },
    ],
  },
  {
    module: 'academics',
    label: 'Classes, subjects & timetable',
    permissions: [
      { key: 'academics:read', action: 'view', label: 'View classes and subjects' },
      { key: 'academics:manage', action: 'create_edit', label: 'Manage classes, subjects and teacher assignments' },
      { key: 'timetable:read', action: 'view', label: 'View timetable' },
      { key: 'timetable:manage', action: 'create_edit', label: 'Edit timetable' },
    ],
  },
  {
    module: 'attendance',
    label: 'Attendance',
    permissions: [
      { key: 'attendance:read', action: 'view', label: 'View attendance' },
      { key: 'attendance:mark', action: 'create_edit', label: 'Mark attendance' },
      { key: 'attendance:manage', action: 'settings', label: 'Correct attendance older than 7 days' },
    ],
  },
  {
    module: 'homework',
    label: 'Homework',
    permissions: [
      { key: 'homework:read', action: 'view', label: 'View homework' },
      { key: 'homework:manage', action: 'create_edit', label: 'Set and grade homework' },
    ],
  },
  {
    module: 'exams',
    label: 'Examinations',
    permissions: [
      { key: 'exams:read', action: 'view', label: 'View exams and results' },
      { key: 'exams:manage', action: 'create_edit', label: 'Create exams and date sheets' },
      { key: 'marks:enter', action: 'create_edit', label: 'Enter marks' },
      { key: 'results:publish', action: 'approve', label: 'Publish and withdraw results' },
    ],
  },
  {
    module: 'fees',
    label: 'Fees & payments',
    permissions: [
      { key: 'fees:read', action: 'view', label: 'View fees' },
      { key: 'fees:manage', action: 'create_edit', label: 'Manage fee structures and invoices' },
      { key: 'fees:collect', action: 'create_edit', label: 'Collect payments' },
      { key: 'fees:discount', action: 'approve', label: 'Give discounts and waivers' },
      { key: 'fees:export', action: 'export', label: 'Export fee data' },
    ],
  },
  {
    module: 'accounts',
    label: 'Accounts & expenses',
    permissions: [
      { key: 'accounts:read', action: 'view', label: 'View accounts' },
      { key: 'accounts:manage', action: 'create_edit', label: 'Record expenses' },
    ],
  },
  {
    module: 'communications',
    label: 'Communications',
    permissions: [
      { key: 'communications:read', action: 'view', label: 'View messages' },
      { key: 'communications:send', action: 'create_edit', label: 'Send messages' },
    ],
  },
  {
    module: 'documents',
    label: 'Certificates & files',
    permissions: [
      { key: 'certificates:read', action: 'view', label: 'View certificates' },
      { key: 'certificates:issue', action: 'create_edit', label: 'Issue certificates' },
      { key: 'files:read', action: 'view', label: 'View files' },
      { key: 'files:upload', action: 'create_edit', label: 'Upload files' },
    ],
  },
  {
    module: 'reports',
    label: 'Reports',
    permissions: [
      { key: 'reports:read', action: 'view', label: 'View reports' },
      { key: 'reports:export', action: 'export', label: 'Export reports (CSV)' },
    ],
  },
  {
    module: 'automation',
    label: 'AI, automations & approvals',
    permissions: [
      { key: 'ai:use', action: 'other', label: 'Use the AI copilot' },
      { key: 'automations:read', action: 'view', label: 'View automations' },
      { key: 'automations:manage', action: 'create_edit', label: 'Manage automations' },
      { key: 'approvals:read', action: 'view', label: 'View approval requests' },
      { key: 'approvals:decide', action: 'approve', label: 'Approve or reject requests' },
    ],
  },
  {
    module: 'admin',
    label: 'Administration',
    permissions: [
      { key: 'audit:read', action: 'view', label: 'View audit log' },
      { key: 'subscription:read', action: 'view', label: 'View subscription' },
    ],
  },
];
