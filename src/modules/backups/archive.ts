import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { createDecryptStream, createEncryptStream } from './backup-crypto';
import { END_OF_ARCHIVE, padding, readTar, tarHeader, type TarEntry } from './tar';

/**
 * School OS backup archive, format version 1.
 *
 *   <name>.tar.gz.enc = AES-256-GCM( gzip( ustar ) )
 *     db/<collection>.ejson     one document per line, MongoDB Extended JSON v2 (canonical),
 *                                so ObjectIds, dates, decimals and longs round-trip exactly
 *     files/<storageKey>         private uploaded files, byte for byte
 *     manifest.json              last entry: everything below, with a checksum per entry
 *
 *   <name>.manifest.json  the same manifest plus the archive's own size and SHA-256, readable
 *                         without the key so a download can be checked with Get-FileHash.
 */
export const FORMAT = 'school-os-backup';
export const FORMAT_VERSION = 1;

export interface CollectionEntry {
  name: string;
  file: string;
  documents: number;
  bytes: number;
  sha256: string;
  options: Record<string, unknown>;
  indexes: Array<Record<string, unknown>>;
}

export interface FileEntry {
  key: string;
  size: number;
  sha256: string;
}

export interface SchoolFinancials {
  invoices: number;
  invoiceTotal: number;
  invoicePaid: number;
  invoiceBalance: number;
  invoiceWaiver: number;
  validPayments: number;
  validPaymentAmount: number;
  reversedPayments: number;
}

export interface BackupManifest {
  format: typeof FORMAT;
  formatVersion: number;
  backupId: string;
  type: 'full';
  createdAt: string;
  completedAt?: string;
  app: { name: string; version: string; gitCommit: string | null; node: string };
  database: {
    name: string;
    serverVersion: string;
    topology: string;
    consistency: 'snapshot' | 'write-freeze';
    snapshotClusterTime?: string;
  };
  encryption: { algorithm: 'AES-256-GCM'; keyId: string };
  collections: CollectionEntry[];
  files: { count: number; bytes: number; entries: FileEntry[]; skipped: string[]; referencedMissing: number };
  integrity: {
    /** Per school id; recomputed from the restored database to prove financial data is intact. */
    financials: Record<string, SchoolFinancials>;
    usersByRole: Record<string, number>;
    guardianLinks: number;
  };
  restore: {
    minimumMongoVersion: string;
    notes: string[];
  };
  /** Only in the downloadable manifest (an archive cannot contain its own checksum). */
  archive?: { fileName: string; sizeBytes: number; sha256: string };
}

export type ArchiveSource =
  { name: string; kind: 'path'; path: string; size: number } | { name: string; kind: 'buffer'; data: Buffer };

/** Hashing pass-through. */
export function hasher() {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest('hex'), bytes: () => bytes };
}

/**
 * Writes the encrypted archive. `entries` is consumed lazily; every file's size is checked
 * against what was actually read, and per-entry SHA-256s are reported through `onEntry`.
 */
export async function writeArchive(
  out: Writable,
  key: Buffer,
  entries: AsyncIterable<ArchiveSource>,
  onEntry: (name: string, sha256: string, size: number) => void,
): Promise<{ sha256: string; bytes: number }> {
  async function* tarStream() {
    for await (const e of entries) {
      if (e.kind === 'buffer') {
        yield tarHeader(e.name, e.data.length);
        yield e.data;
        yield padding(e.data.length);
        onEntry(e.name, crypto.createHash('sha256').update(e.data).digest('hex'), e.data.length);
        continue;
      }
      yield tarHeader(e.name, e.size);
      const hash = crypto.createHash('sha256');
      let read = 0;
      for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1024 * 1024 })) {
        const buf = chunk as Buffer;
        read += buf.length;
        if (read > e.size) throw new Error(`File changed while it was being backed up: ${e.name}`);
        hash.update(buf);
        yield buf;
      }
      if (read !== e.size) throw new Error(`File changed while it was being backed up: ${e.name}`);
      yield padding(e.size);
      onEntry(e.name, hash.digest('hex'), e.size);
    }
    yield END_OF_ARCHIVE;
  }
  const outHash = hasher();
  await pipeline(
    Readable.from(tarStream()),
    zlib.createGzip({ level: 6 }),
    createEncryptStream(key),
    outHash.stream,
    out,
  );
  return { sha256: outHash.digest(), bytes: outHash.bytes() };
}

export interface ReadEntryInfo {
  size: number;
  sha256: string;
  lines: number;
}

