import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { keygen, loadConfig, signOnce, signToken } from '../deploy/oidc-signer/school-os-oidc-signer.mjs';
import { getApps } from 'firebase-admin/app';
import { AdcSource, fcmCredentialMode, FCM_SCOPE } from '../src/modules/push/google-credentials';
import { pushApp, PushConfigError, readServiceAccount, resolvePushConfig } from '../src/modules/push/fcm-admin';
import { decodeOidcToken, OidcTokenError, verifyOidcToken, type Jwks } from '../src/modules/push/oidc-token';

/**
 * FCM credentials (docs/PUSH_NOTIFICATIONS.md, docs/FCM_KEYLESS.md): a downloaded Firebase Admin
 * SDK key, checked before use, and keyless Workload Identity Federation through ADC with our own
 * OIDC signer. Google itself is never called. The keys here are generated for the test.
 */
const ISSUER = 'https://smsapi.example.test/oidc';
const AUDIENCE =
  'https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/school-os-pool/providers/school-os-server';
const STS_AUDIENCE =
  '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/school-os-pool/providers/school-os-server';
const SA = 'school-os-fcm-sender@demo-project.iam.gserviceaccount.com';
const SUBJECT = 'school-os-api';
const KID = 'test-key-1';

let dir: string;
let jwks: Jwks;
let privatePem: string;
const expected = { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT };
const base = { issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT, kid: KID, ttlSeconds: 600 };
const now = () => Math.floor(Date.now() / 1000);

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-os-oidc-'));
  const r = keygen(path.join(dir, 'oidc'), KID);
  jwks = JSON.parse(fs.readFileSync(r.jwksFile, 'utf8'));
  privatePem = fs.readFileSync(r.keyFile, 'utf8');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A service-account key file like the one Firebase generates (with a throwaway key). */
function keyFile(name: string, over: Record<string, unknown> = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      project_id: 'school-os-test',
      private_key_id: 'abc',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'firebase-adminsdk-x@school-os-test.iam.gserviceaccount.com',
      ...over,
    }),
  );
  return file;
}

describe('choosing and checking the credentials', () => {
  it('key file or keyless; nothing configured means push is off', () => {
    expect(fcmCredentialMode({})).toBe('none');
    expect(fcmCredentialMode({ FCM_SERVICE_ACCOUNT_FILE: '/k.json' })).toBe('service_account_file');
    expect(fcmCredentialMode({ FCM_CREDENTIALS: 'adc', FCM_SERVICE_ACCOUNT_FILE: '/k.json' })).toBe('adc');
    expect(resolvePushConfig({})).toEqual({ mode: 'none' });
  });

  it('a valid key: project taken from the key, and it must match FCM_PROJECT_ID', () => {
    const file = keyFile('good.json');
    const c = resolvePushConfig({ FCM_SERVICE_ACCOUNT_FILE: file });
    expect(c).toMatchObject({ mode: 'service_account_file', projectId: 'school-os-test' });
    expect(resolvePushConfig({ FCM_SERVICE_ACCOUNT_FILE: file, FCM_PROJECT_ID: 'school-os-test' }).mode).toBe(
      'service_account_file',
    );
    expect(() => resolvePushConfig({ FCM_SERVICE_ACCOUNT_FILE: file, FCM_PROJECT_ID: 'another-project' })).toThrow(
      /belongs to project "school-os-test" but FCM_PROJECT_ID is "another-project"/,
    );
  });

  it('missing, malformed or wrong files are refused with what to fix, never with their contents', () => {
    const cases: Array<[string, RegExp]> = [
      [path.join(dir, 'does-not-exist.json'), /cannot be read/],
      [(() => (fs.writeFileSync(path.join(dir, 'bad.json'), '{not json'), path.join(dir, 'bad.json')))(), /not valid JSON/],
      [keyFile('gs.json', { type: undefined, project_info: {} }), /not a service-account key.*google-services\.json/],
      [keyFile('nokey.json', { private_key: '' }), /missing project_id, client_email or private_key/],
      [keyFile('notpem.json', { private_key: 'secret-but-not-pem' }), /not a PEM private key/],
    ];
    for (const [file, msg] of cases) {
      let err: unknown;
      try {
        readServiceAccount(file);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PushConfigError);
      expect((err as Error).message).toMatch(msg);
      expect((err as Error).message).not.toContain('secret-but-not-pem');
      expect((err as Error).message).not.toContain('BEGIN');
    }
  });

  it('half-configured settings are errors, not a silent "push off"', () => {
    expect(() => resolvePushConfig({ FCM_CREDENTIALS: 'service_account_file' })).toThrow(/FCM_SERVICE_ACCOUNT_FILE is not set/);
    expect(() => resolvePushConfig({ FCM_PROJECT_ID: 'p' })).toThrow(/no credentials/);
    expect(() => resolvePushConfig({ FCM_CREDENTIALS: 'adc' })).toThrow(/needs FCM_PROJECT_ID/);
    expect(resolvePushConfig({ FCM_CREDENTIALS: 'adc', FCM_PROJECT_ID: 'p' }).mode).toBe('adc');
  });

  it('one Admin SDK app for the process, reused', () => {
    const c = resolvePushConfig({ FCM_SERVICE_ACCOUNT_FILE: keyFile('app.json') });
    if (c.mode === 'none') throw new Error('expected a config');
    const a = pushApp(c);
    const b = pushApp(c);
    expect(a).toBe(b);
    expect(getApps().filter((x) => x.name === 'school-os-push')).toHaveLength(1);
    expect(a.options.projectId).toBe('school-os-test');
  });
});

