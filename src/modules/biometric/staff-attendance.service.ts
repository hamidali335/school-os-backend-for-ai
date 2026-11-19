import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import { inTransaction } from '../../database/transactions';
import type { SchoolContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, notFound } from '../../utils/errors';
import { assertCampusAccess, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { schoolTimezone } from '../schools/timezone';
import { staffInCampus, visibleStaffIds } from './access';
import { PunchEvent, StaffAttendance, STAFF_ATTENDANCE_STATUSES } from './biometric.models';
import { assertBiometricIndexes } from './index-check';

type Ctx = Pick<SchoolContext, 'schoolId'>;
type StaffStatus = (typeof STAFF_ATTENDANCE_STATUSES)[number];

/**
 * Staff daily attendance. A day is worked out from the staff member's punches ("present", with
 * the first and last punch) unless a person marked it; a marked day is never changed by punches.
 * When a day marked absent or on leave has punches, it is flagged for a person to decide.
 * No punches never means absent: a day without punches and without a mark has no record.
 */

const CONFLICT_PUNCHED_WHILE_OFF = 'marked_off_but_punched';

/** Times a day is worked out again when its punches changed meanwhile (see recomputeStaffDay). */
const RECOMPUTE_ATTEMPTS = 5;

/**
 * Bring one staff member's day up to date with their punches. Safe to call any number of times,
 * also at the same moment for the same day: after writing, the punches are counted again, and if
 * they changed meanwhile (another request stored or moved one, and may have written its summary
 * first) the day is worked out again. So the last write of a day is always checked against the
 * punches as they are after it.
 */
export async function recomputeStaffDay(ctx: Ctx, employeeId: string | Types.ObjectId, localDate: string) {
  await assertBiometricIndexes();
  const empId = oid(String(employeeId));
  for (let attempt = 1; attempt <= RECOMPUTE_ATTEMPTS; attempt++) {
    const counted = await workOutStaffDay(ctx, empId, localDate);
    if ((await PunchEvent.countDocuments(scope(ctx, { employeeId: empId, localDate }))) === counted) return;
  }
  logger.warn(
    { employeeId: String(empId), localDate },
    'Staff day kept changing while it was worked out; it is corrected by the next change or by Recalculate',
  );
}

/** Work the day out once from the punches as read now; returns how many punches it counted. */
async function workOutStaffDay(ctx: Ctx, empId: Types.ObjectId, localDate: string) {
  const punches = await PunchEvent.find(scope(ctx, { employeeId: empId, localDate }))
    .select('punchedAt punchType')
    .sort({ punchedAt: 1 })
    .lean();
  const date = parseDateOnly(localDate);
  const summary = {
    count: punches.length,
    first: punches[0]?.punchedAt,
    last: punches[punches.length - 1]?.punchedAt,
    in: punches.filter((p) => p.punchType === 'in').length,
    out: punches.filter((p) => p.punchType === 'out').length,
  };
  if (!summary.count) {
    // No punches (e.g. the device user was unlinked): a day only the punches made disappears;
    // a marked day keeps its mark, without punch details.
    await StaffAttendance.deleteOne(scope(ctx, { employeeId: empId, date, source: 'biometric' }));
    await StaffAttendance.updateOne(scope(ctx, { employeeId: empId, date, source: 'manual' }), {
      $set: { punches: summary },
      $unset: { conflict: 1 },
    });
    return 0;
  }
  // The punch summary is always kept current; status and source are only set when the day is new,
  // so a day someone marked keeps their mark even when punches arrive at the same moment.
  const day = await StaffAttendance.findOneAndUpdate(
    scope(ctx, { employeeId: empId, date }),
    { $set: { punches: summary }, $setOnInsert: { status: 'present', source: 'biometric' } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  const off = day!.source === 'manual' && (day!.status === 'absent' || day!.status === 'leave');
  if (off && !day!.conflict?.code && !day!.conflictDismissed)
    await StaffAttendance.updateOne(scope(ctx, { _id: day!._id }), {
      $set: {
        conflict: {
          code: CONFLICT_PUNCHED_WHILE_OFF,
          message: `Marked ${day!.status === 'leave' ? 'on leave' : 'absent'}, but the fingerprint machine recorded ${summary.count} punch(es) this day`,
          at: new Date(),
        },
      },
    });
  else if (!off && day!.conflict?.code)
    await StaffAttendance.updateOne(scope(ctx, { _id: day!._id }), { $unset: { conflict: 1 } });
  return summary.count;
}

/** Days worked out at once by recomputeStaffDays (each day is its own record). */
const RECOMPUTE_LANES = 8;

/**
 * Days affected by a change of punches: recompute each once. Different days are worked out a few
 * at a time; inside a transaction (which cannot run operations in parallel) one after another.
 * Returns how many days were worked out.
 */
export async function recomputeStaffDays(ctx: Ctx, days: Array<{ employeeId: unknown; localDate: string }>) {
  const unique = [
    ...new Map(days.filter((d) => d.employeeId).map((d) => [`${String(d.employeeId)}|${d.localDate}`, d])).values(),
  ];
  const lanes = inTransaction() ? 1 : RECOMPUTE_LANES;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(lanes, unique.length) }, async () => {
      while (next < unique.length) {
        const d = unique[next++];
        await recomputeStaffDay(ctx, String(d.employeeId), d.localDate);
      }
    }),
  );
  return unique.length;
}

