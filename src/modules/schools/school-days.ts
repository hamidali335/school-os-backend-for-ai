import { unprocessable } from '../../utils/errors';
import { parseDateOnly } from '../../utils/dates';
import { School } from './school.model';

/** ISO weekdays (1 = Monday … 7 = Sunday) a school is open when it has not chosen: Monday to Saturday. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6];
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export const isoWeekdayOf = (date: string) => ((parseDateOnly(date).getUTCDay() + 6) % 7) + 1;

/** The school's working days (Settings → School days). */
export async function workingDays(schoolId: string): Promise<number[]> {
  const school = await School.findById(schoolId).select('settings.workingDays').lean();
  const days = (school?.settings as { workingDays?: number[] } | undefined)?.workingDays;
  return days?.length ? [...days].sort((a, b) => a - b) : DEFAULT_WORKING_DAYS;
}

export const isSchoolDay = (days: number[], date: string) => days.includes(isoWeekdayOf(date));

/** Refuses something that only happens on school days (attendance) on an off day. */
export async function assertSchoolDay(schoolId: string, date: string, what: string) {
  const days = await workingDays(schoolId);
  if (!isSchoolDay(days, date))
    throw unprocessable(
      `${date} is a ${WEEKDAY_NAMES[isoWeekdayOf(date) - 1]}, which is an off day: ${what} is only for school days. Change the school days in Settings → School days if this is wrong.`,
      { date, workingDays: days },
      'SCHOOL_CLOSED',
    );
}
