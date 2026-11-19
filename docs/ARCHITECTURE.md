# Architecture

## Overview

The backend is a modular monolith: one Node.js process (scalable horizontally), one MongoDB database, and 25 domain modules under `src/modules`. Each module owns its models, services and routes. Modules call one another through exported service functions, never through HTTP.

```
HTTP ─► requestId ─► pino-http ─► helmet/CORS ─► JSON body ─► global rate limit
     ─► route: [route rate limit] ─► authenticate (school | platform) ─► permission/role check
     ─► [multipart] ─► Zod validation (params, query, body) ─► handler ─► { data } envelope
     ─► error handler ─► { error: { code, message, details, requestId } }
```

`src/utils/api.ts` (`Api.route`) is the single place where a route is declared. It mounts the Express handler and registers the OpenAPI operation from the same Zod schemas, so the documentation always matches what the server enforces.

## Identities

| Identity | Collection | Token secret / audience | Login |
|---|---|---|---|
| School user | `users` (tenant-scoped, unique email per school) | `JWT_ACCESS_SECRET` / `school-os:school` | `/auth/login` |
| Platform admin | `platformadmins` (global) | `JWT_PLATFORM_SECRET` / `school-os:platform` | `/platform/auth/login` |

Access tokens carry `sub`, the tenant `sid` (school users), `role` and `tv` (token version). Every request reloads the user and school. A token is rejected when any of these is true:
- the account is disabled;
- the token version changed (password change, role change, logout-all);
- the school is suspended or pending.

When a subscription is expired or cancelled, non-GET requests return `402 SUBSCRIPTION_INACTIVE`, so the school becomes read-only.

Refresh tokens are random 48-byte values. Only their SHA-256 hash is stored, in `refreshtokens`, which has a TTL index. Each refresh atomically marks the presented token as rotated. If a rotated token is presented again, every token in its family is revoked.

## Multi-tenancy

- Every school-owned schema has `schoolId` (required, indexed, immutable) and the **tenant plugin** (`src/database/tenant-plugin.ts`).
- **Queries and aggregations.** The plugin rejects any find, update, delete, count or distinct, and any aggregation whose first `$match` lacks `schoolId`. Platform code that legitimately aggregates across schools passes the option `{ crossTenant: true }` explicitly, and only platform routes do this.
- **Populate.** The plugin copies the parent query's `schoolId` into every `populate` match, so a reference can never resolve to another school's document.
- **Service helpers** (`src/utils/tenant.ts`):
  - `scope(ctx, filter)` adds the caller's `schoolId`.
  - `findOwned` loads a record by id within the school and returns 404 otherwise.
  - `assertRefs` / `assertManyRefs` verify that body references belong to the school.
  - `campusScope` restricts users who have `campusIds` to their campuses.
- **Parents** see only their children: students linked through `Student.guardians.parentId`. Students have no login of their own (the `student` role is retired and kept only so old user documents stay readable). **Teachers** act only on sections where they are class teacher or have a teaching assignment.

## Sensitive actions and approvals

Sensitive actions follow a fixed pipeline:

`DATA → ANALYSIS → RECOMMENDATION → APPROVAL → ACTION → RESULT → AUDIT LOG`

An `ApprovalRequest` stores:
- `data`: facts computed by code;
- `analysis` and `recommendation`;
- `payload`: the parameters of the action.

When a request is approved, its registered handler (`src/modules/approvals/handlers.ts`) runs normal application code. The request then becomes `executed` with a `result`, or `failed` with an `error`.

| Type | Created by | Action on approval |
|---|---|---|
| `expense` | Expense at or above `settings.approvals.expenseThreshold` | Expense becomes `approved` (counted in finance) |
| `invoice_waiver` | Fee staff | Atomic waiver applied to the balance |
| `invoice_cancel` | Fee staff | Unpaid invoice cancelled |
| `payment_reversal` | Fee staff | Payment reversed and invoice balance restored |
| `fee_concession` | Fee staff | Standing concession applied to future invoices |
| `announcement_publish` | Bulk external send or AI-drafted text | Publish and dispatch |
| `fee_reminder_batch` | AI Copilot or automation | In-app plus external reminders |
| `message_batch` | Attendance-alert automation (external channels) | External alerts |

**Rules:**
- Deciders need `approvals:decide` (school owner or principal).
- Requesters cannot decide their own requests. A school owner may, and that decision is flagged `selfApproval` in the audit log.
- Decisions claim the request atomically, so two approvers cannot both act on it.

## Money and data integrity without transactions

