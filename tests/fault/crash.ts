import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Runs tests/fault/crash-child.ts, waits until it reaches its checkpoint (half-way through a
 * workflow), then kills it hard and waits for the process to be gone.
 */
export async function crashAtCheckpoint(scenario: string, args: Record<string, unknown>): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'crash-child.ts'), scenario, JSON.stringify(args)],
    {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child never reached the checkpoint: ${out} ${err.slice(-500)}`)),
      45_000,
    );
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('CHECKPOINT')) {
        clearTimeout(timer);
        resolve();
      } else if (out.includes('ERROR') || out.includes('FINISHED')) {
        clearTimeout(timer);
        reject(new Error(`child did not stop at the checkpoint: ${out}`));
      }
    });
  });
  child.kill('SIGKILL');
  await exited;
}
