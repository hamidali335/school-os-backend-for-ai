# School OS — Backend API

Multi-tenant backend for the **AI School & Academy Operating System** for private schools and academies in Pakistan. It is the first of three independent applications:

| Application | Talks to | Status |
|---|---|---|
| **school-os-backend** (this repo) | MongoDB | Complete |
| School frontend (staff, parents, students) | This API over HTTP | Separate project, not started |
| Platform-owner admin panel | This API over HTTP | Separate project, not started |

The frontends never connect to MongoDB and never import code from this repository. Everything they need is in the OpenAPI document and [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md).

- **Stack:** Node.js 20+ (tested on 22), TypeScript, Express 5, MongoDB with Mongoose 9, Zod 4, JWT plus rotating refresh tokens, bcrypt, Pino, Vitest.
- **Shape:** a modular monolith. No microservices, no Docker requirement.
- **API:** `http://localhost:4000/api/v1`. Health is at `/health` and `/health/ready`. Docs are at `/api-docs` (Swagger UI) and `/api-docs.json`; static copies are in `docs/openapi.yaml` and `docs/openapi.json`.

---

## Quick start

### 1. Prerequisites
- Node.js 20.11 or newer (`node -v`).
- MongoDB 6.0 or newer. Use a local install or a free MongoDB Atlas cluster (see [MongoDB setup](#mongodb-setup)).

To try the API without installing MongoDB, run `npm run demo` (see step 5).

### 2. Install
```bash
cd school-os-backend
npm install
```

### 3. Configure
```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```
Edit `.env` and set at least:
- `MONGODB_URI`
- `JWT_ACCESS_SECRET` and `JWT_PLATFORM_SECRET`: two different random values. Generate each one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- `SEED_DEMO_PASSWORD`: the password for the demo logins. It needs 10 or more characters with an upper-case letter, a lower-case letter and a digit.

AI, SMS, WhatsApp and email are all **optional**. The server starts and every core feature works without them.

### 4. Seed demo data and create a platform owner
```bash
npm run seed                    # Bright Future School System, Bahawalpur, 2026-2027
npm run create-platform-owner -- --email you@yourcompany.com --name "Your Name" --password "A-Strong-Pass-2026"
```
The `--` is required so npm passes the arguments on to the script. The password needs 10 or more characters with an upper-case letter, a lower-case letter and a digit.

You can also use environment variables. In PowerShell, use `$env:NAME="value"`; `Set NAME value` only creates a PowerShell variable, which the script cannot see:
```powershell
$env:PLATFORM_OWNER_EMAIL="you@yourcompany.com"; $env:PLATFORM_OWNER_PASSWORD="A-Strong-Pass-2026"; npm run create-platform-owner
```

If `MONGODB_URI` does not name a database (common with Atlas strings ending in `.net/?retryWrites=true`), the API uses `MONGODB_DB_NAME`, which defaults to `school_os`, instead of MongoDB's implicit `test` database.

### 5. Run
```bash
npm run dev          # development, auto-reload
# or
npm run build && npm start   # compiled production build
# or, without MongoDB installed (data is lost on exit):
npm run demo
```
Then open http://localhost:4000/api-docs.

### Demo logins (after `npm run seed`)
Every demo account uses the password you set in `SEED_DEMO_PASSWORD`. The school code is `BFSS`.

| Role | Email |
|---|---|
| School owner | owner@brightfuture.example |
| Principal | principal@brightfuture.example |
| School administrator | admin@brightfuture.example |
| Accountant | accounts@brightfuture.example |
| Teachers | teacher.ayesha@ / teacher.bilal@ / teacher.rabia@brightfuture.example |
| Parent | parent@brightfuture.example |

Students have no login of their own: the parent account shows each of the parent's children (attendance, homework, results, fees) and hands in homework for them. Databases seeded before this change may still hold a `student@…` login; `npm run migrate:retire-student-logins -- --apply` disables it (see docs/DEPLOYMENT.md).

The seed creates 2 campuses, 11 classes, 13 sections, 8 subjects and 16 employees. It also creates 98 students with parents, fee structures, about 290 invoices with about 215 payments for Aug–Oct 2026, 15 days of attendance, a published first-term exam, a Class 5-A timetable, 18 admission inquiries, expenses and income, and 4 automation rules. All of it is fictional. Running the seed again changes nothing and does not overwrite passwords that users have changed. It refuses to run when `NODE_ENV=production`.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start with auto-reload (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm test` | Run the automated test suite (in-memory MongoDB; never touches your database) |
| `npm run typecheck` | Type-check `src`, `tests` and `scripts` |
| `npm run seed` | Seed the idempotent demo school |
| `npm run create-platform-owner` | Create a platform owner. Add `--reset-password` to reset an existing one |
| `npm run db:indexes` | Report index changes (dry run). `-- --apply` creates missing indexes (never drops); `-- --apply --drop-obsolete` also replaces/drops undeclared ones. Run after every production deploy |
| `npm run backup:keygen` / `backup:verify` / `backup:restore` | Backup key generation, offline verification and restore into an empty database — see docs/BACKUP_RESTORE.md |
| `npm run security:inventory` | Regenerate docs/audit/ENDPOINT_INVENTORY.md from the route definitions |
| `npm run docs:generate` | Regenerate `docs/openapi.yaml` and `docs/openapi.json` from the code |
| `npm run postman:generate` | Regenerate the Postman collection and environment in `docs/postman/` |
| `npm run demo` | Temporary in-memory MongoDB, seed and API (for evaluation only) |
| `npm run format` | Run Prettier |

---

## MongoDB setup

**Windows:** install MongoDB Community Server (MSI) from mongodb.com/try/download/community and select "Install as a Service". The connection string is `mongodb://127.0.0.1:27017/school_os`.

**macOS:**
```bash
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

**Ubuntu/Debian:** follow the official apt instructions for `mongodb-org`, then run `sudo systemctl enable --now mongod`.

**MongoDB Atlas (cloud):**
1. Create a cluster and a database user.
2. Add your server's IP to the IP access list.
3. Use `mongodb+srv://USER:PASS@CLUSTER.mongodb.net/school_os?retryWrites=true&w=majority`.

The application does **not** need a replica set. Money-sensitive updates use atomic single-document operations, so a standalone `mongod` works.

---

## Project structure

```text
src/
  app.ts, server.ts         Express app factory, process entry (graceful shutdown, scheduler)
  config/                   env validation (Zod), logger with redaction, roles and permissions
  database/                 connection, tenant-guard plugin, schema helpers, counters
  middleware/               authentication, request ids, rate limits, error handling
  docs/openapi.ts           OpenAPI document builder
  services/                 PDF rendering, private file storage, messaging adapters
  utils/                    route builder (validation + auth + docs), tenancy helpers, CSV, dates
  modules/
    auth  schools  campuses  users  students (+parents)  admissions  academics
    timetable  attendance  homework  examinations  fees  accounts  employees (+payroll)
    communications  certificates (+files)  reports (+dashboard)  ai  automations
    approvals  subscriptions  platform-admin  audit  health
tests/                      12 test files, 114 tests (Vitest + Supertest + mongodb-memory-server)
scripts/                    seed, create-platform-owner, sync-indexes, generate-openapi, generate-postman, demo
docs/                       openapi.yaml/json, integration, architecture, deployment, backup, troubleshooting
```

Every route is declared once through `api.route({...})`. That one declaration does three things:
- it mounts the Express handler;
- it validates params, query and body with Zod;
- it enforces authentication, permissions and roles, and registers the endpoint in OpenAPI.

Because of this, **the documentation cannot drift from the code**.

---

## Roles and access

| Role | Highlights |
|---|---|
| `school_owner` | Everything in their school, including subscription and audit. May approve their own requests (flagged in the audit log) |
| `principal` | Everything except subscription. Approves requests and publishes results |
| `school_admin` | Day-to-day operations. Cannot decide approvals, manage accounts or payroll, or publish results |
| `accountant` | Fees, payments, income, expenses, payroll, financial reports |
| `teacher` | Attendance, homework and marks for **their own sections and subjects only** |
| `parent` | Their own children only: profile, attendance, homework, published results, fees, documents |
| `student` | Themselves only. Can submit homework |
| `platform_owner` / `platform_admin` | A **separate identity** with separate tokens. Platform admins cannot manage plans, change a school's plan or features, or manage other admins |

The full permission matrix is in `src/config/permissions.ts`. `GET /api/v1/auth/me` returns the effective permissions, so frontends can show or hide UI. The server always enforces permissions independently.

---

## Multi-tenancy and security model (summary)

- **Tenant from the token only.** `schoolId` is read from the verified JWT and re-checked against the database on every request. No school endpoint accepts a `schoolId` from the client; one sent in a body or query is ignored.
- **Tenant guard plugin.** Every query, update, delete and aggregation on a school-owned collection must filter by `schoolId`, or Mongoose throws `TenantScopeError`. Populated references are scoped to the same school automatically.
- **Reference checks.** Ids in request bodies (class, section, parent, teacher and so on) are verified to belong to the caller's school before they are written (`INVALID_REFERENCE`). A foreign id always returns `404`, never `403`, so the API does not reveal that the record exists.
- **Tests.** Automated tests show that School A cannot read, list, search, export, pay, approve, modify or download anything from School B.
- **Passwords and lockout.** Passwords are hashed with bcrypt (12 rounds). Accounts lock after 5 failed logins. Login timing is equalised for unknown accounts.
- **Tokens.** Access tokens are short-lived (15 min). Refresh tokens are opaque and stored only as SHA-256 hashes. They are single-use with rotation, and reusing a refresh token revokes the whole session family. Changing a password, changing a role or disabling an account revokes sessions immediately (`tokenVersion`).
- **Other protections:**
  - Helmet security headers and a CORS allow-list.
  - Rate limits for the whole API, logins and AI.
  - A 1 MB JSON body limit.
  - Escaped search regexes.
  - CSV export with formula-injection protection.
- **Files.** Uploads are checked against magic numbers, stored outside any web root, and downloaded only through per-file authorization checks.
- **Logging.** Pino redacts passwords, tokens, CNIC/B-Form numbers and medical notes. Request bodies are never logged. Every response carries `X-Request-Id`.
- **Audit log.** Logins, every write, approvals, exports, downloads and platform actions are recorded.

Full details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## AI (Grok/xAI)

- [docs/SUBSCRIPTION_PLANS.md](docs/SUBSCRIPTION_PLANS.md): plans, pricing, feature entitlements, enforcement and the migration for existing schools.
Choose the provider and model in the platform admin panel (`/platform/ai/...` endpoints): Groq, OpenAI, DeepSeek, xAI Grok, Google Gemini, OpenRouter or any OpenAI-compatible endpoint. You can switch at any time without a restart. Alternatively set `AI_PROVIDER`, `AI_API_KEY` and `AI_MODEL` in `.env` as the fallback. See [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md). `npm run ai:check` tests the `.env` configuration.

**Design rules:**
- Application code calculates every fee, balance, grade and attendance figure. AI only explains or summarises numbers it is given.
- The Copilot uses **read-only, permission-filtered tools**. The tools offered to the model depend on the user's permissions, and each tool call is authorised again when it runs. The model cannot run queries or code.
- Sensitive actions follow **DATA → ANALYSIS → RECOMMENDATION → APPROVAL → ACTION → RESULT → AUDIT LOG**. The AI can only create *drafts* (announcements) or *approval requests* (fee reminders). People approve them, and application code executes them.
- **Failure handling:**

  | Situation | Response |
  |---|---|
  | No API key | `503 AI_UNAVAILABLE` |
  | AI turned off in school settings | `503 AI_UNAVAILABLE` |
  | Provider error or timeout | `502 AI_PROVIDER_ERROR` |
  | Monthly token limit reached | `429 AI_LIMIT_REACHED` |

  Insights and the daily brief still return their computed data (with `aiStatus: "unavailable"`), and every other feature keeps working.
- **Usage and limits.** Token usage and estimated cost are recorded for every call (`AI_INPUT_COST_PER_MTOK_USD` / `AI_OUTPUT_COST_PER_MTOK_USD`). Limits apply per school (from the plan, and a school can lower its own) and across the platform.
- **Swapping providers.** The provider is an interface (`src/modules/ai/provider.ts`). Any OpenAI-compatible provider can be added with a base URL and key.

## Messaging (SMS, WhatsApp, email, in-app)

- **In-app** notifications are stored and delivered immediately.
- **External channels** use real adapters: SMTP email (nodemailer), Twilio SMS and the WhatsApp Cloud API. Each channel is enabled only when its credentials are set.
- **Honest statuses.** A message is logged as `sent` only after the provider accepts it. A missing provider is logged as `not_configured`, and nothing is ever reported as sent when it was not.
- **Approval gates.** Bulk external sends (at or above `settings.approvals.bulkMessageThreshold`) and AI-drafted text require approval.
- **Costs.** Messaging costs are tracked separately from AI costs (`MESSAGE_COST_*_PKR`).

---

## Incomplete features and items that need credentials

| Item | Status |
|---|---|
| AI providers (Groq, OpenAI, DeepSeek, xAI, Gemini, OpenRouter, custom) | Implemented; choose and switch in the platform admin panel. Each needs that provider's API key. Cost estimates need your per-token prices. |
| SMS (Twilio) | Implemented; needs Twilio credentials. Local Pakistani SMS gateways would need a new adapter (one file). |
| WhatsApp Cloud API | Implemented for text messages; needs a token and phone number id. Meta only allows free-form text inside a 24-hour customer window. **Business-initiated template messages are not implemented yet.** |
| Email (SMTP) | Implemented; needs SMTP settings. |
| Delivery receipts / webhooks | **Not implemented.** `sent` means the provider accepted the message; final delivery status is not tracked. |
| Online fee payments (JazzCash, Easypaisa, cards) | **Not implemented.** Payments are recorded by staff (cash, bank, cheque, online reference). |
| Self-service "forgot password" by email | **Not implemented.** Administrators reset passwords (`POST /users/{id}/reset-password`), which issues a one-time temporary password. |
| MFA for platform administrators | **Not implemented.** Recommended before going live. |
| Urdu text in PDFs | PDFs use standard fonts, so Urdu script will not render in challans and certificates until an Urdu font (e.g. Noto Nastaliq) is embedded. JSON APIs fully support Urdu. |
| Report-card PDF | Report cards are JSON (`GET /exams/{id}/report-cards/{studentId}`); the frontend renders them. Challans, receipts and certificates are PDFs. |
| Staff attendance and leave | Not included in this version. Payroll is basic: monthly payslips plus a salary expense. |
| Transport, Library, Inventory | Excluded by design (no models, endpoints or jobs). |
| Horizontal scaling | Rate limits and files are per instance. A shared rate-limit store and object storage are needed for more than one instance (see deployment guide). The scheduler is already safe across instances. |

---

## Documentation

- [docs/BIOMETRIC_ATTENDANCE.md](docs/BIOMETRIC_ATTENDANCE.md): staff attendance from fingerprint machines (export files today, Connector API; live device integrations planned).
- [docs/DATA_IMPORT.md](docs/DATA_IMPORT.md): importing students, parents, staff, classes and sections from Excel/CSV (templates or a school's own files).
- [docs/SCHOOL_DOCUMENTS_AND_ACCOUNTS.md](docs/SCHOOL_DOCUMENTS_AND_ACCOUNTS.md): school logo and document design, installment challans, user suspend/archive/delete, notifications, teacher–parent messages, substitute cover on the timetable.
- [docs/MESSAGING_CHANNELS.md](docs/MESSAGING_CHANNELS.md): SMS, WhatsApp and email are paused ("Coming soon"), and how to switch each one on.
- [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md): choosing and switching AI providers and models.
- [docs/POSTMAN.md](docs/POSTMAN.md): testing every endpoint with the generated Postman collection.
- [docs/FRONTEND_INTEGRATION.md](docs/FRONTEND_INTEGRATION.md): how the school frontend and the owner admin panel connect.
- [docs/openapi.yaml](docs/openapi.yaml): the full API reference (also live at `/api-docs`).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): tenancy, approvals, AI, automations and data model.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production deployment without Docker.
- [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md): backups and restoration.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): common problems and fixes.
