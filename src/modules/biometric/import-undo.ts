import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { formatDateOnly, parseDateOnly } from '../../utils/dates';
import { AppError, badRequest, conflict } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { audit, auditOrThrow } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { ImportJob, UNDO_STALE_MS } from '../imports/import.models';
import { importJobForAction, jobView } from '../imports/imports.service';
import { assertStaffInCampus, campusLimited } from './access';
import { BiometricDevice, PunchEvent, StaffAttendance } from './biometric.models';
import { assertBiometricIndexes } from './index-check';
import { punchLockHolder, releasePunchLock, renewPunchLock, requirePunchLock } from './punch-lock';
import { AuditLog } from '../audit/audit.model';
import { recomputeStaffDays } from './staff-attendance.service';

/**
 * Undo a staff attendance punch import: for an import made from the wrong device, with the wrong
 * day/month order, or of the wrong file.
 *
 * - Only the punches this import stored (`importJobId`), of this school. A punch that another
 *   import's file also held (it was "already imported" there) is handed to that import instead of
 *   removed; one the connector also sent is kept as the connector's. Nothing else is touched.
 * - The affected staff days are worked out again from the punches that remain, by the same rules
 *   as always: a day marked by hand keeps its mark (only its punch details change; a "marked
 *   absent but punched" flag goes when its punches go); "keep the mark" decisions stay; a day made
 *   only from these punches becomes "not recorded".
 * - One undo at a time per import, claimed atomically with a heartbeat (as an import run). The
 *   affected days are saved on the import before any punch is touched, so a failed or interrupted
 *   undo is finished by running it again; nothing is removed twice. It is reported done only
 *   after the punches, the days and the audit record are all done.
 * - An undone import cannot be run or resumed again (imports.service refuses it).
 */

const UNDOABLE = ['completed', 'cancelled', 'interrupted'];
const NOT_FINISHED =
  'Undoing this import did not finish. Some punches may already be removed; undo it again to finish (nothing is removed twice).';
const BATCH = 1000;
const HEARTBEAT_MS = 10_000;
const MAX_ROUNDS = 50;

type Ctx = SchoolContext;
type JobDoc = Awaited<ReturnType<typeof importJobForAction>>;
type Punch = {
  _id: Types.ObjectId;
  employeeId?: Types.ObjectId | null;
  localDate: string;
  alsoImportJobIds?: Types.ObjectId[] | null;
  alsoFromConnector?: boolean | null;
};

async function punchImport(ctx: Ctx, id: string) {
  const job = await importJobForAction(ctx, id);
  if (job.type !== 'staff_punches')
    throw badRequest('Only staff attendance punch imports can be undone', undefined, 'IMPORT_NOT_UNDOABLE');
  return job;
}

/** Why this import cannot be undone now, or null. */
function stateProblem(job: JobDoc): AppError | null {
  if (job.undo?.status === 'completed')
    return conflict('This import was already undone', undefined, 'IMPORT_ALREADY_UNDONE');
  if (!UNDOABLE.includes(job.status))
    return conflict(
      job.status === 'running'
        ? 'This import is still running. Stop it first, then undo it.'
        : 'Nothing from this import has been saved yet: cancel it instead.',
      undefined,
      'IMPORT_STATE',
    );
  return null;
}

/** Imports being or already undone: never handed a punch. */
async function undoneImports(ctx: Ctx) {
  const ids = await ImportJob.find(scope(ctx, { type: 'staff_punches', undo: { $exists: true } })).distinct('_id');
  return new Set(ids.map(String));
}

/** What undoing does to one punch of the import. */
function fate(p: Punch, jobId: Types.ObjectId, undone: Set<string>) {
  const other = (p.alsoImportJobIds ?? []).map(String).find((id) => id !== String(jobId) && !undone.has(id));
  if (other) return { kind: 'handover' as const, to: other };
  if (p.alsoFromConnector) return { kind: 'connector' as const };
  return { kind: 'remove' as const };
}