/**
 * Decrypts and reads an archive, hashing every entry. `onEntry` may consume the entry stream
 * (e.g. to extract it); whatever it does not read is hashed and discarded. Throws on any
 * corruption, wrong key, unsafe entry or authentication failure. Results must only be trusted
 * after this resolves (the GCM tag is checked at the very end).
 */
export async function readArchive(
  file: string,
  key: Buffer,
  onEntry?: (entry: TarEntry, data: Readable) => Promise<void>,
): Promise<{ entries: Map<string, ReadEntryInfo>; manifest: BackupManifest }> {
  const entries = new Map<string, ReadEntryInfo>();
  let manifestRaw: Buffer | null = null;
  const plain = new PassThrough({ highWaterMark: 1024 * 1024 });
  const decrypting = pipeline(fs.createReadStream(file), createDecryptStream(key), zlib.createGunzip(), plain);
  const reading = readTar(plain, async (entry) => {
    const hash = crypto.createHash('sha256');
    let lines = 0;
    const isManifest = entry.name === 'manifest.json';
    const chunks: Buffer[] = [];
    const tee = new PassThrough();
    const counting = (async () => {
      for await (const c of entry.stream) {
        const buf = c as Buffer;
        hash.update(buf);
        if (entry.name.startsWith('db/')) for (const b of buf) if (b === 10) lines++;
        if (isManifest) chunks.push(buf);
        if (!tee.write(buf)) await new Promise((r) => tee.once('drain', r));
      }
      tee.end();
    })();
    // onEntry must read `data` to the end (or the hashing above waits for it forever).
    const consumer = onEntry ? onEntry(entry, tee) : (async () => void tee.resume())();
    await Promise.all([counting, consumer]);
    entries.set(entry.name, { size: entry.size, sha256: hash.digest('hex'), lines });
    if (isManifest) manifestRaw = Buffer.concat(chunks);
  });
  try {
    await Promise.all([decrypting, reading]);
  } catch (err) {
    plain.destroy();
    await decrypting.catch(() => undefined);
    throw err;
  }
  if (!manifestRaw) throw new Error('Archive has no manifest.json');
  const manifest = JSON.parse((manifestRaw as Buffer).toString('utf8')) as BackupManifest;
  if (manifest.format !== FORMAT) throw new Error('Not a School OS backup');
  if (manifest.formatVersion > FORMAT_VERSION)
    throw new Error(`Backup format ${manifest.formatVersion} is newer than this software supports (${FORMAT_VERSION})`);
  return { entries, manifest };
}

/** Every entry the manifest lists is present with the same size and checksum, and nothing else. */
export function compareWithManifest(entries: Map<string, ReadEntryInfo>, manifest: BackupManifest): string[] {
  const problems: string[] = [];
  const expected = new Map<string, { size: number; sha256: string; documents?: number }>();
  for (const c of manifest.collections)
    expected.set(c.file, { size: c.bytes, sha256: c.sha256, documents: c.documents });
  for (const f of manifest.files.entries) expected.set(`files/${f.key}`, { size: f.size, sha256: f.sha256 });
  for (const [name, want] of expected) {
    const got = entries.get(name);
    if (!got) problems.push(`missing entry ${name}`);
    else if (got.size !== want.size || got.sha256 !== want.sha256) problems.push(`checksum mismatch for ${name}`);
    else if (want.documents !== undefined && got.lines !== want.documents)
      problems.push(`document count mismatch for ${name} (${got.lines} != ${want.documents})`);
  }
  for (const name of entries.keys())
    if (name !== 'manifest.json' && !expected.has(name)) problems.push(`unexpected entry ${name}`);
  return problems;
}

export function safeCollectionFile(name: string, index: number) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(name) ? `db/${name}.ejson` : `db/collection-${index}.ejson`;
}

/** Recursively lists regular files under `root` as posix keys (symlinks and others skipped). */
export async function listStorageFiles(
  root: string,
): Promise<{ files: Array<{ key: string; size: number }>; skipped: string[] }> {
  const files: Array<{ key: string; size: number }> = [];
  const skipped: string[] = [];
  async function walk(dir: string, prefix: string) {
    let names: fs.Dirent[];
    try {
      names = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && dir === root) return;
      throw err;
    }
    for (const d of names) {
      const key = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), key);
      else if (d.isFile() && /^[A-Za-z0-9._\-/]+$/.test(key) && !key.split('/').includes('..')) {
        const st = await fs.promises.lstat(path.join(dir, d.name));
        files.push({ key, size: st.size });
      } else skipped.push(key.replace(/[^\x20-\x7e]/g, '?').slice(0, 200));
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.key.localeCompare(b.key));
  return { files, skipped };
}
