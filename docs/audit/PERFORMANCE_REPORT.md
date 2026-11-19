# Performance report

> **Superseded in part (17 Oct 2026):** see [FINAL_STAGING_VERIFICATION.md](FINAL_STAGING_VERIFICATION.md) for the current results and decision. This report is kept as the 14 Oct baseline.

## How it was measured

- Tool: `npm run loadtest` (`scripts/load-test/run.ts`, no extra dependencies). The API runs as a **separate process** (`src/server.ts`, the production entry point) so the load generator does not share its event loop; a wrapper prints server event-loop delay, RSS and CPU every second.
- Data: throwaway in-memory MongoDB 8.2, 2 schools × 400 students, 10 classes × 2 sections, 6 subjects, 10 teachers, 120 teaching assignments per school, one month of fee invoices. Seeded through the real API.
- Machine: Windows 11, 8 logical CPUs, Node 22.23.3. API, MongoDB and load generator **on the same machine**. bcrypt cost 12 (production default). Rate limits raised for the run (otherwise the test measures the limiter, not the server).
- Mix (closed loop, random pick per request): student search, student detail, admin dashboard, attendance roster, invoices list, teacher homework list, teacher student list, setup guide.
- Raw results: `docs/audit/load-test-results.json`.

**These are baselines on a developer machine, not a capacity claim.** No number of schools or users is claimed. Re-run on staging hardware with a real MongoDB before sizing production.

## Results (14 Oct 2026)

| Stage | VUs | Requests | RPS | Errors | p50 ms | p95 ms | p99 ms | Server event-loop p99 ms | RSS MB | Server CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| login | 5 | 77 | 7.3 | 0% | 612 | 1003 | 1066 | 40 | 339 | 377 |
| login | 20 | 100 | 8.1 | 0% | 2463 | 2544 | 2577 | 23 | 340 | 399 |
| mixed | 5 | 2965 | 148 | 0% | 31 | 57 | 87 | 39 | 456 | 118 |
| mixed | 20 | 2822 | 141 | 0% | 135 | 208 | 253 | 75 | 478 | 109 |
| mixed | 50 | 2828 | 140 | 0% | 328 | 510 | 559 | 71 | 473 | 106 |

Per endpoint at 50 VUs (ms): student detail p95 334 · invoices 349 · attendance roster 329 · student search 343 · teacher homework 416 · teacher students 486 · admin dashboard 553 · setup guide 556.

## Findings

1. **Fixed — login blocked the whole API.** Before the fix (bcrypt on the main thread) a 5-user login burst produced ~808 ms event-loop p99 (smoke run): every other request in every school stalled. With the worker-thread pool the event loop stays at 23–40 ms p99 during login bursts. Login itself stays deliberately slow (~8/s on this machine at cost 12) — that is the password-hashing cost, now isolated from other traffic.
2. **Throughput ceiling ≈ 140–150 req/s per process**, reached at ~5 VUs; beyond that latency grows linearly (queueing), errors stay at 0. Server CPU ~1 core: Node runs JavaScript on one thread. Per request the API does authentication (user + school lookups), permission resolution, the query and logging.
3. **Heaviest endpoints**: dashboard and setup guide (several aggregations each, by design run on demand), then teacher-scoped lists (teacher scope = 3 small queries per request, memoised per request).
4. No memory growth across stages (RSS ~470 MB steady, includes the in-process seeding data structures in the child).

## Recommendations (in order)

1. Run several API processes (PM2 cluster or several systemd units behind nginx) — throughput scales with cores. **Requires** a shared rate-limit store (Redis) first (KNOWN_ISSUES K2).
2. If dashboards become hot, cache their aggregates per school for 30–60 s (tenant-keyed). Not done now: not a bottleneck at measured load and stale counts confuse users.
3. Do **not** cache user/school status in authentication: suspension and disabling must take effect immediately.
