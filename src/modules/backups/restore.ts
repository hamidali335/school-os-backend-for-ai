import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { compareWithManifest, readArchive, type BackupManifest, type SchoolFinancials } from './archive';
import { keyId } from './backup-crypto';

/**
 * Offline verification and restore of a backup archive (no running API needed).
 *
 * Safety rules, all enforced here:
 * - The archive's SHA-256 must match the downloaded manifest before anything is decrypted.
 * - Decryption is authenticated; any change to the archive aborts before the database is touched.
 * - Entries are extracted only into a NEW private work folder (names validated by the tar reader:
 *   no absolute paths, `..`, links or devices), and the folder is deleted afterwards.
 * - Nothing inside an archive is ever executed.
 * - The target database must be EMPTY, and the operator must type its name (`confirmTarget`).
 * - The target storage folder must be empty or not exist; existing files are never overwritten.
 */
const EJSON = mongoose.mongo.BSON.EJSON;

export interface Check {
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  manifest: BackupManifest | null;
  checks: Check[];
}

async function sha256File(file: string) {
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c as Buffer);
  return hash.digest('hex');
}

function readExternalManifest(file?: string): BackupManifest | null {
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest;
}

/** Checks archive checksum (no key needed), then decrypts and checks every entry. */
export async function verifyBackup(opts: {
  archive: string;
  manifest?: string;
  key: Buffer;
  extractTo?: string;
}): Promise<VerifyResult> {
  const checks: Check[] = [];
  const external = readExternalManifest(opts.manifest);
  if (external?.archive) {
    const st = await fs.promises.stat(opts.archive);
    const sum = await sha256File(opts.archive);
    const ok = sum === external.archive.sha256 && st.size === external.archive.sizeBytes;
    checks.push({
      name: 'archive checksum matches manifest',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? sum : 'SHA-256 or size differs: corrupted or incomplete download',
    });
    if (!ok) return { ok: false, manifest: external, checks };
  }

  if (external && external.encryption.keyId !== keyId(opts.key)) {
    checks.push({
      name: 'encryption key',
      status: 'FAIL',
      detail: `backup needs key ${external.encryption.keyId}, given ${keyId(opts.key)}`,
    });
    return { ok: false, manifest: external, checks };
  }

  let extractRoot: string | null = null;
  if (opts.extractTo) {
    extractRoot = path.resolve(opts.extractTo);
    if (fs.existsSync(extractRoot)) throw new Error(`Work folder already exists: ${extractRoot}`);
    await fs.promises.mkdir(extractRoot, { recursive: true, mode: 0o700 });
  }
  try {
    const read = await readArchive(opts.archive, opts.key, async (entry, data) => {
      if (!extractRoot) return void (await drain(data));
      const target = path.resolve(extractRoot, entry.name);
      if (!target.startsWith(extractRoot + path.sep))
        throw new Error(`Refusing to extract outside the work folder: ${entry.name}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
        out.on('error', reject);
        out.on('finish', () => resolve());
        data.on('error', reject);
        data.pipe(out);
      });
    });
    checks.push({ name: 'decryption and authentication', status: 'PASS' });
    const problems = compareWithManifest(read.entries, read.manifest);
    checks.push({
      name: 'every entry matches its checksum',
      status: problems.length ? 'FAIL' : 'PASS',
      detail: problems.length ? problems.slice(0, 5).join('; ') : `${read.entries.size} entries`,
    });
    if (external) {
      const same = external.backupId === read.manifest.backupId;
      checks.push({ name: 'downloaded manifest belongs to this archive', status: same ? 'PASS' : 'FAIL' });
    }
    return { ok: checks.every((c) => c.status === 'PASS'), manifest: read.manifest, checks };
  } catch (err) {
    checks.push({ name: 'decryption and authentication', status: 'FAIL', detail: (err as Error).message });
    if (extractRoot) await fs.promises.rm(extractRoot, { recursive: true, force: true });
    return { ok: false, manifest: external, checks };
  }
}

async function drain(stream: NodeJS.ReadableStream) {
  for await (const _ of stream) void _;
}

function dbNameOf(uri: string): string {
  const afterHosts = uri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, '');
  return afterHosts.replace(/^\//, '').split('?')[0];
}

export interface RestoreOptions {
  archive: string;
  manifest?: string;
  key: Buffer;
  targetUri: string;
  /** Must equal the database name in targetUri. */
  confirmTarget: string;
  storageDir: string;
  workDir: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface RestoreReport {
  ok: boolean;
  backupId: string | null;
  targetDatabase: string;
  durationMs: number;
  checks: Check[];
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const dbName = dbNameOf(opts.targetUri);
  const report: RestoreReport = { ok: false, backupId: null, targetDatabase: dbName, durationMs: 0, checks: [] };
  const fail = (name: string, detail: string) => {
    report.checks.push({ name, status: 'FAIL', detail });
    report.durationMs = Date.now() - started;
    return report;
  };
  if (!dbName) return fail('target database', 'the target URI must name a database, e.g. mongodb://host/school_os');
  if (!opts.manifest) return fail('downloaded manifest', 'give the .manifest.json downloaded with the archive');
  if (opts.confirmTarget !== dbName)
    return fail('target confirmation', `type the target database name (${dbName}) to confirm`);

  const storageDir = path.resolve(opts.storageDir);
  if (fs.existsSync(storageDir) && (await fs.promises.readdir(storageDir)).length)
    return fail('target storage folder is empty', `${storageDir} is not empty; restore into an empty folder`);

  const client = new mongoose.mongo.MongoClient(opts.targetUri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).filter(
      (c) => !c.name.startsWith('system.'),
    );
    for (const c of existing) {
      if ((await db.collection(c.name).estimatedDocumentCount()) > 0)
        return fail(
          'target database is empty',
          `${dbName} already contains data (${c.name}); restore into a new database`,
        );
    }
    report.checks.push({ name: 'target database is empty', status: 'PASS' });

    log('Verifying and extracting archive...');
    const work = path.resolve(opts.workDir);
    const verified = await verifyBackup({
      archive: opts.archive,
      manifest: opts.manifest,
      key: opts.key,
      extractTo: work,
    });
    report.checks.push(...verified.checks);
    const manifest = verified.manifest;
    report.backupId = manifest?.backupId ?? null;
    if (!manifest || !verified.ok) {
      await fs.promises.rm(work, { recursive: true, force: true });
      return fail('archive verified', 'verification failed; nothing was restored');
    }
    if (opts.dryRun) {
      await fs.promises.rm(work, { recursive: true, force: true });
      report.ok = true;
      report.durationMs = Date.now() - started;
      log('Dry run: archive verified, nothing restored.');
      return report;
    }

    try {
      // Database: collections with their options, documents, then indexes.
      for (const c of manifest.collections) {
        log(`Restoring ${c.name} (${c.documents} documents)`);
        const { autoIndexId: _a, ...options } = c.options as Record<string, unknown>;
        await db.createCollection(c.name, options as any).catch((err) => {
          if ((err as { codeName?: string }).codeName !== 'NamespaceExists') throw err;
        });
        const coll = db.collection(c.name);
        let batch: any[] = [];
        const rl = readline.createInterface({
          input: fs.createReadStream(path.join(work, c.file)),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line) continue;
          batch.push(EJSON.parse(line, { relaxed: false }));
          if (batch.length >= 1000) {
            await coll.insertMany(batch, { ordered: true });
            batch = [];
          }
        }
        if (batch.length) await coll.insertMany(batch, { ordered: true });
        for (const idx of c.indexes) {
          if (idx.name === '_id_') continue;
          const { v: _v, ns: _ns, key, ...rest } = idx as any;
          await coll.createIndex(key, rest);
        }
      }

      // Files: moved from the verified work folder into the (empty) storage folder.
      log(`Restoring ${manifest.files.count} files`);
      await fs.promises.mkdir(storageDir, { recursive: true, mode: 0o700 });
      for (const f of manifest.files.entries) {
        const from = path.join(work, 'files', f.key);
        const to = path.resolve(storageDir, f.key);
        if (!to.startsWith(storageDir + path.sep)) throw new Error(`Unsafe storage key ${f.key}`);
        await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(to, 0o600).catch(() => undefined);
      }
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true });
    }

    log('Checking the restored data...');
    report.checks.push(...(await verifyRestored(db, manifest, storageDir)));
    report.ok = report.checks.every((c) => c.status === 'PASS');
    report.durationMs = Date.now() - started;
    return report;
  } finally {
    await client.close();
  }
}

/** Independent re-computation from the restored database, compared with the backup manifest. */
export async function verifyRestored(
  db: mongoose.mongo.Db,
  manifest: BackupManifest,
  storageDir: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const countProblems: string[] = [];
  const indexProblems: string[] = [];
  for (const c of manifest.collections) {
    const n = await db.collection(c.name).countDocuments({});
    if (n !== c.documents) countProblems.push(`${c.name}: ${n} != ${c.documents}`);
    const names = new Set((await db.collection(c.name).listIndexes().toArray()).map((i) => i.name));
    for (const idx of c.indexes) if (!names.has(idx.name as string)) indexProblems.push(`${c.name}.${idx.name}`);
  }
  checks.push({
    name: 'document counts per collection',
    status: countProblems.length ? 'FAIL' : 'PASS',
    detail: countProblems.join('; ') || `${manifest.collections.length} collections`,
  });
  checks.push({
    name: 'indexes and unique constraints',
    status: indexProblems.length ? 'FAIL' : 'PASS',
    detail: indexProblems.join('; ') || undefined,
  });

  // Financial totals per school, recomputed with aggregations (not from the archive files).
  const fin: Record<string, SchoolFinancials> = {};
  const blank = (): SchoolFinancials => ({
    invoices: 0,
    invoiceTotal: 0,
    invoicePaid: 0,
    invoiceBalance: 0,
    invoiceWaiver: 0,
    validPayments: 0,
    validPaymentAmount: 0,
    reversedPayments: 0,
  });
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const r of await db
    .collection('invoices')
    .aggregate([
      {
        $group: {
          _id: '$schoolId',
          n: { $sum: 1 },
          t: { $sum: '$total' },
          p: { $sum: '$paid' },
          b: { $sum: '$balance' },
          w: { $sum: '$waiver' },
        },
      },
    ])
    .toArray()) {
    const f = (fin[String(r._id)] ??= blank());
    Object.assign(f, {
      invoices: r.n,
      invoiceTotal: round(r.t),
      invoicePaid: round(r.p),
      invoiceBalance: round(r.b),
      invoiceWaiver: round(r.w),
    });
  }
  for (const r of await db
    .collection('payments')
    .aggregate([
      {
        $group: {
          _id: { s: '$schoolId', rev: { $eq: ['$status', 'reversed'] } },
          n: { $sum: 1 },
          a: { $sum: '$amount' },
        },
      },
    ])
    .toArray()) {
    const f = (fin[String(r._id.s)] ??= blank());
    if (r._id.rev) f.reversedPayments = r.n;
    else Object.assign(f, { validPayments: r.n, validPaymentAmount: round(r.a) });
  }
  const finProblems: string[] = [];
  const schools = new Set([...Object.keys(fin), ...Object.keys(manifest.integrity.financials)]);
  for (const s of schools) {
    const a = fin[s] ?? blank();
    const b = manifest.integrity.financials[s] ?? blank();
    for (const k of Object.keys(b) as Array<keyof SchoolFinancials>)
      if (a[k] !== b[k]) finProblems.push(`school ${s} ${k}: ${a[k]} != ${b[k]}`);
  }
  checks.push({
    name: 'financial totals (invoices, payments, balances, waivers) per school',
    status: finProblems.length ? 'FAIL' : 'PASS',
    detail: finProblems.slice(0, 5).join('; ') || `${schools.size} school(s)`,
  });

  const roles: Record<string, number> = {};
  for (const r of await db
    .collection('users')
    .aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }])
    .toArray())
    roles[String(r._id)] = r.n;
  const roleProblems = [...new Set([...Object.keys(roles), ...Object.keys(manifest.integrity.usersByRole)])].filter(
    (r) => (roles[r] ?? 0) !== (manifest.integrity.usersByRole[r] ?? 0),
  );
  checks.push({
    name: 'accounts per role',
    status: roleProblems.length ? 'FAIL' : 'PASS',
    detail: roleProblems.join(', ') || undefined,
  });

  const [g] = await db
    .collection('students')
    .aggregate([{ $group: { _id: null, n: { $sum: { $size: { $ifNull: ['$guardians', []] } } } } }])
    .toArray();
  const links = g?.n ?? 0;
  checks.push({
    name: 'parent–child (guardian) links',
    status: links === manifest.integrity.guardianLinks ? 'PASS' : 'FAIL',
    detail: `${links} vs ${manifest.integrity.guardianLinks}`,
  });

  const fileProblems: string[] = [];
  for (const f of manifest.files.entries) {
    const full = path.join(storageDir, f.key);
    if (!fs.existsSync(full)) fileProblems.push(`missing ${f.key}`);
    else if ((await sha256File(full)) !== f.sha256) fileProblems.push(`checksum ${f.key}`);
  }
  const metas = await db
    .collection('fileobjects')
    .find({}, { projection: { storageKey: 1, sha256: 1 } })
    .toArray();
  for (const m of metas) {
    const full = path.join(storageDir, String(m.storageKey));
    if (!fs.existsSync(full)) fileProblems.push(`metadata without file ${m.storageKey}`);
    else if (m.sha256 && (await sha256File(full)) !== m.sha256)
      fileProblems.push(`content differs from upload checksum ${m.storageKey}`);
  }
  checks.push({
    name: 'private files present and unchanged (vs. manifest and upload checksums)',
    status: fileProblems.length ? 'FAIL' : 'PASS',
    detail: fileProblems.slice(0, 5).join('; ') || `${manifest.files.count} files, ${metas.length} metadata records`,
  });
  return checks;
}