describe('the OIDC signer', () => {
  it('writes a private key (refusing to overwrite it) and a public JWKS without private parts', () => {
    expect(() => keygen(path.join(dir, 'oidc'), KID)).toThrow(/already exists/);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', kid: KID, alg: 'RS256', use: 'sig' });
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(dir, 'oidc', 'private.pem')).mode & 0o777).toBe(0o600);
  });

  it('refuses unsafe configuration', () => {
    const write = (c: object) => {
      const f = path.join(dir, `cfg-${crypto.randomUUID()}.json`);
      fs.writeFileSync(f, JSON.stringify(c));
      return f;
    };
    const ok = { ...base, privateKeyFile: 'k', tokenFile: 't' };
    expect(loadConfig(write(ok)).ttlSeconds).toBe(600);
    expect(() => loadConfig(write({ ...ok, issuer: 'http://insecure' }))).toThrow(/https/);
    expect(() => loadConfig(write({ ...ok, ttlSeconds: 7200 }))).toThrow(/ttlSeconds/);
    expect(() => loadConfig(write({ ...ok, subject: '' }))).toThrow(/subject/);
  });

  it('signs a token that passes the same checks Google applies', () => {
    const token = signToken(base, privatePem);
    const claims = verifyOidcToken(token, jwks, expected);
    expect(claims).toMatchObject({ iss: ISSUER, aud: AUDIENCE, sub: SUBJECT });
    expect(claims.exp - claims.iat).toBe(600);
    expect(decodeOidcToken(token).header).toMatchObject({ alg: 'RS256', kid: KID });
  });
});

