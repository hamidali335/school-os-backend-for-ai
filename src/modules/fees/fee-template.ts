import { model, Schema } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { notFound } from '../../utils/errors';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { assertRefs, campusScope, oid, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { feeSettings, checkStructureItems } from './fees.service';
import { FeeStructure } from './fees.models';

type Ctx = SchoolContext;
type Item = { feeHeadId: string; amount: number; billingMonths?: number[] };

/**
 * A school's default fee structure for a session: what a newly created class is charged until an
 * administrator changes that class. One per school and session. It is a starting point only:
 * a class's own structure is never overwritten by later template changes.
 */
const FeeTemplateSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      name: { type: String, required: true, trim: true },
      items: {
        type: [
          {
            _id: false,
            feeHeadId: { type: ObjectId, ref: 'FeeHead', required: true },
            amount: { type: Number, required: true, min: 0 },
            billingMonths: { type: [Number], default: [] },
          },
        ],
        default: [],
      },
    },
    baseOptions,
  ),
);
FeeTemplateSchema.index({ schoolId: 1, sessionId: 1 }, { unique: true });
export const FeeTemplate = model('FeeTemplate', FeeTemplateSchema);

export function getFeeTemplate(ctx: Ctx, sessionId: string) {
  return FeeTemplate.findOne(scope(ctx, { sessionId: oid(sessionId) }))
    .populate('items.feeHeadId', 'name code frequency billing')
    .lean();
}

export async function saveFeeTemplate(ctx: Ctx, input: { sessionId: string; name: string; items: Item[] }) {
  await assertRefs(ctx, [[AcademicSession, input.sessionId, 'sessionId']]);
  await checkStructureItems(ctx, input.items);
  const doc = await FeeTemplate.findOneAndUpdate(
    scope(ctx, { sessionId: oid(input.sessionId) }),
    { $set: { name: input.name, items: input.items } },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  await audit(ctx, {
    action: 'fee_template.save',
    entityType: 'FeeTemplate',
    entityId: doc!._id,
    metadata: { items: input.items.length },
  });
  return getFeeTemplate(ctx, input.sessionId);
}

export async function deleteFeeTemplate(ctx: Ctx, sessionId: string) {
  const doc = await FeeTemplate.findOneAndDelete(scope(ctx, { sessionId: oid(sessionId) })).lean();
  if (!doc) throw notFound('Default fee structure');
  await audit(ctx, { action: 'fee_template.delete', entityType: 'FeeTemplate', entityId: doc._id });
}

/** Each active class and what applying the template would do for it (nothing is written). */
export async function previewFeeTemplate(ctx: Ctx, sessionId: string) {
  const [template, classes, structures] = await Promise.all([
    FeeTemplate.findOne(scope(ctx, { sessionId: oid(sessionId) })).lean(),
    SchoolClass.find(scope(ctx, { ...campusScope(ctx), status: { $ne: 'inactive' } }))
      .select('name level')
      .sort({ level: 1, name: 1 })
      .lean(),
    FeeStructure.find(scope(ctx, { sessionId: oid(sessionId) }))
      .select('classId name')
      .lean(),
  ]);
  const has = new Map(structures.map((s) => [String(s.classId), s.name]));
  return {
    hasTemplate: Boolean(template),
    classes: classes.map((c) => ({
      classId: c._id,
      name: c.name,
      action: has.has(String(c._id)) ? ('keep' as const) : template ? ('create' as const) : ('none' as const),
      existingStructure: has.get(String(c._id)) ?? null,
    })),
  };
}

/**
 * Gives the template to classes that have no structure for the session yet (all such classes, or
 * the chosen ones). A class that already has one keeps it, untouched. Safe to repeat.
 */
export async function applyFeeTemplate(ctx: Ctx, sessionId: string, classIds?: string[]) {
  const template = await FeeTemplate.findOne(scope(ctx, { sessionId: oid(sessionId) })).lean();
  if (!template) throw notFound('Default fee structure');
  const preview = await previewFeeTemplate(ctx, sessionId);
  const wanted = classIds ? new Set(classIds) : null;
  const created: string[] = [];
  const kept: string[] = [];
  for (const c of preview.classes) {
    if (wanted && !wanted.has(String(c.classId))) continue;
    if (c.action !== 'create') {
      kept.push(c.name);
      continue;
    }
    if (await createFromTemplate(ctx, template, c.classId)) created.push(c.name);
    else kept.push(c.name);
  }
  await audit(ctx, {
    action: 'fee_template.apply',
    entityType: 'FeeTemplate',
    entityId: template._id,
    metadata: { created, kept: kept.length },
  });
  return { created, kept };
}

type TemplateDoc = {
  _id: unknown;
  sessionId: unknown;
  name: string;
  items: Array<{ feeHeadId: unknown; amount: number; billingMonths?: number[] }>;
};

/** Inserts the class's structure only when it has none ($setOnInsert): a retry never duplicates or overwrites. */
async function createFromTemplate(ctx: Ctx, template: TemplateDoc, classId: unknown): Promise<boolean> {
  const res = await FeeStructure.updateOne(
    scope(ctx, { sessionId: template.sessionId, classId }),
    {
      $setOnInsert: {
        name: template.name,
        items: template.items.map((i) => ({
          feeHeadId: i.feeHeadId,
          amount: i.amount,
          billingMonths: i.billingMonths ?? [],
        })),
        isActive: true,
      },
    },
    { upsert: true },
  );
  if (!res.upsertedCount) return false;
  await audit(ctx, {
    action: 'fee_structure.from_template',
    entityType: 'FeeStructure',
    entityId: res.upsertedId ?? undefined,
    metadata: { classId: String(classId), templateId: String(template._id) },
  });
  return true;
}

/**
 * A class was just created: it starts with the current session's default structure, when the
 * school has one. Never fails the class creation; the administrator can apply it later.
 */
export async function inheritFeeTemplate(ctx: Ctx, classId: unknown): Promise<boolean> {
  try {
    const { currentSessionId } = await feeSettings(ctx.schoolId);
    if (!currentSessionId) return false;
    const template = await FeeTemplate.findOne(scope(ctx, { sessionId: oid(currentSessionId) })).lean();
    if (!template) return false;
    return await createFromTemplate(ctx, template, classId);
  } catch (err) {
    logger.warn({ err, classId: String(classId) }, 'Could not give a new class the default fee structure');
    return false;
  }
}
