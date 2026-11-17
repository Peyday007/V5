/**
 * The two event-loop stalls inside `cash:runMonetizationLedger` (production,
 * 56bc7f12, 2026-11-17: 2.0–2.8 s stalls about once a minute while the process
 * was SHEDDING, with a 12 840-possibility ledger).
 *
 * - `rankLedger` sorted with a comparator that recomputed every criterion on
 *   both sides of every comparison — allocating, parsing dates — inside one
 *   synchronous `sort`. It now reads each entry's criteria once. The order must
 *   be exactly the comparator's order, and the number of criterion readings is
 *   bounded by entries × criteria, which the old sort exceeded many times over.
 * - `recordMovements` wrote each moved position as an insert plus a read-back,
 *   thousands of sequential round trips a pass. It now writes them in chunks,
 *   and the rows written must be the same rows.
 * - The root cause of the once-a-minute stall itself: the stall profiler
 *   restarted V8's sampler every 60 s, and `Profiler.start` walks the heap
 *   synchronously. It now restarts only after a window that held a stall, or
 *   when its span reaches the maximum.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  noteStall,
  pressureStallMs,
  profileRotationDue,
  resetStallLog,
  resetStallProfilerState,
  stalledMsSince,
  rotateStallProfile,
  stallProfileReading,
  type ProfilerSession,
} from '../server/db/infra.ts';
import { createNode } from '../server/repos/industry.ts';
import { latestSnapshots, recordPath } from '../server/repos/monetization.ts';
import {
  CRITERIA,
  compareEntries,
  rankLedger,
  type RankableEntry,
} from '../server/services/cash/monetization/rank.ts';
import { recordMovements } from '../server/services/cash/monetization/movement.ts';
import { MONETIZATION_STATUSES } from '../server/domain/monetization.ts';
import type {
  MonetizationAttribute,
  MonetizationPathFact,
} from '../server/domain/types.ts';

/** A deterministic generator, so the fixture is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A ledger shaped like production's: most possibilities freshly enumerated
 * (unproven, few or no answers, created in batches that share an instant), a
 * minority with figures, choices and evidence.
 */
function productionShapedLedger(size: number): RankableEntry[] {
  const random = seeded(20261117);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const out: RankableEntry[] = [];
  for (let i = 0; i < size; i++) {
    const batch = Math.floor(i / 40);
    const createdAt = new Date(Date.UTC(2026, 9, 1) + batch * 60_000).toISOString();
    const path = { id: `mpx_${String(i).padStart(6, '0')}_${Math.floor(random() * 1e6)}`, createdAt } as RankableEntry['path'];
    const facts = new Map<MonetizationAttribute, MonetizationPathFact>();
    const fact = (attribute: MonetizationAttribute, extra: Partial<MonetizationPathFact>): void => {
      facts.set(attribute, {
        attribute,
        kind: random() < 0.4 ? 'EVIDENCE' : 'RECOMMENDATION',
        value: '',
        amountCents: null,
        days: null,
        ...extra,
      } as MonetizationPathFact);
    };
    if (random() < 0.25) {
      if (random() < 0.7) fact('expectedRevenue', { amountCents: Math.floor(random() * 20) * 50_000 });
      if (random() < 0.5) fact('directCosts', { amountCents: Math.floor(random() * 10) * 10_000 });
      if (random() < 0.5) fact('timeToCash', { days: Math.floor(random() * 6) * 15 });
      if (random() < 0.4) fact('requiredCapital', { amountCents: Math.floor(random() * 5) * 100_000 });
      if (random() < 0.5) fact('executionDifficulty', { value: pick(['LOW', 'MEDIUM', 'HIGH']) });
      if (random() < 0.5) fact('competition', { value: pick(['NONE_FOUND', 'FEW', 'MANY', 'SATURATED']) });
      if (random() < 0.4) fact('repeatability', { value: pick(['ONE_OFF', 'REPEATABLE', 'RECURRING']) });
      if (random() < 0.3) fact('scalability', { value: pick(['NONE', 'LINEAR', 'SUPERLINEAR']) });
    }
    const status = random() < 0.85 ? 'UNPROVEN' : pick(MONETIZATION_STATUSES);
    out.push({ path, status, facts } as RankableEntry);
  }
  // Production hands the ranking its paths in creation order, not shuffled.
  return out;
}

/** Count every criterion reading taken while `run` executes. */
function countingReadings<T>(run: () => T): { result: T; readings: number; ms: number } {
  let readings = 0;
  const originals = CRITERIA.map((criterion) => criterion.order);
  CRITERIA.forEach((criterion, at) => {
    (criterion as { order: (entry: RankableEntry) => number | null }).order = (entry) => {
      readings++;
      return originals[at]!(entry);
    };
  });
  try {
    const started = performance.now();
    const result = run();
    return { result, readings, ms: performance.now() - started };
  } finally {
    CRITERIA.forEach((criterion, at) => {
      (criterion as { order: (entry: RankableEntry) => number | null }).order = originals[at]!;
    });
  }
}