/** A staff member the caller may mark: of their school and campuses, and not archived. */
async function staffMember(ctx: SchoolContext, employeeId: string) {
  const emp = await staffInCampus(ctx, employeeId);
  if (emp.status === 'archived') throw badRequest('This staff member is archived');
  return emp;
}

async function assertNotFuture(ctx: SchoolContext, date: string) {
  const today = todayInTz(await schoolTimezone(ctx.schoolId));
  if (date > today)
    throw badRequest(
      'Attendance cannot be marked for a future date',
      [{ path: 'body.date', message: 'Choose today or an earlier day' }],
      'VALIDATION_ERROR',
    );
}

/** Mark a day by hand. Replaces what the punches said for that day (they stay visible). */
export async function markStaffDay(
  ctx: SchoolContext,
  input: { employeeId: string; date: string; status: StaffStatus; note?: string },
) {
  const emp = await staffMember(ctx, input.employeeId);
  await assertNotFuture(ctx, input.date);
  await assertBiometricIndexes();
  const date = parseDateOnly(input.date);
  const before = await StaffAttendance.findOne(scope(ctx, { employeeId: emp._id, date })).lean();
  await StaffAttendance.findOneAndUpdate(
    scope(ctx, { employeeId: emp._id, date }),
    {
      $set: {
        status: input.status,
        source: 'manual',
        note: input.note,
        markedBy: oid(ctx.userId),
        markedAt: new Date(),
        conflictDismissed: false,
      },
      $unset: { conflict: 1 },
    },
    { upsert: true },
  );
  await recomputeStaffDay(ctx, emp._id, input.date);
  await audit(ctx, {
    action: 'staff_attendance.mark',
    entityType: 'StaffAttendance',
    entityId: emp._id,
    metadata: {
      date: input.date,
      status: input.status,
      previous: before ? { status: before.status, source: before.source } : null,
    },
  });
  return dayFor(ctx, String(emp._id), input.date);
}

/** Remove a hand-made mark: the day goes back to what the punches say (or no record). */
export async function clearStaffMark(ctx: SchoolContext, employeeId: string, dateStr: string) {
  const emp = await staffMember(ctx, employeeId);
  await assertBiometricIndexes();
  const date = parseDateOnly(dateStr);
  const res = await StaffAttendance.updateOne(scope(ctx, { employeeId: emp._id, date, source: 'manual' }), {
    $set: { source: 'biometric', status: 'present', conflictDismissed: false },
    $unset: { note: 1, markedBy: 1, markedAt: 1, conflict: 1 },
  });
  if (!res.matchedCount) throw notFound('Marked attendance');
  await recomputeStaffDay(ctx, emp._id, dateStr);
  await audit(ctx, {
    action: 'staff_attendance.clear_mark',
    entityType: 'StaffAttendance',
    entityId: emp._id,
    metadata: { date: dateStr },
  });
  return dayFor(ctx, String(emp._id), dateStr);
}

