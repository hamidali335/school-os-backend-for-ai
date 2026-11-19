# Final staging verification

Date: 17 Oct 2026. Projects: `school-os-backend` (BE), `school-management-software-frontend`
(school app, FE), `school-os-admin-panel` (console, AP). All three were clean `main` branches
before this work; every change is uncommitted in the working trees for review.

**Decision: SUPERVISED PILOT ONLY** — see §9.

Linked reports: [ENDPOINT_INVENTORY](ENDPOINT_INVENTORY.md) ·
[DATA_INTEGRITY_TESTS](DATA_INTEGRITY_TESTS.md) · [DATABASE_FAILURE_TESTS](DATABASE_FAILURE_TESTS.md) ·
[MIGRATION_VERIFICATION](MIGRATION_VERIFICATION.md) · [BACKUP_RESTORE_TEST_RESULTS](BACKUP_RESTORE_TEST_RESULTS.md) ·
[LINUX_DEPLOYMENT_TEST_RESULTS](LINUX_DEPLOYMENT_TEST_RESULTS.md) · [KNOWN_ISSUES](KNOWN_ISSUES.md) ·
[REMEDIATION_LOG](REMEDIATION_LOG.md) (R16–R28) · [FINAL_GO_LIVE_CHECKLIST](FINAL_GO_LIVE_CHECKLIST.md) ·
[../DEPLOYMENT.md](../DEPLOYMENT.md) · [../BACKUP_RESTORE.md](../BACKUP_RESTORE.md).
Earlier reports (PRODUCTION_READINESS_REPORT, TEST_RESULTS, SECURITY_AUDIT_REPORT,
DEPLOYMENT_VERIFICATION, PERFORMANCE_REPORT, 14 Oct) are kept for history; where they differ,
this report and the linked ones are current.

## 1. Environment

| Item | Value |
|---|---|
| Host | Windows 11 Pro, Node 22.23.3. No Linux/WSL/Docker available. |
| Staging database | MongoDB 8.2.6 single-node **replica set** `rs0`, on disk, 127.0.0.1:27117, database `school_os_staging` (seeded demo school, fictional data) |
| "Clean server" for restore | Second MongoDB 8.2.6 instance `rs1`, 127.0.0.1:27118, empty data folder |
| API | `node dist/server.js`, `NODE_ENV=production`, bcrypt cost 12, run from a folder **without `.env`** (staging-only random secrets); http://localhost:4100 |
| Frontends | `next build` → `next start` (production): school app :3100, console :3101, `NEXT_PUBLIC_API_BASE_URL=http://localhost:4100/api/v1` |
| Deviations | `AUTH_RATE_LIMIT_MAX=30` and `RATE_LIMIT_MAX=1500` for e2e (single IP); limits raised further for the load test only; `SMS_ENABLED=true` without credentials for the "not configured" e2e case |
| Untouched | The developer `.env` (MongoDB Atlas) was never loaded by any test or script in this work; tests refuse non-test databases. |

## 2. Automated results (actually executed)

| Project | Check | Command | Result |
|---|---|---|---|
| BE | Type check | `npx tsc --noEmit` | PASS |
| BE | Format | `npx prettier --check …` | PASS |
| BE | Unit + API integration, standalone MongoDB + **replica set** projects | `npx vitest run` | **319/319** (33 files; baseline before changes 275/275, 27 files) |
| BE | Production build | `npm run build` | PASS |
| BE | Dependency audit | `npm audit` / `--omit=dev` | 0 / 0 |
| FE | Type check / lint / unit | `tsc`, `eslint src tests`, `vitest run` | PASS / PASS / see §2a |
| FE | Production build | `next build` | PASS |
| FE | **Playwright vs staging** (desktop + mobile, a11y scan) | `npx playwright test` | **75/75** on a fresh seed |
| AP | Type check / lint / unit | as above | PASS / PASS / see §2a |
| AP | Production build | `next build` | PASS |
| AP | **Playwright vs staging** (console, lifecycle with writes, backups) | `E2E_ALLOW_WRITES=1 npx playwright test` | **25/25** on a fresh seed |
| FE, AP | Production dependency audit | `npm audit --omit=dev` | 0 vulnerabilities each |

§2a — unit tests (final run): school app **71/71** (12 files; unchanged from baseline), console
**65/65** (6 files; baseline 62 + 3 new backup-helper tests). Type check and lint clean in both.

E2E runs before the final green ones (kept honest): school app 69/71 first (one stale assertion,
one environment mismatch), then 69/70 + 5 not run (HTTP 429 from the production global rate
limit, single IP); console 13/25 then 20/25 (stale lifecycle test data; new backup dialog bug B1).
Causes and fixes: REMEDIATION_LOG R27–R28, KNOWN_ISSUES K4.

