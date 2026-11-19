# Backup and Restore (disaster recovery)

This is the procedure for getting every school back after the server is lost, damaged or
compromised. Test results: [`docs/audit/BACKUP_RESTORE_TEST_RESULTS.md`](audit/BACKUP_RESTORE_TEST_RESULTS.md).

## 1. What a backup contains

A backup is **one encrypted archive plus its manifest**, created by the API and downloaded from
the admin panel (**Backups** page, platform owner only).

| Included | Where it comes from |
|---|---|
| Every collection of the application database (schools, settings, campuses, users and roles, custom staff roles, parents and parent–child links, students, admissions/inquiries, staff, attendance, timetable, homework and submissions, exams, marks, results, invoices, payments, receipts numbering, fee heads/structures, income/expenses, payslips, approvals, audit log, automations, notifications, messages log, AI settings and usage, plans and subscriptions, onboarding state, account activation tokens) — **including collections no current model declares** | MongoDB, read at one point in time |
| Collection options and **all index definitions** (unique, partial and TTL indexes included) | MongoDB `listIndexes` |
| All private uploaded files (certificates, student and staff documents, homework files and submissions), byte for byte | `STORAGE_DIR` |
| Manifest: backup id, UTC times, format version, app version + git commit, MongoDB version and topology, consistency method, per-collection document counts and SHA-256, per-file size and SHA-256, per-school financial totals, accounts per role, guardian-link count, key id | generated |

| Not included | Why / what to do |
|---|---|
| `refreshtokens` (sessions) | After a disaster everybody signs in again; restoring sessions from a possibly compromised server would keep them alive. |
| Backup job records and download links | They describe archives on the old server. |
| Server secrets: `.env` (JWT secrets, `MONGODB_URI`, `BACKUP_ENCRYPTION_KEY`, SMTP/Twilio/WhatsApp/AI keys) | Secrets never go into a backup. Keep them in your password manager (see §6). |
| TLS certificates, DNS, nginx/systemd config | Re-created by `docs/DEPLOYMENT.md`. |
| `node_modules`, builds, git history | Re-installed from the repositories at the commit recorded in the manifest. |
| Provider-side data (sent SMS/WhatsApp/e-mail, AI provider accounts) | Lives with the provider. |

AI provider keys saved in the panel are stored encrypted with `SETTINGS_ENCRYPTION_KEY` (or a
key derived from `JWT_PLATFORM_SECRET` when it is unset). Restore with the **same** value, or
re-enter the AI keys in Platform → Integrations after the restore.

## 2. How a backup is made (and when it counts as good)

`POST /api/v1/platform/backups` (button **Create backup now**), or automatically every
`BACKUP_INTERVAL_HOURS` when `BACKUP_SCHEDULE_ENABLED=true`. One backup runs at a time.

1. **Consistent point in time.**
   - Replica set / Atlas: all collections are read inside one MongoDB **snapshot** (the cluster
     time is recorded as `snapshotClusterTime`). The API keeps accepting writes.
   - Standalone MongoDB: API **writes are paused** (HTTP 503 `MAINTENANCE`, `Retry-After: 30`)
     while the database is read and the file list is taken — usually seconds; reads keep working
     and the scheduler skips its tick.
   - In both cases files cannot be deleted until the backup ends (deletions are deferred), and
     the backup **fails** if any file the database refers to is missing.
2. Free disk space is checked first (about 1.5 × data size + 512 MB is required).
3. The archive is written as `*.partial`, then **read back from disk, decrypted and every entry
   compared with its checksum**. Only then is it renamed and the job marked **Verified**
   (`completed`). Any error, timeout (`BACKUP_TIMEOUT_MINUTES`) or full disk ends as **Failed**
   with the reason, and the partial file is deleted. A backup interrupted by a server restart is
   marked Failed at the next start.
4. Retention keeps the newest `BACKUP_RETENTION_COUNT` verified backups on the server (default
   14). The newest verified backup is never deleted, automatically or by hand. Copies on your
   computer are never affected.

**Recovery point:** the last backup you downloaded. With daily backups you can lose up to 24
hours of changes. Need less? Lower `BACKUP_INTERVAL_HOURS`, or use MongoDB Atlas continuous
backup (point-in-time) in addition — see §8.

### Format

`school-os-full-<YYYYMMDDTHHMMSSZ>.tar.gz.enc` = AES-256-GCM( gzip( tar ) ):

```
db/<collection>.ejson    one document per line, MongoDB Extended JSON (canonical): ids, dates,
                         decimals and 64-bit numbers round-trip exactly
files/<schoolId>/<category>/<uuid>.<ext>
manifest.json
```

The `.manifest.json` downloaded next to it is the same manifest plus the archive's size and
SHA-256 (so a download can be checked without the key). The archive header names the key id;
decryption is authenticated, so a corrupted or altered archive is rejected, never half-restored.

