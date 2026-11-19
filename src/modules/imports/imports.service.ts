import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { toCsv } from '../../utils/csv';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { routeFeatures } from '../../utils/api';
import { audit } from '../audit/audit.service';
import { assertEntitled } from '../subscriptions/entitlements.service';
import {
  IMPORT_TYPES,
  TYPE_DEFS,
  fieldLabel,
  missingRequired,
  normaliseHeader,
  suggestMapping,
  type ImportType,
} from './import-fields';
import type { ParsedSheet } from './import-files';
import { readSpreadsheetInWorker } from './spreadsheet-reader';
import { IMPORT_ROW_RETENTION_DAYS, ImportJob, ImportMapping, ImportRow, UNDO_STALE_MS } from './import.models';
import { classesProcessor } from './processors/classes';
import { feesProcessor } from './processors/fees';
import { parentsProcessor } from './processors/parents';
import { staffProcessor } from './processors/staff';
import { staffPunchesProcessor } from './processors/staff-punches';
import { studentsProcessor } from './processors/students';
import { timetableProcessor } from './processors/timetable';
import { groupByKeys, IMPORT_LANES, runInLanes } from './import-lanes';
import {
  DEFAULT_OPTIONS,
  type ApplyResult,
  type ImportOptions,
  type Processor,
  type RowIn,
  type RowPlan,
  type RunHelper,
} from './processors/types';

const PROCESSORS: Record<ImportType, Processor> = {
  students: studentsProcessor,
  parents: parentsProcessor,
  staff: staffProcessor,
  classes: classesProcessor,
  timetable: timetableProcessor,
  staff_punches: staffPunchesProcessor,
  fees: feesProcessor,
};

type Ctx = SchoolContext;
/** A job as read from the database (lean). */
interface JobDoc {
  _id: Types.ObjectId;
  type: string;
  status: string;
  fileName: string;
  fileKind: string;
  sheetName?: string | null;
  headerRow: number;
  headers: string[];
  notes: string[];
  mapping: Array<{ column?: number | null; header?: string | null; field?: string | null }>;
  options?: unknown;
  totalRows: number;
  cancelRequested?: boolean | null;
  summary?: unknown;
  warnings?: string[];
  result?: {
    created?: number;
    updated?: number;
    skipped?: number;
    failed?: number;
    breakdown?: Record<string, number> | null;
  };
  progress?: { processed?: number; total?: number };
  createdBy?: unknown;
  createdByName: string;
  campusIds?: unknown[];
  runnerId?: string | null;
  heartbeatAt?: Date | null;
  createdAt?: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  error?: string | null;
  rowsExpireAt: Date;
  undo?: {
    status: 'running' | 'completed' | 'failed';
    heartbeatAt?: Date | null;
    byName?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    removed?: number | null;
    keptForOtherImports?: number | null;
    keptForConnector?: number | null;
    daysRecalculated?: number | null;
    error?: string | null;
  } | null;
}

/** The same permission (and plan entitlement) as adding the records by hand. */
export function canImport(ctx: Ctx, type: ImportType) {
  return ctx.permissions.has(TYPE_DEFS[type].permission);
}

function requireAccess(ctx: Ctx, type: ImportType) {
  const permission = TYPE_DEFS[type].permission;
  if (!ctx.permissions.has(permission))
    throw forbidden(`You need the “${permission}” permission to import ${TYPE_DEFS[type].label.toLowerCase()}`);
  assertEntitled({ features: ctx.entitlements, eligible: ctx.subscriptionEligible }, routeFeatures({ permission }));
}

export function importTypes(ctx: Ctx) {
  return IMPORT_TYPES.map((t) => {
    const d = TYPE_DEFS[t];
    return {
      type: t,
      label: d.label,
      description: d.description,
      identifier: d.identifier,
      allowed: canImport(ctx, t),
      oneOf: d.oneOf ?? [],
      fields: d.fields.map((f) => ({
        key: f.key,
        label: f.label,
        required: Boolean(f.required),
        description: f.description,
        example: f.example,
        inTemplate: f.inTemplate !== false,
      })),
    };
  });
}

/* ───────────────────────────── Step 1: read the file ───────────────────────────── */

/** At most this many files are read at once by one API process (reading is CPU and memory heavy). */
export const MAX_PARALLEL_READS = 2;
let activeReads = 0;

/** Run fn while holding one of the reading slots; refuses (429) when all are busy. */
export async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_PARALLEL_READS)
    throw new AppError(429, 'IMPORT_BUSY', 'Other files are being read right now. Try again in a minute.');
  activeReads++;
  try {
    return await fn();
  } finally {
    activeReads--;
  }
}

export async function analyzeFile(ctx: Ctx, type: ImportType, file: { buffer: Buffer; originalname: string }) {
  requireAccess(ctx, type);
  // Parsed in a worker thread: a large workbook never freezes the API for other users.
  const sheet = await withReadSlot(() => readSpreadsheetInWorker(file.buffer, file.originalname));
  if (!sheet.rows.length)
    throw badRequest('The file has column headings but no data rows', { field: 'file' }, 'IMPORT_EMPTY');
  const remembered = await ImportMapping.findOne(scope(ctx, { type })).lean();
  const mapping = suggestMapping(type, sheet.headers, (remembered?.columns as Record<string, string>) ?? {});
  const rowsExpireAt = new Date(Date.now() + IMPORT_ROW_RETENTION_DAYS * 86_400_000);
  const job = await ImportJob.create({
    schoolId: ctx.schoolId,
    type,
    status: 'staging',
    heartbeatAt: new Date(),
    progress: { processed: 0, total: sheet.rows.length },
    createdBy: ctx.userId,
    createdByName: ctx.name,
    campusIds: ctx.campusIds,
    fileName: file.originalname.slice(0, 200),
    fileKind: sheet.kind,
    sheetName: sheet.sheetName,
    headerRow: sheet.headerRow,
    headers: sheet.headers,
    notes: sheet.notes,
    mapping: mapping.map((m) => ({ column: m.column, header: m.header, field: m.field })),
    totalRows: sheet.rows.length,
    rowsExpireAt,
  });
  // The rows are saved after the response: how long that takes depends on the database
  // (a fraction of a second next to the API, ~30 s over the internet to a shared cloud tier),
  // and must never decide whether the upload request times out. The column step can start
  // at once; checking waits until the rows are ready (status "staging" → "analyzed").
  const schoolId = ctx.schoolId;
  setImmediate(() => void stageRows(schoolId, job._id, sheet.rows, rowsExpireAt));
  return analysisView(
    job.toObject() as unknown as JobDoc,
    mapping,
    sheet.rows.slice(0, 50).map((r) => r.values),
  );
}

/** Rows are saved in batches of this many (short bursts of main-thread work). */
const STAGE_BATCH = 250;
const STAGING_FAILED =
  'Preparing the rows of this file failed, so nothing can be imported from it. Upload the file again.';

/**
 * Save the parsed rows of a new import (background). Renews the job's heartbeat with each batch
 * and stops if the user cancels. If it fails or is cancelled, the rows saved so far are removed
 * and the job says so: a half-prepared import is never offered for checking.
 */
