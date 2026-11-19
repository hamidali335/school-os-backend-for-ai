import { connectorLimiter } from '../../middleware/rate-limit';
import type { Api } from '../../utils/api';
import { idParams, isoDate, objectId, paginationQuery, queryBool, z } from '../../utils/zod';
import { toCsv } from '../../utils/csv';
import { ImportJobRes } from '../imports/imports.routes';
import { INTEGRATION_METHODS, listIntegrations } from './adapters/registry';
import { DEVICE_STATUSES, PUNCH_TYPES, STAFF_ATTENDANCE_STATUSES } from './biometric.models';
import * as svc from './biometric.service';
import * as undo from './import-undo';
import * as staff from './staff-attendance.service';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { importUploadLimiter } from '../../middleware/rate-limit';
import { badRequest } from '../../utils/errors';
import { previewUpload, saveUpload } from './attendance-upload';

/** An attendance file is read in memory only (never stored), at most 5 MB. */
const readAttendanceFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
}).single('file');
const attendanceUpload: RequestHandler = (req, res, next) =>
  importUploadLimiter(req, res, (err?: unknown) => (err ? next(err) : readAttendanceFile(req, res, next)));
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');

const tags = ['Staff attendance'];

const Integration = z
  .object({
    method: z.enum(INTEGRATION_METHODS),
    label: z.string(),
    status: z.enum(['implemented', 'planned']),
    usable: z.boolean(),
    description: z.string(),
    steps: z.array(z.string()),
  })
  .openapi('BiometricIntegration');

