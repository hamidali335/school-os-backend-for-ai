import { pausedChannels, pausedMessage, withoutPausedChannels } from '../../config/features';
import type { ZodType } from 'zod';
import type { Permission } from '../../config/permissions';
import type { SchoolContext } from '../../types/context';
import { addDays, formatDateOnly, parseDateOnly, todayInTz } from '../../utils/dates';
import { AppError, forbidden } from '../../utils/errors';
import { textSearchFilter } from '../../utils/pagination';
import { oid, scope } from '../../utils/tenant';
import { z } from '../../utils/zod';
import { studentVisibilityFilter } from '../academics/access.service';
import { financialSummary } from '../accounts/accounts.service';
import { pipeline as admissionsPipeline } from '../admissions/admissions.service';
import { listApprovals } from '../approvals/approvals.service';
import { attendanceReport, chronicAbsentees, dailySummary } from '../attendance/attendance.service';
import { createAnnouncement } from '../communications/communications.service';
import { sectionResults } from '../examinations/exams.service';
import { proposeFeeReminders } from '../automations/reminders.service';
import { outstanding } from '../fees/fees.service';
import { adminDashboard, studentOverview } from '../reports/dashboard.service';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import type { ToolSpec } from './provider';

export interface CopilotTool {
  name: string;
  description: string;
  schema: ZodType;
  /** All listed permissions are required. Checked again at execution time. */
  permissions: Permission[];
  /** Tool creates something (always a draft or an approval request, never a final action). */
  proposes?: boolean;
  run: (ctx: SchoolContext, args: any) => Promise<unknown>;
}

const ADMIN_ONLY = new Set(['school_owner', 'principal', 'school_admin', 'accountant', 'staff']);

async function today(ctx: SchoolContext) {
  const s = await School.findById(ctx.schoolId).select('settings.timezone').lean();
  return todayInTz(s?.settings?.timezone ?? 'Asia/Karachi');
}

const dateRange = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD')
    .optional(),
});

async function resolveRange(ctx: SchoolContext, a: { from?: string; to?: string }, days = 30) {
  const to = a.to ?? (await today(ctx));
  const from = a.from ?? formatDateOnly(addDays(parseDateOnly(to), -(days - 1)));
  return { from, to };
}

