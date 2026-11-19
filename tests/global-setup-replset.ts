import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * Throwaway single-node replica set for tests that need transactions or snapshot reads. Like the
 * standalone setup, nothing here can touch a real database.
 */
export default async function setup(project: TestProject) {
  const rs = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
      // A transaction left open by a killed process is aborted after this many seconds (server
      // default 60). Lowered so crash tests can retry the same record quickly.
      args: ['--setParameter', 'transactionLifetimeLimitSeconds=10'],
    },
  });
  await rs.waitUntilRunning();
  // getUri() ends with "/?replicaSet=..."; setup-env inserts the per-file database name.
  project.provide('mongoUri', rs.getUri());
  return async () => {
    await rs.stop();
  };
}
