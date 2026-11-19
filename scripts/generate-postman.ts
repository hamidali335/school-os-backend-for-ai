/**
 * Generates a Postman collection (v2.1) and environment from the live OpenAPI document:
 *   docs/postman/School-OS-API.postman_collection.json
 *   docs/postman/School-OS-Local.postman_environment.json
 *
 * Usage: npm run postman:generate
 *
 * - One folder per API area, every endpoint included with an example body.
 * - Login requests store tokens automatically; school requests use {{accessToken}},
 *   platform requests use {{platformAccessToken}}.
 * - List and create requests store ids (e.g. {{studentId}}) for the detail requests.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/unused';
process.env.JWT_ACCESS_SECRET ??= 'docs-generation-only-secret-0123456789abcdef';
process.env.JWT_PLATFORM_SECRET ??= 'docs-generation-only-platform-0123456789abcd';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A UUID derived from a name: the same on every run, so regenerating does not change the files. */
function stableId(name: string): string {
  const h = crypto.createHash('sha1').update(name).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

type Json = Record<string, any>;

const ID_VAR_OVERRIDES: Array<[RegExp, string]> = [
  [/^\/ai\/admissions\/\{id\}/, 'inquiryId'],
  // "Lost" closes the inquiry this collection created; "convert" admits an open seeded one.
  [/^\/admissions\/inquiries\/\{id\}\/lost/, 'createdInquiryId'],
  [/^\/platform\/schools\/\{id\}/, 'platformSchoolId'],
  [/^\/platform\/admins\/\{id\}/, 'platformAdminId'],
  [/^\/platform\/plans\/\{id\}/, 'planId'],
  [/^\/fees\/heads\/\{id\}/, 'feeHeadId'],
  [/^\/fees\/structures\/\{id\}/, 'feeStructureId'],
  [/^\/academics\/teaching-assignments\/\{id\}/, 'teachingAssignmentId'],
  [/^\/academics\/sessions\/\{id\}/, 'sessionId'],
  [/^\/timetable\/\{id\}/, 'timetableEntryId'],
  [/^\/automations\/\{id\}/, 'automationRuleId'],
  [/^\/reports\/exams\/\{id\}/, 'examId'],
];

const LIST_VAR_OVERRIDES: Record<string, string> = {
  '/platform/schools': 'platformSchoolId',
  '/platform/admins': 'platformAdminId',
  '/platform/plans': 'planId',
  '/fees/heads': 'feeHeadId',
  '/fees/structures': 'feeStructureId',
  '/academics/teaching-assignments': 'teachingAssignmentId',
  '/academics/sessions': 'sessionId',
  '/academics/my-sections': 'sectionId',
  '/automations': 'automationRuleId',
  '/automations/runs': '',
  '/timetable': 'timetableEntryId',
  '/exams': 'examId',
  '/homework': 'homeworkId',
  '/accounts/income': 'incomeId',
  '/admissions/inquiries': 'inquiryId',
  '/communications/announcements': 'announcementId',
  '/communications/messages': '',
  '/audit-logs': '',
  '/notifications': 'notificationId',
};

function singular(word: string) {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('es') && word.endsWith('uses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Variable name for the `{id}` in a path, from the resource segment before it. */
function idVarFor(apiPath: string): string {
  for (const [rx, v] of ID_VAR_OVERRIDES) if (rx.test(apiPath)) return v;
  const segs = apiPath.split('/').filter(Boolean);
  const i = segs.indexOf('{id}');
  const resource = segs[i - 1] ?? 'item';
  return `${camel(singular(resource))}Id`;
}

function listVarFor(apiPath: string): string {
  if (apiPath in LIST_VAR_OVERRIDES) return LIST_VAR_OVERRIDES[apiPath];
  const last = apiPath.split('/').filter(Boolean).pop() ?? '';
  return last && !last.includes('{') ? `${camel(singular(last))}Id` : '';
}

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

function resolve(schema: Json | undefined, doc: Json): Json {
  let s = schema ?? {};
  for (let i = 0; i < 10 && s.$ref; i++) s = doc.components.schemas[s.$ref.split('/').pop()];
  if (s.allOf)
    return s.allOf.reduce((acc: Json, part: Json) => {
      const r = resolve(part, doc);
      return {
        ...acc,
        ...r,
        properties: { ...(acc.properties ?? {}), ...(r.properties ?? {}) },
        required: [...(acc.required ?? []), ...(r.required ?? [])],
      };
    }, {});
  if (s.anyOf || s.oneOf) {
    const opts = (s.anyOf ?? s.oneOf).map((o: Json) => resolve(o, doc)).filter((o: Json) => o.type !== 'null');
    return opts[0] ?? {};
  }
  return s;
}

/** Body fields whose id comes from a differently named variable. */
const ID_ALIASES: Record<string, string> = {
  teacherId: 'employeeId',
  classTeacherId: 'employeeId',
  fromSectionId: 'sectionId',
  toSectionId: 'sectionId',
  classSoughtId: 'classId',
  currentSessionId: 'sessionId',
  excludeEntryId: 'timetableEntryId',
};

function sampleString(name: string, s: Json): string {
  // Ids reference variables captured by earlier requests (e.g. {{studentId}}).
  if (name.endsWith('Id') || s.format === 'objectid') {
    return name.endsWith('Id') ? `{{${ID_ALIASES[name] ?? name}}}` : '{{id}}';
  }
  // Unique values so "create" requests do not collide with seeded records.
  if (name === 'code') return `C{{$randomInt}}`;
  if (name === 'name' || name === 'title') return `${s.example ?? `Sample ${name}`} {{$randomInt}}`.slice(0, 40);
  if (/Time$/.test(name)) return /end/i.test(name) ? '08:40' : '08:00';
  if (name === 'endDate') return new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10);
  if (name === 'from' || name.endsWith('From')) return '{{fromDate}}';
  if (name === 'to' || name.endsWith('To')) return '{{toDate}}';
  if (s.example !== undefined) return String(s.example);
  if (Array.isArray(s.examples) && s.examples.length) return String(s.examples[0]);
  if (s.format === 'date' || /YYYY-MM-DD|\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(s.pattern ?? '')) {
    if (name === 'from' || name.endsWith('From')) return '{{fromDate}}';
    if (name === 'to' || name.endsWith('To')) return '{{toDate}}';
    return '{{today}}';
  }
  if (s.format === 'date-time') return new Date().toISOString();
  if (s.format === 'email' || name.toLowerCase().includes('email')) return 'someone@example.com';
  if ((s.pattern ?? '').includes('0[1-9]|1[0-2]')) return '{{period}}';
  if ((s.pattern ?? '').includes('[01]\\d|2[0-3]')) return name.toLowerCase().includes('end') ? '08:40' : '08:00';
  if (/phone|whatsapp/i.test(name)) return '+923001234567';
  if (/password/i.test(name)) return 'Change-Me-Pass-2026';
  if (name === 'cnic') return '31202-1234567-1';
  if (name === 'code') return 'CODE1';
  const min = typeof s.minLength === 'number' ? s.minLength : 0;
  const text = `Sample ${name || 'text'}`;
  return text.length >= min ? text : text.padEnd(min, '.');
}

function example(schemaIn: Json | undefined, doc: Json, name = '', depth = 0): any {
  const s = resolve(schemaIn, doc);
  if (depth > 5) return undefined;
  if (s.example !== undefined && s.type !== 'object' && s.type !== 'string') return s.example;
  if (s.enum) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const props: Json = s.properties ?? {};
      const required: string[] = s.required ?? [];
      // All-optional objects are PATCH-style updates: change a couple of harmless fields only,
      // never ids, names or codes (so running the collection does not rename seeded records).
      const harmless = Object.keys(props).filter(
        (k) => !/(Id|Ids)$/.test(k) && !['name', 'code', 'title', 'status', 'role'].includes(k),
      );
      const keys = required.length ? required : (harmless.length ? harmless : Object.keys(props)).slice(0, 2);
      const out: Json = {};
      for (const k of keys) {
        const v = example(props[k], doc, k, depth + 1);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case 'array': {
      const item = example(s.items, doc, singular(name), depth + 1);
      const n = Math.max(1, s.minItems ?? 1);
      return item === undefined ? [] : Array.from({ length: Math.min(n, 2) }, () => item);
    }
    case 'integer':
    case 'number':
      if (name === 'capacity') return 40;
      if (name === 'maxMarks') return 100;
      if (name === 'passMarks') return 33;
      return typeof s.minimum === 'number'
        ? Math.max(s.minimum, 1)
        : typeof s.exclusiveMinimum === 'number'
          ? s.exclusiveMinimum + 1
          : 1;
    case 'boolean':
      return false;
    case 'string':
      return sampleString(name, s);
    default:
      return name.endsWith('Id') ? `{{${name}}}` : undefined;
  }
}

const TOKEN_SCRIPTS: Record<string, string[]> = {
  'post /auth/login': [
    'const j = pm.response.json();',
    "if (j.data && j.data.accessToken) { pm.collectionVariables.set('accessToken', j.data.accessToken); pm.collectionVariables.set('refreshToken', j.data.refreshToken); }",
  ],
  'post /auth/refresh': [
    'const j = pm.response.json();',
    "if (j.data && j.data.accessToken) { pm.collectionVariables.set('accessToken', j.data.accessToken); pm.collectionVariables.set('refreshToken', j.data.refreshToken); }",
  ],
  'post /auth/change-password': [
    'const j = pm.response.json();',
    "if (j.data && j.data.accessToken) { pm.collectionVariables.set('accessToken', j.data.accessToken); pm.collectionVariables.set('refreshToken', j.data.refreshToken); }",
  ],
  'post /platform/auth/login': [
    'const j = pm.response.json();',
    "if (j.data && j.data.accessToken) { pm.collectionVariables.set('platformAccessToken', j.data.accessToken); pm.collectionVariables.set('platformRefreshToken', j.data.refreshToken); }",
  ],
  'post /platform/auth/refresh': [
    'const j = pm.response.json();',
    "if (j.data && j.data.accessToken) { pm.collectionVariables.set('platformAccessToken', j.data.accessToken); pm.collectionVariables.set('platformRefreshToken', j.data.refreshToken); }",
  ],
};

const BODY_OVERRIDES: Record<string, Json> = {
  'patch /school/settings': { passPercent: 40, fees: { invoiceDueDay: 10, lateFeeAmount: 300 } },
  'post /accounts/expenses': { category: 'utilities', amount: 12000, date: '{{today}}', vendor: 'Sample vendor' },
  'post /communications/messages': { channel: 'sms', parentId: '{{parentId}}', body: 'Test message from School OS' },
  'post /ai/explain': { subject: 'student_overview', id: '{{studentId}}', language: 'en' },
  'post /automations': { type: 'late_fee', schedule: { frequency: 'daily', hour: 9 } },
  'put /platform/schools/{id}/subscription': { status: 'active' },
  'post /platform/schools/{id}/plan-change': {
    planCode: 'pro',
    billingPeriod: 'monthly',
    confirm: true,
    note: 'Upgrade from Postman',
  },
  'put /platform/schools/{id}/feature-overrides': {
    overrides: [{ feature: 'ai.copilot', mode: 'grant', reason: 'Trial of AI' }],
  },
  'put /platform/plans/{id}/draft': {
    prices: { monthly: { amount: 2500, enabled: true }, yearly: { amount: 25000, enabled: true } },
  },
  'post /platform/plans/{id}/publish': { applyTo: 'all_subscribers', confirm: true, note: 'Published from Postman' },
  'post /platform/plans/{id}/archive': { confirm: true, note: 'Archived from Postman' },
  'post /platform/schools/{id}/subscription/apply-current-price': { confirm: true },
  'post /platform/schools/{id}/suspend': { reason: 'Testing suspension from Postman' },
  'post /platform/schools/{id}/activate': { reason: 'Testing activation from Postman' },
  'post /exams/{id}/papers/{paperId}/marks': {
    sectionId: '{{sectionId}}',
    marks: [{ studentId: '{{studentId}}', obtained: 75 }],
  },
  'post /fees/invoices/{id}/payments': { amount: 1000, method: 'cash', reference: 'Postman test payment' },
  'post /fees/invoices/{id}/waiver-requests': { amount: 500, reason: 'Testing a waiver request from Postman' },
  'post /platform/auth/change-password': {
    currentPassword: '{{platformPassword}}',
    newPassword: 'New-Strong-Pass-2026',
  },
  'put /platform/ai/settings/providers/{provider}': { apiKey: '{{aiApiKey}}', model: '{{aiModel}}', activate: true },
  'put /platform/ai/settings': { activeProvider: '{{provider}}', enabled: true },
  'post /platform/ai/test': { provider: '{{provider}}', model: '{{aiModel}}' },
  'post /ai/copilot/chat': { messages: [{ role: 'user', content: 'How is attendance this week?' }] },
  'post /ai/summarize': {
    text: 'Parents asked about the winter vacation schedule and the new uniform policy for next term.',
  },
  'post /auth/login': { email: '{{schoolEmail}}', password: '{{schoolPassword}}' },
  'post /auth/refresh': { refreshToken: '{{refreshToken}}' },
  'post /auth/logout': { refreshToken: '{{refreshToken}}' },
  'post /auth/change-password': { currentPassword: '{{schoolPassword}}', newPassword: 'New-Strong-Pass-2026' },
  'post /platform/auth/login': { email: '{{platformEmail}}', password: '{{platformPassword}}' },
  'post /platform/auth/refresh': { refreshToken: '{{platformRefreshToken}}' },
  'post /platform/auth/logout': { refreshToken: '{{platformRefreshToken}}' },
};

/**
 * Shared setup entities: creating one stores it only as `created…Id` so it never replaces
 * the seeded record that other requests (students, sections, fees) are linked to.
 */
const SHARED_SETUP_VARS = new Set([
  'sessionId',
  'classId',
  'sectionId',
  'campusId',
  'subjectId',
  'feeHeadId',
  'planId',
  'platformSchoolId',
  'inquiryId',
]);
const createdVar = (v: string) => `created${v[0].toUpperCase()}${v.slice(1)}`;

/** Picks the most useful list item: matching the current class/section, or still actionable. */
const PICK_BEST = [
  'const v = (k) => pm.collectionVariables.get(k);',
  "const idOf = (x) => (x && typeof x === 'object' ? x._id : x);",
  'const score = (x) => { let s = 0;',
  "  if (['pending', 'unpaid', 'partial', 'draft'].includes(x.status)) s += 10;",
  "  if (x.stage && !['admitted', 'lost'].includes(x.stage)) s += 10;",
  '  if (x.balance > 0) s += 5;',
  "  if (x.campusId && idOf(x.campusId) === v('campusId')) s += 4;",
  "  if (x.classId && idOf(x.classId) === v('classId')) s += 4;",
  "  if (x.sectionId && idOf(x.sectionId) === v('sectionId')) s += 4;",
  '  return s; };',
  'const pickBest = (arr) => arr.slice().sort((a, b) => score(b) - score(a))[0];',
];

/** Store ids from responses so later requests can use them. */
function captureScript(method: string, apiPath: string, hasPathParams: boolean): string[] {
  const lines: string[] = [];
  if (method === 'get' && !hasPathParams) {
    const v = listVarFor(apiPath);
    if (v) {
      lines.push(
        'const j = pm.response.json();',
        ...PICK_BEST,
        'const list = Array.isArray(j.data) ? j.data : (j.data && Array.isArray(j.data.students) ? j.data.students : []);',
        'const best = list.length ? pickBest(list) : null;',
        `if (best) { const id = best._id || best.studentId; if (id) pm.collectionVariables.set('${v}', idOf(id)); }`,
      );
    }
  }
  if (method === 'get' && apiPath === '/attendance/sections/{id}') {
    lines.push(
      'const j = pm.response.json();',
      "if (j.data && j.data.students && j.data.students[0]) pm.collectionVariables.set('studentId', j.data.students[0].studentId);",
    );
  }
  if (method === 'get' && apiPath === '/exams/{id}') {
    lines.push(
      'const j = pm.response.json();',
      "if (j.data && j.data.papers && j.data.papers[0]) pm.collectionVariables.set('paperId', j.data.papers[0]._id);",
    );
  }
  if (method === 'post' || method === 'put') {
    lines.push(
      'if (pm.response.code < 300 && pm.response.headers.get("Content-Type") && pm.response.headers.get("Content-Type").includes("json")) {',
      '  const d = pm.response.json().data || {};',
      "  const keep = (k, v) => { if (v && typeof v === 'string') pm.collectionVariables.set(k, v); };",
    );
    const base = apiPath.split('/').filter((s) => s && !s.includes('{'));
    const resourceVar = !hasPathParams ? listVarFor(apiPath) : '';
    if (resourceVar && !['/auth/login', '/platform/auth/login'].includes(apiPath)) {
      lines.push(`  keep('${createdVar(resourceVar)}', d._id);`);
      if (!SHARED_SETUP_VARS.has(resourceVar)) lines.push(`  keep('${resourceVar}', d._id);`);
    }
    if (apiPath === '/exams/{id}/papers') lines.push("  if (Array.isArray(d) && d[0]) keep('paperId', d[0]._id);");
    if (apiPath === '/fees/invoices/generate') lines.push("  keep('invoiceId', (d.invoiceIds || [])[0]);");
    if (base.includes('payments')) lines.push("  keep('paymentId', d.payment && d.payment._id);");
    if (apiPath.includes('requests') || apiPath === '/accounts/expenses')
      lines.push("  keep('approvalId', d._id && d.status === 'pending' ? d._id : (d.approval && d.approval._id));");
    if (apiPath === '/accounts/expenses') {
      lines.push(
        "  keep('expenseId', d.expense && d.expense._id);",
        "  keep('createdExpenseId', d.expense && d.expense._id);",
      );
    }
    if (apiPath === '/platform/schools') lines.push("  keep('platformSchoolId', d.school && d.school._id);");
    if (apiPath === '/users') lines.push("  keep('userId', d.user && d.user._id);");
    if (apiPath.endsWith('/convert')) lines.push("  keep('studentId', d.student && d.student._id);");
    lines.push('}');
  }
  return lines;
}

/** Every DELETE runs here, at the end, and only targets records the collection created. */
const CLEANUP = 'Cleanup (deletes records created by this collection)';

async function main() {
  const { buildApis } = await import('../src/app');
  const { openapi } = buildApis();
  const doc = openapi as unknown as Json;
  const prefix = '/api/v1';

  const folders = new Map<string, Json[]>();
  // Setup data first, then modules that depend on it, then cross-cutting views.
  const order = [
    'Health',
    'Auth',
    'Platform Auth',
    'School',
    'Campuses',
    'Users',
    'Employees',
    'Parents',
    'Academics',
    'Students',
    'Admissions',
    'Timetable',
    'Attendance',
    'Homework',
    'Examinations',
    'Fees',
    'Accounts',
    'Payroll',
    'Communications',
    'Files & Documents',
    'Certificates',
    'Dashboard & Reports',
    'AI',
    'Automations',
    'Approvals',
    'Audit',
    'Subscription',
    'Platform Admin',
    'Platform AI Settings',
  ];
  const idVars = new Set<string>();

  for (const [fullPath, ops] of Object.entries(doc.paths as Json)) {
    for (const [method, op] of Object.entries(ops as Json) as Array<[string, Json]>) {
      const apiPath = fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) || '/' : fullPath;
      const key = `${method} ${apiPath}`;
      const tag: string = op.tags?.[0] ?? 'Other';
      const security: Json[] = op.security ?? [];
      const isPlatform = security.some((s) => 'platformBearer' in s);
      const isPublic = security.length === 0;

      const params: Json[] = op.parameters ?? [];
      const pathParams = params.filter((p) => p.in === 'path');
      const queryParams = params.filter((p) => p.in === 'query');
      const variables = pathParams.map((p) => {
        // DELETE only targets records the collection itself created (never seeded data).
        const base = p.name === 'id' ? idVarFor(apiPath) : p.name;
        const v =
          method === 'delete' && p.name === 'id'
            ? createdVar(base)
            : method === 'delete' && p.name === 'provider'
              ? 'providerToRemove'
              : base;
        idVars.add(v);
        return { key: p.name, value: `{{${v}}}`, description: p.description ?? '' };
      });
      const query = queryParams.map((p) => {
        const value = example(p.schema, doc, p.name);
        return {
          key: p.name,
          value: value === undefined ? '' : String(value),
          disabled:
            !p.required && !['from', 'to'].includes(p.name) && !(key === 'get /timetable' && p.name === 'sectionId'),
          description: p.description ?? (p.required ? 'required' : 'optional'),
        };
      });
      const rawPath = fullPath.replace(/\{([^}]+)\}/g, ':$1');
      const url = {
        raw: `{{baseUrl}}${rawPath}${
          query.length
            ? `?${query
                .filter((q) => !q.disabled)
                .map((q) => `${q.key}=${q.value}`)
                .join('&')}`
            : ''
        }`,
        host: ['{{baseUrl}}'],
        path: rawPath.split('/').filter(Boolean),
        ...(query.length ? { query } : {}),
        ...(variables.length ? { variable: variables } : {}),
      };

      const request: Json = {
        method: method.toUpperCase(),
        header: [],
        url,
        description: [op.summary, op.description].filter(Boolean).join('\n\n'),
      };
      if (isPublic) request.auth = { type: 'noauth' };
      else if (isPlatform)
        request.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{platformAccessToken}}', type: 'string' }] };

      const content = op.requestBody?.content ?? {};
      if (content['application/json']) {
        const body = BODY_OVERRIDES[key] ?? example(content['application/json'].schema, doc);
        request.header.push({ key: 'Content-Type', value: 'application/json' });
        request.body = {
          mode: 'raw',
          raw: JSON.stringify(body ?? {}, null, 2),
          options: { raw: { language: 'json' } },
        };
      } else if (content['multipart/form-data']) {
        const schema = resolve(content['multipart/form-data'].schema, doc);
        const formdata = Object.entries(schema.properties ?? {}).map(([k, v]) => {
          const prop = resolve(v as Json, doc);
          if (prop.format === 'binary')
            return { key: k, type: 'file', src: [], description: 'Choose a PDF/JPEG/PNG file' };
          const val = k === 'category' ? 'student_document' : example(prop, doc, k);
          return {
            key: k,
            value: val === undefined ? '' : String(val),
            type: 'text',
            disabled: !(schema.required ?? []).includes(k) && k !== 'studentId',
          };
        });
        request.body = { mode: 'formdata', formdata };
      }

      const exec = [
        "pm.test('no server error', () => pm.expect(pm.response.code).to.be.below(500));",
        ...(TOKEN_SCRIPTS[key] ?? captureScript(method, apiPath, pathParams.length > 0)),
      ];
      const dangerous =
        method === 'delete' || /\/(suspend|cancel|revoke|logout-all|reset-password|change-password)$/.test(apiPath);
      const item = {
        name: `${dangerous ? '⚠ ' : ''}${method.toUpperCase()} ${apiPath}${op.summary ? ` — ${op.summary}` : ''}`.slice(
          0,
          200,
        ),
        request,
        event: [{ listen: 'test', script: { type: 'text/javascript', exec } }],
      };
      // Requests that end the session are grouped last so a full collection run keeps working.
      const sessionEnding = /\/auth\/(logout|logout-all|change-password)$/.test(apiPath);
      const folder = sessionEnding ? 'Session end (run last)' : method === 'delete' ? CLEANUP : tag;
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder)!.push(item);
    }
  }

  const last = 'Session end (run last)';
  // Save a provider's key before switching to it.
  const aiFolder = folders.get('Platform AI Settings');
  if (aiFolder) {
    const i = aiFolder.findIndex((x) => String(x.name).startsWith('PUT /platform/ai/settings —'));
    if (i >= 0) aiFolder.push(...aiFolder.splice(i, 1));
  }
  const tags = [
    ...order.filter((t) => folders.has(t)),
    ...[...folders.keys()].filter((t) => !order.includes(t) && t !== last && t !== CLEANUP),
    ...(folders.has(CLEANUP) ? [CLEANUP] : []),
    ...(folders.has(last) ? [last] : []),
  ];
  const variablesList = [
    'accessToken',
    'refreshToken',
    'platformAccessToken',
    'platformRefreshToken',
    ...[...idVars].sort(),
    'studentId',
    'sectionId',
    'classId',
    'subjectId',
    'invoiceId',
    'paymentId',
    'approvalId',
    'expenseId',
    'parentId',
    'employeeId',
    'teacherId',
    'campusId',
  ];
  const collection = {
    info: {
      _postman_id: stableId('school-os-api-collection'),
      name: 'School OS API',
      description: [
        'Generated from the School OS OpenAPI document (`npm run postman:generate`).',
        '',
        '1. Select the **School OS — Local** environment and set `schoolPassword` (your SEED_DEMO_PASSWORD) and the platform credentials.',
        '2. Run **Auth → POST /auth/login** (stores `accessToken`) and **Platform Auth → POST /platform/auth/login** (stores `platformAccessToken`).',
        '3. Run a list request (e.g. **Students → GET /students**) before its detail requests — list and create requests save ids such as `{{studentId}}` automatically.',
        '4. Requests marked ⚠ change or delete data.',
        '',
        'Access tokens last 15 minutes: when you get `TOKEN_EXPIRED`, run the login (or refresh) request again.',
      ].join('\n'),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
    variable: [
      ...[...new Set(variablesList)].map((key) => ({ key, value: '' })),
      { key: 'today', value: today },
      { key: 'fromDate', value: monthAgo },
      { key: 'toDate', value: today },
      { key: 'period', value: today.slice(0, 7) },
    ],
    item: tags.map((t) => ({ name: t, item: folders.get(t) })),
  };

  const environment = {
    id: stableId('school-os-local-environment'),
    name: 'School OS — Local',
    values: [
      { key: 'baseUrl', value: 'http://localhost:4000', type: 'default', enabled: true },
      { key: 'schoolEmail', value: 'principal@brightfuture.example', type: 'default', enabled: true },
      { key: 'schoolPassword', value: '', type: 'secret', enabled: true },
      { key: 'platformEmail', value: '', type: 'default', enabled: true },
      { key: 'platformPassword', value: '', type: 'secret', enabled: true },
      { key: 'provider', value: 'groq', type: 'default', enabled: true },
      { key: 'aiModel', value: 'openai/gpt-oss-120b', type: 'default', enabled: true },
      { key: 'aiApiKey', value: '', type: 'secret', enabled: true },
    ],
    _postman_variable_scope: 'environment',
  };

  const dir = path.resolve(__dirname, '..', 'docs', 'postman');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'School-OS-API.postman_collection.json'), JSON.stringify(collection, null, 2));
  fs.writeFileSync(path.join(dir, 'School-OS-Local.postman_environment.json'), JSON.stringify(environment, null, 2));
  const count = tags.reduce((n, t) => n + folders.get(t)!.length, 0);
  console.log(`Wrote docs/postman (${tags.length} folders, ${count} requests)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
