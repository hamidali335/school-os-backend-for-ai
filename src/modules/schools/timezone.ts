import { DEFAULT_TIMEZONE } from '../../utils/dates';
import { School } from './school.model';

/** The school's configured IANA timezone (`settings.timezone`), defaulting to Asia/Karachi. */
export async function schoolTimezone(schoolId: string): Promise<string> {
  const s = await School.findById(schoolId).select('settings.timezone').lean();
  return s?.settings?.timezone || DEFAULT_TIMEZONE;
}
