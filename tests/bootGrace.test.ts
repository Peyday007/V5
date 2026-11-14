/**
 * The boot grace keeps optional work and the boot's re-derivations out of the
 * window the release's after-restart verification measures (2026-11-14).
 *
 * Deploy 43641501207: `/healthz` took 10.2 s while a scenario ran two minutes
 * after the restart, beside the boot's packet resume (past its 90 s bound),
 * the every-project recompute (88 s), the self-model scan and every optional
 * Russell pass. Each of those now waits out the one grace the goal-plan pass
 * already used.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterBootGrace,
  bootGraceRemainingMs,
  DEFERRABLE_UNDER_PRESSURE,
  runPass,
  setOptionalBootGraceMs,
} from '../server/services/russell/loop.ts';

const TEN_MINUTES = 10 * 60_000;

afterEach(() => {
  setOptionalBootGraceMs(0);
  vi.useRealTimers();
});

describe('the optional-work boot grace', () => {
  it('defers every optional Russell pass inside the grace, and runs it once the grace has passed', async () => {
    setOptionalBootGraceMs(TEN_MINUTES);
    expect(bootGraceRemainingMs()).toBeGreaterThan(0);
    for (const name of DEFERRABLE_UNDER_PRESSURE) {
      const report = { passFailures: [], deferred: [] as string[] };
      const fn = vi.fn(async () => undefined);
      expect(await runPass(report, name, fn)).toBe(false);
      expect(fn).not.toHaveBeenCalled();
      expect(report.deferred).toEqual([`${name} (boot grace)`]);
    }

    setOptionalBootGraceMs(0);
    const report = { passFailures: [], deferred: [] as string[] };
    const fn = vi.fn(async () => undefined);
    expect(await runPass(report, 'retrospectives', fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('never defers a pass that is not optional', async () => {
    setOptionalBootGraceMs(TEN_MINUTES);
    const report = { passFailures: [], deferred: [] as string[] };
    const fn = vi.fn(async () => undefined);
    expect(await runPass(report, 'writeback', fn)).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
    expect(report.deferred).toEqual([]);
  });

  it('starts boot work only after the grace, and at once when it has passed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    setOptionalBootGraceMs(TEN_MINUTES);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const work = vi.fn();
    afterBootGrace('test work', work);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(bootGraceRemainingMs() - 1);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledOnce();

    setOptionalBootGraceMs(0);
    const now = vi.fn();
    afterBootGrace('test work', now);
    expect(now).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('is how the boot starts its packet resume, its recompute and its self-model scan', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    const boot = source.slice(source.indexOf('async function continueBoot'));
    for (const [label, call] of [
      ['resume worker-driven packets', 'resumePulledPackets'],
      ['the self-model scan', 'scanIfStale()'],
      ['rebuild derived state', 'recomputeProject('],
    ] as const) {
      const grace = boot.indexOf(`afterBootGrace('${label}'`);
      const at = boot.indexOf(call, grace);
      expect({ label, graced: grace > 0 && at > grace }).toEqual({ label, graced: true });
      // And nothing calls it outside the grace.
      expect({ label, before: boot.slice(0, grace).includes(call) }).toEqual({ label, before: false });
    }
  });
});
