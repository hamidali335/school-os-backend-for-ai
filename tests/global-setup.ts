import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Starts a throwaway in-memory MongoDB for the whole test run. Tests never touch a real
 * or production database; each test file uses its own uniquely named database on it.
 */
export default async function setup(project: TestProject) {
  const mongod = await MongoMemoryServer.create();
  project.provide('mongoUri', mongod.getUri());
  return async () => {
    await mongod.stop();
  };
}
