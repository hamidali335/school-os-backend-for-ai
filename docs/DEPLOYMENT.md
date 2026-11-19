# Deployment Guide — Ubuntu home server (no Docker)

Target: one Ubuntu 24.04 LTS (or 22.04) machine running the API, both web apps, nginx and
MongoDB, or the API + apps with MongoDB Atlas. Three independent repositories:
`school-os-backend`, `school-management-software-frontend` (school app),
`school-os-admin-panel` (platform console).

> **Verification status.** The commands below were reviewed but **not executed on Linux** in
> the October 2026 verification (no Linux VM was available; see
> [`audit/LINUX_DEPLOYMENT_TEST_RESULTS.md`](audit/LINUX_DEPLOYMENT_TEST_RESULTS.md)). The
> application itself was run in production mode against a MongoDB 8.2 replica set on Windows
> staging. Rehearse this guide on a spare machine or VM before using it on the real server.

## 0. Requirements that are enforced

| Requirement | Why | Enforced by |
|---|---|---|
| **MongoDB replica set** (one node is enough) or Atlas | Payments, reversals, admissions, staff logins and onboarding are written in transactions; a standalone server cannot do that and a crash can leave partial data. | API refuses to start in production on standalone unless `ALLOW_STANDALONE_MONGODB=true`. |
| Journaled, majority writes | An acknowledged payment must survive a power cut. | Connection write concern `{ w: 'majority', journal: true }`. |
| Two different random JWT secrets, `CORS_ORIGINS` | Session security. | Startup validation. |
| `BACKUP_DIR` separate from `STORAGE_DIR` | A backup must not include itself or be served. | Startup validation. |
| Node.js 22 LTS (≥ 20.11) | | `engines`. |

## 1. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install nginx ufw git curl
# Node.js 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt -y install nodejs
node -v   # v22.x

# Service account (no login shell) and folders
sudo useradd --system --create-home --home-dir /opt/school-os --shell /usr/sbin/nologin schoolos
sudo install -d -o schoolos -g schoolos -m 700 /var/lib/school-os /var/lib/school-os/storage /var/lib/school-os/backups
sudo install -d -o schoolos -g schoolos -m 750 /opt/school-os
```

Firewall — only SSH and HTTPS from outside; the API (4000), apps (3000/3001) and MongoDB (27017)
listen on 127.0.0.1 only:

```bash
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full'
sudo ufw enable && sudo ufw status verbose
```

On a home network also forward only ports 80/443 on the router, and keep SSH reachable only
from the LAN or a VPN (Tailscale/WireGuard).

## 2. MongoDB as a single-node replica set (skip when using Atlas)

Install MongoDB 8.0 Community from the official repository (mongodb.com → Install on Ubuntu), then:

```bash
# Key file for internal auth (required once authorization is on, even with one node)
sudo openssl rand -base64 756 | sudo tee /etc/mongod.keyfile >/dev/null
sudo chown mongodb:mongodb /etc/mongod.keyfile && sudo chmod 400 /etc/mongod.keyfile
```

`/etc/mongod.conf` (relevant parts):

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1
replication:
  replSetName: rs0
security:
  authorization: enabled
  keyFile: /etc/mongod.keyfile
```

```bash
sudo systemctl enable --now mongod
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
# Admin and application users (choose strong passwords; store them in your password manager)
mongosh admin --eval 'db.createUser({user:"admin",pwd:passwordPrompt(),roles:["root"]})'
mongosh -u admin admin --eval 'db.getSiblingDB("admin").createUser({user:"schoolos",pwd:passwordPrompt(),roles:[{role:"readWrite",db:"school_os"}]})'
```

`MONGODB_URI=mongodb://schoolos:<password>@127.0.0.1:27017/school_os?replicaSet=rs0&authSource=admin`

Atlas: create a dedicated database user with `readWrite` on `school_os`, restrict the IP access
list to your server's public IP, and use the `mongodb+srv://…/school_os?retryWrites=true&w=majority` URI.
Enable Atlas Cloud Backup as an extra layer (it does not include `STORAGE_DIR`).

## 3. Backend

```bash
sudo -u schoolos -s /bin/bash   # work as the service user from here
cd /opt/school-os
git clone <backend repo> school-os-backend && cd school-os-backend
git checkout <release tag or commit>
npm ci
npm run build
cp .env.example .env && chmod 600 .env && nano .env
```

Production `.env` essentials (see `.env.example` for all settings):