async function stageRows(schoolId: string, jobId: Types.ObjectId, rows: ParsedSheet['rows'], expiresAt: Date) {
  const own = { schoolId: oid(schoolId), _id: jobId, status: 'staging' as const };
  try {
    for (let i = 0; i < rows.length; i += STAGE_BATCH) {
      await ImportRow.insertMany(
        rows.slice(i, i + STAGE_BATCH).map((r) => ({ schoolId, jobId, rowNo: r.rowNo, values: r.values, expiresAt })),
        { ordered: false },
      );
      const state = await ImportJob.findOneAndUpdate(
        own,
        { $set: { heartbeatAt: new Date(), 'progress.processed': Math.min(rows.length, i + STAGE_BATCH) } },
        { returnDocument: 'after' },
      )
        .select('cancelRequested')
        .lean();
      if (!state || (state as { cancelRequested?: boolean }).cancelRequested) {
        // Cancelled (or no longer ours): nothing of this file is kept. Rows go first, so a
        // cancelled import never still holds them.
        await ImportRow.deleteMany({ schoolId: oid(schoolId), jobId });
        await ImportJob.updateOne(own, { $set: { status: 'cancelled', finishedAt: new Date() } });
        return;
      }
    }
    await ImportJob.updateOne(own, { $set: { status: 'analyzed', heartbeatAt: null } });
  } catch (err) {
    logger.error({ err, jobId: String(jobId) }, 'Preparing import rows failed');
    await ImportRow.deleteMany({ schoolId: oid(schoolId), jobId }).catch(() => undefined);
    await ImportJob.updateOne(own, { $set: { status: 'failed', error: STAGING_FAILED, finishedAt: new Date() } }).catch(
      () => undefined,
    );
  }
}

/** Waiting for the rows of a new import to be saved (the column step may already be shown). */
function assertNotStaging(job: JobDoc) {
  if (job.status === 'staging' && !isStale(job))
    throw conflict(
      `The rows of this file are still being prepared (${job.progress?.processed ?? 0} of ${job.totalRows}). Try again in a moment.`,
      { processed: job.progress?.processed ?? 0, total: job.totalRows },
      'IMPORT_STAGING',
    );
}

/** Waiting for a check to finish: row results are being written. */
function assertNotChecking(job: JobDoc) {
  if (job.status === 'checking' && !isStale(job))
    throw conflict(
      `The rows of this file are being checked (${job.progress?.processed ?? 0} of ${job.totalRows}). Try again in a moment.`,
      { processed: job.progress?.processed ?? 0, total: job.totalRows },
      'IMPORT_CHECKING',
    );
}

function analysisView(job: JobDoc, mapping: ReturnType<typeof suggestMapping>, sampleRows: string[][]) {
  const samples = (column: number) => [...new Set(sampleRows.map((v) => v[column]).filter(Boolean))].slice(0, 3);
  return {
    job: jobView(job),
    columns: mapping.map((m) => ({ ...m, samples: samples(m.column) })),
  };
}

/* ───────────────────────────── Step 2: check ───────────────────────────── */

export interface MappingInput {
  column: number;
  field: string | null;
}

function normaliseMapping(job: JobDoc, mapping: MappingInput[]) {
  const fieldKeys = new Set(TYPE_DEFS[job.type as ImportType].fields.map((f) => f.key));
  const used = new Map<string, number>();
  const out = job.headers.map((header, column) => ({ column, header, field: null as string | null }));
  for (const m of mapping) {
    if (!Number.isInteger(m.column) || m.column < 0 || m.column >= job.headers.length)
      throw badRequest(`Column ${m.column} is not in the file`);
    if (m.field === null || m.field === '') continue;
    if (!fieldKeys.has(m.field)) throw badRequest(`"${m.field}" is not a field of this import`, { field: 'mapping' });
    if (used.has(m.field))
      throw badRequest(
        `${fieldLabel(job.type as ImportType, m.field)} is chosen for two columns ("${job.headers[used.get(m.field)!]}" and "${job.headers[m.column]}")`,
        { field: 'mapping' },
        'IMPORT_MAPPING_CONFLICT',
      );
    used.set(m.field, m.column);
    out[m.column].field = m.field;
  }
  return out;
}

function rowInputs(
  job: JobDoc,
  rows: Array<{ rowNo: number; values: string[]; assignedKey?: string | null }>,
): RowIn[] {
  const mapped = job.mapping.filter((m) => m.field);
  const parentHeader = job.mapping.find((m) => m.field === 'parentName')?.header ?? '';
  return rows.map((r) => {
    const cells: Record<string, string> = { __parentHeader: parentHeader };
    for (const m of mapped) cells[m.field!] = r.values[m.column ?? 0] ?? '';
    return { rowNo: r.rowNo, cells, ...(r.assignedKey ? { assignedKey: r.assignedKey } : {}) };
  });
}

/** Rows that equal the template's example row are not data. */
function isTemplateExample(type: ImportType, row: RowIn) {
  const examples = TYPE_DEFS[type].fields.filter((f) => f.inTemplate !== false && f.example);
  return examples.length > 0 && examples.every((f) => (row.cells[f.key] ?? '').trim() === f.example);
}

/** Check results are saved in batches of this many rows. */
const CHECK_BATCH = 250;
const CHECK_STOPPED =
  'Checking stopped before it finished (the server restarted or stopped responding). Check the rows again.';
const CHECK_FAILED = 'Checking the rows failed. Check them again; if it keeps failing, upload the file again.';

/**
 * Step 2. Saves the column matches and options and starts checking in the background (status
 * "checking"); the response does not wait for it, so a slow database never times the request
 * out. Checking writes only the import's own records (each row's result and the summary): no
 * students, parents, staff or logins are created or changed. One check runs per import, claimed
 * atomically: a repeated request for the same columns and options (a retry, a refresh, a second
 * tab) gets the running check, never a second one. Progress is polled with GET /imports/:id.
 */
export async function checkImport(
  ctx: Ctx,
  id: string,
  input: { mapping: MappingInput[]; options?: Partial<ImportOptions> },
) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  assertNotStaging(job);
  if (!['analyzed', 'validated', 'checking'].includes(job.status))
    throw conflict(`This import is ${job.status}; it cannot be checked again`, undefined, 'IMPORT_STATE');
  assertRowsAvailable(job);
  const type = job.type as ImportType;
  const mapping = normaliseMapping(job, input.mapping);
  const options: ImportOptions = { ...DEFAULT_OPTIONS, ...stripUndefined(input.options ?? {}) };
  const mappedFields = new Set(mapping.flatMap((m) => (m.field ? [m.field] : [])));
  const missing = missingRequired(type, mappedFields);
  if (missing.length)
    throw badRequest(
      `Map a column for: ${missing.map((k) => fieldLabel(type, k)).join(', ')}`,
      { missing: missing.map((k) => ({ field: k, label: fieldLabel(type, k) })) },
      'IMPORT_REQUIRED_COLUMNS',
    );
  /** The check already running, if this request asks for the same one; otherwise refused. */
  const joinRunning = (current: JobDoc) => {
    if (sameCheck(current, mapping, options)) return { job: jobView(current), summary: null, warnings: [] };
    throw conflict(
      'These rows are already being checked. Wait for the check to finish, then change the columns and check again.',
      { processed: current.progress?.processed ?? 0, total: current.totalRows },
      'IMPORT_CHECKING',
    );
  };
  if (job.status === 'checking' && !isStale(job)) return joinRunning(job);
  const checkId = randomUUID();
  // Atomic claim: of two requests at the same moment only one starts a check. A check whose
  // process stopped (no heartbeat) may be replaced.
  const started = (await ImportJob.findOneAndUpdate(
    scope(ctx, {
      _id: job._id,
      $or: [
        { status: { $in: ['analyzed', 'validated'] } },
        { status: 'checking', $or: [{ heartbeatAt: { $lt: staleBefore() } }, { heartbeatAt: null }] },
      ],
    }),
    {
      $set: {
        status: 'checking',
        runnerId: checkId,
        heartbeatAt: new Date(),
        mapping,
        options,
        summary: null,
        warnings: [],
        error: null,
        cancelRequested: false,
        progress: { processed: 0, total: job.totalRows },
      },
    },
    { returnDocument: 'after' },
  ).lean()) as unknown as JobDoc | null;
  if (!started) {
    const now = await loadJob(ctx, id);
    if (now.status === 'checking' && !isStale(now)) return joinRunning(now);
    throw conflict('This import changed meanwhile; reload it', undefined, 'IMPORT_STATE');
  }
  setImmediate(() => void runCheck(ctx, started, checkId));
  return { job: jobView(started), summary: null, warnings: [] };
}

