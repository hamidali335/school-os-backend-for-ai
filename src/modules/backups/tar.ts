import { Readable, Writable } from 'node:stream';

/**
 * Minimal POSIX ustar writer/reader for backup archives.
 *
 * Deliberately narrow: only regular files with server-generated relative names are written,
 * and the reader rejects anything else (symlinks, hard links, devices, absolute paths, `..`,
 * backslashes, duplicate names). That makes extraction safe by construction instead of relying
 * on a general-purpose tar implementation's filtering. Archives are standard ustar, so
 * `tar -tzf` (Linux, or `tar.exe` built into Windows 10+) can list them after decryption.
 */

const BLOCK = 512;
const MAX_ENTRY_BYTES = 8 * 1024 ** 3 - 1; // ustar size field: 11 octal digits

export function assertSafeEntryName(name: string): void {
  if (
    !name ||
    name.length > 255 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((p) => p === '' || p === '.' || p === '..') ||
    !/^[A-Za-z0-9._\-/]+$/.test(name)
  ) {
    throw new Error(`Unsafe archive entry name: ${JSON.stringify(name.slice(0, 80))}`);
  }
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function splitName(name: string): { name: string; prefix: string } {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const cut = name.lastIndexOf('/', 155);
  if (cut <= 0 || name.length - cut - 1 > 100) throw new Error(`Archive entry name too long: ${name.slice(0, 80)}`);
  return { name: name.slice(cut + 1), prefix: name.slice(0, cut) };
}

export function tarHeader(name: string, size: number, mtime = new Date()): Buffer {
  assertSafeEntryName(name);
  if (size < 0 || size > MAX_ENTRY_BYTES) throw new Error('Archive entry too large');
  const h = Buffer.alloc(BLOCK, 0);
  const parts = splitName(name);
  h.write(parts.name, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder
  h.write('0', 156, 1, 'ascii'); // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(parts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

export const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);
export const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2, 0);

export interface TarEntry {
  name: string;
  size: number;
  /** Stream of exactly `size` bytes. Must be fully consumed before the next entry is read. */
  stream: Readable;
}

function parseOctal(buf: Buffer): number {
  const s = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!/^[0-7]*$/.test(s)) throw new Error('Corrupt archive header');
  return s ? parseInt(s, 8) : 0;
}

/**
 * Reads a ustar stream entry by entry. `onEntry` receives each regular file; anything that is
 * not a regular file with a safe, unique name aborts the read with an error.
 */
export async function readTar(input: Readable, onEntry: (entry: TarEntry) => Promise<void>): Promise<number> {
  const seen = new Set<string>();
  let buffered = Buffer.alloc(0);
  let ended = false;
  const iterator = input[Symbol.asyncIterator]();

  async function fill(n: number): Promise<boolean> {
    while (buffered.length < n && !ended) {
      const next = await iterator.next();
      if (next.done) ended = true;
      else buffered = Buffer.concat([buffered, next.value as Buffer]);
    }
    return buffered.length >= n;
  }
  function take(n: number): Buffer {
    const out = buffered.subarray(0, n);
    buffered = buffered.subarray(n);
    return out;
  }

  let count = 0;
  for (;;) {
    if (!(await fill(BLOCK))) throw new Error('Archive is truncated (no end-of-archive marker)');
    const header = take(BLOCK);
    if (header.every((b) => b === 0)) return count; // end of archive
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== parseOctal(header.subarray(148, 156))) throw new Error('Corrupt archive header (checksum)');
    if (header.subarray(257, 262).toString('ascii') !== 'ustar') throw new Error('Unsupported archive format');
    const type = String.fromCharCode(header[156] || 48);
    if (type !== '0') throw new Error('Archive contains a non-regular file entry; refusing to extract');
    const base = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${base}` : base;
    assertSafeEntryName(name);
    if (seen.has(name)) throw new Error(`Archive contains a duplicate entry: ${name}`);
    seen.add(name);
    const size = parseOctal(header.subarray(124, 136));
    if (size > MAX_ENTRY_BYTES) throw new Error('Archive entry too large');

    let remaining = size;
    const stream = new Readable({
      async read() {
        try {
          if (remaining === 0) return void this.push(null);
          if (!buffered.length && !(await fill(1))) return void this.destroy(new Error('Archive is truncated'));
          const chunk = take(Math.min(remaining, buffered.length, 1024 * 1024));
          remaining -= chunk.length;
          this.push(Buffer.from(chunk));
          if (remaining === 0) this.push(null);
        } catch (err) {
          this.destroy(err as Error);
        }
      },
    });
    await onEntry({ name, size, stream });
    // Drain anything the consumer left unread so the next header lines up.
    for await (const _ of stream) void _;
    if (remaining !== 0) throw new Error('Archive is truncated');
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad) {
      if (!(await fill(pad))) throw new Error('Archive is truncated');
      take(pad);
    }
    count++;
  }
}

/** Writable sink that discards data; useful for verification passes. */
export const discard = () => new Writable({ write: (_c, _e, cb) => cb() });
