import bcrypt from 'bcryptjs';
import { afterAll, describe, expect, it } from 'vitest';
import { closeHasherPool, compareInWorker, hashInWorker } from '../src/modules/auth/password-hasher';

describe('password hashing in worker threads', () => {
  afterAll(() => closeHasherPool());

  it('produces standard bcrypt hashes, compatible both ways with existing ones', async () => {
    const h = await hashInWorker('Secret-Pass-123', 6);
    expect(h).toMatch(/^\$2[aby]\$06\$/);
    expect(await bcrypt.compare('Secret-Pass-123', h)).toBe(true);
    const legacy = await bcrypt.hash('Old-Pass-123', 6);
    expect(await compareInWorker('Old-Pass-123', legacy)).toBe(true);
    expect(await compareInWorker('wrong', legacy)).toBe(false);
  });

  it('keeps the main thread responsive while hashing at production cost', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => hashInWorker('Busy-Pass-123', 11)));
    clearInterval(timer);
    const elapsed = Date.now() - started;
    // With hashing on the main thread the interval could not fire at all until it finished.
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 10 / 3));
  });
});
