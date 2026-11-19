import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { parseDateOnly, todayInTz } from '../../utils/dates';
import { forbidden, notFound } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { Section, SubstituteAssignment, TeachingAssignment, type SubstituteCapability } from './academics.models';

/**
 * Roles with school-wide academic reach. Their actions are still gated by permissions on every
 * route; this only decides that they are not limited to particular sections. Teachers are
 * never in this set: they reach only what they are assigned to (or are covering).
 */
const SCHOOL_WIDE_ROLES = new Set(['school_owner', 'principal', 'school_admin', 'staff']);

export const isSchoolWide = (ctx: SchoolContext) => SCHOOL_WIDE_ROLES.has(ctx.role);

/** `view` = see the class and its students; the others are the actions a cover can include. */
export type TeachingCapability = 'view' | SubstituteCapability;

interface Grant {
  sectionId: string;
  /** null: section-level grant (class teacher, or a cover of everything the original teaches) */
  subjectId: string | null;
  capabilities: ReadonlySet<TeachingCapability>;
  source: 'class_teacher' | 'assignment' | 'substitute';
  substituteAssignmentId?: string;
}

export interface TeacherScope {
  grants: Grant[];
}

const ALL_CAPS: ReadonlySet<TeachingCapability> = new Set(['view', 'attendance', 'homework', 'marks']);
// A subject teacher who is not the class teacher may mark attendance for the section (they teach
// it) — this preserves the long-standing behaviour of the attendance module.
const cache = new WeakMap<SchoolContext, Promise<TeacherScope>>();

async function schoolToday(schoolId: string): Promise<Date> {
  const s = await School.findById(schoolId).select('settings.timezone').lean();
  return parseDateOnly(todayInTz(s?.settings?.timezone ?? 'Asia/Karachi'));
}

async function computeScope(ctx: SchoolContext): Promise<TeacherScope> {
  if (ctx.role !== 'teacher' || !ctx.employeeId) return { grants: [] };
  const me = oid(ctx.employeeId);
  const today = await schoolToday(ctx.schoolId);
  const [classTeacherOf, assignments, covers] = await Promise.all([
    Section.find(scope(ctx, { classTeacherId: me }))
      .select('_id')
      .lean(),
    TeachingAssignment.find(scope(ctx, { teacherId: me }))
      .select('sectionId subjectId')
      .lean(),
    SubstituteAssignment.find(
      scope(ctx, {
        substituteTeacherId: me,
        status: 'active',
        startDate: { $lte: today },
        endDate: { $gte: today },
      }),
    ).lean(),
  ]);
  const grants: Grant[] = [
    ...classTeacherOf.map((s) => ({
      sectionId: s._id.toString(),
      subjectId: null,
      capabilities: ALL_CAPS,
      source: 'class_teacher' as const,
    })),
    ...assignments.map((a) => ({
      sectionId: a.sectionId.toString(),
      subjectId: a.subjectId.toString(),
      capabilities: ALL_CAPS,
      source: 'assignment' as const,
    })),
  ];
  for (const c of covers) {
    const caps = new Set<TeachingCapability>(['view', ...(c.capabilities as SubstituteCapability[])]);
    const base = { capabilities: caps, source: 'substitute' as const, substituteAssignmentId: c._id.toString() };
    if (c.subjectId) {
      grants.push({ ...base, sectionId: c.sectionId.toString(), subjectId: c.subjectId.toString() });
      continue;
    }
    // Whole-section cover: exactly what the original teacher holds in that section, no more.
    const [origClassTeacher, origAssignments] = await Promise.all([
      Section.exists(scope(ctx, { _id: c.sectionId, classTeacherId: c.originalTeacherId })),
      TeachingAssignment.find(scope(ctx, { sectionId: c.sectionId, teacherId: c.originalTeacherId }))
        .select('subjectId')
        .lean(),
    ]);
    if (origClassTeacher) grants.push({ ...base, sectionId: c.sectionId.toString(), subjectId: null });
    for (const a of origAssignments)
      grants.push({ ...base, sectionId: c.sectionId.toString(), subjectId: a.subjectId.toString() });
  }
  return { grants };
}

/** Teacher's effective grants for the current request (memoised per request context). */
export function teacherScope(ctx: SchoolContext): Promise<TeacherScope> {
  let p = cache.get(ctx);
  if (!p) {
    p = computeScope(ctx);
    cache.set(ctx, p);
  }
  return p;
}

/**
 * What a teacher may do in each of their sections (union of all grants there): `view`, and the
 * actions a cover can include (`attendance`, `homework`, `marks`). The same grants that the
 * save endpoints check, so the app can show only what will be accepted.
 */
