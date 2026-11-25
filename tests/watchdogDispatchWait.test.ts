/**
 * The watchdog counts a bin as executable only when the dispatcher could fire
 * it now (rule 9, §98; ORIGINATED:IDLE_CAPACITY:engineering-watchdog).
 *
 * Production, 2026-11-24: "1 executable item(s), 14 eligible surface(s), 1
 * active against a target of 12: capacity is unexplainedly idle" in most
 * ten-minute windows, each answered by a dispatch pass that fired nothing. The
 * one bin's current intent was waiting out the dispatcher's own deferral —
 * an audit role no surface's next session could take, or a routing refusal
 * deferred past the fixed fifteen-minute unrouted window — and the watchdog
 * read neither. It now reads the same `next_attempt_at` `claimDispatchIntent`
 * reads, so the two cannot disagree.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ passes: 0 }));

// The recorded fleet: fourteen eligible surfaces against a target of twelve.
vi.mock('../server/services/fleet/capacity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/fleet/capacity.ts')>();
  return { ...actual, capacityReading: async () => ({ eligibleNow: 14, target: 12 }) };
});

vi.mock('../server/services/dispatch/loop.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/dispatch/loop.ts')>();
  return {
    ...actual,
    dispatchTick: async () => {
      state.passes += 1;
      return { fired: 0 };
    },
    dispatchTickIfIdle: async () => {
      state.passes += 1;
      return true;
    },
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  createBin,
  ensureDispatchIntent,
  getBin,
  listDispatchesForBin,
  markDispatchDeferred,
  recordBinEvent,
} from '../server/repos/bins.ts';
import { brainUtilization, idleCounts, watchIdle, watchUtilization } from '../server/services/engineering/watchdog.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  state.passes = 0;
});

function manifest(): BinManifest {
  return {
    objective: 'Return the sha-256 of one value carried in this manifest.',
    why: 'a bounded proof',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [{ key: 'echo', establishes: 'answered', input: 'nonce', transform: 'sha256', dependsOn: [] }],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['one unit result'],
    outputs: ['the sha-256'],
    authorizedActions: ['submit the unit result'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a verified result'],
  } as unknown as BinManifest;
}

/** A READY, work-ready bin with its intent at the current generation. */
async function readyBinWithIntent(): Promise<{ binId: string; intentId: string }> {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'the one executable item',
    objective: 'do the work',
    manifest: manifest(),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  await ensureDispatchIntent((await getBin(bin.id))!);
  const current = (await getBin(bin.id))!;
  const intent = (await listDispatchesForBin(bin.id)).find((d) => d.leaseGeneration === current.leaseGeneration)!;
  return { binId: bin.id, intentId: intent.id };
}

async function idleRecords(): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = 'IDLE_WITH_EXECUTABLE_WORK'",
  );
  return Number(row?.n ?? 0);
}

describe('a bin the dispatcher deferred is not idle capacity', () => {
  it('a deferral for an audit role no next session can take is a wait, not idle', async () => {
    const { intentId } = await readyBinWithIntent();
    await markDispatchDeferred(intentId, {
      refusal: 'NO_ELIGIBLE_AUDIT_SESSION',
      message: 'no surface’s next session would be independent',
      retryAfterMs: 40 * 60_000,
    });

    const reading = await watchIdle({});
    expect(reading.executableWork).toBe(0);
    expect(reading.dispatchWaits).toEqual({ NO_ELIGIBLE_AUDIT_SESSION: 1 });
    expect(reading.idle).toBe(false);
    expect(await idleRecords()).toBe(0);
    expect(state.passes).toBe(0);

    const routines = (await brainUtilization()).find((one) => one.pool === 'ROUTINES')!;
    expect(routines.idle).toBe(false);
    expect(routines.because).toContain('1 NO_ELIGIBLE_AUDIT_SESSION');
    expect(routines.because).not.toContain('unexplainedly idle');
  });

  it('a routing refusal deferred past the fifteen-minute unrouted window still waits', async () => {
    const { binId, intentId } = await readyBinWithIntent();
    await markDispatchDeferred(intentId, {
      refusal: 'PROJECT_NOT_IN_SCOPE',
      message: 'no surface serves this project',
      retryAfterMs: 60 * 60_000,
    });
    // The refusal itself was recorded twenty minutes ago: outside the unrouted window.
    await recordBinEvent({ eventType: 'DISPATCH_UNROUTED', binId, projectId, outcome: 'PROJECT_NOT_IN_SCOPE', reason: 'test' });
    await getDb().run("UPDATE bin_events SET at = ? WHERE bin_id = ? AND event_type = 'DISPATCH_UNROUTED'", [
      new Date(Date.now() - 20 * 60_000).toISOString(),
      binId,
    ]);

    const result = await watchUtilization({});
    expect(result.pools.find((one) => one.pool === 'ROUTINES')?.idle).toBe(false);
    expect(result.recorded).not.toContain('ROUTINES');
    expect(state.passes).toBe(0);
  });
});

describe('work the dispatcher could fire now is still idle capacity (positive control)', () => {
  it('a due intent reads as executable, is recorded and gets the dispatch pass', async () => {
    const { intentId } = await readyBinWithIntent();
    await markDispatchDeferred(intentId, { refusal: 'NO_ELIGIBLE_AUDIT_SESSION', message: 'cleared', retryAfterMs: 0 });
    await getDb().run('UPDATE bin_dispatch SET next_attempt_at = ? WHERE id = ?', [
      new Date(Date.now() - 1_000).toISOString(),
      intentId,
    ]);

    const reading = await watchIdle({});
    expect(reading.executableWork).toBe(1);
    expect(reading.idle).toBe(true);
    expect(await idleRecords()).toBe(1);
    expect(state.passes).toBe(1);
  });

  it('a bin with a fresh intent reads as executable', async () => {
    await readyBinWithIntent();
    const counts = await idleCounts();
    expect(counts.executableWork).toBe(1);
    expect(counts.dispatchWaits).toEqual({});
  });
});
