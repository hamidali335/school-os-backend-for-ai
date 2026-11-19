# Remediation log

Audit and implementation date: 14 Oct 2026. Every row is a confirmed defect found by reading the code or measuring, fixed in this change, with the test that proves it. "BE" = `school-os-backend`, "FE" = `school-management-software-frontend`, "AP" = `school-os-admin-panel`.

| ID | Sev. | Project | Finding (root cause) | Fix | Verified by |
|---|---|---|---|---|---|
| R1 | High | BE | **Teachers could list and open every student in the school.** `listStudents`/`getStudent`, `/students/:id/overview` and the AI `search_students` tool restricted only parents/students; teachers were treated like admins. | Central `academics/access.service.ts`: `studentVisibilityFilter` + teacher-aware `assertStudentVisible`, applied in an `$and` so query filters can only narrow it. | `teacher-access-homework.test.ts` › "lists only students of the teacher’s own sections…", "hides students … by id (404)" |
| R2 | High | BE | **Any teacher of a section could see the submission roster of, and grade, another subject’s homework** (`assertSectionAccess` instead of subject check). Teachers also saw all homework of every section they touched. | Homework list filtered by (section, subject) grants; roster/grade/edit/delete require `assertSubjectAccess(…, 'homework')`. | "lets only teachers of that class-subject see or grade it" |
| R3 | High | BE | **Teacher-load report (every teacher’s workload) readable by parents and students**; teachers could read any section’s or teacher’s timetable. | `teacher-load` limited to admin roles; teachers limited to own timetable/sections. | "blocks attendance, timetable and marks for unassigned sections" |
| R4 | Medium | BE | **Student overview returned fee balances to anyone with `students:read`** (e.g. teachers). | Fees block only with `fees:read`. | "does not show fee balances to teachers" |
| R5 | High (bug) | BE+FE | **Homework “Teacher: —” never resolved.** `POST /homework` stored `teacherId = ctx.employeeId`; an Admin has none, so the field stayed empty forever and assigning a teacher later changed nothing. | Attribution rules (`homework-teacher.ts`): creator / explicit (validated) / subject teacher / refuse with `TEACHER_NOT_ASSIGNED` unless explicitly unassigned; backfill when a teacher is assigned; historical attribution kept; API returns `teacher`, `teacherStatus`, `currentSubjectTeacher`; UI preview and choices. Migration backfills old rows. | "Homework teacher attribution" suite (A–D, multiple teachers, legacy rows), `migration.test.ts` |
| R6 | Medium (data loss) | FE+BE | **Date-sheet editor could delete papers silently**: rows were built only from subjects currently linked to the class, so an existing paper for an unlinked subject was omitted and deleted on save. Clearing a date/time/duration never persisted (`$set` with `undefined`). Papers with marks were “kept” silently while the UI said saved. Published exams opened the editor and then failed with a bare 409. | Editor always includes existing papers, locks papers with marks, confirms removals, uses date/time pickers with readable previews and per-field validation; backend refuses (`PAPER_HAS_MARKS`, `MAX_BELOW_ENTERED_MARKS`), clears with `$unset`, validates dates against the exam window, optimistic concurrency (`STALE_DATE_SHEET`), detailed audit; published exams explain and offer withdraw → edit → republish. | "Exam date sheet editing" suite (7 tests) |
| R7 | Medium | BE | **bcrypt (pure JS, cost 12) blocked the event loop**: measured ~808 ms p99 event-loop delay with 5 concurrent logins, stalling every other request. | Worker-thread pool for hashing/compare (same hash format, no new dependency). Re-measured: ~40 ms p99. | `password-hasher.test.ts`, load test (PERFORMANCE_REPORT) |
| R8 | Medium | BE | **One school’s malformed automation rule aborted the scheduler tick for all schools** and was retried forever (exception thrown inside `finally`, lock left in place). | `rescheduleOrDisable`: compute next run safely; disable and record a bad rule. | "isolates a school whose rule cannot be scheduled…" |
| R9 | Medium | BE | **Credential stuffing across many emails from one IP** was bounded only by the global limiter (per-email auth limiter can be rotated around). | Added per-IP ceiling on all auth endpoints. | Covered by code review; limiter disabled in tests by design |
| R10 | Low | BE | CSV report exports needed only `reports:read`. | Added `reports:export` (and `students:export`, `fees:export` in the catalogue). | "enforces a custom role on the server" (CSV export 403) |
| R11 | Low | BE | Swagger UI enabled by default in production; `TRUST_PROXY=0` behind a proxy silently merges all users into one rate-limit bucket. | Docs default off in production; startup warnings for risky settings. | `verify-dist` check (Swagger 404, warning logged) |
| R12 | Low | BE | Uncaught exceptions had no controlled shutdown policy. | Log fatal → graceful shutdown → exit 1 for the process manager. | Code review (signals on Windows cannot exercise it) |
| R13 | Low | BE | Exam could be saved with end date before start date. | Validation. | "rejects exam dates where the end comes before the start" |
| R14 | Low (a11y) | FE | New setup-hint links were distinguishable only by colour (found by the axe scan in e2e). | Always underlined. | `a11y.spec.ts` passes |
| R15 | Medium | AP | No way to recover a school whose only Admin lost their password (documented GAP-04; required a server script). | `GET /platform/schools/:id/admins`, `POST …/admins/:userId/access-link` + Users-tab panel; onboarding can issue an activation link instead of a password. | Admin e2e "onboarding wizard … link can be reissued" |

