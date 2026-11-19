# Subscription plans and feature entitlements

How plans, prices and features work, how they are enforced, and how to operate them.

## Three separate things

| Concept | Where it lives | Who changes it |
|---|---|---|
| **Feature registry**: the plan-controlled capabilities this software has, with stable keys | `src/config/entitlements.ts` | Developers, only when a new capability is built |
| **Plan configuration**: each plan's name, prices, limits, availability and which registry features it includes | `plans` collection | Platform Owner, in the admin panel (no code change, no deploy) |
| **School entitlement**: what one school can use right now | Computed on every request | Follows the plan, the school's overrides and its subscription status |

A user also needs the **role permission** for an action. A plan never grants a permission, and a permission never bypasses the plan. Pro Max does not let a teacher open the fee module.

## Feature registry

| Key | Name | Category | Notes |
|---|---|---|---|
| `core.school_admin` | School administration | Core | In every plan. Settings, campuses, users, roles, approvals, audit log, dashboard |
| `core.students` | Students and parents | Core | In every plan |
| `core.academics` | Classes and subjects | Academics | In every plan |
| `core.staff` | Staff records | Staff | In every plan (teacher logins need it) |
| `core.admissions` | Admissions | Core | |
| `core.timetable` | Timetable and substitutes | Academics | Needs `core.academics` |
| `core.attendance` | Attendance | Academics | Needs `core.academics` |
| `core.homework` | Homework | Academics | Needs `core.academics` |
| `core.examinations` | Examinations and results | Academics | Needs `core.academics` |
| `core.certificates` | Certificates | Academics | |
| `core.fees` | Fees | Finance | |
| `core.accounts` | Income and expenses | Finance | |
| `core.payroll` | Payroll | Staff | Needs `core.staff` |
| `core.reports` | Reports | Core | |
| `core.communications` | Announcements and notifications | Communication | SMS/WhatsApp/email also follow their own channel switches |
| `core.automations` | Automations | Communication | |
| `portal.parents` | Parent web portal | Web portals | In every plan |
| `portal.teachers` | Teacher web portal | Web portals | In every plan |
| `mobile.parent_app` | Parent mobile app | Mobile apps | **Coming soon**: not released. Needs `portal.parents` |
| `mobile.teacher_app` | Teacher mobile app | Mobile apps | **Coming soon**: not released. Needs `portal.teachers` |
| `calls.voice` | App voice calls | Calls | In **no default plan**; add it to a plan or grant it per school. Lost when the subscription is ineligible, like mobile and AI. Needs `core.communications`. See `docs/VOICE_CALLS.md` |
| `calls.ai_voice` | AI voice conversations | Calls | In **no default plan**. Needs `calls.voice`; lost when the subscription is ineligible. See `docs/AI_VOICE_CALLS.md` |
| `ai.copilot` | AI Copilot | AI | `POST /ai/copilot/chat` |
| `ai.insights` | AI insights | AI | `/ai/insights`, `/ai/daily-brief`, `/ai/reports/narrative`, the scheduled daily brief. Needs `core.reports` |
| `ai.assistant` | AI writing assistant | AI | `/ai/explain`, `/ai/summarize`, `/ai/admissions/{id}/recommendation`, `/ai/draft-communication` |

"In every plan" features cannot be removed from a plan or revoked for a school, so logins, activation, password reset and the parent and teacher **web** portals work on every plan. Unknown keys are rejected when a plan is saved and are always denied at runtime.

## Default plans

Created by `npm run migrate:plan-entitlements` (or the seed) only if missing. They are never overwritten, and the Platform Owner edits them freely afterwards.

| | Basic | Pro | Pro Max |
|---|---|---|---|
| Every core module and both web portals | ✓ | ✓ | ✓ |
| Parent and teacher mobile apps (coming soon) | — | ✓ | ✓ |
| AI Copilot, AI insights, AI writing assistant | — | — | ✓ |
| Monthly price (placeholder, edit in the panel) | PKR 2,500 | PKR 3,500 | PKR 5,000 |
| Yearly billing | off | off | off |

## How a school's features are computed (precedence)

Highest first:

1. **Required features** are always on.
2. A school-level **revoke** removes a feature, whatever the plan includes.
3. A school-level **grant** adds a feature the plan does not include.
4. The **plan's features**: the school's grandfathered snapshot if it has one, otherwise the plan's published features. A school with **no plan** gets the core features only (no AI, no mobile apps).
5. **Subscription status**: an ineligible subscription (cancelled, expired, or a trial that has ended) loses AI and mobile features. Core modules stay readable but read-only, as before (`402 SUBSCRIPTION_INACTIVE` on writes). Active, trialing and past-due subscriptions are eligible. This is the existing policy; there is no grace period.

## Enforcement

