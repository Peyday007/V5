/**
 * A Russell pass that never settles does not stop the tick.
 *
 * Production 2026-11-06: no tick completed after the 03:34Z restart and no deep
 * dive started for six hours, because the one-tick-at-a-time timer waited on a
 * tick that never returned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hungRussellPasses, runPass } from '../server/services/russell/loop.ts';

beforeEach(() => {
  process.env['BRAIN_RUSSELL_PASS_LIMIT_MS'] = '1000';
});
afterEach(() => {
  delete process.env['BRAIN_RUSSELL_PASS_LIMIT_MS'];
});

describe('runPass bound', () => {
  it('records a pass that never settles, goes on, and skips it until it settles', async () => {
    let release: () => void = () => undefined;
    const never = new Promise<void>((resolve) => (release = resolve));
    const report = { passFailures: [] as { pass: string; error: string }[], deferred: [] as string[] };

    const started = Date.now();
    expect(await runPass(report, 'stuck-pass', () => never)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(report.passFailures[0]?.error).toMatch(/did not settle/);
    expect(hungRussellPasses()).toContain('stuck-pass');

    let ranAgain = false;
    expect(await runPass(report, 'stuck-pass', async () => { ranAgain = true; })).toBe(false);
    expect(ranAgain).toBe(false);
    expect(report.passFailures[1]?.error).toMatch(/has not settled/);

    expect(await runPass(report, 'other-pass', async () => undefined)).toBe(true);

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hungRussellPasses()).not.toContain('stuck-pass');
    expect(await runPass(report, 'stuck-pass', async () => { ranAgain = true; })).toBe(true);
    expect(ranAgain).toBe(true);
  });
});
