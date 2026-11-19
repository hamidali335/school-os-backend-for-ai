# Fee import: own monthly fees and previous dues

For schools moving to School OS where every student pays a different fee and many owe money from
before. **Import data → Student fees and previous dues** (permission `fees:manage`).

## What one row does

| Column | Effect |
|---|---|
| Admission No, or Student Name + Class | Finds the student already in School OS (never creates or renames one) |
| Father Name, Parent Phone, Section | Only tell apart students with the same name in a class; differences are shown as warnings, nothing is changed |
| Monthly Fee | The student's own monthly fee (`Student.customFees`), used instead of the class fee structure from the next invoices on; billed even if the class has no structure |
| Previous Dues | One invoice of kind `opening` ("Previous dues (up to Oct 2026)") with that amount, due at once |
| Notes | Kept on the previous dues invoice |

Options: **Previous dues are up to** (a month, default last month) and **Monthly Fee is** (a
monthly fee head; default the school's tuition head, or a new "Monthly Fee" head `MONTHLY` is
created once).

## Safety rules

- Checking saves nothing. Every row shows what will change (from → to), and the check lists totals
  per class to compare with the school's register before confirming.
- Students are matched exactly by name within the class (case, dots and spaces ignored). Only if
  that finds nobody, short forms of Muhammad count as the same ("M. Ali" = "Muhammad Ali"), and
  the row says which student it matched. Two students with the same name and nothing to tell
  them apart → error, never a guess.
- One `opening` invoice per student (unique index `one_opening_invoice_per_student`): a repeated
  import cannot add dues twice. "Add new" keeps existing own fees and dues; "update" changes them,
  but never previous dues that have a payment against them.
- Negative amounts (advances) and unreadable amounts are errors. "3000+600" is added up, "-" is 0.
- Late fees are never added to previous dues.
- Each saved row is one transaction (own fee + invoice + audit entry `fees.import_student`).

## After the import

- Generate invoices from the month after "Previous dues are up to".
- The challan of a month shows **Previous dues** (the student's other unpaid invoices of that month
  or earlier) and **Total payable**, with a PAID / PARTLY PAID / UNPAID stamp. The family voucher
  is unchanged (it already lists every open invoice).
- Paying the voucher: **Record payment → The whole voucher** (`POST /fees/students/:id/payments`)
  settles the oldest dues first, one receipt per invoice reached, all in one transaction.
- Whatever stays unpaid shows as previous dues on the next month's challan.

## Deploy

New index on `invoices`: run `npm run db:indexes -- --apply` after deploying.
