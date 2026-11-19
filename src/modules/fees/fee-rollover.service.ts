import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { badRequest } from '../../utils/errors';
import { findOwned, oid, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { FeeHead, FeeStructure } from './fees.models';
import { FeeTemplate } from './fee-template';

type Ctx = SchoolContext;

export interface RolloverAdjustments {
  defaultPercent?: number;
  feeHeadAdjustments?: Record<string, number>;
  classAdjustments?: Record<string, number>;
}

export interface RolloverPreviewInput {
  fromSessionId: string;
  toSessionId: string;
  adjustments?: RolloverAdjustments;
}

export interface RolloverExecuteInput extends RolloverPreviewInput {
  overwriteExisting?: boolean;
  selectedClassIds?: string[];
}

/**
 * Calculates adjusted amount with percentage increase/decrease and rounding.
 * e.g., 5000 + 10% = 5500; 1250 + 15% = 1438 (rounded); minimum 0.
 */
export function calculateAdjustedAmount(originalAmount: number, percent = 0): number {
  if (!percent || Number.isNaN(percent)) return originalAmount;
  const adjusted = Math.round(originalAmount * (1 + percent / 100));
  return Math.max(0, adjusted);
}

/**
 * Previews carrying forward fee structures from source session to target session.
 * Shows original vs proposed amounts, percentage adjustments, and existing status.
 * Never modifies database.
 */
export async function previewFeeStructureRollover(ctx: Ctx, input: RolloverPreviewInput) {
  if (input.fromSessionId === input.toSessionId) {
    throw badRequest('Source and target academic sessions must be different');
  }

  const [fromSession, toSession] = await Promise.all([
    findOwned(AcademicSession, ctx, input.fromSessionId, 'Source session'),
    findOwned(AcademicSession, ctx, input.toSessionId, 'Target session'),
  ]);

  const [sourceStructures, existingTargetStructures, activeHeads, sourceTemplate, targetTemplate] = await Promise.all([
    FeeStructure.find(scope(ctx, { sessionId: fromSession._id, isActive: true }))
      .populate('classId', 'name level')
      .lean(),
    FeeStructure.find(scope(ctx, { sessionId: toSession._id })).select('classId').lean(),
    FeeHead.find(scope(ctx, { isActive: true })).lean(),
    FeeTemplate.findOne(scope(ctx, { sessionId: fromSession._id })).lean(),
    FeeTemplate.findOne(scope(ctx, { sessionId: toSession._id })).lean(),
  ]);

  const targetClassSet = new Set(existingTargetStructures.map((s) => s.classId.toString()));
  const activeHeadMap = new Map(activeHeads.map((h) => [h._id.toString(), h]));

  const adj = input.adjustments ?? {};
  const defaultPct = adj.defaultPercent ?? 0;

  let totalOrigMonthly = 0;
  let totalPropMonthly = 0;

  const structurePreviews = sourceStructures.map((struct) => {
    const classIdStr = struct.classId?._id?.toString() ?? struct.classId?.toString();
    const className = (struct.classId as any)?.name ?? 'Unknown Class';
    const classLevel = (struct.classId as any)?.level ?? 0;

    const classPct = adj.classAdjustments?.[classIdStr] ?? defaultPct;

    // Filter to active fee heads only (discontinued heads are omitted)
    const validItems = struct.items.filter((item) => activeHeadMap.has(item.feeHeadId.toString()));

    let origMonthly = 0;
    let propMonthly = 0;

    const itemPreviews = validItems.map((item) => {
      const headIdStr = item.feeHeadId.toString();
      const head = activeHeadMap.get(headIdStr)!;

      const pct = adj.feeHeadAdjustments?.[headIdStr] ?? classPct;
      const proposed = calculateAdjustedAmount(item.amount, pct);

      if (head.frequency === 'monthly') {
        origMonthly += item.amount;
        propMonthly += proposed;
      }

      return {
        feeHeadId: headIdStr,
        feeHeadName: head.name,
        feeHeadCode: head.code,
        frequency: head.frequency,
        billingMonths: item.billingMonths ?? [],
        originalAmount: item.amount,
        percentAdjustment: pct,
        proposedAmount: proposed,
      };
    });

    totalOrigMonthly += origMonthly;
    totalPropMonthly += propMonthly;

    const alreadyExists = targetClassSet.has(classIdStr);

    return {
      structureId: struct._id.toString(),
      classId: classIdStr,
      className,
      classLevel,
      structureName: struct.name,
      alreadyExists,
      status: alreadyExists ? ('exists' as const) : ('create' as const),
      originalMonthlyTotal: origMonthly,
      proposedMonthlyTotal: propMonthly,
      items: itemPreviews,
    };
  });

  // Sort by class level
  structurePreviews.sort((a, b) => a.classLevel - b.classLevel);

  // Template preview
  let templatePreview = null;
  if (sourceTemplate) {
    const templateItems = sourceTemplate.items
      .filter((i) => activeHeadMap.has(i.feeHeadId.toString()))
      .map((item) => {
        const headIdStr = item.feeHeadId.toString();
        const head = activeHeadMap.get(headIdStr)!;
        const pct = adj.feeHeadAdjustments?.[headIdStr] ?? defaultPct;
        const proposed = calculateAdjustedAmount(item.amount, pct);
        return {
          feeHeadId: headIdStr,
          feeHeadName: head.name,
          feeHeadCode: head.code,
          frequency: head.frequency,
          billingMonths: item.billingMonths ?? [],
          originalAmount: item.amount,
          percentAdjustment: pct,
          proposedAmount: proposed,
        };
      });

    templatePreview = {
      name: sourceTemplate.name,
      alreadyExists: Boolean(targetTemplate),
      items: templateItems,
    };
  }

  const existingCount = structurePreviews.filter((s) => s.alreadyExists).length;

  return {
    fromSession: { _id: fromSession._id.toString(), name: fromSession.name },
    toSession: { _id: toSession._id.toString(), name: toSession.name },
    adjustments: {
      defaultPercent: defaultPct,
      feeHeadAdjustments: adj.feeHeadAdjustments ?? {},
      classAdjustments: adj.classAdjustments ?? {},
    },
    structures: structurePreviews,
    template: templatePreview,
    summary: {
      totalSourceStructures: structurePreviews.length,
      newStructuresToCreate: structurePreviews.length - existingCount,
      existingStructuresInTarget: existingCount,
      originalTotalMonthly: totalOrigMonthly,
      proposedTotalMonthly: totalPropMonthly,
      netMonthlyDifference: totalPropMonthly - totalOrigMonthly,
    },
  };
}

/**
 * Executes the rollover of fee structures from source session to target session.
 * Never modifies source structures.
 * Idempotent: skips existing structures unless overwriteExisting is true.
 */
export async function executeFeeStructureRollover(ctx: Ctx, input: RolloverExecuteInput) {
  const preview = await previewFeeStructureRollover(ctx, input);

  const selectedClassSet = input.selectedClassIds?.length
    ? new Set(input.selectedClassIds)
    : null;

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const s of preview.structures) {
    if (selectedClassSet && !selectedClassSet.has(s.classId)) {
      continue;
    }

    const items = s.items.map((i) => ({
      feeHeadId: oid(i.feeHeadId),
      amount: i.proposedAmount,
      billingMonths: i.billingMonths,
    }));

    if (s.alreadyExists) {
      if (!input.overwriteExisting) {
        skippedCount++;
        continue;
      }
      // Overwrite existing in target session
      await FeeStructure.updateOne(
        scope(ctx, { sessionId: oid(input.toSessionId), classId: oid(s.classId) }),
        { $set: { name: s.structureName, items, isActive: true } },
      );
      updatedCount++;
    } else {
      // Create new structure in target session
      await FeeStructure.create({
        schoolId: oid(ctx.schoolId),
        sessionId: oid(input.toSessionId),
        classId: oid(s.classId),
        name: s.structureName,
        items,
        isActive: true,
      });
      createdCount++;
    }
  }

  // Rollover template if available
  if (preview.template) {
    const templateItems = preview.template.items.map((i) => ({
      feeHeadId: oid(i.feeHeadId),
      amount: i.proposedAmount,
      billingMonths: i.billingMonths,
    }));

    if (!preview.template.alreadyExists || input.overwriteExisting) {
      await FeeTemplate.findOneAndUpdate(
        scope(ctx, { sessionId: oid(input.toSessionId) }),
        { $set: { name: preview.template.name, items: templateItems } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    }
  }

  const hasAdjustments = Boolean(
    input.adjustments?.defaultPercent ||
      (input.adjustments?.feeHeadAdjustments && Object.keys(input.adjustments.feeHeadAdjustments).length > 0) ||
      (input.adjustments?.classAdjustments && Object.keys(input.adjustments.classAdjustments).length > 0),
  );

  // Update fee rollover status on target AcademicSession
  await AcademicSession.updateOne(
    scope(ctx, { _id: oid(input.toSessionId) }),
    { $set: { feeRolloverStatus: hasAdjustments ? 'customized' : 'copied' } },
  );

  await audit(ctx, {
    action: 'fee_structure.rollover',
    entityType: 'FeeStructure',
    summary: `Rolled over ${createdCount + updatedCount} fee structures from "${preview.fromSession.name}" to "${preview.toSession.name}"`,
    metadata: {
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      createdCount,
      updatedCount,
      skippedCount,
      hasAdjustments,
      adjustments: input.adjustments,
    },
  });

  return {
    fromSession: preview.fromSession,
    toSession: preview.toSession,
    createdCount,
    updatedCount,
    skippedCount,
    totalProcessed: createdCount + updatedCount + skippedCount,
  };
}
