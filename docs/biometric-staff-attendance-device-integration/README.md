# Biometric staff attendance — automatic device integration

## A. Feature status

**Status: PAUSED — AWAITING PHYSICAL DEVICE / VERIFIED DEVICE DETAILS** (since 2026-10-24).

- **Why paused:** no school has supplied an attendance machine, a confirmed brand and exact
  model, a firmware version or the device's protocol documentation. A manufacturer integration
  built without those would be guesswork and could not be tested.
- **What is paused:** *automatic* hardware integration only — a machine (or vendor software)
  sending punches to School OS by itself, or School OS / a local program reading the machine.
  Candidates listed in the app: ZKTeco push (ADMS), ZKTeco over the LAN, Suprema BioStar 2, a
  local connector program. None is built; none is a confirmed choice.
- **What is not paused and keeps working:** staff attendance from **file import** (the machine's
  exported CSV / Excel / TXT / DAT file), device-user linking, daily staff attendance, hand-made
  marks and conflict resolution, undoing an import, recalculating days, and the normalized JSON
  **Connector API** (`POST /api/v1/biometric/ingest`) for a future local connector.
- **In the app:** Staff attendance → Devices shows an *Automatic attendance machine integration —
  Coming soon* notice, and every not-yet-built connection method is labelled *Coming soon* without
  controls. Registering a device for File import (or the Connector API) still works.

Full description of the working feature: [`../BIOMETRIC_ATTENDANCE.md`](../BIOMETRIC_ATTENDANCE.md).

## B. What already exists (verified in this repository on 2026-10-24)

Legend: **Implemented** (code and automated tests exist and pass) · **Partial** · **Planned** (listed, no code) · **Not verified** (no evidence here).

### Routes and APIs — `school-os-backend/src/modules/biometric/biometric.routes.ts`

| Method and path (prefix `/api/v1`) | Permission | Status |
|---|---|---|
| `GET /biometric/integrations` | `employees:read` | Implemented |
| `GET /biometric/devices` · `GET /biometric/devices/:id/status` | `employees:read` | Implemented |
| `POST /biometric/devices` · `PATCH`/`DELETE /biometric/devices/:id` | `employees:manage` | Implemented (planned methods refused: `INTEGRATION_NOT_AVAILABLE`) |
| `POST`/`DELETE /biometric/devices/:id/connector-key` | `employees:manage` | Implemented |
| `GET /biometric/links` · `GET /biometric/unlinked` · `GET /biometric/punches` | `employees:read` | Implemented |
| `POST /biometric/links` · `DELETE /biometric/links/:id` | `employees:manage` | Implemented |
| `GET`/`POST /biometric/imports/:id/undo` | `employees:manage` | Implemented |
| `POST /biometric/ingest` (Connector API) | public, device connector key | Implemented (normalized JSON only) |
| `GET`/`PUT /staff-attendance` · `DELETE /staff-attendance/:employeeId/:date` | read / manage | Implemented |
| `GET /staff-attendance/conflicts` · `POST /staff-attendance/:id/resolve` · `POST /staff-attendance/repair` | read / manage | Implemented |
| Punch file import: import type `staff_punches` through `/api/v1/imports…` | `employees:manage` | Implemented |
| Any manufacturer protocol endpoint (e.g. ZKTeco ADMS) | — | **Not implemented** |

### Services, models, adapters

| File | Role | Status |
|---|---|---|
| `src/modules/biometric/biometric.models.ts` | `BiometricDevice`, `DeviceUserLink`, `PunchEvent`, `StaffAttendance` and their indexes | Implemented |
| `src/modules/biometric/biometric.service.ts` | devices, connector keys, links, `storePunches` (shared punch storage), `ingestPunches` (Connector API) | Implemented |
| `src/modules/biometric/staff-attendance.service.ts` | daily records, marks, conflicts, recalculation, repair | Implemented |
| `src/modules/biometric/punch-values.ts` | reading punch times and types | Implemented |
| `src/modules/biometric/access.ts` | campus restrictions | Implemented |
| `src/modules/biometric/import-undo.ts` · `punch-lock.ts` | undo an import; one import/undo at a time per school | Implemented |
| `src/modules/biometric/index-check.ts` | refuses writes while required unique indexes are missing (read-only check) | Implemented |
| `src/modules/biometric/adapters/registry.ts` | connection methods and their status; a pull-style `DeviceAdapter` interface | Methods `file_import`, `connector_api` implemented; `zkteco_push`, `zkteco_lan`, `suprema_biostar2`, `local_connector` **planned** (no adapter code). The interface has no implementation and suits pulling, not a device that pushes. |
| `src/modules/imports/processors/staff-punches.ts` | the punch file import | Implemented |

