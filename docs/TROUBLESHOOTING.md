# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment configuration: MONGODB_URI is required` | `.env` is missing or not in the working directory | `cp .env.example .env`, fill it in, and run commands from the project folder |
| `JWT_ACCESS_SECRET must be at least 32 characters` | Secret not set or too short | Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `Refusing to start in production with placeholder JWT secrets` / `must differ` | Production safety check | Use two different random secrets |
| `CORS_ORIGINS must list the frontend origins in production` | Production safety check | `CORS_ORIGINS=https://app.example.pk,https://admin.example.pk` |
| `MongoServerSelectionError` / `ECONNREFUSED 127.0.0.1:27017` | MongoDB not running or wrong URI | Start MongoDB (Windows: Services → MongoDB; Linux: `sudo systemctl start mongod`). For Atlas, add your IP to the access list |
| `Authentication failed` (MongoDB) | Wrong DB user or password, or wrong `authSource` | URL-encode special characters in the password; for Atlas use the `mongodb+srv://` string |
| Browser shows a CORS error | Frontend origin not allowed | Add the exact origin (scheme + host + port) to `CORS_ORIGINS` and restart |
| Every request returns `401 TOKEN_EXPIRED` | Access token is older than 15 minutes | Call `/auth/refresh`; see FRONTEND_INTEGRATION.md |
| Refresh suddenly fails and the user is logged out | Same refresh token used twice (two tabs or a retry) | Only one refresh may be in flight; always store the newest token |
| `400 SCHOOL_CODE_REQUIRED` at login | Same email exists at two schools | Send `schoolCode` (e.g. `BFSS`) |
| `423 ACCOUNT_LOCKED` | 5 failed logins | Wait `LOCKOUT_MINUTES`, or an administrator resets the password |
| `403 SCHOOL_SUSPENDED` | Platform suspended the school | Platform admin: `POST /platform/schools/{id}/activate` |
| `402 SUBSCRIPTION_INACTIVE` on writes | Trial ended or subscription expired or cancelled | Platform admin: extend the trial or set the subscription to `active` |
| `403 PLAN_LIMIT_REACHED` | Plan limit for students, campuses or staff reached | Upgrade the plan or deactivate records |
| `503 AI_UNAVAILABLE` | No active AI provider: nothing saved in the admin panel and no `AI_API_KEY` in `.env`, AI turned off platform-wide, or AI turned off in school settings | Save a provider in the admin panel (docs/AI_PROVIDERS.md) or set `AI_PROVIDER`, `AI_API_KEY` and `AI_MODEL`. Core features are unaffected |
| `502 AI_PROVIDER_ERROR` | Provider rejected the key, unknown model, quota or timeout | Run `POST /platform/ai/test` (it shows the provider message and a hint) or `npm run ai:check` |
| Groq key (`gsk_…`) does not work | Key used with another provider (e.g. xAI) | Use provider `groq`. Groq and Grok (xAI) are different companies |
| `429 AI_LIMIT_REACHED` | Monthly token allowance used up | Raise `limits.aiMonthlyTokens` on the plan, or wait for the new month |
| `503 CHANNEL_PAUSED`, or messages show `paused` | SMS, WhatsApp or email is switched off (coming soon) | Intended for now. To enable: set provider credentials and `SMS_ENABLED`, `WHATSAPP_ENABLED` or `EMAIL_SENDING_ENABLED`, then restart (docs/MESSAGING_CHANNELS.md) |
| Messages show `not_configured` | Channel credentials missing | Set the SMTP, Twilio or WhatsApp variables and restart |
| WhatsApp messages `failed` with error 470/131047 | Outside Meta's 24-hour window; template required | Use approved templates (not implemented yet) or SMS |
| `409 TIMETABLE_CONFLICT` | Section, teacher or room double-booked | `error.details.conflicts` lists the clashes; use `POST /timetable/check` while editing |
| `409 SECTION_FULL` | Section capacity reached | Increase `capacity` on the section or choose another section |
| `500` with "Tenant scope violation" in logs | A code change queried a school collection without `schoolId` | This is the guard working. Add `scope(ctx, …)` to the query |
| Urdu names show as boxes in PDFs | Standard PDF fonts lack Urdu glyphs | Embed an Urdu font in `src/services/pdf.ts` (known limitation) |
| Seed fails: `Set SEED_DEMO_PASSWORD` | Variable missing or weak | Use at least 10 characters with upper, lower and a digit |
| Seed refuses with `NODE_ENV=production` | Safety check | Do not seed demo data in production |
| Tests fail to start: cannot download MongoDB binary | No internet on first run (mongodb-memory-server downloads `mongod` once) | Allow the download once, or set `MONGOMS_SYSTEM_BINARY` to a local `mongod` |
| Port 4000 already in use | Another process | Change `PORT`, or stop the other process (Windows: `netstat -ano \| findstr :4000`) |

## Diagnostics

- Every response carries `X-Request-Id`. Search the logs for that value.
- For more detail, set `LOG_LEVEL=debug` (development only).
- `GET /health/ready` shows database connectivity. `GET /platform/health` (platform token) shows memory use, uptime and scheduler status.