/** Same columns and options as the check of this job. */
function sameCheck(job: JobDoc, mapping: ReturnType<typeof normaliseMapping>, options: ImportOptions) {
  const cols = (m: Array<{ column?: number | null; field?: string | null }>) =>
    JSON.stringify(m.map((x) => [x.column ?? 0, x.field ?? null]));
  const opts = (o: object) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return (
    cols(job.mapping) === cols(mapping) &&
    opts({ ...DEFAULT_OPTIONS, ...((job.options as Partial<ImportOptions>) ?? {}) }) === opts(options)
  );
}

/**
 * The check itself (background). Holds the job like a run: its id plus a heartbeat, renewed while
 * the rows are planned and with each batch of results, so a check whose process stopped is seen
 * as stopped (and may be started again). The job is only written while this check still owns
 * it, and ownership is confirmed before each batch of row results; a batch that was already
 * being written when another check took over can still land.
 * Stops if the user cancels the import. If it fails, the job returns to "analyzed" with the
 * reason, and can be checked again.
 */
async function runCheck(ctx: Ctx, job: JobDoc, checkId: string) {
  const own = scope(ctx, { _id: job._id, status: 'checking', runnerId: checkId });
  const beat = async (processed?: number): Promise<'ok' | 'lost' | 'cancel'> => {
    const state = await ImportJob.findOneAndUpdate(
      own,
      { $set: { heartbeatAt: new Date(), ...(processed === undefined ? {} : { 'progress.processed': processed }) } },
      { returnDocument: 'after' },
    )
      .select('cancelRequested')
      .lean();
    if (!state) return 'lost';
    return (state as { cancelRequested?: boolean }).cancelRequested ? 'cancel' : 'ok';
  };
  // Planning is one step whose length depends on the file and the database: renew meanwhile.
  const timer = setInterval(() => void beat().catch(() => undefined), IMPORT_LEASE.HEARTBEAT_MS);
  timer.unref();
  try {
    const { plans, warnings, extra } = await planRows(ctx, job);
    const summary = { ...summarise(plans, job), ...extra };
    for (let i = 0; i <= plans.length; i += CHECK_BATCH) {
      const state = await beat(i);
      if (state === 'lost') return;
      if (state === 'cancel') {
        // Cancelling an import that was never run removes its rows (as for a checked import).
        await ImportRow.deleteMany(scope(ctx, { jobId: job._id }));
        await ImportJob.updateOne(own, { $set: { status: 'cancelled', finishedAt: new Date() } });
        return;
      }
      if (i < plans.length) await saveChecks(ctx, job._id, plans.slice(i, i + CHECK_BATCH));
    }
    await ImportJob.updateOne(own, {
      $set: { status: 'validated', summary, warnings, validatedAt: new Date(), runnerId: null, heartbeatAt: null },
    });
  } catch (err) {
    logger.error({ err, jobId: String(job._id) }, 'Checking import rows failed');
    const message = err instanceof AppError && err.status < 500 ? err.message : CHECK_FAILED;
    await ImportJob.updateOne(own, {
      $set: { status: 'analyzed', error: message, runnerId: null, heartbeatAt: null },
    }).catch(() => undefined);
  } finally {
    clearInterval(timer);
  }
}

async function planRows(ctx: Ctx, job: JobDoc) {
  const type = job.type as ImportType;
  const rows = await ImportRow.find(scope(ctx, { jobId: job._id }))
    .select('rowNo values assignedKey result check')
    .sort({ rowNo: 1 })
    .lean();
  const inputs = rowInputs(job, rows);
  const examples = new Set(inputs.filter((r) => isTemplateExample(type, r)).map((r) => r.rowNo));
  const {
    rows: plans,
    warnings,
    summary: extra,
  } = await PROCESSORS[type].plan(
    ctx,
    inputs.filter((r) => !examples.has(r.rowNo)),
    job.options as ImportOptions,
    {
      jobId: String(job._id),
    },
  );
  for (const rowNo of examples)
    plans.push({
      rowNo,
      check: 'exists',
      issues: [{ level: 'info', message: 'The example row from the template; skipped' }],
      changes: [],
    });
  plans.sort((a, b) => a.rowNo - b.rowNo);
  return { plans, warnings, rows, extra: extra ?? {} };
}

function summarise(plans: RowPlan[], job: JobDoc) {
  const count = (c: string) => plans.filter((p) => p.check === c).length;
  return {
    total: plans.length,
    create: count('create'),
    update: count('update'),
    unchanged: count('unchanged'),
    exists: count('exists'),
    duplicate: count('duplicate'),
    invalid: count('invalid'),
    withWarnings: plans.filter((p) => p.check !== 'invalid' && p.issues.some((i) => i.level === 'warning')).length,
    ignoredColumns: job.mapping.filter((m) => !m.field).map((m) => m.header),
  };
}

async function saveChecks(ctx: Ctx, jobId: unknown, plans: RowPlan[], stop?: () => boolean) {
  for (let i = 0; i < plans.length; i += 250) {
    if (stop?.()) return;
    await ImportRow.bulkWrite(
      plans.slice(i, i + 250).map((p) => ({
        updateOne: {
          filter: { schoolId: oid(ctx.schoolId), jobId: oid(String(jobId)), rowNo: p.rowNo },
          update: { $set: { check: p.check, issues: p.issues, changes: p.changes } },
        },
      })),
    );
  }
}

/* ───────────────────────────── Step 3: import ───────────────────────────── */

/**
 * Running imports hold a lease: the run's id plus a heartbeat written at least every
 * HEARTBEAT_MS. A run whose heartbeat is older than STALE_MS is treated as stopped (its process
 * died) and may be taken over. Each row is also claimed atomically before it is saved, so even
 * two processes working on the same import can never save a row twice.
 */
export const IMPORT_LEASE = { HEARTBEAT_MS: 5_000, STALE_MS: 120_000 };
const staleBefore = () => new Date(Date.now() - IMPORT_LEASE.STALE_MS);
const isStale = (job: Pick<JobDoc, 'status' | 'heartbeatAt'>) =>
  (job.status === 'running' || job.status === 'staging' || job.status === 'checking') &&
  (!job.heartbeatAt || job.heartbeatAt < staleBefore());
