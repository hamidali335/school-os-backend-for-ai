import { parentPort } from 'node:worker_threads';
import { AppError } from '../../utils/errors';
import { readSpreadsheet } from './import-files';

/**
 * Worker-thread entry: reads one uploaded spreadsheet with exactly the same code and limits as
 * before (readSpreadsheet), so parsing and decompression never run on the API's main thread.
 * Started by spreadsheet-reader.ts; never imported by the API itself.
 */
type Task = { id: number; buffer: ArrayBuffer; fileName: string };

parentPort?.on('message', async (task: Task) => {
  try {
    const sheet = await readSpreadsheet(Buffer.from(task.buffer), task.fileName);
    parentPort!.postMessage({ id: task.id, sheet });
  } catch (err) {
    // Only the safe parts of an error cross back: the user-facing message of a refused file,
    // or nothing at all for anything unexpected.
    parentPort!.postMessage({
      id: task.id,
      error:
        err instanceof AppError
          ? { status: err.status, code: err.code, message: err.message, details: err.details }
          : { unexpected: true },
    });
  }
});
