import type { SchoolContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { findOwned, oid, scope } from '../../utils/tenant';
import { docBase, idParams, isoDate, objectId, paginationQuery, z } from '../../utils/zod';
import { audit } from '../audit/audit.service';
import { coverClashes } from '../timetable/cover-lessons';
import { Employee } from '../employees/employee.model';
import { School } from '../schools/school.model';
import {
  Section,
  Subject,
  SUBSTITUTE_CAPABILITIES,
  SubstituteAssignment,
  TeachingAssignment,
} from './academics.models';

/** Longest single cover; longer absences should be handled by reassigning the class. */
export const MAX_COVER_DAYS = 62;

const SubstituteRes = z
  .object({
    ...docBase,
    sessionId: objectId(),
    originalTeacherId: z.any(),
    substituteTeacherId: z.any(),
    sectionId: z.any(),
    subjectId: z.any().optional(),
    startDate: z.string(),
    endDate: z.string(),
    periods: z.string().optional(),
    reason: z.string().optional(),
    capabilities: z.array(z.enum(SUBSTITUTE_CAPABILITIES)),
    status: z.enum(['active', 'cancelled']),
    state: z.enum(['upcoming', 'current', 'expired', 'cancelled']),
    createdBy: z.any(),
    cancelledAt: z.string().optional(),
    cancelReason: z.string().optional(),
  })
  .openapi('SubstituteAssignment');

const Body = z
  .object({
    originalTeacherId: objectId(),
    substituteTeacherId: objectId(),
    sectionId: objectId(),
    subjectId: objectId()
      .nullable()
      .optional()
      .openapi({ description: 'Omit to cover everything the original teacher teaches in the section' }),
    startDate: isoDate(),
    endDate: isoDate(),
    periods: z.string().trim().max(120).optional(),
    reason: z.string().trim().max(300).optional(),
    capabilities: z
      .array(z.enum(SUBSTITUTE_CAPABILITIES))
      .min(1)
      .max(3)
      .optional()
      .openapi({ description: 'Default: attendance and homework. Viewing the class is always included.' }),
    acceptClashes: z.boolean().optional().openapi({
      description:
        'Assign even though the substitute already teaches at some of these times (after reviewing the clash list)',
    }),
  })
  .refine((v) => v.startDate <= v.endDate, { message: 'endDate must be on or after startDate', path: ['endDate'] })
  .refine((v) => v.originalTeacherId !== v.substituteTeacherId, {
    message: 'The substitute must be a different teacher',
    path: ['substituteTeacherId'],
  });

async function schoolToday(schoolId: string) {
  const s = await School.findById(schoolId).select('settings.timezone').lean();
  return todayInTz(s?.settings?.timezone ?? 'Asia/Karachi');
}

const populate = (q: any) =>
  q
    .populate('originalTeacherId', 'firstName lastName employeeNo')
    .populate('substituteTeacherId', 'firstName lastName employeeNo')
    .populate('sectionId', 'name classId')
    .populate('subjectId', 'name code')
    .populate('createdBy', 'name');

function withState<T extends { status: string; startDate: Date; endDate: Date }>(doc: T, today: string) {
  const start = formatDateOnly(doc.startDate);
  const end = formatDateOnly(doc.endDate);
  const state =
    doc.status === 'cancelled' ? 'cancelled' : end < today ? 'expired' : start > today ? 'upcoming' : 'current';
  return { ...doc, state };
}

interface CoverInput {
  originalTeacherId: string;
  substituteTeacherId: string;
  sectionId: string;
  subjectId?: string | null;
  startDate: string;
  endDate: string;
}

/** Validates people, scope and dates; returns the section. Shared by create and update. */
async function validateCover(ctx: SchoolContext, input: CoverInput, excludeId?: string) {
  const today = await schoolToday(ctx.schoolId);
  if (input.endDate < today)
    throw badRequest('The cover has already ended; choose current or future dates', { field: 'endDate' });
  if (input.startDate < formatDateOnly(addDays(parseDateOnly(today), -7)))
    throw badRequest('A cover cannot start more than 7 days in the past', { field: 'startDate' });
  const days =
    Math.round((parseDateOnly(input.endDate).getTime() - parseDateOnly(input.startDate).getTime()) / 86_400_000) + 1;
  if (days > MAX_COVER_DAYS)
    throw badRequest(`A cover can last at most ${MAX_COVER_DAYS} days. For longer absences reassign the class.`, {
      field: 'endDate',
    });

  const section = await findOwned(Section, ctx, input.sectionId, 'Section');
  const [original, substitute] = await Promise.all([
    Employee.findOne(scope(ctx, { _id: oid(input.originalTeacherId) }))
      .select('staffType status firstName')
      .lean(),
    Employee.findOne(scope(ctx, { _id: oid(input.substituteTeacherId) }))
      .select('staffType status userId')
      .lean(),
  ]);
  if (!original)
    throw badRequest(
      'The absent teacher does not exist in this school',
      { field: 'originalTeacherId' },
      'INVALID_REFERENCE',
    );
  if (!substitute)
    throw badRequest(
      'The substitute does not exist in this school',
      { field: 'substituteTeacherId' },
      'INVALID_REFERENCE',
    );
  if (substitute.staffType !== 'teaching' || substitute.status !== 'active')
    throw badRequest('The substitute must be an active teacher', { field: 'substituteTeacherId' });

  // The cover may only include duties the absent teacher actually has in this section.
  const isClassTeacher = String(section.classTeacherId ?? '') === input.originalTeacherId;
  if (input.subjectId) {
    await findOwned(Subject, ctx, input.subjectId, 'Subject');
    const teaches = await TeachingAssignment.exists(
      scope(ctx, { sectionId: section._id, subjectId: oid(input.subjectId), teacherId: oid(input.originalTeacherId) }),
    );
    if (!teaches && !isClassTeacher)
      throw badRequest('The absent teacher does not teach this subject in this section', { field: 'subjectId' });
    const subAlready = await TeachingAssignment.exists(
      scope(ctx, {
        sectionId: section._id,
        subjectId: oid(input.subjectId),
        teacherId: oid(input.substituteTeacherId),
      }),
    );
    if (subAlready)
      throw badRequest('The substitute already teaches this subject in this section', { field: 'substituteTeacherId' });
  } else {
    const teachesAny = await TeachingAssignment.exists(
      scope(ctx, { sectionId: section._id, teacherId: oid(input.originalTeacherId) }),
    );
    if (!teachesAny && !isClassTeacher)
      throw badRequest('The absent teacher has no classes in this section', { field: 'sectionId' });
  }

  // One active cover per section/subject per day: overlapping covers would make it unclear
  // who is responsible. A whole-section cover overlaps every subject of that section.
  const overlap = await SubstituteAssignment.findOne(
    scope(ctx, {
      ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}),
      sectionId: section._id,
      status: 'active',
      startDate: { $lte: parseDateOnly(input.endDate) },
      endDate: { $gte: parseDateOnly(input.startDate) },
      ...(input.subjectId ? { $or: [{ subjectId: oid(input.subjectId) }, { subjectId: null }] } : {}),
    }),
  )
    .select('_id startDate endDate')
    .lean();
  if (overlap)
    throw conflict(
      `Another cover for this class already runs from ${formatDateOnly(overlap.startDate)} to ${formatDateOnly(overlap.endDate)}. Change or cancel it first.`,
      { conflictingId: overlap._id.toString() },
      'SUBSTITUTE_CONFLICT',
    );
  return section;
}

