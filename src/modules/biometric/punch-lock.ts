import { model, Schema } from 'mongoose';
import { ObjectId, withTenant } from '../../database/schema-helpers';
import type { SchoolContext } from '../../types/context';
import { conflict } from '../../utils/errors';
import { oid } from '../../utils/tenant';

/**
 * One staff punch import run, or one undo of such an import, at a time per school. They both read
 * the school's punches and then change them (an import skips punches it finds "already
 * imported"; an undo removes punches no other import holds), so running them at once can lose a
 * punch that both touch.
 *
 * One lock document per school, `_id` "staff_punches:<schoolId>": taking it is a single atomic
 * upsert that only matches a free or expired lock, and the always-unique `_id` turns a second
 * taker's upsert into a duplicate-key error (no other index needed). The holder renews it with
 * its heartbeat; a lock not renewed for PUNCH_LOCK_STALE_MS belongs to a stopped process and can
 * be taken over.
 */
export const PUNCH_LOCK_STALE_MS = 120_000;

const PunchLockSchema = withTenant(
  new Schema(
    {
      _id: { type: String, required: true },
      schoolId: { type: ObjectId, ref: 'School', required: true, immutable: true },
      holder: { type: String, default: null },
      kind: { type: String, enum: ['import', 'undo'] },
      /** The import being undone (undo only), to tell a repeated request apart from another undo. */
      ref: { type: String },
      heartbeatAt: { type: Date },
    },
    { versionKey: false },
  ),
);
export const PunchLock = model('BiometricPunchLock', PunchLockSchema);

type Ctx = Pick<SchoolContext, 'schoolId'>;
const lockId = (ctx: Ctx) => `staff_punches:${ctx.schoolId}`;

/** Take (or keep) the school's lock for `holder`; false when another live holder has it. */
export async function acquirePunchLock(ctx: Ctx, holder: string, kind: 'import' | 'undo', ref?: string) {
  try {
    const lock = await PunchLock.findOneAndUpdate(
      {
        _id: lockId(ctx),
        schoolId: oid(ctx.schoolId),
        $or: [{ holder: null }, { holder }, { heartbeatAt: { $lt: new Date(Date.now() - PUNCH_LOCK_STALE_MS) } }],
      },
      { $set: { holder, kind, heartbeatAt: new Date(), ...(ref ? { ref } : {}) } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    return lock?.holder === holder;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false; // held by someone else
    throw err;
  }
}

/** What holds the school's lock right now (a live holder only), or null. */
export async function punchLockHolder(ctx: Ctx): Promise<'import' | 'undo' | null> {
  const lock = await PunchLock.findOne({
    _id: lockId(ctx),
    schoolId: oid(ctx.schoolId),
    holder: { $ne: null },
    heartbeatAt: { $gte: new Date(Date.now() - PUNCH_LOCK_STALE_MS) },
  }).lean();
  return (lock?.kind as 'import' | 'undo' | undefined) ?? null;
}

/**
 * Take the lock or refuse with 409: UNDO_IN_PROGRESS when it is the same import's undo (a
 * repeated request), PUNCH_IMPORT_BUSY otherwise.
 */
export async function requirePunchLock(ctx: Ctx, holder: string, kind: 'import' | 'undo', ref?: string) {
  if (await acquirePunchLock(ctx, holder, kind, ref)) return;
  const other = await PunchLock.findOne({ _id: lockId(ctx), schoolId: oid(ctx.schoolId) }).lean();
  if (kind === 'undo' && other?.kind === 'undo' && ref && other.ref === ref)
    throw conflict('This import is being undone right now', undefined, 'UNDO_IN_PROGRESS');
  throw conflict(
    other?.kind === 'undo'
      ? 'A staff attendance import is being undone right now. Try again when it has finished.'
      : 'A staff attendance import is running right now. Try again when it has finished.',
    undefined,
    'PUNCH_IMPORT_BUSY',
  );
}

/** Renew the holder's lock; false when it was lost (expired and taken over). */
export async function renewPunchLock(ctx: Ctx, holder: string) {
  const res = await PunchLock.updateOne(
    { _id: lockId(ctx), schoolId: oid(ctx.schoolId), holder },
    { $set: { heartbeatAt: new Date() } },
  );
  return res.matchedCount === 1;
}

/** Release the lock if `holder` still has it. */
export async function releasePunchLock(ctx: Ctx, holder: string) {
  await PunchLock.updateOne(
    { _id: lockId(ctx), schoolId: oid(ctx.schoolId), holder },
    { $set: { holder: null, heartbeatAt: null }, $unset: { ref: 1 } },
  );
}
