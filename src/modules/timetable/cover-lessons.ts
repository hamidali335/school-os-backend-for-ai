import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly } from '../../utils/dates';
import { oid, scope } from '../../utils/tenant';
import { SubstituteAssignment } from '../academics/academics.models';
import { overlaps } from './conflicts';
import { TimetableEntry } from './timetable.model';

/**
 * Substitute lessons are computed, never stored: for each date a cover is active, the absent
 * teacher's regular lessons for that section (and subject) on that weekday are the cover's
 * lessons. The regular timetable is never copied or changed, so a cover disappears from
 * every view as soon as it ends, is edited or is cancelled, and nothing is left to clean up.
 * "Working days" are the days the timetable has lessons (there is no holiday calendar).
 */
export interface CoverLesson {
  date: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
  sectionId: string;
  subjectId: string;
  room?: string | null;
  entryId: string;
  coverId: string;
  originalTeacherId: string;
  substituteTeacherId: string;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a UTC-midnight calendar date. */
export const isoWeekday = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = parseDateOnly(from); formatDateOnly(d) <= to; d = addDays(d, 1)) out.push(formatDateOnly(d));
  return out;
}

type CoverLike = {
  _id: Types.ObjectId | string;
  sectionId: Types.ObjectId | string;
  subjectId?: Types.ObjectId | string | null;
  originalTeacherId: Types.ObjectId | string;
  substituteTeacherId: Types.ObjectId | string;
  startDate: Date;
  endDate: Date;
};

/** The dated lessons a set of covers stand for, between `from` and `to` (inclusive). */
export async function lessonsForCovers(
  ctx: Pick<SchoolContext, 'schoolId'>,
  covers: CoverLike[],
  from: string,
  to: string,
) {
  if (!covers.length) return [] as CoverLesson[];
  const entries = await TimetableEntry.find(
    scope(ctx, {
      $or: covers.map((c) => ({
        sectionId: oid(String(c.sectionId)),
        teacherId: oid(String(c.originalTeacherId)),
        ...(c.subjectId ? { subjectId: oid(String(c.subjectId)) } : {}),
      })),
    }),
  ).lean();
  const out: CoverLesson[] = [];
  for (const c of covers) {
    const start = formatDateOnly(c.startDate) > from ? formatDateOnly(c.startDate) : from;
    const end = formatDateOnly(c.endDate) < to ? formatDateOnly(c.endDate) : to;
    if (start > end) continue;
    const own = entries.filter(
      (e) =>
        String(e.sectionId) === String(c.sectionId) &&
        String(e.teacherId) === String(c.originalTeacherId) &&
        (!c.subjectId || String(e.subjectId) === String(c.subjectId)),
    );
    for (const date of datesBetween(start, end)) {
      const dow = isoWeekday(parseDateOnly(date));
      for (const e of own.filter((x) => x.dayOfWeek === dow))
        out.push({
          date,
          dayOfWeek: dow,
          startTime: e.startTime,
          endTime: e.endTime,
          startMinutes: e.startMinutes,
          endMinutes: e.endMinutes,
          sectionId: String(e.sectionId),
          subjectId: String(e.subjectId),
          room: e.room,
          entryId: String(e._id),
          coverId: String(c._id),
          originalTeacherId: String(c.originalTeacherId),
          substituteTeacherId: String(c.substituteTeacherId),
        });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.startMinutes - b.startMinutes);
}

/** Active covers overlapping a date range, optionally for one teacher (either side) or section. */
export async function activeCovers(
  ctx: Pick<SchoolContext, 'schoolId'>,
  from: string,
  to: string,
  filter: { teacherId?: string; sectionId?: string; excludeId?: string } = {},
) {
  return SubstituteAssignment.find(
    scope(ctx, {
      status: 'active',
      startDate: { $lte: parseDateOnly(to) },
      endDate: { $gte: parseDateOnly(from) },
      ...(filter.excludeId ? { _id: { $ne: oid(filter.excludeId) } } : {}),
      ...(filter.sectionId ? { sectionId: oid(filter.sectionId) } : {}),
      ...(filter.teacherId
        ? { $or: [{ originalTeacherId: oid(filter.teacherId) }, { substituteTeacherId: oid(filter.teacherId) }] }
        : {}),
    }),
  ).lean();
}

export interface CoverClash {
  date: string;
  startTime: string;
  endTime: string;
  sectionId: string;
  subjectId: string;
  /** What the substitute is already doing at that time. */
  clashWith: {
    kind: 'own_lesson' | 'other_cover';
    sectionId: string;
    subjectId: string;
    startTime: string;
    endTime: string;
    coverId?: string;
  };
}

/**
 * Lessons of a proposed cover that collide with the substitute's own timetable or with
 * another cover they already hold on the same date and time.
 */
export async function coverClashes(
  ctx: Pick<SchoolContext, 'schoolId'>,
  proposed: CoverLike & { _id?: Types.ObjectId | string },
  from: string,
  to: string,
): Promise<{ lessons: CoverLesson[]; clashes: CoverClash[] }> {
  const lessons = await lessonsForCovers(ctx, [{ ...proposed, _id: proposed._id ?? 'proposed' }], from, to);
  if (!lessons.length) return { lessons, clashes: [] };
  const subId = String(proposed.substituteTeacherId);
  const [ownEntries, otherCovers] = await Promise.all([
    TimetableEntry.find(
      scope(ctx, { teacherId: oid(subId), dayOfWeek: { $in: [...new Set(lessons.map((l) => l.dayOfWeek))] } }),
    ).lean(),
    SubstituteAssignment.find(
      scope(ctx, {
        status: 'active',
        substituteTeacherId: oid(subId),
        startDate: { $lte: parseDateOnly(to) },
        endDate: { $gte: parseDateOnly(from) },
        ...(proposed._id ? { _id: { $ne: oid(String(proposed._id)) } } : {}),
      }),
    ).lean(),
  ]);
  const otherLessons = await lessonsForCovers(ctx, otherCovers, from, to);
  const clashes: CoverClash[] = [];
  for (const l of lessons) {
    for (const e of ownEntries)
      if (e.dayOfWeek === l.dayOfWeek && overlaps(e, l))
        clashes.push({
          date: l.date,
          startTime: l.startTime,
          endTime: l.endTime,
          sectionId: l.sectionId,
          subjectId: l.subjectId,
          clashWith: {
            kind: 'own_lesson',
            sectionId: String(e.sectionId),
            subjectId: String(e.subjectId),
            startTime: e.startTime,
            endTime: e.endTime,
          },
        });
    for (const o of otherLessons)
      if (o.date === l.date && overlaps(o, l))
        clashes.push({
          date: l.date,
          startTime: l.startTime,
          endTime: l.endTime,
          sectionId: l.sectionId,
          subjectId: l.subjectId,
          clashWith: {
            kind: 'other_cover',
            sectionId: o.sectionId,
            subjectId: o.subjectId,
            startTime: o.startTime,
            endTime: o.endTime,
            coverId: o.coverId,
          },
        });
  }
  return { lessons, clashes };
}
