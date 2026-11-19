/**
 * Offline backup tool. Does not start the API and does not read .env.
 *
 *   npm run backup:keygen
 *       Prints a new random BACKUP_ENCRYPTION_KEY. Store it in a password manager AND offline;
 *       a backup cannot be restored without it.
 *
 *   npm run backup:verify -- --archive <file.tar.gz.enc> [--manifest <file.manifest.json>] [--key-file <file>]
 *       Checks the download (SHA-256 vs manifest), decrypts in memory and checks every entry.
 *       Writes nothing.
 *
 *   npm run backup:restore -- --archive <file> --manifest <file> --target-uri <mongodb uri with db name>
 *        --confirm-target <db name> --storage-dir <empty folder> [--work-dir <new folder>] [--dry-run] [--key-file <file>]
 *       Restores into an EMPTY database and an EMPTY storage folder, then re-checks counts,
 *       indexes, financial totals, accounts, guardian links and file checksums.
 *
 * Key: environment variable BACKUP_ENCRYPTION_KEY, or --key-file (a file containing only the key).
 * Never pass the key itself as an argument (it would be kept in shell history).
 * Target URI: environment variable RESTORE_TARGET_URI or --target-uri.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKey, keyId, parseKey } from '../src/modules/backups/backup-crypto';
import { restoreBackup, verifyBackup, type Check } from '../src/modules/backups/restore';

function args() {
  const out: Record<string, string | boolean> = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function loadKey(a: Record<string, string | boolean>) {
  const raw =
    typeof a['key-file'] === 'string'
      ? fs.readFileSync(a['key-file'], 'utf8').trim()
      : process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) throw new Error('Provide the key with BACKUP_ENCRYPTION_KEY or --key-file');
  return parseKey(raw);
}

function printChecks(checks: Check[]) {
  for (const c of checks) console.log(`  ${c.status.padEnd(4)}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

function redactUri(uri: string) {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}

async function main() {
  const cmd = process.argv[2];
  const a = args();
  if (cmd === 'keygen') {
    const key = generateKey();
    console.log(key);
    console.error(`Key id: ${keyId(parseKey(key))}. Store this key safely; it is not saved anywhere.`);
    return 0;
  }
  if (cmd === 'verify') {
    if (typeof a.archive !== 'string') throw new Error('--archive is required');
    const res = await verifyBackup({
      archive: a.archive,
      manifest: typeof a.manifest === 'string' ? a.manifest : undefined,
      key: loadKey(a),
    });
    console.log(`Backup ${res.manifest?.backupId ?? '(unknown)'} created ${res.manifest?.createdAt ?? '?'}`);
    printChecks(res.checks);
    if (!a.manifest) console.log('  NOTE  no --manifest given: the download checksum was not compared');
    console.log(res.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    return res.ok ? 0 : 1;
  }
  if (cmd === 'restore') {
    const targetUri = (typeof a['target-uri'] === 'string' ? a['target-uri'] : process.env.RESTORE_TARGET_URI) ?? '';
    if (typeof a.archive !== 'string' || typeof a['storage-dir'] !== 'string')
      throw new Error('--archive, --manifest, --target-uri, --confirm-target and --storage-dir are required');
    const workDir =
      typeof a['work-dir'] === 'string'
        ? a['work-dir']
        : path.join(os.tmpdir(), `school-os-restore-${process.pid}-${Date.now()}`);
    console.log(
      `Target: ${redactUri(targetUri)}  storage: ${path.resolve(a['storage-dir'])}${a['dry-run'] ? '  (dry run)' : ''}`,
    );
    const report = await restoreBackup({
      archive: a.archive,
      manifest: typeof a.manifest === 'string' ? a.manifest : undefined,
      key: loadKey(a),
      targetUri,
      confirmTarget: typeof a['confirm-target'] === 'string' ? a['confirm-target'] : '',
      storageDir: a['storage-dir'],
      workDir,
      dryRun: Boolean(a['dry-run']),
      log: (m) => console.log(m),
    });
    printChecks(report.checks);
    console.log(`Duration: ${(report.durationMs / 1000).toFixed(1)} s`);
    console.log(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    if (typeof a.report === 'string') fs.writeFileSync(a.report, JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  console.log('Usage: backup-tool <keygen|verify|restore> [options]  (see the header of scripts/backup-tool.ts)');
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
