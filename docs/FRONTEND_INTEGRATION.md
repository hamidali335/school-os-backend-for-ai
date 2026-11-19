# Frontend Integration Guide

This guide is for the two independent frontend projects:

1. **School app**, used by owners, principals, administrators, accountants, teachers and parents. Students do not sign in: their parents' accounts cover them.
2. **Platform-owner admin panel**, used by the SaaS operator.

Both apps talk to the backend **only over HTTP**. Do not import backend code or connect to MongoDB. The complete, machine-readable contract is the OpenAPI 3.1 document.

| | Development | Production (example) |
|---|---|---|
| API base URL | `http://localhost:4000/api/v1` | `https://api.yourdomain.pk/api/v1` |
| API docs (Swagger UI) | `http://localhost:4000/api-docs` | `https://api.yourdomain.pk/api-docs` |
| OpenAPI JSON | `http://localhost:4000/api-docs.json` | — |
| Static spec | `docs/openapi.yaml`, `docs/openapi.json` | — |
| Liveness / readiness | `GET /health`, `GET /health/ready` | — |

Put the API base URL in each frontend's environment (for example `VITE_API_BASE_URL`). Then add each frontend's exact origin to the backend's `CORS_ORIGINS`, for example `CORS_ORIGINS=https://app.yourdomain.pk,https://admin.yourdomain.pk`. In development, any `http://localhost:<port>` origin is allowed while `CORS_ORIGINS` is empty.

## 1. Generate a typed client (recommended)

```bash
npx openapi-typescript http://localhost:4000/api-docs.json -o src/api/schema.d.ts
npm i openapi-fetch
```
```ts
import createClient from 'openapi-fetch';
import type { paths } from './schema';
export const api = createClient<paths>({ baseUrl: import.meta.env.VITE_API_BASE_URL.replace(/\/api\/v1$/, '') });
```
Regenerate the types whenever the backend changes (`npm run docs:generate` in the backend also refreshes `docs/openapi.*`).

## 2. Response conventions

- **Success:** `{ "data": <payload> }`.
- **Paginated success:** `{ "data": [...], "meta": { "page": 1, "limit": 20, "total": 134, "totalPages": 7 } }`. Request pages with `?page=&limit=` (`limit` is at most 100).
- **Error:** `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...], "requestId": "..." } }`. Branch on `error.code`. `message` is human-readable and may change.
- **Validation details:** `details` is an array of `{ path: "body.records.0.status", message }`, which you can use to highlight form fields.
- **Ids:** `_id` strings (24 hex characters).
- **Money:** integer rupees. Format it with `toLocaleString('en-PK')`.
- **Dates:** `YYYY-MM-DD` for calendar dates, ISO-8601 UTC for timestamps, `YYYY-MM` for billing periods. The school timezone is in `GET /school/settings` (`Asia/Karachi` by default).
- **Request IDs:** every response has an `X-Request-Id` header. Show it in error toasts ("Reference: …") so support can trace the problem in the logs. You can also send your own `X-Request-Id`.

### Error codes to handle globally

| Code | HTTP | Suggested UI |
|---|---|---|
| `TOKEN_EXPIRED` | 401 | Refresh silently and retry once |
| `UNAUTHORIZED` | 401 | Clear session, go to login |
| `INVALID_CREDENTIALS` | 401 | "Email or password is incorrect" |
| `ACCOUNT_LOCKED` | 423 | "Too many attempts, try again later" |
| `SCHOOL_CODE_REQUIRED` | 400 | Show the school-code field on the login form |
| `ACCOUNT_DISABLED` / `SCHOOL_SUSPENDED` | 403 | Full-page blocked state |
| `FORBIDDEN` | 403 | "You don't have access" |
| `SUBSCRIPTION_INACTIVE` | 402 | Read-only banner; disable write actions |
| `PLAN_LIMIT_REACHED` | 403 | Upgrade prompt |
| `FEATURE_NOT_IN_PLAN` | 403 | The school's plan does not include `details.feature`. Show an upgrade screen (`GET /entitlements` lists the plans that include it) and refresh the cached entitlements |
| `NOT_FOUND` | 404 | Not found page |
| `VALIDATION_ERROR` | 400 | Field errors from `details` |
| `DUPLICATE` / `CONFLICT` / `SECTION_FULL` / `TIMETABLE_CONFLICT` | 409 | Inline message (`details` explains the conflict) |
| `OVERPAYMENT` / `UNPROCESSABLE` | 422 | Inline message |
| `RATE_LIMITED` | 429 | Back off (`Retry-After` header) |
| `AI_UNAVAILABLE` (503), `AI_LIMIT_REACHED` (429), `AI_PROVIDER_ERROR` (502) | | Hide or disable AI panels; never block core screens |
| `CHANNEL_PAUSED` | 503 | SMS, WhatsApp or email is switched off ("Coming soon"). Show the label; never show a success message. `details.pausedChannels` lists the channels. Check `GET /communications/availability` up front to disable these controls |

