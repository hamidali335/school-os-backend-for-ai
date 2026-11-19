# Platform console from anywhere (Cloudflare Access)

How to use the Platform Admin Panel (`admin.teachassist.site`) from any network (home Wi-Fi, other Wi-Fi, mobile data) without making it publicly usable with a password alone. There are two ways: only your registered devices (option A, simplest), or Cloudflare Access (option B). It applies to the self-hosted set-up in `guide/` (PM2 + Cloudflare Tunnel).

## Why it only worked on the home Wi-Fi

The platform API (`/api/v1/platform/*`, login included) answers only clients whose address is in `PLATFORM_ALLOWED_IPS`. Everyone else gets a plain `404` (`src/middleware/platform-network.ts`). In production this was set to `127.0.0.1,::1` plus the home connection's public IP (`guide/11-IMPORTANT-NOTES.md`).

- Every device on the home Wi-Fi shares that public IP, so the console worked there.
- From mobile data or any other network, the console page still loads, but sign-in fails with "not found".
- When the ISP changes the home IP, it fails at home too.

This was **intentional**. Platform administrators have no second login factor (MFA) of their own (`docs/audit/KNOWN_ISSUES.md` K1), so the IP rule was the compensating control. It must be replaced by something at least as strong, not just removed.

## Option A (simplest): only your own devices, from any network

No Cloudflare plan, no card. The API accepts platform requests only from browsers registered on the server, from any Wi-Fi or mobile data. Every other device gets `404`, including other devices on the home Wi-Fi, even with the right password. The password is still required on the registered device.

1. Deploy the backend and admin panel versions that include it.
2. API `.env`: `PLATFORM_DEVICE_ONLY=true` (`PLATFORM_ALLOWED_IPS` is then ignored), then `pm2 restart school-os-api`.
3. On the server: `npm run platform:device -- add "My laptop"`. It prints a one-time setup code, valid for 15 minutes and usable once.
4. On the laptop: open the admin panel, click **Set up this device** under the sign-in form, and enter the code. The panel shows "This browser is set up as My laptop". Sign in as usual.

| Task | Command (on the server) |
|---|---|
| See devices | `npm run platform:device -- list` |
| Laptop lost or stolen | `npm run platform:device -- remove "My laptop"` (its key stops working at once) |
| New browser, or browser data cleared | `npm run platform:device -- add "My laptop"` again (new code; the old key stops working) |
| Undo | `PLATFORM_DEVICE_ONLY=false` and restart (back to `PLATFORM_ALLOWED_IPS`) |

The key lives in that one browser's storage (not in a cookie). Only its SHA-256 hash is stored on the server. Keep a lock screen on the laptop: someone with the unlocked laptop **and** your password could sign in.

Backup downloads open as a plain browser link, which cannot carry the key, so `GET /platform/backups/download` is the one other route allowed without it. Its single-use, 2-minute token can only be created by a signed-in owner on a registered device.

## Option B: Cloudflare Access

## The secure replacement

```
browser (any network)
  │  https://admin.teachassist.site/…        ← Cloudflare Access: e-mail one-time code (or your identity provider)
  ▼
Cloudflare ── tunnel ──▶ server
        /api/*, /health  → localhost:4000  (API; Cloudflare adds a signed Access token to each request)
        everything else  → localhost:3001  (admin panel)
```

1. **Cloudflare Access** in front of `admin.teachassist.site`. Nobody reaches the console, or its API on that hostname, without first proving their e-mail (a one-time code, or Google/GitHub sign-in if you set one up). This is the second factor.
2. **Same-origin API for the console.** The tunnel sends `admin.teachassist.site/api/*` straight to the API. The console calls its API on its own hostname, so the Access session covers those calls too. There is no extra proxy hop: the API sees the client address exactly as it does through `smsapi`, so rate limits keep working.
3. **The API checks the Access token itself** (`src/middleware/cloudflare-access.ts`), so the protection does not depend on the tunnel being configured correctly. With `PLATFORM_ACCESS_TEAM_DOMAIN` and `PLATFORM_ACCESS_AUD` set, every platform request must carry Cloudflare's signed `Cf-Access-Jwt-Assertion`. It checks:
   - the signature against the team's published keys;
   - the issuer and this application's audience tag;
   - expiry;
   - optionally, the e-mail (`PLATFORM_ACCESS_EMAILS`).

   Requests without a valid token get `404`, from any network. That includes `smsapi.teachassist.site/api/v1/platform/*`, which is not behind Access, and a stolen platform session token. If Cloudflare's keys cannot be fetched, requests are refused (fail closed).
4. **The password stays.** After Access, the platform login still needs the platform admin's password, with the existing rate limits, lockout and password re-entry for backup download and delete.
5. With Access configured, `PLATFORM_ALLOWED_IPS` is ignored. Keeping it would bring back the "home only" rule, and Access is the stronger control. Unset Access to return to the IP rule.

School apps are unaffected. `smsapi.teachassist.site` and `teachassist.site` get no Access gate, and their API does not require the token.

## Changes to apply (live: needs your go-ahead; nothing below has been applied)

