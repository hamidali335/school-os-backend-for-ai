import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { AppError, conflict, notFound, tooMany } from '../../utils/errors';
import { assertCampusAccess, campusScope, oid, scope, type LeanDoc } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { getAiProvider } from '../ai/provider';
import { resolveCall } from '../calls/calls.policy';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { AiCallAgent, engines, runningAgents, runningForSchool } from './ai-calls.agent';
import { AI_CALL_FINAL, AiConversation } from './ai-calls.model';
import type { Language, Question } from './conversation';

/**
 * AI voice conversations for school leadership (docs/AI_VOICE_CALLS.md). One parent per
 * conversation (no campaigns: those are Stage 4). Every rule is checked here, on the server:
 * permission and plan feature (route), the parent–student relationship (calls policy), engine
 * availability, and concurrency and daily limits.
 */

type ConvDoc = LeanDoc<typeof AiConversation>;
const LIVE = ['starting', 'ringing', 'consent', 'in_progress'] as const;

/** Which parts are configured (shown on the website before anyone starts a call). */
export async function availability(ctx: SchoolContext) {
  const { stt, tts } = engines();
  const provider = await getAiProvider();
  const since = startOfToday();
  const usedToday = await AiConversation.countDocuments(scope(ctx, { createdAt: { $gte: since } }));
  return {
    enabled: env.AI_CALLS_ENABLED && env.CALLS_ENABLED,
    speechToText: stt ? stt.name : null,
    textToSpeech: tts ? tts.name : null,
    languageModel: provider.isConfigured() ? 'configured' : null,
    ready: Boolean(env.AI_CALLS_ENABLED && env.CALLS_ENABLED && stt && tts && provider.isConfigured()),
    limits: {
      maxMinutes: env.AI_CALL_MAX_MINUTES,
      perDay: env.AI_CALL_DAILY_LIMIT_PER_SCHOOL,
      concurrentPerSchool: env.AI_CALL_MAX_CONCURRENT_PER_SCHOOL,
      transcriptRetentionDays: env.AI_CALL_TRANSCRIPT_RETENTION_DAYS,
    },
    usedToday,
    runningNow: runningForSchool(ctx.schoolId),
  };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface StartInput {
  studentId: string;
  parentId?: string;
  purpose: string;
  language: Language;
  questions: Question[];
  storeTranscript: boolean;
}

export async function startConversation(ctx: SchoolContext, input: StartInput) {
  if (!env.AI_CALLS_ENABLED || !env.CALLS_ENABLED)
    throw new AppError(503, 'AI_CALL_UNAVAILABLE', 'AI calls are turned off on this server.');
  const { stt, tts } = engines();
  const provider = await getAiProvider();
  const missing = [
    !stt && 'speech_to_text',
    !tts && 'text_to_speech',
    !provider.isConfigured() && 'language_model',
  ].filter(Boolean) as string[];
  if (missing.length)
    throw new AppError(
      503,
      'AI_CALL_UNAVAILABLE',
      'AI calls need speech recognition, speech synthesis and a language model configured on the server.',
      { missing },
    );
  const keys = new Set<string>();
  for (const q of input.questions) {
    if (keys.has(q.key)) throw conflict(`Two questions use the key "${q.key}"`, undefined, 'DUPLICATE');
    keys.add(q.key);
    if (q.type === 'choice' && !(q.choices?.length ?? 0))
      throw conflict(`Question "${q.key}" needs choices`, undefined, 'BAD_REQUEST');
  }

  // Limits. The in-process check and reservation happen with no await in between, so two
  // simultaneous starts on this instance cannot both take the last slot.
  if (
    (await AiConversation.countDocuments(scope(ctx, { createdAt: { $gte: startOfToday() } }))) >=
    env.AI_CALL_DAILY_LIMIT_PER_SCHOOL
  )
    throw tooMany('Your school has used all of today’s AI calls.', 'AI_CALL_LIMIT');
  if (runningAgents.size >= env.AI_CALL_MAX_CONCURRENT)
    throw tooMany('The AI assistant is busy with other calls. Please try again in a few minutes.', 'AI_CALL_BUSY');
  if (runningForSchool(ctx.schoolId) >= env.AI_CALL_MAX_CONCURRENT_PER_SCHOOL)
    throw tooMany('Another AI call of your school is still running. Wait until it ends.', 'AI_CALL_BUSY');
  const reservation = `reserve:${ctx.schoolId}:${Date.now()}:${Math.random()}`;
  runningAgents.set(reservation, { schoolId: ctx.schoolId } as AiCallAgent);

  try {
    // Who is being called is resolved exactly like a normal call (the parent of a student this
    // staff member may contact, with an active app account).
    const resolved = await resolveCall(ctx, input.studentId, { type: 'parent', parentId: input.parentId });
    const student = await Student.findOne(scope(ctx, { _id: resolved.studentId }))
      .select('campusId')
      .lean();
    assertCampusAccess(ctx, student!.campusId);

    const school = await School.findById(ctx.schoolId).select('name').lean();
    const conv = await AiConversation.create({
      schoolId: ctx.schoolId,
      studentId: resolved.studentId,
      studentName: resolved.studentName,
      campusId: student!.campusId,
      parentId: resolved.parentId,
      parentUserId: resolved.parentUserId,
      parentName: resolved.calleeName,
      createdBy: ctx.userId,
      createdByName: ctx.name,
      purpose: input.purpose,
      language: input.language,
      questions: input.questions,
      storeTranscript: input.storeTranscript,
      status: 'starting',
    });
    await audit(ctx, {
      action: 'ai_call.started',
      entityType: 'AiConversation',
      entityId: conv._id,
      summary: `AI call to ${resolved.calleeName} about ${resolved.studentName}`,
      metadata: { questions: input.questions.length, language: input.language, storeTranscript: input.storeTranscript },
    });
    const agent = new AiCallAgent(
      String(conv._id),
      ctx,
      {
        language: input.language,
        purpose: input.purpose,
        schoolName: school?.name ?? 'the school',
        studentName: resolved.studentName,
        staffName: ctx.name,
        questions: input.questions,
        storeTranscript: input.storeTranscript,
      },
      { studentId: String(resolved.studentId), parentId: String(resolved.parentId) },
      { stt: stt!, tts: tts! },
    );
    runningAgents.delete(reservation);
    const call = await agent.start();
    return { conversation: view(await reload(ctx, String(conv._id)), false), call };
  } finally {
    runningAgents.delete(reservation);
  }
}

async function reload(ctx: SchoolContext, id: string) {
  const c = await AiConversation.findOne(scope(ctx, { _id: oid(id), ...campusScope(ctx) })).lean();
  if (!c) throw notFound('AI call');
  return c;
}

/** What staff see. The transcript only on the detail view. */
export function view(c: ConvDoc, withTranscript: boolean) {
  return {
    _id: String(c._id),
    studentId: String(c.studentId),
    studentName: c.studentName,
    parentName: c.parentName,
    createdByName: c.createdByName,
    purpose: c.purpose,
    language: c.language as Language,
    questions: (c.questions ?? []).map(
      (q: { key: string; prompt: string; type: string; choices?: string[] | null; required?: boolean }) => ({
        key: q.key,
        prompt: q.prompt,
        type: q.type,
        choices: q.choices ?? undefined,
        required: q.required !== false,
      }),
    ),
    storeTranscript: c.storeTranscript !== false,
    callId: c.callId ?? null,
    status: c.status,
    consent: c.consent ?? null,
    answers: (c.answers ?? {}) as Record<string, string | number | boolean>,
    summary: c.summary ?? null,
    outcome: c.outcome ?? null,
    followUpRequested: Boolean(c.followUpRequested),
    failureReason: c.failureReason ?? null,
    createdAt: (c as { createdAt: Date }).createdAt.toISOString(),
    startedAt: c.startedAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    usage: {
      turns: c.usage?.turns ?? 0,
      speechSeconds: c.usage?.speechSeconds ?? 0,
      ttsCharacters: c.usage?.ttsCharacters ?? 0,
      llmTokens: c.usage?.llmTokens ?? 0,
      durationSec: c.usage?.durationSec ?? 0,
    },
    ...(withTranscript
      ? {
          transcript: (c.transcript ?? []).map((t: { role: string; text: string; at: Date }) => ({
            role: t.role as 'ai' | 'parent',
            text: t.text,
            at: t.at.toISOString(),
          })),
          transcriptExpiresAt: c.transcriptExpiresAt?.toISOString() ?? null,
        }
      : {}),
  };
}

export async function listConversations(ctx: SchoolContext, q: { page: number; limit: number; studentId?: string }) {
  const filter = scope(ctx, { ...campusScope(ctx), ...(q.studentId ? { studentId: oid(q.studentId) } : {}) });
  const [rows, total] = await Promise.all([
    AiConversation.find(filter)
      .select('-transcript')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    AiConversation.countDocuments(filter),
  ]);
  return {
    items: rows.map((r) => view(r, false)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

export async function getConversation(ctx: SchoolContext, id: string) {
  const c = await reload(ctx, id);
  if (c.transcript?.length)
    await audit(ctx, {
      action: 'ai_call.transcript_viewed',
      entityType: 'AiConversation',
      entityId: c._id,
      summary: c.studentName,
    });
  return view(c, true);
}

export async function cancelConversation(ctx: SchoolContext, id: string) {
  const c = await reload(ctx, id);
  if ((AI_CALL_FINAL as readonly string[]).includes(c.status)) return view(c, false);
  const agent = runningAgents.get(id);
  if (agent && 'cancel' in agent) await agent.cancel();
  else
    await AiConversation.updateOne(scope(ctx, { _id: c._id, status: { $in: [...LIVE] } }), {
      $set: { status: 'cancelled', endedAt: new Date(), failureReason: 'cancelled_by_staff' },
    });
  await audit(ctx, {
    action: 'ai_call.cancelled',
    entityType: 'AiConversation',
    entityId: c._id,
    summary: c.studentName,
  });
  return view(await reload(ctx, id), false);
}

/** Retention: remove transcripts past their expiry (answers, summary and outcome stay). */
export async function purgeExpiredTranscripts(now = new Date()) {
  const r = await AiConversation.updateMany(
    { transcriptExpiresAt: { $lte: now } },
    { $unset: { transcript: 1, transcriptExpiresAt: 1 } },
  ).setOptions({ crossTenant: true });
  return r.modifiedCount;
}

/** At startup: conversations left running by a previous run cannot continue. */
export async function recoverInterruptedConversations() {
  const r = await AiConversation.updateMany(
    { status: { $in: [...LIVE] } },
    { $set: { status: 'failed', failureReason: 'server_restart', endedAt: new Date() } },
  ).setOptions({ crossTenant: true });
  if (r.modifiedCount) logger.warn({ conversations: r.modifiedCount }, 'AI calls interrupted by a restart were closed');
}

let retention: NodeJS.Timeout | null = null;
export function startAiCallMaintenance(intervalMs = 60 * 60_000) {
  if (retention) return;
  retention = setInterval(() => {
    void purgeExpiredTranscripts().catch((err) => logger.error({ err }, 'AI call transcript retention failed'));
  }, intervalMs);
  retention.unref();
}
export function stopAiCallMaintenance() {
  if (retention) clearInterval(retention);
  retention = null;
}
