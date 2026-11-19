# Backup and restore — test results

Date: 17 Oct 2026. Procedure under test: [`docs/BACKUP_RESTORE.md`](../BACKUP_RESTORE.md).

## Environments

- **Automated:** `tests/backups.test.ts` (standalone MongoDB → write-freeze mode) and the
  snapshot test in `tests/data-integrity.replset.test.ts` (replica set → snapshot mode).
- **Staging (manual, executed):** Windows 11; compiled API (`dist/server.js`, `NODE_ENV=production`)
  on MongoDB 8.2.6 replica set `rs0` (port 27117, on disk) with the seeded school plus 6 uploaded
  private files. The "new server" was a **second, empty MongoDB instance** (replica set `rs1`,
  port 27118, separate data folder) and an empty storage folder. Downloads went into a
  `SchoolOS-Backups\full|manifests|checksums|restore-guides` folder as documented.
- Not executed: restore on a real clean Ubuntu machine (see LINUX_DEPLOYMENT_TEST_RESULTS.md).

## Results

| # | Check | Expected | Observed | Status |
|---|---|---|---|---|
| 1 | Unauthenticated / school Admin / parent / non-owner platform admin call backup endpoints | 401 / 401 / 401 / 403 | As expected | PASS |
| 2 | Manipulated id (`..%2F..%2Fetc`) / unknown id | 400 / 404, no file access | As expected | PASS |
| 3 | Create backup on staging (replica set) | Snapshot-consistent, verified | `completed`, consistency `snapshot`, 45 collections, 2,758 documents; **1.8 s**, archive 64.6 KB | PASS |
| 4 | Create backup with files | Files included | 6 files (12.2 KB) included; **0.9 s**, archive 71.3 KB | PASS |
| 5 | Backup while writes continue (replica set) | API keeps accepting writes | POST during the backup → 201 | PASS |
| 6 | Backup on standalone | Writes paused briefly, reads continue | Writes → 503 `MAINTENANCE` + `Retry-After: 30`, reads 200, writes resume after | PASS |
| 7 | Second backup while one runs | Refused | 409 `BACKUP_IN_PROGRESS` | PASS |
| 8 | Download needs the password again | Wrong password refused and audited | 403 `REAUTH_FAILED`; `platform.backup.download_denied` logged | PASS |
| 9 | Single-use download link | Second use refused | 1st 200 (71,284 bytes), 2nd **410** | PASS |
| 10 | Link after access revoked (session generation changed) | Refused | 403 | PASS |
| 11 | Windows check of the download (`Get-FileHash` vs `.sha256` file) | OK | **OK** | PASS |
| 12 | Offline verify (`npm run backup:verify`, key from a file) | All entries checked | checksum PASS, decryption/authentication PASS, 52 entries PASS → **RESULT: PASS** | PASS |
| 13 | Restore dry run into the empty instance | Verifies, writes nothing | RESULT: PASS (0.9 s) | PASS |
| 14 | Restore with wrong `--confirm-target` | Refused before reading | RESULT: FAIL, nothing written | PASS |
| 15 | **Restore into the clean instance** | All post-restore checks pass | **RESULT: PASS in 15.8 s**: 45 collection counts, all indexes, per-school invoice total/paid/balance/waiver and payment count/amount, accounts per role, 98/98 guardian links, 6 files vs manifest **and** upload checksums | PASS |
| 16 | Restore again into the now non-empty database | Refused | "school_os already contains data" | PASS |
| 17 | `db:indexes` on the restored database | Only non-backed-up collections pending | 9 indexes for `refreshtokens`, `backupjobs`, `backupdownloadtokens`; after `--apply`: in sync | PASS |
| 18 | `migrate:2026-10` dry run on the restored database | Nothing to do | No duplicates, 0 homework to fix | PASS |
| 19 | API started on the restored database with **new** JWT secrets | Ready; users sign in; old sessions rejected | Ready; owner, accountant, teacher, parent and platform owner signed in; old token → 401 | PASS |
| 20 | Financial balances after restore | Equal to backup time | Outstanding Rs 715,548 and 213 payments = manifest; invoice `paid` = Σ valid payments = 1,930,363 | PASS |
| 21 | Private file after restore | Same bytes | Download byte-identical to the uploaded file | PASS |
| 22 | Parent scope after restore | Own children only | 1 of 98 students visible; other student 404 | PASS |
| 23 | Byte-for-byte equality (automated) | Identical documents | invoices, payments, users, students, parents, schools, fileobjects identical (EJSON); same index names | PASS |
| 24 | Corrupted archive (one byte flipped) | Rejected, nothing restored | Checksum FAIL; without manifest, GCM authentication FAIL; target DB has 0 collections, storage folder not created | PASS |
| 25 | Truncated archive / wrong key | Rejected | Both FAIL | PASS |
| 26 | Missing referenced file at backup time | Backup fails, never "completed" | `failed` ("missing from storage"), no archive left, download link 409 | PASS |
| 27 | Process killed during a backup | Marked failed at next start, partial removed | `failed` "Interrupted…", `.partial` deleted, lock released, next backup completes | PASS |
| 28 | Archive extraction safety | `..`, absolute, drive, backslash paths, symlinks, hard links, duplicates, truncation rejected | All rejected (unit tests) | PASS |
| 29 | Deleting the only verified backup | Refused | 409 `LAST_VERIFIED_BACKUP`; deletion requires password | PASS |
| 30 | No secrets in job records / manifests / archive plaintext | — | Key absent from job and manifest; no password hashes in job; archive contains no plaintext school code | PASS |
| 31 | Admin panel end-to-end (Playwright, staging) | Create → Verified → download archive, manifest, checksum; checksums agree | PASS (after fix B1) | PASS |
| 32 | Backup audit trail | Requested, link created, downloaded, denied, deleted | All present | PASS |
| 33 | Disk-full during backup | Fails cleanly | Free-space pre-check implemented; an actual full disk was not simulated | NOT RUN |
| 34 | Scheduled backups (`BACKUP_SCHEDULE_ENABLED`) | One per interval | Logic implemented; not run for 24 h | NOT RUN |
| 35 | Restore on Ubuntu | — | No Linux machine | BLOCKED |
| 36 | Incremental backups | — | Not implemented on purpose (BACKUP_RESTORE.md §8) | NOT APPLICABLE |

## Measurements (staging, this data size)

| | Value |
|---|---|
| Backup duration (2,758 documents, 6 files) | 0.9–1.8 s |
| Archive size | 71 KB (encrypted, gzip) |
| Offline verify | < 1 s |
| Restore incl. all checks | 15.8 s |
| Recovery point | Time of the last downloaded backup (24 h with the daily schedule) |

These are small-data figures; time grows roughly linearly with data and file size. Snapshot
mode needs the backup's database read to finish within MongoDB's snapshot window (300 s by
default); larger deployments should use `BACKUP_CONSISTENCY=freeze` at night or raise
`minSnapshotHistoryWindowInSeconds`.

## Defect found during testing

| ID | Finding | Fix |
|---|---|---|
| B1 | Admin panel download dialog: the Manifest/Checksum buttons submitted the dialog's form and closed it, so the checksum file could not be saved. | `type="button"`; Playwright test now saves all three files and compares SHA-256s. |
