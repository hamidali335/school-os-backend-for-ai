# Test results

> **Superseded in part (17 Oct 2026):** see [FINAL_STAGING_VERIFICATION.md](FINAL_STAGING_VERIFICATION.md) for the current results and decision. This report is kept as the 14 Oct baseline.

All commands were run on 14 Oct 2026 on the development machine (Windows 11, Node 22.23.3). Results are as observed; nothing was skipped silently.

## Summary

| Project | Check | Command | Result |
|---|---|---|---|
| Backend | Type check | `npx tsc --noEmit` | Pass |
| Backend | Format | `npx prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.ts"` | Pass |
| Backend | Unit + API integration (in-memory MongoDB) | `npx vitest run` | **170 / 170 passed**, 18 files (baseline before changes: 114 / 114, 12 files) |
| Backend | Production build | `npm run build` | Pass |
| Backend | Compiled build in production mode | `verify-dist` script (see DEPLOYMENT_VERIFICATION.md) | **11 / 11 checks passed** |
| Backend | Dependency audit | `npm audit` / `npm audit --omit=dev` | 0 vulnerabilities / 0 |
| Backend | Load test | `npm run loadtest` | Completed, 0 errors (PERFORMANCE_REPORT.md) |
| School app | Type check | `npx tsc --noEmit` | Pass |
| School app | Lint | `npx eslint src tests` | Pass (0 problems) |
| School app | Unit | `npx vitest run` | **40 / 40 passed** (5 files) |
| School app | Production build | `next build` | Pass (all routes incl. `/setup`, `/substitutes`, `/activate`) |
| School app | End-to-end (Playwright, desktop + mobile) against the backend in-memory demo | `npx playwright test` | **76 / 76 passed** (fresh demo) |
| School app | Dependency audit | `npm audit --omit=dev` | 0 production vulnerabilities; 9 high in dev tooling (KNOWN_ISSUES K9) |
| Admin panel | Type check / Lint | `npx tsc --noEmit`, `npx eslint src tests` | Pass / Pass |
| Admin panel | Unit | `npx vitest run` | **50 / 50 passed** |
| Admin panel | Production build | `next build` | Pass |
| Admin panel | End-to-end against the demo backend | `npx playwright test` (with `E2E_ALLOW_WRITES=1`) | **23 / 23 passed** |
| Admin panel | Dependency audit | `npm audit --omit=dev` | 0 production vulnerabilities; 9 high in dev tooling |

## New backend test files

| File | What it proves |
|---|---|
| `accounts-roles.test.ts` (16) | Teacher login auto-provisioned as pending; no sign-in before activation; single-use links; hashes only; non-teaching staff no login by default; 5 concurrent provisioning calls → exactly one login; sibling parents share one login; phone sign-in; admission rolled back when a login fails (no orphans); suspend/disable effective immediately; leavers disabled; link rotation; no self-escalation; custom roles enforced server-side; permission changes apply immediately; `roles:manage` not delegable; roles tenant-scoped. |
| `teacher-access-homework.test.ts` (17) | Teacher isolation (students, records by id, fees, attendance, timetable, marks, cross-school); substitute validation, scoped capabilities, audit attribution, no overlap, cancellation/expiry end access, upcoming covers inactive, authorisation; homework attribution scenarios A–D, multiple teachers, legacy records, unauthorised teachers. |
| `datesheet-onboarding.test.ts` (11) | No duplicate papers; clearing values; validation; concurrent-edit detection; marks protected; publish/unpublish workflow + audit; setup guide from real data, not page visits; per-school state; attention state; dismiss/resume; manual steps; Admin-only. |
| `auth-edge.test.ts` (6) | Expired token, wrong secret, wrong audience, `alg: none`, school/platform token separation, refresh after suspension, malformed/oversized bodies, operator injection. |
| `password-hasher.test.ts` (2) | Worker hashes are standard bcrypt and compatible both ways; main thread stays responsive at cost 11. |
| `migration.test.ts` (3) | Dry run changes nothing; apply attributes only what it can; idempotent; duplicate-login report. |
| `approvals-automation.test.ts` (+1) | A school’s broken rule is disabled while another school’s rule still runs. |

## Changes to existing tests (behaviour changed on purpose)

- Fixture: teachers and the first parent now sign in by redeeming the activation link created automatically (previously the test created a second, manual login).
- In-app announcement count: every parent now has an app account after admission (3 instead of 1).
- Student homework test: activates the student login created at admission.
- School app e2e: enrolment and “add staff” now confirm the one-time activation-link screen before continuing; “create a parent login” now asserts the duplicate is refused; the a11y scan of ~20 screens got a 3-minute budget (it timed out at 60 s, it did not fail).
- Admin e2e: onboarding uses the new default (activation link) and reissues a School Admin link.

## Not run

- Backup/restore (KNOWN_ISSUES K12). Graceful `SIGTERM` shutdown on Linux (Windows cannot deliver POSIX signals to Node; code path reviewed).