## 3. Settings (backend `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | — | **Required** to enable backups. 32 random bytes, base64. Generate: `npm run backup:keygen`. |
| `BACKUP_DIR` | `./backups` | Where archives are kept on the server. Not inside `STORAGE_DIR`, never served by nginx, mode 700. |
| `BACKUP_SCHEDULE_ENABLED` | `false` | Automatic backups. |
| `BACKUP_INTERVAL_HOURS` | `24` | Age after which a new scheduled backup starts. |
| `BACKUP_RETENTION_COUNT` | `14` | Verified backups kept on the server. |
| `BACKUP_TIMEOUT_MINUTES` | `60` | A backup running longer fails. |
| `BACKUP_CONSISTENCY` | `auto` | `auto` (snapshot on a replica set, else pause writes), `snapshot` (fail if unavailable), `freeze` (always pause writes). |

## 4. Downloading backups to your Windows computer

The browser asks where to save each file; the server cannot reach your computer.

1. Sign in to the admin panel as the **platform owner** (from the allowed network — see
   `PLATFORM_ALLOWED_IPS` in `docs/DEPLOYMENT.md`).
2. **Backups** → newest row with status **Verified** → **Download**.
3. Enter your password again. You get a single-use link valid for 2 minutes. Save the three files:

```
SchoolOS-Backups\
  full\            school-os-full-20261017T023000Z.tar.gz.enc
  manifests\       school-os-full-20261017T023000Z.manifest.json
  checksums\       school-os-full-20261017T023000Z.tar.gz.enc.sha256
  restore-guides\  a copy of this file (docs/BACKUP_RESTORE.md) and docs/DEPLOYMENT.md
```

4. Check the download (PowerShell, no key needed):

```powershell
cd C:\SchoolOS-Backups
$f = "full\school-os-full-20261017T023000Z.tar.gz.enc"
$expected = (Get-Content "checksums\$(Split-Path $f -Leaf).sha256").Split(" ")[0]
if ((Get-FileHash $f -Algorithm SHA256).Hash -eq $expected) { "OK" } else { "MISMATCH - download again" }
```

5. Full check (decrypts in memory and checks every record and file; writes nothing). Needs
   Node.js 22 and the backend repository on the Windows PC (`npm ci` once):

```powershell
cd C:\path\to\school-os-backend
# The key is read from a file so it never lands in shell history.
npm run backup:verify -- --archive C:\SchoolOS-Backups\full\school-os-full-20261017T023000Z.tar.gz.enc `
  --manifest C:\SchoolOS-Backups\manifests\school-os-full-20261017T023000Z.manifest.json `
  --key-file C:\Secure\school-os-backup.key
```

Copy the folder to a second place too (external drive, or an encrypted cloud folder). Delete old
local copies on your own schedule; the server's retention never touches them.

Automatic daily download to the PC is **not** built in: it would need a separate agent on your
computer holding platform credentials. Ask for it explicitly if you want that trade-off.

## 5. Restoring onto a new, clean server

Never restore over a running production database. The restore tool refuses a database that
already contains data and a storage folder that is not empty, and asks you to type the target
database name. It never runs anything contained in an archive.

1. Provision Ubuntu 24.04 LTS (or 22.04) and follow `docs/DEPLOYMENT.md` §1–§3: Node.js 22,
   MongoDB as a **replica set**, service user `schoolos`, nginx, TLS. Do not start the API yet.
2. Check out the three repositories **at the commit in the manifest** (`app.gitCommit`):
   `git checkout <commit>` (or the release tag), `npm ci`, `npm run build`.
3. Create `/opt/school-os-backend/.env` from your password manager: new or the same JWT
   secrets (new ones sign everyone out, which is fine), `MONGODB_URI` pointing at a **new, empty**
   database, `STORAGE_DIR` pointing at an **empty** folder, the same `BACKUP_ENCRYPTION_KEY` (or
   keep it only in a key file for the restore), `SETTINGS_ENCRYPTION_KEY`/`JWT_PLATFORM_SECRET`
   as before if you want saved AI keys to keep working.
4. Copy the backup from your PC with a secure transfer:
   `scp .\full\school-os-full-....tar.gz.enc .\manifests\school-os-full-....manifest.json schoolos@NEWSERVER:/var/backups/school-os/incoming/`
5. On the server, as `schoolos`, put the key in a file only you can read
   (`install -m 600 /dev/null ~/backup.key && nano ~/backup.key`), then:

