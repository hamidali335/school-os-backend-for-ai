import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * Encryption for secrets stored in the database (e.g. AI provider API keys), using
 * AES-256-GCM. The key comes from SETTINGS_ENCRYPTION_KEY, or is derived from
 * JWT_PLATFORM_SECRET when that is not set. Changing either value makes stored secrets
 * unreadable: they must then be entered again.
 */
let cachedKey: Buffer | undefined;
function key(): Buffer {
  cachedKey ??= Buffer.from(
    crypto.hkdfSync(
      'sha256',
      env.SETTINGS_ENCRYPTION_KEY ?? env.JWT_PLATFORM_SECRET,
      'school-os',
      'settings-secrets-v1',
      32,
    ),
  );
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Returns null when the value cannot be decrypted (wrong key or tampered data). */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    const [version, iv, tag, data] = stored.split(':');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** "gsk_…9fA2" — enough to recognise a key without revealing it. */
export function maskSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  if (plain.length <= 8) return '••••';
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