### Device registration and connector

- A device is registered with a name, optional manufacturer/model/serial/location/campus and a
  connection method. Only `file_import` and `connector_api` can be registered.
- Connector API: a key `sbk_<deviceId>_<secret>` is created per device, shown once, stored as a
  SHA-256 hash, compared in constant time; 120 requests/minute per device; up to 1,000 punches per
  request; timestamps must carry a time zone; replies `{ stored, duplicates, linked, rejected }`.
- The connector *program* that would use it is **not provided** (planned "Local connector").
- Device status shown: file-import devices are "not contacted"; connector devices report when
  punches last arrived (`lastSyncAt`, `lastSyncResult`, `lastEventAt`). Nothing reports
  "connected" without received data.

### Punch processing and duplicate protection

- One path for file import and Connector API: `storePunches` (`biometric.service.ts`).
- Each punch is stored once: key = SHA-256 of device + device user ID + time to the second,
  unique per school (`PunchEvent` index `{ schoolId, dedupeKey }`). No device event ID is needed.
- Device user → staff member only through explicit links; never by name; unlinked punches wait.

### Attendance recalculation and manual-mark protection

- A day is "present" from punches; a day marked by hand is never changed by punches; a day marked
  absent/on leave with punches is flagged for a person to resolve; no punches never means absent.
- Recalculation is re-checked after writing (safe for simultaneous punches); "Recalculate" repairs
  a date range; undo removes only an import's own punches and keeps punches other imports hold.

### UI — `school-management-software-frontend`

- `src/app/(app)/staff-attendance/page.tsx`, `src/features/staff-attendance/staff-attendance.tsx`
  (Daily attendance, Device users, Devices tabs), `src/features/imports/punch-import.tsx`
  (date reading preview, undo), the import wizard (`src/features/imports/import-wizard.tsx`),
  navigation entry *Staff attendance* (`src/config/navigation.ts`, `employees:read`).

### Tests (all use the suite's own in-memory MongoDB)

- Backend: `tests/biometric-attendance.test.ts` (25), `tests/biometric-hardening.test.ts` (29),
  `tests/biometric-concurrency.test.ts` (5).
- Frontend: `tests/unit/staff-attendance.test.tsx`, `tests/unit/punch-import.test.tsx`; browser:
  `tests/e2e/staff-attendance.spec.ts` (needs an isolated backend; see H).

### Not verified

- Any real fingerprint machine sending to, or being read by, School OS.
- Whether any particular export file format beyond the tested samples imports correctly.

## C. Work completed so far

- **Phase 1 (implemented, uncommitted):** file import, linking, daily records, marks, conflicts,
  Connector API, campus restrictions, undo with overlap protection, repair, index readiness check.
  Several production-readiness audits were run; their findings were fixed and are covered by the
  test files listed in B (audit reports themselves are not stored in the repository).
- **Phase 2A (read-only investigation, 2026-10-24):** traced the Connector API and pipeline and
  assessed ZKTeco ADMS. Verified findings, re-checked against the code for this document:
  - the Connector API accepts normalized JSON only (`express.json`, 1 MB, `src/app.ts`), one way;
    no device polling, push protocol, command exchange or handshake exists;
  - the API is mounted under `/api/v1`; manufacturer firmware usually calls fixed paths, so a
    device protocol would need its own routes (and the write-freeze guard applied to them);
  - devices are identified only by connector key; `serialNumber` is optional and not indexed, so
    identifying a device by serial number (as push protocols typically do) is not possible yet;
  - Connector API timestamps without a time zone are rejected; device-local times would need a
    per-device time zone;
  - connector deliveries are not written to the audit log (only the device's last-sync text).
  - Unverified (no vendor documentation in the repository): ADMS endpoint paths, message formats,
    handshake, status/verify codes, authentication, HTTPS support, retry behaviour.
- **Known considerations for any device integration:**
  - *Security/identity:* push devices may identify themselves only by serial number — never trust
    an unknown serial, never attach a device to a school automatically.
  - *Time zone:* device clock and time-zone settings may differ from the school's; clock changes
    create new punch keys (duplicates in counts).
  - *Retries:* reply success only after punches are stored; malformed lines must not cause endless
    resends.
  - *Monitoring:* last poll, last upload, clock offset and rejected lines should be visible.
  - *Compatibility:* depends on exact model and firmware, never on the brand alone.
  - *Transport:* the API is served through a Cloudflare tunnel; a device that only speaks plain
    HTTP or does not follow redirects may not reach it (not verified).
- **This task (pause):** UI "Coming soon" notice and labels, matching test updates, this document.
  No backend code, schema, index or configuration was changed.

## D. Why work is paused

No physical machine, confirmed brand/model, firmware version or verified device protocol is
available. The protocol details that decide the design (identity, authentication, message
format, time handling, retries) cannot be confirmed from documentation alone and must be tested
against the real device.

## E. Future implementation plan

1. Obtain from the school owner: device brand, exact model, firmware version, connection type and
   the relevant protocol documentation (or vendor SDK/API documentation).
2. Verify compatibility and the device's communication and authentication capabilities (HTTPS,
   communication key, how it identifies itself, retry behaviour).
