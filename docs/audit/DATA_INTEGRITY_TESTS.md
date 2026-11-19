# Data integrity and interrupted workflows

Date: 17 Oct 2026. Crash tests run a real workflow in a **separate process**, stop it at a
checkpoint between two of its database writes, kill it hard (no cleanup code runs), then
inspect the database (`tests/fault/crash-child.ts`, `tests/fault/crash.ts`).

- `tests/data-integrity.replset.test.ts` — single-node **replica set** (minimum production topology).
- `tests/data-integrity-standalone.test.ts` — standalone server, to document the limitation.

## Which workflows need atomicity

| Workflow | Documents written | Now |
|---|---|---|
| Record payment | invoice (paid/balance/status), receipt counter, payment, audit | **Transaction** (`fees.service.recordPayment`) |
| Reversal / waiver / cancellation / concession / expense approval | approval claim, payment or invoice, approval status, audit | **Transaction** for these handlers (`transactional: true`) |
| Admission | parents, student, parent logins, account tokens, links | **Transaction** (`students.service.createStudent`) |
| Staff + login | employee, user, employee↔user link, token | **Transaction** (`POST /employees`) |
| School onboarding | school, campus, Admin user, activation token | **Transaction** (platform route + `onboardSchool`) |
| Messaging approvals (fee reminders, message batches, announcements) | external sends | **Not** in a transaction on purpose (a retry must never resend). Unchanged: claim, then send; delivery status recorded per message. |
| Invoice generation | many invoices | Idempotent per student/period (unique), not transactional |

Transactions run only on a replica set / Atlas (`database/transactions.ts`); on standalone the
existing compensating rollbacks still handle thrown errors. Production refuses to start on
standalone unless `ALLOW_STANDALONE_MONGODB=true`.

## Results

| Test | Topology | Expected | Observed | Status |
|---|---|---|---|---|
| Payment: process killed after the balance update, before payment/receipt | replica set | No balance change, no payment | Balance and paid unchanged; 0 payments | PASS |
| — client retries with the same idempotency key | replica set | Recorded once | 201; replay returns `replayed: true`; balance reduced once; exactly 1 payment with a receipt number | PASS |
| Payment: error thrown between writes | replica set | Rolled back, no internals in response | 500 with generic message; balance unchanged | PASS |
| 8 concurrent payments on one invoice | replica set | Never over-settled; `paid` = Σ payments | As expected; statuses only 201/409/422 | PASS |
| Reversal approval: killed after payment marked reversed, before invoice restored | replica set | Nothing changed; request still pending | Payment `valid`, balance unchanged, request `pending`; approving again → `executed`, balance restored exactly | PASS |
| Onboarding: killed after school + campus, before Admin | replica set | No school | 0 schools with that code | PASS |
| Admission: killed after parent + student, before parent login | replica set | No student, no parent | 0 / 0; same admission then succeeds (1 parent, no duplicate) | PASS |
| **Payment crash on standalone** | standalone | (documents the risk) | **Balance reduced by 700 with no payment record** | LIMITATION REPRODUCED |
| Production start on standalone | — | Refused unless explicitly allowed | Refused; allowed with the flag; replica set accepted | PASS |
| Existing financial suites (`fees.test.ts`, idempotency, overpayment, waiver approvals) | standalone | Unchanged behaviour | Pass (full suite) | PASS |
| Duplicate-login prevention under concurrency (`accounts-roles.test.ts`) | standalone | One login | Pass | PASS |

## Defects found and fixed

| ID | Severity | Finding | Fix |
|---|---|---|---|
| I1 | High | **Payment recording was not crash-safe**: the invoice balance was reduced first and the payment written after; a crash in between lost the money trail, and the client's retry (same idempotency key) reduced the balance a second time. Compensation only ran for thrown errors. | Transaction on replica sets; production requires a replica set. |
| I2 | High | Same class of defect for approval execution (payment marked reversed but invoice not restored), admissions, staff logins and onboarding (orphans after a crash). | Transactions as listed above. |
| I3 | Medium | Introduced and caught during this work: `createStudent` / `createUser` ran two queries with `Promise.all` inside the new transaction ("Only servers in a sharded cluster can start a new transaction at the active transaction number"). | Sequential queries; rule documented in `atomic()`. |

## Not covered

- Transactions on MongoDB Atlas specifically (same server feature; not exercised against Atlas).
- External side effects with an outbox: messages are recorded per recipient with honest
  statuses, but a crash between "provider accepted" and "status saved" could still re-send on a
  manual retry. Messaging is switched off by default (`*_ENABLED=false`).
- Load-level contention between transactions (only 8-way concurrency tested).
