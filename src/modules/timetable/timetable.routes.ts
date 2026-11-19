import type { Types } from 'mongoose';
import { WEEKDAY_NAMES, workingDays } from '../schools/school-days';
import type { SchoolContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { parseDateOnly, timeToMinutes } from '../../utils/dates';
import { AppError, badRequest, forbidden, unprocessable } from '../../utils/errors';
import { assertRefs, findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, timeHHmm, z } from '../../utils/zod';
import { teacherSectionIds, visibleStudentIds } from '../academics/access.service';
import { Section, Subject } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { Student } from '../students/student.models';
import { findConflicts, scanConflicts, type Slot } from './conflicts';
// import { registerTimetableImportRoutes } from './timetable-import';
import { TimetableEntry } from './timetable.model';
import { activeCovers, datesBetween, isoWeekday, lessonsForCovers } from './cover-lessons';

const EntryShape = z.object({
  sectionId: objectId(),
  subjectId: objectId(),
  teacherId: objectId().nullable().optional(),
  dayOfWeek: z.number().int().min(1).max(7).openapi({ description: '1 = Monday … 7 = Sunday' }),
  startTime: timeHHmm(),
  endTime: timeHHmm(),
  room: z.string().trim().max(30).optional(),
});
const EntryBody = EntryShape.refine((v) => timeToMinutes(v.startTime) < timeToMinutes(v.endTime), {
  message: 'endTime must be after startTime',
  path: ['endTime'],
});

const EntryRes = z
  .object({
    ...docBase,
    sessionId: objectId(),
    campusId: objectId(),
    sectionId: z.any(),
    subjectId: z.any(),
    teacherId: z.any().optional(),
    dayOfWeek: z.number(),
    startTime: z.string(),
    endTime: z.string(),
    room: z.string().optional(),
  })
  .openapi('TimetableEntry');

const ConflictRes = z
  .object({
    type: z.enum(['section', 'teacher', 'room']),
    withEntryId: z.string().optional(),
    dayOfWeek: z.number(),
    message: z.string(),
  })
  .openapi('TimetableConflict');

type EntryInput = z.infer<typeof EntryBody>;

const toSlot = (e: {
  _id?: Types.ObjectId;
  sectionId: any;
  teacherId?: any;
  campusId: any;
  room?: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}): Slot => ({
  id: e._id?.toString(),
  sectionId: e.sectionId.toString(),
  teacherId: e.teacherId ? e.teacherId.toString() : null,
  campusId: e.campusId.toString(),
  room: e.room,
  dayOfWeek: e.dayOfWeek,
  startMinutes: e.startMinutes,
  endMinutes: e.endMinutes,
});

async function buildEntry(ctx: SchoolContext, input: EntryInput) {
  const days = await workingDays(ctx.schoolId);
  if (!days.includes(input.dayOfWeek))
    throw unprocessable(
      `${WEEKDAY_NAMES[input.dayOfWeek - 1]} is an off day for your school. Choose a school day, or change the school days in Settings → School days.`,
      { dayOfWeek: input.dayOfWeek, workingDays: days },
      'SCHOOL_CLOSED',
    );
  await assertRefs(ctx, [
    [Section, input.sectionId, 'sectionId'],
    [Subject, input.subjectId, 'subjectId'],
    [Employee, input.teacherId, 'teacherId'],
  ]);
  const section = await Section.findOne(scope(ctx, { _id: oid(input.sectionId) }))
    .select('sessionId campusId')
    .lean();
  return {
    ...input,
    teacherId: input.teacherId ?? undefined,
    schoolId: oid(ctx.schoolId),
    sessionId: section!.sessionId,
    campusId: section!.campusId,
    startMinutes: timeToMinutes(input.startTime),
    endMinutes: timeToMinutes(input.endTime),
  };
}

async function conflictsFor(
  ctx: SchoolContext,
  entry: Awaited<ReturnType<typeof buildEntry>>,
  excludeIds: string[] = [],
) {
  const candidates = await TimetableEntry.find(
    scope(ctx, {
      sessionId: entry.sessionId,
      dayOfWeek: entry.dayOfWeek,
      startMinutes: { $lt: entry.endMinutes },
      endMinutes: { $gt: entry.startMinutes },
      _id: { $nin: excludeIds.map(oid) },
    }),
  ).lean();
  return findConflicts(toSlot(entry as any), candidates.map(toSlot));
}

const conflictError = (conflicts: unknown[]) =>
  new AppError(409, 'TIMETABLE_CONFLICT', 'The period conflicts with the existing timetable', { conflicts } as any);

const populate = (q: any) =>
  q
    .populate('subjectId', 'name code')
    .populate('teacherId', 'firstName lastName')
    .populate('sectionId', 'name classId');

export function registerTimetableRoutes(api: Api) {
  const tags = ['Timetable'];

  // Bulk import from a CSV file (preview + import).
  // registerTimetableImportRoutes(api);

  api.route({
    method: 'get',
    path: '/timetable',
    tags,
    auth: 'school',
    permission: 'timetable:read',
    summary: 'Timetable for a section or teacher',
    description:
      'Parents/students: omit filters to get their (children’s) section timetables. Teachers may omit filters to get their own.',
    query: z.object({
      sectionId: objectId().optional(),
      teacherId: objectId().optional(),
      dayOfWeek: z.coerce.number().int().min(1).max(7).optional(),
    }),
    response: z.array(EntryRes),
    handler: async ({ ctx, query }) => {
      const filter: Record<string, unknown> = scope(ctx);
      const visible = await visibleStudentIds(ctx);
      if (visible) {
        const kids = await Student.find(scope(ctx, { _id: { $in: visible.map(oid) } }))
          .select('sectionId')
          .lean();
        const allowed = kids.map((k) => k.sectionId.toString());
        if (query.sectionId && !allowed.includes(query.sectionId)) return [];
        filter.sectionId = { $in: (query.sectionId ? [query.sectionId] : allowed).map(oid) };
      } else if (query.sectionId) {
        if (ctx.role === 'teacher' && !(await teacherSectionIds(ctx)).includes(query.sectionId))
          throw forbidden('You can only view the timetable of your own classes');
        filter.sectionId = oid(query.sectionId);
      }
      if (ctx.role === 'teacher' && query.teacherId && query.teacherId !== ctx.employeeId)
        throw forbidden('You can only view your own timetable');
      if (query.teacherId && !visible) filter.teacherId = oid(query.teacherId);
      if (!visible && !query.sectionId && !query.teacherId) {
        if (ctx.role === 'teacher' && ctx.employeeId) filter.teacherId = oid(ctx.employeeId);
        else throw badRequest('Provide sectionId or teacherId');
      }
      if (query.dayOfWeek) filter.dayOfWeek = query.dayOfWeek;
      return populate(TimetableEntry.find(filter).sort({ dayOfWeek: 1, startMinutes: 1 })).lean();
    },
  });

  api.route({
    method: 'get',
    path: '/timetable/dated',
    tags,
    auth: 'school',
    permission: 'timetable:read',
    summary: 'Timetable for actual dates, including substitute (cover) lessons',
    description:
      'For each date in the range: the regular lessons for that weekday, plus cover lessons. For a teacher: lessons they cover for someone else (`kind: cover`) and their own lessons covered by someone else (`coveredBy`). ' +
      'For a section: who covers each lesson. Cover lessons are computed from the weekly timetable and the active cover assignments; the regular timetable is never changed. ' +
      'Same access rules as `GET /timetable`. At most 31 days.',
    query: z.object({
      from: isoDate(),
      to: isoDate(),
      sectionId: objectId().optional(),
      teacherId: objectId().optional(),
    }),
    response: z.array(
      z.object({
        date: z.string(),
        dayOfWeek: z.number(),
        lessons: z.array(
          z.object({
            kind: z.enum(['regular', 'cover']),
            startTime: z.string(),
            endTime: z.string(),
            room: z.string().nullable(),
            section: z.object({ _id: z.string(), name: z.string() }),
            subject: z.object({ _id: z.string(), name: z.string() }),
            teacher: z.object({ _id: z.string(), name: z.string() }).nullable(),
            /** Regular lesson taken by a substitute on this date. */
            coveredBy: z.object({ _id: z.string(), name: z.string(), coverId: z.string() }).nullable(),
            /** Cover lesson: whose lesson it is. */
            coveringFor: z.object({ _id: z.string(), name: z.string(), coverId: z.string() }).nullable(),
          }),
        ),
      }),
    ),
    handler: async ({ ctx, query }) => {
      if (query.from > query.to) throw badRequest('"to" must be on or after "from"', { field: 'to' });
      const days = datesBetween(query.from, query.to);
      if (days.length > 31) throw badRequest('Choose at most 31 days', { field: 'to' });
      // The same access rules as GET /timetable.
      let sectionIds: string[] | null = null;
      let teacherId: string | null = null;
      const visible = await visibleStudentIds(ctx);
      if (visible) {
        const kids = await Student.find(scope(ctx, { _id: { $in: visible.map(oid) } }))
          .select('sectionId')
          .lean();
        const allowed = kids.map((k) => k.sectionId.toString());
        sectionIds = query.sectionId ? (allowed.includes(query.sectionId) ? [query.sectionId] : []) : allowed;
      } else if (query.sectionId) {
        if (ctx.role === 'teacher' && !(await teacherSectionIds(ctx)).includes(query.sectionId))
          throw forbidden('You can only view the timetable of your own classes');
        sectionIds = [query.sectionId];
      } else {
        if (ctx.role === 'teacher' && query.teacherId && query.teacherId !== ctx.employeeId)
          throw forbidden('You can only view your own timetable');
        teacherId = query.teacherId ?? (ctx.role === 'teacher' ? (ctx.employeeId ?? null) : null);
        if (!teacherId) throw badRequest('Provide sectionId or teacherId');
      }
      const weekdays = [...new Set(days.map((d) => isoWeekday(parseDateOnly(d))))];
      const regular = await TimetableEntry.find(
        scope(ctx, {
          dayOfWeek: { $in: weekdays },
          ...(teacherId ? { teacherId: oid(teacherId) } : { sectionId: { $in: (sectionIds ?? []).map(oid) } }),
        }),
      ).lean();
      const covers = teacherId
        ? await activeCovers(ctx, query.from, query.to, { teacherId })
        : (
            await Promise.all(
              (sectionIds ?? []).map((sid) => activeCovers(ctx, query.from, query.to, { sectionId: sid })),
            )
          ).flat();
      const coverLessons = await lessonsForCovers(ctx, covers, query.from, query.to);

      // Names, loaded once.
      const ids = {
        sections: new Set<string>([
          ...regular.map((e) => String(e.sectionId)),
          ...coverLessons.map((l) => l.sectionId),
        ]),
        subjects: new Set<string>([
          ...regular.map((e) => String(e.subjectId)),
          ...coverLessons.map((l) => l.subjectId),
        ]),
        teachers: new Set<string>([
          ...regular.filter((e) => e.teacherId).map((e) => String(e.teacherId)),
          ...coverLessons.flatMap((l) => [l.originalTeacherId, l.substituteTeacherId]),
        ]),
      };
      const [secs, subs, emps] = await Promise.all([
        Section.find(scope(ctx, { _id: { $in: [...ids.sections].map(oid) } }))
          .populate('classId', 'name')
          .select('name classId')
          .lean(),
        Subject.find(scope(ctx, { _id: { $in: [...ids.subjects].map(oid) } }))
          .select('name')
          .lean(),
        Employee.find(scope(ctx, { _id: { $in: [...ids.teachers].map(oid) } }))
          .select('firstName lastName')
          .lean(),
      ]);
      const secName = new Map(
        secs.map((x) => [x._id.toString(), `${(x.classId as { name?: string } | null)?.name ?? ''} ${x.name}`.trim()]),
      );
      const subName = new Map(subs.map((x) => [x._id.toString(), x.name]));
      const empName = new Map(emps.map((x) => [x._id.toString(), `${x.firstName} ${x.lastName ?? ''}`.trim()]));
      const ref = (m: Map<string, string>, id: string) => ({ _id: id, name: m.get(id) ?? '' });

      return days.map((date) => {
        const dow = isoWeekday(parseDateOnly(date));
        const todays = coverLessons.filter((l) => l.date === date);
        const lessons = regular
          .filter((e) => e.dayOfWeek === dow)
          .map((e) => {
            const cover = todays.find((l) => l.entryId === String(e._id));
            return {
              kind: 'regular' as const,
              startTime: e.startTime,
              endTime: e.endTime,
              startMinutes: e.startMinutes,
              room: e.room ?? null,
              section: ref(secName, String(e.sectionId)),
              subject: ref(subName, String(e.subjectId)),
              teacher: e.teacherId ? ref(empName, String(e.teacherId)) : null,
              coveredBy: cover ? { ...ref(empName, cover.substituteTeacherId), coverId: cover.coverId } : null,
              coveringFor: null,
            };
          });
        // A teacher's view also lists the lessons they cover for someone else.
        if (teacherId)
          for (const l of todays.filter((x) => x.substituteTeacherId === teacherId))
            lessons.push({
              kind: 'cover' as never,
              startTime: l.startTime,
              endTime: l.endTime,
              startMinutes: l.startMinutes,
              room: l.room ?? null,
              section: ref(secName, l.sectionId),
              subject: ref(subName, l.subjectId),
              teacher: ref(empName, teacherId),
              coveredBy: null,
              coveringFor: { ...ref(empName, l.originalTeacherId), coverId: l.coverId } as never,
            });
        return {
          date,
          dayOfWeek: dow,
          lessons: lessons.sort((a, b) => a.startMinutes - b.startMinutes).map(({ startMinutes: _m, ...rest }) => rest),
        };
      });
    },
  });

  api.route({
    method: 'post',
    path: '/timetable/check',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: 'Dry-run: report conflicts for a proposed period without saving',
    body: EntryBody.and(z.object({ excludeEntryId: objectId().optional() })),
    response: z.object({ ok: z.boolean(), conflicts: z.array(ConflictRes) }),
    handler: async ({ ctx, body }) => {
      const { excludeEntryId, ...input } = body as EntryInput & { excludeEntryId?: string };
      const conflicts = await conflictsFor(ctx, await buildEntry(ctx, input), excludeEntryId ? [excludeEntryId] : []);
      return { ok: conflicts.length === 0, conflicts };
    },
  });

  api.route({
    method: 'post',
    path: '/timetable',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: 'Add a period',
    description:
      'Rejected with 409 `TIMETABLE_CONFLICT` (details.conflicts) when the section, teacher or room is double-booked.',
    body: EntryBody,
    response: EntryRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      const entry = await buildEntry(ctx, body);
      const conflicts = await conflictsFor(ctx, entry);
      if (conflicts.length) throw conflictError(conflicts);
      const doc = await TimetableEntry.create(entry);
      await audit(ctx, { action: 'timetable.create', entityType: 'TimetableEntry', entityId: doc._id });
      return doc.toObject();
    },
  });

  api.route({
    method: 'patch',
    path: '/timetable/:id',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: 'Change a period',
    params: idParams,
    body: z.object({
      sectionId: objectId().optional(),
      subjectId: objectId().optional(),
      teacherId: objectId().nullable().optional(),
      dayOfWeek: z.number().int().min(1).max(7).optional(),
      startTime: timeHHmm().optional(),
      endTime: timeHHmm().optional(),
      room: z.string().trim().max(30).optional(),
    }),
    response: EntryRes,
    handler: async ({ ctx, params, body }) => {
      const existing = await findOwned(TimetableEntry, ctx, params.id, 'Timetable entry');
      const merged = {
        sectionId: body.sectionId ?? existing.sectionId.toString(),
        subjectId: body.subjectId ?? existing.subjectId.toString(),
        teacherId: body.teacherId === null ? null : (body.teacherId ?? existing.teacherId?.toString()),
        dayOfWeek: body.dayOfWeek ?? existing.dayOfWeek,
        startTime: body.startTime ?? existing.startTime,
        endTime: body.endTime ?? existing.endTime,
        room: body.room ?? existing.room ?? undefined,
      };
      const parsed = EntryBody.safeParse(merged);
      if (!parsed.success)
        throw badRequest(
          'Invalid period',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const entry = await buildEntry(ctx, parsed.data);
      const conflicts = await conflictsFor(ctx, entry, [params.id]);
      if (conflicts.length) throw conflictError(conflicts);
      const update: Record<string, unknown> = { $set: entry };
      if (!entry.teacherId) update.$unset = { teacherId: 1 };
      if (!entry.teacherId) delete (entry as any).teacherId;
      const doc = await TimetableEntry.findOneAndUpdate(scope(ctx, { _id: existing._id }), update, {
        returnDocument: 'after',
      }).lean();
      await audit(ctx, { action: 'timetable.update', entityType: 'TimetableEntry', entityId: existing._id });
      return doc;
    },
  });

  api.route({
    method: 'delete',
    path: '/timetable/:id',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: 'Remove a period',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const existing = await findOwned(TimetableEntry, ctx, params.id, 'Timetable entry');
      await TimetableEntry.deleteOne(scope(ctx, { _id: existing._id }));
      await audit(ctx, { action: 'timetable.delete', entityType: 'TimetableEntry', entityId: existing._id });
    },
  });

  api.route({
    method: 'put',
    path: '/timetable/sections/:id',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: "Replace a section's whole weekly timetable (all-or-nothing)",
    description:
      'Validates conflicts within the submitted periods and against other sections. Nothing is saved if any conflict exists.',
    params: idParams,
    body: z.object({ entries: z.array(EntryShape.omit({ sectionId: true })).max(80) }),
    response: z.array(EntryRes),
    handler: async ({ ctx, params, body }) => {
      const section = await findOwned(Section, ctx, params.id, 'Section');
      const built = [];
      for (const e of body.entries) {
        if (timeToMinutes(e.startTime) >= timeToMinutes(e.endTime)) throw badRequest('endTime must be after startTime');
        built.push(await buildEntry(ctx, { ...e, sectionId: section._id.toString() }));
      }
      const internal = scanConflicts(built.map((b, i) => ({ ...toSlot(b as any), id: `new-${i}` })));
      const currentIds = (
        await TimetableEntry.find(scope(ctx, { sectionId: section._id }))
          .select('_id')
          .lean()
      ).map((d) => d._id.toString());
      const external = (await Promise.all(built.map((b) => conflictsFor(ctx, b, currentIds)))).flat();
      if (internal.length || external.length) throw conflictError([...internal, ...external]);
      await TimetableEntry.deleteMany(scope(ctx, { sectionId: section._id }));
      if (built.length) await TimetableEntry.insertMany(built);
      await audit(ctx, {
        action: 'timetable.replace_section',
        entityType: 'Section',
        entityId: section._id,
        metadata: { periods: built.length },
      });
      return populate(
        TimetableEntry.find(scope(ctx, { sectionId: section._id })).sort({ dayOfWeek: 1, startMinutes: 1 }),
      ).lean();
    },
  });

  api.route({
    method: 'get',
    path: '/timetable/conflicts',
    tags,
    auth: 'school',
    permission: 'timetable:manage',
    summary: 'Scan the timetable of a session for existing conflicts',
    query: z.object({ sessionId: objectId() }),
    response: z.array(ConflictRes.extend({ entryId: z.string().optional() })),
    handler: async ({ ctx, query }) => {
      const entries = await TimetableEntry.find(scope(ctx, { sessionId: oid(query.sessionId) })).lean();
      return scanConflicts(entries.map(toSlot));
    },
  });

  api.route({
    method: 'get',
    path: '/timetable/teacher-load',
    tags,
    auth: 'school',
    permission: 'timetable:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff'],
    summary: 'Teaching periods and minutes per teacher per week',
    query: z.object({ sessionId: objectId() }),
    response: z.array(z.object({ teacherId: objectId(), name: z.string(), periods: z.number(), minutes: z.number() })),
    handler: async ({ ctx, query }) => {
      const rows = await TimetableEntry.aggregate([
        { $match: scope(ctx, { sessionId: oid(query.sessionId), teacherId: { $ne: null } }) },
        {
          $group: {
            _id: '$teacherId',
            periods: { $sum: 1 },
            minutes: { $sum: { $subtract: ['$endMinutes', '$startMinutes'] } },
          },
        },
        { $lookup: { from: 'employees', localField: '_id', foreignField: '_id', as: 't' } },
        { $unwind: '$t' },
        {
          $project: {
            _id: 0,
            teacherId: '$_id',
            periods: 1,
            minutes: 1,
            name: { $concat: ['$t.firstName', ' ', { $ifNull: ['$t.lastName', ''] }] },
          },
        },
        { $sort: { minutes: -1 } },
      ]);
      return rows;
    },
  });
}