## Feature work (requirements, not defects)

Setup guide, Admin terminology, account lifecycle + activation links, automatic teacher/parent/student provisioning, custom staff roles with permission matrix, teacher isolation across modules, substitute teachers — see PRODUCTION_READINESS_REPORT.md §2.

## Incident during this audit

While checking startup behaviour, a run of `node dist/server.js` inside the backend folder loaded the developer `.env` and started for about two minutes against the local development database `school_os` (scheduler on). No messaging provider is configured there. A read-only check confirmed nothing was written in that window (0 automation runs, notifications, message logs, audit logs, error events). Because it ran in development mode, Mongoose auto-created the **new** indexes and four empty collections in that dev database; the **old** `schoolId_1_email_1` index is still there. Run `npm run db:indexes` against that dev database (the documented upgrade step) to drop it; until then, admitting a second student whose auto-created login has no email fails with a duplicate-key error there.

## Final verification — 17 Oct 2026

Each row was confirmed by reproduction or measurement, fixed, and re-tested. Details and
evidence: DATA_INTEGRITY_TESTS.md, DATABASE_FAILURE_TESTS.md, MIGRATION_VERIFICATION.md,
BACKUP_RESTORE_TEST_RESULTS.md.

| ID | Sev. | Project | Finding (root cause) | Fix | Verified by |
|---|---|---|---|---|---|
| R16 | High | BE | **Payment recording not crash-safe**: balance reduced before the payment was written; a crash in between lost the trail and the retry reduced the balance again. | MongoDB transaction (`database/transactions.ts` `atomic()`), production requires a replica set. | `data-integrity.replset.test.ts` (kill at checkpoint); standalone reproduction in `data-integrity-standalone.test.ts` |
| R17 | High | BE | Same for reversal/waiver/cancel/concession/expense approvals, admissions, staff logins, school onboarding. | Transactions; messaging handlers deliberately excluded (no resend on retry). | Crash tests for reversal, admission, onboarding |
| R18 | High | BE | **Acknowledged writes lost on a MongoDB crash** (default `w:1` without journal on standalone). | Write concern `{ w: 'majority', journal: true }`. | `database-failure.test.ts` (fails 3/3 without the fix, passes 3/3 with it) |
| R19 | High | BE | `db:indexes` (`syncIndexes`) dropped undeclared indexes before creating new ones; a failed unique index left the collection without its old constraint. No dry run. | Rewritten: report by default, create-before-drop, stop on failure, `--drop-obsolete` opt-in, restore on failed replacement, index snapshot. | MIGRATION_VERIFICATION.md steps 2–3, 10–12 |
| R20 | Medium | BE | DB outages returned `500 INTERNAL_ERROR` and were logged as bugs. | `503 SERVICE_UNAVAILABLE` + `Retry-After` for connectivity errors. | `database-failure.test.ts` |
| R21 | Medium | BE | No application backup/restore; documented procedure never executed. | Encrypted, verified, snapshot-consistent backups; owner-only API; single-use step-up download links; offline verify/restore tool with post-restore checks; retention; crash recovery. | `backups.test.ts`, staging restore onto a separate empty instance |
| R22 | Medium | BE | Public certificate verification had only the global limiter (serials enumerable). | `publicLookupLimiter` (60 / 15 min / IP). | Inventory test |
| R23 | Medium | BE | No network restriction possible for the platform API (no MFA). | `PLATFORM_ALLOWED_IPS` guard (404 outside the list, login included). | `security-surface.test.ts` |
| R24 | Low | BE | Report-only runs created empty collections (`autoCreate`). | Off in production. | MIGRATION_VERIFICATION.md step 1 |
| R25 | Low | BE | `seed` / `create-platform-owner` never exited. | Close hashing pool. | Staging |
| R26 | Medium | BE | Introduced during this work and caught by the replica-set suite: parallel queries inside a transaction. | Sequential queries. | `data-integrity.replset.test.ts` |
| R27 | Low | AP | (New page) download dialog buttons submitted the form and closed the dialog. | `type="button"`. | Admin Playwright `backups.spec.ts` |
| R28 | Low | FE, AP (tests) | Stale e2e assertions: announcement toast text; lifecycle plans with an invalid feature key. | Tests updated to current behaviour (app unchanged). | Both suites green on staging |
| R29 | Medium | BE | `.gitignore` rule `backups/` matched any folder of that name, so `src/modules/backups/` (the backup feature) would never have been committed. | Anchored to `/backups/`. | `git status` lists the module |

New regression guards: `security-surface.test.ts` (fails if an unauthenticated route is added or
backup routes lose owner-only protection) and `cross-tenant-probe.test.ts`.