const dayKey = (employeeId: unknown, localDate: string) => `${String(employeeId)}|${localDate}`;

/**
 * What undoing would do, for the administrator to confirm: punches removed or kept, the staff and
 * days affected, hand-made marks kept, and why it cannot be done if it cannot. Changes nothing.
 */
export async function undoImportPreview(ctx: Ctx, id: string) {
  const job = await punchImport(ctx, id);
  const punches = (await PunchEvent.find(scope(ctx, { importJobId: job._id }))
    .select('employeeId localDate alsoImportJobIds alsoFromConnector')
    .lean()) as Punch[];
  const undone = await undoneImports(ctx);
  const removed: Punch[] = [];
  let keptForOtherImports = 0;
  let keptForConnector = 0;
  for (const p of punches) {
    const f = fate(p, job._id, undone);
    if (f.kind === 'remove') removed.push(p);
    else if (f.kind === 'handover') keptForOtherImports++;
    else keptForConnector++;
  }
  const removedPerDay = new Map<string, number>();
  for (const p of removed)
    if (p.employeeId)
      removedPerDay.set(
        dayKey(p.employeeId, p.localDate),
        (removedPerDay.get(dayKey(p.employeeId, p.localDate)) ?? 0) + 1,
      );
  const employeeIds = [...new Set(removed.flatMap((p) => (p.employeeId ? [String(p.employeeId)] : [])))].map(oid);
  const dates = [...new Set(removed.map((p) => p.localDate))];
  const [totals, records, staff] = await Promise.all([
    PunchEvent.aggregate<{ _id: { e: Types.ObjectId; d: string }; n: number }>([
      { $match: { schoolId: oid(ctx.schoolId), employeeId: { $in: employeeIds }, localDate: { $in: dates } } },
      { $group: { _id: { e: '$employeeId', d: '$localDate' }, n: { $sum: 1 } } },
    ]),
    StaffAttendance.find(scope(ctx, { employeeId: { $in: employeeIds }, date: { $in: dates.map(parseDateOnly) } }))
      .select('employeeId date status source markedBy conflict')
      .lean(),
    Employee.find(scope(ctx, { _id: { $in: employeeIds } }))
      .select('firstName lastName employeeNo')
      .sort({ firstName: 1, lastName: 1 })
      .limit(20)
      .lean(),
  ]);
  const totalPerDay = new Map(totals.map((t) => [dayKey(t._id.e, t._id.d), t.n]));
  const recordPerDay = new Map(records.map((r) => [dayKey(r.employeeId, formatDateOnly(r.date)), r]));
  const days = {
    affected: removedPerDay.size,
    updated: 0,
    becomeNotRecorded: 0,
    markedKept: 0,
    flagsCleared: 0,
    resolvedByPersonLosePunches: 0,
  };
  for (const [key, n] of removedPerDay) {
    const left = (totalPerDay.get(key) ?? n) - n;
    const r = recordPerDay.get(key);
    if (!r) continue;
    if (r.source === 'manual') {
      days.markedKept++;
      if (r.conflict?.code && !left) days.flagsCleared++;
    } else if (left) days.updated++;
    else {
      days.becomeNotRecorded++;
      // "Use the punches" was chosen for this day; without punches it is no longer recorded.
      if (r.markedBy) days.resolvedByPersonLosePunches++;
    }
  }
  let blockedReason = stateProblem(job)?.message ?? null;
  const busy = blockedReason ? null : await punchLockHolder(ctx);
  if (busy)
    blockedReason =
      busy === 'import'
        ? 'A staff attendance import is running right now. Undo this import when it has finished.'
        : 'An import is being undone right now. Try again when it has finished.';
  if (!blockedReason && campusLimited(ctx))
    blockedReason = await assertStaffInCampus(
      ctx,
      punches.map((p) => p.employeeId),
      'This import has punches of',
    ).then(
      () => null,
      (err: Error) => err.message,
    );
  const options = (job.options ?? {}) as { deviceId?: string; dateOrder?: string };
  const datePreview = (job.summary as { datePreview?: { order?: string | null; timeZone?: string } } | null)
    ?.datePreview;
  const device = options.deviceId
    ? await BiometricDevice.findOne(scope(ctx, { _id: oid(options.deviceId) }))
        .select('name')
        .lean()
    : null;
  return {
    import: {
      _id: String(job._id),
      fileName: job.fileName,
      status: jobView(job).status,
      createdByName: job.createdByName,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      deviceName: device?.name ?? null,
      dateOrder: datePreview?.order ?? null,
      timeZone: datePreview?.timeZone ?? null,
    },
    canUndo: !blockedReason,
    blockedReason,
    punches: {
      total: punches.length,
      removed: removed.length,
      keptForOtherImports,
      keptForConnector,
      unlinkedRemoved: removed.filter((p) => !p.employeeId).length,
    },
    staff: {
      count: employeeIds.length,
      names: staff.map((s) => `${[s.firstName, s.lastName].filter(Boolean).join(' ')} (${s.employeeNo})`),
    },
    days,
    noResume: job.status === 'interrupted',
  };
}

