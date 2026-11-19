# Security audit report

> **Superseded in part (17 Oct 2026):** see [FINAL_STAGING_VERIFICATION.md](FINAL_STAGING_VERIFICATION.md) for the current results and decision. This report is kept as the 14 Oct baseline.

Scope: `school-os-backend`, `school-management-software-frontend`, `school-os-admin-panel`, as of 14 Oct 2026. Method: source review of authentication, authorisation, tenant isolation, validation and the new account/permission features; automated tests for every confirmed finding; dependency audit. No external penetration test was performed.

## Confirmed findings and status

See REMEDIATION_LOG.md for root cause, fix and test of each.

| ID | Severity | Finding | Status |
|---|---|---|---|
| R1 | High | Teachers could read all students of the school (list, detail, overview, AI search). | Fixed + tested |
| R2 | High | Teachers could view and grade other subjects’ homework in a shared section. | Fixed + tested |
| R3 | High | Teacher workloads exposed to parents/students; teachers could read any timetable. | Fixed + tested |
| R4 | Medium | Fee balances exposed through student overview to non-fee roles. | Fixed + tested |
| R7 | Medium | Login hashing blocked the event loop (cheap DoS through login bursts). | Fixed + measured |
| R9 | Medium | Auth limiter could be bypassed by rotating identifiers. | Fixed (per-IP ceiling) |
| R10 | Low | CSV exports without an export permission. | Fixed + tested |
| R11 | Low | Swagger on by default in production; silent `TRUST_PROXY` misconfiguration. | Fixed + verified |
| R15 | Medium | No safe recovery for a school’s only Admin. | Fixed + e2e |

No cross-tenant read or write was found; the existing tenant guard (queries without `schoolId` throw) and isolation tests held, and all new collections use it.

## Controls reviewed (and how)

| Area | Observation | Evidence |
|---|---|---|
| Passwords | bcrypt cost 12, timing-equalised for unknown accounts, now in worker threads; temp passwords and link tokens are never stored readable (SHA-256 of 256-bit tokens). | `password-hasher.test.ts`, `accounts-roles.test.ts` |
| JWT | HS256 pinned, issuer/audience checked, separate secrets for school vs platform, `tokenVersion` revocation on role/status/password change. | `auth.test.ts`, `auth-edge.test.ts` |
| Refresh tokens | Rotation with family revocation on reuse; refused after suspension/disable. | `auth.test.ts`, `auth-edge.test.ts` |
| Account lifecycle | `pending / active / suspended / disabled`; blocked states end sessions immediately; leavers auto-disabled; activation/reset links single-use, expiring (7 d / 48 h), rotating, token only in URL fragment (never sent to servers or Referer), removed from the address bar. | tests + e2e |
| Privilege escalation | Role grants enforced server-side; nobody can change their own role/status/permissions; custom roles only for `staff` accounts; `roles:manage` is never delegable; only the Admin assigns custom roles. | `accounts-roles.test.ts` |
| Permission changes | Re-read on every request → immediate effect. | test "applies permission changes … immediately" |
| Teacher scope | One service (`access.service.ts`) used by students, homework, attendance, exams, timetable, files, AI tools; filters applied in `$and` so caller filters cannot widen them; out-of-scope ids return 404. | `teacher-access-homework.test.ts` |
| Substitute access | Date-bounded in school time zone, capability-scoped, never modifies the original assignment, overlap refused, cancel/expiry immediate, actions audited with `viaSubstitute`. | same file |
| Validation | Zod on every route body/query/params; operator injection rejected; body size limit; regex search escaped and capped; pagination capped at 100. | `validation-errors.test.ts`, `auth-edge.test.ts` |
| Duplicate accounts | Pre-check + unique partial indexes on `(schoolId, employeeId/parentId/studentId)`. | concurrency test |
| Multi-step writes | Compensating rollback (standalone MongoDB has no transactions). | rollback test; KNOWN_ISSUES K3 |
| Secrets | Values were never printed. Only the school app is a git repository and it tracks no `.env` file. The backend and admin panel are not repositories yet; their `.gitignore` (`.env.*` / `.env*`) would also exclude `.env.example` — add `!.env.example` when initialising them. Frontend env files hold only public URLs. | manual review |
| Dependencies | 0 production vulnerabilities in all three projects; 9 dev-only highs in frontend tooling. | `npm audit` |
| Frontend | Tokens never in URLs; downloads via blob URLs; permission-based navigation mirrors server, server enforces. | review, e2e |

## Residual risks

See KNOWN_ISSUES.md (no MFA for platform admins, in-memory rate limits, no transactions, links delivered by hand, no self-service password reset, e2e/backup not run against production-like infrastructure).