const STOPPED_MESSAGE = 'Stopped by a user. Rows already imported are kept.';

/**
 * Runs whose process stopped (no heartbeat for STALE_MS), matching `filter` (a school, or all
 * schools at startup). A run that was asked to stop is cancelled, as the user asked: it is not
 * offered for resuming. Any other can be resumed ("interrupted").
 */
async function settleStaleRuns(filter: Record<string, unknown>, crossTenant = false) {
  const stale = {
    ...filter,
    status: 'running' as const,
    $or: [{ heartbeatAt: { $lt: staleBefore() } }, { heartbeatAt: null }],
  };
  const stopped = (await ImportJob.find({ ...stale, cancelRequested: true })
    .setOptions({ crossTenant })
    .select('_id schoolId mapping headers')
    .lean()) as unknown as Array<JobDoc & { schoolId: Types.ObjectId }>;
  for (const j of stopped) {
    const done = await ImportJob.updateOne(
      { schoolId: j.schoolId, _id: j._id, status: 'running', cancelRequested: true, $or: stale.$or },
      { $set: { status: 'cancelled', finishedAt: new Date(), error: STOPPED_MESSAGE } },
    );
    if (done.modifiedCount) await forgetUnimportedColumns({ schoolId: String(j.schoolId) } as Ctx, j);
  }
  const interrupted = await ImportJob.updateMany(
    { ...stale, cancelRequested: { $ne: true } },
    { $set: { status: 'interrupted', error: STALE_MESSAGE } },
  ).setOptions({ crossTenant });
  return { cancelled: stopped.length, interrupted: interrupted.modifiedCount };
}

const STALE_MESSAGE =
  'The import stopped before it finished (the server restarted or stopped responding). Resume it to finish the remaining rows; rows already imported are not added twice.';

export async function startImport(ctx: Ctx, id: string) {
  let job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  assertNotStaging(job);
  assertNotChecking(job);
  if (job.status === 'running' && isStale(job)) {
    // Its process stopped: settle it (cancelled if a stop was requested, otherwise resumable).
    await settleStaleRuns(scope(ctx));
    job = await loadJob(ctx, id);
  }
  if (job.undo)
    throw conflict(
      'This import was undone: it cannot be run again. Upload the file again to import it.',
      undefined,
      'IMPORT_UNDONE',
    );
  const resumable = job.status === 'validated' || job.status === 'interrupted';
  if (!resumable)
    throw conflict(
      job.status === 'analyzed' || job.status === 'checking'
        ? 'Check the file before importing'
        : `This import is already ${job.status}`,
      undefined,
      'IMPORT_STATE',
    );
  assertRowsAvailable(job);
  // A stopped run elsewhere in the school must not block this one (one import per school).
  await settleStaleRuns(scope(ctx));
  const runnerId = randomUUID();
  // Kinds with a run lock (staff punches): taken before the run is claimed, held until it ends.
  const lock = PROCESSORS[job.type as ImportType].runLock;
  if (lock) await lock.acquire(ctx, runnerId);
  let started: JobDoc | null;
  try {
    started = (await ImportJob.findOneAndUpdate(
      // Never an import being (or already) undone, even if the undo started a moment ago.
      scope(ctx, { _id: job._id, status: { $in: ['validated', 'interrupted'] }, undo: { $exists: false } }),
      {
        $set: {
          status: 'running',
          runnerId,
          heartbeatAt: new Date(),
          startedAt: job.startedAt ?? new Date(),
          error: null,
          cancelRequested: false,
        },
      },
      { returnDocument: 'after' },
    ).lean()) as unknown as JobDoc | null;
  } catch (err) {
    await lock?.release(ctx, runnerId);
    if (isDuplicateKey(err))
      throw conflict(
        'Another import is running in your school. Wait for it to finish, then try again.',
        undefined,
        'IMPORT_ALREADY_RUNNING',
      );
    throw err;
  }
  if (!started) {
    await lock?.release(ctx, runnerId);
    throw conflict('This import has already started', undefined, 'IMPORT_STATE');
  }
  // Keep the rows for at least two more days so a long run (or a resume) never loses them.
  const keepUntil = new Date(Math.max(job.rowsExpireAt.getTime(), Date.now() + 2 * 86_400_000));
  if (keepUntil > job.rowsExpireAt) {
    await ImportJob.updateOne(scope(ctx, { _id: job._id }), { $set: { rowsExpireAt: keepUntil } });
    await ImportRow.updateMany(scope(ctx, { jobId: job._id }), { $set: { expiresAt: keepUntil } });
    started.rowsExpireAt = keepUntil;
  }
  await audit(ctx, {
    action: 'import.started',
    entityType: 'ImportJob',
    entityId: job._id,
    metadata: { type: job.type, rows: job.totalRows, resumed: job.status !== 'validated' },
  });
  // Runs after the response; progress is polled with GET /imports/:id.
  setImmediate(() => {
    void trackRun(processJob(ctx, started!, runnerId)).catch(async (err) => {
      logger.error({ err, jobId: String(job._id) }, 'Import failed');
      // Only a run that still owns the import marks it; a finished import is never changed back.
      await ImportJob.updateOne(scope(ctx, { _id: job._id, runnerId, status: 'running' }), {
        $set: {
          status: 'interrupted',
          finishedAt: new Date(),
          error:
            'The import stopped because of an unexpected error. Rows already imported are kept and are not added twice if you resume it.',
        },
      });
    });
  });
  return jobView(started);
}

const firstMessage = (plan: RowPlan, levels: string[]) => plan.issues.find((i) => levels.includes(i.level))?.message;

/** MongoDB duplicate-key error (E11000), possibly wrapped. */
export function isDuplicateKey(
  err: unknown,
): err is { code: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> } {
  const e = err as { code?: number; cause?: { code?: number } } | null;
  return e?.code === 11000 || e?.cause?.code === 11000;
}

const DUPLICATE_FIELDS: Record<string, string> = {
  admissionNo: 'admission number',
  employeeNo: 'employee number',
  cnic: 'CNIC',
  email: 'email address',
  username: 'sign-in name',
  name: 'name',
  phone: 'phone number',
};

/** A clear message for a unique-index clash (the record already exists, e.g. added meanwhile). */
export function duplicateKeyMessage(err: unknown): string {
  const e = (isDuplicateKey(err) ? ((err as { cause?: unknown }).cause ?? err) : err) as {
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };
  const field = Object.keys(e.keyPattern ?? e.keyValue ?? {}).find((k) => k !== 'schoolId' && !k.endsWith('Id'));
  const value = field ? e.keyValue?.[field] : undefined;
  const what = field ? (DUPLICATE_FIELDS[field] ?? field) : 'details';
  return `Not saved: a record with the same ${what}${value !== undefined && value !== null ? ` (${String(value)})` : ''} already exists. It may have been added while the import was running; check the existing record or change this row and import it again.`;
}

