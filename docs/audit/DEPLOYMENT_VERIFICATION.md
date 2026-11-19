# Deployment verification

> **Superseded in part (17 Oct 2026):** see [FINAL_STAGING_VERIFICATION.md](FINAL_STAGING_VERIFICATION.md) for the current results and decision. This report is kept as the 14 Oct baseline.

## Compiled backend (`dist/`) in production mode

Run from an isolated folder (no `.env`), against a throwaway in-memory MongoDB, `NODE_ENV=production`, bcrypt cost 12:

| Check | Result |
|---|---|
| Starts with no configuration → exits 1 and names the missing variables | PASS |
| Refuses placeholder JWT secrets in production | PASS ("Refusing to start in production with placeholder JWT secrets") |
| Starts in production with valid configuration (indexes created by `scripts/sync-indexes.ts`) | PASS |
| `GET /health/ready` = 200 | PASS |
| Swagger (`/api-docs.json`) off by default in production | PASS (404) |
| Startup warning for `TRUST_PROXY=0` | PASS |
| Platform login (bcrypt in worker threads from the compiled build) | PASS |
| Onboard school with School Admin activation link → activate → sign in → setup guide | PASS |

## Frontends

| Check | School app | Admin panel |
|---|---|---|
| `next build` | PASS | PASS |
| `next start` serves `/login` | PASS (port 3000) | PASS (port 3001) |
| E2E against API at `NEXT_PUBLIC_API_BASE_URL` | 76/76 | 23/23 |

## Configuration reviewed

- Backend env validation (`src/config/env.ts`) rejects missing/short secrets, identical or placeholder secrets and empty `CORS_ORIGINS` in production. New: Swagger off by default in production; warnings for `TRUST_PROXY=0`, docs enabled, scheduler disabled.
- New admin-panel variable: `NEXT_PUBLIC_SCHOOL_APP_URL` (school app address, for School Admin links). Optional; documented in `.env.example`.
- `docs/DEPLOYMENT.md` now has an explicit upgrade procedure for this release (backup → dry-run migration → apply → `db:indexes` → restart) and a rollback note.

## Not verified here

- systemd/PM2 service on Linux, nginx/TLS, `TRUST_PROXY=1` behind a real proxy, graceful `SIGTERM` (Windows host).
- Restore from backup (procedure in `docs/BACKUP_RESTORE.md` reviewed, not executed).
- Running against MongoDB Atlas or an authenticated replica set.
