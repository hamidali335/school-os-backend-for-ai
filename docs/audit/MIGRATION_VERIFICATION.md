# Migration verification — `migrate:2026-10` and `db:indexes`

Date: 17 Oct 2026. Environment: Windows 11 staging, MongoDB 8.2.6 **single-node replica set**
(separate instance on port 27118, on-disk), backend at the working tree of this verification,
`NODE_ENV=production`, run from a folder without `.env`. No production or developer database was used.

## Dataset (representative legacy data)

The seeded staging school (1 school, 2 campuses, 98 students with 98 parents, 16 staff, 294
invoices, 213 payments, 1,470 attendance records, 120 marks, 230 audit entries, 6 private files)
was backed up, **restored into a new database `school_os_legacy`**, and converted to the shape of
the previous release:

| Legacy condition | How it was created |
|---|---|
| Old plain unique index `users.schoolId_1_email_1`; none of the new partial unique indexes | all `users` indexes dropped, old one created |
| Duplicate login for one parent (two `users` with the same `parentId`) | inserted |
| 3,000 homework without a teacher (the "Teacher: —" bug); 300 of them for a subject with no teaching assignment | inserted from real sections / teaching assignments |
| Collections added by the 2026-10 release absent (`staffroles`, `accounttokens`, `substituteassignments`, `onboardingstates`) | dropped |

Before each step a fingerprint was recorded: per collection the document count, a SHA-256 of all
documents, and the index list (`unique`/`partial` flags).

## Results

| # | Step | Expected | Observed | Status |
|---|---|---|---|---|
| 1 | `npm run migrate:2026-10` (dry run) | Reports duplicates and unattributed homework; changes nothing | Reported `DUPLICATE parentId … users=…,…`, "Homework without a teacher: 3000; can be attributed: 2700". Fingerprint **identical** (no data, collection or index change) | PASS (after fix F2) |
| 2 | `npm run db:indexes` (report) | Lists changes, changes nothing | 30 pending changes incl. `CREATE school_parent_login_unique` and `OBSOLETE schoolId_1_email_1`; exit code 2; fingerprint identical | PASS (after fix F1) |
| 3 | `db:indexes -- --apply` with the duplicate still present | Builds what it can, stops at the blocked unique index, **drops nothing** | Created 12 indexes, then "could NOT create school_parent_login_unique … E11000 … Stopped. No index was dropped."; exit 1; old `schoolId_1_email_1` still present | PASS (after fix F1) |
| 4 | Resolve the duplicate (disable the extra login, detach it) | — | 1 user updated | — |
| 5 | `migrate:2026-10 -- --apply`, process **hard-killed** after 300 updates | Partial progress, no corruption | 303 attributed, 2,697 without teacher | PASS |
| 6 | Re-run `--apply`; **MongoDB shut down** after 1,000 updates | Script fails with an error, no corruption | Exit 1 after 9.8 s (`MongoServerSelectionError`); 1,001 attributed | PASS |
| 7 | MongoDB restarted on the same data; re-run `--apply` | Completes the rest only | "Homework without a teacher: 1996; attributable 1696; updated 1696" | PASS |
| 8 | Re-run `--apply` again (idempotency) | Nothing to do | "Homework without a teacher: 300; attributable 0; updated 0" | PASS |
| 9 | Totals after interruption + outage + 2 re-runs | Each attributable homework updated exactly once | 2,700 `teacherSource: backfill`, 300 left unattributed (no assignment exists), 0 duplicates | PASS |
| 10 | `db:indexes -- --apply` | All new indexes created; reports the obsolete one | `school_parent_login_unique` and the rest created; "1 index(es) to replace or drop" | PASS |
| 11 | `db:indexes -- --apply --drop-obsolete` | Drops `schoolId_1_email_1` | "dropped obsolete schoolId_1_email_1. Indexes are in sync." | PASS |
| 12 | `db:indexes` (report) | In sync | "All indexes are in sync.", exit 0 | PASS |
| 13 | Data preserved | Only intended changes | **Byte-identical**: invoices, payments, students, parents, employees, attendance, marks, exams, exam papers, fee heads/structures, schools, counters, audit log (39 collections unchanged). Changed: `users` (the resolved duplicate + indexes), `homeworks` (attribution). User count 9 → 9. New empty collections created by index creation. | PASS |
| 14 | Index snapshots | Saved before every change | `BACKUP_DIR/index-snapshot-<time>.json` written on each run | PASS |

## Defects found and fixed

| ID | Finding | Fix | Evidence |
|---|---|---|---|
| F1 | `npm run db:indexes` called Mongoose `syncIndexes()` for every model: it **drops** every index a model does not declare (including indexes an operator added) *before* building new ones. If a new unique index then failed (duplicates), the old uniqueness constraint was already gone. There was no dry run. | Rewritten (`scripts/sync-indexes.ts`): report by default; `--apply` creates first and stops without dropping on any failure; drops/replacements only with `--drop-obsolete`, restoring the old definition if a replacement fails; index snapshot written first. | Steps 2, 3, 10–12 |
| F2 | Report-only runs were not side-effect free: Mongoose `autoCreate` created 7 empty collections when a script merely connected. | `autoCreate` disabled in production (like `autoIndex`); MongoDB creates collections on first write. | Step 1 fingerprint identical; before the fix 42 → 49 collections |
| F3 | `npm run seed` and `npm run create-platform-owner` finished their work but never exited (password worker threads kept the process alive under `tsx`). | Scripts close the hashing pool after disconnecting. | Both exit 0 on staging |

## Not covered

- Other migrations (`migrate:plan-entitlements`, `migrate:retire-student-logins`) were not re-run
  on legacy data in this verification (they have their own automated tests; dry-run first).
- A migration interrupted on a **standalone** server (only the replica set was used here; the
  homework update is per-document and idempotent, so the result would be the same).
- Real production data volumes.
