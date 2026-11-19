/**
 * Timetable conflict rules. Two periods conflict when they are on the same day, their
 * time ranges overlap (touching end/start is allowed), and they share a section, a
 * teacher, or a room on the same campus.
 */
export interface Slot {
  id?: string;
  sectionId: string;
  teacherId?: string | null;
  campusId: string;
  room?: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

export type ConflictType = 'section' | 'teacher' | 'room';

export interface Conflict {
  type: ConflictType;
  withEntryId?: string;
  dayOfWeek: number;
  message: string;
}

export const overlaps = (a: Pick<Slot, 'startMinutes' | 'endMinutes'>, b: Pick<Slot, 'startMinutes' | 'endMinutes'>) =>
  a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;

const normRoom = (r?: string | null) => (r ? r.trim().toLowerCase() : '');

export function conflictsBetween(candidate: Slot, existing: Slot): Conflict[] {
  if (candidate.id && existing.id && candidate.id === existing.id) return [];
  if (candidate.dayOfWeek !== existing.dayOfWeek || !overlaps(candidate, existing)) return [];
  const out: Conflict[] = [];
  const base = { withEntryId: existing.id, dayOfWeek: candidate.dayOfWeek };
  if (candidate.sectionId === existing.sectionId)
    out.push({ ...base, type: 'section', message: 'Section already has a period at this time' });
  if (candidate.teacherId && candidate.teacherId === existing.teacherId) {
    out.push({ ...base, type: 'teacher', message: 'Teacher is already teaching another period at this time' });
  }
  if (
    normRoom(candidate.room) &&
    candidate.campusId === existing.campusId &&
    normRoom(candidate.room) === normRoom(existing.room)
  ) {
    out.push({ ...base, type: 'room', message: 'Room is already booked at this time' });
  }
  return out;
}

export function findConflicts(candidate: Slot, others: Slot[]): Conflict[] {
  return others.flatMap((o) => conflictsBetween(candidate, o));
}

/** Every pairwise conflict inside a set of slots (used to scan an existing timetable). */
export function scanConflicts(slots: Slot[]): Array<Conflict & { entryId?: string }> {
  const out: Array<Conflict & { entryId?: string }> = [];
  const byDay = new Map<number, Slot[]>();
  for (const s of slots) byDay.set(s.dayOfWeek, [...(byDay.get(s.dayOfWeek) ?? []), s]);
  for (const daySlots of byDay.values()) {
    const sorted = [...daySlots].sort((a, b) => a.startMinutes - b.startMinutes);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].startMinutes < sorted[i].endMinutes; j++) {
        for (const c of conflictsBetween(sorted[i], sorted[j])) out.push({ ...c, entryId: sorted[i].id });
      }
    }
  }
  return out;
}
