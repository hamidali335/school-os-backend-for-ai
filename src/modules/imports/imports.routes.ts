import type { RequestHandler } from 'express';
import multer from 'multer';
import { importUploadLimiter } from '../../middleware/rate-limit';
import type { Api } from '../../utils/api';
import { badRequest } from '../../utils/errors';
import { idParams, paginationQuery, z } from '../../utils/zod';
import { IMPORT_TYPES, type ImportType } from './import-fields';
import { IMPORT_LIMITS } from './import-files';
import { IMPORT_STATUSES } from './import.models';
import { templateCsv, templateXlsx } from './import-templates';
import * as svc from './imports.service';

/** Files stay in memory only while they are read; they are never written to disk or storage. */
const readUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_LIMITS.maxBytes, files: 1, fields: 4 },
}).single('file');

/** Per-user upload limit first (after sign-in), then the upload itself. */
const importUpload: RequestHandler = (req, res, next) =>
  importUploadLimiter(req, res, (err?: unknown) => (err ? next(err) : readUpload(req, res, next)));

const TypeEnum = z.enum(IMPORT_TYPES);
const Counts = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  failed: z.number(),
  breakdown: z.record(z.string(), z.number()).optional().openapi({
    description:
      'Students: the added students as saved, by status, read back when the import ended (`active`, `left`, `graduated`, `suspended`; `notFound` if an added record no longer exists). Only Active students count as active students.',
  }),
});
const Options = z.object({
  mode: z.enum(['create', 'upsert']),
  campusId: z.string().optional(),
  sessionId: z.string().optional(),
  sectionName: z.string().optional(),
  skipPossibleDuplicates: z.boolean(),
  createLogins: z.boolean(),
  deviceId: z.string().optional().openapi({ description: 'Staff attendance punches: the device the file comes from' }),
  dateOrder: z.enum(['auto', 'dmy', 'mdy']).optional().openapi({
    description: 'Staff attendance punches: day/month order of dates like 03/04/2026 (auto: decided from the file)',
  }),
  feeHeadId: z.string().optional().openapi({ description: 'Fee import: the monthly fee head Monthly Fee sets' }),
  duesUpTo: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
    .optional()
    .openapi({ description: 'Fee import: the month (YYYY-MM) Previous Dues are up to' }),
});
const Summary = z.object({
  total: z.number(),
  create: z.number(),
  update: z.number(),
  unchanged: z.number(),
  exists: z.number(),
  duplicate: z.number(),
  invalid: z.number(),
  withWarnings: z.number(),
  periods: z
    .number()
    .optional()
    .openapi({ description: 'Timetable: how many periods the rows add or change (one row can cover several days)' }),
  ignoredColumns: z.array(z.string()),
  statusBreakdown: z
    .record(z.string(), z.number())
    .optional()
    .openapi({ description: 'Students: rows to add by the status they will be saved with' }),
  datePreview: z
    .object({
      timeZone: z.string(),
      order: z.enum(['dmy', 'mdy']).nullable(),
      orderSource: z.enum(['chosen', 'detected', 'none']),
      ambiguousRows: z.number(),
      overriddenRows: z.number(),
      examples: z.array(
        z.object({
          rowNo: z.number(),
          original: z.string(),
          interpreted: z.string(),
          localDate: z.string(),
          at: z.string(),
          readAs: z.enum(['dmy', 'mdy', 'ymd', 'zoned']),
          ambiguous: z.boolean(),
          overridden: z.boolean(),
        }),
      ),
    })
    .optional()
    .openapi({
      description:
        'Staff attendance punches: how the dates and times of the file are read (the same reading the import uses), with examples',
    }),
});
export const ImportJobRes = z
  .object({
    _id: z.string(),
    type: TypeEnum,
    status: z.enum(IMPORT_STATUSES),
    fileName: z.string(),
    fileKind: z.enum(['xlsx', 'csv']),
    sheetName: z.string().nullable(),
    headerRow: z.number(),
    headers: z.array(z.string()),
    notes: z.array(z.string()),
    mapping: z.array(z.object({ column: z.number(), header: z.string(), field: z.string().nullable() })),
    options: Options,
    totalRows: z.number(),
    summary: Summary.nullable(),
    warnings: z.array(z.string()),
    result: Counts,
    progress: z.object({ processed: z.number(), total: z.number() }),
    createdByName: z.string(),
    createdAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
    rowsAvailable: z.boolean(),
    canResume: z
      .boolean()
      .openapi({ description: 'Interrupted and its rows are still kept: POST /imports/{id}/run resumes it' }),
    rowsExpireAt: z.string(),
    undo: z
      .object({
        status: z.enum(['running', 'completed', 'failed']),
        byName: z.string().nullable(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
        removed: z.number(),
        keptForOtherImports: z.number(),
        keptForConnector: z.number(),
        daysRecalculated: z.number(),
        error: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: 'Staff attendance punches: the import was undone (POST /biometric/imports/{id}/undo)' }),
  })
  .openapi('ImportJob');

export function registerImportRoutes(api: Api) {
  const tags = ['Data import'];

  api.route({
    method: 'get',
    path: '/imports/types',
    tags,
    auth: 'school',
    summary: 'What can be imported, its fields, and whether you may import it',
    response: z.array(
      z.object({
        type: TypeEnum,
        label: z.string(),
        description: z.string(),
        identifier: z.string(),
        allowed: z.boolean(),
        oneOf: z.array(z.array(z.string())),
        fields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            required: z.boolean(),
            description: z.string(),
            example: z.string(),
            inTemplate: z.boolean(),
          }),
        ),
      }),
    ),
    handler: ({ ctx }) => svc.importTypes(ctx),
  });

  api.route({
    method: 'get',
    path: '/imports/templates/:type',
    tags,
    auth: 'school',
    summary: 'Download an import template (Excel with instructions and dropdowns, or CSV)',
    params: z.object({ type: TypeEnum }),
    query: z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }),
    produces: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    handler: async ({ params, query, res }) => {
      const name = `school-os-${params.type}-template`;
      if (query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
        res.send(templateCsv(params.type));
        return;
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
      res.send(await templateXlsx(params.type));
    },
  });

  api.route({
    method: 'post',
    path: '/imports',
    tags,
    auth: 'school',
    summary: 'Step 1: upload a file (.xlsx or .csv) and get suggested column matches',
    description:
      'multipart/form-data with `file` and `type`. The content is checked (not just the name): old .xls, macro workbooks, damaged or oversized files are refused. ' +
      `At most ${IMPORT_LIMITS.maxRows} rows, ${IMPORT_LIMITS.maxColumns} columns, 5 MB. Nothing is imported in this step. ` +
      'The file is not stored; its cells are kept for the preview and report for 7 days. Requires the same permission as adding the records by hand.',
    upload: { middleware: importUpload, field: 'file', extraFields: z.object({ type: TypeEnum }) },
    response: z.object({
      job: ImportJobRes,
      columns: z.array(
        z.object({
          column: z.number(),
          header: z.string(),
          field: z.string().nullable(),
          source: z.enum(['remembered', 'exact', 'likely']).optional(),
          ignoredReason: z.string().optional(),
          samples: z.array(z.string()),
        }),
      ),
    }),
    status: 201,
    handler: async ({ ctx, req }) => {
      const type = TypeEnum.safeParse(req.body?.type);
      if (!type.success) throw badRequest('Choose what to import', { field: 'type' });
      if (!req.file) throw badRequest('Choose a file to upload', { field: 'file' });
      return svc.analyzeFile(ctx, type.data as ImportType, req.file);
    },
  });

  api.route({
    method: 'get',
    path: '/imports',
    tags,
    auth: 'school',
    summary: 'Import history (imports of the kinds you may import)',
    query: paginationQuery,
    response: ImportJobRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listImports(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/imports/:id',
    tags,
    auth: 'school',
    summary: 'One import with its status, progress and results',
    params: idParams,
    response: ImportJobRes,
    handler: ({ ctx, params }) => svc.getImport(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/imports/:id/check',
    tags,
    auth: 'school',
    summary:
      'Step 2: check every row with the chosen column matches and options (runs in the background; poll GET /imports/{id})',
    description:
      'Saves the column matches and options and starts checking: the job becomes `checking`, then `validated` with the summary ' +
      '(or `analyzed` with `error` if checking failed or stopped). The check results are saved with the import; no students, ' +
      'parents, staff or logins are created or changed. `summary` is null in this response. Repeating the request for the same ' +
      'columns and options while checking returns the running check; other columns give `IMPORT_CHECKING`. ' +
      '`IMPORT_REQUIRED_COLUMNS` lists required fields without a column. Row details: `GET /imports/{id}/rows`.',
    params: idParams,
    body: z.object({
      mapping: z
        .array(z.object({ column: z.number().int().min(0), field: z.string().max(40).nullable() }))
        .max(IMPORT_LIMITS.maxColumns),
      options: Options.partial().optional(),
    }),
    response: z.object({ job: ImportJobRes, summary: Summary.nullable(), warnings: z.array(z.string()) }),
    handler: ({ ctx, params, body }) => svc.checkImport(ctx, params.id, body),
  });

  api.route({
    method: 'get',
    path: '/imports/:id/rows',
    tags,
    auth: 'school',
    summary: 'Rows of an import with their check result, problems and (after the import) outcome',
    params: idParams,
    query: paginationQuery.extend({
      filter: z.enum(['all', 'problems', 'warnings', 'ready', 'skipped', 'imported']).default('all'),
    }),
    response: z.object({
      rowNo: z.number(),
      check: z.string().nullable(),
      result: z.string().nullable(),
      resultMessage: z.string().nullable(),
      issues: z.array(
        z.object({ level: z.enum(['error', 'warning', 'info']), field: z.string().nullable(), message: z.string() }),
      ),
      changes: z.array(z.object({ field: z.string(), from: z.string(), to: z.string() })),
      values: z.record(z.string(), z.string()),
    }),
    paginated: true,
    handler: ({ ctx, params, query }) => svc.listImportRows(ctx, params.id, query),
  });

  api.route({
    method: 'post',
    path: '/imports/:id/run',
    tags,
    auth: 'school',
    summary: 'Step 3: import the checked rows (runs in the background; poll GET /imports/{id})',
    description:
      'Requires `confirm: true`. Each row is saved through the same code as the manual forms, one row at a time; rows are re-checked first in case data changed. ' +
      'A row that fails is reported and the rest continue. One import per school runs at a time (`IMPORT_ALREADY_RUNNING`); a staff punch import also waits while an import is being undone (`PUNCH_IMPORT_BUSY`). ' +
      'An import interrupted by a server restart can be resumed with this endpoint; rows already saved are not added again.',
    params: idParams,
    body: z.object({ confirm: z.literal(true) }),
    response: ImportJobRes,
    status: 202,
    handler: ({ ctx, params }) => svc.startImport(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/imports/:id/stop',
    tags,
    auth: 'school',
    // Stopping only ends writes: it stays possible when the subscription has lapsed (read-only).
    allowInactiveSubscription: true,
    summary: 'Cancel an import that has not started, or stop a running one (the rows being saved finish)',
    params: idParams,
    response: ImportJobRes,
    handler: ({ ctx, params }) => svc.stopImport(ctx, params.id),
  });

  api.route({
    method: 'get',
    path: '/imports/:id/report.csv',
    tags,
    auth: 'school',
    summary:
      'Download the rows that were not imported (or all rows with `all=true`) with their original values and reasons',
    params: idParams,
    query: z.object({ all: z.enum(['true', 'false']).default('false') }),
    produces: 'text/csv',
    handler: async ({ ctx, params, query, res }) => {
      const { csv, fileName } = await svc.importReportCsv(ctx, params.id, query.all === 'true');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(csv);
    },
  });
}