/**
 * Process the rows of a running import. Returns when every row has an outcome, when the user
 * stops it, or as soon as this run loses its lease (another run took over a stalled import).
 *
 * The lease is renewed by a timer every HEARTBEAT_MS, whatever the rows are doing (one row can
 * take seconds over a slow connection, and checking the file again at the start much longer), so
 * a live run is never shown as stopped, and a stop request or a takeover is noticed within
 * HEARTBEAT_MS. Once either is noticed, no new row starts; rows already being saved finish.
 * Each row is claimed before it is saved and its result is written only while this run still
 * holds that claim, so a run that lost its lease never overwrites the run that took over.
 *
 * Two runs never save rows of one family (rows sharing a parent or a number) at the same time:
 * - a run whose heartbeat has not been renewed for half of STALE_MS starts no new row and leaves
 *   the import resumable, so by the time another run may take over (STALE_MS) it has stopped;
 * - a run that takes over leaves alone every group with a row the other run is still saving
 *   (claimed within STALE_MS); the import then ends interrupted, to be resumed later.
 *
 * Processors that support it save rows in a few lanes at once (see RunHelper and import-lanes).
 */
async function processJob(ctx: Ctx, job: JobDoc, runnerId: string) {
  const type = job.type as ImportType;
  const processor = PROCESSORS[type];
  let processed = 0;
  let total = job.totalRows;
  const lease = { state: 'ok' as 'ok' | 'lost' | 'cancel' };
  /** The lease as the heartbeat last found it (it changes while the rows are saved). */
  const now = () => lease.state;
  let helper: RunHelper | undefined;
  let lastRenewed = Date.now();
  /** True once the lease has gone unrenewed so long that another run could soon take over. */
  const fenced = () => Date.now() - lastRenewed > IMPORT_LEASE.STALE_MS / 2;
  /** Renew the lease; notes when this run no longer owns the import, or was asked to stop. */
  const beat = async () => {
    // A run lock lost to another holder (it expired) means another operation may now change the
    // same records: this run stops as if it had lost its lease.
    if (processor.runLock && !(await processor.runLock.renew(ctx, runnerId))) {
      lease.state = 'lost';
      return lease.state;
    }
    const found = await ImportJob.findOneAndUpdate(
      scope(ctx, { _id: job._id, status: 'running', runnerId }),
      { $set: { heartbeatAt: new Date(), 'progress.processed': processed, 'progress.total': total } },
      { returnDocument: 'after' },
    )
      .select('cancelRequested')
      .lean();
    if (found) lastRenewed = Date.now();
    if (!found) lease.state = 'lost';
    else if ((found as { cancelRequested?: boolean }).cancelRequested && lease.state === 'ok') lease.state = 'cancel';
    return lease.state;
  };
  let beating = false;
  const timer = setInterval(() => {
    if (beating || lease.state === 'lost') return;
    beating = true;
    void beat()
      // Values reused between rows are read again with each heartbeat.
      .then((now) => (now === 'lost' ? undefined : helper?.refresh()))
      .catch((err) => logger.warn({ err, jobId: String(job._id) }, 'Import heartbeat failed'))
      .finally(() => (beating = false));
  }, IMPORT_LEASE.HEARTBEAT_MS);
  timer.unref();
  try {
    if ((await beat()) === 'lost') return;
    // Fresh check against the data as it is now (it may have changed since the preview).
    const { plans } = await planRows(ctx, job);
    total = plans.length;
    let deferred = 0;
    await saveChecks(ctx, job._id, plans, () => now() === 'lost');
    if (now() === 'lost') return;
    if (now() === 'ok') {
      const reserved = await reserveRowKeys(ctx, job, processor, plans);
      const lanes = processor.startRun ? IMPORT_LANES.DEFAULT : 1;
      helper = processor.startRun ? await processor.startRun(ctx, plans, { lanes }) : undefined;
      const save = (plan: RowPlan) => (helper ? helper.apply(plan) : processor.apply(ctx, plan));
      let groups = helper
        ? groupByKeys(plans, (p) => [
            ...(p.key ? [`key:${p.key.toLowerCase()}`] : []),
            ...(p.existingId ? [`record:${p.existingId}`] : []),
            ...(p.groupKeys ?? []),
          ])
        : [plans];
      if (helper) {
        // Families another run is still saving are left to it (resumed later).
        const busy = new Set(
          (
            await ImportRow.find(
              scope(ctx, {
                jobId: job._id,
                result: 'processing',
                claimedBy: { $ne: runnerId },
                claimedAt: { $gt: staleBefore() },
              }),
            )
              .select('rowNo')
              .lean()
          ).map((r) => r.rowNo),
        );
        const free = groups.filter((g) => !g.some((plan) => busy.has(plan.rowNo)));
        deferred = groups.length - free.length;
        groups = free;
      }
      await runInLanes(
        groups,
        lanes,
        async (plan) => {
          processed++;
          await processRow(ctx, job, runnerId, plan, processor, reserved.has(plan.rowNo), save);
        },
        () => now() !== 'ok' || fenced() || draining,
      );
      if (helper?.finish) {
        await helper.finish();
      }
    }
    if (now() === 'lost') return;
    if (now() === 'ok' && (fenced() || deferred || draining)) {
      // Stopped responding for a while, the server is shutting down, or another run still saves
      // some families: leave it resumable.
      await ImportJob.updateOne(scope(ctx, { _id: job._id, status: 'running', runnerId }), {
        $set: {
          status: 'interrupted',
          error: draining
            ? 'The server restarted while importing. Resume the import to finish the remaining rows; rows already imported are not added twice.'
            : fenced()
              ? STALE_MESSAGE
              : 'Some rows were still being saved by an earlier run. Resume the import in two minutes to finish them; nothing is added twice.',
        },
      });
      return;
    }
    if (now() === 'cancel') {
      if ((await beat()) === 'lost') return;
      await finish(ctx, job, runnerId, 'cancelled', 'Stopped by a user. Rows already imported are kept.');
      return;
    }
    if ((await beat()) === 'lost') return;
    // Rows another run was still saving are not finished: leave the import resumable.
    const unresolved = await ImportRow.countDocuments(scope(ctx, { jobId: job._id, result: 'processing' }));
    if (unresolved) {
      await ImportJob.updateOne(scope(ctx, { _id: job._id, status: 'running', runnerId }), {
        $set: {
          status: 'interrupted',
          error: `${unresolved} row(s) were still being saved by an earlier run. Resume the import in two minutes to finish them; nothing is added twice.`,
        },
      });
      return;
    }
    await finish(ctx, job, runnerId, 'completed');
  } finally {
    clearInterval(timer);
    await processor.runLock?.release(ctx, runnerId).catch((err) => {
      logger.warn({ err, jobId: String(job._id) }, 'Could not release the import run lock (it expires on its own)');
    });
  }
}

