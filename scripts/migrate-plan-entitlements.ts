/**
 * Plan and entitlement migration. Safe to re-run; changes nothing without --apply.
 *
 *   npm run migrate:plan-entitlements            # dry run: report only
 *   npm run migrate:plan-entitlements -- --apply # apply
 *
 * 1. Creates the Basic, Pro and Pro Max templates if they do not exist (never overwrites a plan).
 * 2. Existing plans: translates their old free-text features to feature-registry keys
 *    (core → every core module and both web portals; parent_portal → parent web portal;
 *    automations → automations; ai_copilot → every AI feature). Values that are not software
 *    capabilities (e.g. priority_support) are moved to the plan's marketing highlights. Missing
 *    pricing fields are filled from the old monthly price (yearly billing disabled).
 *    The API already reads old feature strings this way, so schools' access does not change.
 * 3. Schools: reports each school's plan and effective features. Records the plan's current
 *    price as the agreed price where none is stored. Schools without a plan are listed: they
 *    get the core features only (no AI, no mobile apps) until a plan is assigned; none is
 *    assigned automatically.
 *
 * Nothing is deleted, no school is moved to another plan, and no school gains AI it did not have.
 */
import mongoose from 'mongoose';
import '../src/app';
import { featureDef, isFeatureKey, LEGACY_FEATURE_MAP, normaliseFeatures } from '../src/config/entitlements';
import { connectDatabase } from '../src/database/connection';
import { School } from '../src/modules/schools/school.model';
import { DEFAULT_PLAN_TEMPLATES, templateDocument } from '../src/modules/subscriptions/default-plans';
import { computeEntitlements, type SubscriptionLike } from '../src/modules/subscriptions/entitlements.service';
import { Plan } from '../src/modules/subscriptions/plan.model';

const NON_CAPABILITY_LABELS: Record<string, string> = { priority_support: 'Priority support' };

export async function migratePlanEntitlements(apply: boolean, log: (line: string) => void = console.log) {
  const report = {
    templatesCreated: [] as string[],
    plansUpdated: [] as string[],
    schoolsPriced: 0,
    schoolsWithoutPlan: [] as string[],
  };

  for (const tpl of DEFAULT_PLAN_TEMPLATES) {
    if (await Plan.exists({ code: tpl.code })) {
      log(`  template ${tpl.code}: already exists, left unchanged`);
      continue;
    }
    report.templatesCreated.push(tpl.code);
    log(`  template ${tpl.code}: ${apply ? 'created' : 'would be created'}`);
    if (apply) await Plan.create(templateDocument(tpl));
  }

  const plans = await Plan.find().lean();
  for (const plan of plans) {
    const stored = plan.features ?? [];
    const legacy = stored.filter((f) => !isFeatureKey(f));
    const set: Record<string, unknown> = {};
    if (legacy.length) {
      set.features = normaliseFeatures(stored);
      const labels = legacy.filter((f) => !LEGACY_FEATURE_MAP[f]).map((f) => NON_CAPABILITY_LABELS[f] ?? f);
      if (labels.length) set.highlights = [...new Set([...(plan.highlights ?? []), ...labels])];
    }
    if (!plan.prices?.monthly)
      set.prices = {
        monthly: { amount: plan.priceMonthlyPkr ?? 0, enabled: true },
        yearly: { amount: 0, enabled: false },
      };
    if (!plan.currency) set.currency = 'PKR';
    if (plan.published === undefined) set.published = true;
    if (plan.version === undefined) set.version = 1;
    if (!Object.keys(set).length) continue;
    report.plansUpdated.push(plan.code);
    log(
      `  plan ${plan.code}: ${apply ? 'updated' : 'would update'} ${Object.keys(set).join(', ')}` +
        (legacy.length
          ? ` (old features ${JSON.stringify(legacy)} → ${normaliseFeatures(stored).length} registry features)`
          : ''),
    );
    if (apply) await Plan.updateOne({ _id: plan._id }, { $set: set });
  }

  const byId = new Map((await Plan.find().lean()).map((p) => [String(p._id), p]));
  const schools = await School.find().select('name code subscription').lean();
  for (const s of schools) {
    const plan = s.subscription?.planId ? (byId.get(String(s.subscription.planId)) ?? null) : null;
    const ent = computeEntitlements(s.subscription as SubscriptionLike, plan);
    const premium = [...ent.features].filter((f) => ['ai', 'mobile'].includes(featureDef(f)!.category));
    log(
      `  school ${s.code}: plan ${plan?.code ?? '(none: core features only)'}, status ${s.subscription?.status ?? 'trialing'}, ` +
        `${ent.features.size} features${premium.length ? `, premium: ${premium.join(', ')}` : ', no AI or mobile'}`,
    );
    if (!plan) report.schoolsWithoutPlan.push(s.code);
    if (plan && s.subscription?.agreedPrice?.amount == null) {
      report.schoolsPriced++;
      const amount = plan.prices?.monthly?.amount ?? plan.priceMonthlyPkr ?? 0;
      log(
        `    agreed price: ${apply ? 'recorded' : 'would record'} ${plan.currency ?? 'PKR'} ${amount}/month (the plan's current price)`,
      );
      if (apply)
        await School.updateOne(
          { _id: s._id },
          {
            $set: {
              'subscription.billingPeriod': s.subscription?.billingPeriod ?? 'monthly',
              'subscription.agreedPrice': {
                amount,
                currency: plan.currency ?? 'PKR',
                period: 'monthly',
                setAt: new Date(),
              },
            },
          },
        );
    }
  }
  return report;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDatabase();
  console.log(apply ? 'Applying plan migration…' : 'Dry run (use --apply to change data)…');
  const r = await migratePlanEntitlements(apply);
  console.log(
    `  Templates created: ${r.templatesCreated.length}; plans updated: ${r.plansUpdated.length}; agreed prices recorded: ${r.schoolsPriced}; ` +
      `schools without a plan: ${r.schoolsWithoutPlan.length ? r.schoolsWithoutPlan.join(', ') : 'none'}`,
  );
}

if (require.main === module)
  main()
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      console.error(err);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