const Device = z
  .object({
    _id: objectId(),
    name: z.string(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
    serialNumber: z.string().optional(),
    location: z.string().optional(),
    campusId: z.string().nullable().optional(),
    integration: z.enum(INTEGRATION_METHODS),
    integrationInfo: Integration,
    status: z.enum(DEVICE_STATUSES),
    connectorKeyHint: z.string().optional(),
    connectorKeyCreatedAt: z.string().optional(),
    lastEventAt: z.string().optional(),
    lastSyncAt: z.string().optional(),
    lastSyncResult: z.string().optional(),
    punches: z.number().optional(),
    unlinkedPunches: z.number().optional(),
  })
  .openapi('BiometricDevice');

const DeviceBody = z.object({
  name: z.string().trim().min(1).max(80),
  manufacturer: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  serialNumber: z.string().trim().max(60).optional(),
  location: z.string().trim().max(120).optional(),
  campusId: objectId().nullable().optional(),
  integration: z.enum(INTEGRATION_METHODS),
});

const Ref = z.object({ _id: objectId() }).passthrough();
const Link = z
  .object({
    _id: objectId(),
    deviceId: z.union([Ref, z.null()]),
    deviceUserId: z.string(),
    employeeId: Ref,
  })
  .openapi('DeviceUserLink');

const UnlinkedUser = z
  .object({
    deviceId: objectId(),
    deviceName: z.string(),
    deviceUserId: z.string(),
    punches: z.number(),
    first: z.string(),
    last: z.string(),
    suggestion: z
      .object({ employeeId: objectId(), name: z.string(), employeeNo: z.string(), reason: z.string() })
      .nullable(),
  })
  .openapi('UnlinkedDeviceUser');

const Punch = z
  .object({
    _id: objectId(),
    deviceId: z.unknown(),
    deviceUserId: z.string(),
    employeeId: z.unknown().nullable(),
    punchedAt: z.string(),
    localDate: z.string(),
    punchType: z.enum(PUNCH_TYPES),
    rawType: z.string().optional(),
    source: z.enum(['file', 'connector']),
    importJobId: z.string().optional(),
  })
  .openapi('PunchEvent');

const StaffDay = z
  .object({
    _id: objectId(),
    employeeId: z.unknown(),
    date: z.string(),
    status: z.enum(STAFF_ATTENDANCE_STATUSES),
    source: z.enum(['biometric', 'manual']),
    note: z.string().optional(),
    times: z.object({ in: z.string().optional(), out: z.string().optional() }).optional(),
    markedAt: z.string().optional(),
    punches: z.object({
      count: z.number(),
      first: z.string().optional(),
      last: z.string().optional(),
      in: z.number(),
      out: z.number(),
    }),
    conflict: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
  })
  .openapi('StaffAttendanceDay');

export function registerBiometricRoutes(api: Api) {
  /* ───────── Integrations and devices ───────── */

  api.route({
    method: 'get',
    path: '/biometric/integrations',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Ways to get attendance from fingerprint machines, and which are available now',
    description: 'Only `implemented` methods can be used. Planned ones list what is needed to build them.',
    response: z.array(Integration),
    handler: () => listIntegrations(),
  });

  api.route({
    method: 'get',
    path: '/biometric/devices',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Registered fingerprint machines, with their punch counts',
    response: z.array(Device),
    handler: ({ ctx }) => svc.listDevices(ctx),
  });

  api.route({
    method: 'post',
    path: '/biometric/devices',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Register a fingerprint machine',
    description: 'Only implemented integration methods are accepted (`INTEGRATION_NOT_AVAILABLE` otherwise).',
    body: DeviceBody,
    response: Device,
    status: 201,
    handler: ({ ctx, body }) => svc.createDevice(ctx, body),
  });

  api.route({
    method: 'patch',
    path: '/biometric/devices/:id',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Change or disable a device',
    params: idParams,
    body: DeviceBody.partial().extend({ status: z.enum(DEVICE_STATUSES).optional() }),
    response: Device,
    handler: ({ ctx, params, body }) => svc.updateDevice(ctx, params.id, body),
  });

  api.route({
    method: 'delete',
    path: '/biometric/devices/:id',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Remove a device that has no punches (otherwise disable it: `DEVICE_HAS_PUNCHES`)',
    params: idParams,
    status: 204,
    handler: ({ ctx, params }) => svc.deleteDevice(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/biometric/devices/:id/status',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'What can truthfully be said about the device’s connection',
    description:
      'File-import devices are never contacted (`not_applicable`). Connector devices report when punches last arrived. Nothing reports success without evidence.',
    params: idParams,
    response: z.object({
      state: z.enum(['not_applicable', 'not_configured', 'waiting', 'received', 'unavailable']),
      message: z.string(),
      lastEventAt: z.string().nullable(),
    }),
    handler: ({ ctx, params }) => svc.deviceStatus(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/biometric/devices/:id/connector-key',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Create (or replace) the connector key of a Connector API device; shown once',
    params: idParams,
    response: z.object({ key: z.string(), hint: z.string() }),
    status: 201,
    handler: ({ ctx, params }) => svc.createConnectorKey(ctx, params.id),
  });

  api.route({
    method: 'delete',
    path: '/biometric/devices/:id/connector-key',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Revoke the connector key (the connector can no longer send punches)',
    params: idParams,
    status: 204,
    handler: ({ ctx, params }) => svc.revokeConnectorKey(ctx, params.id),
  });

  /* ───────── Device users ───────── */

  api.route({
    method: 'get',
    path: '/biometric/links',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Links from device user IDs to staff members',
    response: z.array(Link),
    handler: ({ ctx }) => svc.listLinks(ctx),
  });

  api.route({
    method: 'post',
    path: '/biometric/links',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Link a device user ID to a staff member (one device, or every device when deviceId is null)',
    description:
      'Punches already waiting for this device user are linked and their days worked out. Never matched by name.',
    body: z.object({
      deviceId: objectId().nullable().optional(),
      deviceUserId: z.string().trim().min(1).max(40),
      employeeId: objectId(),
    }),
    response: z.object({ link: Link.partial(), punchesLinked: z.number() }),
    status: 201,
    handler: ({ ctx, body }) => svc.linkDeviceUser(ctx, body),
  });

  api.route({
    method: 'delete',
    path: '/biometric/links/:id',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Remove a link (its punches wait again; days made only from them are removed)',
    params: idParams,
    response: z.object({ punchesChanged: z.number() }),
    handler: ({ ctx, params }) => svc.unlinkDeviceUser(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/biometric/unlinked',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Device users with punches but no staff link, with a suggestion when the ID equals an Employee No',
    response: z.array(UnlinkedUser),
    handler: ({ ctx }) => svc.unlinkedDeviceUsers(ctx),
  });

  api.route({
    method: 'get',
    path: '/biometric/punches',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Raw punches as the machines recorded them',
    query: paginationQuery.extend({
      date: isoDate().optional(),
      employeeId: objectId().optional(),
      deviceId: objectId().optional(),
      unlinked: queryBool(),
    }),
    response: Punch,
    paginated: true,
    handler: ({ ctx, query }) => svc.listPunches(ctx, query),
  });

  /* ───────── Undoing an import ───────── */

  api.route({
    method: 'get',
    path: '/biometric/imports/:id/undo',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'What undoing a punch import would do (changes nothing)',
    description:
      'For the confirmation: punches removed, punches kept because another import or the connector also delivered them, staff and days affected, hand-made marks kept. `canUndo` false with `blockedReason` when it cannot be undone (already undone, still running, or punches of a campus you do not have access to).',
    params: idParams,
    response: z.object({
      import: z.object({
        _id: objectId(),
        fileName: z.string(),
        status: z.string(),
        createdByName: z.string(),
        finishedAt: z.string().nullable(),
        deviceName: z.string().nullable(),
        dateOrder: z.string().nullable(),
        timeZone: z.string().nullable(),
      }),
      canUndo: z.boolean(),
      blockedReason: z.string().nullable(),
      punches: z.object({
        total: z.number(),
        removed: z.number(),
        keptForOtherImports: z.number(),
        keptForConnector: z.number(),
        unlinkedRemoved: z.number(),
      }),
      staff: z.object({ count: z.number(), names: z.array(z.string()) }),
      days: z.object({
        affected: z.number(),
        updated: z.number(),
        becomeNotRecorded: z.number(),
        markedKept: z.number(),
        flagsCleared: z.number(),
        resolvedByPersonLosePunches: z.number(),
      }),
      noResume: z.boolean(),
    }),
    handler: ({ ctx, params }) => undo.undoImportPreview(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/biometric/imports/:id/undo',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Undo a punch import: remove its punches and work the affected days out again',
    description:
      'Requires `confirm: true`. Only the punches this import stored are removed (a punch another import or the connector also delivered is kept); hand-made marks stay. Runs in the background: poll GET /imports/{id} until `undo.status` is `completed` (or `failed`: undo again to finish). ' +
      '`IMPORT_ALREADY_UNDONE`, `UNDO_IN_PROGRESS`, `IMPORT_STATE` (still running), `CAMPUS_FORBIDDEN`, `PUNCH_IMPORT_BUSY` (a staff punch import is running, or another import is being undone: one at a time per school). An undone import cannot be run or resumed again.',
    params: idParams,
    body: z.object({ confirm: z.literal(true) }),
    response: ImportJobRes,
    status: 202,
    handler: ({ ctx, params }) => undo.undoImport(ctx, params.id),
  });

  /* ───────── Connector API ───────── */

  api.route({
    method: 'post',
    path: '/biometric/ingest',
    tags,
    auth: 'public',
    middleware: [connectorLimiter],
    summary: 'Connector API: send punches from a school’s local connector',
    description:
      'Authenticate with the device’s connector key: `Authorization: Bearer sbk_…`. Up to 1,000 punches per request; timestamps must include their time zone. ' +
      'Each punch is stored once (sending it again is counted as a duplicate). Rejected punches are listed with the reason; the others are stored.',
    body: z.object({
      punches: z
        .array(
          z.object({
            deviceUserId: z.string().trim().min(1).max(40),
            timestamp: z.string().trim().min(10).max(40).openapi({ example: '2026-10-24T08:01:33+05:00' }),
            punchType: z.string().trim().max(30).optional(),
          }),
        )
        .min(1)
        .max(1000),
    }),
    response: z.object({
      stored: z.number(),
      duplicates: z.number(),
      linked: z.number(),
      rejected: z.array(z.object({ index: z.number(), reason: z.string() })),
    }),
    handler: ({ req, body }) => svc.ingestPunches(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], body),
  });

  /* ───────── Staff daily attendance ───────── */

  api.route({
    method: 'get',
    path: '/staff-attendance',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'One day of staff attendance: every current staff member with their record (or none)',
    description:
      'A staff member without punches and without a mark has no record ("not recorded"); they are never assumed absent.',
    query: z.object({ date: isoDate(), campusId: objectId().optional() }),
    response: z.object({
      date: z.string(),
      totals: z.object({
        staff: z.number(),
        present: z.number(),
        late: z.number(),
        halfDay: z.number(),
        absent: z.number(),
        leave: z.number(),
        notRecorded: z.number(),
        conflicts: z.number(),
      }),
      rows: z.array(
        z.object({
          employee: z.object({
            _id: objectId(),
            name: z.string(),
            employeeNo: z.string(),
            designation: z.string(),
            status: z.string(),
          }),
          record: StaffDay.nullable(),
        }),
      ),
    }),
    handler: ({ ctx, query }) => staff.staffDay(ctx, query),
  });

  const ReportQuery = z.object({
    from: isoDate(),
    to: isoDate(),
    employeeId: objectId().optional(),
    department: z.string().trim().max(80).optional(),
    status: z
      .enum(STAFF_ATTENDANCE_STATUSES)
      .optional()
      .openapi({ description: 'Only staff with at least one such day' }),
  });
  const ReportRow = z.object({
    employeeId: objectId(),
    name: z.string(),
    employeeNo: z.string(),
    designation: z.string(),
    department: z.string(),
    present: z.number(),
    late: z.number(),
    halfDay: z.number(),
    absent: z.number(),
    leave: z.number(),
    notRecorded: z.number(),
    attendancePercent: z.number().nullable(),
  });

  api.route({
    method: 'get',
    path: '/staff-attendance/report',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Staff attendance for a date range (at most 366 days): days per status and attendance %',
    description:
      'Attendance % = (present + late + half days ÷ 2) ÷ days with a record; days nobody marked are counted as not recorded, never as absent. Staff of your campuses only; no salary or CNIC.',
    query: ReportQuery,
    response: z.object({
      from: z.string(),
      to: z.string(),
      days: z.number(),
      totals: z.object({
        staff: z.number(),
        present: z.number(),
        late: z.number(),
        halfDay: z.number(),
        absent: z.number(),
        leave: z.number(),
        notRecorded: z.number(),
      }),
      rows: z.array(ReportRow),
    }),
    handler: ({ ctx, query }) => staff.staffAttendanceReport(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/staff-attendance/report.csv',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'The same report as a CSV file (exactly the filtered rows)',
    query: ReportQuery,
    produces: 'text/csv',
    handler: async ({ ctx, query, res }) => {
      const r = await staff.staffAttendanceReport(ctx, query);
      const csv = toCsv(
        [
          { key: 'employeeNo', header: 'Employee No' },
          { key: 'name', header: 'Name' },
          { key: 'designation', header: 'Designation' },
          { key: 'department', header: 'Department' },
          { key: 'present', header: 'Present' },
          { key: 'late', header: 'Late' },
          { key: 'halfDay', header: 'Half day' },
          { key: 'absent', header: 'Absent' },
          { key: 'leave', header: 'Leave' },
          { key: 'notRecorded', header: 'Not recorded' },
          { key: 'attendancePercent', header: 'Attendance %' },
        ],
        r.rows,
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="staff-attendance-' + query.from + '-to-' + query.to + '.csv"',
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(csv);
    },
  });

  api.route({
    method: 'put',
    path: '/staff-attendance',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Mark a staff member’s day by hand (punches never overwrite it)',
    body: z.object({
      employeeId: objectId(),
      date: isoDate(),
      status: z.enum(STAFF_ATTENDANCE_STATUSES),
      note: z.string().trim().max(300).optional(),
    }),
    response: StaffDay.nullable(),
    handler: ({ ctx, body }) => staff.markStaffDay(ctx, body),
  });

  api.route({
    method: 'delete',
    path: '/staff-attendance/:employeeId/:date',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Remove a hand-made mark: the day goes back to what the punches say',
    params: z.object({ employeeId: objectId(), date: isoDate() }),
    response: StaffDay.nullable(),
    handler: ({ ctx, params }) => staff.clearStaffMark(ctx, params.employeeId, params.date),
  });

  api.route({
    method: 'post',
    path: '/staff-attendance/repair',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Work staff days out again from the stored punches (a date range, at most 62 days)',
    description:
      'For days whose summary is out of date. The same rules as always: hand-made marks and “keep the mark” decisions stay; conflicts are raised or cleared as the punches say. Only staff of your campuses. Safe to repeat. Returns how many days were checked and how many changed.',
    body: z.object({ from: isoDate(), to: isoDate(), employeeId: objectId().optional() }),
    response: z.object({ from: z.string(), to: z.string(), checked: z.number(), repaired: z.number() }),
    handler: ({ ctx, body }) => staff.repairStaffDays(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/staff-attendance/upload/preview',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Read an attendance file (Excel, CSV or PDF) and show what would be saved; nothing is saved',
    description:
      'multipart/form-data: `file`, optional `month` (YYYY-MM, for a monthly register), `dateOrder` (dmy|mdy for dates like 03/04/2026), `lateAfter` (HH:mm). ' +
      'Recognises a machine log (one row per punch), a daily sheet (date + status/time in/out) or a monthly P/A/L register. Staff are found by a remembered match, the employee number or the name.',
    upload: {
      middleware: attendanceUpload,
      field: 'file',
      extraFields: z.object({
        month: z.string().optional(),
        dateOrder: z.string().optional(),
        lateAfter: z.string().optional(),
      }),
    },
    response: z.any(),
    handler: async ({ ctx, req }) => {
      if (!req.file) throw badRequest('Choose a file to upload', { field: 'file' });
      const opts = z
        .object({
          month: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
            .optional(),
          dateOrder: z.enum(['dmy', 'mdy']).optional(),
          lateAfter: hhmm.optional(),
        })
        .safeParse(Object.fromEntries(Object.entries(req.body ?? {}).filter(([, v]) => v !== '')));
      if (!opts.success)
        throw badRequest(opts.error.issues[0]?.message ?? 'Invalid options', {
          field: String(opts.error.issues[0]?.path[0] ?? ''),
        });
      return previewUpload(ctx, req.file, opts.data);
    },
  });

  api.route({
    method: 'post',
    path: '/staff-attendance/upload/save',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Save the days of a previewed attendance file (each day checked again)',
    description:
      'Each day is marked by hand (machine punches never overwrite it). Refused per day: staff outside your campuses, future dates, off days, the same day twice. ' +
      '`links` remembers which staff member a name/ID in the file is, for the next upload.',
    body: z.object({
      fileName: z.string().trim().min(1).max(200),
      entries: z
        .array(
          z.object({
            employeeId: objectId(),
            date: isoDate(),
            status: z.enum(STAFF_ATTENDANCE_STATUSES),
            in: hhmm.optional(),
            out: hhmm.optional(),
          }),
        )
        .min(1)
        .max(10_000),
      links: z
        .array(z.object({ key: z.string().min(3).max(200), employeeId: objectId() }))
        .max(2000)
        .optional(),
    }),
    response: z.object({
      saved: z.number(),
      created: z.number(),
      updated: z.number(),
      refused: z.array(z.object({ employeeId: z.string(), date: z.string(), reason: z.string() })),
    }),
    handler: ({ ctx, body }) => saveUpload(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/staff-attendance/conflicts',
    tags,
    auth: 'school',
    permission: 'employees:read',
    summary: 'Days where a mark and the punches disagree, for a person to decide',
    response: z.array(StaffDay),
    handler: ({ ctx }) => staff.staffConflicts(ctx),
  });

  api.route({
    method: 'post',
    path: '/staff-attendance/:id/resolve',
    tags,
    auth: 'school',
    permission: 'employees:manage',
    summary: 'Decide a flagged day: keep the mark, or use the punches (present)',
    params: idParams,
    body: z.object({ action: z.enum(['keep_mark', 'use_punches']) }),
    response: StaffDay.nullable(),
    handler: ({ ctx, params, body }) => staff.resolveStaffConflict(ctx, params.id, body.action),
  });
}
