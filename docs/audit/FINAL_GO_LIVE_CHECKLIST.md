# Final go-live checklist

Tick each item on the real server. Items marked ✅ were verified in the October 2026 staging
verification; everything else must be done by you on the target machine.

## A. Blockers for a supervised pilot

- [ ] MongoDB runs as a **replica set** (single node is fine) or Atlas, with authentication, bound to 127.0.0.1 / IP-restricted. (App behaviour on a replica set ✅; your server ❌)
- [ ] The deployment guide (docs/DEPLOYMENT.md) has been **rehearsed on a spare Ubuntu machine/VM** and LINUX_DEPLOYMENT_TEST_RESULTS.md filled in (reboot, crash restart, ports closed, TLS renewal).
- [ ] `BACKUP_ENCRYPTION_KEY` generated, stored in a password manager **and** offline; key id noted.
- [ ] `PLATFORM_ALLOWED_IPS` set to LAN/VPN; nginx restricts `console.` and `/api/v1/platform/`. From outside the network the console and platform login are unreachable.
- [ ] `TRUST_PROXY=1` behind nginx (with `X-Forwarded-For $remote_addr`).
- [ ] First backup created **on the real server**, downloaded to the PC, `Get-FileHash` OK and `npm run backup:verify` PASS.
- [ ] One full **restore drill** from that download into a scratch database on another machine: `RESULT: PASS`. (Procedure ✅ on staging; on your data ❌)
- [ ] If upgrading existing data: dry runs of `migrate:2026-10`, `migrate:plan-entitlements`, `migrate:retire-student-logins` and `db:indexes` reviewed; duplicates resolved; then applied (procedure ✅ on legacy staging data).

## B. Configuration

- [ ] `NODE_ENV=production`, two new random JWT secrets, `CORS_ORIGINS` exact origins, `API_DOCS_ENABLED=false`, `SEED_DEMO_PASSWORD` unset.
- [ ] `STORAGE_DIR` and `BACKUP_DIR` under `/var/lib/school-os`, owned by `schoolos`, mode 700.
- [ ] `BACKUP_SCHEDULE_ENABLED=true`; `BACKUP_RETENTION_COUNT` fits the disk.
- [ ] Messaging channels stay off (`*_ENABLED=false`) until credentials are verified.
- [ ] Startup log shows no warnings you have not accepted (`journalctl -u school-os -b`).
- [ ] Frontends built with the public API URL; console built with `NEXT_PUBLIC_SCHOOL_APP_URL`.
- [ ] Platform owner created with a strong unique password; no demo data (`brightfuture.example`) in the production database.

## C. Verified in staging (re-check quickly after deploying)

- ✅ Backend 319/319 automated tests; school app 75/75 and console 25/25 Playwright against production builds + staging API + replica set.
- ✅ Cross-tenant probe: 3,422 requests, 0 leaks, other school's data unchanged.
- ✅ Crash-at-checkpoint tests for payments, reversals, admissions, onboarding: no partial data.
- ✅ DB outage: readiness 503, controlled 503 errors, automatic recovery, no lost acknowledged writes.
- ✅ Backup → download → verify → restore onto an empty instance → sign-in and balances identical.
- ✅ No source maps or secrets in browser bundles; Swagger off; security headers present.
- [ ] After deploying: `curl https://api.<domain>/health/ready` = 200; sign in to both apps; one test payment on a test school, then reverse it via approval.

## D. Operations

- [ ] Uptime monitor on `/health/ready`.
- [ ] Weekly: download the newest backup to the PC (and a second location); check free disk.
- [ ] Monthly: restore drill (BACKUP_RESTORE.md §7).
- [ ] journald size limit set; `certbot renew --dry-run` passes.
- [ ] Delete `school-os-backend/.env.backup-before-ai` from the development PC when no longer needed.

## E. Before unrestricted public launch (not required for the supervised pilot)

- [ ] MFA (TOTP or SSO) for platform administrators — then the console may be exposed beyond the LAN/VPN.
- [ ] Re-measure performance on the home server; tune `RATE_LIMIT_MAX` for schools behind NAT.
- [ ] Outbox/idempotency for external messaging before enabling paid channels at volume.
- [ ] Decide on point-in-time recovery (Atlas continuous backup) if a 24 h recovery point is too long.
- [ ] External penetration test.
