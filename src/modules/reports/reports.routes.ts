import type { Response } from 'express';
import type { Api } from '../../utils/api';
import { toCsv } from '../../utils/csv';
import { renderReport } from '../../services/pdf';
import { loadBrand } from '../branding/branding.service';
import { forbidden, notFound } from '../../utils/errors';
import { addDays, localDayRange, parseDateOnly } from '../../utils/dates';
import { schoolTimezone } from '../schools/timezone';
import { campusScope, oid, scope } from '../../utils/tenant';
import { idParams, isoDate, objectId, z } from '../../utils/zod';
import { Section } from '../academics/academics.models';
import { financialSummary } from '../accounts/accounts.service';
import { pipeline as admissionsPipeline } from '../admissions/admissions.service';
import { attendanceReport } from '../attendance/attendance.service';
import { audit } from '../audit/audit.service';
import { Exam } from '../examinations/exam.models';
import { sectionResults } from '../examinations/exams.service';
import { Payment } from '../fees/fees.models';
import { outstanding } from '../fees/fees.service';
import { Student } from '../students/student.models';
import { dashboardFor, studentOverview } from './dashboard.service';

const format = z.object({
  format: z
    .enum(['json', 'csv', 'pdf'])
    .default('json')
    .openapi({ description: 'pdf: a printable report with the school’s branding' }),
});

type Col = { key: string; header: string; align?: 'right'; width?: number };

/** Send a report as CSV or as a branded PDF (same columns and rows). */
async function sendExport(
  ctx: { schoolId: string },
  res: Response,
  kind: 'csv' | 'pdf',
  r: {
    name: string;
    title: string;
    subtitle?: string;
    columns: Col[];
    rows: Array<Record<string, any>>;
    totals?: Record<string, any>;
  },
) {
  if (kind === 'csv')
    return sendCsv(
      res,
      r.name,
      toCsv(
        r.columns.map(({ key, header }) => ({ key, header })),
        r.rows,
      ),
    );
  const fmt = (v: unknown) =>
    typeof v === 'number' ? v.toLocaleString('en-PK') : v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? '');
  const pdf = await renderReport(
    {
      title: r.title,
      subtitle: r.subtitle,
      columns: r.columns.map((c) => ({ key: c.key, label: c.header, align: c.align, width: c.width })),
      rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c) => [c.key, fmt(row[c.key])]))) as never,
      totals: r.totals
        ? (Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, fmt(v)])) as never)
        : undefined,
    },
    await loadBrand(ctx.schoolId),
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${r.name}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}
const range = z.object({ from: isoDate(), to: isoDate() });

function sendCsv(res: Response, name: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(csv);
}