describe('rankLedger reads each criterion once per entry', () => {
  it('returns exactly the comparator order, within entries × criteria readings, at production size', () => {
    const size = 12_840;
    const ledger = productionShapedLedger(size);

    const before = countingReadings(() => [...ledger].sort(compareEntries));
    const after = countingReadings(() => rankLedger(ledger));

    expect(after.result.map((one) => one.path.id)).toEqual(before.result.map((one) => one.path.id));
    expect(after.result).toHaveLength(size);

    const bound = size * CRITERIA.length;
    expect(after.readings).toBeLessThanOrEqual(bound);
    // The comparator-driven sort this replaced read the criteria several times that.
    expect(before.readings).toBeGreaterThan(5 * bound);
    // eslint-disable-next-line no-console
    console.info(
      `rankLedger(${size}): comparator sort ${before.ms.toFixed(0)} ms / ${before.readings} readings; ` +
        `keyed sort ${after.ms.toFixed(0)} ms / ${after.readings} readings`,
    );
  });

  it('agrees with the comparator on ties, nulls and an empty ledger', () => {
    expect(rankLedger([])).toEqual([]);
    const small = productionShapedLedger(500);
    expect(rankLedger(small).map((one) => one.path.id)).toEqual(
      [...small].sort(compareEntries).map((one) => one.path.id),
    );
  });
});

describe('recordMovements writes its snapshots in chunks, and the same rows', () => {
  let projectId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('records every movement with one insert per chunk and no read-back', async () => {
    // One path per (subject, method), so 300 subjects of four methods each.
    const methods = ['DIRECT_SALE', 'PRODUCTIZED_SERVICE', 'CONSULTING', 'TRAINING'];
    const count = 1_200;
    let node = { id: '' };
    for (let i = 0; i < count; i++) {
      if (i % methods.length === 0) {
        node = (await createNode({ projectId, parentId: null, kind: 'SECTOR', name: `Stall test ${i}`, origin: 'SEED' })).node;
      }
      await recordPath({
        projectId,
        industryNodeId: node.id,
        method: methods[i % methods.length] as never,
        title: `Path ${i}`,
        origin: 'SEED',
      });
    }

    const db = getDb();
    const statements: string[] = [];
    const originalRun = db.run.bind(db);
    const originalAll = db.all.bind(db);
    const runSpy = vi.spyOn(db, 'run').mockImplementation(((sql: string, params?: unknown[]) => {
      statements.push(sql);
      return originalRun(sql, params as never);
    }) as never);
    const allSpy = vi.spyOn(db, 'all').mockImplementation(((sql: string, params?: unknown[]) => {
      statements.push(sql);
      return originalAll(sql, params as never);
    }) as never);

    let report;
    try {
      report = await recordMovements({ projectId, now: '2026-11-17T18:30:00.000Z' });
    } finally {
      runSpy.mockRestore();
      allSpy.mockRestore();
    }

    expect(report.evaluated).toBe(count);
    expect(report.movements).toHaveLength(count);
    const inserts = statements.filter((sql) => sql.includes('INSERT INTO monetization_rank_snapshots'));
    expect(inserts.length).toBeLessThanOrEqual(Math.ceil(count / 500));
    expect(statements.filter((sql) => sql.includes('FROM monetization_rank_snapshots WHERE id = ?'))).toHaveLength(0);

    // The rows are the movements, field for field.
    const latest = await latestSnapshots(projectId);
    expect(latest.size).toBe(count);
    for (const movement of report.movements) {
      const row = latest.get(movement.pathId)!;
      expect(row).toBeTruthy();
      expect(row.rank).toBe(movement.rank);
      expect(row.previousRank).toBe(movement.previousRank);
      expect(row.reason).toBe(movement.reason);
      expect(row.criterion).toBe(movement.criterion);
      expect(row.evaluatedAt).toBe('2026-11-17T18:30:00.000Z');
    }
    const ids = await db.all<{ id: string }>(
      'SELECT id FROM monetization_rank_snapshots WHERE project_id = ?',
      [projectId],
    );
    expect(new Set(ids.map((one) => one.id)).size).toBe(count);

    // And an unchanged ledger still records nothing.
    const again = await recordMovements({ projectId, now: '2026-11-17T18:40:00.000Z' });
    expect(again.movements).toHaveLength(0);
  });
});