## 3. Authentication

### School app
1. Log in with `POST /auth/login` `{ email, password, schoolCode? }`. The response contains `accessToken`, `expiresIn` (seconds), `refreshToken`, `refreshTokenExpiresAt`, `user`, `school` and `permissions[]`.
2. Send `Authorization: Bearer <accessToken>` on every request.
3. Refresh with `POST /auth/refresh` `{ refreshToken }`, either when you get `TOKEN_EXPIRED` or shortly before `expiresIn` runs out. **Refresh tokens are single-use.** Always store the new pair from the response. If two tabs refresh with the same token, the second refresh fails and the session family is revoked, so use one refresh in flight (a shared promise or lock) per browser.
4. Log out with `POST /auth/logout` `{ refreshToken }`. To sign out everywhere, use `POST /auth/logout-all`.
5. If `user.mustChangePassword` is true, force `POST /auth/change-password` before showing the app. The response is a fresh token pair.
6. On startup, call `GET /auth/me` to restore the user, school and permissions.

**Token storage:** keep the access token in memory. Keep the refresh token in `sessionStorage` (or `localStorage` for "remember me") and accept the XSS trade-off. With a backend-for-frontend you could instead move it into an httpOnly cookie on your own domain. Never put tokens in URLs.

### Platform-owner admin panel
Use the same flow with `/platform/auth/login`, `/platform/auth/refresh`, `/platform/auth/logout`, `/platform/auth/me` and `/platform/auth/change-password`. Platform tokens are rejected by school endpoints and school tokens are rejected by platform endpoints. Platform refresh sessions last 12 hours.

### Example fetch wrapper with refresh
```ts
let access: string | null = null;
let refreshing: Promise<void> | null = null;

async function refresh() {
  const rt = sessionStorage.getItem('rt');
  const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  if (!res.ok) { sessionStorage.removeItem('rt'); access = null; throw new Error('SESSION_ENDED'); }
  const { data } = await res.json();
  access = data.accessToken; sessionStorage.setItem('rt', data.refreshToken);
}

export async function call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}), ...init.headers } });
  if (res.status === 401 && retry) {
    const body = await res.clone().json().catch(() => ({}));
    if (body?.error?.code === 'TOKEN_EXPIRED') {
      refreshing ??= refresh().finally(() => (refreshing = null));
      await refreshing;
      return call<T>(path, init, false);
    }
  }
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error.message), json.error);
  return json?.data as T;
}
```

## 4. Permissions-driven UI

`GET /auth/me` returns `permissions` such as `students:manage`, `fees:collect` and `approvals:decide`. Use them to show or hide navigation and buttons. The server enforces the same rules, so a hidden button is a convenience, not security.

**Plan features** are separate from permissions. `GET /entitlements` returns every feature with `entitled`, `available` (false for unreleased capabilities such as the mobile apps), `availableIn` (offered plans that include it) and `permissions` (the route permissions that belong to it). A screen is usable when the user has a permission for it **and** the feature behind that permission is entitled. Refetch it on window focus and after any `FEATURE_NOT_IN_PLAN`, so plan changes show up without signing in again. See [SUBSCRIPTION_PLANS.md](SUBSCRIPTION_PLANS.md).