/** Section and subject names for a list of lessons or clashes. */
async function namesFor(ctx: SchoolContext, ids: { sections: string[]; subjects: string[] }) {
  const [sections, subjects] = await Promise.all([
    Section.find(scope(ctx, { _id: { $in: ids.sections.map(oid) } }))
      .populate('classId', 'name')
      .select('name classId')
      .lean(),
    Subject.find(scope(ctx, { _id: { $in: ids.subjects.map(oid) } }))
      .select('name')
      .lean(),
  ]);
  const sec = new Map(
    sections.map((x) => [x._id.toString(), `${(x.classId as { name?: string } | null)?.name ?? ''} ${x.name}`.trim()]),
  );
  const sub = new Map(subjects.map((x) => [x._id.toString(), x.name]));
  return { section: (id: string) => sec.get(id) ?? '', subject: (id: string) => sub.get(id) ?? '' };
}

/**
 * The dated lessons a cover stands for and any clash with what the substitute already
 * teaches (own timetable or another cover) at the same date and time.
 */
async function coverPlan(ctx: SchoolContext, input: CoverInput, excludeId?: string) {
  const { lessons, clashes } = await coverClashes(
    ctx,
    {
      _id: excludeId,
      sectionId: input.sectionId,
      subjectId: input.subjectId ?? null,
      originalTeacherId: input.originalTeacherId,
      substituteTeacherId: input.substituteTeacherId,
      startDate: parseDateOnly(input.startDate),
      endDate: parseDateOnly(input.endDate),
    } as never,
    input.startDate,
    input.endDate,
  );
  const n = await namesFor(ctx, {
    sections: [...new Set([...lessons.map((l) => l.sectionId), ...clashes.map((c) => c.clashWith.sectionId)])],
    subjects: [...new Set([...lessons.map((l) => l.subjectId), ...clashes.map((c) => c.clashWith.subjectId)])],
  });
  return {
    lessons: lessons.map((l) => ({
      date: l.date,
      startTime: l.startTime,
      endTime: l.endTime,
      section: n.section(l.sectionId),
      subject: n.subject(l.subjectId),
    })),
    clashes: clashes.map((c) => ({
      date: c.date,
      startTime: c.startTime,
      endTime: c.endTime,
      section: n.section(c.sectionId),
      subject: n.subject(c.subjectId),
      clashWith: `${c.clashWith.kind === 'own_lesson' ? 'Own lesson' : 'Another cover'}: ${n.subject(c.clashWith.subjectId)} in ${n.section(c.clashWith.sectionId)} (${c.clashWith.startTime}–${c.clashWith.endTime})`,
    })),
  };
}

