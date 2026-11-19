import os from 'node:os';
import mongoose from 'mongoose';
import { createApp } from './app';
import { configWarnings, env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './database/connection';
import { startScheduler, stopScheduler } from './modules/automations/scheduler';
import { drainImports, recoverInterruptedImports } from './modules/imports/imports.service';
import { recoverInterruptedBackups, startBackupScheduler, stopBackupScheduler } from './modules/backups/backup.service';
import { assertSupportedTopology, mongoTopology } from './database/transactions';
import { logBiometricIndexStatus } from './modules/biometric/index-check';
import { attachCallSignaling } from './modules/calls/calls.socket';
import { recoverInterruptedCalls, startCallSweeper, stopCallSweeper } from './modules/calls/calls.service';
import { callHub } from './modules/calls/calls.hub';
import { initPush } from './modules/push/push.service';
import {
  recoverInterruptedConversations,
  startAiCallMaintenance,
  stopAiCallMaintenance,
} from './modules/ai-calls/ai-calls.service';

async function main() {
  await connectDatabase();
  assertSupportedTopology({ production: env.NODE_ENV === 'production', allowStandalone: env.ALLOW_STANDALONE_MONGODB });
  if (mongoTopology() === 'standalone')
    logger.warn('MongoDB is standalone: multi-document writes are not transactional');
  await recoverInterruptedBackups().catch((err) => logger.error({ err }, 'Could not check for interrupted backups'));
  await recoverInterruptedImports().catch((err) => logger.error({ err }, 'Could not check for interrupted imports'));
  if (env.CALLS_ENABLED)
    await recoverInterruptedCalls().catch((err) => logger.error({ err }, 'Could not close interrupted calls'));
  if (env.CALLS_ENABLED && env.AI_CALLS_ENABLED)
    await recoverInterruptedConversations().catch((err) =>
      logger.error({ err }, 'Could not close interrupted AI calls'),
    );
  // Push: a wrong Firebase configuration stops start-up with what to fix (docs/PUSH_NOTIFICATIONS.md).
  const push = initPush();
  if (push.configured)
    logger.info(
      `Push notifications on: project ${push.projectId}, credentials ${push.credentials}${push.dryRun ? ' (dry run: nothing delivered)' : ''}`,
    );
  else if (env.NODE_ENV === 'production')
    logger.warn(
      'Push notifications are off: phones ring and show notifications only while the app is open (docs/PUSH_NOTIFICATIONS.md)',
    );
  const app = createApp();
  if (env.NODE_ENV !== 'production') await syncIndexesForDevelopment();
  // Read-only: warns (and staff attendance refuses writes) while its unique indexes are missing.
  await logBiometricIndexStatus();
  const onListening = () => {
    logger.info(`School OS API listening on http://${env.HOST ?? 'localhost'}:${env.PORT} (docs: /api-docs)`);
    // Development: the addresses a phone on the same network can use (docs/LOCAL_DEVICE_SETUP.md
    // in SchoolOSMobile). The LAN address changes when the router assigns a new one.
    if (env.NODE_ENV !== 'production' && (!env.HOST || env.HOST === '0.0.0.0' || env.HOST === '::')) {
      for (const ip of lanAddresses()) logger.info(`  From a phone on this network: http://${ip}:${env.PORT}/api/v1`);
    }
  };
  const server = env.HOST ? app.listen(env.PORT, env.HOST, onListening) : app.listen(env.PORT, onListening);
  server.keepAliveTimeout = 65_000;
  if (env.CALLS_ENABLED) {
    attachCallSignaling(server);
    startCallSweeper();
    startAiCallMaintenance();
  }

  for (const w of configWarnings()) logger.warn(w);
  if (env.SCHEDULER_ENABLED) startScheduler();
  startBackupScheduler();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    stopBackupScheduler();
    stopCallSweeper();
    stopAiCallMaintenance();
    callHub.closeAll(1012, 'Server restarting');
    // Imports start no new row and finish the ones being saved (within the 15 s limit below).
    const drained = drainImports(10_000).catch(() => undefined);
    server.close(async () => {
      await drained;
      await disconnectDatabase().catch(() => undefined);
      process.exit(process.exitCode ?? 0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Request errors never reach here (Express 5 routes async errors to the error handler). A
  // stray rejection from fire-and-forget work is logged; the request that started it is done.
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
  // After an uncaught exception the process state is unknown: stop taking traffic, finish
  // in-flight requests, exit non-zero and let the process manager (systemd/PM2) restart it.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; shutting down');
    process.exitCode = 1;
    void shutdown('uncaughtException');
  });
}

/** This machine's private IPv4 addresses (Wi-Fi, Ethernet), for the development startup hint. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    .map((a) => a.address);
}

/**
 * Development only: bring MongoDB indexes in line with the models, dropping indexes a model no
 * longer declares. Mongoose's autoIndex only ever adds indexes, so an index left over from an
 * earlier version (e.g. a unique email index without the "only when set" condition) would keep
 * rejecting valid records. Production runs `npm run db:indexes` as a deploy step instead.
 */
async function syncIndexesForDevelopment() {
  for (const name of mongoose.modelNames()) {
    try {
      const dropped = await mongoose.model(name).syncIndexes();
      if (dropped.length) logger.warn({ model: name, dropped }, 'Dropped obsolete MongoDB indexes');
    } catch (err) {
      logger.error({ err, model: name }, 'Could not sync MongoDB indexes; run `npm run db:indexes`');
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