| Role | Typical navigation |
|---|---|
| school_owner / principal | Dashboard, Students, Admissions, Academics, Timetable, Attendance, Homework, Exams, Fees, Accounts, Staff & Payroll, Communications, Certificates, Reports, AI Copilot & Insights, Automations, Approvals, Audit log, Settings, Subscription |
| school_admin | As above, without Approvals decisions, Accounts management, Payroll, Results publishing, Audit, Settings |
| accountant | Dashboard, Fees, Accounts, Payroll, Reports, Approvals (view) |
| teacher | Dashboard, My sections, Timetable, Attendance, Homework, Marks entry, Notifications |
| parent | Dashboard (per child), Attendance, Homework (hand in for a child), Results, Fees & challans, Timetable, Announcements, Documents |

`GET /dashboard` returns a role-specific payload (`role`: `admin` | `accountant` | `teacher` | `parent`). Each variant includes `actions[]` (`{type, priority, title, count, link}`), so you can render a "Needs attention" list directly.

## 5. Screen-to-endpoint map (school app)

| Screen | Endpoints |
|---|---|
| Settings | `GET/PATCH /school`, `GET/PATCH /school/settings`, `/campuses`, `/users`, `POST /users/{id}/reset-password` |
| Academics setup | `/academics/sessions` (+`/set-current`), `/academics/classes`, `/academics/sections`, `/academics/subjects`, `/academics/teaching-assignments`, `/academics/my-sections` |
| Students | `GET/POST /students`, `GET/PATCH /students/{id}`, `/students/{id}/status`, `/students/{id}/overview`, `/students/{id}/documents`, `/students/promote`, `/parents`, `/parents/{id}/children` |
| Admissions CRM | `/admissions/inquiries` (+`/follow-ups`, `/convert`, `/lost`), `/admissions/pipeline` |
| Timetable | `GET /timetable?sectionId=` or `?teacherId=`, `POST /timetable/check` (live conflict hints), `POST/PATCH/DELETE /timetable`, `PUT /timetable/sections/{id}`, `/timetable/conflicts`, `/timetable/teacher-load` |
| Attendance | `GET /attendance/sections/{id}?date=` (marking sheet), `POST /attendance/mark`, `/attendance/daily`, `/attendance/report`, `/attendance/students/{id}`, `/attendance/chronic-absentees` |
| Homework | `/homework`, `/homework/{id}`, `/homework/{id}/submissions` (+`/grade`) |
| Exams | `/exams`, `PUT /exams/{id}/papers`, marks roster/entry `/exams/{id}/papers/{paperId}/marks`, `/exams/{id}/results?sectionId=`, `/exams/{id}/report-cards/{studentId}`, `/exams/{id}/publish` |
| Fees | `/fees/heads`, `/fees/structures`, `/fees/invoices/generate`, `/fees/invoices` (+`/{id}`, `/challan.pdf`, `/payments`, `/installments`, `/waiver-requests`, `/cancel-requests`), `/fees/payments` (+`/receipt.pdf`, `/reversal-requests`), `/fees/outstanding`, `/fees/students/{id}/ledger`, `/fees/students/{id}/concession-requests`, `/fees/late-fees/apply` |
| Accounts | `/accounts/income`, `/accounts/expenses`, `/accounts/summary` |
| Staff & payroll | `/employees`, `/payroll/generate`, `/payroll/payslips` (+`/pay`) |
| Communications | `/communications/announcements` (+`/publish`), `/communications/messages`, `/communications/channels`, `/communications/costs`, `/notifications` (+`/unread-count`, `/read`, `/read-all`) |
| Certificates & files | `POST /files` (multipart), `GET /files/{id}/download`, `/certificates` (+`/download`, `/revoke`) |
| Reports | `/reports/attendance`, `/reports/fee-collection`, `/reports/outstanding`, `/reports/finance`, `/reports/admissions`, `/reports/enrollment`, `/reports/exams/{id}/analysis` (`?format=csv` where supported) |
| AI | `/ai/status`, `/ai/copilot/chat`, `/ai/insights`, `/ai/daily-brief`, `/ai/explain`, `/ai/summarize`, `/ai/admissions/{id}/recommendation`, `/ai/draft-communication`, `/ai/reports/narrative`, `/ai/usage` |
| Automations | `/automations/templates`, `/automations`, `/automations/{id}/run`, `/automations/runs` |
| Approvals | `GET /approvals?status=pending`, `GET /approvals/{id}`, `POST /approvals/{id}/decision`, `/approvals/{id}/cancel` |
| Audit / subscription | `/audit-logs`, `/subscription` |