function assertNoClashes(plan: Awaited<ReturnType<typeof coverPlan>>, accept?: boolean) {
  if (plan.clashes.length && !accept)
    throw conflict(
      `The substitute already teaches at ${plan.clashes.length} of these times. Choose another substitute, change the dates, or assign anyway.`,
      { clashes: plan.clashes },
      'SUBSTITUTE_TIMETABLE_CONFLICT',
    );
}

const PlanRes = z.object({
  lessons: z.array(
    z.object({
      date: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      section: z.string(),
      subject: z.string(),
    }),
  ),
  clashes: z.array(
    z.object({
      date: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      section: z.string(),
      subject: z.string(),
      clashWith: z.string(),
    }),
  ),
});

export function registerSubstituteRoutes(api: Api) {
  const tags = ['Substitute teachers'];

  api.route({
    method: 'get',
    path: '/substitutes',
    tags,
    auth: 'school',
    permission: 'substitutes:manage',
    summary: 'Substitute (cover) assignments',
    query: paginationQuery.extend({
      state: z.enum(['current', 'upcoming', 'expired', 'cancelled', 'active']).optional(),
      teacherId: objectId().optional().openapi({ description: 'Absent or substitute teacher' }),
      sectionId: objectId().optional(),
    }),
    response: SubstituteRes,
    paginated: true,
    handler: async ({ ctx, query }) => {
      const today = await schoolToday(ctx.schoolId);
      const t = parseDateOnly(today);
      const filter: Record<string, unknown> = scope(ctx);
      if (query.sectionId) filter.sectionId = oid(query.sectionId);
      if (query.teacherId)
        filter.$or = [{ originalTeacherId: oid(query.teacherId) }, { substituteTeacherId: oid(query.teacherId) }];
      if (query.state === 'cancelled') filter.status = 'cancelled';
      else if (query.state) {
        filter.status = 'active';
        if (query.state === 'current') Object.assign(filter, { startDate: { $lte: t }, endDate: { $gte: t } });
        if (query.state === 'upcoming') filter.startDate = { $gt: t };
        if (query.state === 'expired') filter.endDate = { $lt: t };
        if (query.state === 'active') filter.endDate = { $gte: t };
      }
      const page = await paginate(SubstituteAssignment, filter, {
        page: query.page,
        limit: query.limit,
        sort: { startDate: -1 },
        populate: [
          { path: 'originalTeacherId', select: 'firstName lastName employeeNo' },
          { path: 'substituteTeacherId', select: 'firstName lastName employeeNo' },
          { path: 'sectionId', select: 'name classId' },
          { path: 'subjectId', select: 'name code' },
          { path: 'createdBy', select: 'name' },
        ],
      });
      return { ...page, items: (page.items as any[]).map((d) => withState(d, today)) };
    },
  });

  api.route({
    method: 'get',
    path: '/substitutes/mine',
    tags,
    auth: 'school',
    roles: ['teacher'],
    summary: 'Covers the signed-in teacher is doing (current and upcoming)',
    response: z.array(SubstituteRes),
    handler: async ({ ctx }) => {
      if (!ctx.employeeId) return [];
      const today = await schoolToday(ctx.schoolId);
      const rows = await populate(
        SubstituteAssignment.find(
          scope(ctx, {
            substituteTeacherId: oid(ctx.employeeId),
            status: 'active',
            endDate: { $gte: parseDateOnly(today) },
          }),
        ).sort({ startDate: 1 }),
      ).lean();
      return rows.map((d: any) => withState(d, today));
    },
  });

  api.route({
    method: 'post',
    path: '/substitutes/preview',
    tags,
    auth: 'school',
    permission: 'substitutes:manage',
    summary: 'Preview a cover: the dated lessons it covers and any timetable clash for the substitute',
    description:
      'Nothing is saved. Uses the absent teacher’s regular timetable for that section (and subject) on each date.',
    body: Body,
    response: PlanRes,
    handler: async ({ ctx, body }) => {
      await validateCover(ctx, body);
      return coverPlan(ctx, body);
    },
  });

  api.route({
    method: 'post',
    path: '/substitutes',
    tags,
    auth: 'school',
    permission: 'substitutes:manage',
    summary: 'Assign a substitute teacher for a period',
    description:
      'The substitute can act for the absent teacher in the chosen section (and subject) only between the dates, and only for the chosen capabilities. ' +
      'The original teaching assignment is not changed. Overlapping covers for the same class are rejected (`SUBSTITUTE_CONFLICT`). ' +
      'If the substitute already teaches (or covers) at any of the covered lesson times, it is refused with the list of clashes (`SUBSTITUTE_TIMETABLE_CONFLICT`) unless `acceptClashes` is true. ' +
      'The cover lessons appear on the dated timetable (`GET /timetable/dated`) for the substitute, the absent teacher and the class.',
    body: Body,
    response: SubstituteRes,
    status: 201,
    handler: async ({ ctx, body }) => {
      const section = await validateCover(ctx, body);
      assertNoClashes(await coverPlan(ctx, body), body.acceptClashes);
      const { acceptClashes: _accept, ...data } = body;
      const doc = await SubstituteAssignment.create({
        ...data,
        subjectId: body.subjectId ?? undefined,
        schoolId: ctx.schoolId,
        sessionId: section.sessionId,
        startDate: parseDateOnly(body.startDate),
        endDate: parseDateOnly(body.endDate),
        capabilities: body.capabilities ?? ['attendance', 'homework'],
        createdBy: ctx.userId,
      });
      await audit(ctx, {
        action: 'substitute.assigned',
        entityType: 'SubstituteAssignment',
        entityId: doc._id,
        metadata: {
          originalTeacherId: body.originalTeacherId,
          substituteTeacherId: body.substituteTeacherId,
          sectionId: body.sectionId,
          subjectId: body.subjectId ?? null,
          from: body.startDate,
          to: body.endDate,
          capabilities: doc.capabilities,
        },
      });
      const today = await schoolToday(ctx.schoolId);
      return withState(await populate(SubstituteAssignment.findOne(scope(ctx, { _id: doc._id }))).lean(), today);
    },
  });

  api.route({
    method: 'patch',
    path: '/substitutes/:id',
    tags,
    auth: 'school',
    permission: 'substitutes:manage',
    summary: 'Change a substitute assignment (dates, substitute, scope, capabilities)',
    params: idParams,
    body: z.object({
      substituteTeacherId: objectId().optional(),
      subjectId: objectId().nullable().optional(),
      startDate: isoDate().optional(),
      endDate: isoDate().optional(),
      periods: z.string().trim().max(120).optional(),
      reason: z.string().trim().max(300).optional(),
      capabilities: z.array(z.enum(SUBSTITUTE_CAPABILITIES)).min(1).max(3).optional(),
      acceptClashes: z.boolean().optional(),
    }),
    response: SubstituteRes,
    handler: async ({ ctx, params, body }) => {
      const existing = await findOwned(SubstituteAssignment, ctx, params.id, 'Substitute assignment');
      if (existing.status === 'cancelled') throw conflict('This cover was cancelled; create a new one instead');
      const next = {
        originalTeacherId: existing.originalTeacherId.toString(),
        substituteTeacherId: body.substituteTeacherId ?? existing.substituteTeacherId.toString(),
        sectionId: existing.sectionId.toString(),
        subjectId: body.subjectId === undefined ? (existing.subjectId?.toString() ?? null) : body.subjectId,
        startDate: body.startDate ?? formatDateOnly(existing.startDate),
        endDate: body.endDate ?? formatDateOnly(existing.endDate),
      };
      if (next.startDate > next.endDate)
        throw badRequest('endDate must be on or after startDate', { field: 'endDate' });
      if (next.substituteTeacherId === next.originalTeacherId)
        throw badRequest('The substitute must be a different teacher', { field: 'substituteTeacherId' });
      await validateCover(ctx, next, existing._id.toString());
      assertNoClashes(await coverPlan(ctx, next, existing._id.toString()), body.acceptClashes);
      const set: Record<string, unknown> = {
        substituteTeacherId: oid(next.substituteTeacherId),
        startDate: parseDateOnly(next.startDate),
        endDate: parseDateOnly(next.endDate),
        updatedBy: oid(ctx.userId),
      };
      if (body.periods !== undefined) set.periods = body.periods;
      if (body.reason !== undefined) set.reason = body.reason;
      if (body.capabilities) set.capabilities = body.capabilities;
      const update: Record<string, unknown> = { $set: set };
      if (next.subjectId) set.subjectId = oid(next.subjectId);
      else update.$unset = { subjectId: 1 };
      await SubstituteAssignment.updateOne(scope(ctx, { _id: existing._id, status: 'active' }), update);
      await audit(ctx, {
        action: 'substitute.updated',
        entityType: 'SubstituteAssignment',
        entityId: existing._id,
        metadata: { fields: Object.keys(body) },
      });
      const today = await schoolToday(ctx.schoolId);
      return withState(await populate(SubstituteAssignment.findOne(scope(ctx, { _id: existing._id }))).lean(), today);
    },
  });

  api.route({
    method: 'post',
    path: '/substitutes/:id/cancel',
    tags,
    auth: 'school',
    permission: 'substitutes:manage',
    summary: 'Cancel a substitute assignment (access ends immediately)',
    params: idParams,
    body: z.object({ reason: z.string().trim().max(300).optional() }),
    response: SubstituteRes,
    handler: async ({ ctx, params, body }) => {
      const existing = await findOwned(SubstituteAssignment, ctx, params.id, 'Substitute assignment');
      const res = await SubstituteAssignment.updateOne(scope(ctx, { _id: existing._id, status: 'active' }), {
        $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: oid(ctx.userId), cancelReason: body.reason },
      });
      if (!res.modifiedCount) throw conflict('This cover is already cancelled');
      await audit(ctx, {
        action: 'substitute.cancelled',
        entityType: 'SubstituteAssignment',
        entityId: existing._id,
        metadata: { reason: body.reason },
      });
      const today = await schoolToday(ctx.schoolId);
      const doc = await populate(SubstituteAssignment.findOne(scope(ctx, { _id: existing._id }))).lean();
      if (!doc) throw notFound('Substitute assignment');
      return withState(doc, today);
    },
  });
}
