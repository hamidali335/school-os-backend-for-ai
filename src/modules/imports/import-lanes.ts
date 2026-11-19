/**
 * Saving import rows in a few parallel lanes (see RunHelper in processors/types.ts).
 *
 * Every database operation of a row waits for a network round trip; over a slow connection a
 * row takes seconds, almost all of it waiting. Lanes let a few rows wait at the same time. They
 * are bounded (IMPORT_LANES), so an import uses at most that many database connections at once
 * for its rows (the pool has 20), plus one for the heartbeat.
 */

/** Lanes per import: 4 by default; never more than 8. */
export const IMPORT_LANES = { DEFAULT: 4, MAX: 8 };

/**
 * Rows that share any key end up in one group (union–find over the keys); each group keeps
 * file order, and groups are ordered by their first row.
 */
export function groupByKeys<T extends { rowNo: number }>(items: T[], keysOf: (item: T) => string[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const key of keysOf(item)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, T[]>();
  const order = items.map((item, i) => ({ item, i })).sort((a, b) => a.item.rowNo - b.item.rowNo);
  for (const { item, i } of order) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  }
  return [...groups.values()];
}

/** One named lock: held by any number of rows together (shared) or by one row alone (exclusive). */
class SharedLock {
  private readers = 0;
  private writer = false;
  private queue: Array<{ exclusive: boolean; grant: () => void }> = [];

  get idle() {
    return !this.writer && this.readers === 0 && this.queue.length === 0;
  }

  acquire(exclusive: boolean): Promise<void> {
    // A waiting exclusive request goes first: rows asking later for a shared hold wait behind it.
    if (!this.queue.length && !this.writer && (!exclusive || this.readers === 0)) {
      this.take(exclusive);
      return Promise.resolve();
    }
    return new Promise((grant) => this.queue.push({ exclusive, grant }));
  }

  release(exclusive: boolean) {
    if (exclusive) this.writer = false;
    else this.readers--;
    while (this.queue.length && !this.writer) {
      const next = this.queue[0];
      if (next.exclusive && this.readers > 0) break;
      this.queue.shift();
      this.take(next.exclusive);
      next.grant();
      if (next.exclusive) break;
    }
  }

  private take(exclusive: boolean) {
    if (exclusive) this.writer = true;
    else this.readers++;
  }
}

/**
 * Named locks held while a row is saved, shared or exclusive. A row asks for all its locks at
 * once; they are taken in sorted order, so rows can never wait for each other in a circle.
 */
export class KeyedLocks {
  private locks = new Map<string, SharedLock>();

  async run<T>(requests: Array<{ key: string; exclusive?: boolean }>, fn: () => Promise<T>): Promise<T> {
    const held: Array<{ key: string; lock: SharedLock; exclusive: boolean }> = [];
    const wanted = new Map<string, boolean>();
    for (const r of requests) wanted.set(r.key, Boolean(wanted.get(r.key) || r.exclusive));
    try {
      for (const key of [...wanted.keys()].sort()) {
        const exclusive = wanted.get(key)!;
        let lock = this.locks.get(key);
        if (!lock) this.locks.set(key, (lock = new SharedLock()));
        await lock.acquire(exclusive);
        held.push({ key, lock, exclusive });
      }
      return await fn();
    } finally {
      for (const { key, lock, exclusive } of held.reverse()) {
        lock.release(exclusive);
        if (lock.idle && this.locks.get(key) === lock) this.locks.delete(key);
      }
    }
  }
}

/**
 * Work through the groups with `lanes` workers: each worker takes the next group and saves its
 * rows one after another. No new row starts once `shouldStop()` is true or a row has thrown;
 * rows already started finish. The first error is thrown after every worker has stopped.
 */
export async function runInLanes<T>(
  groups: T[][],
  lanes: number,
  work: (item: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async () => {
    while (!failure && !shouldStop() && next < groups.length) {
      const group = groups[next++];
      for (const item of group) {
        if (failure || shouldStop()) return;
        try {
          await work(item);
        } catch (err) {
          failure ??= { err };
          return;
        }
      }
    }
  };
  const count = Math.max(1, Math.min(lanes, IMPORT_LANES.MAX, groups.length));
  await Promise.all(Array.from({ length: count }, worker));
  if (failure) throw failure.err;
}
