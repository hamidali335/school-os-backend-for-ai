import type { Api } from '../../utils/api';
import { idParams, objectId, paginationQuery, z } from '../../utils/zod';
import { AI_CALL_LANGUAGES, AI_CALL_STATUSES, ANSWER_TYPES } from './ai-calls.model';
import * as svc from './ai-calls.service';

const Question = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .openapi({ description: 'Short id for the answer, e.g. pickup_time' }),
    prompt: z.string().trim().min(3).max(300),
    type: z.enum(ANSWER_TYPES),
    choices: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
    required: z.boolean().default(true),
  })
  .openapi('AiCallQuestion');

const ConversationRes = z
  .object({
    _id: objectId(),
    studentId: objectId(),
    studentName: z.string(),
    parentName: z.string(),
    createdByName: z.string(),
    purpose: z.string(),
    language: z.enum(AI_CALL_LANGUAGES),
    questions: z.array(Question),
    storeTranscript: z.boolean(),
    callId: z.string().nullable(),
    status: z.enum(AI_CALL_STATUSES),
    consent: z.enum(['given', 'refused', 'unclear']).nullable(),
    answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    summary: z.string().nullable(),
    outcome: z
      .string()
      .nullable()
      .openapi({ description: 'all_answered | partly_answered | none_answered | follow_up' }),
    followUpRequested: z.boolean(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    usage: z.object({
      turns: z.number(),
      speechSeconds: z.number(),
      ttsCharacters: z.number(),
      llmTokens: z.number(),
      durationSec: z.number(),
    }),
  })
  .openapi('AiConversation');

const ConversationDetail = ConversationRes.extend({
  transcript: z.array(z.object({ role: z.enum(['ai', 'parent']), text: z.string(), at: z.string() })),
  transcriptExpiresAt: z.string().nullable(),
}).openapi('AiConversationDetail');

export function registerAiCallRoutes(api: Api) {
  const tags = ['AI calls'];
  const permission = 'ai_calls:manage' as const;

  api.route({
    method: 'get',
    path: '/ai-calls/availability',
    tags,
    auth: 'school',
    permission,
    summary: 'Whether AI calls can run (speech engines and language model configured), limits and usage today',
    response: z.object({
      enabled: z.boolean(),
      speechToText: z.string().nullable(),
      textToSpeech: z.string().nullable(),
      languageModel: z.string().nullable(),
      ready: z.boolean(),
      limits: z.object({
        maxMinutes: z.number(),
        perDay: z.number(),
        concurrentPerSchool: z.number(),
        transcriptRetentionDays: z.number(),
      }),
      usedToday: z.number(),
      runningNow: z.number(),
    }),
    handler: ({ ctx }) => svc.availability(ctx),
  });

  api.route({
    method: 'post',
    path: '/ai-calls',
    tags,
    auth: 'school',
    permission,
    status: 201,
    summary: 'Start an AI voice conversation with one parent about a student',
    description:
      'The parent (default: primary guardian) must have an active app account and the app or website open to hear it ring. ' +
      'The AI says it is an AI assistant for the school, asks for consent, then asks the configured questions; nothing is processed or kept before consent, and audio is never recorded. ' +
      '`503 AI_CALL_UNAVAILABLE` when speech recognition, speech synthesis or the language model is not configured (`details.missing`); `429 AI_CALL_LIMIT` / `AI_CALL_BUSY` for the daily and concurrency limits.',
    body: z.object({
      studentId: objectId(),
      parentId: objectId().optional(),
      purpose: z.string().trim().min(5).max(500),
      language: z.enum(AI_CALL_LANGUAGES).default('ur'),
      questions: z.array(Question).min(1).max(10),
      storeTranscript: z.boolean().default(true),
    }),
    response: z.object({
      conversation: ConversationRes,
      call: z.object({ callId: z.string(), status: z.string() }).passthrough(),
    }),
    handler: ({ ctx, body }) => svc.startConversation(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/ai-calls',
    tags,
    auth: 'school',
    permission,
    summary: 'AI conversations of the school (newest first)',
    query: paginationQuery.extend({ studentId: objectId().optional() }),
    response: ConversationRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listConversations(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/ai-calls/:id',
    tags,
    auth: 'school',
    permission,
    summary: 'One AI conversation with its transcript (if kept) — viewing is audited',
    params: idParams,
    response: ConversationDetail,
    handler: ({ ctx, params }) => svc.getConversation(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/ai-calls/:id/cancel',
    tags,
    auth: 'school',
    permission,
    summary: 'Stop an AI conversation now (it hangs up)',
    params: idParams,
    response: ConversationRes,
    handler: ({ ctx, params }) => svc.cancelConversation(ctx, params.id),
  });
}
