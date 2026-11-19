# Keyless push (FCM) with Workload Identity Federation

The API sends incoming-call pushes through Firebase Cloud Messaging (FCM HTTP v1). Google needs to know it is really our API asking. The usual way is a downloaded service-account key, which your Google Workspace policy rightly forbids. This setup needs **no Google key at all**.

## How it works

```
 school-os-oidc (Linux user)                 Google Cloud                          FCM
 ───────────────────────────                 ────────────                          ───
 private.pem (0600, never leaves the server)
   │ every 5 min: sign a 10-minute token
   ▼
 /run/school-os-oidc/token ──read by──▶ API (PM2 user hamid)
                                          │ 1. Security Token Service: token for the
                                          │    provider "school-os-server" (checks the
                                          │    signature with the uploaded JWKS, issuer,
                                          │    audience, expiry, sub == 'school-os-api')
                                          │ 2. IAM Credentials: act as
                                          │    school-os-fcm-sender (FCM sending only)
                                          ▼
                                        1-hour access token ───────────────────────▶ messages:send
```

- **The signing key is not a Google key**, so the "disable service account key creation" policy does not apply, and nothing can be downloaded from Google.
- **The API cannot read the key.** It runs as `hamid`; the signer runs as `school-os-oidc`. If the API were compromised, it would get only tokens that expire within minutes, and only for sending FCM messages.
- **No public endpoint.** The public key (JWKS) is uploaded to Google when the provider is created, so Google never contacts the server. The issuer URL is only a name.

## What is checked, and where

| Check | Google (on every exchange) | Server (`npm run push:check -- --verify …`) |
|---|---|---|
| Signature (RS256) against the uploaded JWKS, by key id | yes | yes |
| Issuer `https://smsapi.teachassist.site/oidc` | yes | yes |
| Audience (the provider's full name) | yes | yes |
| Subject `school-os-api` (attribute condition) | yes | yes |
| Expiry; lifetime at most 1 hour (we use 10 minutes) | yes | yes |
| Only the FCM scope, only the dedicated service account | IAM role bindings | — |

The API itself checks before each exchange that the token file exists and has not expired, and reports a stopped signer plainly (`is school-os-oidc.timer running?`).

## Settings

| Variable | Value |
|---|---|
| `FCM_PROJECT_ID` | `school-management-softwa-c42b4` |
| `FCM_CREDENTIALS` | `adc` (keyless). `service_account_file` = the old key file. Unset = key file if `FCM_SERVICE_ACCOUNT_FILE` is set, otherwise push off. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/etc/school-os/google-wif.json`, the external-account configuration (no secret in it) |

## Files (in `deploy/oidc-signer/`)

| File | Installed as |
|---|---|
| `school-os-oidc-signer.mjs` | `/opt/school-os-oidc/school-os-oidc-signer.mjs` (Node built-ins only) |
| `school-os-oidc.service`, `school-os-oidc.timer` | `/etc/systemd/system/` |
| `school-os-oidc.tmpfiles.conf` | `/etc/tmpfiles.d/school-os-oidc.conf` (recreates `/run/school-os-oidc`, setgid group `hamid`, at boot) |
| `signer.example.json` | `/etc/school-os/oidc/signer.json` |
| `google-wif.example.json` | `/etc/school-os/google-wif.json` (or the file `gcloud … create-cred-config` writes) |

## Google Cloud names used

| Thing | Name |
|---|---|
| Project | `school-management-softwa-c42b4` (number `687478394315`) |
| Service account | `school-os-fcm-sender@school-management-softwa-c42b4.iam.gserviceaccount.com`, role **Firebase Cloud Messaging API Admin** only, **no keys** |
| Workload identity pool | `school-os-pool` |
| OIDC provider | `school-os-server`: issuer `https://smsapi.teachassist.site/oidc`, allowed audience `https://iam.googleapis.com/projects/687478394315/locations/global/workloadIdentityPools/school-os-pool/providers/school-os-server`, mapping `google.subject=assertion.sub`, condition `assertion.sub == 'school-os-api'`, JWKS uploaded |
| Binding | `principal://iam.googleapis.com/projects/687478394315/locations/global/workloadIdentityPools/school-os-pool/subject/school-os-api` has **Workload Identity User** on the service account |

The step-by-step commands are given one step at a time during setup; each step says how to check it before the next.

## Key rotation

1. On the server: `sudo -u school-os-oidc node /opt/school-os-oidc/school-os-oidc-signer.mjs keygen /etc/school-os/oidc-next school-os-YYYY-MM`.
2. Upload a JWKS containing **both** keys (old and new) to the provider.
3. Point `signer.json` at the new key and `kid`, wait 10 minutes, then upload a JWKS with only the new key and delete the old key.

## Troubleshooting

| Message | Meaning |
|---|---|
| `OIDC token file is missing or unreadable: is school-os-oidc.timer running?` | `systemctl status school-os-oidc.timer`; `journalctl -u school-os-oidc` |
| `… not usable (EXPIRED)` | The signer stopped, or the server clock is wrong (`timedatectl`) |
| `invalid_grant` / `unauthorized_client` from Google | Issuer, audience, JWKS or the attribute condition do not match: run `npm run push:check -- --verify /etc/school-os/oidc/signer.json /etc/school-os/oidc/jwks.json` |
| `Permission 'iam.serviceAccounts.getAccessToken' denied` | The Workload Identity User binding is missing |
| `403` from FCM | The service account lacks the FCM role, or the FCM API is disabled |