### 1. Cloudflare Access application (Zero Trust dashboard)

*Access → Applications → Add an application → Self-hosted*

- Application name: `School OS Platform Console`
- Session duration: `24 hours` (or shorter)
- Application domain: `admin.teachassist.site`, **path empty** (the whole host, including `/api/*`)
- Policy `Platform owners`:
  - Action **Allow**
  - Include **Emails** = your platform admin e-mail(s)
  - **Not** "Everyone": with one-time PIN that would let any e-mail address in
- Login methods: **One-time PIN** (and/or Google). Turn on "Instant Auth" only if you use a single method.
- Save, then copy the **Application Audience (AUD) Tag** from the application's *Overview* (or *Basic information*) page.
- Your team domain is in *Settings → Custom pages* or the address bar: `https://<team>.cloudflareaccess.com`.

If an Access application for `admin.teachassist.site` already exists (`guide/09` recommended one), keep it. Check that its domain has no path restriction and that its policy lists only your e-mails, and use its AUD tag.

### 2. Tunnel route for the console's API (Zero Trust → Networks → Tunnels → your tunnel → Published applications)

Add a route **above** the existing `admin.teachassist.site` route (first match wins):

| Hostname | Path | Service |
|---|---|---|
| `admin.teachassist.site` | `^/(api/\|health)` | `http://localhost:4000` |
| `admin.teachassist.site` | *(empty)* | `http://localhost:3001` *(existing)* |

No DNS change is needed (same hostname). Nothing new is exposed: no database, SSH or other ports, and no new hostname.

### 3. API `.env` on the server

```ini
PLATFORM_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
PLATFORM_ACCESS_AUD=<the 64-character AUD tag>
PLATFORM_ACCESS_EMAILS=<your platform admin e-mail>
# PLATFORM_ALLOWED_IPS can stay; it is ignored while Access is configured.
```

Then `pm2 restart school-os-api`. The production start-up refuses to start if only one of the two Access settings is set. It also warns if `PLATFORM_ACCESS_EMAILS` is empty.

### 4. Rebuild the admin panel with its own hostname as the API address

```bash
cd ~/apps/school-os-admin-panel
NEXT_PUBLIC_API_BASE_URL=https://admin.teachassist.site/api/v1 NEXT_PUBLIC_SCHOOL_APP_URL=https://teachassist.site npm run build
pm2 restart school-os-admin
```

`CORS_ORIGINS` needs no change (same origin). Deploy the backend and admin panel code from this change first (`guide/05`).

**Order:**
1. Apply step 1 (Access).
2. Apply step 2 (route) and check that `https://admin.teachassist.site/health` asks for the Access code, then answers.
3. Deploy the code, then apply step 3 (`.env`) and step 4 (rebuild).

Until step 3, the IP rule still applies, so nothing breaks in between.

## Verify from mobile data (not the home Wi-Fi)

On your phone, **turn Wi-Fi off**, so the phone uses mobile data only.

1. Open `https://admin.teachassist.site` in a private tab. You should see the **Cloudflare Access** page. Enter your e-mail, then the code from your inbox.
2. The console's sign-in page appears. Sign in with the platform password. The dashboard loads.
3. Open a page that lists data (Schools, Health) and confirm it loads. Sign out, sign in again. Leave it for 20 minutes and use it again (the session refreshes).
4. **Negative checks**, still on mobile data:
   - In a fresh private tab, `https://admin.teachassist.site/api/v1/platform/auth/me` should show the Access page, not data.
   - `https://smsapi.teachassist.site/api/v1/platform/auth/me` should show `{"error":{"code":"NOT_FOUND",…}}`.
   - The school app `https://teachassist.site` should work as before, with no Access page.
5. Repeat step 1 on the home Wi-Fi: the same Access page, then the same console.

From a laptop on another network, `curl -s -o /dev/null -w '%{http_code}\n' https://admin.teachassist.site/api/v1/platform/auth/me` should print `302` (redirect to Access), and the same against `smsapi…` should print `404`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Console says "Your Cloudflare Access sign-in has expired. Reload the page" | Access session ended: reload and enter a new code |
| Access page passes, but console sign-in says "not found" | Step 3 missing or wrong (AUD tag, team domain), e-mail not in `PLATFORM_ACCESS_EMAILS`, or the console still calls `smsapi` (step 4). The API log shows `Platform API request refused` with a reason such as `access_wrong_audience` or `access_missing` |
| `…/api/…` on the admin host shows the console's 404 page | Step 2 route missing or below the catch-all |
| Everything refused after a Cloudflare outage | The API could not fetch Access keys (fails closed). It retries automatically |

## Rollback

Remove `PLATFORM_ACCESS_TEAM_DOMAIN` and `PLATFORM_ACCESS_AUD` from `.env` and run `pm2 restart school-os-api`. The `PLATFORM_ALLOWED_IPS` rule applies again (home only). The Access application and route can stay. If you also rebuild the panel with `smsapi` as the API address, it works from home as before.

## Still recommended

Built-in MFA (TOTP) for platform administrators would let the console stand on its own if Access were ever misconfigured or removed. Until then, keep Access in place and the e-mail list short.