## 3. Security

| Area | Method | Result |
|---|---|---|
| Endpoint inventory | Generated from route definitions: **293 endpoints** (14 public, 227 school, 52 platform) | ENDPOINT_INVENTORY.md; regression test fails on any new unauthenticated route |
| Unauthenticated surface | Review of all 14 public routes | Health, index, login/refresh/logout, account-link redeem, certificate verify (minimal data, now rate-limited), backup download (single-use token) |
| Tenant isolation (BOLA/IDOR) | `cross-tenant-probe.test.ts`: School A's Admin × 118 id-taking routes × 29 real School B ids = **3,422 requests**, plus query/body `schoolId` tampering | **0 leaks, 0 server errors, School B data byte-identical**. Mass-assigned `schoolId` ignored. (Requests used empty bodies: deep mutation paths rely on the existing isolation suites.) |
| AuthN/AuthZ, roles, teacher/parent/substitute scope, custom roles, revocation | Existing suites (auth, auth-edge, accounts-roles, teacher-access-homework, tenant-isolation) re-run | PASS (part of 319) |
| Platform vs school identity | Separate secrets/audience; platform routes reject school tokens | PASS (tests); inventory test: no platform path uses school auth |
| Platform admin MFA | Not implemented | **Compensating control implemented**: `PLATFORM_ALLOWED_IPS` + nginx allow-list + password re-entry for backup download/delete. Public exposure of the console must stay blocked (K1). |
| Login abuse | Rate limits (per IP+id, per-IP ceiling), lockout, bcrypt cost 12 in a bounded worker pool (queue ≤ 500) | Measured: 12-way login burst → 5.8 logins/s, other requests p50 30 ms, event-loop probe p95 16 ms; no errors |
| Browser | Tokens in memory (+ sessionStorage handoff on reload only); no `dangerouslySetInnerHTML`; CSP with `frame-ancestors 'none'`; bearer auth → CSRF not applicable; **0 source maps, no secret values in bundles** | PASS |
| Secrets in git | `git ls-files` in all three repos | Only `.env.example` tracked. Untracked secret-bearing local file noted (K15). No credential exposure found. |
| Dependencies | `npm audit` | 0 production advisories; 9 dev-only (one `braces` advisory, no patched release) — K13 |

## 4. Data integrity, database resilience, migrations

- Payments, approvals with money effects, admissions, staff logins and onboarding now commit
  atomically on a replica set; a **process killed mid-workflow leaves nothing behind** and the
  retry applies exactly once (DATA_INTEGRITY_TESTS.md). On standalone the same crash reproduced
  a balance change without a payment, so production now refuses standalone MongoDB by default.
- Database outage: readiness 503 within milliseconds, liveness stays 200, writes fail with a
  clean 503 after ~10 s, automatic recovery 8 s after MongoDB returns; acknowledged writes now
  survive an abrupt MongoDB stop (they did not before) — DATABASE_FAILURE_TESTS.md.
- `migrate:2026-10` and the rewritten `db:indexes` verified on legacy-shaped data including a
  hard kill and a database shutdown mid-migration; financial and personal collections
  byte-identical afterwards — MIGRATION_VERIFICATION.md.

## 5. Backup and disaster recovery

Implemented and executed end to end on staging: owner-only backup API + console page,
snapshot-consistent encrypted full backups (AES-256-GCM, authenticated), read-back verification
before "completed", retention that never removes the newest verified backup, single-use 2-minute
download links after password re-entry, `.sha256` + manifest for Windows checks, offline
`backup:verify` / `backup:restore` with mandatory empty target and typed confirmation, and
post-restore recomputation of counts, indexes, per-school financial totals, roles, guardian links
and file checksums. Restore onto a separate empty MongoDB instance: **RESULT: PASS (15.8 s)**; the
API on the restored data served all roles with balances identical to backup time. Full matrix:
BACKUP_RESTORE_TEST_RESULTS.md (30 PASS, 2 NOT RUN, 1 BLOCKED, 1 N/A). Incremental backups were
deliberately not built (unreliable without oplog-based PITR; BACKUP_RESTORE.md §8).

## 6. Performance (staging, measured; one machine for API, MongoDB and load generator)

