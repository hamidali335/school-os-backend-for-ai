import type { Model } from 'mongoose';
import { logger } from '../../config/logger';
import { unavailable } from '../../utils/errors';
import { BiometricDevice, DeviceUserLink, PunchEvent, StaffAttendance } from './biometric.models';

/**
 * Staff attendance relies on unique indexes to stay correct under retries and concurrent
 * requests: without them the same punch can be stored many times (a retried connector request,
 * a connector and an import at once), a staff member can get two records for one day, and a
 * device user two links. Production does not build indexes on its own (autoIndex is off): they
 * are created by `npm run db:indexes -- --apply`.
 *
 * This check only READS the index list. It never creates or drops an index. While an index is
 * missing, staff attendance refuses to write (503) instead of writing data it cannot keep
 * consistent; reads keep working. The check is repeated while the API runs (see INDEX_RECHECK_MS),
 * so an index dropped after startup is noticed, and applying the indexes takes effect without a
 * restart.
 */
export const REQUIRED_BIOMETRIC_INDEXES: Array<{ model: Model<any>; key: Record<string, 1>; purpose: string }> = [
  { model: PunchEvent, key: { schoolId: 1, dedupeKey: 1 }, purpose: 'each punch is stored once' },
  {
    model: StaffAttendance,
    key: { schoolId: 1, employeeId: 1, date: 1 },
    purpose: 'one attendance record per staff member and day',
  },
  {
    model: DeviceUserLink,
    key: { schoolId: 1, deviceId: 1, deviceUserId: 1 },
    purpose: 'a device user ID is linked once per device',
  },
  { model: BiometricDevice, key: { schoolId: 1, name: 1 }, purpose: 'device names are unique in a school' },
];

const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

/** The required unique indexes that do not exist (collection and key), from a read-only listing. */
export async function missingBiometricIndexes(): Promise<string[]> {
  const missing: string[] = [];
  for (const r of REQUIRED_BIOMETRIC_INDEXES) {
    const existing = (await r.model.collection
      .indexes()
      .catch((err: { codeName?: string }) =>
        err.codeName === 'NamespaceNotFound' ? [] : Promise.reject(err),
      )) as Array<{ key: Record<string, unknown>; unique?: boolean }>;
    if (!existing.some((i) => i.unique && sameKey(i.key, r.key)))
      missing.push(`${r.model.collection.collectionName} ${JSON.stringify(r.key)} unique (${r.purpose})`);
  }
  return missing;
}

/**
 * A passed check is trusted for this long, then repeated on the next write: an index dropped
 * while the API runs is noticed within this time (a write path such as an import saves many rows,
 * so checking before every single write would multiply its database calls). A failed check is
 * repeated on every write, so applying the indexes takes effect at once.
 */
export const INDEX_RECHECK_MS = 10_000;
const LOG_EVERY_MS = 60_000;
let state: { ok: boolean; checkedAt: number } | null = null;
let loggedAt = 0;

/** Refuse a staff attendance write while a required unique index is missing. */
export async function assertBiometricIndexes() {
  if (state?.ok && Date.now() - state.checkedAt < INDEX_RECHECK_MS) return;
  const missing = await missingBiometricIndexes();
  state = { ok: !missing.length, checkedAt: Date.now() };
  if (missing.length && Date.now() - loggedAt > LOG_EVERY_MS) {
    loggedAt = Date.now();
    logger.error(
      { missing },
      'Staff attendance writes are refused: required unique indexes are missing. Run `npm run db:indexes -- --apply`.',
    );
  }
  if (!state.ok)
    throw unavailable(
      'Staff attendance cannot save changes yet: its database setup is incomplete. Please contact support.',
      'BIOMETRIC_NOT_READY',
    );
}

/** Startup: say clearly (in the log) if the indexes are missing. Read-only; never throws. */
export async function logBiometricIndexStatus() {
  try {
    const missing = await missingBiometricIndexes();
    state = { ok: !missing.length, checkedAt: Date.now() };
    if (missing.length)
      logger.warn(
        { missing },
        'Staff attendance: required unique indexes are missing, so its writes are refused until `npm run db:indexes -- --apply` is run',
      );
  } catch (err) {
    logger.warn({ err }, 'Could not check the staff attendance indexes');
  }
}

/** Test hook: forget the last result. */
export const _resetBiometricIndexCheck = () => {
  state = null;
  loggedAt = 0;
};