export const COPILOT_TOOLS: CopilotTool[] = [
  {
    name: 'get_school_overview',
    description:
      'Key school numbers right now: students, staff, attendance today, fee position, admissions, pending approvals, upcoming exams.',
    schema: z.object({}),
    permissions: ['dashboard:read', 'reports:read'],
    run: async (ctx) => {
      const d = await adminDashboard(ctx);
      return { ...d, actions: d.actions.map((a) => `${a.title}: ${a.count}`) };
    },
  },
  {
    name: 'get_attendance_today',
    description: "Today's attendance by section, including which sections have not been marked.",
    schema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    permissions: ['attendance:read', 'reports:read'],
    run: async (ctx, a) => {
      const d = await dailySummary(ctx, a.date);
      return {
        ...d,
        sections: d.sections.map((s) => ({
          section: s.section,
          enrolled: s.enrolled,
          marked: s.marked,
          rate: s.counts?.rate ?? null,
        })),
      };
    },
  },
  {
    name: 'get_attendance_report',
    description:
      'Attendance rates over a date range (default last 30 days), daily trend and students below the school threshold.',
    schema: dateRange.extend({
      sectionId: z
        .string()
        .regex(/^[a-f\d]{24}$/i)
        .optional(),
    }),
    permissions: ['attendance:read', 'reports:read'],
    run: async (ctx, a) => {
      const r = await attendanceReport(ctx, { ...(await resolveRange(ctx, a)), sectionId: a.sectionId });
      return { ...r, students: r.students.slice(0, 25) };
    },
  },
  {
    name: 'get_consecutive_absentees',
    description: 'Students absent several school days in a row (at or above the school alert threshold).',
    schema: z.object({}),
    permissions: ['attendance:read', 'reports:read'],
    run: (ctx) => chronicAbsentees(ctx),
  },
  {
    name: 'get_fee_outstanding',
    description: 'Outstanding and overdue fee balances, total and per student (largest first).',
    schema: z.object({ overdueOnly: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional() }),
    permissions: ['fees:manage'],
    run: (ctx, a) => outstanding(ctx, { overdueOnly: a.overdueOnly, limit: a.limit ?? 20 }),
  },
  {
    name: 'get_financial_summary',
    description: 'Fee collections, other income, expenses and net for a date range (default last 30 days).',
    schema: dateRange,
    permissions: ['accounts:read'],
    run: async (ctx, a) => {
      const r = await resolveRange(ctx, a);
      return financialSummary(ctx, r.from, r.to);
    },
  },
  {
    name: 'get_admissions_pipeline',
    description: 'Admissions funnel by stage and source, conversion rates and follow-ups due.',
    schema: z.object({}),
    permissions: ['admissions:read'],
    run: (ctx) => admissionsPipeline(ctx),
  },
  {
    name: 'search_students',
    description: 'Find students by name, admission number or roll number. Returns at most 10 matches.',
    schema: z.object({ query: z.string().min(2).max(60) }),
    permissions: ['students:read'],
    run: async (ctx, a) => {
      const filter: Record<string, unknown> = scope(ctx, { status: 'active' });
      // Same visibility as the students list: family for parents, own sections for teachers.
      const restriction = await studentVisibilityFilter(ctx);
      if (restriction) filter.$and = [restriction];
      filter.$or = textSearchFilter(a.query, ['firstName', 'lastName'], ['admissionNo', 'rollNo'])?.$or ?? [];
      const rows = await Student.find(filter)
        .select('firstName lastName admissionNo classId sectionId')
        .populate('classId', 'name')
        .populate('sectionId', 'name')
        .limit(10)
        .lean();
      return rows.map((s: any) => ({
        studentId: s._id,
        name: `${s.firstName} ${s.lastName ?? ''}`.trim(),
        admissionNo: s.admissionNo,
        class: s.classId?.name,
        section: s.sectionId?.name,
      }));
    },
  },
  {
    name: 'get_student_overview',
    description: "One student's last-30-day attendance, outstanding fees, latest exam and upcoming homework.",
    schema: z.object({ studentId: z.string().regex(/^[a-f\d]{24}$/i) }),
    permissions: ['students:read'],
    run: (ctx, a) => studentOverview(ctx, a.studentId),
  },
  {
    name: 'get_exam_section_results',
    description: 'Results of one section in an exam: pass rate, averages, subject statistics and student ranking.',
    schema: z.object({ examId: z.string().regex(/^[a-f\d]{24}$/i), sectionId: z.string().regex(/^[a-f\d]{24}$/i) }),
    permissions: ['exams:read', 'reports:read'],
    run: async (ctx, a) => {
      const r = await sectionResults(ctx, a.examId, a.sectionId);
      return {
        ...r,
        results: r.results.slice(0, 40).map((s) => ({
          name: s.name,
          percentage: s.percentage,
          grade: s.grade,
          position: s.position,
          passed: s.passed,
          failedSubjects: s.failedSubjects,
        })),
      };
    },
  },
  {
    name: 'list_pending_approvals',
    description: 'Approval requests waiting for a decision.',
    schema: z.object({}),
    permissions: ['approvals:read'],
    run: async (ctx) => {
      const r = await listApprovals(ctx, { page: 1, limit: 20, status: 'pending' });
      return r.items.map((a: any) => ({
        id: a._id,
        type: a.type,
        title: a.title,
        requestedBy: a.requestedByName,
        createdAt: a.createdAt,
      }));
    },
  },
  {
    name: 'draft_announcement',
    description:
      'Save an announcement as a DRAFT for staff review. It is NOT sent. Publishing AI-drafted text to SMS/WhatsApp/email always requires human approval.',
    schema: z.object({
      title: z.string().min(3).max(150),
      body: z.string().min(3).max(3000),
      roles: z.array(z.enum(['parent', 'teacher', 'principal', 'school_admin', 'accountant'])).min(1),
      channels: z.array(z.enum(['in_app', 'sms', 'whatsapp', 'email'])).optional(),
    }),
    permissions: ['communications:send'],
    proposes: true,
    run: async (ctx, a) => {
      const doc = await createAnnouncement(ctx, {
        title: a.title,
        body: a.body,
        audience: { roles: a.roles },
        // Paused channels (SMS/WhatsApp/email coming soon) are dropped; in-app is always kept.
        channels: withoutPausedChannels(a.channels ?? ['in_app']),
        aiGenerated: true,
      });
      const paused = pausedChannels(a.channels ?? []);
      return {
        draftAnnouncementId: doc._id,
        status: 'draft',
        note:
          'Saved as a draft. A staff member must review and publish it.' +
          (paused.length ? ` ${pausedMessage(paused)}` : ''),
      };
    },
  },
  {
    name: 'propose_fee_reminders',
    description:
      'Create an approval request to remind parents about overdue fees. Nothing is sent until an approver approves the request in the approval queue.',
    schema: z.object({
      channels: z
        .array(z.enum(['sms', 'whatsapp', 'email']))
        .max(3)
        .optional(),
      reason: z.string().max(500).optional(),
    }),
    permissions: ['fees:manage'],
    proposes: true,
    run: async (ctx, a) => {
      const approval = await proposeFeeReminders(ctx, {
        channels: a.channels ?? [],
        recommendation: a.reason,
        source: 'ai',
      });
      if (!approval) return { created: false, note: 'No overdue invoices need a reminder right now.' };
      const paused = pausedChannels(a.channels ?? []);
      return {
        created: true,
        approvalId: approval._id,
        title: approval.title,
        status: 'pending',
        note: 'Awaiting human approval.' + (paused.length ? ` In-app only: ${pausedMessage(paused)}` : ''),
      };
    },
  },
];

export function toolsFor(ctx: SchoolContext): CopilotTool[] {
  return COPILOT_TOOLS.filter((t) => t.permissions.every((p) => ctx.permissions.has(p))).filter(
    (t) => !t.permissions.includes('reports:read') || ADMIN_ONLY.has(ctx.role),
  );
}

export function toolSpecs(tools: CopilotTool[]): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
}

/**
 * Executes one tool call on behalf of the signed-in user. Arguments are validated and
 * permissions re-checked here; the model can never reach data the user could not.
 */
export async function executeTool(ctx: SchoolContext, name: string, rawArgs: string) {
  const tool = toolsFor(ctx).find((t) => t.name === name);
  if (!tool) return { ok: false, error: 'Tool not available for this user' };
  let parsedJson: unknown;
  try {
    parsedJson = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON' };
  }
  const args = tool.schema.safeParse(parsedJson);
  if (!args.success)
    return { ok: false, error: `Invalid arguments: ${args.error.issues.map((i) => i.message).join('; ')}` };
  if (!tool.permissions.every((p) => ctx.permissions.has(p))) throw forbidden();
  try {
    return { ok: true, proposes: !!tool.proposes, data: await tool.run(ctx, args.data) };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message };
    throw err;
  }
}
