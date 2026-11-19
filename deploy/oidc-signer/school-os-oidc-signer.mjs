#!/usr/bin/env node
/**
 * School OS OIDC signer (docs/FCM_KEYLESS.md).
 *
 * Signs the short-lived identity token that Google Workload Identity Federation exchanges for an
 * FCM access token, so the API needs no Google key. It runs as its own Linux user
 * (school-os-oidc); the API process can read only the token it writes, never the signing key.
 * Node.js built-ins only, no dependencies.
 *
 *   keygen <dir> <kid>   create <dir>/private.pem (0600) and <dir>/jwks.json (public, to upload
 *                         to the Google Cloud provider). Refuses to overwrite an existing key.
 *   sign <config.json>   write a fresh token to config.tokenFile (atomic replace, 0640)
 *
 * config.json: { "issuer", "audience", "subject", "kid", "privateKeyFile", "tokenFile",
 *                "ttlSeconds" (60..3600, default 600) }
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function keygen(dir, kid) {
  if (!dir || !kid || !/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error('usage: keygen <dir> <kid>');
  const keyFile = path.join(dir, 'private.pem');
  if (fs.existsSync(keyFile)) throw new Error(`${keyFile} already exists; remove it deliberately to rotate`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const jwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' }] };
  fs.writeFileSync(path.join(dir, 'jwks.json'), JSON.stringify(jwks, null, 2) + '\n', { mode: 0o644 });
  return { keyFile, jwksFile: path.join(dir, 'jwks.json') };
}

export function loadConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['issuer', 'audience', 'subject', 'kid', 'privateKeyFile', 'tokenFile'])
    if (typeof c[k] !== 'string' || !c[k]) throw new Error(`config: "${k}" is required`);
  if (!/^https:\/\//.test(c.issuer)) throw new Error('config: issuer must be an https:// URL');
  const ttl = c.ttlSeconds ?? 600;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new Error('config: ttlSeconds must be 60..3600');
  return { ...c, ttlSeconds: ttl };
}

export function signToken(config, privateKeyPem, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT', kid: config.kid });
  const claims = b64({
    iss: config.issuer,
    aud: config.audience,
    sub: config.subject,
    iat: now,
    exp: now + config.ttlSeconds,
    jti: crypto.randomUUID(),
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKeyPem).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/** Writes next to the target, then renames: a reader never sees a half-written token. */
export function writeTokenFile(file, token) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

export function signOnce(configFile) {
  const config = loadConfig(configFile);
  const token = signToken(config, fs.readFileSync(config.privateKeyFile, 'utf8'));
  writeTokenFile(config.tokenFile, token);
  return config.tokenFile;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'keygen') {
      const r = keygen(a, b);
      console.log(`Key written to ${r.keyFile} (keep private). Upload ${r.jwksFile} to the Google Cloud provider.`);
    } else if (cmd === 'sign') {
      // Never print the token.
      console.log(`Token refreshed: ${signOnce(a)}`);
    } else {
      console.error('usage: school-os-oidc-signer.mjs keygen <dir> <kid> | sign <config.json>');
      process.exit(2);
    }
  } catch (err) {
    console.error(`school-os-oidc-signer: ${err.message}`);
    process.exit(1);
  }
}