The system runs on a standalone MongoDB; no replica set is needed.

- **Payments.** A single conditional `findOneAndUpdate` with an update pipeline adds to `paid`, subtracts from `balance` and recomputes `status`. It succeeds only while `balance >= amount`, so concurrent payments cannot over-settle an invoice. If the receipt write fails, the invoice update is compensated.
- **Idempotency.** An `idempotencyKey` under a unique partial index makes client retries safe.
- **Sequences.** Invoice, receipt, admission, inquiry, employee and certificate numbers come from atomic per-school counters.
- **Invoice uniqueness.** A unique index (student + period, for regular invoices) makes generation idempotent.
- **Calculation code.** Fee arithmetic (`fees/fee-calc.ts`), results and grading (`examinations/result-calc.ts`), attendance rates (`attendance/attendance-stats.ts`) and timetable conflicts (`timetable/conflicts.ts`) are pure functions with unit tests.

## AI

- **Provider.** `src/modules/ai/provider.ts` defines the `AiProvider` interface and one OpenAI-compatible client used for every provider (Groq, OpenAI, DeepSeek, xAI, Gemini, OpenRouter, custom; catalogue in `catalog.ts`). The active provider, model and encrypted key come from the platform admin settings (`aisettings` collection), with `.env` as fallback. See docs/AI_PROVIDERS.md.
- **Single call path.** `ai.service.ts#callAi` is the only way to reach a provider. It performs, in order:
  1. a configuration check;
  2. a school AI-enabled check;
  3. a per-school monthly token limit check (plan, optionally lowered by the school);
  4. a platform monthly limit check;
  5. the provider call with a timeout;
  6. recording an `AiUsage` row (tokens, estimated cost, latency, status).

  Errors become typed `AppError`s. Providers' raw error bodies are never surfaced.
- **Copilot tools** (`copilot-tools.ts`) are fixed TypeScript functions over existing services. Tools are filtered by the user's permissions before they are offered to the model, and checked again on execution. Arguments are validated with Zod. Tools are read-only, except `draft_announcement` (creates a draft) and `propose_fee_reminders` (creates an approval request).
- **Computed first, narrated second.** Insights, the daily brief and report narratives compute their numbers first, then optionally ask the AI to narrate them (`tryNarrate`). If AI is unavailable, the computed data is still returned.

## Messaging

- **Adapters.** `services/messaging/adapters.ts` has adapters for SMTP email (nodemailer), Twilio SMS and the WhatsApp Cloud API. `dispatchMessage` writes one `MessageLog` row per message, with a real status:
  - `sent`: the provider accepted the message;
  - `failed`;
  - `not_configured`;
  - `limit_reached`: the plan's `messagesPerMonth` was exceeded.
- **Costs.** A cost (PKR) is recorded only for `sent` messages.
- **Background delivery.** Bulk sends run in the background with a concurrency of 5 (no external queue). Progress is visible on the announcement's `delivery` field and in the message log.

## Automations

- **Rules.** `AutomationRule` has a type, a schedule (daily or weekly, hour in the school's timezone) and a config. The types are `fee_reminder`, `admission_followup`, `attendance_alert`, `late_fee` and `daily_brief`.
- **Scheduler.** `automations/scheduler.ts` polls every `SCHEDULER_INTERVAL_SECONDS`. It claims each due rule with an atomic lock (`lockedUntil`), so several API instances never run the same rule twice.
- **Run log.** Each run writes an `AutomationRun` execution log.
- **Approval routing.** Anything that would send external messages becomes an approval request.

## Files

`services/storage.ts` keeps files under `STORAGE_DIR/<schoolId>/<category>/<uuid>.<ext>`. That directory is outside any static route.

**Upload checks:**
- the MIME type must be on an allow-list;
- the file's magic number must match its declared type;
- the size is limited by `MAX_UPLOAD_MB`.

**Download rules:** the record must belong to the caller's school, plus a per-category rule in `canAccessFile`. Parents see only files marked visible to family, and only for their own children.

To run several servers, replace this module with object storage (S3, Azure Blob, GCS).

## Observability

- **Logs.** Pino writes structured JSON (pretty-printed in development). Passwords, tokens, CNIC/B-Form numbers and medical notes are redacted. Request bodies are never logged.
- **Correlation.** `X-Request-Id` is on every response and in every log line.
- **Error events.** Unexpected 5xx errors and scheduler failures are stored in `errorevents` (kept for 90 days) for `/platform/errors`.
- **Health checks.** `/health` is a liveness check that never touches the database. `/health/ready` pings MongoDB.
