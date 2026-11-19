/**
 * Load-test only: starts the normal server and prints process metrics once a second on stderr
 * as `METRICS {json}` lines (event-loop delay, memory, CPU) for scripts/load-test/run.ts.
 * Never used in production.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();
setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - lastAt) / 1000;
  lastCpu = process.cpuUsage();
  lastAt = now;
  const m = process.memoryUsage();
  process.stderr.write(
    `METRICS ${JSON.stringify({
      t: Date.now(),
      elP50ms: h.percentile(50) / 1e6,
      elP99ms: h.percentile(99) / 1e6,
      elMaxMs: h.max / 1e6,
      rssMb: Math.round(m.rss / 1048576),
      heapUsedMb: Math.round(m.heapUsed / 1048576),
      cpuPct: Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10,
    })}\n`,
  );
  h.reset();
}, 1000).unref();

void import('../../src/server');
