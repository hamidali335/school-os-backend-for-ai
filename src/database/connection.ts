import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { detectTopology } from './transactions';

mongoose.set('strictQuery', true);
// Never let a query silently build indexes in production; use `npm run db:indexes`.
mongoose.set('autoIndex', env.NODE_ENV !== 'production');
// Nor create empty collections just by connecting: a dry-run script (e.g. a migration report)
// must not change the database. MongoDB creates a collection on its first write.
mongoose.set('autoCreate', env.NODE_ENV !== 'production');

/** True when the connection string names a database, e.g. `.../school_os?retryWrites=true`. */
export function uriHasDatabase(uri: string): boolean {
  const afterHosts = uri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, '');
  const db = afterHosts.replace(/^\//, '').split('?')[0];
  return db.length > 0;
}

/**
 * Strict guard for test environments.
 * Refuses to run tests against any non-local or non-test database, especially Atlas.
 * Must throw BEFORE any network connection attempt is made.
 */
export function assertSafeTestDatabaseUri(uri: string): void {
  if (!uri) {
    throw new Error('Test runner refused: MONGODB_URI is not set');
  }
  // Refuse Atlas, remote or srv endpoints
  if (uri.includes('.mongodb.net') || uri.startsWith('mongodb+srv://') || uri.includes('@cluster')) {
    throw new Error(`Test runner refused: MONGODB_URI points to remote/Atlas host: ${uri}`);
  }
  const isLocalhost = uri.includes('localhost') || uri.includes('127.0.0.1');
  if (!isLocalhost) {
    throw new Error(`Test runner refused: MONGODB_URI does not point to localhost: ${uri}`);
  }
  const afterHosts = uri.replace(/^mongodb:\/\/[^/]*/, '');
  const dbName = afterHosts.replace(/^\//, '').split('?')[0];
  const isTestDb = dbName.endsWith('_test') || dbName.includes('schoolos_test_');
  if (!isTestDb) {
    throw new Error(`Test runner refused: Database name "${dbName}" must end with _test or contain schoolos_test_`);
  }
}

export async function connectDatabase(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  if (env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') {
    assertSafeTestDatabaseUri(uri);
  }
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    // A write is acknowledged only once it is in the on-disk journal (and on a majority of a
    // replica set). Without this, a standalone server that crashes can lose the last ~100 ms
    // of writes the API already reported as saved (observed in tests/database-failure.test.ts).
    writeConcern: { w: 'majority', journal: true },
    // Without a database in the URI, MongoDB silently uses "test"; use a named one instead.
    ...(uriHasDatabase(uri) ? {} : { dbName: env.MONGODB_DB_NAME }),
  });
  const topology = await detectTopology();
  logger.info({ db: mongoose.connection.name, topology }, 'MongoDB connected');
  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function databaseState(): 'connected' | 'connecting' | 'disconnected' | 'disconnecting' | 'unknown' {
  switch (mongoose.connection.readyState) {
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 0:
      return 'disconnected';
    case 3:
      return 'disconnecting';
    default:
      return 'unknown';
  }
}

export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number | null }> {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return { ok: false, latencyMs: null };
  const started = Date.now();
  try {
    await mongoose.connection.db.admin().ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  }
}
