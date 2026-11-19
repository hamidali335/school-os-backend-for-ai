import type { Types } from 'mongoose';
import type { SchoolContext } from '../../../types/context';
import type { Parsed } from '../import-values';

export type ImportMode = 'create' | 'upsert';

export interface ImportOptions {
  /** create: add new records and skip existing ones; upsert: also update existing ones. */
  mode: ImportMode;
  /** Used for rows without a Campus column (schools with several campuses). */
  campusId?: string;
  /** Used for rows without a Session column. Default: the school's current session. */
  sessionId?: string;
  /** Section for rows without a Section column (students). */
  sectionName?: string;
  /** Skip rows that look like a student already in the system (same name and date of birth or parent phone). */
  skipPossibleDuplicates: boolean;
  /** Staff: create logins for teaching staff (as the staff form does). */
  createLogins: boolean;
  /** Staff attendance punches: the registered device the file was exported from. */
  deviceId?: string;
  /** Staff attendance punches: how to read dates like 03/04/2026 (auto: decided from the file). */
  dateOrder?: 'auto' | 'dmy' | 'mdy';
  /** Fees: the monthly fee head the Monthly Fee column sets (default: the school's tuition head). */
  feeHeadId?: string;
  /** Fees: the month (YYYY-MM) the previous dues are up to; billing in School OS starts after it. */
  duesUpTo?: string;
}

export const DEFAULT_OPTIONS: ImportOptions = { mode: 'create', skipPossibleDuplicates: true, createLogins: true };

export interface Issue {
  level: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export interface Change {
  field: string;
  from: string;
  to: string;
}

/** One data row: mapped field → raw cell text ('' when empty or unmapped). */
export interface RowIn {
  rowNo: number;
  cells: Record<string, string>;
  /** Identifier given to this row when it was processed before (resume after an interruption). */
  assignedKey?: string;
}

export type RowCheck = 'create' | 'update' | 'unchanged' | 'exists' | 'duplicate' | 'invalid';

export interface RowPlan<P = unknown> {
  rowNo: number;
  check: RowCheck;
  issues: Issue[];
  changes: Change[];
  /** What apply() needs (only for create/update). */
  payload?: P;
  /** Existing record (exists/update/unchanged). */
  existingId?: string;
  /** The record's identifier as it will be saved (admission no, employee no…), if known. */
  key?: string;
  /**
   * Other records this row creates or links to (parents by phone, email, CNIC…). Rows sharing
   * any of these, or the key, are saved one after another in file order (see RunHelper).
   */
  groupKeys?: string[];
}

export interface ApplyResult {
  result: 'created' | 'updated' | 'skipped';
  entityId?: string;
  message?: string;
}

export interface Processor<P = any> {
  plan(
    ctx: SchoolContext,
    rows: RowIn[],
    options: ImportOptions,
    meta?: { jobId: string },
  ): Promise<{
    rows: RowPlan<P>[];
    warnings: string[];
    /** Extra details saved with the check summary (e.g. how the dates of a punch file are read). */
    summary?: Record<string, unknown>;
  }>;
  apply(ctx: SchoolContext, plan: RowPlan<P>): Promise<ApplyResult>;
  /**
   * For a create row without an identifier: reserve one before processing, so a resumed import
   * recognises the record it already created instead of adding it twice.
   */
  assignKey?(ctx: SchoolContext, plan: RowPlan<P>): Promise<string | undefined>;
  /**
   * Reserve identifiers for `count` create rows at once, in file order (instead of assignKey
   * row by row). Saved on the rows before any of them is processed.
   */
  reserveKeys?(ctx: SchoolContext, count: number): Promise<string[]>;
  /**
   * Save rows in several lanes at once. Without it, rows are saved one at a time.
   * Called once per run, after the rows are checked again and before any is saved.
   */
  startRun?(ctx: SchoolContext, plans: RowPlan<P>[], opts: { lanes: number }): Promise<RunHelper<P>>;
  /**
   * The records this import added, as they are saved now, by kind (students: by status), read
   * back from the database when the import ends. Shown with the result, so "added" is never read
   * as "active" when some rows were saved as left or graduated.
   */
  resultBreakdown?(ctx: SchoolContext, entityIds: Types.ObjectId[]): Promise<Record<string, number>>;
  /**
   * A school-wide lock held for a whole run (taken before the run starts, renewed with each
   * heartbeat, released when the run ends), for kinds that must not run while something else
   * changes the same records (staff punches and undoing a punch import).
   */
  runLock?: {
    /** Take the lock or throw (409). */
    acquire(ctx: SchoolContext, holder: string): Promise<void>;
    /** Keep it; false when it was lost to another holder (the run then stops). */
    renew(ctx: SchoolContext, holder: string): Promise<boolean>;
    release(ctx: SchoolContext, holder: string): Promise<void>;
  };
}

/**
 * How a processor saves rows in parallel lanes safely:
 * - rows sharing a key (RowPlan.key, existingId or groupKeys) are in one group, saved in file
 *   order in one lane, so they meet the records saved by the rows before them, as one at a time;
 * - apply() keeps limits exact under parallel saving (e.g. the students import saves rows near a
 *   limit one at a time, see KeyedLocks);
 * - refresh() runs with every heartbeat: values reused between rows are re-read.
 */
export interface RunHelper<P = any> {
  apply(plan: RowPlan<P>): Promise<ApplyResult>;
  refresh(): Promise<void>;
  finish?(): Promise<void>;
}

/** Collects issues for one row while reading its cells. */
export class RowReader {
  issues: Issue[] = [];
  constructor(
    private row: RowIn,
    private label: (field: string) => string,
  ) {}

