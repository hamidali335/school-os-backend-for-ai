/**
 * Checks the push (FCM) configuration in .env without delivering any message
 * (docs/PUSH_NOTIFICATIONS.md, docs/FCM_KEYLESS.md).
 *
 *   npm run push:check                 which credentials and project; the key file or keyless
 *                                      configuration is valid and matches FCM_PROJECT_ID
 *   npm run push:check -- --google     also ask FCM to validate a message (dry run, to a token
 *                                      that cannot exist): proves the credentials and project
 *                                      are accepted by Google. Nothing is delivered.
 *   npm run push:check -- --app <google-services.json>
 *                                      also check the app file is for the same project and package
 *   npm run push:check -- --verify <signer.json> <jwks.json>
 *                                      keyless only: verify the OIDC token exactly as Google will
 *
 * Never prints a key, an access token or a device token.
 */
import fs from 'node:fs';
import { env } from '../src/config/env';
import { AdcSource } from '../src/modules/push/google-credentials';
import { adminMessaging, classify, resolvePushConfig } from '../src/modules/push/fcm-admin';
import { verifyOidcToken } from '../src/modules/push/oidc-token';

async function main() {
  const args = process.argv.slice(2);
  const config = resolvePushConfig(env);
  if (config.mode === 'none') throw new Error('Push is not configured: see docs/PUSH_NOTIFICATIONS.md');
  console.log(`1) Credentials: ${config.mode}  project: ${config.projectId}`);
  if (config.mode === 'service_account_file') console.log(`   Service account: ${config.clientEmail}`);

  if (config.mode === 'adc') {
    new AdcSource(env.GOOGLE_APPLICATION_CREDENTIALS).preflight();
    console.log('   ADC configuration readable; OIDC token present and not expired');
    const v = args.indexOf('--verify');
    if (v >= 0) {
      const signer = JSON.parse(fs.readFileSync(args[v + 1], 'utf8'));
      const jwks = JSON.parse(fs.readFileSync(args[v + 2], 'utf8'));
      const cfg = JSON.parse(fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS!, 'utf8'));
      const claims = verifyOidcToken(fs.readFileSync(cfg.credential_source.file, 'utf8'), jwks, {
        issuer: signer.issuer,
        audience: signer.audience,
        subject: signer.subject,
      });
      console.log(`   Token verified (kid ${signer.kid}); expires in ${claims.exp - Math.floor(Date.now() / 1000)} s`);
    }
  }

  const a = args.indexOf('--app');
  if (a >= 0) {
    // The app's google-services.json must belong to the same project, for the same package.
    let gs: {
      project_info?: { project_id?: string; project_number?: string };
      client?: Array<{ client_info?: { android_client_info?: { package_name?: string } } }>;
    };
    try {
      gs = JSON.parse(fs.readFileSync(args[a + 1], 'utf8'));
    } catch {
      throw new Error(`--app: ${args[a + 1]} is not a readable google-services.json`);
    }
    const appProject = gs.project_info?.project_id;
    const packages = (gs.client ?? []).map((c) => c.client_info?.android_client_info?.package_name);
    if (appProject !== config.projectId)
      throw new Error(
        `the app's google-services.json is for project "${appProject}" but the server sends as "${config.projectId}". Use the key and the app file from the same Firebase project.`,
      );
    if (!packages.includes('com.schoolosmobile'))
      throw new Error(
        `the app's google-services.json has no Android app "com.schoolosmobile" (found: ${packages.join(', ') || 'none'})`,
      );
    console.log(
      `   App file matches: project ${appProject} (number ${gs.project_info?.project_number}), package com.schoolosmobile`,
    );
  }

  if (args.includes('--google')) {
    const t0 = Date.now();
    // A token that cannot exist: FCM authenticates the request, then rejects only the token.
    const { responses } = await adminMessaging(config).sendEach(
      [{ token: 'school-os-push-check-not-a-real-device-token', data: { type: 'check' } }],
      true,
    );
    const r = responses[0];
    const kind = r.success ? 'ok' : classify(r.error?.code, r.error?.message);
    if (kind === 'invalid_token' || kind === 'ok')
      console.log(
        `2) Google accepted the credentials for project ${config.projectId} (${Date.now() - t0} ms; dry run, nothing delivered)`,
      );
    else throw new Error(`Google refused the request: ${r.error?.code ?? 'unknown error'}`);
  }
  console.log('OK');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Push check failed: ${(err as Error).message}`);
    process.exit(1);
  });
