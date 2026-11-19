import { execSync } from 'node:child_process';
import mongoose from 'mongoose';

const TEST_URI = 'mongodb://127.0.0.1:27018/?replicaSet=rs0';

async function main() {
  console.log('[TEST-DB] Starting Docker test replica set...');
  try {
    execSync('docker compose -f docker-compose.test.yml up -d', { stdio: 'inherit' });
  } catch (err: any) {
    console.warn('[TEST-DB] docker compose failed or docker not running:', err.message);
  }

  console.log('[TEST-DB] Waiting for MongoDB replica set to become available...');
  const maxAttempts = 30;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const conn = await mongoose.createConnection(TEST_URI, { serverSelectionTimeoutMS: 2000 }).asPromise();
      const hello = await conn.db?.admin().command({ hello: 1 });
      if (hello?.setName === 'rs0' && (hello.isWritablePrimary || hello.ismaster)) {
        console.log('[TEST-DB] MongoDB replica set is ready and writable!');
        await conn.close();
        process.exit(0);
      }
      await conn.close();
    } catch {
      // wait and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.error('[TEST-DB] Timed out waiting for MongoDB replica set at', TEST_URI);
  process.exit(1);
}

if (require.main === module) {
  main();
}
