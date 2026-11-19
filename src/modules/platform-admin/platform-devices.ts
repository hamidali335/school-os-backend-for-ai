import crypto from 'node:crypto';
import { model, Schema } from 'mongoose';
import { baseOptions } from '../../database/schema-helpers';
import { logger } from '../../config/logger';
import { AppError } from '../../utils/errors';

/**
 * Trusted devices for the platform console (docs/PLATFORM_REMOTE_ACCESS.md). With
 * PLATFORM_DEVICE_ONLY=true the platform API answers only browsers that hold a registered
 * device key, from any network; every other device gets 404, even with the password.
 *
 * A device is added on the server (`npm run platform:device -- add "My laptop"`), which prints a
 * one-time setup code (15 minutes, single use). Entering it once in the console on that device
 * gives the browser a random device key; only its SHA-256 hash is stored here. Removing the
 * device on the server makes its key worthless at once.
 */

const PlatformDeviceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** SHA-256 of the device key; null until the setup code was used. */
    keyHash: { type: String, default: null, select: false },
    /** SHA-256 of the one-time setup code; cleared once used. */
    setupCodeHash: { type: String, default: null, select: false },
    setupExpiresAt: { type: Date, default: null },
    enrolledAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  baseOptions,
);
PlatformDeviceSchema.index({ name: 1 }, { unique: true });
PlatformDeviceSchema.index({ setupCodeHash: 1 }, { sparse: true });
export const PlatformDevice = model('PlatformDevice', PlatformDeviceSchema);

const SETUP_MINUTES = 15;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** Setup codes: 12 characters from an alphabet without look-alikes, shown as XXXX-XXXX-XXXX. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newSetupCode() {
  const bytes = crypto.randomBytes(12);
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Register a device (or re-issue a code for one): any key it had stops working. */
export async function addDevice(name: string, now = new Date()) {
  const clean = name.trim();
  if (!clean || clean.length > 60) throw new Error('Device name: 1 to 60 characters');
  const code = newSetupCode();
  await PlatformDevice.updateOne(
    { name: clean },
    {
      $set: {
        keyHash: null,
        setupCodeHash: sha256(normalizeCode(code)),
        setupExpiresAt: new Date(now.getTime() + SETUP_MINUTES * 60_000),
        enrolledAt: null,
      },
    },
    { upsert: true },
  );
  return { name: clean, code, expiresInMinutes: SETUP_MINUTES };
}

export async function removeDevice(name: string) {
  const r = await PlatformDevice.deleteOne({ name: name.trim() });
  return r.deletedCount > 0;
}

export async function listDevices() {
  return PlatformDevice.find({}).sort({ name: 1 }).select('name enrolledAt lastSeenAt setupExpiresAt').lean();
}

/** Exchange a one-time setup code for a device key (returned once, never stored in clear). */
export async function enrollDevice(code: string, now = new Date()) {
  const hash = sha256(normalizeCode(code));
  const key = crypto.randomBytes(32).toString('base64url');
  const device = await PlatformDevice.findOneAndUpdate(
    { setupCodeHash: hash, setupExpiresAt: { $gt: now } },
    { $set: { keyHash: sha256(key), setupCodeHash: null, setupExpiresAt: null, enrolledAt: now, lastSeenAt: now } },
    { new: true },
  ).lean();
  if (!device)
    throw new AppError(
      400,
      'INVALID_SETUP_CODE',
      'This setup code is wrong, already used or expired. Create a new one on the server.',
    );
  logger.info({ device: device.name }, 'Platform device registered');
  return { deviceKey: `${String(device._id)}.${key}`, name: device.name };
}

const lastSeenWrites = new Map<string, number>();

/** Whether the X-Platform-Device header holds a key of a registered device. */
export async function verifyDeviceKey(header: string | undefined): Promise<boolean> {
  const m = /^([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/.exec(header?.trim() ?? '');
  if (!m) return false;
  const device = await PlatformDevice.findById(m[1]).select('+keyHash').lean();
  if (!device?.keyHash) return false;
  const a = Buffer.from(device.keyHash, 'hex');
  const b = Buffer.from(sha256(m[2]), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  // Record use at most once an hour.
  const id = String(device._id);
  if (Date.now() - (lastSeenWrites.get(id) ?? 0) > 3_600_000) {
    lastSeenWrites.set(id, Date.now());
    void PlatformDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return true;
}
