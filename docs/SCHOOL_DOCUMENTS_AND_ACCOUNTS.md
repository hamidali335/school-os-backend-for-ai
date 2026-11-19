# School branding, documents, account lifecycle, messages and cover lessons

This page explains how these features behave and what each one guarantees. The endpoint reference is in `docs/openapi.yaml`.

## School logo and document design

- `PUT /school/branding/logo` (multipart, field `file`, needs `school:settings`) takes a PNG, JPG or WebP file of up to 2 MB, between 32 and 6000 px.
  - The server decodes the image with `sharp`, which rejects files that are not really images.
  - It re-encodes the logo as a PNG of at most 600 px and stores it in the file store under category `branding`.
  - The previous file is deleted. `DELETE` removes the logo.
- `GET /school/branding/logo` only ever returns the signed-in user's own school logo. The school logo is separate from the platform's own branding.
- `PATCH /school/branding/documents` saves the design settings: theme, header, page, footer, challan, receipt and certificate. `DELETE` resets them to the defaults.
  - Only the listed options exist. Amounts, dates, numbers and names are always printed, whatever the settings.
  - If a stored section stops validating (for example after an option is removed), that section falls back to its defaults.
- `POST /school/branding/documents/preview` takes `{kind, settings?}` and renders a real PDF with sample data and the unsaved settings. The settings screen uses it for the live preview.
- The logo and design apply to fee challans, installment challans, receipts, certificates and PDF reports. Reports are produced with `?format=pdf` on the attendance, fee-collection and outstanding reports.

## Installment challans

`GET /fees/invoices/:id/challan.pdf?installment=N` prints the voucher for installment N. Without `installment`, a split invoice prints the first installment that still has an amount due.

Each voucher shows:
- the invoice total, discount and net amount;
- the amount already paid and the amount outstanding;
- "Installment N of M" and that installment's due date;
- the amount payable now (the installment amount, for example 60,000 ÷ 6 = 10,000);
- what remains after this payment.

Asking for an installment on an invoice that isn't split, or an out-of-range number, returns `400`.

## User account lifecycle

| Action | Endpoint | Effect |
|---|---|---|
| Suspend | `POST /users/:id/suspend` | Sign-in is blocked. Every session is revoked and access tokens stop working at once. |
| Reactivate | `POST /users/:id/reactivate` | The user can sign in again. Refused for an archived account. |
| Archive | `POST /users/:id/archive` `{reason}` | For someone who has left. The account is disabled, sessions are revoked, it is hidden from the default list, and all records are kept. |
| Restore | `POST /users/:id/unarchive` | Back in the list as disabled. Reactivating is a separate step. |
| Delete | `GET /users/:id/deletion-check`, then `DELETE /users/:id` `{reason}` | Only for an account that was never used. Otherwise `IN_USE`, with the blockers listed; archive the account instead. |

Safeguards:
- The last active owner or administrator can't be suspended, archived, deleted or demoted (`LAST_ADMIN`).
- Nobody can do any of these to their own account (`SELF_ACTION`).
- Role grants still apply.
- Every action is audited.

`GET /users?archived=only|include` lists archived accounts.

## Notifications

In-app notifications are now created for:
- approval requests, sent to the users who can decide them;
- approval decisions, sent to the requester;
- fee payments, sent to the student's parents;
- new messages.

Absence notices to parents are sent once per student per day. The school frontend refreshes the bell every 30 seconds and whenever the tab regains focus.

## Teacher–parent messages

Students have no logins, so a teacher writes to a student's parent. Each conversation is between one staff member and one parent about one student, and starting it again reuses the existing conversation.

Who can message whom:
- A teacher can message the parents of students in sections they teach: as class teacher, through a subject assignment, or while actively covering as a substitute.
- When a teacher stops teaching the student, the conversation becomes read-only for them.
- Parents can message their children's teachers.
- The owner, principal and school admin can read every conversation (`all=true`) for oversight. They can't post in conversations they are not part of.

Message bodies are plain text of up to 2000 characters. The recipient gets an in-app notification that links to `/messages/:id`.

## Substitute cover and the timetable

Cover lessons are calculated, never copied. For each date a cover is active, the absent teacher's regular lessons for that section (and subject) on that weekday become the substitute's cover lessons. Ending, editing or cancelling a cover therefore updates every view at once, and nothing is left behind to clean up.

- `POST /substitutes/preview` lists the dated lessons a cover would include, and any clash with the substitute's own lessons or other covers.
- Creating or editing a cover with clashes is refused with `409 SUBSTITUTE_TIMETABLE_CONFLICT`, along with the clash list, unless `acceptClashes: true` is sent. Overlapping covers for the same class are still refused (`SUBSTITUTE_CONFLICT`).
- `GET /timetable/dated?from&to&sectionId|teacherId` (31 days at most) returns the lessons for each date with `kind: regular|cover`, `coveredBy` and `coveringFor`. Teachers and parents see the same scope they see in `GET /timetable`.
- There is no holiday calendar: a working day is any day that has timetable lessons.

## Printing vouchers

**Print challan** (on the invoice page and on each installment) prints the same PDF as the download, using the browser's print dialog. The printed and downloaded versions are therefore identical, and none of the app's interface appears on paper. Browsers that can't print a PDF from within the page open it in a new tab instead.

## Family vouchers

- `GET /fees/family/:parentId` lists a parent's children (in this school, visible to the user), with their open invoices and the amount payable now. These are the same figures as each invoice's own challan, installments included.
- `GET /fees/family/:parentId/voucher.pdf?studentIds=…` returns one PDF:
  - each child is listed separately, with each invoice's items, discounts, amount paid and amount payable now;
  - then a family total and a cut-off bank copy.
- Each child's invoices stay separate liabilities. Payments are still recorded against each invoice, so a family's partial payment is allocated explicitly by the accountant, never guessed.
- Parents can open only their own family. Teachers and other schools are refused.

## Search

- **Students:** by name, admission or roll number, and by a parent's name or phone, whatever the phone's format.
- **Fee invoices (`q`):** challan number, student, admission number or parent phone.
- **Payments (`q`):** receipt number or reference, student, or parent phone.
- **Certificates (`q`):** serial number or student.
- **Staff:** also by phone, email and department, and by CNIC for users allowed to see it.

All searches stay within the user's school and campuses.

## Colour-coded interface

`PATCH /school/settings { ui: { colorCoded: true } }` (permission `school:settings`) turns it on for the whole school. It's off by default and is returned in `GET /auth/me`.

The school app then gives each navigation area one muted colour, used for accents only. Green, amber and red keep their meaning, text colours are unchanged, and print is never affected.
