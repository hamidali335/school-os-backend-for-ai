# Data import (Excel and CSV)

Schools can bring in existing records in two ways:

- **Template:** download an official template from **Import data**, fill it in, and upload it.
- **Existing file:** upload the `.xlsx` or `.csv` file they already have, even if its column names and order are different. They then confirm how each column is used.

Nothing is saved until the user has seen the preview and confirmed. The manual forms (Add student, Add staff and so on) are unchanged. An import runs each row through the same code as those forms.

## What can be imported

| Type | Permission | Recognised by | Notes |
|---|---|---|---|
| Classes and sections | `academics:manage` | class + section + session | Creates a class once and reuses it for its sections. Existing classes and sections are skipped, never changed. |
| Students and parents | `students:manage` | Admission No | Each row is an admission through `createStudent()`, so placement, capacity, plan limits and parent logins follow the admission rules. A row with status Left or Graduated (or Transferred, read as Left) is saved with that status from the start; as it is not active, it does not count towards the active-student limit or section capacity, and can be imported when the limit is reached. Saved in lanes, the limit and section capacities stay exact: each row counts the active students inside its own save. Within 50 places of a limit, every save that uses it (import rows, admissions, re-activations, restores from the archive) takes a guard in its transaction, so concurrent saves are counted one after another and the limit is never passed; the import then saves those rows one at a time. This needs a replica set (required in production). Students with the same parent phone share one parent record. Sending messages is never triggered. |
| Parents and guardians | `parents:manage` | phone | Can link to existing students by admission number (`Children Admission Nos`). No login is created, the same as the Parents page. |
| Teachers and staff | `employees:manage` | Employee No (or CNIC) | Uses `createEmployee()`, the same as Add staff. Teachers get a login waiting for activation. Existing staff are skipped. |

Fees, payments and opening balances **cannot be imported**. A wrong import would change balances and receipts, and the fee rules (approvals, receipts, ledgers) have no safe bulk path yet. This is deliberate.

Recommended order when moving from another system: classes and sections, then students and parents, then staff.

## Steps and API

1. **Upload:** `POST /imports` (multipart with `file` and `type`). The server reads the file and suggests a field for each column. It never stores the file. The cells are kept in `importrows` for 7 days (with a TTL index) so the preview and error report work.
   - The response comes as soon as the file is read: the job is `staging` while its rows are saved in the background, with progress in `GET /imports/:id`. The column step can start meanwhile; check, rows, report and run answer `409 IMPORT_STAGING` until the job is `analyzed`.
   - How long saving takes depends on the database: about 1 s for 5,000 rows next to the API, about 30 s over the internet to a shared cloud tier. Before, that time was inside the upload request and the browser gave up at 30 s.
   - If saving fails, is cancelled, or the server stops meanwhile, the rows already saved are removed first and the job then shows `failed` or `cancelled` ("upload the file again"). It is never offered for checking half-prepared.
2. **Check:** `POST /imports/:id/check` with `{ mapping, options }` checks every row in the background.
   - The response comes at once: the job is `checking`, with progress in `GET /imports/:id`. It becomes `validated` with the counts (will add, will update, unchanged, already exists, duplicates, errors), or `analyzed` with `error` if checking failed or the server stopped meanwhile; it can then be checked again.
   - Checking saves only the import's own records (each row's result and the summary). It never creates or changes students, parents, staff or logins.
   - One check runs per import, claimed atomically. Repeating the request with the same columns and options (a retry, a refresh, a second tab) returns the running check; other columns or options get `409 IMPORT_CHECKING`. Rows, report and run answer `409 IMPORT_CHECKING` until it ends. A check holds a heartbeat like a run: one whose process stopped is shown as `analyzed` (and reset at startup), and the next check replaces it.
   - Required fields without a column return `IMPORT_REQUIRED_COLUMNS`.
   - Row details come from `GET /imports/:id/rows?filter=problems|warnings|ready|skipped|imported|all`.
3. **Run:** `POST /imports/:id/run` with `{ confirm: true }` imports in the background. Poll `GET /imports/:id` for progress.
   - Each row is checked again just before it is saved, in case the data changed.
   - Each row is saved on its own. A row that fails is reported and the rest continue.
   - Students are saved in 4 lanes at once (at most 8, `IMPORT_LANES`), because over a slow connection almost all of a row's time is spent waiting for the database. Rows that share a parent (phone in any spelling, the parent's login name, email or CNIC) or an admission number are saved one after another in file order, in one lane, so they find what the rows before them created, exactly as one at a time. Parents, staff and classes are saved one at a time.
