import type { AttendanceStatus } from './attendance.model';

export interface AttendanceCounts {
  present: number;
  absent: number;
  late: number;
  leave: number;
  excused: number;
  total: number;
  /** Attendance % = (present + late) / (present + late + absent). Leave/excused are excluded. */
  rate: number | null;
}

export function emptyCounts(): AttendanceCounts {
  return { present: 0, absent: 0, late: 0, leave: 0, excused: 0, total: 0, rate: null };
}

export function withRate(c: Omit<AttendanceCounts, 'rate' | 'total'> & { total?: number }): AttendanceCounts {
  const counted = c.present + c.late + c.absent;
  return {
    present: c.present,
    absent: c.absent,
    late: c.late,
    leave: c.leave,
    excused: c.excused,
    total: c.present + c.absent + c.late + c.leave + c.excused,
    rate: counted ? Math.round(((c.present + c.late) / counted) * 1000) / 10 : null,
  };
}

export function countStatuses(statuses: AttendanceStatus[]): AttendanceCounts {
  const c = emptyCounts();
  for (const s of statuses) c[s]++;
  return withRate(c);
}

/** Longest run of consecutive 'absent' days at the end of a chronologically sorted list. */
export function trailingAbsenceStreak(records: Array<{ status: AttendanceStatus }>): number {
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const s = records[i].status;
    if (s === 'absent') streak++;
    else if (s === 'leave' || s === 'excused') continue;
    else break;
  }
  return streak;
}
