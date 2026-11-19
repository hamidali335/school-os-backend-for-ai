import { nextNumber } from '../../database/counter.model';
import type { SchoolContext, SystemContext } from '../../types/context';
import { addDays, localDayRange, parseDateOnly, todayInTz } from '../../utils/dates';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { paginate, textSearchFilter } from '../../utils/pagination';
import { assertCampusAccess, assertRefs, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { SchoolClass } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Campus } from '../campuses/campus.model';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { createStudent, type StudentInput } from '../students/students.service';
import { User } from '../users/user.model';
import { Inquiry, INQUIRY_SOURCES, INQUIRY_STAGES } from './inquiry.model';

type Ctx = SchoolContext;

export interface InquiryInput {
  campusId: string;
  studentName: string;
  gender?: 'male' | 'female' | 'other';
  dateOfBirth?: string;
  classSoughtId?: string;
  parentName: string;
  phone: string;
  email?: string;
  address?: string;
  previousSchool?: string;
  source?: (typeof INQUIRY_SOURCES)[number];
  priority?: 'low' | 'medium' | 'high';
  assignedTo?: string;
  nextFollowUpAt?: string;
  notes?: string;
}

async function prepare(ctx: Ctx, input: Partial<InquiryInput>) {
  await assertRefs(ctx, [
    [Campus, input.campusId, 'campusId'],
    [SchoolClass, input.classSoughtId, 'classSoughtId'],
    [User, input.assignedTo, 'assignedTo'],
  ]);
  if (input.campusId) assertCampusAccess(ctx, input.campusId);
  const out: Record<string, any> = { ...input };
  if (input.dateOfBirth) out.dateOfBirth = parseDateOnly(input.dateOfBirth);
  if (input.nextFollowUpAt) out.nextFollowUpAt = new Date(input.nextFollowUpAt);
  if (input.classSoughtId) {
    const cls = await SchoolClass.findOne(scope(ctx, { _id: oid(input.classSoughtId) }))
      .select('name')
      .lean();
    out.classSoughtName = cls?.name;
  }
  return out;
}

export async function createInquiry(ctx: Ctx, input: InquiryInput) {
  const data = await prepare(ctx, input);
  const duplicate = await Inquiry.findOne(
    scope(ctx, { phone: input.phone, studentName: input.studentName, stage: { $nin: ['admitted', 'lost'] } }),
  )
    .select('inquiryNo')
    .lean();
  if (duplicate)
    throw conflict(`An open inquiry already exists for this student (${duplicate.inquiryNo})`, {
      inquiryId: duplicate._id,
    });
  const inquiryNo = await nextNumber(ctx.schoolId, 'inquiry', 'INQ-', 5);
  const doc = await Inquiry.create({
    ...data,
    schoolId: ctx.schoolId,
    inquiryNo,
    assignedTo: input.assignedTo ?? ctx.userId,
    nextFollowUpAt: data.nextFollowUpAt ?? addDays(new Date(), 1),
  });
  await audit(ctx, { action: 'inquiry.create', entityType: 'Inquiry', entityId: doc._id });
  return doc.toObject();
}

export async function listInquiries(
  ctx: Ctx,
  q: {
    page: number;
    limit: number;
    stage?: string;
    source?: string;
    assignedTo?: string;
    campusId?: string;
    followUpDue?: boolean;
    q?: string;
  },
) {
  const filter: Record<string, unknown> = scope(ctx, campusScope(ctx));
  if (q.stage) filter.stage = q.stage;
  if (q.source) filter.source = q.source;
  if (q.assignedTo) filter.assignedTo = oid(q.assignedTo);
  if (q.campusId) filter.campusId = oid(q.campusId);
  if (q.followUpDue) {
    filter.stage = { $nin: ['admitted', 'lost'] };
    filter.nextFollowUpAt = { $lte: new Date() };
  }
  const match = textSearchFilter(q.q, ['studentName', 'parentName'], ['phone', 'inquiryNo']);
  if (match) filter.$or = match.$or;
  return paginate(Inquiry, filter, {
    page: q.page,
    limit: q.limit,
    sort: q.followUpDue ? { nextFollowUpAt: 1 } : { createdAt: -1 },
    select: '-followUps',
    populate: { path: 'assignedTo', select: 'name' },
  });
}

