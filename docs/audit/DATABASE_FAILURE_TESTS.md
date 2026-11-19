# Database failure tests

Date: 17 Oct 2026. Automated: `tests/database-failure.test.ts` (the test owns a separate
MongoDB 8.2.6 process on disk, so it can stop and restart it without touching anything else).
Manual on staging: migration during an outage (see MIGRATION_VERIFICATION.md step 6).

| Scenario | Procedure | Expected | Observed | Status |
|---|---|---|---|---|
| DB unavailable at API start | `src/server.ts` with `MONGODB_URI` pointing at a closed port | Exit non-zero quickly so systemd/PM2 retries | Exit code 1 after 2.3 s ("Failed to start") | PASS |
| DB stops after start — liveness | Stop mongod; `GET /health` | 200 (no restart loop) | 200 | PASS |
| — readiness | `GET /health/ready` | 503 | 503 `not_ready` within 4 ms of the stop | PASS |
| — request during outage | `POST` payment | Controlled 503, no internals, bounded wait | `503 SERVICE_UNAVAILABLE`, `Retry-After: 5`, body contains no URI/host/driver error/stack; failed after 10.0 s (driver buffer timeout) | PASS (after fix D1) |
| DB restarts | Restart mongod on the same data | Recovers without restarting the API | Readiness 200 8.4 s after mongod restarted; existing sessions still valid | PASS |
| No partial write from the failed request | Count payments for the invoice | 0 | 0; retry with the same idempotency key recorded exactly 1 payment and reduced the balance once | PASS |
| Acknowledged writes survive an abrupt DB stop | Write, then hard-stop mongod (Windows: process kill), restart | Write present | Present 3/3 runs with the fix; **lost 3/3 runs without it** | PASS (after fix D2) |
| Error classification | Unit: driver error names | Outage → 503; duplicate key → 409; bugs → 500 | As expected | PASS |
| Duplicate-key errors | Existing suites | 409 `DUPLICATE`, field name only | As expected (existing tests) | PASS |
| Interrupted migration + restart | MIGRATION_VERIFICATION.md 5–8 | Re-run completes, no double updates | As expected | PASS |
| Connection-pool exhaustion / acquisition timeout | — | — | Not reproduced (needs server-side slow operations, `sleep` test command not enabled). Classification of `MongoWaitQueueTimeoutError` / `MongoPoolClearedError` as 503 is unit-tested. | NOT RUN |
| Slow queries | — | — | Not injected. | NOT RUN |
| Replica-set failover (primary change) | — | — | Single-node replica sets only. | NOT RUN |
| Transient network partition (not a stop) | — | — | Not simulated (no network fault tooling). | NOT RUN |

## Defects fixed

| ID | Finding | Fix |
|---|---|---|
| D1 | Database outages were reported as `500 INTERNAL_ERROR` (and logged as unexpected bugs, each trying to write an error event to the unavailable database). Clients could not tell a temporary outage from a defect. | `isDatabaseUnavailable()` in `middleware/error-handler.ts`: driver connectivity errors and Mongoose buffer timeouts → `503 SERVICE_UNAVAILABLE` + `Retry-After`, logged as a warning. |
| D2 | **Data loss on crash**: the connection used the default write concern (`w:1`, no journal acknowledgement on a standalone server). Writes the API had already confirmed (HTTP 201) were missing after MongoDB was killed and restarted. Reproduced deterministically. | Connection write concern `{ w: 'majority', journal: true }` in `database/connection.ts`. |

## Behaviour and limits (as observed)

- During an outage each request waits up to ~10 s (`serverSelectionTimeoutMS` / Mongoose
  `bufferTimeoutMS`) before failing with 503. The frontends show their error state.
- Retries are safe for payments only when the client sends an `idempotencyKey` (the school app
  does). Other create operations should not be blindly retried by a client.
- After a crash on a replica set, a transaction left open by the dead process holds its
  documents until MongoDB aborts it (`transactionLifetimeLimitSeconds`, default 60 s): a retry
  on the same invoice may wait up to a minute, then succeeds (observed with a 10 s limit in tests).
