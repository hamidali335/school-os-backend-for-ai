# Linux deployment — test results

Date: 17 Oct 2026. **No Linux machine, VM, WSL or container runtime was available** on the
verification host (Windows 11; WSL not installed, no Docker). Linux-specific checks are therefore
BLOCKED. Nothing was changed on the live home server.

What *was* executed instead: the compiled backend in `NODE_ENV=production` and both frontends as
production builds (`next start`) against a MongoDB 8.2.6 replica set on Windows staging — see
FINAL_STAGING_VERIFICATION.md.

| Check | Status | Evidence / note |
|---|---|---|
| Supported Node.js version | PASS (Windows) | Node 22.23.3; `engines: >=20.11`. |
| Install from lockfiles | PASS (Windows) | Existing `node_modules` from `npm ci`-compatible lockfiles; builds succeeded. Clean `npm ci` on Linux: BLOCKED. |
| Production builds | PASS | `npm run build` (backend), `next build` (both apps). |
| Production environment validation | PASS | Refuses missing/placeholder/identical secrets, empty CORS, `BACKUP_DIR` inside `STORAGE_DIR`, standalone MongoDB (unless allowed); warns for `TRUST_PROXY=0`, empty `PLATFORM_ALLOWED_IPS`, backups unconfigured. Observed in staging logs. |
| Swagger off in production | PASS | `/api-docs.json` → 404. |
| Security headers | PASS | API: CSP, HSTS, nosniff, frame options (helmet). Apps: CSP with `frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff, referrer policy; console adds `noindex`. |
| No source maps / secrets in browser bundles | PASS | 0 `.map` files; no secret values found in either build. |
| Health / readiness semantics | PASS | DATABASE_FAILURE_TESTS.md. |
| Exit non-zero when DB is down at start (for systemd restart) | PASS | Exit 1 after 2.3 s. |
| Dedicated non-root service account | BLOCKED | Documented (`schoolos`, nologin). |
| File ownership / permissions (`STORAGE_DIR`, `BACKUP_DIR` 700, files 600, `.env` 600) | BLOCKED | Application writes files with mode 600 and backup folders 700 (code); Linux permissions not observed. |
| systemd units, hardening, start after reboot, crash restart | BLOCKED | Units in docs/DEPLOYMENT.md §5 (not run). |
| Graceful shutdown on SIGTERM | BLOCKED | Windows cannot deliver SIGTERM to Node; code reviewed. |
| nginx reverse proxy, `X-Forwarded-For` handling, request size/timeouts | BLOCKED | Config in §6. Trusted-proxy logic verified in an automated test (`security-surface.test.ts`: spoofed left-most XFF ignored with one trusted proxy). |
| HTTPS + certificate renewal | BLOCKED | certbot steps documented. |
| Firewall / internal ports not exposed | BLOCKED | ufw rules documented; services bind 127.0.0.1 in the guide. |
| Platform console / API restricted to LAN/VPN | PARTIAL | Backend allow-list tested automatically; nginx `allow/deny` not run. |
| Log rotation | BLOCKED | journald `SystemMaxUse` documented. |
| Disk-space monitoring | BLOCKED | Pre-backup free-space check implemented; host monitoring documented only. |
| Backup storage on Linux | BLOCKED | Backup/restore executed on Windows staging (BACKUP_RESTORE_TEST_RESULTS.md). |
| Deployment rollback | BLOCKED | Procedure in §9. |
| MongoDB auth / network restriction | BLOCKED | Staging MongoDB ran without auth on 127.0.0.1; production config documented (§2). |

## To do on a spare Ubuntu machine before go-live

Follow docs/DEPLOYMENT.md exactly, then record PASS/FAIL here for: reboot (all services back,
readiness 200), `kill -9` of the API (systemd restarts it), `systemctl stop school-os`
(graceful), `curl` from another LAN host to ports 4000/3000/3001/27017 (must fail), console from
outside the allow-list (must 404/403), `certbot renew --dry-run`, a backup + download + restore
drill on that machine, and a rollback to the previous release.