export async function getInquiry(ctx: Ctx, id: string) {
  const doc = await Inquiry.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) }))
    .populate('assignedTo', 'name email')
    .populate('classSoughtId', 'name')
    .lean();
  if (!doc) throw notFound('Inquiry');
  return doc;
}

export async function updateInquiry(ctx: Ctx, id: string, input: Partial<InquiryInput> & { stage?: string }) {
  const existing = await findOwned(Inquiry, ctx, id, 'Inquiry');
  assertCampusAccess(ctx, existing.campusId);
  if (input.stage === 'admitted') throw badRequest('Use the convert endpoint to admit an inquiry');
  if (input.stage === 'lost') throw badRequest('Use the lost endpoint to close an inquiry');
  const data = await prepare(ctx, input);
  const updated = await Inquiry.findOneAndUpdate(
    scope(ctx, { _id: existing._id }),
    { $set: data },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  await audit(ctx, {
    action: 'inquiry.update',
    entityType: 'Inquiry',
    entityId: existing._id,
    metadata: { fields: Object.keys(input) },
  });
  return updated;
}

export async function addFollowUp(
  ctx: Ctx,
  id: string,
  input: {
    channel: string;
    note: string;
    outcome?: string;
    nextFollowUpAt?: string | null;
    stage?: (typeof INQUIRY_STAGES)[number];
  },
) {
  const existing = await findOwned(Inquiry, ctx, id, 'Inquiry');
  assertCampusAccess(ctx, existing.campusId);
  if (['admitted', 'lost'].includes(existing.stage)) throw conflict(`Inquiry is already ${existing.stage}`);
  if (input.stage && ['admitted', 'lost'].includes(input.stage)) throw badRequest('Use the convert or lost endpoint');
  const set: Record<string, unknown> = { lastContactedAt: new Date() };
  if (input.nextFollowUpAt !== undefined)
    set.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
  if (input.stage) set.stage = input.stage;
  else if (existing.stage === 'new') set.stage = 'contacted';
  const updated = await Inquiry.findOneAndUpdate(
    scope(ctx, { _id: existing._id }),
    {
      $set: set,
      $push: {
        followUps: {
          at: new Date(),
          by: oid(ctx.userId),
          byName: ctx.name,
          channel: input.channel,
          note: input.note,
          outcome: input.outcome,
        },
      },
    },
    { returnDocument: 'after' },
  ).lean();
  await audit(ctx, { action: 'inquiry.follow_up', entityType: 'Inquiry', entityId: existing._id });
  return updated;
}

export async function markLost(ctx: Ctx, id: string, reason: string) {
  const existing = await findOwned(Inquiry, ctx, id, 'Inquiry');
  if (existing.stage === 'admitted') throw conflict('Inquiry has already been admitted');
  const updated = await Inquiry.findOneAndUpdate(
    scope(ctx, { _id: existing._id }),
    { $set: { stage: 'lost', lostReason: reason, nextFollowUpAt: null } },
    { returnDocument: 'after' },
  ).lean();
  await audit(ctx, { action: 'inquiry.lost', entityType: 'Inquiry', entityId: existing._id });
  return updated;
}

export async function convertInquiry(
  ctx: Ctx,
  id: string,
  input: Omit<StudentInput, 'firstName' | 'campusId' | 'guardians'> & { firstName?: string; lastName?: string },
) {
  const inquiry = await findOwned(Inquiry, ctx, id, 'Inquiry');
  assertCampusAccess(ctx, inquiry.campusId);
  if (inquiry.stage === 'admitted') throw conflict('Inquiry has already been converted');
  if (inquiry.stage === 'lost') throw conflict('Re-open a lost inquiry before converting it');
  const [first, ...rest] = inquiry.studentName.split(' ');
  const student = await createStudent(ctx, {
    ...input,
    campusId: inquiry.campusId.toString(),
    firstName: input.firstName ?? first,
    lastName: input.lastName ?? (rest.join(' ') || undefined),
    dateOfBirth:
      input.dateOfBirth ?? (inquiry.dateOfBirth ? inquiry.dateOfBirth.toISOString().slice(0, 10) : undefined),
    previousSchool: input.previousSchool ?? inquiry.previousSchool ?? undefined,
    address: input.address ?? inquiry.address ?? undefined,
    guardians: [
      {
        parent: { name: inquiry.parentName, phone: inquiry.phone, email: inquiry.email ?? undefined },
        isPrimary: true,
      },
    ],
  });
  await Inquiry.updateOne(scope(ctx, { _id: inquiry._id }), {
    $set: { stage: 'admitted', convertedStudentId: student._id, nextFollowUpAt: null },
  });
  await Student.updateOne(scope(ctx, { _id: student._id }), { $set: { inquiryId: inquiry._id } });
  await audit(ctx, {
    action: 'inquiry.converted',
    entityType: 'Inquiry',
    entityId: inquiry._id,
    metadata: { studentId: student._id.toString() },
  });
  return { inquiryId: inquiry._id, student };
}

/** Funnel metrics. Pure database aggregation — never AI-computed. */
export async function pipeline(actor: Ctx | SystemContext, input: { from?: string; to?: string } = {}) {
  const match: Record<string, unknown> = scope(actor, actor.kind === 'school' ? campusScope(actor) : {});
  const school = await School.findById(actor.schoolId).select('settings.timezone').lean();
  const tz = school?.settings?.timezone || 'Asia/Karachi';
  if (input.from || input.to) {
    match.createdAt = {
      ...(input.from ? { $gte: localDayRange(input.from, input.from, tz).start } : {}),
      ...(input.to ? { $lt: localDayRange(input.to, input.to, tz).end } : {}),
    };
  }
  const today = parseDateOnly(todayInTz(tz));
  const [byStage, bySource, due] = await Promise.all([
    Inquiry.aggregate([{ $match: match }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    Inquiry.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$source',
          total: { $sum: 1 },
          admitted: { $sum: { $cond: [{ $eq: ['$stage', 'admitted'] }, 1, 0] } },
        },
      },
      { $sort: { total: -1 } },
    ]),
    Inquiry.aggregate([
      { $match: { ...match, stage: { $nin: ['admitted', 'lost'] }, nextFollowUpAt: { $ne: null } } },
      {
        $group: {
          _id: null,
          overdue: { $sum: { $cond: [{ $lt: ['$nextFollowUpAt', today] }, 1, 0] } },
          dueToday: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$nextFollowUpAt', today] }, { $lt: ['$nextFollowUpAt', addDays(today, 1)] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);
  const stages = Object.fromEntries(INQUIRY_STAGES.map((s) => [s, 0])) as Record<string, number>;
  byStage.forEach((r) => (stages[r._id] = r.count));
  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  const closed = stages.admitted + stages.lost;
  return {
    total,
    stages,
    open: total - closed,
    conversionRate: closed ? Math.round((stages.admitted / closed) * 1000) / 10 : 0,
    bySource: bySource.map((r) => ({
      source: r._id,
      total: r.total,
      admitted: r.admitted,
      conversionRate: r.total ? Math.round((r.admitted / r.total) * 1000) / 10 : 0,
    })),
    followUps: { overdue: due[0]?.overdue ?? 0, dueToday: due[0]?.dueToday ?? 0 },
  };
}
