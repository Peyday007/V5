import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOOT_RETRY_FIRST_MS,
  BOOT_RETRY_MAX_MS,
  bootRetryDelay,
  retryBoot,
} from '../server/bootRetry.ts';

/**
 * Deploys 319, 324 and 334 each met a Supabase timeout at boot and served the
 * error for ever, because nothing asked again and Fly does not restart a
 * machine for failing a health check. These pin the asking-again.
 */
describe('a boot whose cloud proof failed asks again', () => {
  function harness(outcomes: Array<'fail' | 'ok'>) {
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const recovered: string[] = [];
    const failed: number[] = [];
    let calls = 0;
    const stop = retryBoot<string>({
      attempt: async () => {
        const outcome = outcomes[calls++] ?? 'fail';
        if (outcome === 'fail') throw new Error('HTTP 544 DatabaseTimeout');
        return `proof-${calls}`;
      },
      onRecovered: async (value) => {
        recovered.push(value);
      },
      onFailed: (attempt) => failed.push(attempt),
      schedule: (fn, ms) => pending.push({ fn, ms }),
    });
    const tick = async () => {
      const next = pending.shift();
      if (!next) return null;
      next.fn();
      await new Promise((resolve) => setImmediate(resolve));
      return next.ms;
    };
    return { pending, recovered, failed, stop, tick, calls: () => calls };
  }

  it('keeps asking until the proof holds, then hands over exactly once', async () => {
    const run = harness(['fail', 'fail', 'ok']);
    const waits = [await run.tick(), await run.tick(), await run.tick()];
    expect(waits).toEqual([BOOT_RETRY_FIRST_MS, BOOT_RETRY_FIRST_MS * 2, BOOT_RETRY_FIRST_MS * 4]);
    expect(run.failed).toEqual([1, 2]);
    expect(run.recovered).toEqual(['proof-3']);
    // Nothing is asked after the hand-over.
    expect(run.pending).toHaveLength(0);
    expect(await run.tick()).toBeNull();
    expect(run.calls()).toBe(3);
  });

  it('never stops asking during an outage, and never asks faster than the cap', async () => {
    const run = harness([]);
    for (let i = 0; i < 20; i++) await run.tick();
    expect(run.recovered).toEqual([]);
    expect(run.pending).toHaveLength(1);
    expect(run.pending[0]!.ms).toBe(BOOT_RETRY_MAX_MS);
    expect(bootRetryDelay(1)).toBe(BOOT_RETRY_FIRST_MS);
    expect(bootRetryDelay(50)).toBe(BOOT_RETRY_MAX_MS);
  });

  it('asks nothing once stopped', async () => {
    const run = harness(['ok']);
    run.stop();
    await run.tick();
    expect(run.recovered).toEqual([]);
  });

  it('is what boot does with a failed proof, and it retries the same proof boot ran', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    // The first proof and the retry are one function, so what counts as "the
    // cloud answered" cannot differ between them.
    expect(source).toMatch(/migrations = await proveCloud\(\)/);
    expect(source).toMatch(/retryBoot\(\{\s*attempt: proveCloud,/);
    // And the proof itself serves nothing: only main decides to serve the error.
    const proof = source.slice(
      source.indexOf('async function proveCloud'),
      source.indexOf('async function main'),
    );
    expect(proof.length).toBeGreaterThan(200);
    expect(proof).not.toMatch(/serveMigrationFailure\(/);
    expect(proof).toMatch(/await initStorage\(\)/);
    expect(proof).toMatch(/await initDatabase\(\)/);
  });
});
