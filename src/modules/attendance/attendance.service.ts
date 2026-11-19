import { assertSchoolDay } from '../schools/school-days';
import type { Types } from 'mongoose';
import type { SchoolContext, SystemContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, forbidden, unprocessable } from '../../utils/errors';
import { campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { assertSectionAccess, assertStudentVisible, teacherSectionIds } from '../academics/access.service';
import { Section } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { notifyUsers, parentUserIdsForStudents } from '../communications/communications.service';
import { School } from '../schools/school.model';
import { Student, StudentEnrollment } from '../students/student.models';
import { approvedLeaveOn } from '../leave/leave.service';
import { AttendanceRecord, AttendanceRegister, type AttendanceStatus, type RegisterState } from './attendance.model';
import { countStatuses, emptyCounts, trailingAbsenceStreak, withRate } from './attendance-stats';
import { recordChange, recordChanges } from '../sync/sync.service';
import { atomic } from '../../database/transactions';

type Ctx = SchoolContext;

/** Teachers may correct attendance up to this many days back; older edits need attendance:manage. */
const TEACHER_EDIT_WINDOW_DAYS = 7;

async function schoolToday(schoolId: string) {
  const s = await School.findById(schoolId).select('settings.timezone settings.attendance').lean();
  return { today: todayInTz(s?.settings?.timezone ?? 'Asia/Karachi'), settings: s?.settings?.attendance };
}

export type RegisterSummary = {
  enrolled: number;
  marked: number;
  missing: number;
  finalized: boolean;
  finalizedAt: Date | null;
  state: RegisterState;
};

/**
 * Register state per section for one day, computed from the data: only records of students
 * who are active members of the section count, and a blank is never counted as present or
 * absent. Complete means every active student has a status and the register was finalized.
 */
export async function registerStates(
  actor: Ctx | SystemContext,
  sectionIds: Array<Types.ObjectId | string>,
  day: Date,
): Promise<Map<string, RegisterSummary>> {
  const ids = sectionIds.map((x) => oid(String(x)));
  const [students, records, registers] = await Promise.all([
    Student.find(scope(actor, { sectionId: { $in: ids }, status: 'active' }))
      .select('_id sectionId')
      .lean(),
    AttendanceRecord.find(scope(actor, { sectionId: { $in: ids }, date: day }))
      .select('studentId sectionId')
      .lean(),
    AttendanceRegister.find(scope(actor, { sectionId: { $in: ids }, date: day }))
      .select('sectionId finalizedAt')
      .lean(),
  ]);
  const roster = new Map<string, Set<string>>();
  for (const st of students) {
    const k = st.sectionId.toString();
    if (!roster.has(k)) roster.set(k, new Set());
    roster.get(k)!.add(st._id.toString());
  }
  const markedBy = new Map<string, number>();
  for (const r of records) {
    const k = r.sectionId.toString();
    if (roster.get(k)?.has(r.studentId.toString())) markedBy.set(k, (markedBy.get(k) ?? 0) + 1);
  }
  const finalizedBy = new Map(registers.map((r) => [r.sectionId.toString(), r.finalizedAt ?? null]));
  const out = new Map<string, RegisterSummary>();
  for (const id of ids) {
    const k = id.toString();
    const enrolled = roster.get(k)?.size ?? 0;
    const marked = markedBy.get(k) ?? 0;
    const missing = enrolled - marked;
    const finalizedAt = finalizedBy.get(k) ?? null;
    // A day marked before registers existed has records but no register: complete when every
    // student has a status, as it was then. A saved draft always has a register (see markSection).
    const legacyComplete = !finalizedBy.has(k) && marked > 0 && missing === 0;
    const finalized = Boolean(finalizedAt) || legacyComplete;
    const state: RegisterState = marked === 0 ? 'not_started' : missing === 0 && finalized ? 'complete' : 'draft';
    out.set(k, { enrolled, marked, missing, finalized, finalizedAt, state });
  }
  return out;
}

export async function sectionRoster(ctx: Ctx, sectionId: string, date: string) {
  const section = await findOwned(Section, ctx, sectionId, 'Section');
  await assertSectionAccess(ctx, section._id);
  const day = parseDateOnly(date);
  const enrolledStudentIds = await StudentEnrollment.distinct(
    'studentId',
    scope(ctx, { sectionId: section._id, status: { $in: ['active', 'promoted'] } }),
  );
  const [students, records] = await Promise.all([
    Student.find(
      scope(ctx, {
        $or: [{ sectionId: section._id, status: 'active' }, { _id: { $in: enrolledStudentIds } }],
      }),
    )
      .select('firstName lastName admissionNo rollNo gender')
      .sort({ rollNo: 1, firstName: 1 })
      .lean(),
    AttendanceRecord.find(scope(ctx, { sectionId: section._id, date: day }))
      .select('studentId status remarks')
      .lean(),
  ]);
  const byStudent = new Map(records.map((r) => [r.studentId.toString(), r]));
  // A hint for the register only: approved leave never marks anyone by itself.
  const onLeave = await approvedLeaveOn(
    ctx,
    students.map((s) => s._id as Types.ObjectId),
    day,
  );
  const roster = students.map((s) => ({
    studentId: s._id,
    name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
    admissionNo: s.admissionNo,
    rollNo: s.rollNo,
    status: (byStudent.get(s._id.toString())?.status ?? null) as AttendanceStatus | null,
    remarks: byStudent.get(s._id.toString())?.remarks ?? null,
    onApprovedLeave: onLeave.has(s._id.toString()),
  }));
  const register = (await registerStates(ctx, [section._id], day)).get(section._id.toString())!;
  return {
    sectionId: section._id,
    date,
    marked: records.length > 0,
    state: register.state,
    missingCount: register.missing,
    finalizedAt: register.finalizedAt?.toISOString() ?? null,
    summary: countStatuses(records.map((r) => r.status as AttendanceStatus)),
    students: roster,
  };
}

export async function markSection(
  ctx: Ctx,
  input: {
    sectionId: string;
    date: string;
    records: Array<{ studentId: string; status: AttendanceStatus; remarks?: string }>;
    notifyParents?: boolean;
    /**
     * true: finalize (refused, after saving the entries as a draft, if anyone is unmarked).
     * false: save as a draft. Omitted (older clients): save, and finalize only if complete.
     */
    finalize?: boolean;
  },
) {
  const section = await findOwned(Section, ctx, input.sectionId, 'Section');
  const access = await assertSectionAccess(ctx, section._id, 'attendance');
  const { today } = await schoolToday(ctx.schoolId);
  if (input.date > today) throw badRequest('Cannot mark attendance for a future date');
  await assertSchoolDay(ctx.schoolId, input.date, 'attendance');
  const ageDays = Math.round((parseDateOnly(today).getTime() - parseDateOnly(input.date).getTime()) / 86_400_000);
  if (ageDays > TEACHER_EDIT_WINDOW_DAYS && !ctx.permissions.has('attendance:manage')) {
    throw forbidden(`Attendance older than ${TEACHER_EDIT_WINDOW_DAYS} days can only be changed by an administrator`);
  }
  const ids = [...new Set(input.records.map((r) => r.studentId))];
  if (ids.length !== input.records.length) throw badRequest('Each student may appear only once');
  const enrolledStudentIds = await StudentEnrollment.distinct(
    'studentId',
    scope(ctx, { sectionId: section._id, status: { $in: ['active', 'promoted'] } }),
  );
  const students = await Student.find(
    scope(ctx, {
      _id: { $in: ids.map(oid) },
      $or: [{ sectionId: section._id, status: 'active' }, { _id: { $in: enrolledStudentIds } }],
    }),
  )
    .select('_id')
    .lean();
  if (students.length !== ids.length)
    throw badRequest('Some students are not active members of this section', undefined, 'INVALID_REFERENCE');

  const day = parseDateOnly(input.date);
  const ops = input.records.map((r) => ({
    updateOne: {
      filter: { schoolId: oid(ctx.schoolId), studentId: oid(r.studentId), date: day },
      update: {
        $set: {
          status: r.status,
          remarks: r.remarks,
          markedBy: oid(ctx.userId),
          sectionId: section._id,
          classId: section.classId,
          sessionId: section.sessionId,
          campusId: section.campusId,
        },
      },
      upsert: true,
    },
  }));
  const res = await atomic(async () => {
    const bulkRes = await AttendanceRecord.bulkWrite(ops as any, { ordered: false });

    // Record incremental changes for sync subscribers in a single batch
    const changeItems = input.records.map((r) => ({
      entityType: 'ATTENDANCE',
      entityId: `${r.studentId}_${input.date}`,
      operation: 'INSERT' as const,
      payload: {
        studentId: r.studentId,
        date: input.date,
        status: r.status,
        remarks: r.remarks,
        sectionId: section._id.toString(),
        classId: section.classId?.toString(),
        sessionId: section.sessionId?.toString(),
        campusId: section.campusId?.toString(),
      },
      options: { originDeviceId: 'web_portal' },
    }));
    await recordChanges(ctx.schoolId, changeItems);
    return bulkRes;
  });

  // Completeness is checked against what is saved now (including other teachers' entries).
  const register = (await registerStates(ctx, [section._id], day)).get(section._id.toString())!;
  const missingStudents = register.missing ? await unmarkedStudents(ctx, section._id, day) : [];
  if (input.finalize === true && register.missing > 0) {
    await audit(ctx, {
      action: 'attendance.finalize_blocked',
      entityType: 'Section',
      entityId: section._id,
      outcome: 'failure',
      metadata: { date: input.date, saved: input.records.length, missing: register.missing },
    });
    throw unprocessable(
      `Attendance cannot be finalized. Attendance is missing for ${register.missing} student${register.missing === 1 ? '' : 's'}. ` +
        `The ${input.records.length} entr${input.records.length === 1 ? 'y you marked was' : 'ies you marked were'} saved as a draft.`,
      { saved: input.records.length, missingCount: register.missing, missing: missingStudents },
      'ATTENDANCE_INCOMPLETE',
    );
  }
  const finalize = register.missing === 0 && input.finalize !== false;
  if (finalize)
    await AttendanceRegister.updateOne(
      scope(ctx, { sectionId: section._id, date: day }),
      {
        $set: { finalizedAt: new Date(), finalizedBy: oid(ctx.userId) },
        $setOnInsert: { schoolId: oid(ctx.schoolId) },
      },
      { upsert: true },
    );
  else if (input.finalize === false)
    // Saving a draft reopens a register that was finalized earlier. Always recorded (also for a
    // new register), so a draft with everyone marked is never read as a finished pre-register day.
    await AttendanceRegister.updateOne(
      scope(ctx, { sectionId: section._id, date: day }),
      {
        $unset: { finalizedAt: 1, finalizedBy: 1 },
        $set: { draftSavedAt: new Date(), draftSavedBy: oid(ctx.userId) },
        $setOnInsert: { schoolId: oid(ctx.schoolId) },
      },
      { upsert: true },
    );

  let notified = 0;
  // Parents hear about an absence once the register is final (or from older clients, as before).
  if (input.notifyParents && (finalize || input.finalize === undefined)) {
    // One absence notice per child per day: saving the register again (or correcting another
    // student) must not notify the same parents twice.
    const markedAbsent = input.records.filter((r) => r.status === 'absent').map((r) => r.studentId);
    const alreadyNotified = new Set(
      (
        await AttendanceRecord.find(
          scope(ctx, { studentId: { $in: markedAbsent.map(oid) }, date: day, parentNotifiedAt: { $ne: null } }),
        )
          .select('studentId')
          .lean()
      ).map((r) => String(r.studentId)),
    );
    const absentIds = markedAbsent.filter((id) => !alreadyNotified.has(String(id)));
    if (absentIds.length) {
      const absentStudents = await Student.find(scope(ctx, { _id: { $in: absentIds.map(oid) } }))
        .select('firstName lastName')
        .lean();
      for (const s of absentStudents) {
        const parentUsers = await parentUserIdsForStudents(ctx, [s._id]);
        notified += await notifyUsers(ctx, parentUsers, {
          title: 'Absence notice',
          body: `${s.firstName} ${s.lastName ?? ''} was marked absent on ${input.date}.`.replace('  ', ' '),
          category: 'attendance',
        });
      }
      await AttendanceRecord.updateMany(scope(ctx, { studentId: { $in: absentIds.map(oid) }, date: day }), {
        $set: { parentNotifiedAt: new Date() },
      });
    }
  }
  await audit(ctx, {
    action: 'attendance.mark',
    entityType: 'Section',
    entityId: section._id,
    metadata: {
      date: input.date,
      records: input.records.length,
      finalized: finalize,
      missing: register.missing,
      notifiedParents: notified,
      ...(access.viaSubstitute ? { viaSubstitute: access.viaSubstitute } : {}),
    },
  });
  return {
    sectionId: section._id,
    date: input.date,
    saved: res.upsertedCount + res.matchedCount,
    summary: countStatuses(input.records.map((r) => r.status)),
    parentsNotified: notified,
    finalized: finalize,
    state: (finalize ? 'complete' : 'draft') as RegisterState,
    missingCount: register.missing,
    missing: missingStudents,
  };
}

/** Active students of a section with no status saved for the day (the exact list to finish). */
async function unmarkedStudents(ctx: Ctx, sectionId: Types.ObjectId, day: Date) {
  const enrolledStudentIds = await StudentEnrollment.distinct(
    'studentId',
    scope(ctx, { sectionId, status: { $in: ['active', 'promoted'] } }),
  );
  const [students, records] = await Promise.all([
    Student.find(
      scope(ctx, {
        $or: [{ sectionId, status: 'active' }, { _id: { $in: enrolledStudentIds } }],
      }),
    )
      .select('firstName lastName admissionNo rollNo')
      .sort({ rollNo: 1, firstName: 1 })
      .lean(),
    AttendanceRecord.find(scope(ctx, { sectionId, date: day }))
      .select('studentId')
      .lean(),
  ]);
  const done = new Set(records.map((r) => r.studentId.toString()));
  return students
    .filter((st) => !done.has(st._id.toString()))
    .map((st) => ({
      studentId: st._id.toString(),
      name: `${st.firstName} ${st.lastName ?? ''}`.trim(),
      admissionNo: st.admissionNo,
      rollNo: st.rollNo ?? null,
    }));
}

export async function studentAttendance(ctx: Ctx, studentId: string, from: string, to: string) {
  await assertStudentVisible(ctx, studentId);
  const student = await findOwned(
    Student,
    ctx,
    studentId,
    'Student',
    'firstName lastName admissionNo sectionId campusId',
  );
  if (ctx.role === 'teacher' && !(await teacherSectionIds(ctx)).includes(student.sectionId.toString())) {
    throw forbidden('You are not assigned to this student’s section');
  }
  const records = await AttendanceRecord.find(
    scope(ctx, { studentId: student._id, date: { $gte: parseDateOnly(from), $lte: parseDateOnly(to) } }),
  )
    .select('date status remarks')
    .sort({ date: 1 })
    .lean();
  return {
    student: {
      _id: student._id,
      name: `${student.firstName} ${student.lastName ?? ''}`.trim(),
      admissionNo: student.admissionNo,
    },
    from,
    to,
    summary: countStatuses(records.map((r) => r.status as AttendanceStatus)),
    currentAbsenceStreak: trailingAbsenceStreak(records as any),
    records: records.map((r) => ({ date: formatDateOnly(r.date), status: r.status, remarks: r.remarks })),
  };
}

/** Daily overview: which sections are marked and today's rates. */
export async function dailySummary(actor: Ctx | SystemContext, date?: string) {
  const { today } = await schoolToday(actor.schoolId);
  const day = parseDateOnly(date ?? today);
  const sectionFilter: Record<string, unknown> = scope(actor);
  if (actor.kind === 'school') Object.assign(sectionFilter, campusScope(actor));
  const school = await School.findById(actor.schoolId).select('settings.currentSessionId').lean();
  if (school?.settings?.currentSessionId) sectionFilter.sessionId = school.settings.currentSessionId;
  const [sections, rows, enrolment] = await Promise.all([
    Section.find(sectionFilter).select('name classId').populate('classId', 'name level').lean(),
    AttendanceRecord.aggregate([
      { $match: scope(actor, { date: day }) },
      { $group: { _id: { sectionId: '$sectionId', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Student.aggregate([
      { $match: scope(actor, { status: 'active' }) },
      { $group: { _id: '$sectionId', count: { $sum: 1 } } },
    ]),
  ]);
  const enrolled = new Map(enrolment.map((e) => [e._id.toString(), e.count]));
  const states = await registerStates(
    actor,
    sections.map((s) => s._id),
    day,
  );
  const bySection = new Map<string, ReturnType<typeof emptyCounts>>();
  for (const r of rows) {
    const key = r._id.sectionId.toString();
    const c = bySection.get(key) ?? emptyCounts();
    (c as any)[r._id.status] = r.count;
    bySection.set(key, c);
  }
  const overall = emptyCounts();
  const list = sections
    .map((s) => {
      const c = bySection.get(s._id.toString());
      if (c) for (const k of ['present', 'absent', 'late', 'leave', 'excused'] as const) overall[k] += c[k];
      return {
        sectionId: s._id,
        section: `${(s.classId as any)?.name ?? ''} ${s.name}`.trim(),
        level: (s.classId as any)?.level ?? 0,
        enrolled: enrolled.get(s._id.toString()) ?? 0,
        marked: Boolean(c),
        state: states.get(s._id.toString())?.state ?? ('not_started' as RegisterState),
        missing: states.get(s._id.toString())?.missing ?? 0,
        counts: c ? withRate(c) : null,
      };
    })
    .filter((s) => s.enrolled > 0)
    .sort((a, b) => a.level - b.level || a.section.localeCompare(b.section));
  return {
    date: formatDateOnly(day),
    overall: withRate(overall),
    sectionsMarked: list.filter((s) => s.marked).length,
    sectionsTotal: list.length,
    unmarkedSections: list.filter((s) => !s.marked).map((s) => ({ sectionId: s.sectionId, section: s.section })),
    /** Started but not finished: some students have no status, or the register is not finalized. */
    incompleteSections: list
      .filter((s) => s.state === 'draft')
      .map((s) => ({ sectionId: s.sectionId, section: s.section, missing: s.missing })),
    sections: list,
  };
}

/** Per-student attendance rates over a range; flags students below the school threshold. */
export async function attendanceReport(
  actor: Ctx | SystemContext,
  q: { from: string; to: string; classId?: string; sectionId?: string; belowThreshold?: boolean },
) {
  const school = await School.findById(actor.schoolId).select('settings.attendance').lean();
  const threshold = school?.settings?.attendance?.lowAttendanceThreshold ?? 75;
  const match: Record<string, unknown> = scope(actor, {
    date: { $gte: parseDateOnly(q.from), $lte: parseDateOnly(q.to) },
  });
  if (actor.kind === 'school') Object.assign(match, campusScope(actor));
  if (q.classId) match.classId = oid(q.classId);
  if (q.sectionId) match.sectionId = oid(q.sectionId);
  const rows = await AttendanceRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$studentId',
        present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ['$status', 'late'] }, 1, 0] } },
        leave: { $sum: { $cond: [{ $eq: ['$status', 'leave'] }, 1, 0] } },
        excused: { $sum: { $cond: [{ $eq: ['$status', 'excused'] }, 1, 0] } },
      },
    },
    { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 's' } },
    { $unwind: '$s' },
    {
      $project: {
        studentId: '$_id',
        _id: 0,
        name: { $trim: { input: { $concat: ['$s.firstName', ' ', { $ifNull: ['$s.lastName', ''] }] } } },
        admissionNo: '$s.admissionNo',
        sectionId: '$s.sectionId',
        present: 1,
        absent: 1,
        late: 1,
        leave: 1,
        excused: 1,
      },
    },
  ]);
  const students = rows
    .map((r) => ({ ...r, ...withRate(r) }))
    .filter((r) => !q.belowThreshold || (r.rate !== null && r.rate < threshold))
    .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101));
  const overall = withRate(
    rows.reduce(
      (acc, r) => {
        for (const k of ['present', 'absent', 'late', 'leave', 'excused'] as const) acc[k] += r[k];
        return acc;
      },
      { present: 0, absent: 0, late: 0, leave: 0, excused: 0 },
    ),
  );
  const daily = await AttendanceRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$date',
        present: { $sum: { $cond: [{ $in: ['$status', ['present', 'late']] }, 1, 0] } },
        counted: { $sum: { $cond: [{ $in: ['$status', ['present', 'late', 'absent']] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return {
    from: q.from,
    to: q.to,
    threshold,
    overall,
    belowThresholdCount: rows.map((r) => withRate(r)).filter((r) => r.rate !== null && r.rate < threshold).length,
    trend: daily.map((d) => ({
      date: formatDateOnly(d._id),
      rate: d.counted ? Math.round((d.present / d.counted) * 1000) / 10 : null,
    })),
    students,
  };
}

/** Students absent N or more consecutive marked days up to today (for alerts and AI insights). */
export async function chronicAbsentees(actor: Ctx | SystemContext, minStreak?: number) {
  const school = await School.findById(actor.schoolId).select('settings.attendance settings.timezone').lean();
  const streak = minStreak ?? school?.settings?.attendance?.consecutiveAbsenceAlert ?? 3;
  const today = parseDateOnly(todayInTz(school?.settings?.timezone ?? 'Asia/Karachi'));
  const since = addDays(today, -Math.max(14, streak * 3));
  const records = await AttendanceRecord.find(scope(actor, { date: { $gte: since, $lte: today } }))
    .select('studentId date status')
    .sort({ date: 1 })
    .lean();
  const byStudent = new Map<string, Array<{ status: AttendanceStatus }>>();
  for (const r of records) {
    const k = r.studentId.toString();
    byStudent.set(k, [...(byStudent.get(k) ?? []), { status: r.status as AttendanceStatus }]);
  }
  const flagged = [...byStudent.entries()]
    .map(([id, recs]) => ({ studentId: id, streak: trailingAbsenceStreak(recs) }))
    .filter((s) => s.streak >= streak);
  if (!flagged.length) return [];
  const students = await Student.find(
    scope(actor, { _id: { $in: flagged.map((f) => oid(f.studentId)) }, status: 'active' }),
  )
    .select('firstName lastName admissionNo sectionId')
    .lean();
  return students.map((s) => ({
    studentId: s._id.toString(),
    name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
    admissionNo: s.admissionNo,
    sectionId: s.sectionId.toString(),
    consecutiveAbsences: flagged.find((f) => f.studentId === s._id.toString())!.streak,
  }));
}
