import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext, SystemContext } from '../../types/context';
import { badRequest, notFound } from '../../utils/errors';
import { formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { findOwned, oid, scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { School } from '../schools/school.model';
import { AcademicSession } from './academics.models';

type Ctx = SchoolContext | SystemContext;

export interface SessionDates {
  name: string;
  startDate: Date;
  endDate: Date;
}

/**
 * Advances a date by a given number of years while safely preserving month boundaries
 * and leap years (e.g. Feb 29 in leap year -> Feb 28 in non-leap year, or Feb 28 -> Feb 29).
 */
export function addYearsPreservingMonthDay(d: Date, years: number): Date {
  const y = d.getUTCFullYear() + years;
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const lastDayInOrigMonth = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  const isLastDay = day === lastDayInOrigMonth;

  const lastDayInTargetMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  let targetDay = day;
  if (isLastDay) {
    targetDay = lastDayInTargetMonth;
  } else {
    targetDay = Math.min(day, lastDayInTargetMonth);
  }
  return new Date(Date.UTC(y, m, targetDay));
}

/**
 * Derives the next academic session name based on common naming patterns:
 * - "2025-2026" -> "2026-2027"
 * - "2025/2026" -> "2026/2027"
 * - "Session 2025-2026" -> "Session 2026-2027"
 * - "2025" -> "2026"
 * - Fallback: derived from next start and end date years.
 */
export function deriveNextSessionName(currentName: string, nextStartDate: Date, nextEndDate: Date): string {
  const trimmed = currentName.trim();

  // Pattern 1: Two 4-digit years with a delimiter (e.g., 2024-2025, 2024/2025)
  const rangeMatch = trimmed.match(/^([\D]*)(\d{4})([^\d]+)(\d{4})([\D]*)$/);
  if (rangeMatch) {
    const prefix = rangeMatch[1];
    const y1 = Number(rangeMatch[2]);
    const sep = rangeMatch[3];
    const y2 = Number(rangeMatch[4]);
    const suffix = rangeMatch[5];
    return `${prefix}${y1 + 1}${sep}${y2 + 1}${suffix}`;
  }

  // Pattern 2: Single 4-digit year (e.g., 2025, Session 2025)
  const singleYearMatch = trimmed.match(/^([\D]*)(\d{4})([\D]*)$/);
  if (singleYearMatch) {
    const prefix = singleYearMatch[1];
    const y = Number(singleYearMatch[2]);
    const suffix = singleYearMatch[3];
    return `${prefix}${y + 1}${suffix}`;
  }

  // Fallback: derive from next session dates
  const sY = nextStartDate.getUTCFullYear();
  const eY = nextEndDate.getUTCFullYear();
  return sY === eY ? `${sY}` : `${sY}-${eY}`;
}

/**
 * Computes next session dates and name dynamically from an existing session.
 * Handles month boundaries and leap years safely without hardcoding any month.
 */
export function computeNextSessionDates(session: { name: string; startDate: Date; endDate: Date }): SessionDates {
  const nextStartDate = addYearsPreservingMonthDay(session.startDate, 1);
  const nextEndDate = addYearsPreservingMonthDay(session.endDate, 1);
  const nextName = deriveNextSessionName(session.name, nextStartDate, nextEndDate);

  return {
    name: nextName,
    startDate: nextStartDate,
    endDate: nextEndDate,
  };
}

/**
 * Previews what the next academic session will be, its source session, whether it is due,
 * and whether it has already been generated.
 */
export async function previewNextSessionGeneration(ctx: Ctx, sourceSessionId?: string) {
  const school = await School.findById(ctx.schoolId).select('settings').lean();
  const timezone = school?.settings?.timezone ?? 'Asia/Karachi';

  const sourceId = sourceSessionId ?? school?.settings?.currentSessionId;
  if (!sourceId) {
    throw badRequest('No current or source academic session found to generate next session from.');
  }

  const sourceSession = await findOwned(AcademicSession, ctx, sourceId, 'Source academic session');
  const computed = computeNextSessionDates(sourceSession);

  // Check if next session was already generated
  const existing = await AcademicSession.findOne(
    scope(ctx, {
      $or: [{ generatedFromSessionId: sourceSession._id }, { name: computed.name }],
    }),
  ).lean();

  const localToday = todayInTz(timezone);
  const endDateStr = formatDateOnly(sourceSession.endDate);
  const isDue = localToday >= endDateStr;

  return {
    sourceSession: {
      _id: sourceSession._id.toString(),
      name: sourceSession.name,
      startDate: formatDateOnly(sourceSession.startDate),
      endDate: formatDateOnly(sourceSession.endDate),
      isCurrent: sourceSession.isCurrent,
      status: sourceSession.status,
    },
    proposedSession: {
      name: computed.name,
      startDate: formatDateOnly(computed.startDate),
      endDate: formatDateOnly(computed.endDate),
    },
    schoolTimezone: timezone,
    localToday,
    isDue,
    alreadyGenerated: Boolean(existing),
    existingSession: existing
      ? {
          _id: existing._id.toString(),
          name: existing.name,
          startDate: formatDateOnly(existing.startDate),
          endDate: formatDateOnly(existing.endDate),
          status: existing.status,
          isCurrent: existing.isCurrent,
          generationSource: (existing as any).generationSource ?? 'manual',
        }
      : null,
  };
}

/**
 * Generates the next academic session idempotently.
 * Never silently promotes students or activates the session disruptively.
 * Status is set to 'planned' and isCurrent is false.
 */
export async function generateNextSession(
  ctx: Ctx,
  input?: { sourceSessionId?: string; name?: string; startDate?: string; endDate?: string; isAutomatic?: boolean },
) {
  const school = await School.findById(ctx.schoolId).select('settings').lean();
  const sourceId = input?.sourceSessionId ?? school?.settings?.currentSessionId;
  if (!sourceId) {
    throw badRequest('Cannot generate next session: no current or specified session found.');
  }

  const sourceSession = await findOwned(AcademicSession, ctx, sourceId, 'Source academic session');
  const computed = computeNextSessionDates(sourceSession);

  const targetName = input?.name?.trim() || computed.name;
  const targetStartDate = input?.startDate ? parseDateOnly(input.startDate) : computed.startDate;
  const targetEndDate = input?.endDate ? parseDateOnly(input.endDate) : computed.endDate;

  if (targetStartDate >= targetEndDate) {
    throw badRequest('startDate must be before endDate');
  }

  // Idempotency check 1: already generated from this source session
  let existing = await AcademicSession.findOne(
    scope(ctx, { generatedFromSessionId: sourceSession._id }),
  ).lean();

  // Idempotency check 2: already exists with the target name
  if (!existing) {
    existing = await AcademicSession.findOne(
      scope(ctx, { name: targetName }),
    ).lean();
  }

  if (existing) {
    logger.info(
      { schoolId: ctx.schoolId, sessionId: existing._id, name: existing.name },
      'Next academic session already exists; returning existing session idempotently',
    );
    return existing;
  }

  const isAuto = Boolean(input?.isAutomatic);
  const created = await AcademicSession.create({
    schoolId: oid(ctx.schoolId),
    name: targetName,
    startDate: targetStartDate,
    endDate: targetEndDate,
    isCurrent: false,
    status: 'planned',
    generationSource: isAuto ? 'automatic' : 'manual',
    generatedFromSessionId: sourceSession._id,
    generatedAt: new Date(),
    feeRolloverStatus: 'none',
  });

  await audit(ctx, {
    action: isAuto ? 'academic_session.auto_generate' : 'academic_session.generate_next',
    entityType: 'AcademicSession',
    entityId: created._id,
    summary: `Generated next academic session "${created.name}" from "${sourceSession.name}"`,
    metadata: {
      sourceSessionId: sourceSession._id.toString(),
      generationSource: isAuto ? 'automatic' : 'manual',
      startDate: formatDateOnly(created.startDate),
      endDate: formatDateOnly(created.endDate),
    },
  });

  return created.toObject();
}

/**
 * Checks if a school's current session has reached or passed its end date in the school's timezone,
 * and if so, automatically generates the next academic session idempotently.
 */
export async function checkAndGenerateNextSessionForSchool(schoolId: string | Types.ObjectId) {
  const school = await School.findById(schoolId).select('status settings').lean();
  if (!school || school.status !== 'active') return null;

  const currentSessionId = school.settings?.currentSessionId;
  if (!currentSessionId) return null;

  const session = await AcademicSession.findOne({
    schoolId: oid(schoolId),
    _id: currentSessionId,
  }).lean();
  if (!session) return null;

  const timezone = school.settings?.timezone ?? 'Asia/Karachi';
  const localToday = todayInTz(timezone);
  const endStr = formatDateOnly(session.endDate);

  // If local today has reached or passed session end date
  if (localToday >= endStr) {
    const ctx: SystemContext = {
      kind: 'system',
      schoolId: schoolId.toString(),
      label: 'scheduler.auto_session_rollover',
    };
    return generateNextSession(ctx, {
      sourceSessionId: session._id.toString(),
      isAutomatic: true,
    });
  }

  return null;
}

/**
 * Cross-tenant scheduled runner to inspect all active schools and trigger automatic next-session
 * generation if due. Safe to run concurrently or on server restarts.
 */
export async function checkAllSchoolsSessionRollover(now = new Date()) {
  try {
    const activeSchools = await School.find({ status: 'active' })
      .select('_id')
      .lean();

    for (const s of activeSchools) {
      try {
        await checkAndGenerateNextSessionForSchool(s._id);
      } catch (err) {
        logger.error({ err, schoolId: s._id }, 'Automatic session generation failed for school');
      }
    }
  } catch (err) {
    logger.error({ err }, 'checkAllSchoolsSessionRollover tick failed');
  }
}

/**
 * Safe activation workflow:
 * Switches an academic session to current and active without destroying historical records.
 * Marks other sessions isCurrent: false and closes previously active session.
 */
export async function activateSessionSafely(ctx: Ctx, sessionId: string) {
  const target = await findOwned(AcademicSession, ctx, sessionId, 'Academic session');

  // Close or de-current previous sessions
  await AcademicSession.updateMany(
    scope(ctx, { _id: { $ne: target._id }, isCurrent: true }),
    { $set: { isCurrent: false, status: 'closed' } },
  );

  const updated = await AcademicSession.findOneAndUpdate(
    scope(ctx, { _id: target._id }),
    { $set: { isCurrent: true, status: 'active' } },
    { returnDocument: 'after' },
  ).lean();

  await School.updateOne(
    { _id: oid(ctx.schoolId) },
    { $set: { 'settings.currentSessionId': target._id } },
  );

  await audit(ctx, {
    action: 'academic_session.activate',
    entityType: 'AcademicSession',
    entityId: target._id,
    summary: `Activated academic session "${target.name}" as current session`,
  });

  return updated;
}
