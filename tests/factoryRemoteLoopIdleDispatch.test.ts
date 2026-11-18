import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dispatchAfterLinePass } from '../server/services/factory/remoteLoop.ts';
import type { LineReading } from '../server/services/factory/line.ts';

/*
 * The recorded failure (2026-11-18T16:47:13): the FACTORY line read
 * waiting=1, running=0, capacity=1 — "1 piece(s) of executable work and 1 free
 * surface(s), and nothing is running or arriving" — and stayed there, because the
 * remote loop only asked the dispatcher to place work when its own tick created a
 * bin. A bin that became READY any other way (an expired lease, a hand-back, a
 * reopened no-show) waited on the dispatcher's separate wake.
 */

type Idle = Pick<LineReading, 'unexplainedIdle' | 'executable' | 'active' | 'capacity'>;

function reading(overrides: Partial<Idle> = {}): Idle {
  const executable = overrides.executable ?? { queued: 0, readyBins: 1, total: 1 };
  const active = overrides.active ?? { leasedBins: 0, arriving: 0, workingCampaigns: 1 };
  const capacity = overrides.capacity ?? { freeSurfaces: 1, surfaces: [] };
  // The same predicate readLine computes.
  const unexplainedIdle =
    executable.total > 0 && capacity.freeSurfaces > 0 && active.leasedBins === 0 && active.arriving === 0;
  return { executable, active, capacity, unexplainedIdle, ...overrides };
}

const nothingCreated = [{ created: [] as string[] }, { created: [] as string[] }];

/** The rule before this change: dispatch only on a creation. */
function previousRule(reports: readonly { created: string[] }[]): boolean {
  return reports.some((report) => report.created.length > 0);
}

describe('remote loop dispatches when the line reads unexplained idle', () => {
  it('reproduces the recorded failure class and asks the dispatcher on that pass', () => {
    const idle = reading();
    expect(idle.unexplainedIdle).toBe(true);
    expect(idle.executable.total).toBe(1);
    expect(idle.capacity.freeSurfaces).toBe(1);
    expect(idle.active.leasedBins).toBe(0);
    expect(idle.active.arriving).toBe(0);

    // Before: nothing was created, so the pass never asked the dispatcher.
    expect(previousRule(nothingCreated)).toBe(false);
    // After: the idle reading alone is a reason to dispatch now.
    expect(dispatchAfterLinePass(nothingCreated, idle)).toBe(true);
  });

  it('keeps dispatching when a report created a bin', () => {
    const quiet = reading({ executable: { queued: 0, readyBins: 0, total: 0 } });
    expect(dispatchAfterLinePass([{ created: [] }, { created: ['bin_1'] }], quiet)).toBe(true);
    expect(dispatchAfterLinePass([{ created: ['bin_1'] }], null)).toBe(true);
  });

  it('does not add a dispatch pass on a quiet line', () => {
    const empty = reading({ executable: { queued: 0, readyBins: 0, total: 0 } });
    expect(empty.unexplainedIdle).toBe(false);
    expect(dispatchAfterLinePass(nothingCreated, empty)).toBe(false);

    const running = reading({ active: { leasedBins: 1, arriving: 0, workingCampaigns: 1 } });
    expect(running.unexplainedIdle).toBe(false);
    expect(dispatchAfterLinePass(nothingCreated, running)).toBe(false);

    const arriving = reading({ active: { leasedBins: 0, arriving: 1, workingCampaigns: 1 } });
    expect(dispatchAfterLinePass(nothingCreated, arriving)).toBe(false);

    const noSurface = reading({ capacity: { freeSurfaces: 0, surfaces: [] } });
    expect(dispatchAfterLinePass(nothingCreated, noSurface)).toBe(false);
  });

  it('keeps the creation-only rule when the line pass threw', () => {
    expect(dispatchAfterLinePass(nothingCreated, null)).toBe(false);
    expect(dispatchAfterLinePass([], null)).toBe(false);
  });

  it('adds no dispatch pass when every idle bin is stranded, and does when one is not', () => {
    const allStranded = { ...reading(), stranded: { bins: 1, reasons: ['factory_plan bin b: superseded'] } };
    expect(allStranded.unexplainedIdle).toBe(true);
    expect(dispatchAfterLinePass(nothingCreated, allStranded)).toBe(false);

    const oneFireable = {
      ...reading({ executable: { queued: 0, readyBins: 2, total: 2 } }),
      stranded: { bins: 1, reasons: ['factory_plan bin b: superseded'] },
    };
    expect(dispatchAfterLinePass(nothingCreated, oneFireable)).toBe(true);

    const noneStranded = { ...reading(), stranded: { bins: 0, reasons: [] } };
    expect(dispatchAfterLinePass(nothingCreated, noneStranded)).toBe(true);
    // A creation still always dispatches.
    expect(dispatchAfterLinePass([{ created: ['bin_1'] }], allStranded)).toBe(true);
  });

  it('is the decision the loop actually uses, through the dispatcher guard', () => {
    const source = readFileSync(new URL('../server/services/factory/remoteLoop.ts', import.meta.url), 'utf8');
    const loop = source.slice(source.indexOf('export function startFactoryRemoteLoop'));
    expect(loop).toContain('reading = pass.reading;');
    expect(loop).toContain('if (!dispatchAfterLinePass(reports, reading)) return;');
    expect(loop).toContain('await dispatchTickIfIdle({});');
    expect(loop).not.toContain('if (!reports.some((report) => report.created.length > 0)) return;');
  });
});
