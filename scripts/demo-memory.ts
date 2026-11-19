/**
 * Try the API without installing MongoDB: starts a temporary in-memory MongoDB, seeds the
 * Bright Future demo school and starts the API on PORT (default 4000).
 *
 *   SEED_DEMO_PASSWORD='Choose-A-Strong-Pass-1' npm run demo
 *
 * EVERYTHING IS LOST WHEN THE PROCESS STOPS. Development/evaluation only — never use this
 * for real data. Requires dev dependencies (mongodb-memory-server).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

async function main() {
  const password = process.env.SEED_DEMO_PASSWORD;
  if (!password) throw new Error('Set SEED_DEMO_PASSWORD (min 10 chars with upper, lower and a digit).');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = `${mongod.getUri()}schoolos_demo`;
  process.env.JWT_ACCESS_SECRET ??= `demo-access-${Math.random().toString(36).slice(2)}-${Date.now()}-ephemeral`;
  process.env.JWT_PLATFORM_SECRET ??= `demo-platform-${Math.random().toString(36).slice(2)}-${Date.now()}-ephemeral`;
  process.env.SCHEDULER_ENABLED ??= 'false';
  process.env.ALLOW_STANDALONE_MONGODB ??= 'true';
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  process.env.RATE_LIMIT_MAX = '5000';

  const { connectDatabase } = await import('../src/database/connection');
  const { runSeed, DEMO_LOGINS } = await import('./seed');
  await connectDatabase(process.env.MONGODB_URI);
  await runSeed(password);
  // App voice calls are in no default plan. This throwaway demo school gets them as a school
  // override so calling can be tried locally (DEMO_CALLS=false to see the plan without them).
  if (process.env.DEMO_CALLS !== 'false') {
    const { School } = await import('../src/modules/schools/school.model');
    for (const feature of ['calls.voice', 'calls.ai_voice'])
      await School.updateMany(
        { 'subscription.featureOverrides.feature': { $ne: feature } },
        { $push: { 'subscription.featureOverrides': { feature, mode: 'grant', reason: 'Local demo' } } },
      );
    console.log(
      'Demo only: app voice calls and AI voice calls granted to the demo school (AI calls also need speech engines).',
    );
  }
  // Optional platform owner for the owner-panel endpoints.
  if (process.env.PLATFORM_OWNER_EMAIL && process.env.PLATFORM_OWNER_PASSWORD) {
    const { PlatformAdmin } = await import('../src/modules/platform-admin/platform-admin.model');
    const { hashPassword } = await import('../src/modules/auth/tokens');
    await PlatformAdmin.updateOne(
      { email: process.env.PLATFORM_OWNER_EMAIL.toLowerCase() },
      {
        $setOnInsert: {
          name: process.env.PLATFORM_OWNER_NAME ?? 'Platform Owner',
          role: 'platform_owner',
          passwordHash: await hashPassword(process.env.PLATFORM_OWNER_PASSWORD),
        },
      },
      { upsert: true },
    );
    console.log(`Platform owner: ${process.env.PLATFORM_OWNER_EMAIL}`);
  }
  await import('../src/server');
  console.log('\nIn-memory demo ready (data is discarded on exit). Logins (password = SEED_DEMO_PASSWORD):');
  for (const e of DEMO_LOGINS) console.log(`  ${e}`);
  const stop = async () => {
    await mongod.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
