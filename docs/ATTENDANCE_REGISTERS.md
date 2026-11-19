# Attendance registers: drafts, finalizing, and older clients

A section's attendance for one day is a **register**: the attendance records of its students,
plus an `attendanceregisters` document that says whether it was finalized. Nothing is ever
marked automatically: a student without a record has no status (never present, never absent).

## States (computed by the server, `GET /attendance/sections/:id`, `GET /attendance/daily`)

| State | Meaning |
|---|---|
| `not_started` | Nobody in the section has a status for the day. |
| `draft` | Some active students have no status, or the register was saved as a draft and not finalized. |
| `complete` | Every active student has a status and the register was finalized (or it is a day from before registers existed, see below). |

Completeness is re-checked live: a student admitted to the section after finalizing makes it
`draft` again.

## `POST /attendance/mark` and the `finalize` flag

| Client sends | Server does |
|---|---|
| `finalize: false` | Saves the entries as a draft. Always records the register (`draftSavedAt`), and reopens one that was finalized. |
| `finalize: true` | Saves the entries, then finalizes only if every active student has a status; otherwise **422 `ATTENDANCE_INCOMPLETE`** with the unmarked students in `error.details.missing` (the entries stay saved as a draft). |
| no `finalize` (older clients, e.g. the current mobile app) | Saves the entries; finalizes **only if** every active student has a status. Otherwise the response is 200 with `finalized: false`, `state: 'draft'`, `missingCount` and `missing`. |

The completeness check is always the server's, computed from what is saved, so no client (new or
old) can finalize an incomplete register by omitting or setting the flag.

**Client compatibility.** The mobile app (`SchoolOSMobile`) sends no `finalize` flag and only the
students it has a status for: it keeps working unchanged. A partially marked register it sends is
a draft until the rest of the class is marked (from the app or the website). To show "draft",
read `state` / `missingCount` from the response. Absence notices to parents are sent for older
clients' submissions as before; for `finalize` clients only when the register is finalized.

## Days marked before registers existed

Those days have attendance records but no register document. They count as `complete` when every
active student has a status (as they did before) and as `draft` when some had none; nothing is
filled in or rewritten. Because a saved draft always writes a register document, a new draft is
never mistaken for such a day.

## Deployment

The collection `attendanceregisters` and its unique index `{ schoolId, sectionId, date }` are
created by `npm run db:indexes -- --apply` (see DEPLOYMENT.md). No migration: existing records are
read as described above.
