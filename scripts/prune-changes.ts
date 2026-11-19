import mongoose, { Types } from 'mongoose';
import { connectDatabase } from '../src/database/connection';
import { SyncChangeLog, SchoolSequence } from '../src/modules/sync/sync.models';

export async function pruneChanges(
  schoolIdStr?: string,
  retentionDays: number = 90,
  forcePruneBeforeSeq?: number,
) {
  if (mongoose.connection.readyState !== 1) {
    await connectDatabase();
  }

  const schoolFilter: any = {};
  if (schoolIdStr) {
    schoolFilter.schoolId = new Types.ObjectId(schoolIdStr);
  }

  const distinctSchools = await SyncChangeLog.distinct('schoolId', schoolFilter);

  for (const sid of distinctSchools) {
    const schoolId = typeof sid === 'string' ? new Types.ObjectId(sid) : sid;

    let deleteFilter: any = { schoolId };
    if (typeof forcePruneBeforeSeq === 'number') {
      deleteFilter.seq = { $lte: forcePruneBeforeSeq };
    } else {
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      deleteFilter.timestamp = { $lt: cutoffDate };
    }

    // Find the highest seq being deleted
    const highestDeletedDoc = await SyncChangeLog.findOne(deleteFilter).sort({ seq: -1 }).select('seq').lean();
    if (highestDeletedDoc) {
      const prunedSeq = highestDeletedDoc.seq;
      await SyncChangeLog.deleteMany(deleteFilter);

      // Update highestPrunedSeq in SchoolSequence
      await SchoolSequence.findOneAndUpdate(
        { schoolId },
        { $max: { highestPrunedSeq: prunedSeq } },
        { upsert: true, new: true },
      );
      console.log(`[PRUNE-CHANGES] School ${schoolId}: pruned changes up to seq ${prunedSeq}`);
    }
  }
}

if (require.main === module) {
  pruneChanges()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[PRUNE-CHANGES] Pruning failed:', err);
      process.exit(1);
    });
}
