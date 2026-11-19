# Architecture Addendum: Sync Foundation & Multi-Tenant Protocol

This document defines the binding synchronization, concurrency, and durability rules for School OS Backend (`school-os-backend`) and Desktop (`SchoolManagementSoftware`). Where this document and `ARCHITECTURE.md` disagree, this addendum takes precedence.

---

## Section 2: Desktop Write Path & Offline Mutations
1. **Single Write Path (`WriteCoordinator`):**
   - Every user mutation generates `operationId` (`op_<uuid>`) and `idempotencyKey` (`idemp_<entityType>_<entityId>_<uuid>`) **once**.
   - An outbox row is inserted inside a SQLite transaction **before** any network call is dispatched.
   - **Provisional Local Changes:** Permitted **ONLY** for `ATTENDANCE` and `PAYMENT`. For all other entity types, insert only the outbox row with `state = 'pending'`; apply the server result locally to the SQLite tables after network confirmation.
   - On confirmation (`status: 'synced'`), apply the server result (authoritative server version) and mark outbox row `synced` in a single SQLite transaction.
   - On process restart, rows left in `processing` become `retrying` with the **exact same** `idempotencyKey`.
   - Never skip an outbox insert because an active row exists for that entity; operations on the same entity queue in order of occurrence.

---

## Section 3: Error Classification & Retry Policy
1. **Typed Errors:**
   - Client throws typed `SyncHttpError` holding HTTP status and error code.
   - Zero string-matching on error message text.
2. **HTTP Status Handling:**
   - **HTTP 426 (`Upgrade Required`):** Client version is obsolete. Sync engine transitions to `update_required`, halts all sync cycles, and preserves local data and outbox unmodified.
   - **HTTP 410 (`FULL_RESYNC_REQUIRED`):** Change stream cursor is older than `minRetainedSeq`. Engine uploads pending outbox rows, initiates snapshot download (`POST /sync/snapshot/start`), paginates records (`GET /sync/snapshot/:id/page`), and updates local database.
   - **HTTP 409 (`Conflict`):** Reserved strictly for version conflicts.
   - **HTTP 422 (`Unprocessable Entity`):** Business-rule/validation failure or `IDEMPOTENCY_KEY_REUSED`. Status is `rejected` with `permanent: true` (no client retry).
   - **HTTP 500 / Network Failures:** Transient errors follow exponential backoff: 5s, 15s, 1 min, 5 min, then every 15 min. After 20 consecutive HTTP 500 attempts, event moves to `needs_attention`.

---

## Section 4: Backend Sequence-Based Change Feed
1. **School Sequences:**
   - Collection `school_sequences`: `{ schoolId, seq }`.
   - Atomic `$inc` on `seq` per school inside the caller's active transaction via `nextSeq(session, schoolId)`.
2. **SyncChangeLog:**
   - Fields: `schoolId`, `seq` (Number, required), `version` (Number), `deleted` (Boolean), `actorId`, `visibleToRoles` (`[String]`), `originDeviceId`, `payload`, `timestamp`.
   - Unique index: `{ schoolId: 1, seq: 1 }`.
   - Ordered strictly by `seq: 1`.
3. **Transaction Requirement:**
   - `recordChange` requires an active MongoDB transaction (`inTransaction()`). Throws if called outside `atomic()`.
   - `atomicGuardPlugin` logs warnings in dev, and throws in test mode when `SYNC_GUARD_STRICT=1`.
4. **Stream Endpoint:**
   - `GET /sync/changes?after=<seq>&limit=<=500`: returns `{ changes, hasMore, latestSeq, minRetainedSeq }`.
   - Filters changes by `visibleToRoles` matching the caller's role.
   - If `after < minRetainedSeq`, returns HTTP 410 `FULL_RESYNC_REQUIRED`.
   - `minRetainedSeq`: Highest pruned sequence number (0 if nothing pruned).

---

## Section 10: Outbox States
The desktop outbox schema enforces exactly six discrete states:
1. `pending`: Queued for dispatch.
2. `processing`: In flight over the network.
3. `retrying`: Transient failure; awaiting scheduled retry.
4. `synced`: Confirmed by central server.
5. `conflict`: Server conflict requiring resolution.
6. `needs_attention`: Permanent rejection or 20+ consecutive HTTP 500 failures requiring administrative intervention.
