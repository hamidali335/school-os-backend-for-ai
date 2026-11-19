import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { logger } from '../../config/logger';

/**
 * bcryptjs is pure JavaScript: a cost-12 hash takes hundreds of milliseconds of CPU. Run on the
 * main thread, a burst of logins freezes every other request (measured: ~800 ms event-loop
 * stalls with only 5 concurrent logins). This pool runs bcrypt in worker threads instead, with
 * the same hash format, so existing password hashes keep working.
 */

// Plain CommonJS so it runs as an eval worker under both tsx (dev) and node (dist).
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', async (m) => {
  try {
    const result = m.op === 'hash' ? await bcrypt.hash(m.plain, m.rounds) : await bcrypt.compare(m.plain, m.hash);
    parentPort.postMessage({ id: m.id, result });
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
});
`;

type Task = { id: number; op: 'hash' | 'compare'; plain: string; rounds?: number; hash?: string };
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

const SIZE = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
const MAX_QUEUE = 500;

class HasherPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Task[] = [];
  private pending = new Map<number, Pending>();
  private running = new Map<Worker, number>();
  private seq = 0;
  private closing = false;

  private spawn() {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } });
    w.unref();
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      this.running.delete(w);
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      this.idle.push(w);
      this.drain();
    });
    const fail = (err: Error) => {
      // A crashed worker fails only its own task; it is replaced so the pool keeps working.
      logger.error({ err }, 'Password worker failed');
      const id = this.running.get(w);
      if (id !== undefined) {
        this.pending.get(id)?.reject(err);
        this.pending.delete(id);
      }
      this.running.delete(w);
      this.workers = this.workers.filter((x) => x !== w);
      this.idle = this.idle.filter((x) => x !== w);
      this.drain();
    };
    w.on('error', fail);
    w.on('exit', (code) => code !== 0 && !this.closing && fail(new Error(`Password worker exited with code ${code}`)));
    this.workers.push(w);
    this.idle.push(w);
  }

  private drain() {
    while (this.queue.length) {
      if (!this.idle.length && this.workers.length < SIZE) this.spawn();
      const w = this.idle.pop();
      if (!w) return;
      const task = this.queue.shift()!;
      this.running.set(w, task.id);
      w.postMessage(task);
    }
  }

  run<T>(task: Omit<Task, 'id'>): Promise<T> {
    if (this.queue.length >= MAX_QUEUE) return Promise.reject(new Error('Password hashing queue is full'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.queue.push({ ...task, id });
      this.drain();
    });
  }

  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
    this.closing = false;
  }
}

const pool = new HasherPool();

export const hashInWorker = (plain: string, rounds: number) => pool.run<string>({ op: 'hash', plain, rounds });
export const compareInWorker = (plain: string, hash: string) => pool.run<boolean>({ op: 'compare', plain, hash });
export const closeHasherPool = () => pool.close();
