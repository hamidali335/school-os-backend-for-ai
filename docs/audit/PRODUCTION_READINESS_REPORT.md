# Production readiness report

> **Superseded in part (17 Oct 2026):** see [FINAL_STAGING_VERIFICATION.md](FINAL_STAGING_VERIFICATION.md) for the current results and decision. This report is kept as the 14 Oct baseline.

Date: 14 Oct 2026. Projects: `school-os-backend`, `school-management-software-frontend` (school app), `school-os-admin-panel`.

**Verdict: suitable for a supervised pilot on a single API instance after the upgrade steps in `docs/DEPLOYMENT.md` and the open items marked "Not verified" below. Not yet verified for multi-instance scale or against production infrastructure.** Passing tests do not prove the absence of defects.

## 1. Status

| Area | Status | Evidence |
|---|---|---|
| Authentication | Pass | `auth.test.ts`, `auth-edge.test.ts`, `accounts-roles.test.ts`; expired/forged/wrong-audience tokens, refresh reuse, suspension, activation links |
| Authorization | Pass | Custom roles enforced server-side, no self-escalation, export permission, teacher isolation suite; 3 High findings fixed (R1–R3) |
| Tenant isolation | Pass | Existing `tenant-isolation.test.ts` (unchanged, passing) + cross-school tests on roles, links, substitutes, employees |
| Input validation | Pass | Zod on all routes; `validation-errors.test.ts`, injection/oversize tests; date-sheet and homework validation |
| Financial integrity | Pass (existing) | `fees.test.ts`: idempotency key replay, concurrent payments never over-settle, overpayment rejected, waiver approval by another person. Not changed in this release. |
| AI failure isolation | Pass (existing) | `ai.test.ts`: provider missing/unavailable returns explicit statuses; core modules do not depend on AI |
| Messaging reliability | Pass (existing) | `approvals-automation.test.ts`: `not_configured` reported honestly, approvals gate bulk sends |
| Database resilience | Not verified | Readiness probe returns 503 when the DB ping fails (code reviewed; `auth.test.ts` covers the healthy case only). Outage/failover behaviour not exercised. |
| Frontend resilience | Pass | Error states per panel; 76/76 e2e incl. WCAG scan; duplicate-submit guarded (pending states) |
| Performance | Pass (baseline only) | PERFORMANCE_REPORT.md: 0 errors to 50 VUs, ~140 req/s per process, login no longer blocks the event loop |
| Production build | Pass | `tsc` build + 11/11 compiled production checks; both `next build` |
| Deployment | Not verified | Service/proxy/TLS on Linux not exercised here; upgrade + rollback documented |
| Backup and restore | Not verified | Procedure documented; no restore executed |

## 2. What changed (feature work)

1. **Setup guide** (`/setup`, dashboard card, empty-state hints): 12 steps in dependency order (profile → session → classes → sections → subjects → staff → teacher assignments → timetable* → fees* → students → account links* → module review*; * optional). Status computed from real data on every request, so work done anywhere counts and visiting a page never ticks a step. Persisted per school: first-completion time, minimised/closed state, manual confirmations. Steps whose data later disappears show "Needs attention"; dependent steps show "blocked".
2. **"Admin" terminology**: the school-level `school_owner` role is shown as **Admin** in both frontends (API key unchanged for data compatibility); `school_admin` is shown as **Office Administrator**.
3. **Accounts**: statuses `pending / active / suspended / disabled`; one creation path (`createUser`) for manual, staff and admission provisioning. Teachers get a login on registration; non-teaching staff only on request (role or custom role); students and parents on admission (school setting, default on); siblings’ parent shares one login; sign-in by email or username (parent phone, student admission no, employee no). Single-use activation and reset links; temporary passwords still available. Platform can onboard a school with an Admin activation link and recover a school’s Admin.
4. **Roles & permissions**: custom staff roles (`staff` base role) with a module × action permission screen, least-privilege default, Admin-only `roles:manage`, immediate effect, audited grants/revocations; new permissions `roles:manage`, `students:export`, `fees:export`, `reports:export`, `substitutes:manage`, `onboarding:manage`.
5. **Teacher isolation** across students, homework, attendance, marks, results, timetable, files, dashboard and AI tools (one access service; 404 for out-of-scope ids).
6. **Substitute teachers** (`/substitutes`): absent teacher, section, optional subject, date range, periods note, capabilities (attendance / homework / marks); validated (same school, active teaching staff, original actually teaches it, ≤ 62 days, no overlap); expires by date automatically; cancel ends access at once; original assignment untouched; audit trail.
7. **Homework teacher bug** fixed — see docs/HOMEWORK_TEACHER_RULES.md.
8. **Date-sheet editor** rebuilt and backend hardened — see REMEDIATION_LOG R6.

## 3. Database changes

New collections: `staffroles`, `accounttokens` (TTL index), `substituteassignments`, `onboardingstates`. Changed: `users` (optional email, `username`, `customRoleId`, statuses, partial unique indexes replacing `schoolId_1_email_1`, one login per staff/parent/student), `homework` (`teacherSource`, `createdViaSubstituteId`, index), `exams` (`datesheetVersion`), `schools.settings.accounts`. Migration: `npm run migrate:2026-10` (dry run by default) then `npm run db:indexes`. Existing data is preserved; existing users stay `active`.

## 4. Required before go-live

1. Follow the upgrade procedure in `docs/DEPLOYMENT.md` (backup first).
2. Set `NEXT_PUBLIC_SCHOOL_APP_URL` for the admin panel; `TRUST_PROXY=1` behind nginx.
3. Execute a test restore (K12) and run both e2e suites against staging (K10, K11).
4. Decide on platform-admin MFA or put the admin panel behind SSO/VPN (K1).