4. **Report:** `GET /imports/:id/report.csv` returns the rows that were not imported, with their original values and the reasons. Add `?all=true` for every row and its outcome. The cells are protected against formula injection.

Other endpoints:
- `GET /imports/types` lists the fields of each type.
- `GET /imports/templates/:type?format=xlsx|csv` downloads a template.
- `GET /imports` is the import history.
- `POST /imports/:id/stop` cancels an import that hasn't started, or stops a running one: no new row starts, and the rows being saved (at most one per lane) finish. Stopping works even when the school's subscription has lapsed (the school is read-only); starting or resuming an import does not.

## Matching columns

Matching is deterministic and uses no AI:
1. a column the school mapped in an earlier completed import (remembered per school and type);
2. an exact field name or known alias, such as `SID`, `Father/Guard`, `DOB` or `Contact No`;
3. keyword patterns, where longer patterns win. For example, `Father/Guard Mobile` contains "father" and "mobile", so it maps to Parent phone.

Columns from other systems that have no place in this app, such as a per-student fee plan, are shown with the reason they're ignored. Every ignored column is listed before the import.

## Reading values

- **Dates:** `YYYY-MM-DD`, day-first `DD/MM/YYYY`, `04-Feb-2022`, `March 5, 2016` and Excel date serials are all read. Impossible dates such as 31/02 are errors.
- **Phones:** spaces and dashes are removed. A mobile that lost its leading 0 in Excel (`3001234567`) and `92…` without a `+` are repaired, and the row shows a note saying so.
- **Same number, different spelling:** `03001234567`, `+923001234567`, `923001234567`, `00923001234567` and `0300-123 4567` are the same number when looking for an existing parent or staff member. Stored numbers are never rewritten.
- **Gender, status, relation and staff type:** common words are accepted, such as M/F and "Currently Enrolled".
- **Full names:** split at the last space into first and last name, which display together exactly as given.
- **Same rules as the forms:** student rows are checked with the admission form's schema (`StudentBody`), parent rows with the Parents form's schema, and staff rows with the Add staff schema.
- **Template example row:** recognised and skipped if left in the file.

## File safety and limits

- The content is checked, not just the name:
  - `.xlsx` must be a real workbook (a zip containing `xl/workbook.xml`);
  - CSV must be text;
  - old `.xls`, `.xlsm`/`.xlsb` and workbooks containing VBA are refused with instructions.
- **Checks before the workbook is parsed:**
  - The zip's table of contents must declare at most 30 MB uncompressed in total.
  - Each worksheet is then decompressed with a hard 25 MB cap. The cap holds even if the zip lies about its sizes.
  - Rows and cells are counted from the XML: at most 5,000 rows and 250,000 filled cells per sheet.
  - Only then does the full Excel parser run. A 5 MB file that expands to 400,000 rows is refused instantly, where it previously used about 800 MB of memory.