/** Decide a flagged day: keep the hand-made mark, or use the punches (present). */
export async function resolveStaffConflict(ctx: SchoolContext, id: string, action: 'keep_mark' | 'use_punches') {
  const day = await findOwned(StaffAttendance, ctx, id, 'Attendance day');
  await staffInCampus(ctx, String(day.employeeId), 'Attendance day');
  if (!day.conflict?.code) throw badRequest('This day has nothing to resolve');
  if (action === 'keep_mark')
    await StaffAttendance.updateOne(scope(ctx, { _id: day._id }), {
      $set: { conflictDismissed: true },
      $unset: { conflict: 1 },
    });
  else
    await StaffAttendance.updateOne(scope(ctx, { _id: day._id }), {
      $set: {
        source: 'biometric',
        status: 'present',
        conflictDismissed: false,
        markedBy: oid(ctx.userId),
        markedAt: new Date(),
      },
      $unset: { conflict: 1 },
    });
  await audit(ctx, {
    action: 'staff_attendance.resolve',
    entityType: 'StaffAttendance',
    entityId: day._id,
    metadata: { action, date: formatDateOnly(day.date), employeeId: String(day.employeeId) },
  });
  return StaffAttendance.findOne(scope(ctx, { _id: day._id })).lean();
}

async function dayFor(ctx: SchoolContext, employeeId: string, date: string) {
  return StaffAttendance.findOne(scope(ctx, { employeeId: oid(employeeId), date: parseDateOnly(date) })).lean();
}

/**
 * One day for every current staff member: their record, or none ("not recorded" — never shown
 * as absent unless someone marked it).
 */
export async function staffDay(ctx: SchoolContext, q: { date: string; campusId?: string }) {
  const filter: Record<string, unknown> = scope(ctx, { status: { $in: ['active', 'on_leave'] }, ...campusScope(ctx) });
  if (q.campusId) {
    // Narrows the user's campuses; never widens them.
    assertCampusAccess(ctx, q.campusId);
    filter.campusId = oid(q.campusId);
  }
  const staff = await Employee.find(filter)
    .select('firstName lastName employeeNo designation department campusId status')
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  const records = await StaffAttendance.find(
    scope(ctx, { date: parseDateOnly(q.date), employeeId: { $in: staff.map((s) => s._id) } }),
  ).lean();
  const byEmployee = new Map(records.map((r) => [String(r.employeeId), r]));
  const rows = staff.map((s) => ({
    employee: {
      _id: String(s._id),
      name: [s.firstName, s.lastName].filter(Boolean).join(' '),
      employeeNo: s.employeeNo,
      designation: s.designation,
      status: s.status,
    },
    record: byEmployee.get(String(s._id)) ?? null,
  }));
  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  return {
    date: q.date,
    totals: {
      staff: rows.length,
      present: count((r) => r.record?.status === 'present'),
      late: count((r) => r.record?.status === 'late'),
      halfDay: count((r) => r.record?.status === 'half_day'),
      absent: count((r) => r.record?.status === 'absent'),
      leave: count((r) => r.record?.status === 'leave'),
      notRecorded: count((r) => !r.record),
      conflicts: count((r) => Boolean(r.record?.conflict?.code)),
    },
    rows,
  };
}

/** Days with a disagreement to resolve, newest first. */
export async function staffConflicts(ctx: SchoolContext) {
  const staff = await visibleStaffIds(ctx);
  const days = await StaffAttendance.find(
    scope(ctx, { 'conflict.code': { $exists: true }, ...(staff ? { employeeId: { $in: staff } } : {}) }),
  )
    .sort({ date: -1 })
    .limit(200)
    .populate('employeeId', 'firstName lastName employeeNo')
    .lean();
  return days;
}

