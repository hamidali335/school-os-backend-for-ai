import type { Schema } from 'mongoose';
import { logger } from '../config/logger';
import { inTransaction } from './transactions';

const WRITE_HOOKS = [
  'save',
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

export class AtomicTransactionViolationError extends Error {
  constructor(modelName: string, op: string) {
    super(`[ATOMIC_GUARD] Mutation ${op} on covered model "${modelName}" executed outside atomic() transaction.`);
    this.name = 'AtomicTransactionViolationError';
  }
}

/**
 * Mongoose plugin that ensures mutations on covered sync entities execute inside atomic() transactions.
 * Default behavior: logs warning.
 * Strict behavior (SYNC_GUARD_STRICT=1, set by sync test harness): throws AtomicTransactionViolationError.
 */
export function atomicGuardPlugin(schema: Schema): void {
  for (const hook of WRITE_HOOKS) {
    schema.pre(hook, function atomicGuard(this: any) {
      if (!inTransaction()) {
        const modelName = this.model?.modelName || this.constructor?.modelName || 'UnknownModel';
        if (process.env.SYNC_GUARD_STRICT === '1') {
          throw new AtomicTransactionViolationError(modelName, hook);
        } else {
          logger.warn(
            { model: modelName, op: hook },
            '[ATOMIC_GUARD] Mutation on covered model executed outside atomic() transaction.',
          );
        }
      }
    });
  }
}