```bash
cd /opt/school-os-backend
A=/var/backups/school-os/incoming/school-os-full-20261017T023000Z.tar.gz.enc
M=/var/backups/school-os/incoming/school-os-full-20261017T023000Z.manifest.json
# a) Integrity and authenticity only (writes nothing):
npm run backup:verify -- --archive "$A" --manifest "$M" --key-file ~/backup.key
# b) Dry run of the restore (checks target is empty, verifies, restores nothing):
RESTORE_TARGET_URI='mongodb://schoolos:PASS@127.0.0.1:27017/school_os?replicaSet=rs0&authSource=admin' \
npm run backup:restore -- --archive "$A" --manifest "$M" --key-file ~/backup.key \
  --confirm-target school_os --storage-dir /var/lib/school-os/storage --dry-run
# c) The restore (same command without --dry-run). Keep the report:
RESTORE_TARGET_URI='...same...' npm run backup:restore -- --archive "$A" --manifest "$M" \
  --key-file ~/backup.key --confirm-target school_os --storage-dir /var/lib/school-os/storage \
  --report ~/restore-report.json
```

   The restore prints `PASS`/`FAIL` per check and ends with `RESULT: PASS` only if all of these
   hold, recomputed from the restored database: document count of every collection, every index,
   per-school invoice total/paid/balance/waiver and payment count/amount, accounts per role,
   parent–child links, and every file present with its manifest checksum **and** the checksum
   recorded at upload time.

6. Indexes and migrations: the restore recreated every backed-up index. `npm run db:indexes`
   then lists only the indexes of the collections that are never backed up (`refreshtokens`,
   `backupjobs`, `backupdownloadtokens`); create them with `npm run db:indexes -- --apply`, after
   which it reports "All indexes are in sync". Run only the migrations newer than the backed-up
   version, dry run first (`npm run migrate:2026-10` is idempotent and changes nothing without `--apply`).
7. Ownership: `sudo chown -R schoolos:schoolos /var/lib/school-os && sudo chmod -R go-rwx /var/lib/school-os`.
8. Start: `sudo systemctl start school-os`, then `curl -fsS http://127.0.0.1:4000/health/ready`.
   Start the two frontends (`docs/DEPLOYMENT.md` §4).
9. Verify by hand (record the results):
   - Platform owner signs in to the admin panel; schools and their statuses are listed.
   - A School Admin, a teacher and a parent sign in. The parent sees only their own children.
   - Fees → outstanding totals and a known receipt match what you expect.
   - Download one certificate or student document.
   - Create a test backup on the new server and download it (proves the key and folders work).
10. Reconnect external services: DNS, TLS (`certbot`), SMTP/SMS/WhatsApp credentials, AI keys
    (if `SETTINGS_ENCRYPTION_KEY` changed), and re-enable `BACKUP_SCHEDULE_ENABLED`.
11. `shred -u ~/backup.key` when done if you keep the key elsewhere.

**If a check fails:** do not open the server to users. Drop the target database, empty the
storage folder, and retry with the previous backup. Report the failing check.

## 6. Keys and secrets — keep them off the server

| Secret | Without it |
|---|---|
| `BACKUP_ENCRYPTION_KEY` (key id shown in every manifest) | **No backup can be restored.** |
| `SETTINGS_ENCRYPTION_KEY` / `JWT_PLATFORM_SECRET` | Saved AI keys must be re-entered. |
| MongoDB, SMTP, Twilio, WhatsApp, AI credentials | Re-issue them at the provider. |

Store all of them in a password manager **and** an offline copy (printed or on a USB stick kept
elsewhere). When you rotate `BACKUP_ENCRYPTION_KEY`, keep the old key as long as you keep
backups made with it (the key id in each manifest tells you which one).

## 7. Restore drills

Monthly: download the newest backup, run `backup:verify`, and restore it into a scratch database
on a test machine (`--target-uri mongodb://127.0.0.1:27017/school_os_drill` with an empty
`--storage-dir`). Record the date, duration and `RESULT`.

## 8. Incremental backups and point-in-time recovery

The application makes **full** backups only. A daily "incremental" built from `updatedAt`
fields would be unreliable: deletions, bulk updates and some background writes do not leave a
trustworthy trail, so a chain could silently miss changes. Reliable incremental recovery needs
the replica-set **oplog** (point-in-time recovery), which is provided by:

- **MongoDB Atlas** Cloud Backup with continuous backup (recommended if you use Atlas), or
- `mongodump --oplog` / Percona Backup for MongoDB on a self-hosted replica set, with
  oplog sized for your interval and a tested restore procedure.

Either is an addition to — not a replacement for — the downloadable encrypted full backups,
which remain the copy you control. Data volumes of a school deployment make daily full backups
small (see the measured sizes in the test results).

## 9. Manual alternative (MongoDB Database Tools)

If the API itself cannot run, a `mongodump` of the database plus a copy of `STORAGE_DIR`
(taken while the API is stopped) is a valid emergency backup:

```bash
sudo systemctl stop school-os
mongodump --uri="$MONGODB_URI" --gzip --archive=/var/backups/school-os/db-$(date +%Y%m%d).archive.gz
tar -czf /var/backups/school-os/files-$(date +%Y%m%d).tar.gz -C /var/lib/school-os storage
sudo systemctl start school-os
```

These files are **not encrypted**; encrypt them (e.g. `gpg --symmetric`) before they leave the
server. Restore with `mongorestore --gzip --archive=... --nsFrom='school_os.*' --nsTo='school_os_new.*'`
into a new database, then `npm run db:indexes` and the manual checks of §5.9.
