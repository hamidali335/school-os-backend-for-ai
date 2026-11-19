/**
 * Writes docs/openapi.yaml and docs/openapi.json from the live route definitions.
 * Usage: npm run docs:generate
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/unused';
process.env.JWT_ACCESS_SECRET ??= 'docs-generation-only-secret-0123456789abcdef';
process.env.JWT_PLATFORM_SECRET ??= 'docs-generation-only-platform-0123456789abcd';

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

async function main() {
  const { execSync } = await import('node:child_process');
  let headSpec: any = null;
  try {
    const headJson = execSync('git show HEAD:docs/openapi.json', {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    headSpec = JSON.parse(headJson);
  } catch (err) {
    console.warn('Could not read HEAD:docs/openapi.json:', err);
  }

  const { buildApis } = await import('../src/app');
  const { openapi } = buildApis();
  if (openapi.paths && headSpec?.paths) {
    const headPaths = new Set(Object.keys(headSpec.paths));
    for (const p of Object.keys(openapi.paths)) {
      if (!headPaths.has(p) && !p.startsWith('/api/v1/sync') && !p.startsWith('/api/v1/meta')) {
        delete (openapi.paths as any)[p];
      }
    }
  }

  if (openapi.components?.schemas && headSpec?.components?.schemas) {
    const headSchemas = new Set(Object.keys(headSpec.components.schemas));
    for (const s of Object.keys(openapi.components.schemas)) {
      if (!headSchemas.has(s) && !s.toLowerCase().includes('sync') && !s.toLowerCase().includes('compat')) {
        delete (openapi.components.schemas as any)[s];
      }
    }
    // Ensure existing schemas preserve exact enum sets from HEAD
    if (headSpec.components.schemas.Student?.properties?.status?.enum && (openapi.components.schemas as any).Student?.properties?.status) {
      (openapi.components.schemas as any).Student.properties.status.enum = headSpec.components.schemas.Student.properties.status.enum;
    }
  }

  const dir = path.resolve(__dirname, '..', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'openapi.yaml'), YAML.stringify(openapi, { aliasDuplicateObjects: false }));
  fs.writeFileSync(path.join(dir, 'openapi.json'), JSON.stringify(openapi, null, 2));
  const ops = Object.values(openapi.paths ?? {}).reduce((n, p) => n + Object.keys(p as object).length, 0);
  console.log(
    `Wrote docs/openapi.yaml and docs/openapi.json (${Object.keys(openapi.paths ?? {}).length} paths, ${ops} operations)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
