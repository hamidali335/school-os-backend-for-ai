import type { Permission } from './permissions';

/**
 * Feature registry: the single source of truth for which plan-controlled capabilities this
 * software actually has. Plans (stored in the database and edited in the Platform Owner panel)
 * may only include keys listed here, so a plan can never grant a capability that does not exist.
 *
 * Three separate concepts:
 * 1. Registry (this file): what the software supports, and whether it is released.
 * 2. Plan configuration (database): which features and prices each plan includes.
 * 3. School entitlement (computed per request): plan features + school overrides + subscription status.
 * A user additionally needs the role permission for the operation: entitlements never grant
 * permissions, and permissions never bypass entitlements.
 *
 * Adding a new capability (new code) means adding its key here. Ordinary commercial changes
 * (prices, which features a plan includes, new plans) need no code change.
 */
export const FEATURE_CATEGORIES = {
  core: 'Core school management',
  academics: 'Academics',
  finance: 'Fees and finance',
  people: 'Staff',
  engagement: 'Communication and automation',
  portals: 'Web portals',
  mobile: 'Mobile apps',
  calls: 'Calls',
  ai: 'AI',
} as const;
export type FeatureCategory = keyof typeof FEATURE_CATEGORIES;

export interface FeatureDefinition {
  key: string;
  name: string;
  description: string;
  category: FeatureCategory;
  /** `coming_soon`: may be sold in a plan, but the capability is not released yet. */
  availability: 'available' | 'coming_soon';
  /** Always part of every plan and cannot be revoked (logins, school setup, the web portals). */
  required?: boolean;
  /** Features that must also be included whenever this one is. */
  dependsOn?: string[];
  /** Route permissions that belong to this feature: a route needing one also needs the feature. */
  permissions?: Permission[];
}