- **Other limits:** 5 MB per file and 100 columns. Formulas are never evaluated (Excel's saved value is used), and control characters are removed.
- **Load:** each user may upload at most 20 files per 15 minutes (`RATE_LIMITED`), and each API process reads at most two files at once (`IMPORT_BUSY`, try again shortly).
- **Off the main thread:** files are read in worker threads (`spreadsheet-reader.ts`; same pattern as the password hasher).
  - Each worker is limited to 384 MB of memory and 60 seconds; a file that exceeds either ends only its worker, with a clear message, and the API keeps running.
  - The largest accepted file (5,000 rows × 50 columns) takes about 1.5 s to read. Measured with `perf_hooks.monitorEventLoopDelay` (`tests/import-event-loop.test.ts`), other requests now wait at most about 0.1 s while it is uploaded or checked, instead of about 0.5 s.

## Who can see an import

- **Permission:** every request needs the same permission as adding the records by hand. Everything is scoped to the user's school; another school's import returns 404.
- **Campus visibility:** an import is visible only to the user who uploaded it, and to users with access to every campus. A user limited to some campuses never sees another user's import (it returns 404), because its rows may concern other campuses.
- **Messages:** existing parents' names appear in messages only for users allowed to see parents. A student or staff member in a campus the user can't access is described only as "in another campus".
- **Report contents:** the error report contains only the columns that were imported. When an import ends or is cancelled, the stored cells of columns that weren't imported are blanked. The uploaded file itself is never stored.

## Duplicates, updates and recovery

- **Duplicates in the file:**
  - the same admission number, phone (any spelling), employee number, CNIC or class+section twice;
  - the same student twice (same name and date of birth or parent phone);
  - the same staff member twice (same name and phone or email).

  Later rows are reported against the first.
- **Existing parents:** a parent is recognised by phone number in any spelling and reused, so one parent keeps one login.
  - If several existing parents share the number, the one whose name matches is used.
  - If none or several match, the row is refused for review.
  - A parent's CNIC must not belong to another parent.
- **Records already in the system** (same admission or employee number): skipped by default.
  - "Add and update" (students and parents only) shows each field that would change, `from → to`.
  - Empty cells never erase data.
  - Updates never change a student's class, section or parents (use Promote students).
- **Likely existing students:** checked on every new row, whatever its admission number:
  - same name and date of birth;
  - same name and a parent with the same phone;
  - or the same admission number apart from leading zeros (`123` / `00123`) with the same name.

  These rows are skipped by default. They can be imported anyway with an explicit option, and are never updated. A leading-zero match with a *different* name is always refused for review.
- **Likely existing staff:** same name and the same phone (any spelling) or email, or the same employee number apart from leading zeros. Skipped by default; can be imported anyway.
- **Parent–child links:** the parents import links children only for users who may edit students (`students:manage`), and never beyond four guardians. The limit is checked when the file is checked, again before a row is saved, and atomically for each link. The parent record and its links are saved together (a transaction on a replica set; undone on a standalone server), so a link that fails leaves no new parent record, no partial links and no half-applied update.
- **Processing, leases and safe resume:**
  - A running import holds a lease: its run id plus a heartbeat written every 5 seconds by a timer, whatever the rows are doing (one row can take seconds over a slow connection). A stop request or a takeover is therefore noticed within 5 seconds, and a live run is never shown as stalled.
  - When the API shuts down (a deploy or restart), running imports start no new row, finish the rows being saved (up to 10 seconds) and are left `interrupted` with "The server restarted while importing", to be resumed at once.
  - Each row is claimed atomically before it is saved, so two processes can never save the same row.
  - A run with no heartbeat for 2 minutes counts as stalled: it shows as `interrupted` and can be resumed. On startup, only stalled runs are marked interrupted; a live run in another process keeps its import. A stalled run whose stop had been requested is cancelled instead, as asked, and is not offered for resuming.
  - A run that lost its import (another run took it over) starts no new row; a row's result is written only while its run still holds the row's claim.
  - Before a row is saved, the admission or employee number it will use is reserved and recorded on the row. New students without an admission number are numbered all at once before saving starts, in file order (a stopped import may leave unused numbers). A resumed run re-checks every remaining row and recognises a record saved just before the stop, so nothing is added twice.
  - A row another run claimed in the last 2 minutes is left to that run. If such rows remain, the import ends `interrupted`, to be resumed later.
  - A record that appears meanwhile with the same unique number fails with a clear message ("a record with the same admission number … already exists"), not an unexpected error.
  - Only one import runs per school at a time (a unique partial index). A stalled one no longer blocks the school.
- **Row data lifetime:** cell values are kept 7 days for the preview, resume and report. Starting or resuming a run extends them to at least two days ahead.
  - After they expire, the import can't be checked or resumed (`IMPORT_EXPIRED`).
  - Records it already imported are kept.
  - Upload the file again: rows already in the system are recognised and skipped.
- **No rollback:** there is no "undo import".
  - Records created by an import are ordinary records and are audited (`source: import`), with `import.started` and `import.completed` audit entries.
  - Gaps in admission or employee numbering can appear when reserved rows fail.

## Indexes (production)

Production never creates indexes by itself (`autoIndex` is off), so run these after deploying the code and **before** using imports:

```bash
npm run db:indexes                 # report only; expected: CREATE lines for the three new collections, nothing else
npm run db:indexes -- --apply      # creates them; never drops anything
```

Expected changes (all on new, empty collections, so no uniqueness conflicts are possible):

| Collection | Index | Purpose |
|---|---|---|
| `importjobs` | `schoolId_1` | tenant scope |
| `importjobs` | `schoolId_1_createdAt_-1` | history |
| `importjobs` | `one_running_import_per_school` (`schoolId, status`, unique, partial `status: running`) | one import per school |
| `importrows` | `schoolId_1` | tenant scope |
| `importrows` | `schoolId_1_jobId_1_rowNo_1` (unique) | one row per spreadsheet row |
| `importrows` | `schoolId_1_jobId_1_check_1` | preview filters |
| `importrows` | `expiresAt_1` (TTL, `expireAfterSeconds: 0`) | deletes row data after its expiry; affects only `importrows` |
| `importmappings` | `schoolId_1` | tenant scope |
| `importmappings` | `schoolId_1_type_1` (unique) | remembered column choices |

If the report lists anything as `REPLACE` or `OBSOLETE`, stop and investigate; don't use `--drop-obsolete`.
