# Biometric (fingerprint) attendance for staff

Teacher and staff attendance from the fingerprint machines schools already have. Student
attendance is separate and unchanged (`AttendanceRecord`, the Attendance pages).

> **Automatic device integration is paused** (no real machine or confirmed model yet). Status,
> what exists and how to resume: [`biometric-staff-attendance-device-integration/`](biometric-staff-attendance-device-integration/README.md).
> File import and everything below keep working.

**What works today:** importing a machine's attendance export (CSV, Excel, TXT/DAT), linking
device user IDs to staff, daily records, hand-made marks with conflict resolution, and the
Connector API for a future local connector. **What does not exist yet:** any live connection to
a machine (ZKTeco push, ZKTeco over the LAN, Suprema BioStar 2, a local connector program). No
brand is claimed as "supported": what works depends on the export a model produces.

## How a school uses it

1. **Staff attendance → Devices → Add device.** Name the machine (e.g. "Main gate"), optionally the
   manufacturer, model, serial number and location; connection method **File import**.
2. **Export the attendance log** from the machine (USB flash drive / "Export" menu) or from its
   PC software.
3. **Import data → Staff attendance punches** (or the button on the Staff attendance page): upload
   the file, choose the device, match the columns, check, review, confirm.
4. **Staff attendance → Device users:** link each device user ID to a staff member. A suggestion
   appears only when the ID is exactly a staff member's Employee No; nothing is linked by name or
   without confirmation. Punches of unlinked IDs are kept and counted as soon as the link is made.
5. **Staff attendance → Daily attendance:** each staff member's day, with first and last punch.

Permissions: viewing needs `employees:read` (owner, principal, school admin, accountant);
everything that changes data needs `employees:manage` (owner, principal, school admin).
Teachers and parents have no access.

