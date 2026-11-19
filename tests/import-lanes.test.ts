import { describe, expect, it } from 'vitest';
import { groupByKeys, IMPORT_LANES, KeyedLocks, runInLanes } from '../src/modules/imports/import-lanes';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Import lanes: grouping', () => {
  it('rows sharing any key are one group, in file order; groups follow their first row', () => {
    const rows = [
      { rowNo: 2, keys: ['phone:1'] },
      { rowNo: 3, keys: ['phone:2'] },
      { rowNo: 4, keys: ['phone:1', 'phone:3'] }, // joins row 2's family and the mother's number
      { rowNo: 5, keys: ['phone:3'] },
      { rowNo: 6, keys: [] },
      { rowNo: 7, keys: ['email:x', 'phone:2'] },
    ];
    const groups = groupByKeys(rows, (r) => r.keys).map((g) => g.map((r) => r.rowNo));
    expect(groups).toEqual([[2, 4, 5], [3, 7], [6]]);
  });

  it('keeps file order inside a group even when the rows arrive out of order', () => {
    const rows = [5, 2, 9, 3].map((rowNo) => ({ rowNo }));
    expect(groupByKeys(rows, () => ['same']).map((g) => g.map((r) => r.rowNo))).toEqual([[2, 3, 5, 9]]);
  });
});

describe('Import lanes: running', () => {
  it('never runs more than the lanes asked for, nor more than the maximum', async () => {
    for (const lanes of [1, 4, 50]) {
      let now = 0;
      let peak = 0;
      const groups = Array.from({ length: 40 }, (_, i) => [i]);
      await runInLanes(
        groups,
        lanes,
        async () => {
          peak = Math.max(peak, ++now);
          await tick();
          now--;
        },
        () => false,
      );
      expect(peak).toBe(Math.min(lanes, IMPORT_LANES.MAX));
    }
  });

  it('a group is worked one row after another, in order', async () => {
    const seen: number[] = [];
    let busy = false;
    await runInLanes(
      [[1, 2, 3, 4], [10], [20]],
      4,
      async (n) => {
        if (n < 10) {
          expect(busy).toBe(false); // never two rows of the group at once
          busy = true;
          await tick();
          busy = false;
          seen.push(n);
        }
      },
      () => false,
    );
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('stops starting rows when asked; rows already started finish', async () => {
    let started = 0;
    let finished = 0;
    let stop = false;
    await runInLanes(
      Array.from({ length: 100 }, (_, i) => [i]),
      4,
      async () => {
        started++;
        if (started === 6) stop = true;
        await tick();
        finished++;
      },
      () => stop,
    );
    expect(finished).toBe(started);
    expect(started).toBeLessThanOrEqual(6 + 3);
  });

  it('an unexpected error stops the other lanes and is reported once they have finished', async () => {
    let running = 0;
    let after = 0;
    const err = new Error('database down');
    await expect(
      runInLanes(
        Array.from({ length: 50 }, (_, i) => [i]),
        4,
        async (i) => {
          running++;
          await tick();
          if (i === 3) throw err;
          running--;
          if (i > 10) after++;
        },
        () => false,
      ),
    ).rejects.toBe(err);
    expect(running).toBe(1); // only the failed row did not finish normally; none left running
    expect(after).toBeLessThan(8);
  });
});

describe('Import lanes: locks', () => {
  it('shared holders run together; an exclusive holder runs alone and goes before later shared requests', async () => {
    const locks = new KeyedLocks();
    const log: string[] = [];
    let readers = 0;
    let writers = 0;
    const shared = (name: string) =>
      locks.run([{ key: 'limit' }], async () => {
        readers++;
        expect(writers).toBe(0);
        log.push(`${name}+`);
        await tick();
        log.push(`${name}-`);
        readers--;
      });
    const alone = (name: string) =>
      locks.run([{ key: 'limit', exclusive: true }], async () => {
        expect(readers).toBe(0);
        expect(writers).toBe(0);
        writers++;
        log.push(`${name}+`);
        await tick();
        log.push(`${name}-`);
        writers--;
      });
    const a = shared('a');
    const b = shared('b');
    const w = alone('w'); // waits for a and b
    const c = shared('c'); // asked after w: waits for w
    await Promise.all([a, b, w, c]);
    expect(log.indexOf('w+')).toBeGreaterThan(Math.max(log.indexOf('a-'), log.indexOf('b-')));
    expect(log.indexOf('c+')).toBeGreaterThan(log.indexOf('w-'));
    expect(log.indexOf('b+')).toBeLessThan(log.indexOf('a-')); // a and b together
  });

  it('several locks are taken in one order, so rows never wait for each other in a circle', async () => {
    const locks = new KeyedLocks();
    let done = 0;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        locks.run(
          i % 2
            ? [{ key: 'section:a', exclusive: true }, { key: 'limit' }]
            : [{ key: 'limit', exclusive: i % 4 === 0 }, { key: 'section:a' }],
          async () => {
            await tick();
            done++;
          },
        ),
      ),
    );
    expect(done).toBe(20);
  });

  it('a lock is released when its work fails', async () => {
    const locks = new KeyedLocks();
    await expect(
      locks.run([{ key: 'k', exclusive: true }], async () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    await expect(locks.run([{ key: 'k', exclusive: true }], async () => 'ok')).resolves.toBe('ok');
  });
});