3. Review the existing connector architecture and choose a secure adapter design: the adapter only
   translates device messages into normalized punches and hands them to the existing shared
   punch storage (`storePunches`), never duplicating attendance logic.
4. Implement only the confirmed protocol and required configuration (e.g. device serial lookup,
   per-device time zone), behind review of any new index.
5. Add parser, authentication, duplicate-delivery, time-zone, retry and tenant/campus isolation
   tests with synthetic data on the in-memory test database.
6. Test against the real device in a test school; compare a week of punches with the device's own
   export (no missing, no duplicate punches).
7. Review database indexes, security, monitoring, permissions and production readiness.
8. Obtain explicit approval before any production database change or deployment.

ZKTeco ADMS (device push) is a **candidate only**, not a confirmed choice.

## F. Resume checklist

- [ ] Manufacturer and exact model of each machine.
- [ ] Firmware / protocol version.
- [ ] Connection method: LAN, device push, USB export, vendor cloud, or another supported method.
- [ ] Official protocol documentation, or anonymized sample device requests and responses.
- [ ] Whether the device supports HTTPS and device communication credentials.
- [ ] The school's time zone and how the device stamps times (local clock, time zone setting).
- [ ] Which school and which test environment will be used for the trial.

## G. Safety rules

- Do not alter unrelated working-tree changes.
- Do not use production or shared databases for development tests.
- Do not create or drop database indexes without review and explicit approval.
- Do not commit, push or deploy without explicit authorization.
- Never accept unknown device identities or silently associate unknown devices with schools.
- Never upload or store fingerprint templates or biometric images as part of this attendance
  integration unless a separately reviewed requirement explicitly authorizes it.

## H. Verification results (2026-10-24, this task)

All tests use the suite's own throwaway in-memory MongoDB (the suite refuses any database not
named `schoolos_test_*`). No shared, Atlas or production database was used.

| Command | When | Result |
|---|---|---|
| `npx tsc --noEmit` (backend) | before changes | pass |
| `npx vitest run tests/biometric-attendance.test.ts tests/biometric-hardening.test.ts tests/biometric-concurrency.test.ts tests/imports.test.ts tests/import-hardening.test.ts tests/import-fixes.test.ts tests/attendance-timetable.test.ts tests/tenant-isolation.test.ts tests/security-surface.test.ts tests/students-admissions.test.ts --project standalone` | before changes (backend code unchanged by this task) | 155 / 155 passed (10 files) |
| `npx tsc --noEmit`, `npx eslint` (frontend) | before and after | pass |
| `npx vitest run` (frontend) | before changes | 106 / 109 — 3 login-form tests in `components.test.tsx` timed out while the machine was busy (77 s run); the same file alone: 9 / 9 passed |
| `npx vitest run tests/unit/staff-attendance.test.tsx` (frontend) | after changes | 10 / 10 passed (includes the new Coming soon test) |
| `npx vitest run` (frontend) | after changes | 110 / 110 passed (17 files) |

Limitations:

- Browser tests (`tests/e2e/staff-attendance.spec.ts`, updated for the new label) were **not run**:
  the local ports 3000 and 4000 are used by the developer's own running servers, so an isolated
  target could not be guaranteed.
- The frontend production build (`next build`) was **not run**: the developer's running
  `next dev` uses the same `.next` folder.
- No real device was tested (none is available).
