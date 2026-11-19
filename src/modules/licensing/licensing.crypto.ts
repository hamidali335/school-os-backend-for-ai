import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * License Signature Version and Key Infrastructure
 * Uses Ed25519 (Edwards-curve Digital Signature Algorithm, RFC 8032)
 * Fast, 128-bit security level, resistant to side-channel attacks, 64-byte signatures.
 */
export const LICENSE_KEY_VERSION = 1;

// Internal key pair cached for dev/test environments
let devKeyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;

function getOrGenerateDevKeyPair() {
  if (!devKeyPair) {
    devKeyPair = crypto.generateKeyPairSync('ed25519');
  }
  return devKeyPair;
}

/**
 * Returns the public verification key in PEM format (SPKI).
 * This key is distributed to desktop clients to verify signed licenses locally while offline.
 */
export function getLicensePublicKeyPem(): string {
  if (process.env.LICENSE_PUBLIC_KEY) {
    return process.env.LICENSE_PUBLIC_KEY;
  }
  const pair = getOrGenerateDevKeyPair();
  return pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Returns the private signing key KeyObject.
 * Kept strictly server-side; NEVER sent to desktop clients.
 */
function getLicensePrivateKey(): crypto.KeyObject {
  if (process.env.LICENSE_PRIVATE_KEY) {
    return crypto.createPrivateKey(process.env.LICENSE_PRIVATE_KEY);
  }
  const pair = getOrGenerateDevKeyPair();
  return pair.privateKey;
}

/**
 * Digitally signs a normalized JSON license payload using Ed25519.
 */
export function signLicensePayload(payload: Record<string, any>): {
  signedPayload: string;
  signature: string;
  keyVersion: number;
} {
  // Canonical JSON serialization (sorted keys for deterministic hashing)
  const canonicalJson = JSON.stringify(payload, Object.keys(payload).sort());
  const privateKey = getLicensePrivateKey();
  const signatureBuffer = crypto.sign(null, Buffer.from(canonicalJson, 'utf8'), privateKey);
  const signature = signatureBuffer.toString('base64');

  return {
    signedPayload: canonicalJson,
    signature,
    keyVersion: LICENSE_KEY_VERSION,
  };
}

/**
 * Verifies an Ed25519 digital signature against the canonical JSON payload.
 */
export function verifyLicenseSignature(
  signedPayload: string,
  signatureBase64: string,
  publicKeyPem?: string,
): boolean {
  try {
    const pubKey = publicKeyPem
      ? crypto.createPublicKey(publicKeyPem)
      : getOrGenerateDevKeyPair().publicKey;
    const signatureBuffer = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(signedPayload, 'utf8'), pubKey, signatureBuffer);
  } catch {
    return false;
  }
}
