import { defineConfig } from 'vitest/config';

const shared = {
  environment: 'node' as const,
  setupFiles: ['tests/setup-env.ts'],
  testTimeout: 30000,
  hookTimeout: 120000,
  fileParallelism: false,
  pool: 'threads' as const,
};

export default defineConfig({
  test: {
    projects: [
      {
        // Standalone MongoDB (no transactions): the existing suite and the compensating-rollback paths.
        test: {
          ...shared,
          name: 'standalone',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.replset.test.ts'],
          globalSetup: ['tests/global-setup.ts'],
        },
      },
      {
        // Single-node replica set (the minimum production topology): transactions, crash tests, snapshot backups.
        test: {
          ...shared,
          name: 'replset',
          include: ['tests/**/*.replset.test.ts'],
          globalSetup: ['tests/global-setup-replset.ts'],
          testTimeout: 60000,
        },
      },
    ],
  },
});
