import { nextNumber } from '../../../database/counter.model';
import { scope } from '../../../utils/tenant';
import { CreateEmployeeBody, type CreateEmployeeInput } from '../../employees/employee.schemas';
import { Employee } from '../../employees/employee.model';
import { createEmployee } from '../../employees/employees.service';
import { User } from '../../users/user.model';
import { fieldLabel } from '../import-fields';
import {
  nameKey,
  parseAmount,
  parseCnic,
  parseDate,
  parseEmail,
  parseEmployeeStatus,
  parseGender,
  parsePhone,
  parseStaffType,
  parseText,
  numberKey,
  phoneKey,
} from '../import-values';
import { SchoolRefs } from './school-refs';
import { RowReader, splitName, type Processor, type RowPlan, breathe } from './types';

const label = (f: string) => fieldLabel('staff', f);

/**
 * Staff import through createEmployee(), the same code as the Add staff form: teaching staff get
 * a teacher login waiting for activation (no message is sent) when the importer may create
 * logins. Existing staff (same Employee No or CNIC) are skipped, never changed.
 */
export const staffProcessor: Processor<CreateEmployeeInput> = {
  async plan(ctx, rows, options) {
    const refs = await SchoolRefs.load(ctx);
    const warnings = refs.defaultsProblems(
      options,
      rows.some((r) => r.cells.campusName),
    );
    if (options.mode === 'upsert')
      warnings.push('Staff already in the system are skipped: updating staff records by import is not supported.');
    const emails = rows
      .map((r) => (r.cells.email ? parseEmail(r.cells.email) : null))
      .flatMap((e) => (e?.ok ? [e.value] : []));
    // All staff of the school (small projection): identity checks must not depend on formatting.
    const [existing, users] = await Promise.all([
      Employee.find(scope(ctx)).select('employeeNo cnic firstName lastName phone email campusId').lean(),
      User.find(scope(ctx, { email: { $in: emails } }))
        .select('email')
        .lean(),
    ]);
    const byNo = new Map(existing.map((e) => [e.employeeNo.toLowerCase(), e]));
    const byCnic = new Map(existing.filter((e) => e.cnic).map((e) => [e.cnic!.replace(/-/g, ''), e]));
    const takenEmails = new Set(users.map((u) => u.email?.toLowerCase()));
    const byName = new Map<string, typeof existing>();
    const byNumber = new Map<string, typeof existing>();
    for (const e of existing) {
      const k = nameKey(`${e.firstName} ${e.lastName ?? ''}`);
      byName.set(k, [...(byName.get(k) ?? []), e]);
      const nk = numberKey(e.employeeNo);
      if (nk) byNumber.set(nk, [...(byNumber.get(nk) ?? []), e]);
    }
    const visibleCampus = (campusId: unknown) => !ctx.campusIds.length || ctx.campusIds.includes(String(campusId));
    const seenPerson = new Map<string, number>();
    const seenNo = new Map<string, number>();
    const seenCnic = new Map<string, number>();
    const seenEmail = new Map<string, number>();
    const canLogin = ctx.permissions.has('users:manage');
    if (options.createLogins && !canLogin && rows.some((r) => /teach/i.test(r.cells.staffType ?? '')))
      warnings.push(
        'You cannot create login accounts, so teachers are added without a login. Ask the school Admin to create them later.',
      );
    const out: RowPlan<CreateEmployeeInput>[] = [];

    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      let firstName: string | undefined;
      let lastName: string | undefined;
      if (r.has('fullName')) {
        const full = r.opt('fullName', (v) => parseText(v, 120));
        if (full) ({ firstName, lastName } = splitName(full));
      } else {
        firstName = r.req('firstName', (v) => parseText(v, 60), 'Full Name is required');
        lastName = r.opt('lastName', (v) => parseText(v, 60));
      }
      const staffType = r.req('staffType', parseStaffType);
      const designation = r.req('designation', (v) => parseText(v, 60, 2));
      const employeeNo = r.opt('employeeNo', (v) => parseText(v, 20)) ?? row.assignedKey;
      const cnic = r.opt('cnic', parseCnic);
      const email = r.opt('email', parseEmail);
      const campus = refs.campus(r, 'campusName', options);
      if (!campus && !r.has('campusName')) r.error(undefined, 'Choose the campus for this import');
      const basic = r.opt('basicSalary', parseAmount);
      const input: Record<string, unknown> = {
        campusId: campus?.id,
        employeeNo,
        firstName,
        lastName,
        gender: r.opt('gender', parseGender),
        cnic,
        phone: r.opt('phone', parsePhone),
        email,
        address: r.opt('address', (v) => parseText(v, 300)),
        designation,
        department: r.opt('department', (v) => parseText(v, 60)),
        staffType,
        qualification: r.opt('qualification', (v) => parseText(v, 120)),
        joiningDate: r.opt('joiningDate', parseDate),
        status: r.opt('status', parseEmployeeStatus),
        ...(basic !== undefined ? { salary: { basic } } : {}),
        login: { create: staffType === 'teaching' && options.createLogins && canLogin },
      };
      const plan: RowPlan<CreateEmployeeInput> = {
        rowNo: row.rowNo,
        check: 'create',
        issues: r.issues,
        changes: [],
        key: employeeNo,
      };
      // The same rules as the Add staff form.
      const parsed = r.failed ? null : CreateEmployeeBody.safeParse(stripUndefined(input));
      if (parsed && !parsed.success)
        for (const i of parsed.error.issues)
          plan.issues.push({
            level: 'error',
            field: String(i.path[0] ?? ''),
            message: `${label(String(i.path[0] ?? ''))}: ${i.message}`,
          });
      if (!parsed?.success) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const dupIn = (map: Map<string, number>, key: string | undefined, what: string) => {
        if (!key) return false;
        const first = map.get(key);
        if (first) {
          plan.issues.push({ level: 'error', message: `${what} also appears on row ${first}` });
          return true;
        }
        map.set(key, row.rowNo);
        return false;
      };
      if (
        dupIn(seenNo, employeeNo?.toLowerCase(), `Employee No ${employeeNo}`) ||
        dupIn(seenCnic, cnic?.replace(/-/g, ''), 'This CNIC') ||
        dupIn(seenEmail, email, `Email ${email}`)
      ) {
        out.push({ ...plan, check: 'duplicate' });
        continue;
      }
      const match = (employeeNo && byNo.get(employeeNo.toLowerCase())) || (cnic && byCnic.get(cnic.replace(/-/g, '')));
      if (match) {
        const same =
          nameKey(`${match.firstName} ${match.lastName ?? ''}`) === nameKey(`${firstName} ${lastName ?? ''}`);
        plan.issues.push({
          level: same ? 'info' : 'warning',
          message: `Already in the system as ${match.employeeNo}${same ? '' : ' with a different name'}; skipped`,
        });
        out.push({ ...plan, check: 'exists', existingId: String(match._id) });
        continue;
      }
      // Likely the same person: same name and the same phone (any format) or email, or the same
      // employee number apart from leading zeros. Skipped unless the user chose to import anyway.
      const fullKey = nameKey(`${firstName} ${lastName ?? ''}`);
      const phone = parsed.data.phone;
      const nk = employeeNo ? numberKey(employeeNo) : null;
      const likely =
        (nk
          ? (byNumber.get(nk) ?? []).find(
              (e) => e.employeeNo !== employeeNo && nameKey(`${e.firstName} ${e.lastName ?? ''}`) === fullKey,
            )
          : undefined) ??
        (byName.get(fullKey) ?? []).find(
          (e) =>
            (phone && e.phone && phoneKey(e.phone) === phoneKey(phone)) || (email && e.email?.toLowerCase() === email),
        );
      const personKey = phone ? `${fullKey}|${phoneKey(phone)}` : email ? `${fullKey}|${email}` : undefined;
      const twin = personKey ? seenPerson.get(personKey) : undefined;
      if (likely || twin) {
        const who = likely
          ? `Likely already in the system: ${visibleCampus(likely.campusId) ? `${likely.firstName} ${likely.lastName ?? ''}`.trim() + ` (${likely.employeeNo})` : 'a staff member in another campus'} has the same name and ${phone && likely.phone && phoneKey(likely.phone) === phoneKey(phone) ? 'phone' : email && likely.email?.toLowerCase() === email ? 'email' : 'employee number apart from leading zeros'}`
          : `Likely the same person as row ${twin}`;
        if (options.skipPossibleDuplicates) {
          plan.issues.push({ level: 'warning', message: `${who}; skipped` });
          out.push({ ...plan, check: 'duplicate', ...(likely ? { existingId: String(likely._id) } : {}) });
          continue;
        }
        plan.issues.push({ level: 'warning', message: `${who}; imported anyway as you chose` });
      }
      if (personKey && !seenPerson.has(personKey)) seenPerson.set(personKey, row.rowNo);
      if (email && takenEmails.has(email)) {
        plan.issues.push({
          level: 'error',
          field: 'email',
          message: `${label('email')}: already used by another login in this school`,
        });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      out.push({ ...plan, payload: parsed.data });
    }
    return { rows: out, warnings };
  },

  async assignKey(ctx, plan) {
    if (plan.payload?.employeeNo) return undefined;
    return nextNumber(ctx.schoolId, 'employee', 'EMP-', 4);
  },

  async apply(ctx, plan) {
    const created = await createEmployee(ctx, { ...plan.payload!, employeeNo: plan.payload!.employeeNo ?? plan.key });
    const login = created.account
      ? '; teacher login waiting for activation'
      : created.accountSkipped
        ? '; no login (permission)'
        : '';
    return { result: 'created', entityId: String(created._id), message: `Employee No ${created.employeeNo}${login}` };
  },
};

function stripUndefined(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
