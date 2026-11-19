# Testing the API with Postman

The collection is generated from the live API definition, so it covers **every endpoint (230 requests in 30 folders)**:

- `docs/postman/School-OS-API.postman_collection.json`
- `docs/postman/School-OS-Local.postman_environment.json`

Regenerate both after API changes with `npm run postman:generate`.

## 1. Start the API

```powershell
cd D:\SMS\school-os-backend
npm run dev
```
Open http://localhost:4000. It should show links to the docs and the login endpoints.

## 2. Import into Postman

1. Postman → **Import** → select both files in `docs/postman/`.
2. In the top-right environment dropdown, choose **School OS — Local**.
3. Edit the environment and fill in **Current value**:

| Variable | Value |
|---|---|
| `baseUrl` | `http://localhost:4000` |
| `schoolEmail` | `owner@brightfuture.example` for full access, or any demo login (principal, accounts, teacher.ayesha, parent…) |
| `schoolPassword` | Your `SEED_DEMO_PASSWORD` |
| `platformEmail` / `platformPassword` | The account created with `npm run create-platform-owner` |

## 3. Log in

- **Auth → POST /auth/login** saves `{{accessToken}}`, which every school request uses automatically.
- **Platform Auth → POST /platform/auth/login** saves `{{platformAccessToken}}`, which the Platform Admin folder uses.

Access tokens expire after 15 minutes. When a request returns `TOKEN_EXPIRED`, run the login (or **POST /auth/refresh**) again.

To test as another role, change `schoolEmail` (for example to `teacher.ayesha@brightfuture.example`) and log in again.

## 4. How ids are filled in

- **List requests save an id.** Running a list request (for example **Students → GET /students**) saves an id variable (`{{studentId}}`) that later detail requests use. Lists prefer useful records: unpaid invoices, pending approvals, open inquiries, and sections that match the current class.
- **Create requests save the new record** as `{{createdStudentId}}`, `{{createdExamId}}` and so on.
- **Cleanup only touches created records.** The **Cleanup** folder deletes only `created…` records, never seeded data.
- **You can override any id.** Open the collection → **Variables** to see or change all ids.

Run the folders in order (top to bottom), or use **Run collection** (Collection Runner) to run everything.

Requests marked **⚠** change or delete data. The last folder, **Session end (run last)**, contains logout, logout-all and change-password. Run it last.

## 5. Expected non-2xx responses in a full run

A full run against the seeded demo data was verified: **213 of 230 requests succeed, and none returns a server error.** The rest are expected:

| Request | Why |
|---|---|
| AI requests → `503 AI_UNAVAILABLE` | No AI provider configured. Configure one in **Platform AI Settings** (set `provider`, `aiModel`, `aiApiKey` in the environment), or set `AI_API_KEY` in `.env`. |
| `POST /files`, file download/delete | Pick a real PDF or image in the request's **Body → file** field. |
| `GET /academics/my-sections` | Teacher only. Log in as `teacher.ayesha@…` |
| AI requests → `403 FEATURE_NOT_IN_PLAN` | The school's plan has no AI. Move it to a plan with AI (Pro Max) with `POST /platform/schools/{id}/plan-change` as the platform owner |
| `POST /homework/{id}/submissions`, grade | Parent only, for their own child in that section (`studentId` in the body). Log in as `parent@…`, then grade as the teacher |
| `cancel-requests` on an invoice with payments, cancelling an executed approval, deleting an exam with marks or a published announcement | Business rules working as intended (409) |
| `POST /auth/change-password` after logout-all | The session was already ended (401) |

Every request includes a test that fails only on a 5xx response, so the Collection Runner summary shows real server errors.

## 6. Useful role checks

- **Parent** (`parent@brightfuture.example`): `GET /students` returns only their child. Asking for another student id returns 404.
- **Teacher**: can mark attendance only for their own sections. Other sections return `403`.
- **Accountant**: `POST /approvals/{id}/decision` returns `403`. Approvals need the owner or principal.
- **School token on `/platform/...`**: returns `401`. The platform identity is separate.