  get rowNo() {
    return this.row.rowNo;
  }

  raw(field: string) {
    return (this.row.cells[field] ?? '').trim();
  }

  has(field: string) {
    return this.raw(field) !== '';
  }

  /** Parse an optional cell; errors and notes are recorded against the field. */
  opt<T>(field: string, parse: (raw: string) => Parsed<T>): T | undefined {
    const raw = this.raw(field);
    if (!raw) return undefined;
    const r = parse(raw);
    if (!r.ok) {
      this.error(field, r.error);
      return undefined;
    }
    if (r.note) this.info(field, r.note);
    return r.value;
  }

  /** Parse a required cell. */
  req<T>(field: string, parse: (raw: string) => Parsed<T>, missing?: string): T | undefined {
    if (!this.has(field)) {
      this.error(field, missing ?? `${this.label(field)} is required`);
      return undefined;
    }
    return this.opt(field, parse);
  }

  error(field: string | undefined, message: string) {
    this.issues.push({ level: 'error', field, message: field ? `${this.label(field)}: ${message}` : message });
  }

  warn(field: string | undefined, message: string) {
    this.issues.push({ level: 'warning', field, message: field ? `${this.label(field)}: ${message}` : message });
  }

  info(field: string | undefined, message: string) {
    this.issues.push({ level: 'info', field, message: field ? `${this.label(field)}: ${message}` : message });
  }

  get failed() {
    return this.issues.some((i) => i.level === 'error');
  }
}

/** Split "First Middle Last" into first and last name at the last space (shown together everywhere). */
export function splitName(full: string): { firstName: string; lastName?: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export const show = (v: unknown) =>
  v === undefined || v === null || v === '' ? '—' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);

/**
 * Let other requests run every 250 rows of a long, purely in-memory loop (checking 5,000 rows is
 * otherwise one ~200 ms block). Safe: the loops only read data loaded before they start.
 */
export function breathe(i: number): Promise<void> | undefined {
  return i > 0 && i % 250 === 0 ? new Promise((resolve) => setImmediate(resolve)) : undefined;
}
