/**
 * Brings MongoDB indexes in line with the models. Production disables autoIndex, so run this
 * after each deploy. It never drops an index unless asked to, and never before every new index
 * was built.
 *
 *   npm run db:indexes                               # report only: what would be created / dropped
 *   npm run db:indexes -- --apply                    # create missing indexes; drops nothing
 *   npm run db:indexes -- --apply --drop-obsolete    # then also replace/drop indexes the models no longer declare
 *
 * Before changing anything, the current index definitions of every collection are written to
 * backups/index-snapshot-<time>.json so they can be recreated by hand.
 *
 * Order with --apply:
 *   1. Create every missing index whose name is free. If one fails (typically duplicates for a
 *      new unique index), stop: nothing has been dropped, the error names the index.
 *   2. Only with --drop-obsolete: for an index whose definition changed under the same name,
 *      drop the old one and create the new one; if that fails, the old definition is restored.
 *      Then drop indexes no model declares.
 * Exit code: 0 in sync, 2 changes still pending (report / without --drop-obsolete), 1 error.
 */
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import '../src/app';
import { connectDatabase } from '../src/database/connection';

type Spec = [Record<string, unknown>, Record<string, unknown>];

function indexName(keys: Record<string, unknown>, options: Record<string, unknown>) {
  return (
    (options.name as string) ??
    Object.entries(keys)
      .map(([k, v]) => `${k}_${v}`)
      .join('_')
  );
}

export async function planIndexes() {
  const plan: Array<{
    model: string;
    collection: string;
    existing: Array<Record<string, any>>;
    create: Array<{ name: string; spec: Spec }>;
    replace: Array<{ name: string; spec: Spec; old: Record<string, any> }>;
    drop: Array<Record<string, any>>;
  }> = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const existing = (await model
      .listIndexes()
      .catch((err: any) => (err.codeName === 'NamespaceNotFound' ? [] : Promise.reject(err)))) as any[];
    const diff = (await model.diffIndexes({ indexOptionsToCreate: true } as any)) as {
      toDrop: string[];
      toCreate: Spec[];
    };
    const byName = new Map(existing.map((i) => [i.name, i]));
    const create: Array<{ name: string; spec: Spec }> = [];
    const replace: Array<{ name: string; spec: Spec; old: Record<string, any> }> = [];
    for (const spec of diff.toCreate) {
      const n = indexName(spec[0], spec[1] ?? {});
      if (byName.has(n)) replace.push({ name: n, spec, old: byName.get(n)! });
      else create.push({ name: n, spec });
    }
    const replaced = new Set(replace.map((r) => r.name));
    const drop = diff.toDrop
      .filter((n) => !replaced.has(n))
      .map((n) => byName.get(n)!)
      .filter(Boolean);
    plan.push({ model: name, collection: model.collection.collectionName, existing, create, replace, drop });
  }
  return plan;
}

function recreateOptions(idx: Record<string, any>) {
  const { v: _v, key: _k, ns: _ns, ...opts } = idx;
  return opts;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dropObsolete = process.argv.includes('--drop-obsolete');
  await connectDatabase();
  const plan = await planIndexes();

  const dir = path.resolve(process.env.BACKUP_DIR ?? './backups');
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = path.join(dir, `index-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snapshot, JSON.stringify(Object.fromEntries(plan.map((p) => [p.collection, p.existing])), null, 2), {
    mode: 0o600,
  });
  console.log(`Database: ${mongoose.connection.name}. Current index definitions saved to ${snapshot}`);

  let pending = 0;
  for (const p of plan) {
    for (const c of p.create)
      console.log(
        `  ${p.collection}: CREATE ${c.name} ${JSON.stringify(c.spec[0])} ${JSON.stringify(c.spec[1] ?? {})}`,
      );
    for (const r of p.replace) console.log(`  ${p.collection}: REPLACE ${r.name} (definition changed)`);
    for (const d of p.drop) console.log(`  ${p.collection}: OBSOLETE ${d.name} ${JSON.stringify(d.key)}`);
    pending += p.create.length + p.replace.length + p.drop.length;
  }
  if (!pending) {
    console.log('All indexes are in sync.');
    return 0;
  }
  if (!apply) {
    console.log(
      `${pending} change(s) pending. Dry run: nothing changed. Use --apply (and --drop-obsolete to replace/drop).`,
    );
    return 2;
  }

  // 1. Create missing indexes. Nothing is dropped if any of them fails.
  for (const p of plan)
    for (const c of p.create) {
      try {
        await mongoose.connection.db!.collection(p.collection).createIndex(c.spec[0] as any, c.spec[1] as any);
        console.log(`  ${p.collection}: created ${c.name}`);
      } catch (err) {
        console.error(
          `  ${p.collection}: could NOT create ${c.name}: ${(err as Error).message.slice(0, 300)}\n` +
            'Stopped. No index was dropped. Resolve the conflicting records (for duplicates run `npm run migrate:2026-10`) and run again.',
        );
        return 1;
      }
    }
  const remaining = plan.reduce((n, p) => n + p.replace.length + p.drop.length, 0);
  if (!dropObsolete) {
    if (remaining)
      console.log(
        `${remaining} index(es) to replace or drop. Re-run with --apply --drop-obsolete after reviewing the list above.`,
      );
    return remaining ? 2 : 0;
  }

  // 2. Replace changed definitions (restore the old one on failure), then drop obsolete ones.
  for (const p of plan) {
    const coll = mongoose.connection.db!.collection(p.collection);
    for (const r of p.replace) {
      await coll.dropIndex(r.name);
      try {
        await coll.createIndex(r.spec[0] as any, r.spec[1] as any);
        console.log(`  ${p.collection}: replaced ${r.name}`);
      } catch (err) {
        await coll
          .createIndex(r.old.key, recreateOptions(r.old))
          .catch((e) =>
            console.error(
              `  ${p.collection}: ALSO FAILED to restore ${r.name}; recreate it from ${snapshot}: ${(e as Error).message}`,
            ),
          );
        console.error(
          `  ${p.collection}: could NOT replace ${r.name} (old definition restored): ${(err as Error).message.slice(0, 300)}`,
        );
        return 1;
      }
    }
    for (const d of p.drop) {
      await coll.dropIndex(d.name);
      console.log(`  ${p.collection}: dropped obsolete ${d.name}`);
    }
  }
  console.log('Indexes are in sync.');
  return 0;
}

if (require.main === module)
  main()
    .then(async (code) => {
      await mongoose.disconnect();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
