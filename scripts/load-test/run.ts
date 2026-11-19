/**
 * Repeatable load test against a throwaway in-memory MongoDB with synthetic data.
 *
 *   npm run loadtest                 # stages 5, 20, 50 virtual users, 20 s each
 *   LOADTEST_STAGES=5,20 LOADTEST_SECONDS=10 npm run loadtest
 *
 * Never point this at production. The API runs in a separate process (same as production:
 * `src/server.ts`), with rate limits raised so the limiter does not mask capacity.
 * Results: docs/audit/load-test-results.json and a Markdown table on stdout.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const STAGES = (process.env.LOADTEST_STAGES ?? '5,20,50').split(',').map(Number);
const SECONDS = Number(process.env.LOADTEST_SECONDS ?? 20);
const STUDENTS_PER_SCHOOL = Number(process.env.LOADTEST_STUDENTS ?? 400);
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Load-Test-Pass-123';

type Sample = { name: string; ms: number; ok: boolean; status: number };

async function main() {
  const mongod = await MongoMemoryServer.create();
  const uri = `${mongod.getUri().replace(/\/?(\?.*)?$/, '/')}schoolos_loadtest`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    MONGODB_URI: uri,
    JWT_ACCESS_SECRET: crypto.randomBytes(32).toString('hex'),
    JWT_PLATFORM_SECRET: crypto.randomBytes(32).toString('hex'),
    BCRYPT_ROUNDS: '12',
    LOG_LEVEL: 'warn',
    SCHEDULER_ENABLED: 'false',
    API_DOCS_ENABLED: 'false',
    AI_PROVIDER: 'none',
    RATE_LIMIT_MAX: '100000000',
    AUTH_RATE_LIMIT_MAX: '10000000',
    STORAGE_DIR: './storage-test/loadtest',
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/load-test/server-with-metrics.ts'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const metrics: Array<Record<string, number>> = [];
  child.stderr.setEncoding('utf8');
  let buf = '';
  child.stderr.on('data', (d: string) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (l.startsWith('METRICS ')) metrics.push(JSON.parse(l.slice(8)));
      else if (l.trim()) process.stderr.write(`[server] ${l}\n`);
    }
  });
  try {
    await waitReady();
    // Seed through the backend's own code paths, connected to the same throwaway database.
    Object.assign(process.env, env);
    const { connectDatabase, disconnectDatabase } = await import('../../src/database/connection');
    const mongoose = (await import('mongoose')).default;
    await connectDatabase(uri);
    await mongoose.connection.syncIndexes();
    const seeded = await seed();
    await disconnectDatabase();

    const results: Record<string, unknown> = { environment: describeEnv(), seeded, stages: [] as unknown[] };
    // Login is deliberately expensive (bcrypt cost 12); measured on its own.
    for (const vus of STAGES.filter((v) => v <= 20)) {
      (results.stages as unknown[]).push(
        await stage(`login x${vus}`, vus, Math.min(SECONDS, 10), metrics, () => [
          ['auth.login', 'POST', '/api/v1/auth/login', undefined, { email: seeded.ownerEmail, password: PASSWORD }],
        ]),
      );
    }
    for (const vus of STAGES) {
      (results.stages as unknown[]).push(await stage(`mixed x${vus}`, vus, SECONDS, metrics, () => mix(seeded)));
    }
    const outDir = path.resolve('docs/audit');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'load-test-results.json'), JSON.stringify(results, null, 2));
    printTable(results.stages as StageResult[]);
  } finally {
    child.kill('SIGTERM');
    await mongod.stop();
  }
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/health/ready`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become ready');
}

async function call(token: string | undefined, method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
  return json?.data;
}

interface Seeded {
  ownerEmail: string;
  ownerToken: string;
  teacherToken: string;
  sectionIds: string[];
  studentIds: string[];
  today: string;
  schools: number;
  studentsPerSchool: number;
}

async function seed(): Promise<Seeded> {
  const { onboardSchool } = await import('../../src/modules/schools/schools.service');
  const { Plan } = await import('../../src/modules/subscriptions/plan.model');
  const { todayInTz } = await import('../../src/utils/dates');
  const today = todayInTz('Asia/Karachi');
  await Plan.updateOne(
    { code: 'loadtest' },
    {
      $set: {
        name: 'Load test',
        priceMonthlyPkr: 0,
        isActive: true,
        limits: { maxStudents: 5000, maxCampuses: 5, maxStaffUsers: 500, aiMonthlyTokens: 0, messagesPerMonth: 0 },
      },
    },
    { upsert: true },
  );
  let first: Seeded | undefined;
  for (let s = 0; s < 2; s++) {
    const code = `LT${s}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const ownerEmail = `admin.${code.toLowerCase()}@loadtest.example`;
    const r = await onboardSchool({
      name: `Load School ${s}`,
      code,
      planCode: 'loadtest',
      owner: { name: 'Load Admin', email: ownerEmail, password: PASSWORD },
    });
    const campusId = r.campus._id.toString();
    const t = (await call(undefined, 'POST', '/api/v1/auth/login', { email: ownerEmail, password: PASSWORD }))
      .accessToken as string;
    await call(t, 'PATCH', '/api/v1/school/settings', {
      accounts: { autoCreateParentLogins: false },
    });
    const session = await call(t, 'POST', '/api/v1/academics/sessions', {
      name: '2026-2027',
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });
    await call(t, 'POST', `/api/v1/academics/sessions/${session._id}/set-current`);
    const classes: string[] = [];
    const sections: string[] = [];
    for (let c = 1; c <= 10; c++) {
      const cls = await call(t, 'POST', '/api/v1/academics/classes', { campusId, name: `Class ${c}`, level: c });
      classes.push(cls._id);
      for (const n of ['A', 'B'])
        sections.push(
          (
            await call(t, 'POST', '/api/v1/academics/sections', {
              classId: cls._id,
              sessionId: session._id,
              name: n,
              capacity: 60,
            })
          )._id,
        );
    }
    const subjects: string[] = [];
    for (const [name, code2] of [
      ['English', 'ENG'],
      ['Urdu', 'URD'],
      ['Mathematics', 'MATH'],
      ['Science', 'SCI'],
      ['Islamiat', 'ISL'],
      ['Computer', 'COMP'],
    ])
      subjects.push((await call(t, 'POST', '/api/v1/academics/subjects', { name, code: code2 }))._id);
    const teachers: Array<{ _id: string; account?: { activation?: { token: string }; loginId: string } }> = [];
    for (let i = 0; i < 10; i++)
      teachers.push(
        await call(t, 'POST', '/api/v1/employees', {
          campusId,
          firstName: `Teacher${i}`,
          designation: 'Teacher',
          staffType: 'teaching',
        }),
      );
    for (let i = 0; i < sections.length; i++)
      for (let j = 0; j < subjects.length; j++)
        await call(t, 'POST', '/api/v1/academics/teaching-assignments', {
          sectionId: sections[i],
          subjectId: subjects[j],
          teacherId: teachers[(i + j) % 10]._id,
        });
    const studentIds: string[] = [];
    for (let i = 0; i < STUDENTS_PER_SCHOOL; i++) {
      const sec = i % sections.length;
      const st = await call(t, 'POST', '/api/v1/students', {
        campusId,
        firstName: `Student${i}`,
        lastName: 'Load',
        gender: i % 2 ? 'female' : 'male',
        sessionId: session._id,
        classId: classes[Math.floor(sec / 2)],
        sectionId: sections[sec],
        guardians: [
          {
            parent: { name: `Parent ${i}`, phone: `+92300${String(s * 100000 + i).padStart(7, '0')}` },
            isPrimary: true,
          },
        ],
      });
      studentIds.push(st._id);
    }
    const head = await call(t, 'POST', '/api/v1/fees/heads', {
      name: 'Tuition Fee',
      code: 'TUITION',
      frequency: 'monthly',
    });
    for (const cls of classes)
      await call(t, 'PUT', '/api/v1/fees/structures', {
        sessionId: session._id,
        classId: cls,
        name: 'Fees',
        items: [{ feeHeadId: head._id, amount: 5000 }],
      });
    await call(t, 'POST', '/api/v1/fees/invoices/generate', { period: today.slice(0, 7) });
    if (!first) {
      await call(undefined, 'POST', '/api/v1/auth/account-link/redeem', {
        token: teachers[0].account!.activation!.token,
        password: PASSWORD,
      });
      const teacherToken = (
        await call(undefined, 'POST', '/api/v1/auth/login', {
          username: teachers[0].account!.loginId,
          password: PASSWORD,
          schoolCode: code,
        })
      ).accessToken;
      first = {
        ownerEmail,
        ownerToken: t,
        teacherToken,
        sectionIds: sections,
        studentIds,
        today,
        schools: 2,
        studentsPerSchool: STUDENTS_PER_SCHOOL,
      };
    }
  }
  return first!;
}

type Req = [string, string, string, string | undefined, unknown?];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function mix(s: Seeded): Req[] {
  const sec = pick(s.sectionIds);
  const student = pick(s.studentIds);
  return [
    ['students.list', 'GET', `/api/v1/students?limit=25&q=Student${Math.floor(Math.random() * 40)}`, s.ownerToken],
    ['students.get', 'GET', `/api/v1/students/${student}`, s.ownerToken],
    ['dashboard.admin', 'GET', '/api/v1/dashboard', s.ownerToken],
    ['attendance.roster', 'GET', `/api/v1/attendance/sections/${sec}?date=${s.today}`, s.ownerToken],
    ['fees.invoices', 'GET', '/api/v1/fees/invoices?limit=25', s.ownerToken],
    ['homework.list.teacher', 'GET', '/api/v1/homework?limit=25', s.teacherToken],
    ['students.list.teacher', 'GET', '/api/v1/students?limit=25', s.teacherToken],
    ['onboarding.guide', 'GET', '/api/v1/onboarding', s.ownerToken],
  ];
}

interface StageResult {
  stage: string;
  vus: number;
  seconds: number;
  requests: number;
  throughputRps: number;
  errorRate: number;
  overall: { p50: number; p95: number; p99: number; max: number };
  byEndpoint: Record<string, { n: number; p50: number; p95: number; p99: number; errors: number }>;
  server: { eventLoopP99MaxMs: number; rssMaxMb: number; cpuAvgPct: number } | null;
  sampleErrors: string[];
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
const round = (n: number) => Math.round(n * 10) / 10;

async function stage(
  label: string,
  vus: number,
  seconds: number,
  metrics: Array<Record<string, number>>,
  reqs: () => Req[],
): Promise<StageResult> {
  const samples: Sample[] = [];
  const errors: string[] = [];
  const end = Date.now() + seconds * 1000;
  const startMetrics = metrics.length;
  const worker = async () => {
    while (Date.now() < end) {
      const [name, method, url, token, body] = pick(reqs());
      const t0 = performance.now();
      try {
        const res = await fetch(`${BASE}${url}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        await res.arrayBuffer();
        samples.push({ name, ms: performance.now() - t0, ok: res.ok, status: res.status });
        if (!res.ok && errors.length < 5) errors.push(`${name}: HTTP ${res.status}`);
      } catch (err) {
        samples.push({ name, ms: performance.now() - t0, ok: false, status: 0 });
        if (errors.length < 5) errors.push(`${name}: ${(err as Error).message}`);
      }
    }
  };
  const started = Date.now();
  await Promise.all(Array.from({ length: vus }, worker));
  const elapsed = (Date.now() - started) / 1000;
  const all = samples.map((x) => x.ms).sort((a, b) => a - b);
  const by: StageResult['byEndpoint'] = {};
  for (const name of [...new Set(samples.map((x) => x.name))]) {
    const xs = samples.filter((x) => x.name === name);
    const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
    by[name] = {
      n: xs.length,
      p50: round(pct(ms, 50)),
      p95: round(pct(ms, 95)),
      p99: round(pct(ms, 99)),
      errors: xs.filter((x) => !x.ok).length,
    };
  }
  const m = metrics.slice(startMetrics);
  return {
    stage: label,
    vus,
    seconds: round(elapsed),
    requests: samples.length,
    throughputRps: round(samples.length / elapsed),
    errorRate: samples.length ? round((samples.filter((x) => !x.ok).length / samples.length) * 100) : 0,
    overall: {
      p50: round(pct(all, 50)),
      p95: round(pct(all, 95)),
      p99: round(pct(all, 99)),
      max: round(all[all.length - 1] ?? 0),
    },
    byEndpoint: by,
    server: m.length
      ? {
          eventLoopP99MaxMs: round(Math.max(...m.map((x) => x.elP99ms))),
          rssMaxMb: Math.max(...m.map((x) => x.rssMb)),
          cpuAvgPct: round(m.reduce((a, x) => a + x.cpuPct, 0) / m.length),
        }
      : null,
    sampleErrors: errors,
  };
}

function describeEnv() {
  return {
    note: 'Single API process + in-memory MongoDB + load generator on the same machine. Not a production capacity figure.',
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: (require('node:os') as typeof import('node:os')).cpus().length,
    bcryptRounds: 12,
    rateLimits: 'raised for the test (would otherwise return 429)',
    startedAt: new Date().toISOString(),
  };
}

function printTable(stages: StageResult[]) {
  console.log('\n| Stage | VUs | Req | RPS | Err % | p50 ms | p95 ms | p99 ms | Server EL p99 ms | RSS MB | CPU % |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of stages)
    console.log(
      `| ${s.stage} | ${s.vus} | ${s.requests} | ${s.throughputRps} | ${s.errorRate} | ${s.overall.p50} | ${s.overall.p95} | ${s.overall.p99} | ${s.server?.eventLoopP99MaxMs ?? '–'} | ${s.server?.rssMaxMb ?? '–'} | ${s.server?.cpuAvgPct ?? '–'} |`,
    );
  const last = stages[stages.length - 1];
  if (last) {
    console.log(`\nPer endpoint at ${last.stage}:`);
    console.log('| Endpoint | n | p50 | p95 | p99 | errors |\n|---|---|---|---|---|---|');
    for (const [k, v] of Object.entries(last.byEndpoint))
      console.log(`| ${k} | ${v.n} | ${v.p50} | ${v.p95} | ${v.p99} | ${v.errors} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