export async function teacherSectionCapabilities(ctx: SchoolContext): Promise<Map<string, TeachingCapability[]>> {
  const { grants } = await teacherScope(ctx);
  const out = new Map<string, Set<TeachingCapability>>();
  for (const g of grants) {
    const set = out.get(g.sectionId) ?? new Set<TeachingCapability>();
    for (const c of g.capabilities) set.add(c);
    out.set(g.sectionId, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Section ids a teacher may work with for a capability: as class teacher, as subject teacher,
 * or as a currently active substitute holding that capability.
 */
export async function teacherSectionIds(
  ctx: SchoolContext,
  capability: TeachingCapability = 'view',
): Promise<string[]> {
  const { grants } = await teacherScope(ctx);
  return [...new Set(grants.filter((g) => g.capabilities.has(capability)).map((g) => g.sectionId))];
}

/**
 * Homework/marks visibility for teachers as a Mongo filter fragment: whole sections where they
 * hold a section-level grant, otherwise only their (section, subject) pairs.
 */
export async function teacherSubjectFilter(
  ctx: SchoolContext,
  capability: TeachingCapability = 'view',
): Promise<Array<Record<string, unknown>>> {
  const { grants } = await teacherScope(ctx);
  const usable = grants.filter((g) => g.capabilities.has(capability));
  const wholeSections = [...new Set(usable.filter((g) => !g.subjectId).map((g) => g.sectionId))];
  const pairs = usable.filter((g) => g.subjectId && !wholeSections.includes(g.sectionId));
  const or: Array<Record<string, unknown>> = [];
  if (wholeSections.length) or.push({ sectionId: { $in: wholeSections.map(oid) } });
  for (const p of pairs) or.push({ sectionId: oid(p.sectionId), subjectId: oid(p.subjectId!) });
  return or;
}

/** The grant (if any) that lets this teacher act; used to attribute actions done as a cover. */
async function findGrant(
  ctx: SchoolContext,
  sectionId: string,
  subjectId: string | null,
  capability: TeachingCapability,
): Promise<Grant | undefined> {
  const { grants } = await teacherScope(ctx);
  return grants.find(
    (g) =>
      g.sectionId === sectionId &&
      g.capabilities.has(capability) &&
      (g.subjectId === null || subjectId === null || g.subjectId === subjectId),
  );
}

/**
 * May this user act on a section (mark attendance, view its roster...)? School-wide roles always
 * may (their permission is checked by the route); teachers only for their own or covered
 * sections. Returns the substitute assignment id when access comes from a cover.
 */
export async function assertSectionAccess(
  ctx: SchoolContext,
  sectionId: string | Types.ObjectId,
  capability: TeachingCapability = 'view',
): Promise<{ viaSubstitute?: string }> {
  if (isSchoolWide(ctx)) return {};
  if (ctx.role === 'teacher') {
    const { grants } = await teacherScope(ctx);
    const g = grants.find((x) => x.sectionId === sectionId.toString() && x.capabilities.has(capability));
    if (g) return { viaSubstitute: g.substituteAssignmentId };
  }
  throw forbidden('You are not assigned to this section');
}

/** May this user act on a subject within a section (enter marks, set or grade homework)? */
export async function assertSubjectAccess(
  ctx: SchoolContext,
  sectionId: string | Types.ObjectId,
  subjectId: string | Types.ObjectId,
  capability: TeachingCapability = 'homework',
): Promise<{ viaSubstitute?: string }> {
  if (isSchoolWide(ctx)) return {};
  if (ctx.role === 'teacher') {
    const g = await findGrant(ctx, sectionId.toString(), subjectId.toString(), capability);
    if (g) return { viaSubstitute: g.substituteAssignmentId };
  }
  throw forbidden('You do not teach this subject in this section');
}

/**
 * For parents: the ids of their children (every student listing them as a guardian). Returns
 * null for staff, meaning "not restricted by ownership" (teachers are limited separately by section).
 */
export async function visibleStudentIds(ctx: SchoolContext): Promise<string[] | null> {
  if (ctx.role === 'parent') {
    if (!ctx.parentId) return [];
    const kids = await Student.find(scope(ctx, { 'guardians.parentId': oid(ctx.parentId) }))
      .select('_id')
      .lean();
    return kids.map((k) => k._id.toString());
  }
  return null;
}

/**
 * Mongo filter fragment restricting student queries to what the caller may see: parents and
 * students their own family, teachers the students of their (covered) sections.
 */
export async function studentVisibilityFilter(ctx: SchoolContext): Promise<Record<string, unknown> | null> {
  const family = await visibleStudentIds(ctx);
  if (family) return { _id: { $in: family.map(oid) } };
  if (ctx.role === 'teacher') return { sectionId: { $in: (await teacherSectionIds(ctx)).map(oid) } };
  return null;
}

/**
 * Throws 404 (not 403) when a parent asks for a student who is not theirs, or a
 * teacher asks for a student outside their sections — never revealing that the record exists.
 */
export async function assertStudentVisible(ctx: SchoolContext, studentId: string): Promise<void> {
  const visible = await visibleStudentIds(ctx);
  if (visible && !visible.includes(studentId)) throw notFound('Student');
  if (ctx.role === 'teacher') {
    const st = await Student.findOne(scope(ctx, { _id: oid(studentId) }))
      .select('sectionId')
      .lean();
    if (!st || !(await teacherSectionIds(ctx)).includes(st.sectionId.toString())) throw notFound('Student');
  }
}