export const FEATURES = [
  {
    key: 'core.school_admin',
    name: 'School administration',
    description: 'School profile and settings, campuses, user accounts, roles, approvals, audit log and dashboard.',
    category: 'core',
    availability: 'available',
    required: true,
    permissions: [
      'dashboard:read',
      'school:read',
      'school:settings',
      'onboarding:manage',
      'campuses:read',
      'campuses:manage',
      'users:read',
      'users:manage',
      'roles:manage',
      'approvals:read',
      'approvals:decide',
      'audit:read',
      'subscription:read',
    ],
  },
  {
    key: 'core.students',
    name: 'Students and parents',
    description: 'Student records, guardians, documents, archive and promotion.',
    category: 'core',
    availability: 'available',
    required: true,
    permissions: ['students:read', 'students:manage', 'students:export', 'parents:read', 'parents:manage'],
  },
  {
    key: 'core.academics',
    name: 'Classes and subjects',
    description: 'Academic sessions, classes, sections, subjects and teaching assignments.',
    category: 'academics',
    availability: 'available',
    required: true,
    permissions: ['academics:read', 'academics:manage'],
  },
  {
    key: 'core.staff',
    name: 'Staff records',
    description: 'Teachers and staff records (needed for teacher logins).',
    category: 'people',
    availability: 'available',
    required: true,
    permissions: ['employees:read', 'employees:manage'],
  },
  {
    key: 'core.admissions',
    name: 'Admissions',
    description: 'Admission inquiries, follow-ups and conversion to students.',
    category: 'core',
    availability: 'available',
    permissions: ['admissions:read', 'admissions:manage'],
  },
  {
    key: 'core.timetable',
    name: 'Timetable and substitutes',
    description: 'Weekly timetable and substitute-teacher cover.',
    category: 'academics',
    availability: 'available',
    dependsOn: ['core.academics'],
    permissions: ['timetable:read', 'timetable:manage', 'substitutes:manage'],
  },
  {
    key: 'core.attendance',
    name: 'Attendance',
    description: 'Daily student attendance, registers and attendance reports.',
    category: 'academics',
    availability: 'available',
    dependsOn: ['core.academics'],
    permissions: [
      'attendance:read',
      'attendance:mark',
      'attendance:manage',
      'leave:request',
      'leave:read',
      'leave:decide',
    ],
  },
  {
    key: 'core.homework',
    name: 'Homework',
    description: 'Homework, parent submissions and grading.',
    category: 'academics',
    availability: 'available',
    dependsOn: ['core.academics'],
    permissions: ['homework:read', 'homework:manage', 'homework:submit'],
  },
  {
    key: 'core.examinations',
    name: 'Examinations and results',
    description: 'Exams, date sheets, marks entry, results and report cards.',
    category: 'academics',
    availability: 'available',
    dependsOn: ['core.academics'],
    permissions: ['exams:read', 'exams:manage', 'marks:enter', 'results:publish'],
  },
  {
    key: 'core.certificates',
    name: 'Certificates',
    description: 'Character, leaving and other certificates as PDFs with public verification.',
    category: 'academics',
    availability: 'available',
    permissions: ['certificates:read', 'certificates:issue'],
  },
  {
    key: 'core.fees',
    name: 'Fees',
    description: 'Fee structures, invoices, payments, concessions and fee ledgers.',
    category: 'finance',
    availability: 'available',
    permissions: ['fees:read', 'fees:manage', 'fees:collect', 'fees:discount', 'fees:export'],
  },
  {
    key: 'core.accounts',
    name: 'Income and expenses',
    description: 'Other income, expenses and the financial summary.',
    category: 'finance',
    availability: 'available',
    permissions: ['accounts:read', 'accounts:manage'],
  },
  {
    key: 'core.payroll',
    name: 'Payroll',
    description: 'Monthly salary slips and payments for staff.',
    category: 'people',
    availability: 'available',
    dependsOn: ['core.staff'],
    permissions: ['payroll:manage'],
  },
  {
    key: 'core.reports',
    name: 'Reports',
    description: 'Enrolment, attendance, fee-collection and other reports with CSV export.',
    category: 'core',
    availability: 'available',
    permissions: ['reports:read', 'reports:export'],
  },
  {
    key: 'core.communications',
    name: 'Announcements and notifications',
    description: 'In-app announcements and notifications (SMS/WhatsApp/email follow their own channel switches).',
    category: 'engagement',
    availability: 'available',
    permissions: ['communications:read', 'communications:send'],
  },
  {
    key: 'core.automations',
    name: 'Automations',
    description: 'Scheduled fee reminders, absence alerts and the daily brief.',
    category: 'engagement',
    availability: 'available',
    permissions: ['automations:read', 'automations:manage'],
  },
  {
    key: 'portal.parents',
    name: 'Parent web portal',
    description: 'Parents sign in on the web to see their children’s attendance, homework, results and fees.',
    category: 'portals',
    availability: 'available',
    required: true,
  },
  {
    key: 'portal.teachers',
    name: 'Teacher web portal',
    description: 'Teachers sign in on the web for their classes, attendance, homework and marks.',
    category: 'portals',
    availability: 'available',
    required: true,
  },
  {
    key: 'mobile.parent_app',
    name: 'Parent mobile app',
    description: 'Dedicated parent app for Android and iOS. Not released yet.',
    category: 'mobile',
    availability: 'coming_soon',
    dependsOn: ['portal.parents'],
  },
  {
    key: 'mobile.teacher_app',
    name: 'Teacher mobile app',
    description: 'Dedicated teacher app for Android and iOS. Not released yet.',
    category: 'mobile',
    availability: 'coming_soon',
    dependsOn: ['portal.teachers'],
  },
  {
    key: 'calls.voice',
    name: 'App voice calls',
    description:
      'Internet voice calls between the school office, teachers and parents in the website and apps (self-hosted, no phone network).',
    category: 'calls',
    availability: 'available',
    dependsOn: ['core.communications'],
    permissions: ['calls:use'],
  },
  {
    key: 'calls.ai_voice',
    name: 'AI voice conversations',
    description:
      'An AI assistant calls a parent in the app, asks the questions the school set and records the answers (with consent).',
    category: 'calls',
    availability: 'available',
    dependsOn: ['calls.voice'],
    permissions: ['ai_calls:manage'],
  },
  {
    key: 'ai.copilot',
    name: 'AI Copilot',
    description: 'Chat assistant that answers questions from the school’s own data.',
    category: 'ai',
    availability: 'available',
  },
  {
    key: 'ai.insights',
    name: 'AI insights',
    description: 'AI-written insights, daily brief and report narratives.',
    category: 'ai',
    availability: 'available',
    dependsOn: ['core.reports'],
  },
  {
    key: 'ai.assistant',
    name: 'AI writing assistant',
    description: 'Explain and summarise records, admission recommendations and AI-drafted announcements.',
    category: 'ai',
    availability: 'available',
  },
] as const satisfies readonly FeatureDefinition[];

