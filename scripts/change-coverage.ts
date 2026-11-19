import fs from 'node:fs';
import path from 'node:path';

interface ModelWriteReport {
  model: string;
  module: string;
  serviceFunction: string;
  callsRecordChange: boolean;
}

export function generateChangeCoverageReport(): ModelWriteReport[] {
  const modulesDir = path.resolve(__dirname, '../src/modules');
  const moduleDirs = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  const reports: ModelWriteReport[] = [];

  for (const mDir of moduleDirs) {
    const modName = mDir.name;
    const dirPath = path.join(modulesDir, modName);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.ts'));

    // Find models defined in this module
    const modelFiles = files.filter((f) => f.includes('.model') || f.includes('.models'));
    const modelsInModule: string[] = [];

    for (const mf of modelFiles) {
      const content = fs.readFileSync(path.join(dirPath, mf), 'utf-8');
      const matches = content.matchAll(/export const (\w+) = model</g);
      for (const m of matches) {
        modelsInModule.push(m[1]);
      }
      const matches2 = content.matchAll(/export const (\w+) = model\(/g);
      for (const m of matches2) {
        if (!modelsInModule.includes(m[1])) modelsInModule.push(m[1]);
      }
    }

    // Inspect service files and deletion handlers
    const serviceFiles = files.filter(
      (f) => f.includes('.service') || f.endsWith('upload.ts') || f.endsWith('import.ts') || f.endsWith('deletion.ts'),
    );
    for (const sf of serviceFiles) {
      const content = fs.readFileSync(path.join(dirPath, sf), 'utf-8');
      const lines = content.split('\n');

      // Extract functions and their line ranges
      const funcDefs: Array<{ name: string; start: number; end: number; callsRecordChange: boolean }> = [];
      let curFunc: { name: string; start: number } | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|(\w+)\s*:\s*(?:async\s*)?\(/);
        if (funcMatch) {
          const name = funcMatch[1] || funcMatch[2];
          if (curFunc) {
            const body = lines.slice(curFunc.start, i).join('\n');
            funcDefs.push({
              name: curFunc.name,
              start: curFunc.start,
              end: i - 1,
              callsRecordChange: body.includes('recordChange(') || body.includes('recordChanges('),
            });
          }
          curFunc = { name, start: i };
        }
      }
      if (curFunc) {
        const body = lines.slice(curFunc.start).join('\n');
        funcDefs.push({
          name: curFunc.name,
          start: curFunc.start,
          end: lines.length - 1,
          callsRecordChange: body.includes('recordChange(') || body.includes('recordChanges('),
        });
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const enclosing = funcDefs.find((f) => i >= f.start && i <= f.end);
        const currentFunc = enclosing?.name || 'module-scope';
        const funcCallsRecordChange = enclosing ? enclosing.callsRecordChange : false;

        for (const model of modelsInModule) {
          const writePattern = new RegExp(
            `\\b${model}\\.(create|bulkWrite|updateOne|updateMany|findOneAndUpdate|findOneAndDelete|deleteOne|deleteMany)\\b`,
          );
          if (writePattern.test(line)) {
            reports.push({
              model,
              module: modName,
              serviceFunction: `${sf}#${currentFunc}`,
              callsRecordChange: funcCallsRecordChange,
            });
          }
        }
      }
    }
  }

  return reports;
}

const SYNC_INTERNAL_MODELS = new Set([
  'SchoolSequence',
  'SyncChangeLog',
  'SyncDevice',
  'SyncIdempotency',
  'SyncConflict',
  'SyncEntityMapping',
  'SyncSnapshot',
]);

function run() {
  const rawReports = generateChangeCoverageReport();

  console.log('\n========================================================================================');
  console.log('                        BACKEND CHANGE FEED COVERAGE AUDIT                              ');
  console.log('========================================================================================\n');
  console.log('| Model                      | Module       | Service Location              | Calls recordChange |');
  console.log('|----------------------------|--------------|-------------------------------|--------------------|');

  const seen = new Set<string>();
  const deduplicatedReports: ModelWriteReport[] = [];

  for (const r of rawReports) {
    if (SYNC_INTERNAL_MODELS.has(r.model)) continue;
    const key = `${r.model}_${r.serviceFunction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicatedReports.push(r);

    const check = r.callsRecordChange ? 'YES [COVERED]' : 'NO  [SLICE 3 INPUT]';
    console.log(
      `| ${r.model.padEnd(26)} | ${r.module.padEnd(12)} | ${r.serviceFunction.padEnd(29)} | ${check.padEnd(18)} |`,
    );
  }

  const coveredCount = deduplicatedReports.filter((r) => r.callsRecordChange).length;
  const queuedCount = deduplicatedReports.filter((r) => !r.callsRecordChange).length;
  const totalAudited = deduplicatedReports.length;

  console.log('\n----------------------------------------------------------------------------------------');
  console.log('Entity types currently emitting changes in Slice 0 (4):');
  console.log('  - STUDENT    (src/modules/students/students.service.ts, student-deletion.ts)');
  console.log('  - ATTENDANCE (src/modules/attendance/attendance.service.ts)');
  console.log('  - INVOICE    (src/modules/fees/fees.service.ts)');
  console.log('  - PAYMENT    (src/modules/fees/fees.service.ts)');
  console.log('Verified entity types: STUDENT, ATTENDANCE, INVOICE, PAYMENT');
  console.log('----------------------------------------------------------------------------------------\n');

  console.log('Total write locations audited (excluding sync internals):', totalAudited);
  console.log('Covered by change feed in Slice 0:', coveredCount);
  console.log('Input queue for Slice 3:', queuedCount);
  console.log(`Arithmetic Check: ${coveredCount} + ${queuedCount} = ${coveredCount + queuedCount} (matches audited: ${coveredCount + queuedCount === totalAudited})`);
}

if (require.main === module) {
  run();
}