/*
 * The stall the monitor itself caused. `Profiler.start` walks the whole heap
 * before it samples, synchronously; restarting it at every 60-second window
 * was a 2–3 s stall at :09 of every minute on production's 1.6 GB heap, and
 * the restart's own stall made the next window "hold a stall" and restart too.
 */
describe('the stall profiler restarts only when it has something to keep', () => {
  function fakeSession(): { session: ProfilerSession; stops: number; starts: number } {
    const counts = { stops: 0, starts: 0 };
    const session = {
      post(method: string, callback?: (err: Error | null, result?: { profile?: unknown }) => void) {
        if (method === 'Profiler.stop') {
          counts.stops++;
          callback?.(null, { profile: { nodes: [], samples: [], timeDeltas: [] } });
        } else counts.starts++;
      },
    } as ProfilerSession;
    return {
      session,
      get stops() { return counts.stops; },
      get starts() { return counts.starts; },
    };
  }

  it('keeps one profile running across quiet windows, bounded by its maximum span', () => {
    const t0 = Date.parse('2026-11-17T18:00:00.000Z');
    resetStallProfilerState(t0);
    const fake = fakeSession();
    // Twenty-nine quiet minutes: the old rotation restarted the profiler 29 times.
    for (let minute = 1; minute < 30; minute++) rotateStallProfile(fake.session, t0 + minute * 60_000);
    expect(fake.starts).toBe(0);
    expect(fake.stops).toBe(0);
    // The thirtieth closes it, so what V8 accumulates stays bounded.
    rotateStallProfile(fake.session, t0 + 30 * 60_000);
    expect(fake.stops).toBe(1);
    expect(fake.starts).toBe(1);
    resetStallProfilerState();
  });

  it('closes and keeps the window that held a stall', () => {
    const t0 = Date.parse('2026-11-17T18:00:00.000Z');
    resetStallProfilerState(t0, 2_500);
    const fake = fakeSession();
    // Within five minutes of the last start the stall is held, not restarted for.
    for (let minute = 1; minute < 5; minute++) rotateStallProfile(fake.session, t0 + minute * 60_000);
    expect(fake.stops).toBe(0);
    rotateStallProfile(fake.session, t0 + 5 * 60_000);
    expect(fake.stops).toBe(1);
    expect(fake.starts).toBe(1);
    expect(stallProfileReading()).toHaveLength(1);
    expect(stallProfileReading()[0]!.stallMs).toBe(2_500);
    // The next quiet window does not restart it again.
    rotateStallProfile(fake.session, Date.now() + 60_000);
    expect(fake.starts).toBe(1);
    resetStallProfilerState();
  });

  it('decides on the window stall and the span alone', () => {
    expect(profileRotationDue({ windowStallMs: 0, spanMs: 60_000 })).toBe(false);
    expect(profileRotationDue({ windowStallMs: 1_999, spanMs: 60_000 })).toBe(false);
    // A stall right after a restart waits out the minimum span (a restart is itself a stall).
    expect(profileRotationDue({ windowStallMs: 8_400, spanMs: 60_000 })).toBe(false);
    expect(profileRotationDue({ windowStallMs: 8_400, spanMs: 5 * 60_000 - 1 })).toBe(false);
    expect(profileRotationDue({ windowStallMs: 2_000, spanMs: 5 * 60_000 })).toBe(true);
    expect(profileRotationDue({ windowStallMs: 0, spanMs: 5 * 60_000 })).toBe(false);
    expect(profileRotationDue({ windowStallMs: 0, spanMs: 30 * 60_000 })).toBe(true);
  });
});

/*
 * 04b754ce, 2026-11-17: one real 8.4 s stall and the ~3.5 s profiler restart it
 * caused were both fed to the pressure gate — "stalled 12s of the last 120s",
 * SHEDDING. The restart is Brain's diagnostics, not load.
 */
describe('the pressure gate is fed the stall without the profiler restart', () => {
  it('subtracts the restart overlapping the probe', () => {
    expect(pressureStallMs(8_400, 0)).toBe(8_400);
    expect(pressureStallMs(9_000, 3_500)).toBe(5_500);
  });

  it('feeds nothing when the restart was the stall', () => {
    expect(pressureStallMs(3_600, 3_500)).toBe(0);
    expect(pressureStallMs(5_400, 3_500)).toBe(0);
    expect(pressureStallMs(1_999, 0)).toBe(0);
  });

  it('keeps the real stall below the SHEDDING reading', () => {
    resetStallLog();
    const now = Date.parse('2026-11-17T18:00:00.000Z');
    const real = pressureStallMs(8_400, 0);
    const restart = pressureStallMs(3_600, 3_500);
    if (real > 0) noteStall(real, now - 60_000);
    if (restart > 0) noteStall(restart, now);
    expect(stalledMsSince(now - 120_000)).toBe(8_400);
    resetStallLog();
  });
});