| Phase | Requests | Throughput | Errors | p50 / p95 / p99 ms | API CPU | Peak RSS |
|---|---|---|---|---|---|---|
| Baseline: 3 readers (`GET /students`) | 1,864 | 125 req/s | 0 | 18 / 28 / 351 | 105 % of 1 core | 349 MB |
| — event-loop probe (`/health`) | 3,092 | | 0 | 4 / 6 / 8 | | |
| Login burst: 12 concurrent logins (cost 12) | 94 | 5.8 logins/s | 0 | 2040 / 2653 / 2713 | 450 % (worker threads) | 389 MB |
| — readers during the burst | 986 | 61 req/s | 0 | 30 / 54 / 637 | | |
| — event-loop probe during the burst | 1,645 | | 0 | 5 / 16 / 22 | | |
| Mixed reads, 10 VUs (search, invoices, dashboard, outstanding, teacher homework, parent) | 2,687 | 134 req/s | 0 | 60 / 90 / 411 | 96 % | 438 MB |
| Mixed reads, 30 VUs | 2,914 | 144 req/s | 0 | 175 / 446 / 532 | 96 % | 444 MB |

One API process saturates one core at ~140 req/s; beyond that latency grows (queueing) with no
errors. Backups of this data size took 0.9–1.8 s. AI provider set to `none`: AI endpoints return
a controlled 503 and every non-AI workflow passed e2e (AI outage isolation). Not measured: slow AI
provider, export memory on large schools, backup resource use on large data, multi-tenant
resource exhaustion.

## 7. Project cleanup

Inspected all three repositories for demo, seed, mock, Postman, debug, generated and dead files.

| Item | Decision | Reason |
|---|---|---|
| `scripts/seed.ts`, `scripts/demo-memory.ts` | **Kept** | Both Playwright suites, `seed.test.ts` and the load test depend on them; seed refuses production without an explicit flag. |
| `docs/postman/*`, `scripts/generate-postman.ts`, `docs/POSTMAN.md` | **Kept, regenerated** | Generated from the OpenAPI spec, current (now 293 requests), documented. |
| `scripts/ai-check.ts` | Kept | Documented operator check of AI configuration. |
| `scripts/load-test/*`, `docs/audit/load-test-results.json` | Kept | Performance tooling and its evidence. |
| `docs/openapi.json/.yaml` | Kept, regenerated | Source of both frontends' typed API clients. |
| Migrations, lockfiles, tests, audit reports | Kept | Required for maintenance and recovery. |
| No demo-only routes or screens found in either frontend | — | — |
| Removed (git-ignored, regenerable local artifacts only) | `storage-test/` (test output), both apps' `test-results/` and `.next-verify/` (verification builds) | No tracked file deleted. |
| `school-os-backend/.env.backup-before-ai` | **Not deleted** (your file; contains secrets) | Flagged K15. |

After cleanup: builds, type checks, lint, unit tests and the endpoint-inventory check were re-run (§2).

## 8. Files changed

BE: `src/database/transactions.ts` (new), `connection.ts` (write concern, autoCreate, topology),
`middleware/error-handler.ts` (503 classification), `middleware/platform-network.ts` (new),
`middleware/rate-limit.ts`, `services/write-freeze.ts` (new), `services/storage.ts`,
`modules/backups/*` (new: model, service, routes, archive, tar, crypto, restore),
`modules/fees|approvals|students|users|employees|schools|platform-admin` (atomic workflows),
`modules/auth/password-hasher.ts`, `modules/automations/scheduler.ts`, `config/env.ts`,
`server.ts`, `app.ts`, `utils/api.ts`; scripts `backup-tool.ts`, `endpoint-inventory.ts` (new),
`sync-indexes.ts` (rewritten), `seed.ts`, `create-platform-owner.ts`; tests (6 new files +
fault harness + replica-set project); docs as linked. AP: Backups page, navigation, queries,
regenerated API types, unit + e2e tests, lifecycle e2e fix. FE: one stale e2e assertion.

## 9. Decision

**B. SUPERVISED PILOT ONLY.**

No known critical security or data-integrity defect remains in the code, and backup → download →
restore was proven on a production-like replica-set environment. It is not "ready for production
deployment" because:

1. The Linux deployment has not been executed (K2) — required before the pilot itself.
2. Platform administrators have no MFA; the console/platform API must stay LAN/VPN-only (K1).
3. A restore drill has not been performed with **your** data on **your** server.
4. Load figures are from a developer machine; messaging has no outbox; recovery point is 24 h.

**Can it be deployed to your server now without risking important existing data?** The code
protects existing data (dry-run-first migrations, create-before-drop indexes, refusing restores
into non-empty targets, transactions). The remaining risk is operational: deploy only after
(a) rehearsing docs/DEPLOYMENT.md on a spare machine, (b) running MongoDB as a replica set, and
(c) downloading and verifying a backup of any existing data first. Do not point the new
deployment at the existing Atlas database until a backup of it has been taken and restore-tested.
