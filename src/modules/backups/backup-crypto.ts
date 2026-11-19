import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Backup archive encryption: AES-256-GCM (authenticated) with a random 96-bit IV per archive.
 *
 * File layout:  MAGIC(8) | keyId(8) | iv(12) | ciphertext | authTag(16)
 * MAGIC + keyId + iv are bound to the ciphertext as additional authenticated data, so any
 * change to the header, the data or the tag makes decryption fail.
 *
 * The key never appears in an archive or manifest; only `keyId` (the first 8 bytes of the
 * key's SHA-256) does, so an operator can tell which key a backup needs. Decrypted output is
 * only trustworthy once `final()` has succeeded: restore writes it to a private work folder
 * and discards everything if authentication fails.
 */
export const MAGIC = Buffer.from('SOSBAK01', 'ascii');
const HEADER_LEN = MAGIC.length + 8 + 12;
const TAG_LEN = 16;

export function parseKey(encoded: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Backup encryption key must be 32 bytes (base64 or hex)');
  return key;
}

export function keyId(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest().subarray(0, 8).toString('hex');
}

export function generateKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

export function createEncryptStream(key: Buffer): Transform {
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from(keyId(key), 'hex'), iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) {
        this.push(header);
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      if (!headerSent) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

export class BackupKeyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`This backup was encrypted with key ${expected}; the configured key is ${actual}`);
  }
}

/** Decrypts; errors (wrong key, tampering, truncation) surface as a stream error at the end. */
export function createDecryptStream(key: Buffer): Transform {
  let header: Buffer | null = null;
  let pending = Buffer.alloc(0);
  let decipher: crypto.DecipherGCM | null = null;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (!header) {
          if (pending.length < HEADER_LEN) return cb();
          header = pending.subarray(0, HEADER_LEN);
          pending = pending.subarray(HEADER_LEN);
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a School OS backup archive');
          const fileKeyId = header.subarray(MAGIC.length, MAGIC.length + 8).toString('hex');
          if (fileKeyId !== keyId(key)) throw new BackupKeyMismatchError(fileKeyId, keyId(key));
          decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length + 8));
          decipher.setAAD(header);
        }
        // Hold back the last 16 bytes: they may be the authentication tag.
        if (pending.length > TAG_LEN) {
          const body = pending.subarray(0, pending.length - TAG_LEN);
          pending = pending.subarray(pending.length - TAG_LEN);
          this.push(decipher!.update(body));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!decipher || pending.length !== TAG_LEN) throw new Error('Backup archive is truncated');
        decipher.setAuthTag(pending);
        this.push(decipher.final()); // throws if the key is wrong or data was altered
        cb();
      } catch (err) {
        const e = err as Error;
        cb(
          /unable to authenticate|auth/i.test(e.message)
            ? new Error('Backup archive failed authentication (corrupted or altered)')
            : e,
        );
      }
    },
  });
}

/** Reads the key id from an archive's header without the key. */
export function readKeyIdFromHeader(head: Buffer): string | null {
  if (head.length < HEADER_LEN || !head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  return head.subarray(MAGIC.length, MAGIC.length + 8).toString('hex');
}
