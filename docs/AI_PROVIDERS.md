# AI Providers: Choosing and Switching Models

You can choose the AI provider and model the system uses from the **platform-owner admin panel**, and change them at any time. No code change or restart is needed.

## Supported providers

| Provider | id | Free tier | Example models | Get a key |
|---|---|---|---|---|
| Groq | `groq` | Yes | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile` | console.groq.com/keys (keys start `gsk_`) |
| OpenAI (ChatGPT) | `openai` | No | `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4o` | platform.openai.com/api-keys |
| DeepSeek | `deepseek` | No (low cost) | `deepseek-chat`, `deepseek-reasoner` | platform.deepseek.com |
| xAI (Grok) | `xai` | No | `grok-4-fast`, `grok-4` | console.x.ai |
| Google Gemini | `gemini` | Yes | `gemini-2.5-flash`, `gemini-2.5-pro` | aistudio.google.com/app/apikey |
| OpenRouter | `openrouter` | Some models | models ending in `:free` | openrouter.ai/keys |
| Custom | `custom` | — | Any OpenAI-compatible endpoint (needs `baseUrl`) | — |

All of these use the OpenAI-compatible chat API, so they all support every AI feature, including the Copilot's data tools. The exceptions are models that do not support tool calling, such as `deepseek-reasoner` and some small models: there, the Copilot answers without fetching data.

> Groq (groq.com) and Grok (xAI) are different companies. A Groq key (`gsk_…`) works only with the `groq` provider.

## How the active configuration is chosen

1. **Admin panel settings.** If an active provider is saved there with a key and a model, it is used.
2. **Otherwise, `.env`.** The fallback is `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` (and `AI_BASE_URL` if needed).
3. **Otherwise, AI is off.** AI requests return `503 AI_UNAVAILABLE`, and everything else works normally.

Changes made in the panel take effect immediately on the server that received them, and on other servers within 30 seconds.

## Admin panel API (platform owner)

| Step | Request |
|---|---|
| Show providers and suggested models | `GET /api/v1/platform/ai/providers` |
| Show current settings (keys masked) and what is in use | `GET /api/v1/platform/ai/settings` |
| Fill the model dropdown with the provider's live list | `GET /api/v1/platform/ai/providers/{provider}/models` |
| Test a key and model **before saving** | `POST /api/v1/platform/ai/test` `{ "provider": "groq", "model": "openai/gpt-oss-120b", "apiKey": "gsk_…" }` |
| Save a key and model (and switch to it) | `PUT /api/v1/platform/ai/settings/providers/groq` `{ "apiKey": "gsk_…", "model": "openai/gpt-oss-120b", "activate": true }` |
| Change only the model (the key is kept) | `PUT /api/v1/platform/ai/settings/providers/groq` `{ "model": "llama-3.3-70b-versatile" }` |
| Switch to another saved provider | `PUT /api/v1/platform/ai/settings` `{ "activeProvider": "openai" }` |
| Turn AI off or on for all schools | `PUT /api/v1/platform/ai/settings` `{ "enabled": false }` |
| Test what is currently in use | `POST /api/v1/platform/ai/test` (no body) |
| Remove a provider's key | `DELETE /api/v1/platform/ai/settings/providers/{provider}` |

**Field notes:**
- **Prices.** `inputCostPerMTokUsd` and `outputCostPerMTokUsd` (USD per 1 million tokens) can be set per provider. They are used for the cost figures in AI usage reports.
- **Base URL.** `baseUrl` is only needed for `custom`, or to override a provider's default.
- **Permissions.** Only `platform_owner` can change settings. A `platform_admin` can view settings, list models and run tests.

## Security

- **Keys are encrypted at rest** (AES-256-GCM) with `SETTINGS_ENCRYPTION_KEY`, or a key derived from `JWT_PLATFORM_SECRET` when that is not set. If you change either value, saved keys can no longer be decrypted (shown as `keyReadable: false`) and must be entered again.
- **Keys are never returned.** The API shows only a masked form such as `gsk_…erhN`. Audit logs record that a key changed, not the key itself.
- **Provider error messages** (for example "Invalid API Key") are shown only to platform admins through the test endpoint. School users get a generic `AI_PROVIDER_ERROR`.

## Quick checks

- `npm run ai:check` tests the `.env` AI configuration from the command line: a chat, a tool call, and the model list.
- In Postman, the **Platform AI Settings** folder contains every request above. Set `provider`, `aiModel` and `aiApiKey` in the environment.