export function registerReportRoutes(api: Api) {
  const tags = ['Dashboard & Reports'];

  api.route({
    method: 'get',
    path: '/dashboard',
    tags,
    auth: 'school',
    permission: 'dashboard:read',
    summary: 'Role-aware dashboard: statistics and action items',
    description:
      'Response shape depends on `role`: `admin` (owner/principal/administrator), `accountant`, `teacher`, or `parent`/`student` (per-child overviews). ' +
      'Every variant includes an `actions` array of `{type, priority, title, count, link}`.',
    response: z
      .object({
        role: z.string(),
        date: z.string(),
        actions: z.array(
          z.object({ type: z.string(), priority: z.string(), title: z.string(), count: z.number(), link: z.string() }),
        ),
      })
      .passthrough(),
    handler: ({ ctx }) => dashboardFor(ctx),
  });

  api.route({
    method: 'get',
    path: '/students/:id/overview',
    tags,
    auth: 'school',
    permission: 'students:read',
    summary: 'Student overview: 30-day attendance, fees, latest exam, upcoming homework',
    params: idParams,
    response: z.object({
      student: z.any(),
      attendanceLast30Days: z.any(),
      fees: z.any(),
      latestExam: z.any().nullable(),
      upcomingHomework: z.array(z.any()),
    }),
    handler: ({ ctx, params }) => studentOverview(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/reports/attendance',
    tags,
    auth: 'school',
    permission: ['reports:read', 'attendance:read'],
    summary: 'Attendance report (JSON or CSV)',
    query: range.extend({ classId: objectId().optional(), sectionId: objectId().optional() }).merge(format),
    response: z.any(),
    handler: async ({ ctx, query, res }) => {
      const r = await attendanceReport(ctx, query);
      if (query.format === 'json') return r;
      if (!ctx.permissions.has('reports:export')) throw forbidden('You do not have permission to export reports');
      await audit(ctx, {
        action: 'report.export',
        metadata: { report: 'attendance', format: query.format, from: query.from, to: query.to },
      });
      await sendExport(ctx, res, query.format, {
        name: `attendance-${query.from}-to-${query.to}`,
        title: 'Attendance report',
        subtitle: `${query.from} to ${query.to}`,
        columns: [
          { key: 'admissionNo', header: 'Admission No', width: 1.3 },
          { key: 'name', header: 'Student', width: 2.4 },
          { key: 'present', header: 'Present', align: 'right' },
          { key: 'late', header: 'Late', align: 'right' },
          { key: 'absent', header: 'Absent', align: 'right' },
          { key: 'leave', header: 'Leave', align: 'right' },
          { key: 'excused', header: 'Excused', align: 'right' },
          { key: 'rate', header: 'Attendance %', align: 'right', width: 1.3 },
        ],
        rows: r.students,
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/fee-collection',
    tags,
    auth: 'school',
    permission: ['reports:read', 'fees:read'],
    summary: 'Fee collections grouped by day, payment method or class (JSON or CSV)',
    query: range.extend({ groupBy: z.enum(['day', 'method', 'class']).default('day') }).merge(format),
    response: z.object({
      from: z.string(),
      to: z.string(),
      groupBy: z.string(),
      total: z.number(),
      count: z.number(),
      rows: z.array(z.object({ key: z.string(), total: z.number(), count: z.number() })),
    }),
    handler: async ({ ctx, query, res }) => {
      const tz = await schoolTimezone(ctx.schoolId);
      const { start, end } = localDayRange(query.from, query.to, tz);
      const match = scope(ctx, {
        status: 'valid',
        receivedAt: { $gte: start, $lt: end },
        ...campusScope(ctx),
      });
      const pipeline: any[] = [{ $match: match }];
      if (query.groupBy === 'class') {
        pipeline.push(
          { $lookup: { from: 'invoices', localField: 'invoiceId', foreignField: '_id', as: 'inv' } },
          { $unwind: '$inv' },
          { $lookup: { from: 'classes', localField: 'inv.classId', foreignField: '_id', as: 'cls' } },
          { $unwind: { path: '$cls', preserveNullAndEmptyArrays: true } },
          { $group: { _id: { $ifNull: ['$cls.name', 'Unassigned'] }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
        );
      } else {
        pipeline.push({
          $group: {
            _id:
              query.groupBy === 'method'
                ? '$method'
                : { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt', timezone: tz } },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        });
      }
      pipeline.push({ $sort: { _id: 1 } });
      const rows = (await Payment.aggregate(pipeline)).map((r) => ({
        key: String(r._id),
        total: r.total,
        count: r.count,
      }));
      const result = {
        from: query.from,
        to: query.to,
        groupBy: query.groupBy,
        total: rows.reduce((s, r) => s + r.total, 0),
        count: rows.reduce((s, r) => s + r.count, 0),
        rows,
      };
      if (query.format === 'json') return result;
      if (!ctx.permissions.has('reports:export')) throw forbidden('You do not have permission to export reports');
      await audit(ctx, {
        action: 'report.export',
        metadata: { report: 'fee-collection', format: query.format, from: query.from, to: query.to },
      });
      await sendExport(ctx, res, query.format, {
        name: `fee-collection-${query.from}-to-${query.to}`,
        title: 'Fee collection',
        subtitle: `${query.from} to ${query.to} · grouped by ${query.groupBy}`,
        columns: [
          {
            key: 'key',
            header: query.groupBy === 'day' ? 'Date' : query.groupBy === 'method' ? 'Method' : 'Class',
            width: 2,
          },
          { key: 'count', header: 'Payments', align: 'right' },
          { key: 'total', header: 'Amount (PKR)', align: 'right', width: 1.5 },
        ],
        rows,
        totals: { key: 'Total', count: result.count, total: result.total },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/outstanding',
    tags,
    auth: 'school',
    permission: ['reports:read', 'fees:manage'],
    summary: 'Outstanding fees per student (JSON or CSV)',
    query: z
      .object({
        classId: objectId().optional(),
        sectionId: objectId().optional(),
        overdueOnly: z.enum(['true', 'false']).optional(),
      })
      .merge(format),
    response: z.any(),
    handler: async ({ ctx, query, res }) => {
      const r = await outstanding(ctx, {
        classId: query.classId,
        sectionId: query.sectionId,
        overdueOnly: query.overdueOnly === 'true',
        limit: 5000,
      });
      if (query.format === 'json') return r;
      if (!ctx.permissions.has('reports:export')) throw forbidden('You do not have permission to export reports');
      await audit(ctx, { action: 'report.export', metadata: { report: 'outstanding', format: query.format } });
      await sendExport(ctx, res, query.format, {
        name: 'outstanding-fees',
        title: 'Outstanding fees',
        subtitle: query.overdueOnly === 'true' ? 'Overdue only' : 'All open invoices',
        columns: [
          { key: 'admissionNo', header: 'Admission No', width: 1.3 },
          { key: 'name', header: 'Student', width: 2.4 },
          { key: 'invoices', header: 'Open Invoices', align: 'right' },
          { key: 'balance', header: 'Outstanding (PKR)', align: 'right', width: 1.4 },
          { key: 'overdueBalance', header: 'Overdue (PKR)', align: 'right', width: 1.3 },
          { key: 'oldestDueDate', header: 'Oldest Due Date', width: 1.3 },
        ],
        rows: r.students,
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/finance',
    tags,
    auth: 'school',
    permission: ['reports:read', 'accounts:read'],
    summary: 'Income and expense summary (JSON, CSV or PDF)',
    query: range.merge(format),
    response: z.any(),
    handler: async ({ ctx, query, res }) => {
      const r = await financialSummary(ctx, query.from, query.to);
      if (query.format === 'json') return r;
      await exportAudited(ctx, 'finance', query.format, { from: query.from, to: query.to });
      await sendExport(ctx, res, query.format, {
        name: `finance-${query.from}-to-${query.to}`,
        title: 'Income and expenses',
        subtitle: `${query.from} to ${query.to}`,
        columns: [
          { key: 'month', header: 'Month', width: 1.3 },
          { key: 'feeCollections', header: 'Fee collections (PKR)', align: 'right', width: 1.6 },
          { key: 'otherIncome', header: 'Other income (PKR)', align: 'right', width: 1.5 },
          { key: 'expenses', header: 'Expenses (PKR)', align: 'right', width: 1.4 },
          { key: 'net', header: 'Net (PKR)', align: 'right', width: 1.4 },
        ],
        rows: r.monthly,
        totals: {
          month: 'Total',
          feeCollections: r.feeCollections,
          otherIncome: r.otherIncome,
          expenses: r.expenses,
          net: r.net,
        },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/admissions',
    tags,
    auth: 'school',
    permission: ['reports:read', 'admissions:read'],
    summary: 'Admissions funnel for a period (JSON, CSV or PDF)',
    description: 'The export lists the inquiries by stage, then by source, in one table (`Group` says which).',
    query: z.object({ from: isoDate().optional(), to: isoDate().optional() }).merge(format),
    response: z.any(),
    handler: async ({ ctx, query, res }) => {
      const r = await admissionsPipeline(ctx, { from: query.from, to: query.to });
      if (query.format === 'json') return r;
      await exportAudited(ctx, 'admissions', query.format, { from: query.from, to: query.to });
      const period = query.from || query.to ? `${query.from ?? 'start'} to ${query.to ?? 'today'}` : 'All time';
      await sendExport(ctx, res, query.format, {
        name: `admissions-${query.from ?? 'start'}-to-${query.to ?? 'today'}`,
        title: 'Admissions',
        subtitle: `${period} · ${r.total} inquiries · ${r.open} open · conversion ${r.conversionRate}%`,
        columns: [
          { key: 'group', header: 'Group', width: 1 },
          { key: 'item', header: 'Stage / source', width: 2 },
          { key: 'inquiries', header: 'Inquiries', align: 'right' },
          { key: 'admitted', header: 'Admitted', align: 'right' },
          { key: 'conversionRate', header: 'Conversion %', align: 'right', width: 1.2 },
        ],
        rows: [
          ...Object.entries(r.stages).map(([stage, count]) => ({
            group: 'Stage',
            item: words(stage),
            inquiries: count,
          })),
          ...[...r.bySource]
            .sort((a, b) => b.total - a.total)
            .map((s) => ({
              group: 'Source',
              item: words(String(s.source ?? 'unknown')),
              inquiries: s.total,
              admitted: s.admitted,
              conversionRate: s.conversionRate,
            })),
        ],
        totals: {
          group: 'Total',
          inquiries: r.total,
          admitted: r.stages.admitted ?? 0,
          conversionRate: r.conversionRate,
        },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/enrollment',
    tags,
    auth: 'school',
    permission: ['reports:read', 'students:read'],
    summary: 'Enrolment by class and section with gender split and capacity utilisation (JSON, CSV or PDF)',
    query: z.object({ sessionId: objectId().optional() }).merge(format),
    response: z.object({
      totals: z.object({ students: z.number(), male: z.number(), female: z.number(), other: z.number() }),
      sections: z.array(
        z.object({
          sectionId: objectId(),
          class: z.string(),
          section: z.string(),
          capacity: z.number(),
          enrolled: z.number(),
          male: z.number(),
          female: z.number(),
          utilisation: z.number().nullable(),
        }),
      ),
    }),
    handler: async ({ ctx, query, res }) => {
      const sFilter: Record<string, unknown> = scope(ctx, campusScope(ctx));
      if (query.sessionId) sFilter.sessionId = oid(query.sessionId);
      const [sections, counts] = await Promise.all([
        Section.find(sFilter).select('name capacity classId').populate('classId', 'name level').lean(),
        Student.aggregate([
          { $match: scope(ctx, { status: 'active', ...campusScope(ctx) }) },
          { $group: { _id: { sectionId: '$sectionId', gender: '$gender' }, count: { $sum: 1 } } },
        ]),
      ]);
      const by = new Map<string, Record<string, number>>();
      for (const c of counts) {
        const k = c._id.sectionId.toString();
        by.set(k, { ...(by.get(k) ?? {}), [c._id.gender]: c.count });
      }
      const rows = sections
        .map((s: any) => {
          const g = by.get(s._id.toString()) ?? {};
          const enrolled = (g.male ?? 0) + (g.female ?? 0) + (g.other ?? 0);
          return {
            sectionId: s._id,
            class: s.classId?.name ?? '',
            level: s.classId?.level ?? 0,
            section: s.name,
            capacity: s.capacity ?? 0,
            enrolled,
            male: g.male ?? 0,
            female: g.female ?? 0,
            utilisation: s.capacity ? Math.round((enrolled / s.capacity) * 1000) / 10 : null,
          };
        })
        .sort((a, b) => a.level - b.level || a.section.localeCompare(b.section));
      const totals = { students: 0, male: 0, female: 0, other: 0 };
      for (const c of counts) {
        totals.students += c.count;
        (totals as any)[c._id.gender] += c.count;
      }
      const sectionsOut = rows.map(({ level: _l, ...r }) => r);
      if (query.format === 'json') return { totals, sections: sectionsOut };
      await exportAudited(ctx, 'enrollment', query.format, { sessionId: query.sessionId ?? null });
      await sendExport(ctx, res, query.format, {
        name: 'enrolment',
        title: 'Enrolment by section',
        subtitle: `${totals.students} active students · ${totals.male} male · ${totals.female} female${totals.other ? ` · ${totals.other} other` : ''}`,
        columns: [
          { key: 'class', header: 'Class', width: 1.4 },
          { key: 'section', header: 'Section' },
          { key: 'enrolled', header: 'Enrolled', align: 'right' },
          { key: 'male', header: 'Male', align: 'right' },
          { key: 'female', header: 'Female', align: 'right' },
          { key: 'capacity', header: 'Capacity', align: 'right' },
          { key: 'utilisation', header: 'Seats filled %', align: 'right', width: 1.2 },
        ],
        rows: sectionsOut.map((r) => ({ ...r, capacity: r.capacity || '', utilisation: r.utilisation ?? '' })),
        totals: { class: 'Total', enrolled: totals.students, male: totals.male, female: totals.female },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/reports/exams/:id/analysis',
    tags,
    auth: 'school',
    permission: ['reports:read', 'exams:read'],
    summary: 'Exam analysis across all sections: pass rates and averages (JSON, CSV or PDF)',
    description:
      'The export has one row per section (Subject “All subjects”) followed by one row per subject of that section.',
    params: idParams,
    query: format,
    response: z.object({ exam: z.any(), sections: z.array(z.any()) }),
    handler: async ({ ctx, params, query, res }) => {
      const exam = await Exam.findOne(scope(ctx, { _id: oid(params.id) }))
        .select('name status classIds')
        .lean();
      if (!exam) {
        if (query.format !== 'json') throw notFound('Exam');
        return { exam: null, sections: [] };
      }
      const sections = await Section.find(scope(ctx, { classId: { $in: exam.classIds }, ...campusScope(ctx) }))
        .select('name classId')
        .populate('classId', 'name')
        .lean();
      const out = [];
      for (const s of sections) {
        const r = await sectionResults(ctx, params.id, s._id.toString());
        out.push({
          sectionId: s._id,
          section: `${(s.classId as any)?.name ?? ''} ${s.name}`.trim(),
          summary: r.summary,
          subjects: r.subjects,
        });
      }
      if (query.format === 'json')
        return { exam: { _id: exam._id, name: exam.name, status: exam.status }, sections: out };
      await exportAudited(ctx, 'exam-analysis', query.format, { examId: params.id });
      const pct = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : '');
      await sendExport(ctx, res, query.format, {
        name: `exam-analysis-${fileSafe(exam.name)}`,
        title: `Exam analysis: ${exam.name}`,
        subtitle: exam.status === 'published' ? 'Published results' : `Exam status: ${words(exam.status)}`,
        columns: [
          { key: 'section', header: 'Section', width: 1.6 },
          { key: 'subject', header: 'Subject', width: 1.8 },
          { key: 'students', header: 'Students', align: 'right' },
          { key: 'passed', header: 'Passed', align: 'right' },
          { key: 'passRate', header: 'Pass rate %', align: 'right', width: 1.1 },
          { key: 'average', header: 'Average %', align: 'right', width: 1.1 },
        ],
        rows: out.flatMap((s) => [
          {
            section: s.section,
            subject: 'All subjects',
            students: s.summary.students,
            passed: s.summary.passed,
            passRate: pct(s.summary.passRate),
            average: pct(s.summary.averagePercentage),
          },
          ...s.subjects.map((x: any) => ({
            section: s.section,
            subject: x.subject,
            passRate: pct(x.passRate),
            average: pct(x.averagePercent),
          })),
        ]),
      });
    },
  });
}

/** Exports need `reports:export` (as for the other reports) and are recorded in the audit log. */
async function exportAudited(
  ctx: Parameters<typeof audit>[0] & { permissions: ReadonlySet<string> },
  report: string,
  fmt: 'csv' | 'pdf',
  metadata: Record<string, unknown>,
) {
  if (!ctx.permissions.has('reports:export')) throw forbidden('You do not have permission to export reports');
  await audit(ctx, { action: 'report.export', metadata: { report, format: fmt, ...metadata } });
}

const words = (v: string) => v.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const fileSafe = (v: string) =>
  v
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'exam';