### Workflows to model in the UI
- **Approval-gated actions return `202` with an approval request.** These are waivers, cancellations, payment reversals and concessions. Show the result as "Submitted for approval". Large expenses return `201` with `approvalRequired: true`. Announcements that go to external channels (to many recipients or with AI-drafted text) return `status: "pending_approval"` from `/publish`.
- **The approval detail screen** should show `data` (facts), `analysis`, `recommendation` and `payload`. After a decision, show `status` (`executed` or `failed`), `result` or `error`.
- **Payments:** send an `idempotencyKey` (for example a UUID generated when the payment dialog opens). If the network fails, retry with the same key. A replayed request returns the original payment with `replayed: true`.
- **Timetable editor:** call `POST /timetable/check` while the user edits, to show conflicts before saving.
- **Messaging statuses:** `sent` means the provider accepted the message. `not_configured` means the channel has no credentials. Show these honestly.

## 6. File uploads and downloads

**Upload:** `POST /files` as `multipart/form-data` with a `file` field plus `category` (`student_document` | `certificate` | `homework` | `submission` | `employee_document` | `school`). Optional fields are `studentId`, `employeeId`, `homeworkId`, `documentType`, `description` and `visibleToFamily` (`"true"` / `"false"`). The size limit comes from `MAX_UPLOAD_MB` (10 MB by default).

**Downloads need the Authorization header,** so a plain `<a href>` will not work. Fetch the file as a blob instead:
```ts
const res = await fetch(`${BASE}/fees/invoices/${id}/challan.pdf`, { headers: { Authorization: `Bearer ${access}` } });
const url = URL.createObjectURL(await res.blob());
window.open(url); // or create an <a download> link
```
This applies to challans, receipts, certificates, `/files/{id}/download` and CSV exports (`?format=csv`).

## 7. AI panels

Check `GET /ai/status` once per session. `includedInPlan` lists the AI features in the school's plan (empty: AI is not in the plan, so show the upgrade screen). If `available` is false, hide the Copilot or show it as disabled. Insights and the daily brief still work without AI. `/ai/daily-brief` always returns `text`, which is either the AI narrative or a computed fallback.

The Copilot is stateless. Keep the conversation on the client and send the last turns, up to 12 messages, with the user's message last. Show any returned `proposals`, which are drafts or approval requests, with links to the approval queue.

## 8. Platform-owner admin panel map

| Screen | Endpoints |
|---|---|
| Overview | `GET /platform/overview` |
| Schools | `GET/POST /platform/schools`, `GET/PATCH /platform/schools/{id}`, `/suspend`, `/activate`, `PUT /subscription`, `/extend-trial` |
| Plans & pricing | `GET /platform/features`, `GET/POST /platform/plans`, `GET /platform/plans/{id}`, `PUT/DELETE /platform/plans/{id}/draft`, `GET …/draft/preview`, `POST …/publish`, `…/archive`, `…/restore` (platform_owner only for writes) |
| School subscription & features | `GET /platform/schools/{id}/entitlements`, `GET …/plan-change/preview`, `POST …/plan-change`, `PUT …/feature-overrides`, `POST …/subscription/apply-current-price` (platform_owner only for writes) |
| Usage & limits | `GET /platform/usage` |
| AI usage & cost | `GET /platform/ai-usage?from=&to=` |
| API & DB health | `GET /platform/health` (plus public `/health/ready`) |
| Integrations | `GET /platform/integrations` |
| Errors | `GET /platform/errors?hours=24` |
| Audit events | `GET /platform/audit-events` (`?schoolId=` for one school) |
| Admin activity / admins | `GET /platform/admin-activity`, `GET/POST/PATCH /platform/admins` (platform_owner only) |

These endpoints return aggregates only, with no student names, contact details or passwords. Error summaries leave out internal error messages.

## 9. Rate limits

| Scope | Limit |
|---|---|
| Whole API | 300 requests per minute per IP |
| Login, refresh and password endpoints | 10 per 15 minutes per IP + email |
| AI endpoints | 20 per minute per user |

Responses include `RateLimit` and `RateLimit-Policy` headers. A `429` includes `Retry-After`.
