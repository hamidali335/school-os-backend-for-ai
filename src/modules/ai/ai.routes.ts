import { withoutPausedChannels } from '../../config/features';
import { aiLimiter } from '../../middleware/rate-limit';
import type { SchoolContext } from '../../types/context';
import type { Api } from '../../utils/api';
import { addDays, formatDateOnly, localDayRange, parseDateOnly } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { badRequest, forbidden } from '../../utils/errors';
import { findOwned } from '../../utils/tenant';
import { isoDate, objectId, z } from '../../utils/zod';
import { financialSummary } from '../accounts/accounts.service';
import { pipeline as admissionsPipeline } from '../admissions/admissions.service';
import { Inquiry } from '../admissions/inquiry.model';
import { attendanceReport, studentAttendance } from '../attendance/attendance.service';
import { audit } from '../audit/audit.service';
import { createAnnouncement } from '../communications/communications.service';
import { sectionResults, studentReportCard } from '../examinations/exams.service';
import { getInvoice, outstanding } from '../fees/fees.service';
import { studentOverview } from '../reports/dashboard.service';
import { School } from '../schools/school.model';
import { aiStatus, callAi, narrate, SYSTEM_GUARDRAILS, tryNarrate, usageSummary } from './ai.service';
import { executeTool, toolSpecs, toolsFor } from './copilot-tools';
import { computeInsights, dailyBriefFacts } from './insights.service';
import type { ChatMessage } from './provider';

const MAX_TOOL_ROUNDS = 4;

const InsightRes = z
  .object({
    id: z.string(),
    category: z.enum(['attendance', 'fees', 'admissions', 'operations']),
    severity: z.enum(['info', 'warning', 'critical']),
    title: z.string(),
    detail: z.string(),
    metrics: z.record(z.string(), z.any()),
    recommendation: z.string(),
  })
  .openapi('Insight');

const AiNarrative = {
  aiStatus: z.enum(['ok', 'unavailable']).openapi({
    description:
      '`unavailable` when AI is not configured, disabled, over limit or failing — computed data is still returned',
  }),
  narrative: z.string().nullable(),
  aiError: z.string().optional(),
};