- `authenticateSchool` computes the entitlements on every request from the saved subscription and plan. They are never read from the token or the request, so changing a plan, publishing a template or setting an override applies to the **next request of every user** of the school. Nobody has to sign in again, and no tokens are revoked.
- Every school route needs the features its permissions belong to (`PERMISSION_FEATURE`), plus any it names explicitly (`feature:` on the route; all `/ai/*` routes do). Missing → `403 FEATURE_NOT_IN_PLAN` with `details.feature`.
- `callAi` checks the AI entitlement **before** contacting the provider, including scheduler work, so no tokens are spent for a school without AI.
- `/ai/status` and `/ai/usage` stay readable on every plan: status reports `includedInPlan`, and past usage remains visible after a downgrade.
- The mobile app sends `X-Client-App: mobile` on every request, including sign-in and refresh; web portals never send it. The decision uses the role verified from the database: parents need `mobile.parent_app`, teachers `mobile.teacher_app`, and **every other role is refused** with `403 MOBILE_ROLE_NOT_ALLOWED` (staff use the website). Sign-in checks this after the password and issues no tokens; refresh issues none either. The older values `parent-mobile` / `teacher-mobile` are still accepted, but only for that exact role. Any other value is `403`. The header names the client; it can never grant a role, and omitting it only gives the website's behaviour.
- Plans are cached in memory for at most 10 seconds and the cache is cleared on every plan write. With several API instances, another instance sees a published change within 10 seconds. School subscriptions are read fresh on every request.

## Prices and existing subscribers

- Each school stores its **agreed price** (`subscription.agreedPrice`: amount, currency, period, date), copied from the plan when the plan is assigned. Changing a plan's price never changes it. The Platform Owner applies a new price explicitly (`POST /platform/schools/{id}/subscription/apply-current-price`, audited).
- There is no payment integration. Nothing is charged, refunded, prorated or verified automatically. Subscription status and dates are set by hand, as before.
- Publishing a change to a plan's **features** asks how it applies to schools already on it:
  - `all_subscribers`: they get the new feature set on their next request.
  - `new_subscribers_only`: they keep their current features (a snapshot in `subscription.lockedFeatures`), and schools that join later get the new set. Changing such a school's plan clears the snapshot.

## Draft and publish

Edits are saved as a **draft** on the plan (validated: known features, required features present, dependencies met, at least one billing period). The published configuration is the only one enforced. Publishing re-validates, shows a preview (price changes, features added and removed, schools affected, warnings), needs `confirm: true`, and uses optimistic concurrency on `version`. If anything fails, the last published configuration stays in force. New plans can be created unpublished, and they cannot be assigned until published. **Archived** plans cannot be assigned or offered, but schools on them keep working and all records are kept. A plan's `code` never changes, so renaming is safe.

## Downgrades keep data

A plan change only changes access. Nothing is deleted: AI usage history, announcements, fee records, results and everything else stay. Restricted features return with their data on re-upgrade.

## Who can do what

| Action | Platform owner | Platform admin | School users |
|---|---|---|---|
| View plans, features, a school's entitlements | ✓ | ✓ | Own school only (`GET /entitlements`, `GET /subscription`) |
| Create, edit, publish, archive plans | ✓ | — | — |
| Change a school's plan, overrides, agreed price | ✓ | — | — |
| Subscription status, dates, trial extension | ✓ | ✓ | — |

Every change is audited with actor, school, previous and new plan, features gained and lost, overrides and note: `platform.plan.created`, `platform.plan.draft_saved`, `platform.plan.published`, `platform.plan.archived`, `platform.plan.restored`, `platform.subscription.plan_changed`, `platform.subscription.overrides_changed`, `platform.subscription.price_applied`.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /platform/features` | Feature registry |
| `GET /platform/plans`, `GET /platform/plans/{id}` | Plans (published, draft, subscriber count; subscribed schools) |
| `POST /platform/plans` | Create (`publish: false` for an unpublished draft) |
| `PUT /platform/plans/{id}/draft`, `DELETE …/draft` | Save or discard edits |
| `GET /platform/plans/{id}/draft/preview` | What publishing would change |
| `POST /platform/plans/{id}/publish` | Publish (`applyTo`, `confirm`) |
| `POST /platform/plans/{id}/archive`, `…/restore` | Archive or restore |
| `GET /platform/schools/{id}/entitlements` | A school's plan, price, overrides, effective features |
| `GET /platform/schools/{id}/plan-change/preview?planCode=` | Features gained and lost |
| `POST /platform/schools/{id}/plan-change` | Upgrade or downgrade (`confirm`) |
| `PUT /platform/schools/{id}/feature-overrides` | School exceptions |
| `POST /platform/schools/{id}/subscription/apply-current-price` | Apply the plan's current price |
| `POST /platform/schools` | Now also takes `billingPeriod` and `featureOverrides` |
| `PUT /platform/schools/{id}/subscription` | `planCode` here is owner-only and goes through the plan-change flow |
| `GET /entitlements` (school) | The school's features, with the plans that include each |
| `GET /auth/me` (school) | Now includes `entitlements` (keys) |

Removed: `PATCH /platform/plans/{id}` (replaced by draft and publish).

## Migration for existing databases

```bash
npm run migrate:plan-entitlements            # dry run: reports, changes nothing
npm run migrate:plan-entitlements -- --apply
```

It creates missing templates; translates old plan feature strings (`core`, `parent_portal`, `automations`, `ai_copilot`) to registry keys, so access stays exactly as the old plan described; moves non-capabilities such as `priority_support` to highlights; fills missing price fields from the old monthly price; and records each school's agreed price from its plan's current price. No school changes plan, nothing is deleted, and no school gains AI it did not have. The API already reads old feature strings the same way, so access is correct before and after the migration.

## Adding a new capability later

1. Build it, with a permission or an explicit `feature:` on its routes.
2. Add its key to `FEATURES` in `src/config/entitlements.ts` (and `availability: 'coming_soon'` until it is released).
3. Deploy. It then appears in the admin panel and can be added to plans without further code changes.
