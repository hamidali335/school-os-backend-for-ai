# Student leave requests

Parents tell the school in advance (or up to 7 days afterwards) that a child will be or was away. Class teachers see and comment; school administrators decide. Module: `src/modules/leave`.

## Who can do what

| Role                                                           | Submit                                        | See                                    | Review note        | Approve / reject             | Withdraw                         |
| -------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- | ------------------ | ---------------------------- | -------------------------------- |
| Parent (`leave:request`, `leave:read`)                         | For their own children                        | Their children's requests              | —                  | —                            | Their own request, while pending |
| Teacher (`leave:read`)                                         | —                                             | Sections they are **class teacher** of | Yes, while pending | **No**                       | —                                |
| School owner, principal, office administrator (`leave:decide`) | —                                             | All (within their campuses)            | —                  | Yes, never their own request | Yes, while pending               |
| Custom-role staff                                              | Only if granted `leave:read` / `leave:decide` |                                        |                    |                              |                                  |
| Accountant                                                     | —                                             | —                                      | —                  | —                            | —                                |

Everything outside a user's visibility answers **404**, so ids reveal nothing. Tenant scoping applies to every query.

## Rules

- Dates are inclusive `YYYY-MM-DD` school dates: at most **30 days**, starting no earlier than **7 days ago** and no later than **120 days ahead**; `to` ≥ `from`.
- A pending or approved request for the same child overlapping the dates → `409 LEAVE_OVERLAP`. Cancelled and rejected requests do not block. Simultaneous duplicate submissions leave exactly one request (the later one gives way).
- Only `pending` requests can be reviewed, decided or withdrawn (`409 LEAVE_NOT_PENDING` otherwise). The decision is an atomic claim, so two administrators deciding at once record exactly one decision.
- **Attendance is never changed.** `GET /attendance/sections/{id}` adds `onApprovedLeave: true` for students with approved leave that day, as a hint; the teacher still marks the register.

## History and audit

Each request keeps an append-only `history` (`submitted`, `reviewed`, `approved`, `rejected`, `cancelled`) with who (`byName`, `byRole`), when and the note. Audit log actions: `leave.submit`, `leave.review`, `leave.approved`, `leave.rejected`, `leave.cancel`.

In-app notifications: the class teacher and administrators on submission; the parent on the decision (category `leave`, link `/leave-requests/{id}`).

## Endpoints

`POST /leave-requests`, `GET /leave-requests` (filters `status`, `studentId`, `classId`, `sectionId`, `from`, `to`; paginated; the filters only narrow what the user may already see), `GET /leave-requests/{id}`, `POST /leave-requests/{id}/review`, `POST /leave-requests/{id}/decision`, `POST /leave-requests/{id}/cancel`. Schemas in `docs/openapi.json`.

## Deployment notes

- New collection `leaverequests` with indexes `{schoolId, status, createdAt}`, `{schoolId, studentId, from}`, `{schoolId, sectionId, status, from}`. Create them with `npm run db:indexes -- --apply` after deploying (the command shows changes first and drops nothing unless asked).
- New permissions `leave:request`, `leave:read`, `leave:decide` are part of the built-in roles automatically (the role map is code). Custom roles get them only when an Admin grants them. They belong to the `core.attendance` plan feature.
- Website: **Leave requests** (`/leave-requests`, under Academics). Parents request and withdraw; class teachers add review notes; administrators filter by status, class, section, child and dates, then approve or reject with a note. Open pages check for a decision every 30 seconds while a request is pending (the mobile app does the same).
- Not included: staff leave requests, and file attachments (medical notes).
