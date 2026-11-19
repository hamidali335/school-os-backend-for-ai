import mongoose, { Types } from 'mongoose';
import { connectDatabase } from '../src/database/connection';
import { SyncChangeLog, SchoolSequence } from '../src/modules/sync/sync.models';

export async function backfillSyncSequences() {
  console.log('[MIGRATE-SYNC-SEQ] Starting sequence backfill for SyncChangeLog...');
  await connectDatabase();

  const distinctSchools = await SyncChangeLog.collection.distinct('schoolId');
  console.log(`[MIGRATE-SYNC-SEQ] Found ${distinctSchools.length} schools with change log entries.`);

  for (const sid of distinctSchools) {
    const schoolId = typeof sid === 'string' ? new Types.ObjectId(sid) : sid;
    const entries = await SyncChangeLog.find({ schoolId }).sort({ timestamp: 1, _id: 1 });

    let currentSeq = 0;
    for (const entry of entries) {
      currentSeq++;
      if (entry.seq !== currentSeq) {
        await SyncChangeLog.updateOne({ schoolId, _id: entry._id }, { $set: { seq: currentSeq } });
      }
    }

    await SchoolSequence.findOneAndUpdate(
      { schoolId },
      { $set: { seq: currentSeq, highestPrunedSeq: 0 } },
      { upsert: true, returnDocument: 'after' },
    );

    console.log(`[MIGRATE-SYNC-SEQ] School ${schoolId.toString()}: backfilled ${entries.length} entries to max seq ${currentSeq}.`);
  }

  console.log('[MIGRATE-SYNC-SEQ] Syncing indexes for SyncChangeLog...');
  await SyncChangeLog.syncIndexes();
  await SchoolSequence.syncIndexes();
  console.log('[MIGRATE-SYNC-SEQ] Backfill completed successfully.');
}

if (require.main === module) {
  backfillSyncSequences()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[MIGRATE-SYNC-SEQ] Migration failed:', err);
      process.exit(1);
    });
}