```ini
NODE_ENV=production
PORT=4000
TRUST_PROXY=1                       # exactly one proxy (nginx) in front
MONGODB_URI=...                     # §2
JWT_ACCESS_SECRET=...               # openssl rand -base64 48
JWT_PLATFORM_SECRET=...             # different value
CORS_ORIGINS=https://app.example.pk,https://console.example.pk
STORAGE_DIR=/var/lib/school-os/storage
BACKUP_DIR=/var/lib/school-os/backups
BACKUP_ENCRYPTION_KEY=...           # npm run backup:keygen — copy it to your password manager + offline
BACKUP_SCHEDULE_ENABLED=true
PLATFORM_ALLOWED_IPS=127.0.0.1,::1,192.168.1.0/24   # LAN / VPN range only (no MFA yet)
SETTINGS_ENCRYPTION_KEY=...         # optional; keep it if you set it (encrypts saved AI keys)
API_DOCS_ENABLED=false
# SEED_DEMO_PASSWORD must be unset
```

First-time database setup:

```bash
npm run db:indexes                    # report what will be created
npm run db:indexes -- --apply         # create indexes (drops nothing)
PLATFORM_OWNER_EMAIL=you@example.pk PLATFORM_OWNER_NAME="Your Name" PLATFORM_OWNER_PASSWORD='…' npm run create-platform-owner
NODE_ENV=production node dist/server.js   # quick check: "listening", then Ctrl-C
exit                                  # back to your admin user
```

Keep dev dependencies installed (`tsx` runs `db:indexes`, migrations and the backup tool).

## 4. Frontends

`NEXT_PUBLIC_*` values are compiled into the bundles at build time and are public.

```bash
sudo -u schoolos -s /bin/bash
cd /opt/school-os
git clone <school app repo> school-management-software-frontend && cd school-management-software-frontend
git checkout <release> && npm ci
NEXT_PUBLIC_API_BASE_URL=https://api.example.pk/api/v1 npm run build
cd /opt/school-os
git clone <admin panel repo> school-os-admin-panel && cd school-os-admin-panel
git checkout <release> && npm ci
NEXT_PUBLIC_API_BASE_URL=https://api.example.pk/api/v1 NEXT_PUBLIC_SCHOOL_APP_URL=https://app.example.pk npm run build
exit
```

Production builds contain no source maps (verified for both apps).

## 5. systemd services

`/etc/systemd/system/school-os.service`:

```ini
[Unit]
Description=School OS API
After=network-online.target mongod.service
Wants=network-online.target

[Service]
User=schoolos
Group=schoolos
WorkingDirectory=/opt/school-os/school-os-backend
EnvironmentFile=/opt/school-os/school-os-backend/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# The API exits non-zero when MongoDB is unreachable at start; systemd retries every 5 s.
StartLimitIntervalSec=0
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/school-os
UMask=0077

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/school-app.service` (and `school-console.service` with the admin panel
folder and `-p 3001`):

```ini
[Unit]
Description=School OS school app
After=network-online.target

[Service]
User=schoolos
WorkingDirectory=/opt/school-os/school-management-software-frontend
Environment=NODE_ENV=production
ExecStart=/usr/bin/npx next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now school-os school-app school-console
systemctl status school-os --no-pager
curl -fsS http://127.0.0.1:4000/health/ready
```

`SIGTERM` stops the scheduler, finishes in-flight requests (≤ 15 s) and closes the database.
Logs go to journald: `journalctl -u school-os -f`. Limit journald size in
`/etc/systemd/journald.conf` (`SystemMaxUse=1G`) and `sudo systemctl restart systemd-journald`.

## 6. nginx + TLS

```nginx
# /etc/nginx/sites-available/school-os
server {                       # API
  server_name api.example.pk;
  client_max_body_size 12m;    # >= MAX_UPLOAD_MB
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite: do not trust client-sent values
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
    proxy_read_timeout 120s;   # backup downloads stream for a while
  }
  # App voice call signaling (WebSocket, docs/VOICE_CALLS.md): needs the upgrade headers.
  location = /api/v1/calls/socket {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;  # long-lived; the server pings every 25 s
  }
  # Platform API: LAN/VPN only (defence in depth with PLATFORM_ALLOWED_IPS).
  location /api/v1/platform/ {
    allow 192.168.1.0/24;      # your LAN
    allow 100.64.0.0/10;       # Tailscale, if used
    deny all;
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600s;
    proxy_buffering off;       # stream backup archives
    access_log off;            # download links are single-use, but keep them out of logs
  }
}
server { server_name app.example.pk;     location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; } }
server {                       # Platform console: LAN/VPN only
  server_name console.example.pk;
  allow 192.168.1.0/24; allow 100.64.0.0/10; deny all;
  location / { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/school-os /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.pk -d app.example.pk -d console.example.pk
sudo certbot renew --dry-run      # renewal timer is installed automatically
```

