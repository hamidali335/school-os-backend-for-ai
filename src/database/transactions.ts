import mongoose from 'mongoose';
import { logger } from '../config/logger';

/**
 * Multi-document atomicity for workflows that write several related documents (payment +
 * invoice + receipt number, school + campus + Admin, admission + parents + logins, ...).
 *
 * MongoDB transactions need a replica set (a single-node replica set is enough) or a sharded
 * cluster; MongoDB Atlas always qualifies. On such a deployment `atomic()` runs the work in a
 * transaction: either every write commits or none does, including when the process is killed
 * half-way. With `transactionAsyncLocalStorage` Mongoose passes the session to every model
 * operation inside the callback automatically, so service code needs no session plumbing.
 *
 * On a standalone server (development, tests, or an explicitly allowed production setup) the
 * callback runs directly and the existing compensating rollbacks apply. Those cover thrown
 * errors but NOT a crash between writes — see docs/audit/DATA_INTEGRITY_TESTS.md.
 *
 * The callback may be retried on transient transaction errors, so it must not have external
 * side effects (messages, HTTP calls, file writes that are not cleaned up) — do those after
 * `atomic()` returns. Database operations inside it must run one after another: a transaction
 * cannot run operations in parallel (no `Promise.all` over queries).
 */
mongoose.set('transactionAsyncLocalStorage', true);

let supported: boolean | null = null;
let topology: 'standalone' | 'replicaSet' | 'sharded' | 'unknown' = 'unknown';

export async function detectTopology(): Promise<typeof topology> {
  const db = mongoose.connection.db;
  if (!db) return 'unknown';
  try {
    const hello = await db.admin().command({ hello: 1 });
    topology = hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replicaSet' : 'standalone';
  } catch (err) {
    logger.warn({ err }, 'Could not determine MongoDB topology');
    topology = 'unknown';
  }
  supported = topology === 'replicaSet' || topology === 'sharded';
  return topology;
}

export function mongoTopology() {
  return topology;
}

export function transactionsSupported(): boolean {
  return supported === true;
}

/** True while running inside an `atomic()` transaction. */
export function inTransaction(): boolean {
  return Boolean((mongoose as any).transactionAsyncLocalStorage?.getStore()?.session);
}

export async function atomic<T>(fn: () => Promise<T>): Promise<T> {
  if (supported === null) await detectTopology();
  if (!supported || inTransaction()) return fn();
  return mongoose.connection.transaction(() => fn());
}

/**
 * Production refuses a standalone server unless explicitly allowed: without transactions a
 * crash between two writes of a payment can leave the invoice balance changed with no payment.
 */
export function assertSupportedTopology(opts: { production: boolean; allowStandalone?: boolean }, topo = topology) {
  if (opts.production && !opts.allowStandalone && topo === 'standalone') {
    throw new Error(
      'MongoDB is a standalone server: payments, admissions and onboarding cannot be written atomically. ' +
        'Use a replica set (a single-node replica set is enough; MongoDB Atlas qualifies) or set ALLOW_STANDALONE_MONGODB=true to accept the risk.',
    );
  }
}
