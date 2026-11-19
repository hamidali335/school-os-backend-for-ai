import type { Types } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ErrorEvent } from '../health/error-event.model';
import { School } from '../schools/school.model';
import { AutomationRule } from './automation.models';
import { computeNextRun, executeRule } from './automations.service';
import { writesFrozen } from '../../services/write-freeze';
import { checkAllSchoolsSessionRollover } from '../academics/session-generator.service';

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastSessionCheck = 0;
const LOCK_MS = 10 * 60_000;
const SESSION_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Polls for due automation rules. Each rule is claimed with an atomic lock, so running
 * several API instances never executes the same rule twice.
 */
export async function tick(now = new Date()) {
  // A backup has paused writes (standalone MongoDB); due rules run on the next tick.
  if (running || writesFrozen()) return;
  running = true;
  try {
    for (let i = 0; i < 50; i++) {
      const rule = await AutomationRule.findOneAndUpdate(
        { enabled: true, nextRunAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
        { returnDocument: 'after' },
      )
        .setOptions({ crossTenant: true })
        .lean();
      if (!rule) break;
      const school = await School.findById(rule.schoolId).select('status settings.timezone').lean();
      try {
        if (school?.status === 'active') await executeRule(rule.schoolId.toString(), rule as any, 'schedule');
      } catch (err) {
        logger.error({ err, ruleId: rule._id }, 'Automation rule failed');
        await ErrorEvent.create({
          source: 'scheduler',
          message: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          schoolId: rule.schoolId,
        }).catch(() => undefined);
      } finally {
        await rescheduleOrDisable(rule, school?.settings?.timezone ?? 'Asia/Karachi', now);
      }
    }

    if (now.getTime() - lastSessionCheck > SESSION_CHECK_INTERVAL_MS) {
      lastSessionCheck = now.getTime();
      await checkAllSchoolsSessionRollover(now);
    }
  } catch (err) {
    logger.error({ err }, 'Scheduler tick failed');
  } finally {
    running = false;
  }
}

/**
 * Moves a rule to its next run. A rule whose schedule cannot be computed (malformed data) is
 * disabled and recorded instead of throwing: one school's bad rule must not stop the tick for
 * every other school, nor be retried forever.
 */
async function rescheduleOrDisable(
  rule: { _id: Types.ObjectId; schoolId: Types.ObjectId; schedule?: unknown },
  timezone: string,
  now: Date,
) {
  try {
    const nextRunAt = computeNextRun((rule.schedule ?? {}) as Parameters<typeof computeNextRun>[0], timezone, now);
    if (Number.isNaN(nextRunAt.getTime())) throw new Error('Invalid next run time');
    await AutomationRule.updateOne(
      { schoolId: rule.schoolId, _id: rule._id },
      { $set: { nextRunAt }, $unset: { lockedUntil: 1 } },
    );
  } catch (err) {
    logger.error({ err, ruleId: rule._id }, 'Automation rule has an invalid schedule; disabling it');
    await AutomationRule.updateOne(
      { schoolId: rule.schoolId, _id: rule._id },
      { $set: { enabled: false }, $unset: { lockedUntil: 1 } },
    ).catch(() => undefined);
    await ErrorEvent.create({
      source: 'scheduler',
      message: `Rule disabled: invalid schedule (${err instanceof Error ? err.message.slice(0, 200) : 'unknown'})`,
      schoolId: rule.schoolId,
    }).catch(() => undefined);
  }
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick(), env.SCHEDULER_INTERVAL_SECONDS * 1000);
  timer.unref();
  logger.info({ intervalSeconds: env.SCHEDULER_INTERVAL_SECONDS }, 'Automation scheduler started');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