With `TRUST_PROXY=1` and nginx overwriting `X-Forwarded-For` with `$remote_addr`, rate limits
and `PLATFORM_ALLOWED_IPS` see the real client address.

## 7. Health, monitoring, disk

- Liveness `GET /health` (no database; a DB outage does not cause restart loops).
- Readiness `GET /health/ready` → 503 while MongoDB is unreachable; point an uptime monitor here.
- During an outage requests fail after ≈10 s with `503 SERVICE_UNAVAILABLE` and recover on their own.
- Platform console → System Health / Errors.
- Disk: backups need ≈1.5 × data size free while running. Check weekly, e.g. a cron mail when
  `/var/lib` is over 80 %: `df --output=pcent /var/lib | tail -1`.

## 8. Backups

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md). With `BACKUP_SCHEDULE_ENABLED=true` the API makes a
verified, encrypted full backup every 24 h. **Download them to your PC regularly** (admin panel →
Backups); a backup that only lives on this server is lost with it.

## 9. Upgrades and rollback

```bash
# 0. Download a fresh verified backup to your PC first (admin panel → Backups).
sudo -u schoolos -s /bin/bash
cd /opt/school-os/school-os-backend
git fetch && git checkout <new release>
npm ci && npm run build
npm run db:indexes                         # review the report
# Run the release's migrations as documented below, dry run first.
npm run db:indexes -- --apply              # create new indexes; nothing is dropped
npm run db:indexes -- --apply --drop-obsolete   # only after reviewing the OBSOLETE/REPLACE list
exit
sudo systemctl restart school-os && curl -fsS http://127.0.0.1:4000/health/ready
```

`db:indexes` writes every collection's current index definitions to
`BACKUP_DIR/index-snapshot-<time>.json` before changing anything, creates all missing indexes
before dropping any, stops without dropping if a new (e.g. unique) index cannot be built, and
restores an index's old definition if its replacement fails.

**Rollback:** `git checkout <previous release> && npm ci && npm run build && sudo systemctl
restart school-os`. Code-only releases roll back like this. If the release changed data or
indexes, restore the backup taken in step 0 into a new database (BACKUP_RESTORE.md §5) and point
`MONGODB_URI` at it.

### Release notes with data migrations (October 2026)

**Accounts / permissions / setup guide.** Users' email becomes optional and one login per
staff/parent/student is enforced by unique indexes; homework saved without a teacher is
attributed. Order (verified on representative legacy data, see
[`audit/MIGRATION_VERIFICATION.md`](audit/MIGRATION_VERIFICATION.md)):

```bash
npm run migrate:2026-10                    # dry run: duplicate logins + unattributed homework; changes nothing
# resolve reported duplicate logins in the school app (disable/merge), re-run the dry run until none
npm run migrate:2026-10 -- --apply         # safe to re-run, also after an interruption
npm run db:indexes -- --apply              # stops (drops nothing) if a duplicate is still present
npm run db:indexes -- --apply --drop-obsolete   # replaces users.schoolId_1_email_1
```

**Plan entitlements:** `npm run migrate:plan-entitlements` (dry run) then `-- --apply`. See
[SUBSCRIPTION_PLANS.md](SUBSCRIPTION_PLANS.md).

**Retiring student logins:** `npm run migrate:retire-student-logins` (dry run) then `-- --apply`.
Nothing is deleted; student logins are disabled and audited.

Admin panel: set `NEXT_PUBLIC_SCHOOL_APP_URL` and rebuild, so School Admin links are complete.

## 10. Before opening to users

Work through [`audit/FINAL_GO_LIVE_CHECKLIST.md`](audit/FINAL_GO_LIVE_CHECKLIST.md).

## 11. Scaling beyond one instance (not the home-server target)

| Concern | Single instance | Several instances |
|---|---|---|
| Rate limiting | In memory | Shared store (e.g. Redis) in `src/middleware/rate-limit.ts` |
| Uploaded files | Local `STORAGE_DIR` | Shared volume / object storage (`src/services/storage.ts`) |
| Backups | In-process write pause on standalone; snapshot on replica set | Snapshot mode only; one instance with `BACKUP_SCHEDULE_ENABLED` |
| Scheduler | Built in | Safe (atomic rule locks) |