**Campuses.** A user limited to some campuses works as in the staff module: they see and change only
the staff of their campuses (another campus' staff member, link, day or conflict is "not found"),
by every route, whatever ID is sent. Their lists of links, punches, conflicts and days show only
their campuses' staff; unlinked punches are shown for devices of their campuses and devices not
assigned to a campus (so they can link them). An action that would also change another campus'
staff is refused (`403 CAMPUS_FORBIDDEN`): a link that would take punches over from (or hand them
to) another campus' staff member, an import row of a device user linked to another campus' staff
(the row is refused with the reason), undoing an import holding such punches. Users with every
campus (the owner, usually) are not affected.

Devices belong to a campus, or to every campus (no campus). Every user who can view staff
attendance sees every device. A campus-limited user creates devices for their own campus (their
only campus by default), and can change, disable, remove or manage the connector key only of
their own campus' devices — never a device of another campus or one for every campus, and never
move a device to another campus or to every campus (`403 CAMPUS_FORBIDDEN`). They can import from
their campus' devices and from devices for every campus, not from another campus' devices.

## Files that can be imported (tested)

| Format | Notes |
|---|---|
| CSV (comma, semicolon or tab) | With a heading row, or without one (columns become Column A, B, …). UTF-8 or Windows (ANSI) text. |
| Excel `.xlsx` | Date-time cells keep their time; time-only cells are read as times. Old `.xls` is refused (save as `.xlsx`). |
| Text `.txt` / `.dat` | Tab, comma or semicolon separated, or columns separated by spaces (e.g. `17 2026-10-24 08:01:33 1`). Without a heading row. |

Same limits as every import: 5 MB, 5,000 rows, 100 columns; the file is read in a worker thread
and checked and imported in the background with progress.

Columns (matched automatically where the heading is recognisable, always confirmable):

- **Device user ID** (required): AC-No., Enroll No, User ID, PIN, … Leading zeros are ignored for
  numeric IDs (`0017` = `17`).
- **Date and time** in one column, or **Date** + **Time** in two columns. Accepted: `2026-10-24
  08:01:33`, `2026/10/24 08:01`, `24/10/2026 8:01 PM`, `10/24/2026 20:01`, ISO with zone
  (`2026-10-24T08:01:33+05:00`, `…Z`). Times without a zone are the machine's clock in the
  **school's time zone** (Settings).
- **Day/month order**: dates like `03/04/2026` are ambiguous. The order is decided for the whole
  file when some date makes it clear (`24/10/2026`); otherwise those rows are refused with the
  reason until the order is chosen in the options. A file mixing both orders is reported. A date
  that only fits one order (`25/03/2026` when month first was chosen) is read that way, with a
  warning on the row.
- **Before confirming**, the review shows *How dates and times are read*: the order used (chosen
  or decided from the file), the school's time zone, and example rows as in the file and as they
  will be saved — rows that could be read either way, and rows read against the order, first.
  The examples come from the same check that prepares the rows the import saves, so what is shown
  is what is saved. The order used and the device are recorded in the import's audit entry.
- **Punch type** (optional): In/Out, Check In/Check Out, C/In, C/Out are read; other values,
  including numeric state codes (their meaning differs between machines and settings), are kept as
  given and treated as *unknown* — never read as arrival or departure.
- **Name** (optional): shown in the preview only, never used to match.

Rejected rows (missing ID, impossible or future dates, times before 2000, unclear day/month…)
are listed with the reason in the review and in the downloadable report. Nothing is dropped
silently.

## Rules that keep the data right

- **Each punch is stored once**: device + device user ID + time to the second (`PunchEvent.dedupeKey`,
  unique per school). Importing the same file again, an overlapping export, or a retried import
  never duplicates a punch (the check shows them as "already imported").
- **Raw punches are kept apart** from daily attendance, with their device, original time, source
  (file or connector), import and row.
- **Daily record** (`StaffAttendance`, one per staff member and day): from punches, the day is
  *present* with the first and last punch and the in/out counts. Without punches and without a
  mark there is **no record ("not recorded")**: nobody is ever made absent by missing punches.
- **A day marked by hand is never changed by punches.** If it is marked absent or on leave and
  punches exist, it is flagged for a person to resolve: keep the mark, or use the punches
  (present). A kept mark is not flagged again by the same day's punches. A mark can be removed,
  and the day then follows the punches again.
- Linking or unlinking a device user re-applies the links to all of that ID's punches and reworks
  the affected days. Unlinking removes days made only from those punches; marked days stay. The
  punches change hands in bulk (one update per 1,000 punches), and each affected day is worked out
  once.

## Undoing an import

For a file imported under the wrong device, with the wrong day/month order, or simply the wrong
file: **Import data → History → the import → Undo this import…** (`employees:manage`).

- The confirmation lists what will happen first (`GET /biometric/imports/{id}/undo`, changes
  nothing): punches removed, punches kept, staff and days affected, days that become "not
  recorded", hand-made marks kept.
- Only the punches that import saved are touched. A punch that another import's file also held
  (shown there as "already imported") is handed to that import instead of removed; one the
  connector also sent is kept as the connector's. Punches of other imports, devices and schools are
  never touched.
- The affected days are worked out again from the remaining punches with the usual rules: a day
  marked by hand keeps its mark (its "marked off but punched" flag goes when its punches go), "keep
  the mark" decisions stay, a day made only from those punches becomes "not recorded". A day
  resolved to "use the punches" whose punches all go becomes "not recorded" too; the confirmation
  says how many, and the decision stays in the audit log.
- `POST /biometric/imports/{id}/undo` with `confirm: true` runs in the background (the import page
  shows its progress). One undo at a time per import; a second request gets `UNDO_IN_PROGRESS`, a
  request after it is done `IMPORT_ALREADY_UNDONE`. An undone import cannot be run or resumed.
- **One at a time per school:** a staff punch import run and an undo never overlap (both read the
  school's punches and then change them, so together they could lose a punch both touch). Each
  takes the school's lock (`biometricpunchlocks`, one document per school, taken atomically) for
  its whole run; the other is refused with `409 PUNCH_IMPORT_BUSY` until it has finished. A lock
  left by a process that stopped expires after 2 minutes. On top of that, a punch is removed only
  if, at that very moment, no other live import holds it and the connector did not send it.
- Campus access is checked on every attempt, including retries by another user.
- It is reported done only after the punches, the days and the audit entry (`import.undone`: who,
  when, which import, counts, device, date order) are all written. If anything fails part-way the
  import shows "Undo not finished" (`import.undo_failed` in the audit log); undoing again finishes
  it — the affected days were saved before any punch was touched, so nothing is removed twice.
  `import.undone` is written once per import, even if marking the undo done fails afterwards and
  it is run again; `import.undo_failed` is never written for an undo already recorded as done.
- Limit: punches imported before this version do not record which later imports also held them;
  undoing such an import removes them even if a later import held them too (import that file
  again to bring them back: they are then new).

## Recalculating days

**Staff attendance → Daily attendance → Recalculate** works the shown day out again from the stored
punches (`POST /staff-attendance/repair` with `from`, `to`, optional `employeeId`; at most 62 days
and 20,000 staff days per request). For a day whose summary is out of date — for example a punch
saved while working out its day failed. Marks and decisions stay; conflicts are raised or cleared
as the punches say; only the caller's campuses. Safe to repeat; it reports how many days were
checked and how many changed, and is in the audit log.
- Days cannot be marked in the future. Lateness and absence are not calculated: the system has no
  staff timetable or holiday calendar to base them on.
- No staff record is ever created from a device user ID.

## Connection methods

| Method | Status | Notes |
|---|---|---|
| File import (CSV, Excel, TXT) | **Implemented** | Any machine whose export has a user ID and a date and time per punch. |
| Connector API | **Implemented** | `POST /api/v1/biometric/ingest`, for a program on the school network (below). |
| ZKTeco push (device → cloud) | Planned | Needs the exact model/firmware with a push/cloud-server option, ZKTeco's official protocol documentation for it, and a test machine. |
| ZKTeco over the LAN | Planned | A cloud service cannot reach a machine inside the school network: would run in the local connector. Needs the model's official SDK/protocol and a test machine. |
| Suprema BioStar 2 | Planned | Needs the school's BioStar 2 version, Suprema's API documentation and a read-only account reachable from the connector. |
| Local connector (LAN, USB cable, serial) | Planned | A small program on a school PC that reads the machines and sends through the Connector API. A USB *cable* to a PC is different from copying an export with a USB *flash drive* (which works today through File import). |

Planned methods cannot be registered (`INTEGRATION_NOT_AVAILABLE`); the Devices page lists what each
needs. Device connection status is stated only from evidence: file-import devices are "not
contacted"; connector devices report when punches last arrived; nothing shows "connected" without
having received data.

Code: `src/modules/biometric/` (`adapters/registry.ts` lists the methods and the `DeviceAdapter`
interface live adapters implement; `biometric.service.ts` holds the shared ingestion used by every
method), the import processor `src/modules/imports/processors/staff-punches.ts`.

### Connector API

For a connector running inside the school (it connects out over HTTPS; nothing on the school
network is opened to the internet).

1. Register the device with method **Connector API**, then **Create key** (shown once; only its
   SHA-256 hash is stored; a new key replaces the old one; it can be revoked).
2. Send:

```http
POST /api/v1/biometric/ingest
Authorization: Bearer sbk_<device id>_<secret>
Content-Type: application/json

{ "punches": [ { "deviceUserId": "17", "timestamp": "2026-10-24T08:01:33+05:00", "punchType": "in" } ] }
```

- Up to 1,000 punches per request; 120 requests per minute per device.
- `timestamp` must include its time zone (`Z` or `+05:00`), so the PC's settings cannot shift it.
- Response: `{ stored, duplicates, linked, rejected: [{ index, reason }] }`. Sending punches again is
  safe (they are counted as duplicates); one bad punch never blocks the others. A connector should
  resend a batch whose response it did not receive.
- `401 INVALID_CONNECTOR_KEY` for an unknown or revoked key; `403 DEVICE_DISABLED` /
  `DEVICE_NOT_CONNECTOR` when the device is disabled or uses another method.

## Privacy and security

- No fingerprint images, templates or other biometric data are imported, sent or stored: only the
  device user ID, the time, the punch type and the device. Columns that look like biometric data
  are flagged and ignored by the import.
- Everything is per school (tenant-scoped queries, unique indexes per school); another school's
  devices, links, staff and punches are not visible or usable (404).
- Connector keys are never returned after creation and never logged; the device list omits them.
- Every change (devices, keys, links, marks, resolutions, undone imports, recalculations) is in the
  audit log.

## Deployment

New collections (`biometricdevices`, `deviceuserlinks`, `punchevents`, `staffattendances`) and their
indexes: run `npm run db:indexes -- --apply` after deploying (creates missing indexes, drops nothing,
saves a snapshot of the current index definitions first). Run `npm run db:indexes` without
`--apply` first to see the list. No existing data is changed; the `importjobs` collection only gains
an optional `undo` field (no index, no migration).

The unique indexes are what keep the data right under retries and simultaneous requests:

| Collection | Unique index | Without it |
|---|---|---|
| `punchevents` | `{ schoolId, dedupeKey }` | the same punch is stored again (a retried connector request, a connector and an import at once — reproduced: 10 copies of one punch) |
| `staffattendances` | `{ schoolId, employeeId, date }` | two records for one staff member and day |
| `deviceuserlinks` | `{ schoolId, deviceId, deviceUserId }` | one device user linked twice |
| `biometricdevices` | `{ schoolId, name }` (case-insensitive) | two devices with the same name |

Also created by the same command (lookups, not uniqueness): `punchevents` `{ schoolId, importJobId }`
and `{ schoolId, alsoImportJobIds }` (undo), and the other indexes declared in `biometric.models.ts`.

The API only **reads** the index list (it never creates or drops one). At startup it logs a warning
if one of the unique indexes above is missing, and while one is missing staff attendance refuses
to save anything (`503 BIOMETRIC_NOT_READY`; reading still works). The check is repeated while
the API runs: a passed check is trusted for 10 seconds (so an index dropped after startup is noticed
within 10 seconds), a failed one is repeated on every write (so applying the indexes takes effect at
once, without a restart). Do not drop indexes, or run `db:indexes --drop-obsolete`, while the API
is running: writes in those 10 seconds would not be protected.

The lock collection `biometricpunchlocks` needs no index of its own (it uses `_id`); it is created
on first use.

Working out a day is safe when punches for the same day arrive at the same moment: after writing,
the punches are counted again and the day is worked out again if they changed meanwhile.

## Still needed for live machine integration

- The models and firmware versions schools actually use, with their official SDK or protocol
  documentation (ZKTeco push/LAN, Suprema BioStar 2, others).
- Test machines (or a vendor test environment) to verify each adapter before schools rely on it.
- For the local connector: a decision on the PC platform (likely Windows), how it is installed and
  updated, and where it stores its key (the key only allows sending punches for one device).