/**
 * Undo the import. Claims it, saves the affected days, then removes or hands over the punches and
 * works the days out again in the background (poll GET /imports/{id}: `undo`). Returns the
 * import with `undo.status` "running".
 */
export async function undoImport(ctx: Ctx, id: string) {
  const job = await punchImport(ctx, id);
  const problem = stateProblem(job);
  if (problem) throw problem;
  // Refused before anything changes, rather than after the punches are gone.
  await assertBiometricIndexes();
  const runnerId = randomUUID();
  // Never while a punch import runs in the school, nor two undos at once (see punch-lock.ts).
  await requirePunchLock(ctx, runnerId, 'undo', String(job._id));
  try {
    return await claimUndo(ctx, id, job, runnerId);
  } catch (err) {
    await releasePunchLock(ctx, runnerId).catch(() => undefined);
    throw err;
  }
}

/** Claim the import's undo (holding the school's lock), check access, save the days, start it. */
async function claimUndo(ctx: Ctx, id: string, job: JobDoc, runnerId: string) {
  const claimed = (await ImportJob.findOneAndUpdate(
    scope(ctx, {
      _id: job._id,
      type: 'staff_punches',
      status: { $in: UNDOABLE },
      $or: [
        { undo: { $exists: false } },
        { 'undo.status': 'failed' },
        { 'undo.status': 'running', 'undo.heartbeatAt': { $lt: new Date(Date.now() - UNDO_STALE_MS) } },
      ],
    }),
    {
      $set: {
        'undo.status': 'running',
        'undo.runnerId': runnerId,
        'undo.heartbeatAt': new Date(),
        'undo.by': oid(ctx.userId),
        'undo.byName': ctx.name,
        'undo.startedAt': new Date(),
        'undo.error': null,
      },
      $inc: { 'undo.attempts': 1 },
    },
    { returnDocument: 'after' },
  ).lean()) as unknown as JobDoc & { undo: { days?: Array<{ employeeId: Types.ObjectId; localDate: string }> } };
  if (!claimed) {
    const now = await punchImport(ctx, id);
    const again = stateProblem(now);
    if (again) throw again;
    if (now.undo?.status === 'running')
      throw conflict('This import is being undone right now', undefined, 'UNDO_IN_PROGRESS');
    throw conflict('This import changed meanwhile; reload it', undefined, 'IMPORT_STATE');
  }
  const own = scope(ctx, { _id: job._id, 'undo.status': 'running', 'undo.runnerId': runnerId });
  const saved = claimed.undo.days;
  let days = saved;
  try {
    const punches = await PunchEvent.find(scope(ctx, { importJobId: job._id }))
      .select('employeeId localDate')
      .lean();
    // Every claim, the first and every retry (possibly by another user): a campus-limited user may
    // only undo an import whose punches, and the days already affected, are all of their
    // campuses' staff.
    await assertStaffInCampus(
      ctx,
      [...punches.map((p) => p.employeeId), ...(saved ?? []).map((d) => d.employeeId)],
      'This import has punches of',
    );
    if (!days) {
      days = [
        ...new Map(
          punches
            .filter((p) => p.employeeId)
            .map((p) => [dayKey(p.employeeId, p.localDate), { employeeId: p.employeeId!, localDate: p.localDate }]),
        ).values(),
      ];
      await ImportJob.updateOne(own, { $set: { 'undo.days': days, 'undo.punchesFound': punches.length } });
    }
  } catch (err) {
    // Nothing was changed by this attempt: a first attempt leaves the import as it was; a retry
    // leaves it "not finished", as before.
    await ImportJob.updateOne(
      own,
      saved ? { $set: { 'undo.status': 'failed', 'undo.error': NOT_FINISHED } } : { $unset: { undo: 1 } },
    ).catch(() => undefined);
    throw err;
  }
  const savedDays = days;
  setImmediate(() => void finishUndo(ctx, job, runnerId, savedDays));
  return jobView((await ImportJob.findOne(scope(ctx, { _id: job._id })).lean()) as unknown as JobDoc);
}