/* ───────────────────────────── Repair ───────────────────────────── */

export const REPAIR_LIMITS = { maxDays: 62, maxRecords: 20_000 };

/** What a day record says, to tell whether working it out again changed it. */
const fingerprint = (d: Record<string, any> | null) =>
  d
    ? JSON.stringify([
        d.status,
        d.source,
        d.punches?.count ?? 0,
        d.punches?.first?.toISOString?.() ?? null,
        d.punches?.last?.toISOString?.() ?? null,
        d.punches?.in ?? 0,
        d.punches?.out ?? 0,
        d.conflict?.code ?? null,
      ])
    : 'none';

/**
 * Work out staff days again from the stored punches, for a date range (at most
 * REPAIR_LIMITS.maxDays days) and optionally one staff member: for a day whose summary is out of
 * date (e.g. a punch was saved but working out its day failed). Uses the same rules as every
 * other change: hand-made marks and "keep the mark" decisions stay; conflicts are raised or
 * cleared as the punches say. Only the caller's campuses. Safe to repeat: a day already right is
 * left as it is. Reports how many days were checked and how many changed.
 */
export async function repairStaffDays(ctx: SchoolContext, q: { from: string; to: string; employeeId?: string }) {
  if (q.from > q.to) throw badRequest('The start date must be on or before the end date');
  const span = Math.round((parseDateOnly(q.to).getTime() - parseDateOnly(q.from).getTime()) / 86_400_000) + 1;
  if (span > REPAIR_LIMITS.maxDays)
    throw badRequest(`Choose at most ${REPAIR_LIMITS.maxDays} days at a time`, [
      { path: 'body.to', message: `At most ${REPAIR_LIMITS.maxDays} days after the start date` },
    ]);
  await assertBiometricIndexes();
  const staff = q.employeeId ? [(await staffInCampus(ctx, q.employeeId))._id] : await visibleStaffIds(ctx);
  const who = staff ? { employeeId: { $in: staff } } : { employeeId: { $ne: null } };
  const fromDate = parseDateOnly(q.from);
  const toDate = parseDateOnly(q.to);
  const [punchDays, records] = await Promise.all([
    PunchEvent.aggregate<{ _id: { e: Types.ObjectId; d: string } }>([
      { $match: { schoolId: oid(ctx.schoolId), localDate: { $gte: q.from, $lte: q.to }, ...who } },
      { $group: { _id: { e: '$employeeId', d: '$localDate' } } },
    ]),
    StaffAttendance.find(scope(ctx, { date: { $gte: fromDate, $lt: addDays(toDate, 1) }, ...who }))
      .select('employeeId date')
      .lean(),
  ]);
  const days = new Map<string, { employeeId: Types.ObjectId; localDate: string }>();
  for (const p of punchDays) days.set(`${String(p._id.e)}|${p._id.d}`, { employeeId: p._id.e, localDate: p._id.d });
  for (const r of records) {
    const localDate = formatDateOnly(r.date);
    days.set(`${String(r.employeeId)}|${localDate}`, { employeeId: r.employeeId, localDate });
  }
  if (days.size > REPAIR_LIMITS.maxRecords)
    throw badRequest(
      `This range has ${days.size} staff days; choose a shorter range (at most ${REPAIR_LIMITS.maxRecords} at a time)`,
    );
  let repaired = 0;
  const list = [...days.values()];
  let next = 0;
  const dayRecord = (d: (typeof list)[number]) =>
    StaffAttendance.findOne(scope(ctx, { employeeId: d.employeeId, date: parseDateOnly(d.localDate) })).lean();
  await Promise.all(
    Array.from({ length: Math.min(RECOMPUTE_LANES, list.length) }, async () => {
      while (next < list.length) {
        const d = list[next++];
        const before = fingerprint(await dayRecord(d));
        await recomputeStaffDay(ctx, d.employeeId, d.localDate);
        if (fingerprint(await dayRecord(d)) !== before) repaired++;
      }
    }),
  );
  const result = { from: q.from, to: q.to, checked: list.length, repaired };
  await audit(ctx, {
    action: 'staff_attendance.repair',
    entityType: 'StaffAttendance',
    metadata: { ...result, employeeId: q.employeeId ?? null },
  });
  return result;
}