/** One row: claim it, save it (or record why not), and write its result while the claim is held. */
async function processRow(
  ctx: Ctx,
  job: JobDoc,
  runnerId: string,
  plan: RowPlan,
  processor: Processor,
  keyReserved: boolean,
  save: (plan: RowPlan) => Promise<ApplyResult>,
) {
  const rowFilter = scope(ctx, { jobId: job._id, rowNo: plan.rowNo });
  // Always the row as it is now, never an earlier snapshot.
  const current = await ImportRow.findOne(rowFilter).select('result check assignedKey claimedBy claimedAt').lean();
  if (!current || (current.result && current.result !== 'processing')) return; // done (or row data expired)
  // A row another run claimed recently is left to that run, which may still be saving it.
  if (current.result === 'processing' && current.claimedAt && current.claimedAt > staleBefore()) return;
  /** Claim the row atomically from the state just read; null when another run got it first. */
  const claim = (set: Record<string, unknown>) =>
    ImportRow.findOneAndUpdate(
      { ...rowFilter, result: current.result ?? null, claimedBy: current.claimedBy ?? null },
      { $set: { ...set, claimedBy: runnerId, claimedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  if (current.result === 'processing' && (plan.check === 'exists' || plan.check === 'unchanged')) {
    // A stopped run saved this row just before it stopped: the fresh check finds the record.
    await claim({
      result: current.check === 'update' ? 'updated' : 'created',
      resultMessage: 'Saved before the interruption',
      ...(plan.existingId ? { entityId: oid(plan.existingId) } : {}),
    });
    return;
  }
  if (plan.check === 'invalid') {
    await claim({ result: 'rejected', resultMessage: firstMessage(plan, ['error']) ?? 'Not valid' });
    return;
  }
  if (plan.check !== 'create' && plan.check !== 'update') {
    await claim({ result: 'skipped', resultMessage: firstMessage(plan, ['error', 'warning', 'info']) ?? 'Skipped' });
    return;
  }
  const claimed = await claim({ result: 'processing', check: plan.check });
  if (!claimed) return; // another run is saving it
  const mine = scope(ctx, { jobId: job._id, rowNo: plan.rowNo, claimedBy: runnerId });
  try {
    if (plan.check === 'create' && processor.assignKey && !keyReserved) {
      const key = current.assignedKey ?? (await processor.assignKey(ctx, plan));
      if (key) {
        plan.key = key;
        // Recorded before saving, so a resumed run recognises the record by this number.
        await ImportRow.updateOne(mine, { $set: { assignedKey: key } });
      }
    }
    const res = await save(plan);
    await ImportRow.updateOne(mine, {
      $set: {
        result: res.result,
        resultMessage: res.message,
        ...(res.entityId ? { entityId: oid(res.entityId) } : {}),
      },
    });
  } catch (err) {
    const message = isDuplicateKey(err)
      ? duplicateKeyMessage(err)
      : err instanceof AppError
        ? err.message
        : 'Could not be saved because of an unexpected error';
    if (!(err instanceof AppError) && !isDuplicateKey(err))
      logger.error({ err, jobId: String(job._id), rowNo: plan.rowNo }, 'Import row failed');
    await ImportRow.updateOne(mine, { $set: { result: 'failed', resultMessage: message } });
  }
}

/**
 * New rows without an identifier (a student without an admission number) are numbered before any
 * row is saved: all at once and in file order, and saved on the row, so a resumed run finds the
 * record by it. Rows already numbered or finished keep theirs. Returns the rows numbered here.
 */
async function reserveRowKeys(ctx: Ctx, job: JobDoc, processor: Processor, plans: RowPlan[]) {
  const numbered = new Set<number>();
  if (!processor.reserveKeys) return numbered;
  const wanted = plans.filter((p) => p.check === 'create' && !p.key).map((p) => p.rowNo);
  if (!wanted.length) return numbered;
  const open = await ImportRow.find(
    scope(ctx, { jobId: job._id, rowNo: { $in: wanted }, result: null, assignedKey: null }),
  )
    .select('rowNo')
    .sort({ rowNo: 1 })
    .lean();
  if (!open.length) return numbered;
  const keys = await processor.reserveKeys(ctx, open.length);
  for (let i = 0; i < open.length; i += 500)
    await ImportRow.bulkWrite(
      open.slice(i, i + 500).map((r, j) => ({
        updateOne: {
          filter: { schoolId: oid(ctx.schoolId), jobId: job._id, rowNo: r.rowNo, assignedKey: null },
          update: { $set: { assignedKey: keys[i + j] } },
        },
      })),
    );
  // What the rows hold now: a number saved by another run first wins.
  const saved = await ImportRow.find(scope(ctx, { jobId: job._id, rowNo: { $in: open.map((r) => r.rowNo) } }))
    .select('rowNo assignedKey')
    .lean();
  const byRow = new Map(saved.map((r) => [r.rowNo, r.assignedKey]));
  for (const plan of plans) {
    const key = byRow.get(plan.rowNo);
    if (key) {
      plan.key = key;
      numbered.add(plan.rowNo);
    }
  }
  return numbered;
}

async function finish(ctx: Ctx, job: JobDoc, runnerId: string, status: 'completed' | 'cancelled', error?: string) {
  const counts = await ImportRow.aggregate<{ _id: string; n: number }>([
    { $match: { schoolId: oid(ctx.schoolId), jobId: job._id } },
    { $group: { _id: '$result', n: { $sum: 1 } } },
  ]);
  const n = (k: string) => counts.find((c) => c._id === k)?.n ?? 0;
  const result = {
    created: n('created'),
    updated: n('updated'),
    skipped: n('skipped'),
    failed: n('failed') + n('rejected'),
    ...(await addedBreakdown(ctx, job, n('created'))),
  };
  // Blank the columns that were not imported first, so a finished import never still holds them.
  await forgetUnimportedColumns(ctx, job);
  const done = await ImportJob.updateOne(scope(ctx, { _id: job._id, status: 'running', runnerId }), {
    $set: { status, result, finishedAt: new Date(), ...(error ? { error } : {}) },
  });
  if (!done.modifiedCount) return; // another run owns the import now
  if (status === 'completed') await rememberMapping(ctx, job);
  await audit(ctx, {
    action: status === 'completed' ? 'import.completed' : 'import.cancelled',
    entityType: 'ImportJob',
    entityId: job._id,
    metadata: { type: job.type, file: job.fileName, ...result, ...punchImportFacts(job) },
  });
}

/**
 * The added records as they are saved, by kind (students: by status), read back from the
 * database. An added row whose record cannot be found is counted as `notFound`, so the breakdown
 * always adds up to `created` and nothing is hidden.
 */
async function addedBreakdown(ctx: Ctx, job: JobDoc, created: number) {
  const processor = PROCESSORS[job.type as ImportType];
  if (!processor.resultBreakdown || !created) return {};
  const ids = (await ImportRow.find(
    scope(ctx, { jobId: job._id, result: 'created', entityId: { $ne: null } }),
  ).distinct('entityId')) as Types.ObjectId[];
  const breakdown = await processor.resultBreakdown(ctx, ids);
  const found = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (found < created) breakdown.notFound = created - found;
  return { breakdown };
}

/** Staff attendance punches: the device and the way dates were read, recorded with the outcome. */
function punchImportFacts(job: JobDoc) {
  if (job.type !== 'staff_punches') return {};
  const options = (job.options ?? {}) as Partial<ImportOptions>;
  const dates = (job.summary as { datePreview?: { order?: string | null; orderSource?: string; timeZone?: string } })
    ?.datePreview;
  return {
    deviceId: options.deviceId ?? null,
    dateOrder: dates?.order ?? null,
    dateOrderSource: dates?.orderSource ?? null,
    timeZone: dates?.timeZone ?? null,
  };
}

/**
 * After an import ends, the cells of columns that were not imported are blanked: the file may
 * hold data the school chose not to bring in (medical notes, other IDs), which is then not kept
 * for the remaining days of the report.
 */
async function forgetUnimportedColumns(ctx: Ctx, job: JobDoc) {
  const keep = job.mapping.filter((m) => m.field).map((m) => m.column ?? -1);
  if (keep.length === job.headers.length) return;
  await ImportRow.updateMany(
    scope(ctx, { jobId: job._id }),
    [
      {
        $set: {
          values: {
            $map: {
              input: { $range: [0, { $size: '$values' }] },
              as: 'i',
              in: { $cond: [{ $in: ['$$i', keep] }, { $arrayElemAt: ['$values', '$$i'] }, ''] },
            },
          },
        },
      },
    ],
    { updatePipeline: true },
  );
}

/** Remember the confirmed column choices for the next import of this type. */
async function rememberMapping(ctx: Ctx, job: JobDoc) {
  const current = await ImportMapping.findOne(scope(ctx, { type: job.type })).lean();
  const columns: Record<string, string> = { ...((current?.columns as Record<string, string>) ?? {}) };
  for (const m of job.mapping) {
    const key = normaliseHeader(m.header ?? '');
    if (key) columns[key] = m.field ?? '__ignore';
  }
  await ImportMapping.updateOne(
    scope(ctx, { type: job.type }),
    { $set: { columns }, $setOnInsert: { schoolId: ctx.schoolId } },
    { upsert: true },
  );
}

export async function stopImport(ctx: Ctx, id: string) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  if ((job.status === 'running' || job.status === 'staging' || job.status === 'checking') && !isStale(job)) {
    // The run (or the row preparation, or the check) stops at its next step and cleans up.
    await ImportJob.updateOne(scope(ctx, { _id: job._id }), { $set: { cancelRequested: true } });
    return jobView({ ...job });
  }
  if (!['analyzed', 'validated', 'interrupted', 'running', 'staging', 'checking'].includes(job.status))
    throw conflict(`This import is already ${job.status}`, undefined, 'IMPORT_STATE');
  const res = await ImportJob.updateOne(scope(ctx, { _id: job._id, status: job.status }), {
    $set: { status: 'cancelled', finishedAt: new Date() },
  });
  if (!res.modifiedCount) throw conflict('This import changed meanwhile; reload it', undefined, 'IMPORT_STATE');
  // Nothing was imported before the import started: its rows can go. Otherwise keep them for the report.
  if (['analyzed', 'validated', 'staging', 'checking'].includes(job.status))
    await ImportRow.deleteMany(scope(ctx, { jobId: job._id }));
  else await forgetUnimportedColumns(ctx, job);
  return jobView({ ...job, status: 'cancelled' });
}

/* ───────────────────────────── Reading jobs and rows ───────────────────────────── */

/**
 * An import is visible to the user who uploaded it, and to users with access to every campus
 * (who can see all of the school's records anyway). A user limited to some campuses never sees
 * another user's import, whose rows may concern other campuses. Not found otherwise.
 */
function canSeeJob(ctx: Ctx, job: Pick<JobDoc, 'createdBy'>) {
  return String(job.createdBy) === ctx.userId || ctx.campusIds.length === 0;
}

async function loadJob(ctx: Ctx, id: string) {
  const job = (await ImportJob.findOne(scope(ctx, { _id: oid(id) })).lean()) as unknown as JobDoc | null;
  if (!job || !canSeeJob(ctx, job)) throw notFound('Import');
  return job;
}

/**
 * An import the caller may act on: of their school, visible to them (see canSeeJob), and of a
 * kind they may import. For actions on an import's results outside this module (undoing one).
 */
export async function importJobForAction(ctx: Ctx, id: string) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  return job;
}

function assertRowsAvailable(job: JobDoc) {
  if (job.rowsExpireAt < new Date())
    throw new AppError(
      410,
      'IMPORT_EXPIRED',
      `The rows of this import were removed after ${IMPORT_ROW_RETENTION_DAYS} days, so it can no longer be checked or resumed. ` +
        'Records it already imported are kept. Upload the file again: rows already in the system are recognised and skipped.',
    );
}

export function jobView(job: JobDoc) {
  const stale = isStale(job);
  const rowsAvailable = job.rowsExpireAt > new Date();
  // Stalled row preparation cannot be resumed (the file is not kept): it has failed.
  const stagingFailed = stale && job.status === 'staging';
  // A stalled check changed nothing outside the import: the columns can be checked again.
  const checkStopped = stale && job.status === 'checking';
  // A stalled run that was asked to stop is cancelled (as it will be when it is settled).
  const stopRequested = stale && job.status === 'running' && Boolean(job.cancelRequested);
  const status = stagingFailed
    ? 'failed'
    : checkStopped
      ? 'analyzed'
      : stopRequested
        ? 'cancelled'
        : stale
          ? 'interrupted'
          : job.status;
  return {
    _id: String(job._id),
    type: job.type as ImportType,
    status,
    fileName: job.fileName,
    fileKind: job.fileKind,
    sheetName: job.sheetName ?? null,
    headerRow: job.headerRow,
    headers: job.headers,
    notes: job.notes,
    mapping: job.mapping.map((m) => ({ column: m.column ?? 0, header: m.header ?? '', field: m.field ?? null })),
    options: { ...DEFAULT_OPTIONS, ...((job.options as Partial<ImportOptions>) ?? {}) },
    totalRows: job.totalRows,
    summary: job.summary ?? null,
    warnings: job.warnings ?? [],
    result: {
      created: job.result?.created ?? 0,
      updated: job.result?.updated ?? 0,
      skipped: job.result?.skipped ?? 0,
      failed: job.result?.failed ?? 0,
      ...(job.result?.breakdown ? { breakdown: job.result.breakdown } : {}),
    },
    progress: { processed: job.progress?.processed ?? 0, total: job.progress?.total ?? 0 },
    createdByName: job.createdByName,
    createdAt: (job as { createdAt?: Date }).createdAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    error: stagingFailed ? STAGING_FAILED : checkStopped ? CHECK_STOPPED : stale ? STALE_MESSAGE : (job.error ?? null),
    rowsAvailable,
    canResume: status === 'interrupted' && rowsAvailable && !job.undo,
    rowsExpireAt: job.rowsExpireAt.toISOString(),
    undo: job.undo
      ? {
          // An undo whose process stopped is shown as failed: running it again finishes it.
          status: undoStalled(job.undo) ? 'failed' : job.undo.status,
          byName: job.undo.byName ?? null,
          startedAt: job.undo.startedAt?.toISOString() ?? null,
          finishedAt: job.undo.finishedAt?.toISOString() ?? null,
          removed: job.undo.removed ?? 0,
          keptForOtherImports: job.undo.keptForOtherImports ?? 0,
          keptForConnector: job.undo.keptForConnector ?? 0,
          daysRecalculated: job.undo.daysRecalculated ?? 0,
          error: undoStalled(job.undo) ? UNDO_STALLED : (job.undo.error ?? null),
        }
      : null,
  };
}

const UNDO_STALLED =
  'Undoing this import stopped before it finished (the server restarted). Undo it again to finish: nothing is removed twice.';
const undoStalled = (u: NonNullable<JobDoc['undo']>) =>
  u.status === 'running' && (!u.heartbeatAt || u.heartbeatAt.getTime() < Date.now() - UNDO_STALE_MS);

export async function getImport(ctx: Ctx, id: string) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  return jobView(job);
}

