import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LineReading } from '../server/services/factory/line.ts';

/*
 * The loop itself is driven below, so the three seams it crosses are stubbed:
 * the line pass (which reading the tick sees), the program step (nothing to do)
 * and the dispatcher's guarded pass (what the tick asked for). Everything else —
 * the campaign tick over a real, empty database, the decision, the control flow
 * between them — is the code production runs.
 */
const seams = vi.hoisted(() => ({
  reading: null as unknown,
  lineThrows: false,
  linePasses: 0,
  dispatches: [] as unknown[],
}));

vi.mock('../server/services/factory/line.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/line.ts')>();
  return {
    ...actual,
    runLinePass: async () => {
      seams.linePasses += 1;
      if (seams.lineThrows) throw new Error('the line could not be read');
      return { admission: { admitted: [] }, reading: seams.reading };
    },
  };
});

vi.mock('../server/services/factory/program/loop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/program/loop.ts')>();
  return { ...actual, tickAllProgramsIfDue: async () => [] };
});

vi.mock('../server/services/dispatch/loop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/loop.ts')>();
  return {
    ...actual,
    dispatchTickIfIdle: async (options: unknown) => {
      seams.dispatches.push(options);
      return true;
    },
  };
});

import { freshProject, teardown } from './helpers.ts';
import {
  dispatchAfterLinePass,
  startFactoryRemoteLoop,
  stopFactoryRemoteLoop,
} from '../server/services/factory/remoteLoop.ts';

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
});

/**
 * Run the real loop until two line passes have begun. The loop never overlaps
 * its own passes, so the second one starting proves the first ran to its end —
 * including whatever it decided about the dispatcher.
 */
async function runOneFullPass(): Promise<void> {
  startFactoryRemoteLoop(5);
  try {
    await vi.waitFor(() => expect(seams.linePasses).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 5 });
  } finally {
    stopFactoryRemoteLoop();
  }
}

describe('startFactoryRemoteLoop acts on the line reading it was handed', () => {
  beforeEach(async () => {
    await freshProject();
    seams.reading = null;
    seams.lineThrows = false;
    seams.linePasses = 0;
    seams.dispatches = [];
  });

  afterEach(async () => {
    stopFactoryRemoteLoop();
    await teardown();
  });

  it('asks the dispatcher, through its guard, on a pass that created nothing but read unexplained idle', async () => {
    // The recorded failure: waiting=1, running=0, capacity=1, and no campaign
    // tick created a bin (the database holds no campaign at all).
    seams.reading = reading();
    await runOneFullPass();
    expect(seams.dispatches.length).toBeGreaterThanOrEqual(1);
    expect(seams.dispatches[0]).toEqual({});
  });

  it('does not ask the dispatcher on a quiet, a running or an arriving line', async () => {
    for (const quiet of [
      reading({ executable: { queued: 0, readyBins: 0, total: 0 } }),
      reading({ active: { leasedBins: 1, arriving: 0, workingCampaigns: 1 } }),
      reading({ active: { leasedBins: 0, arriving: 1, workingCampaigns: 1 } }),
      reading({ capacity: { freeSurfaces: 0, surfaces: [] } }),
    ]) {
      seams.reading = quiet;
      seams.linePasses = 0;
      seams.dispatches = [];
      await runOneFullPass();
      expect(seams.dispatches).toEqual([]);
    }
  });

  it('keeps the creation-only rule when the line pass threw', async () => {
    seams.lineThrows = true;
    await runOneFullPass();
    expect(seams.dispatches).toEqual([]);
  });

  it('does not ask the dispatcher when every idle bin is stranded', async () => {
    seams.reading = { ...reading(), stranded: { bins: 1, reasons: ['factory_plan bin b: superseded'] } };
    await runOneFullPass();
    expect(seams.dispatches).toEqual([]);
  });
});