/** Longest date range for a staff attendance report. */
export const STAFF_REPORT_MAX_DAYS = 366;

/**
 * Staff attendance for a date range, one row per staff member: days present, late, half day,
 * absent, on leave and with no record. The percentage counts only days that have a record
 * (a day nobody marked is not assumed absent): (present + late + half days ÷ 2) ÷ recorded days.
 * Names, numbers, designation and department only; never salary or CNIC.
 */
export async function staffAttendanceReport(
  ctx: SchoolContext,
  q: { from: string; to: string; employeeId?: string; department?: string; status?: StaffStatus },
) {
  const from = parseDateOnly(q.from);
  const to = parseDateOnly(q.to);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days < 1) throw badRequest('"to" must be on or after "from"', { field: 'to' });
  if (days > STAFF_REPORT_MAX_DAYS) throw badRequest(`Choose at most ${STAFF_REPORT_MAX_DAYS} days`, { field: 'to' });
  const filter: Record<string, unknown> = scope(ctx, { status: { $ne: 'archived' }, ...campusScope(ctx) });
  if (q.employeeId) filter._id = oid(q.employeeId);
  if (q.department) filter.department = q.department;
  const staff = await Employee.find(filter)
    .select('firstName lastName employeeNo designation department')
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  const records = await StaffAttendance.find(
    scope(ctx, { employeeId: { $in: staff.map((s) => s._id) }, date: { $gte: from, $lte: to } }),
  )
    .select('employeeId status')
    .lean();
  const counts = new Map<string, Record<StaffStatus, number>>();
  for (const r of records) {
    const c = counts.get(String(r.employeeId)) ?? { present: 0, late: 0, half_day: 0, absent: 0, leave: 0 };
    c[r.status as StaffStatus] += 1;
    counts.set(String(r.employeeId), c);
  }
  const rows = staff
    .map((s) => {
      const c = counts.get(String(s._id)) ?? { present: 0, late: 0, half_day: 0, absent: 0, leave: 0 };
      const recorded = c.present + c.late + c.half_day + c.absent + c.leave;
      const attended = c.present + c.late + c.half_day / 2;
      return {
        employeeId: String(s._id),
        name: [s.firstName, s.lastName].filter(Boolean).join(' '),
        employeeNo: s.employeeNo,
        designation: s.designation ?? '',
        department: s.department ?? '',
        present: c.present,
        late: c.late,
        halfDay: c.half_day,
        absent: c.absent,
        leave: c.leave,
        notRecorded: days - recorded,
        attendancePercent: recorded ? Math.round((attended / recorded) * 1000) / 10 : null,
      };
    })
    .filter((r) => !q.status || r[STATUS_FIELD[q.status]] > 0);
  const sum = (k: 'present' | 'late' | 'halfDay' | 'absent' | 'leave' | 'notRecorded') =>
    rows.reduce((t, r) => t + r[k], 0);
  return {
    from: q.from,
    to: q.to,
    days,
    totals: {
      staff: rows.length,
      present: sum('present'),
      late: sum('late'),
      halfDay: sum('halfDay'),
      absent: sum('absent'),
      leave: sum('leave'),
      notRecorded: sum('notRecorded'),
    },
    rows,
  };
}

const STATUS_FIELD: Record<StaffStatus, 'present' | 'late' | 'halfDay' | 'absent' | 'leave'> = {
  present: 'present',
  late: 'late',
  half_day: 'halfDay',
  absent: 'absent',
  leave: 'leave',
};
