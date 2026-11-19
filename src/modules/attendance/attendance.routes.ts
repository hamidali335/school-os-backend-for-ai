import type { Api } from '../../utils/api';
import { forbidden } from '../../utils/errors';
import { idParams, isoDate, objectId, queryBool, z } from '../../utils/zod';
import { teacherSectionIds } from '../academics/access.service';
import { ATTENDANCE_STATUSES, REGISTER_STATES } from './attendance.model';
import * as svc from './attendance.service';

const Counts = z
  .object({
    present: z.number(),
    absent: z.number(),
    late: z.number(),
    leave: z.number(),
    excused: z.number(),
    total: z.number(),
    rate: z
      .number()
      .nullable()
      .openapi({ description: '(present + late) / (present + late + absent) × 100; leave/excused excluded' }),
  })
  .openapi('AttendanceCounts');

const range = z
  .object({ from: isoDate(), to: isoDate() })
  .refine((v) => v.from <= v.to, { message: 'from must be on or before to', path: ['to'] });

export function registerAttendanceRoutes(api: Api) {
  const tags = ['Attendance'];

  api.route({
    method: 'get',
    path: '/attendance/sections/:id',
    tags,
    auth: 'school',
    permission: 'attendance:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff', 'teacher'],
    summary: 'Section roster for a date with current marks (for the marking screen)',
    params: idParams,
    query: z.object({ date: isoDate() }),
    response: z.object({
      sectionId: objectId(),
      date: z.string(),
      marked: z.boolean(),
      state: z.enum(REGISTER_STATES).openapi({
        description:
          'not_started: nobody marked; draft: saved but someone is unmarked or it is not finalized; complete: finalized',
      }),
      missingCount: z.number().openapi({ description: 'Active students with no status saved for this date' }),
      finalizedAt: z.string().nullable(),
      summary: Counts,
      students: z.array(
        z.object({
          studentId: objectId(),
          name: z.string(),
          admissionNo: z.string(),
          rollNo: z.string().optional(),
          status: z.enum(ATTENDANCE_STATUSES).nullable(),
          remarks: z.string().nullable(),
          onApprovedLeave: z.boolean().openapi({
            description: 'An administrator approved leave covering this date (a hint; nothing is marked automatically)',
          }),
        }),
      ),
    }),
    handler: ({ ctx, params, query }) => svc.sectionRoster(ctx, params.id, query.date),
  });

  api.route({
    method: 'post',
    path: '/attendance/mark',
    tags,
    auth: 'school',
    permission: 'attendance:mark',
    summary: 'Mark (or correct) attendance for a section on a date',
    description:
      'Upserts one record per student and date. Teachers can only mark their own sections and only within 7 days; older corrections need `attendance:manage`. ' +
      'Drafts: send only the students marked so far with finalize=false. finalize=true saves the entries and then refuses (422 ATTENDANCE_INCOMPLETE, with the list of unmarked students in error.details.missing) while any active student has no status; nothing is ever marked automatically. ' +
      'Without finalize (older clients) the register is finalized automatically once every student has a status. ' +
      'With `notifyParents`, parents of absent students receive an in-app notification (external SMS/WhatsApp alerts run through automations).',
    body: z.object({
      sectionId: objectId(),
      date: isoDate(),
      records: z
        .array(
          z.object({
            studentId: objectId(),
            status: z.enum(ATTENDANCE_STATUSES),
            remarks: z.string().trim().max(200).optional(),
          }),
        )
        .min(1)
        .max(200),
      notifyParents: z.boolean().optional(),
      finalize: z.boolean().optional(),
    }),
    response: z.object({
      sectionId: objectId(),
      date: z.string(),
      saved: z.number(),
      summary: Counts,
      parentsNotified: z.number(),
      finalized: z.boolean(),
      state: z.enum(REGISTER_STATES),
      missingCount: z.number(),
      missing: z.array(
        z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string(), rollNo: z.string().nullable() }),
      ),
    }),
    handler: ({ ctx, body }) => svc.markSection(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/attendance/students/:id',
    tags,
    auth: 'school',
    permission: 'attendance:read',
    summary: "A student's attendance history and summary",
    description: 'Parents/students may only query their own linked students (others return 404).',
    params: idParams,
    query: range,
    response: z.object({
      student: z.object({ _id: objectId(), name: z.string(), admissionNo: z.string() }),
      from: z.string(),
      to: z.string(),
      summary: Counts,
      currentAbsenceStreak: z.number(),
      records: z.array(
        z.object({ date: z.string(), status: z.enum(ATTENDANCE_STATUSES), remarks: z.string().optional() }),
      ),
    }),
    handler: ({ ctx, params, query }) => svc.studentAttendance(ctx, params.id, query.from, query.to),
  });

  api.route({
    method: 'get',
    path: '/attendance/daily',
    tags,
    auth: 'school',
    permission: 'attendance:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff'],
    summary: 'Daily attendance overview across sections (marked vs unmarked, rates)',
    query: z.object({ date: isoDate().optional() }),
    response: z.object({
      date: z.string(),
      overall: Counts,
      sectionsMarked: z.number(),
      sectionsTotal: z.number(),
      unmarkedSections: z.array(z.object({ sectionId: objectId(), section: z.string() })),
      incompleteSections: z.array(z.object({ sectionId: objectId(), section: z.string(), missing: z.number() })),
      sections: z.array(
        z.object({
          sectionId: objectId(),
          section: z.string(),
          enrolled: z.number(),
          marked: z.boolean(),
          state: z.enum(REGISTER_STATES),
          missing: z.number(),
          counts: Counts.nullable(),
        }),
      ),
    }),
    handler: ({ ctx, query }) => svc.dailySummary(ctx, query.date),
  });

  api.route({
    method: 'get',
    path: '/attendance/report',
    tags,
    auth: 'school',
    permission: 'attendance:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff', 'teacher'],
    summary: 'Attendance report: per-student rates, daily trend, low-attendance list',
    description: 'Teachers must filter by one of their own sections.',
    query: z
      .object({
        from: isoDate(),
        to: isoDate(),
        classId: objectId().optional(),
        sectionId: objectId().optional(),
        belowThreshold: queryBool(),
      })
      .refine((v) => v.from <= v.to, { message: 'from must be on or before to', path: ['to'] }),
    response: z.object({
      from: z.string(),
      to: z.string(),
      threshold: z.number(),
      overall: Counts,
      belowThresholdCount: z.number(),
      trend: z.array(z.object({ date: z.string(), rate: z.number().nullable() })),
      students: z.array(
        Counts.extend({ studentId: objectId(), name: z.string(), admissionNo: z.string(), sectionId: objectId() }),
      ),
    }),
    handler: async ({ ctx, query }) => {
      if (ctx.role === 'teacher' && (!query.sectionId || !(await teacherSectionIds(ctx)).includes(query.sectionId))) {
        throw forbidden('Teachers must specify one of their own sections');
      }
      return svc.attendanceReport(ctx, query);
    },
  });

  api.route({
    method: 'get',
    path: '/attendance/chronic-absentees',
    tags,
    auth: 'school',
    permission: 'attendance:read',
    roles: ['school_owner', 'principal', 'school_admin', 'staff'],
    summary: 'Students with consecutive absences at or above the school alert threshold',
    query: z.object({ minStreak: z.coerce.number().int().min(1).max(30).optional() }),
    response: z.array(
      z.object({
        studentId: objectId(),
        name: z.string(),
        admissionNo: z.string(),
        sectionId: objectId(),
        consecutiveAbsences: z.number(),
      }),
    ),
    handler: ({ ctx, query }) => svc.chronicAbsentees(ctx, query.minStreak),
  });
}