export type FeatureKey = (typeof FEATURES)[number]['key'];
export const FEATURE_KEYS = FEATURES.map((f) => f.key) as readonly FeatureKey[];
const BY_KEY = new Map<string, FeatureDefinition>(FEATURES.map((f) => [f.key, f]));

export const isFeatureKey = (k: string): k is FeatureKey => BY_KEY.has(k);
export const featureDef = (k: string): FeatureDefinition | undefined => BY_KEY.get(k);
export const REQUIRED_FEATURES = FEATURES.filter((f) => 'required' in f && f.required).map(
  (f) => f.key,
) as FeatureKey[];

/** Which feature a route permission belongs to (permissions not listed are not plan-controlled, e.g. files). */
export const PERMISSION_FEATURE = new Map<Permission, FeatureKey>(
  FEATURES.flatMap((f) => ('permissions' in f ? f.permissions.map((p) => [p, f.key] as const) : [])),
);

/** AI usage kinds (see ai-usage.model) and the entitlement each needs. */
export const AI_FEATURE_ENTITLEMENT: Record<string, FeatureKey> = {
  copilot: 'ai.copilot',
  insights: 'ai.insights',
  daily_brief: 'ai.insights',
  report_narrative: 'ai.insights',
  automation: 'ai.insights',
  explain: 'ai.assistant',
  summarize: 'ai.assistant',
  admissions_recommendation: 'ai.assistant',
  draft_communication: 'ai.assistant',
  voice_conversation: 'calls.ai_voice',
};

/**
 * Every non-mobile, non-calls, non-AI feature: the core product every plan is built on. Calls
 * are left out so that adding them to the registry gives no existing plan or school a new feature.
 */
export const CORE_FEATURES = FEATURES.filter(
  (f) => f.category !== 'mobile' && f.category !== 'calls' && f.category !== 'ai',
).map((f) => f.key) as FeatureKey[];
export const MOBILE_FEATURES: FeatureKey[] = ['mobile.parent_app', 'mobile.teacher_app'];
export const AI_ENTITLEMENTS: FeatureKey[] = ['ai.copilot', 'ai.insights', 'ai.assistant'];

/**
 * Feature strings used by plans before this registry existed (they were never enforced). Read
 * through this map so existing schools keep what their plan described, without gaining extras.
 */
export const LEGACY_FEATURE_MAP: Record<string, FeatureKey[]> = {
  core: CORE_FEATURES,
  parent_portal: ['portal.parents'],
  automations: ['core.automations'],
  ai_copilot: AI_ENTITLEMENTS,
};

/** Translate stored plan features (registry keys or legacy strings) to registry keys. Unknown values are dropped. */
export function normaliseFeatures(stored: readonly string[] | null | undefined): FeatureKey[] {
  const out = new Set<FeatureKey>();
  for (const f of stored ?? []) {
    if (isFeatureKey(f)) out.add(f);
    else for (const k of LEGACY_FEATURE_MAP[f] ?? []) out.add(k);
  }
  return [...out];
}

/**
 * Validate a plan's feature selection: only known keys, every required feature present,
 * every dependency satisfied. Returns human-readable problems (empty when valid).
 */
export function validateFeatureSet(keys: readonly string[]): Array<{ feature: string; message: string }> {
  const problems: Array<{ feature: string; message: string }> = [];
  const set = new Set(keys);
  for (const k of set)
    if (!isFeatureKey(k))
      problems.push({ feature: k, message: `Unknown feature “${k}”: it does not exist in this software.` });
  for (const r of REQUIRED_FEATURES)
    if (!set.has(r))
      problems.push({ feature: r, message: `${featureDef(r)!.name} is part of every plan and cannot be removed.` });
  for (const k of set) {
    const def = featureDef(k);
    for (const d of def?.dependsOn ?? [])
      if (!set.has(d))
        problems.push({
          feature: k,
          message: `${def!.name} needs ${featureDef(d)!.name}. Include ${featureDef(d)!.name} or remove ${def!.name}.`,
        });
  }
  return problems;
}
