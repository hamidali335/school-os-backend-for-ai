import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { logger } from '../../config/logger';
import { AppError, badRequest } from '../../utils/errors';
import type { ParsedSheet } from './import-files';

/**
 * Reads uploaded spreadsheets in worker threads, so a large workbook never freezes the API for
 * other users (parsing the largest accepted file takes ~1.5 s of CPU, with stalls of ~0.5 s on
 * the main thread). Same pattern as the password hasher (password-hasher.ts): a small pool of
 * reused, unref'd workers.
 *
 * Each worker is also a safety boundary: its heap is capped (WORKER_HEAP_MB) and a read that
 * takes longer than READ_TIMEOUT_MS is stopped. A file that would exhaust memory or time ends
 * that worker only; the API keeps running. All file checks and limits stay in readSpreadsheet,
 * which the worker calls unchanged.
 */
export const READER_LIMITS = {
  /** Workers in the pool: the same as the number of files read at once (MAX_PARALLEL_READS). */
  WORKERS: 2,
  WORKER_HEAP_MB: 384,
  READ_TIMEOUT_MS: 60_000,
};

// Compiled API (dist/*.js): the compiled worker. Development and tests (src/*.ts): the same
// TypeScript file through tsx, which already runs the API in development.
const ENTRY = path.join(__dirname, `spreadsheet-worker${path.extname(__filename) === '.ts' ? '.ts' : '.js'}`);
const EXEC_ARGV = ENTRY.endsWith('.ts') ? ['--require', require.resolve('tsx/cjs')] : [];

type Reply = {
  id: number;
  sheet?: ParsedSheet;
  error?: { status?: number; code?: string; message?: string; details?: unknown; unexpected?: boolean };
};
type Job = {
  id: number;
  resolve: (s: ParsedSheet) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  worker: Worker;
};

const idle: Worker[] = [];
let size = 0;
let seq = 0;
const running = new Map<Worker, Job>();

function spawn(): Worker {
  const w = new Worker(ENTRY, {
    execArgv: EXEC_ARGV,
    resourceLimits: { maxOldGenerationSizeMb: READER_LIMITS.WORKER_HEAP_MB },
  });
  w.unref();
  size++;
  w.on('message', (m: Reply) => {
    const job = running.get(w);
    if (!job || job.id !== m.id) return;
    clearTimeout(job.timer);
    running.delete(w);
    idle.push(w);
    if (m.sheet) job.resolve(m.sheet);
    else if (m.error && !m.error.unexpected && m.error.status)
      job.reject(
        new AppError(
          m.error.status,
          m.error.code ?? 'BAD_REQUEST',
          m.error.message ?? 'The file could not be read',
          m.error.details as never,
        ),
      );
    else job.reject(unreadable());
  });
  const gone = (err?: Error) => {
    size--;
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    const job = running.get(w);
    if (job) {
      clearTimeout(job.timer);
      running.delete(w);
      const outOfMemory = (err as { code?: string } | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      if (!outOfMemory) logger.error({ err }, 'Spreadsheet worker failed');
      job.reject(
        outOfMemory
          ? badRequest(
              'This file needs too much memory to read safely. Split it into smaller files',
              { field: 'file' },
              'IMPORT_UNSUPPORTED_FILE',
            )
          : unreadable(),
      );
    }
  };
  w.on('error', (err) => gone(err));
  w.on('exit', () => {
    if (size > 0 && (running.has(w) || idle.includes(w))) gone();
  });
  return w;
}

const unreadable = () =>
  badRequest(
    'The file could not be read. Open it in Excel, save it again, and retry',
    { field: 'file' },
    'IMPORT_UNSUPPORTED_FILE',
  );

/** Read a spreadsheet in a worker thread. Callers limit concurrency (withReadSlot). */
export function readSpreadsheetInWorker(buffer: Buffer, fileName: string): Promise<ParsedSheet> {
  const worker = idle.pop() ?? (size < READER_LIMITS.WORKERS ? spawn() : null);
  if (!worker)
    return Promise.reject(
      new AppError(429, 'IMPORT_BUSY', 'Other files are being read right now. Try again in a minute.'),
    );
  // Copy into a standalone ArrayBuffer (an upload buffer may share a larger pool) and hand it over.
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  const id = ++seq;
  return new Promise<ParsedSheet>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Too slow: stop this worker (the pool replaces it on the next read).
      running.delete(worker);
      size--;
      void worker.terminate();
      reject(
        badRequest(
          'Reading this file took too long. Split it into smaller files',
          { field: 'file' },
          'IMPORT_UNSUPPORTED_FILE',
        ),
      );
    }, READER_LIMITS.READ_TIMEOUT_MS);
    running.set(worker, { id, resolve, reject, timer, worker });
    worker.postMessage({ id, buffer: copy.buffer, fileName }, [copy.buffer]);
  });
}

/** Stop all reader workers (tests and shutdown). */
export async function closeSpreadsheetReaders() {
  const all = [...idle, ...running.keys()];
  idle.length = 0;
  running.clear();
  size = 0;
  await Promise.all(all.map((w) => w.terminate()));
}