async function copilotChat(ctx: SchoolContext, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const tools = toolsFor(ctx);
  const school = await School.findById(ctx.schoolId).select('name settings.timezone').lean();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: school?.settings?.timezone ?? 'Asia/Karachi' }).format(
    new Date(),
  );
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${SYSTEM_GUARDRAILS}\n\nSchool: ${school?.name}. Today: ${today}. The user is a ${ctx.role.replace('_', ' ')} named ${ctx.name}.\n` +
        'Use the tools to fetch data before answering questions about the school. If a tool returns an error, explain it briefly. ' +
        'If the user asks for something no tool can provide, say so.',
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const trace: Array<{ tool: string; ok: boolean; proposes?: boolean }> = [];
  const proposals: unknown[] = [];
  let usageTokens = 0;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await callAi(ctx, 'copilot', {
      messages,
      tools: round < MAX_TOOL_ROUNDS ? toolSpecs(tools) : undefined,
      maxTokens: 1000,
    });
    usageTokens += res.usage?.totalTokens ?? 0;
    if (!res.toolCalls.length) {
      return { reply: res.content ?? '', toolCalls: trace, proposals, tokensUsed: usageTokens };
    }
    messages.push({ role: 'assistant', content: res.content ?? null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls.slice(0, 6)) {
      const out = await executeTool(ctx, call.function.name, call.function.arguments);
      trace.push({ tool: call.function.name, ok: out.ok, proposes: (out as any).proposes });
      if (out.ok && (out as any).proposes) proposals.push({ tool: call.function.name, ...((out as any).data ?? {}) });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(out).slice(0, 12_000),
      });
    }
    if (trace.some((t) => t.proposes)) {
      await audit(ctx, {
        action: 'ai.copilot_proposal',
        entityType: 'Copilot',
        viaAi: true,
        metadata: { tools: trace.filter((t) => t.proposes).map((t) => t.tool) },
      });
    }
  }
  return {
    reply: 'I could not complete this request within the allowed number of steps.',
    toolCalls: trace,
    proposals,
    tokensUsed: usageTokens,
  };
}

export function registerAiRoutes(api: Api) {
  const tags = ['AI'];
  const mw = [aiLimiter];

  api.route({
    method: 'get',
    path: '/ai/status',
    tags,
    auth: 'school',
    permission: 'ai:use',
    // Readable on every plan: reports whether AI is included, and keeps past usage visible.
    feature: null,
    summary: 'Whether AI is configured/enabled for this school, and the monthly token allowance',
    response: z.object({
      provider: z.string(),
      model: z.string(),
      configured: z.boolean(),
      enabledForSchool: z.boolean(),
      includedInPlan: z
        .array(z.string())
        .openapi({ description: 'AI features in the school’s plan; empty means AI is not included' }),
      available: z.boolean(),
      monthlyTokenLimit: z.number(),
      tokensUsedThisMonth: z.number(),
      tokensRemaining: z.number(),
    }),
    handler: ({ ctx }) => aiStatus(ctx.schoolId),
  });

  api.route({
    method: 'post',
    path: '/ai/copilot/chat',
    tags,
    auth: 'school',
    permission: 'ai:use',
    feature: 'ai.copilot',
    middleware: mw,
    summary: 'Ask the School Copilot',
    description:
      'Stateless: send the recent conversation (max 12 turns). The Copilot answers using authorised, read-only data tools filtered by your permissions. ' +
      'It can only *propose* actions (draft announcements, fee-reminder approval requests) — never execute them. ' +
      'Errors: `AI_UNAVAILABLE` (503), `AI_LIMIT_REACHED` (429), `AI_PROVIDER_ERROR` (502).',
    body: z.object({
      messages: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) }))
        .min(1)
        .max(12)
        .refine((m) => m[m.length - 1].role === 'user', { message: 'The last message must be from the user' }),
    }),
    response: z.object({
      reply: z.string(),
      toolCalls: z.array(z.object({ tool: z.string(), ok: z.boolean(), proposes: z.boolean().optional() })),
      proposals: z.array(z.any()).openapi({ description: 'Drafts or approval requests created during this turn' }),
      tokensUsed: z.number(),
    }),
    handler: ({ ctx, body }) => copilotChat(ctx, body.messages),
  });

  api.route({
    method: 'get',
    path: '/ai/insights',
    tags,
    auth: 'school',
    permission: ['ai:use', 'reports:read'],
    feature: 'ai.insights',
    middleware: mw,
    summary: 'School insights: attendance and fee patterns, admissions follow-ups (computed; optional AI narrative)',
    description:
      'Insights and recommendations are computed by application code. Pass `narrative=true` for an AI summary; if AI is unavailable the insights are still returned.',
    query: z.object({ narrative: z.enum(['true', 'false']).optional() }),
    response: z.object({ generatedAt: z.string(), date: z.string(), insights: z.array(InsightRes), ...AiNarrative }),
    handler: async ({ ctx, query }) => {
      const data = await computeInsights(ctx);
      if (query.narrative !== 'true')
        return { ...data, aiStatus: 'unavailable' as const, narrative: null, aiError: 'NOT_REQUESTED' };
      const n = await tryNarrate(
        ctx,
        'insights',
        'Summarise these school insights for the principal in 5-8 bullet points, most urgent first, each with a concrete next step.',
        data.insights,
      );
      return { ...data, ...n };
    },
  });

  api.route({
    method: 'get',
    path: '/ai/daily-brief',
    tags,
    auth: 'school',
    permission: ['ai:use', 'reports:read'],
    feature: 'ai.insights',
    middleware: mw,
    summary: 'Daily school brief',
    description:
      '`text` is always present: the AI-written brief when available, otherwise a plain summary generated from the same facts.',
    response: z.object({ date: z.string(), facts: z.any(), text: z.string(), ...AiNarrative }),
    handler: async ({ ctx }) => {
      const { facts, fallbackText } = await dailyBriefFacts(ctx);
      const n = await tryNarrate(
        ctx,
        'daily_brief',
        'Write a short morning brief (under 180 words) for the school leadership: what happened, what needs attention today, and who should act.',
        facts,
      );
      return { date: facts.date, facts, text: n.narrative ?? fallbackText, ...n };
    },
  });

  api.route({
    method: 'post',
    path: '/ai/explain',
    tags,
    auth: 'school',
    permission: 'ai:use',
    feature: 'ai.assistant',
    middleware: mw,
    summary: 'Explain a record in plain language (student overview, invoice, exam result, attendance)',
    description: 'The data is loaded with your permissions and calculated by the system; the AI only explains it.',
    body: z.object({
      subject: z.enum(['student_overview', 'invoice', 'report_card', 'attendance']),
      id: objectId().openapi({ description: 'studentId, or invoiceId for `invoice`' }),
      examId: objectId().optional().openapi({ description: 'Required for report_card' }),
      language: z.enum(['en', 'ur']).default('en'),
    }),
    response: z.object({ explanation: z.string(), data: z.any() }),
    handler: async ({ ctx, body }) => {
      let data: unknown;
      if (body.subject === 'student_overview') data = await studentOverview(ctx, body.id);
      else if (body.subject === 'invoice') {
        if (!ctx.permissions.has('fees:read')) throw forbidden();
        data = await getInvoice(ctx, body.id);
      } else if (body.subject === 'report_card') {
        if (!body.examId) throw badRequest('examId is required');
        data = await studentReportCard(ctx, body.examId, body.id);
      } else {
        const to = formatDateOnly(new Date());
        data = await studentAttendance(ctx, body.id, formatDateOnly(addDays(parseDateOnly(to), -60)), to);
      }
      const explanation = await narrate(
        ctx,
        'explain',
        `Explain this ${body.subject.replace('_', ' ')} to a parent or teacher in simple ${body.language === 'ur' ? 'Urdu' : 'English'} (max 150 words). Do not change any numbers.`,
        data,
      );
      return { explanation, data };
    },
  });

  api.route({
    method: 'post',
    path: '/ai/summarize',
    tags,
    auth: 'school',
    permission: 'ai:use',
    feature: 'ai.assistant',
    middleware: mw,
    summary: 'Summarise text (meeting notes, parent complaints, circulars)',
    body: z.object({
      text: z.string().trim().min(20).max(20_000),
      style: z.enum(['bullets', 'paragraph']).default('bullets'),
    }),
    response: z.object({ summary: z.string() }),
    handler: async ({ ctx, body }) => ({
      summary: await narrate(
        ctx,
        'summarize',
        `Summarise the text as ${body.style === 'bullets' ? 'concise bullet points' : 'one short paragraph'}.`,
        { text: body.text },
      ),
    }),
  });

  api.route({
    method: 'post',
    path: '/ai/admissions/:id/recommendation',
    tags,
    auth: 'school',
    permission: ['ai:use', 'admissions:read'],
    feature: 'ai.assistant',
    middleware: mw,
    summary: 'Recommend the next follow-up step for an admission inquiry, with a draft message',
    params: z.object({ id: objectId() }),
    response: z.object({ recommendation: z.string(), inquiry: z.any() }),
    handler: async ({ ctx, params }) => {
      const inq = await findOwned(Inquiry, ctx, params.id, 'Inquiry');
      const facts = {
        stage: inq.stage,
        source: inq.source,
        classSought: inq.classSoughtName,
        priority: inq.priority,
        createdAt: inq.createdAt,
        lastContactedAt: inq.lastContactedAt,
        nextFollowUpAt: inq.nextFollowUpAt,
        followUps: (inq.followUps ?? [])
          .slice(-5)
          .map((f: any) => ({ at: f.at, channel: f.channel, note: f.note, outcome: f.outcome })),
        studentFirstName: inq.studentName.split(' ')[0],
      };
      const recommendation = await narrate(
        ctx,
        'admissions_recommendation',
        'Recommend the single best next step for this admission inquiry (channel and timing), explain why in one sentence, then give a short, warm draft message to the parent. The message is a draft for staff to review.',
        facts,
      );
      return { recommendation, inquiry: { _id: inq._id, inquiryNo: inq.inquiryNo, stage: inq.stage } };
    },
  });

  api.route({
    method: 'post',
    path: '/ai/draft-communication',
    tags,
    auth: 'school',
    permission: ['ai:use', 'communications:send'],
    feature: 'ai.assistant',
    middleware: mw,
    summary: 'Draft a parent communication (never sent automatically)',
    description:
      'Returns draft text. With `saveAsDraft`, it is stored as a draft announcement flagged `aiGenerated`; publishing it to external channels always requires approval.',
    body: z.object({
      purpose: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .openapi({ example: 'Inform parents that school will close early on Friday for a staff meeting' }),
      facts: z.string().trim().max(2000).optional(),
      tone: z.enum(['formal', 'friendly', 'urgent']).default('friendly'),
      language: z.enum(['en', 'ur', 'both']).default('en'),
      channel: z.enum(['in_app', 'sms', 'whatsapp', 'email']).default('in_app'),
      saveAsDraft: z
        .object({
          roles: z.array(z.enum(['parent', 'teacher'])).min(1),
          channels: z.array(z.enum(['in_app', 'sms', 'whatsapp', 'email'])).optional(),
        })
        .optional(),
    }),
    response: z.object({ title: z.string(), body: z.string(), draftAnnouncementId: objectId().optional() }),
    handler: async ({ ctx, body }) => {
      const school = await School.findById(ctx.schoolId).select('name').lean();
      const lang = body.language === 'ur' ? 'Urdu' : body.language === 'both' ? 'English followed by Urdu' : 'English';
      const limit = body.channel === 'sms' ? 'Keep the body under 300 characters.' : 'Keep it under 150 words.';
      const raw = await narrate(
        ctx,
        'draft_communication',
        `Draft a ${body.tone} message from ${school?.name} to parents in ${lang} for ${body.channel}. ${limit} ` +
          'Respond as JSON: {"title": "...", "body": "..."} and nothing else.',
        { purpose: body.purpose, facts: body.facts ?? null },
      );
      let parsed: { title?: string; body?: string } = {};
      try {
        parsed = JSON.parse(raw.replace(/^```(json)?|```$/g, '').trim());
      } catch {
        parsed = { title: body.purpose.slice(0, 80), body: raw };
      }
      const title = (parsed.title ?? body.purpose).slice(0, 150);
      const text = (parsed.body ?? raw).slice(0, 5000);
      let draftAnnouncementId: string | undefined;
      if (body.saveAsDraft) {
        const ann = await createAnnouncement(ctx, {
          title,
          body: text,
          audience: { roles: body.saveAsDraft.roles },
          // Paused channels (coming soon) are dropped; in-app is always kept.
          channels: withoutPausedChannels(body.saveAsDraft.channels ?? [body.channel]),
          aiGenerated: true,
        });
        draftAnnouncementId = ann._id.toString();
      }
      return { title, body: text, draftAnnouncementId };
    },
  });

  api.route({
    method: 'post',
    path: '/ai/reports/narrative',
    tags,
    auth: 'school',
    permission: ['ai:use', 'reports:read'],
    feature: 'ai.insights',
    middleware: mw,
    summary: 'AI-assisted reporting: compute a report, then explain it',
    description: 'The report figures are computed by the system and returned in `report`; the narrative explains them.',
    body: z.object({
      report: z.enum(['attendance', 'fees_outstanding', 'finance', 'admissions', 'exam_section']),
      from: isoDate().optional(),
      to: isoDate().optional(),
      examId: objectId().optional(),
      sectionId: objectId().optional(),
    }),
    response: z.object({ report: z.any(), ...AiNarrative }),
    handler: async ({ ctx, body }) => {
      const to = body.to ?? formatDateOnly(new Date());
      const from = body.from ?? formatDateOnly(addDays(parseDateOnly(to), -29));
      let report: unknown;
      switch (body.report) {
        case 'attendance':
          if (!ctx.permissions.has('attendance:read')) throw forbidden();
          report = await attendanceReport(ctx, { from, to, sectionId: body.sectionId });
          break;
        case 'fees_outstanding':
          if (!ctx.permissions.has('fees:manage')) throw forbidden();
          report = await outstanding(ctx, { limit: 30 });
          break;
        case 'finance':
          if (!ctx.permissions.has('accounts:read')) throw forbidden();
          report = await financialSummary(ctx, from, to);
          break;
        case 'admissions':
          if (!ctx.permissions.has('admissions:read')) throw forbidden();
          report = await admissionsPipeline(ctx, { from, to });
          break;
        case 'exam_section':
          if (!body.examId || !body.sectionId) throw badRequest('examId and sectionId are required');
          if (!ctx.permissions.has('exams:read')) throw forbidden();
          report = await sectionResults(ctx, body.examId, body.sectionId);
          break;
      }
      const n = await tryNarrate(
        ctx,
        'report_narrative',
        'Write a short narrative report (headline, 3-5 key findings, 2-3 recommendations) for school management based on this data.',
        report,
      );
      return { report, ...n };
    },
  });

  api.route({
    method: 'get',
    path: '/ai/usage',
    tags,
    auth: 'school',
    permission: 'ai:use',
    // Readable on every plan: reports whether AI is included, and keeps past usage visible.
    feature: null,
    roles: ['school_owner', 'principal'],
    summary: 'AI usage and estimated cost for this school (separate from messaging costs)',
    query: z.object({ from: isoDate(), to: isoDate() }),
    response: z.object({
      totalCalls: z.number(),
      totalTokens: z.number(),
      estimatedCostUsd: z.number(),
      costNote: z.string(),
      byFeature: z.array(
        z.object({
          feature: z.string(),
          calls: z.number(),
          errors: z.number(),
          tokens: z.number(),
          costUsd: z.number(),
        }),
      ),
    }),
    handler: async ({ ctx, query }) => {
      const { start, end } = localDayRange(query.from, query.to, await schoolTimezone(ctx.schoolId));
      return usageSummary(ctx.schoolId, start, end);
    },
  });
}