describe('verification failures', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as OidcTokenError).code;
    }
    return 'NO_ERROR';
  };

  it.each([
    ['wrong issuer', { issuer: 'https://evil.test/oidc' }, 'WRONG_ISSUER'],
    ['wrong audience', { audience: 'https://other.test' }, 'WRONG_AUDIENCE'],
    ['wrong subject (what the attribute condition refuses)', { subject: 'someone-else' }, 'WRONG_SUBJECT'],
  ])('%s', (_label, change, expectedCode) => {
    expect(code(() => verifyOidcToken(signToken({ ...base, ...change }, privatePem), jwks, expected))).toBe(
      expectedCode,
    );
  });

  it('expired, issued in the future, or valid for too long', () => {
    expect(code(() => verifyOidcToken(signToken(base, privatePem, now() - 700), jwks, expected))).toBe('EXPIRED');
    expect(code(() => verifyOidcToken(signToken(base, privatePem, now() + 600), jwks, expected))).toBe('NOT_YET_VALID');
    expect(code(() => verifyOidcToken(signToken({ ...base, ttlSeconds: 7200 }, privatePem), jwks, expected))).toBe(
      'LIFETIME_TOO_LONG',
    );
  });

  it('signed by another key, tampered with, unknown key id, or not RS256', () => {
    const other = crypto
      .generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(code(() => verifyOidcToken(signToken(base, other), jwks, expected))).toBe('BAD_SIGNATURE');
    const [h, , s] = signToken(base, privatePem).split('.');
    const forged = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'admin', iat: now(), exp: now() + 60 }),
    ).toString('base64url');
    expect(code(() => verifyOidcToken(`${h}.${forged}.${s}`, jwks, expected))).toBe('BAD_SIGNATURE');
    expect(code(() => verifyOidcToken(signToken({ ...base, kid: 'unknown' }, privatePem), jwks, expected))).toBe(
      'UNKNOWN_KEY',
    );
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url')}.${forged}.`;
    expect(code(() => verifyOidcToken(none, jwks, expected))).toBe('MALFORMED');
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: KID })).toString('base64url')}.${forged}.x`;
    expect(code(() => verifyOidcToken(hs, jwks, expected))).toBe('BAD_ALGORITHM');
    expect(code(() => verifyOidcToken('not-a-jwt', jwks, expected))).toBe('MALFORMED');
  });
});

describe('keyless (adc) with Workload Identity Federation', () => {
  /**
   * A local stand-in for Google's Security Token Service and IAM Credentials API. The credential
   * configuration points at it (in production it points at sts.googleapis.com and
   * iamcredentials.googleapis.com), so google-auth-library runs its real exchange and the tests
   * never reach Google.
   */
  let server: http.Server;
  let fakeUrl: string;
  let refuse = false;
  const seen: { sts?: URLSearchParams; impersonation?: { path: string; body: Record<string, unknown>; auth: string } } =
    {};
  const calls: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(req.url ?? '');
        const json = (status: number, o: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (refuse) return json(400, { error: 'unauthorized_client', error_description: 'condition not met' });
        if (req.url === '/v1/token') {
          seen.sts = new URLSearchParams(body);
          return json(200, {
            access_token: 'federated-token',
            issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (req.url?.endsWith(':generateAccessToken')) {
          seen.impersonation = { path: req.url, body: JSON.parse(body), auth: String(req.headers.authorization) };
          return json(200, { accessToken: 'ya29.keyless', expireTime: new Date(Date.now() + 3600_000).toISOString() });
        }
        json(404, { error: 'not found' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  /** An external_account config like the one gcloud generates, pointing to a token file. */
  function setup(tokenNow?: number) {
    const tokenFile = path.join(dir, `token-${crypto.randomUUID()}`);
    const signerFile = path.join(dir, `signer-${crypto.randomUUID()}.json`);
    fs.writeFileSync(
      signerFile,
      JSON.stringify({ ...base, privateKeyFile: path.join(dir, 'oidc', 'private.pem'), tokenFile }),
    );
    if (tokenNow === undefined) signOnce(signerFile);
    else fs.writeFileSync(tokenFile, signToken(base, privatePem, tokenNow));
    const configFile = path.join(dir, `wif-${crypto.randomUUID()}.json`);
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        type: 'external_account',
        audience: STS_AUDIENCE,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: `${fakeUrl}/v1/token`,
        service_account_impersonation_url: `${fakeUrl}/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
        credential_source: { file: tokenFile },
      }),
    );
    return { configFile, tokenFile };
  }

  it('exchanges the signed token and acts as the FCM sender service account; no key file anywhere', async () => {
    refuse = false;
    calls.length = 0;
    const { configFile, tokenFile } = setup();
    const token = await new AdcSource(configFile).token();
    expect(token).toBe('ya29.keyless');
    expect(calls).toEqual(['/v1/token', `/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`]);
    // 1) Security Token Service: our OIDC token, for the provider, as a JWT.
    expect(seen.sts!.get('subject_token')).toBe(fs.readFileSync(tokenFile, 'utf8'));
    expect(seen.sts!.get('audience')).toBe(STS_AUDIENCE);
    expect(seen.sts!.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(seen.sts!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    // 2) Impersonation of the dedicated sender, asking only for the FCM scope.
    expect(seen.impersonation!.body.scope).toEqual([FCM_SCOPE]);
    expect(seen.impersonation!.auth).toBe('Bearer federated-token');
    // The token the signer wrote is one Google would accept.
    expect(verifyOidcToken(fs.readFileSync(tokenFile, 'utf8'), jwks, expected).sub).toBe(SUBJECT);
  });

  it('a stopped signer (missing or expired token) is reported plainly and Google is not called', async () => {
    refuse = false;
    calls.length = 0;
    const expired = setup(now() - 3000);
    await expect(new AdcSource(expired.configFile).token()).rejects.toThrow(/EXPIRED.*school-os-oidc.timer/);
    const missing = setup();
    fs.rmSync(missing.tokenFile);
    await expect(new AdcSource(missing.configFile).token()).rejects.toThrow(/missing or unreadable/);
    const garbage = setup();
    fs.writeFileSync(garbage.tokenFile, 'garbage');
    await expect(new AdcSource(garbage.configFile).token()).rejects.toThrow(/MALFORMED/);
    await expect(new AdcSource(path.join(dir, 'no-such-config.json')).token()).rejects.toThrow(/readable JSON/);
    expect(calls).toEqual([]);
  });

  it('a refusal by Google (wrong condition, missing role) is an error, never a silent success', async () => {
    refuse = true;
    calls.length = 0;
    const { configFile } = setup();
    await expect(new AdcSource(configFile).token()).rejects.toThrow();
    expect(calls).toEqual(['/v1/token']);
    refuse = false;
  });
});