export async function listImports(ctx: Ctx, q: { page: number; limit: number }) {
  const types = IMPORT_TYPES.filter((t) => canImport(ctx, t));
  const filter = scope(ctx, {
    type: { $in: types },
    // Users limited to some campuses see only their own imports (see canSeeJob).
    ...(ctx.campusIds.length ? { createdBy: oid(ctx.userId) } : {}),
  });
  const [items, total] = await Promise.all([
    ImportJob.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ImportJob.countDocuments(filter),
  ]);
  return {
    items: items.map((j) => jobView(j as unknown as JobDoc)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

const ROW_FILTERS: Record<string, Record<string, unknown>> = {
  all: {},
  problems: { $or: [{ check: { $in: ['invalid', 'duplicate'] } }, { result: { $in: ['failed', 'rejected'] } }] },
  warnings: { 'issues.level': 'warning' },
  ready: { check: { $in: ['create', 'update'] } },
  skipped: { check: { $in: ['exists', 'unchanged', 'duplicate'] } },
  imported: { result: { $in: ['created', 'updated'] } },
};

export async function listImportRows(ctx: Ctx, id: string, q: { filter: string; page: number; limit: number }) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  assertNotStaging(job);
  assertNotChecking(job);
  assertRowsAvailable(job);
  const filter = scope(ctx, { jobId: job._id, ...(ROW_FILTERS[q.filter] ?? {}) });
  const [items, total] = await Promise.all([
    ImportRow.find(filter)
      .sort({ rowNo: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ImportRow.countDocuments(filter),
  ]);
  const mapped = job.mapping.filter((m) => m.field);
  return {
    items: items.map((r) => ({
      rowNo: r.rowNo,
      check: r.check ?? null,
      result: r.result ?? null,
      resultMessage: r.resultMessage ?? null,
      issues: r.issues.map((i) => ({ level: i.level!, field: i.field ?? null, message: i.message ?? '' })),
      changes: r.changes.map((c) => ({
        field: fieldLabel(job.type as ImportType, c.field ?? ''),
        from: c.from ?? '',
        to: c.to ?? '',
      })),
      values: Object.fromEntries(mapped.map((m) => [m.field!, r.values[m.column ?? 0] ?? ''])),
    })),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
  };
}

/**
 * CSV of the rows that were not imported (or all rows), with the reasons. Only the columns that
 * were matched to a field are included: columns the user chose not to import are never written
 * out again.
 */
export async function importReportCsv(ctx: Ctx, id: string, all: boolean) {
  const job = await loadJob(ctx, id);
  requireAccess(ctx, job.type as ImportType);
  assertNotStaging(job);
  assertNotChecking(job);
  assertRowsAvailable(job);
  const filter = all
    ? {}
    : {
        $or: [
          { check: { $in: ['invalid', 'duplicate', 'exists', 'unchanged'] } },
          { result: { $in: ['failed', 'rejected', 'skipped'] } },
        ],
      };
  const rows = await ImportRow.find(scope(ctx, { jobId: job._id, ...filter }))
    .sort({ rowNo: 1 })
    .lean();
  const outcome = (r: (typeof rows)[number]) =>
    r.result ??
    (
      {
        create: 'ready to add',
        update: 'ready to update',
        unchanged: 'unchanged',
        exists: 'already exists',
        duplicate: 'duplicate',
        invalid: 'has errors',
      } as Record<string, string>
    )[r.check ?? ''] ??
    '';
  const mapped = job.mapping.filter((m) => m.field);
  const columns = [
    { key: '__row', header: 'Row' },
    { key: '__outcome', header: 'Outcome' },
    { key: '__problems', header: 'Problems' },
    ...mapped.map((m) => ({ key: `c${m.column}`, header: m.header ?? '' })),
  ];
  const data = rows.map((r) => ({
    __row: r.rowNo,
    __outcome: outcome(r),
    __problems: [r.resultMessage, ...r.issues.filter((i) => i.level !== 'info').map((i) => i.message)]
      .filter((m, i, a) => m && a.indexOf(m) === i)
      .join('; '),
    ...Object.fromEntries(mapped.map((m) => [`c${m.column}`, r.values[m.column ?? 0] ?? ''])),
  }));
  const base =
    job.fileName
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 60) || 'import';
  return { csv: toCsv(columns, data), fileName: `${base}-${all ? 'all-rows' : 'problems'}.csv` };
}

/** Runs of this process, so a shutdown can let them finish their rows (drainImports). */
const activeRuns = new Set<Promise<unknown>>();
let draining = false;
function trackRun<T>(run: Promise<T>): Promise<T> {
  activeRuns.add(run);
  void run.finally(() => activeRuns.delete(run)).catch(() => undefined);
  return run;
}

/**
 * Shutdown: running imports start no new row; the rows being saved finish (each in its own
 * transaction) and each import is left "interrupted", to be resumed at once instead of after
 * the stall timeout. Waits at most `timeoutMs`; a row still running then is rolled back by its
 * transaction when the process exits, and the import is resumed as after a crash.
 */
export async function drainImports(timeoutMs: number) {
  draining = true;
  if (!activeRuns.size) return;
  await Promise.race([Promise.allSettled([...activeRuns]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

/** Test hook: accept work again after drainImports(). */
export const _undrainForTests = () => {
  draining = false;
};

/**
 * On startup: imports whose run has stopped sending heartbeats can be resumed (or are cancelled,
 * if a stop was requested). A run that is still alive (in another process) keeps its import.
 */
export async function recoverInterruptedImports() {
  const res = await settleStaleRuns({}, true);
  if (res.interrupted) logger.warn({ count: res.interrupted }, 'Marked interrupted imports');
  if (res.cancelled) logger.warn({ count: res.cancelled }, 'Cancelled stopped imports whose stop was requested');
  // Row preparation that stopped with the server: the file is gone, so the import has failed.
  const stalled = await ImportJob.find({
    status: 'staging',
    $or: [{ heartbeatAt: { $lt: staleBefore() } }, { heartbeatAt: null }],
  })
    .setOptions({ crossTenant: true })
    .select('_id schoolId')
    .lean();
  for (const j of stalled) {
    await ImportRow.deleteMany({ schoolId: j.schoolId, jobId: j._id });
    await ImportJob.updateOne(
      { schoolId: j.schoolId, _id: j._id, status: 'staging' },
      { $set: { status: 'failed', error: STAGING_FAILED, finishedAt: new Date() } },
    );
  }
  if (stalled.length) logger.warn({ count: stalled.length }, 'Marked imports whose rows were being prepared as failed');
  // A check that stopped with the server changed nothing outside the import: it can be run again.
  const checks = await ImportJob.updateMany(
    { status: 'checking', $or: [{ heartbeatAt: { $lt: staleBefore() } }, { heartbeatAt: null }] },
    { $set: { status: 'analyzed', error: CHECK_STOPPED, runnerId: null, heartbeatAt: null, summary: null } },
  ).setOptions({ crossTenant: true });
  if (checks.modifiedCount) logger.warn({ count: checks.modifiedCount }, 'Marked stopped import checks');
}

/** Test hook: run the processing loop directly (simulates a second process). */
export const _processJobForTests = (ctx: Ctx, id: string, runnerId: string) =>
  loadJob(ctx, id).then((job) => processJob(ctx, job, runnerId));

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Partial<T>;
}
