import { monitorEventLoopDelay } from 'node:perf_hooks';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Section } from '../src/modules/academics/academics.models';
import { readSpreadsheet } from '../src/modules/imports/import-files';
import {
  closeSpreadsheetReaders,
  READER_LIMITS,
  readSpreadsheetInWorker,
} from '../src/modules/imports/spreadsheet-reader';
import { buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';
import { waitChecked, waitStaged } from './import-helpers';

/**
 * Does reading a large spreadsheet freeze the API for everyone else?
 *
 * Method (documented so the numbers can be compared over time):
 * - The file is the largest an import accepts in practice: 5,000 rows × 50 columns of text
 *   (250,000 cells, about 1.4 MB as .xlsx). It is built before any measurement starts.
 * - Node's own event-loop delay histogram (perf_hooks.monitorEventLoopDelay, 10 ms resolution)
 *   records the longest time the main thread could not run other work.
 * - While the upload is in flight, a liveness request (GET /health, no database) is sent every
 *   50 ms through the same app, and the slowest response is recorded: this is what another user
 *   of the school app would feel.
 * - Control: the same file read directly on the main thread, measured the same way, shows how
 *   much the method detects when parsing does block.
 * The thresholds are generous on purpose (the CI machine may be slow); the control must show a
 * clearly larger stall than the API upload, otherwise the test proves nothing and fails.
 */
const t = useTestApp();
let s: SchoolFixture;
let big: Buffer;

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 1 });
  await Section.updateMany({ schoolId: s.schoolId }, { $set: { capacity: 200 } });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['Student Name', 'Gender', 'Class', 'Section', ...Array.from({ length: 46 }, (_, i) => `Extra ${i + 1}`)]);
  for (let r = 0; r < 4999; r++)
    ws.addRow([
      `Load Kid${r}`,
      r % 2 ? 'Male' : 'Female',
      'Class 5',
      'A',
      ...Array.from({ length: 46 }, (_, i) => `v-${r}-${i}`),
    ]);
  big = Buffer.from(await wb.xlsx.writeBuffer());
}, 120_000);

async function measure<T>(work: () => Promise<T>) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  const pings: number[] = [];
  let done = false;
  h.enable();
  const pinger = (async () => {
    while (!done) {
      const t0 = performance.now();
      const res = await request(t.app).get('/health');
      expect(res.status).toBe(200);
      pings.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const result = await work();
  done = true;
  await pinger;
  h.disable();
  return { result, maxStallMs: h.max / 1e6, slowestPingMs: Math.max(...pings), pings: pings.length };
}

describe('Reading a large spreadsheet does not freeze the API', () => {
  it('uploading the largest accepted workbook keeps other requests responsive', async () => {
    expect(big.length).toBeLessThan(5 * 1024 * 1024);
    // Control: parsing on the main thread blocks it.
    const control = await measure(() => readSpreadsheet(big, 'big.xlsx'));
    expect(control.result.rows).toHaveLength(4999);

    // Upload plus the background saving of its rows, measured together.
    const api = await measure(async () => {
      const res = await request(t.app)
        .post('/api/v1/imports')
        .set(auth(s.ownerToken))
        .field('type', 'students')
        .attach('file', big, 'big.xlsx');
      if (res.status === 201) await waitStaged(t.app, s.ownerToken, res.body.data.job._id);
      return res;
    });
    expect(api.result.status).toBe(201);
    expect(api.result.body.data.job.totalRows).toBe(4999);

    console.info(
      `[event loop] main-thread parse: max stall ${control.maxStallMs.toFixed(0)} ms, slowest ping ${control.slowestPingMs.toFixed(0)} ms (${control.pings} pings); ` +
        `API upload: max stall ${api.maxStallMs.toFixed(0)} ms, slowest ping ${api.slowestPingMs.toFixed(0)} ms (${api.pings} pings)`,
    );
    // The method must detect the problem it is meant to catch (a clear main-thread stall).
    expect(control.maxStallMs).toBeGreaterThan(250);
    // The upload itself must not freeze the API.
    expect(api.maxStallMs).toBeLessThan(Math.min(300, control.maxStallMs / 2));
    expect(api.slowestPingMs).toBeLessThan(300);
    expect(api.pings).toBeGreaterThan(5);

    // Checking all 5,000 rows (the same work the run repeats first) must not freeze it either.
    const columns = api.result.body.data.columns as Array<{ column: number; field: string | null }>;
    const jobId = api.result.body.data.job._id;
    const checking = await measure(async () => {
      const started = await request(t.app)
        .post(`/api/v1/imports/${jobId}/check`)
        .set(auth(s.ownerToken))
        .send({ mapping: columns.map((c) => ({ column: c.column, field: c.column < 4 ? c.field : null })) });
      expect(started.status).toBe(200);
      // Checking runs in the background after the response: measured until it has finished.
      return waitChecked(t.app, s.ownerToken, jobId);
    });
    expect(checking.result.status).toBe('validated');
    expect(checking.result.summary.total).toBe(4999);
    console.info(
      `[event loop] checking 4,999 rows: max stall ${checking.maxStallMs.toFixed(0)} ms, slowest ping ${checking.slowestPingMs.toFixed(0)} ms (${checking.pings} pings)`,
    );
    expect(checking.maxStallMs).toBeLessThan(300);
    expect(checking.slowestPingMs).toBeLessThan(300);
  }, 180_000);
});

describe('Reader workers are a safety boundary', () => {
  it('a refused file gets the same message from the worker as before', async () => {
    const res = await request(t.app)
      .post('/api/v1/imports')
      .set(auth(s.ownerToken))
      .field('type', 'students')
      .attach('file', Buffer.from('not a workbook'), 'x.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'IMPORT_UNSUPPORTED_FILE',
      message: 'This file is not a real Excel (.xlsx) file',
    });
  });

  it('a read that takes too long, or needs too much memory, stops only its worker; the next read works', async () => {
    const saved = { ...READER_LIMITS };
    try {
      READER_LIMITS.READ_TIMEOUT_MS = 1;
      await expect(readSpreadsheetInWorker(big, 'big.xlsx')).rejects.toMatchObject({ message: /took too long/ });
      READER_LIMITS.READ_TIMEOUT_MS = saved.READ_TIMEOUT_MS;
      await closeSpreadsheetReaders();
      READER_LIMITS.WORKER_HEAP_MB = 16; // far below what the largest file needs
      await expect(readSpreadsheetInWorker(big, 'big.xlsx')).rejects.toMatchObject({ code: 'IMPORT_UNSUPPORTED_FILE' });
    } finally {
      Object.assign(READER_LIMITS, saved);
      await closeSpreadsheetReaders();
    }
    // The API process is unaffected and new workers read normally.
    expect((await request(t.app).get('/health')).status).toBe(200);
    expect((await readSpreadsheetInWorker(big, 'big.xlsx')).rows).toHaveLength(4999);
  }, 120_000);
});
