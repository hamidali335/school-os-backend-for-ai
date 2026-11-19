import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { IMPORT_TYPES } from './import-fields';

export const IMPORT_STATUSES = [
  'staging', // file read; its rows are being saved (column step can start)
  'analyzed', // file read, columns suggested
  'checking', // rows are being checked in the background; becomes "validated" (or "analyzed" if it fails)
  'validated', // checked; waiting for confirmation
  'running',
  'completed',
  'interrupted', // the server stopped while running; can be resumed
  'failed',
  'cancelled',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** How long the cell values of an import are kept (for the preview and the error report). */
export const IMPORT_ROW_RETENTION_DAYS = 7;

/** An undo whose heartbeat is older than this has stopped (its process ended) and may be run again. */
export const UNDO_STALE_MS = 120_000;

/**
 * One import: who, what, which file, the column mapping and the outcome. The uploaded file
 * itself is never stored; its cells are kept in ImportRow for a limited time.
 */
const ImportJobSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      type: { type: String, enum: IMPORT_TYPES, required: true },
      status: { type: String, enum: IMPORT_STATUSES, default: 'analyzed' },
      createdBy: { type: ObjectId, ref: 'User', required: true },
      createdByName: { type: String, required: true },
      /** The uploader's campuses at upload time (empty = all campuses). Only the uploader, or users
       *  with access to every campus, can see or act on the import. */
      campusIds: { type: [ObjectId], default: [] },
      fileName: { type: String, required: true },
      fileKind: { type: String, enum: ['xlsx', 'csv'], required: true },
      sheetName: { type: String },
      headerRow: { type: Number, required: true },
      headers: { type: [String], default: [] },
      notes: { type: [String], default: [] },
      /** Column index → field key (null = ignored). */
      mapping: {
        type: [{ _id: false, column: Number, header: String, field: { type: String, default: null } }],
        default: [],
      },
      options: { type: Schema.Types.Mixed, default: {} },
      totalRows: { type: Number, default: 0 },
      /** Results of the last check (before confirmation). */
      summary: { type: Schema.Types.Mixed, default: null },
      warnings: { type: [String], default: [] },
      validatedAt: { type: Date },
      /** Final counts. */
      result: {
        created: { type: Number, default: 0 },
        updated: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        /** The added records as saved, by kind (students: by status), read back when the import ended. */
        breakdown: { type: Schema.Types.Mixed, default: undefined },
      },
      progress: { processed: { type: Number, default: 0 }, total: { type: Number, default: 0 } },
      startedAt: { type: Date },
      finishedAt: { type: Date },
      error: { type: String },
      /** The process currently running the import, and its last sign of life (a lease). */
      runnerId: { type: String },
      heartbeatAt: { type: Date },
      /** Set by Stop while running; the run ends once the rows being saved are done (at most one per lane). */
      cancelRequested: { type: Boolean, default: false },
      /** When the row data (and so the error report) is removed. */
      rowsExpireAt: { type: Date, required: true },
      /**
       * Staff attendance punches only: the import was undone (its punches removed, the days worked
       * out again). Claimed like a run (runnerId + heartbeat) so two requests never undo at once;
       * `days` keeps the affected staff days until the undo has finished, so a retry after a
       * failure completes it. An undone import cannot be run or resumed again.
       */
      undo: {
        type: new Schema(
          {
            status: { type: String, enum: ['running', 'completed', 'failed'], required: true },
            runnerId: { type: String },
            heartbeatAt: { type: Date },
            by: { type: ObjectId, ref: 'User' },
            byName: { type: String },
            attempts: { type: Number, default: 0 },
            startedAt: { type: Date },
            finishedAt: { type: Date },
            punchesFound: { type: Number },
            days: { type: [{ _id: false, employeeId: ObjectId, localDate: String }], default: undefined },
            removed: { type: Number, default: 0 },
            keptForOtherImports: { type: Number, default: 0 },
            keptForConnector: { type: Number, default: 0 },
            daysRecalculated: { type: Number, default: 0 },
            error: { type: String },
          },
          { _id: false },
        ),
        default: undefined,
      },
    },
    baseOptions,
  ),
);
ImportJobSchema.index({ schoolId: 1, createdAt: -1 });
// At most one import runs per school at a time.
ImportJobSchema.index(
  { schoolId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'running' }, name: 'one_running_import_per_school' },
);
export const ImportJob = model('ImportJob', ImportJobSchema);

export const ROW_CHECKS = ['create', 'update', 'unchanged', 'exists', 'duplicate', 'invalid'] as const;
export const ROW_RESULTS = ['processing', 'created', 'updated', 'skipped', 'failed'] as const;

const ImportRowSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      jobId: { type: ObjectId, ref: 'ImportJob', required: true },
      rowNo: { type: Number, required: true },
      values: { type: [String], default: [] },
      /** Outcome of the last check. */
      check: { type: String, enum: [...ROW_CHECKS, null], default: null },
      issues: {
        type: [
          { _id: false, level: { type: String, enum: ['error', 'warning', 'info'] }, field: String, message: String },
        ],
        default: [],
      },
      /** For updates: what would change. */
      changes: { type: [{ _id: false, field: String, from: String, to: String }], default: [] },
      /** Outcome of the import itself. */
      result: { type: String, enum: [...ROW_RESULTS, null], default: null },
      resultMessage: { type: String },
      /** The run that claimed the row (atomic claim; see imports.service). */
      claimedBy: { type: String },
      claimedAt: { type: Date },
      /** Identifier assigned when the row is processed (admission/employee number), for safe resume. */
      assignedKey: { type: String },
      entityId: { type: ObjectId },
      expiresAt: { type: Date, required: true },
    },
    { ...baseOptions, timestamps: false },
  ),
);
ImportRowSchema.index({ schoolId: 1, jobId: 1, rowNo: 1 }, { unique: true });
ImportRowSchema.index({ schoolId: 1, jobId: 1, check: 1 });
ImportRowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ImportRow = model('ImportRow', ImportRowSchema);

/**
 * Column choices a school confirmed in a completed import, reused as the first suggestion the
 * next time a file with the same headings is uploaded ("remembered mapping").
 */
const ImportMappingSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      type: { type: String, enum: IMPORT_TYPES, required: true },
      /** Normalised heading → field key, or "__ignore". */
      columns: { type: Schema.Types.Mixed, default: {} },
    },
    baseOptions,
  ),
);
ImportMappingSchema.index({ schoolId: 1, type: 1 }, { unique: true });
export const ImportMapping = model('ImportMapping', ImportMappingSchema);