/** The rest of an undo (background): punches, then days, then the audit record, then done. */
async function finishUndo(
  ctx: Ctx,
  job: JobDoc,
  runnerId: string,
  days: Array<{ employeeId: unknown; localDate: string }>,
) {
  const own = scope(ctx, { _id: job._id, 'undo.status': 'running', 'undo.runnerId': runnerId });
  const timer = setInterval(() => {
    void ImportJob.updateOne(own, { $set: { 'undo.heartbeatAt': new Date() } }).catch(() => undefined);
    void renewPunchLock(ctx, runnerId).catch(() => undefined);
  }, HEARTBEAT_MS);
  timer.unref();
  try {
    const removedDays: typeof days = [];
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) throw new Error('Undo did not finish: punches of the import remain');
      // Still the only one changing the school's punches (the lock expired only if this process
      // stopped responding for minutes).
      if (!(await renewPunchLock(ctx, runnerId))) throw new Error('Undo lost the school’s punch lock');
      const undone = await undoneImports(ctx);
      const batch = (await PunchEvent.find(scope(ctx, { importJobId: job._id }))
        .select('employeeId localDate alsoImportJobIds alsoFromConnector')
        .limit(BATCH)
        .lean()) as Punch[];
      if (!batch.length) break;
      const remove: Types.ObjectId[] = [];
      const toConnector: Types.ObjectId[] = [];
      const handover = new Map<string, Types.ObjectId[]>();
      for (const p of batch) {
        const f = fate(p, job._id, undone);
        if (f.kind === 'remove') {
          remove.push(p._id);
          if (p.employeeId) removedDays.push({ employeeId: p.employeeId, localDate: p.localDate });
        } else if (f.kind === 'connector') toConnector.push(p._id);
        else handover.set(f.to, [...(handover.get(f.to) ?? []), p._id]);
      }
      // Each write only touches punches still held by this import.
      const mine = (ids: Types.ObjectId[]) => scope(ctx, { _id: { $in: ids }, importJobId: job._id });
      // A punch is removed only if, at that very moment, no other live import holds it and the
      // connector did not send it; one that changed since it was read is left for the next round
      // (handed over or kept then).
      const gone = [job._id, ...[...undone].map((u) => oid(u))];
      const removed = remove.length
        ? (
            await PunchEvent.deleteMany({
              ...mine(remove),
              alsoFromConnector: { $ne: true },
              alsoImportJobIds: { $not: { $elemMatch: { $nin: gone } } },
            })
          ).deletedCount
        : 0;
      let keptForOtherImports = 0;
      for (const [to, ids] of handover)
        keptForOtherImports += (
          await PunchEvent.updateMany(mine(ids), {
            $set: { importJobId: oid(to) },
            $unset: { rowNo: 1 },
            $pull: { alsoImportJobIds: { $in: [oid(to), job._id] } },
          })
        ).modifiedCount;
      const keptForConnector = toConnector.length
        ? (
            await PunchEvent.updateMany(mine(toConnector), {
              $set: { source: 'connector' },
              $unset: { importJobId: 1, rowNo: 1, alsoFromConnector: 1 },
              $pull: { alsoImportJobIds: job._id },
            })
          ).modifiedCount
        : 0;
      const progress = await ImportJob.updateOne(own, {
        $inc: {
          'undo.removed': removed,
          'undo.keptForOtherImports': keptForOtherImports,
          'undo.keptForConnector': keptForConnector,
        },
        $set: { 'undo.heartbeatAt': new Date() },
      });
      if (!progress.matchedCount) return; // another undo took over (this one had stalled)
    }
    // Punches of other imports noted as "also in this import" no longer count on it.
    await PunchEvent.updateMany(scope(ctx, { alsoImportJobIds: job._id }), { $pull: { alsoImportJobIds: job._id } });
    const daysRecalculated = await recomputeStaffDays(ctx, [...days, ...removedDays]);
    const state = (await ImportJob.findOne(own).lean()) as unknown as JobDoc & {
      undo: {
        punchesFound?: number;
        removed?: number;
        keptForOtherImports?: number;
        keptForConnector?: number;
        attempts?: number;
      };
    };
    if (!state) return;
    const options = (job.options ?? {}) as { deviceId?: string };
    const result = {
      punchesFound: state.undo.punchesFound ?? 0,
      removed: state.undo.removed ?? 0,
      keptForOtherImports: state.undo.keptForOtherImports ?? 0,
      keptForConnector: state.undo.keptForConnector ?? 0,
      daysRecalculated,
    };
    // Written once: a retry after a failure that came later (marking the undo done) finds it.
    if (!(await undoAudited(ctx, job._id)))
      await auditOrThrow(ctx, {
        action: 'import.undone',
        entityType: 'ImportJob',
        entityId: job._id,
        summary: `Undid the import of ${job.fileName}: ${result.removed} punch(es) removed`,
        metadata: {
          type: job.type,
          file: job.fileName,
          deviceId: options.deviceId ?? null,
          dateOrder: (job.summary as { datePreview?: { order?: string | null } } | null)?.datePreview?.order ?? null,
          attempts: state.undo.attempts ?? 1,
          ...result,
        },
      });
    await ImportJob.updateOne(own, {
      $set: { 'undo.status': 'completed', 'undo.finishedAt': new Date(), 'undo.daysRecalculated': daysRecalculated },
      $unset: { 'undo.days': 1, 'undo.runnerId': 1, 'undo.heartbeatAt': 1 },
    });
  } catch (err) {
    logger.error({ err, jobId: String(job._id) }, 'Undoing a punch import failed');
    await ImportJob.updateOne(own, { $set: { 'undo.status': 'failed', 'undo.error': NOT_FINISHED } }).catch(
      () => undefined,
    );
    // Only if the undo was not already recorded as done (the failure came after its audit entry,
    // e.g. marking it done): never "undone" and "failed" for the same undo.
    if (!(await undoAudited(ctx, job._id).catch(() => false)))
      await audit(ctx, {
        action: 'import.undo_failed',
        entityType: 'ImportJob',
        entityId: job._id,
        outcome: 'failure',
        metadata: { file: job.fileName, error: (err as Error).message?.slice(0, 300) },
      });
  } finally {
    clearInterval(timer);
    await releasePunchLock(ctx, runnerId).catch(() => undefined);
  }
}

/** The undo of this import is already in the audit log. */
async function undoAudited(ctx: Ctx, jobId: Types.ObjectId) {
  return Boolean(
    await AuditLog.exists({ schoolId: oid(ctx.schoolId), action: 'import.undone', entityId: String(jobId) }),
  );
}
