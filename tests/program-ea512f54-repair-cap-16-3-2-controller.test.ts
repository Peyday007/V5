/**
 * CAP-16-3 repair, episode 2 — the capacity controller does not add slots to a
 * model whose calls mostly fail on the provider (S-0171: "Scale ... model
 * instances only after measurements identify the constrained stage"; "Do not
 * enlarge ... merely because a research queue is long").
 *
 * Production, 2026-11-15 20:03–23:03Z (probe r01.cap-16-3): 64–98% of six
 * hours' lane outcomes were provider failures. `decideTarget` halved on
 * transient failures, but an ADD_CAPACITY grant, the no-work decay and a
 * restart could still raise a model's target while most of its calls failed,
 * and an item whose call failed a third time was recorded FAILED_RETRYABLE and
 * so never counted as a provider failure in the controller's window at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  applyGrant,
  controlStep,
  decideTarget,
  MIN_TARGET,
  PROVIDER_HOLD_REASON,
  providerFailureShare,
  providerHeld,
  readCapacity,
  startAdaptivePool,
  stopAdaptivePool,
  windowFromRows,
  type CapacityGrant,
} from '../server/services/freeLane/capacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

const calm = { db: false, lagMs: 5, cpu: 0.1 };
const failing = { ok: 1, content: 0, transient: 9 };
const healthy = { ok: 9, content: 1, transient: 0 };
const grant: CapacityGrant = { model: 'brain-a', units: 8, fingerprint: 'fp-cap-16-3', reason: 'queued qualified research held', decidedAt: new Date().toISOString() };

describe('a model failing on its provider drops to the minimum', () => {
  it('returns MIN_TARGET with a reason naming the provider-failure share at half or more', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 200, window: { ok: 2, content: 0, transient: 2 }, pressure: calm });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.reason).toMatch(/50% of 4 calls failed on the provider/);
    expect(d.reason.startsWith(PROVIDER_HOLD_REASON)).toBe(true);
    const worse = decideTarget({ target: 6, active: 6, waiting: 200, window: failing, pressure: calm });
    expect(worse.target).toBe(MIN_TARGET);
    expect(worse.reason).toMatch(/90% of 10 calls/);
  });

  it('counts a third-strike FAILED_RETRYABLE whose model call failed as a provider failure', () => {
    const w = windowFromRows([
      { outcome: 'SUBMITTED', failed: 0, n: 2 },
      { outcome: 'FAILED_RETRYABLE', failed: 1, n: 6 },
      { outcome: 'FAILED_RETRYABLE', failed: 0, n: 1 },
      { outcome: 'RELEASED_TRANSIENT', failed: 1, n: 3 },
    ]);
    expect(w).toEqual({ ok: 2, content: 7, transient: 3, provider: 9 });
    expect(providerFailureShare(w)).toBeCloseTo(9 / 12);
    // Before the repair the window read 3 of 12 transient (25%): no shrink at all.
    expect(decideTarget({ target: 12, active: 12, waiting: 50, window: w, pressure: calm }).target).toBe(MIN_TARGET);
  });

  it('a single failed call does not collapse a model', () => {
    expect(providerHeld(false, { ok: 0, content: 0, transient: 1 })).toBe(false);
  });
});

describe('neither a grant nor the decay raises a held model', () => {
  it('an ADD_CAPACITY grant is not applied while the provider-failure hold stands', () => {
    const d = decideTarget({ target: 1, active: 1, waiting: 200, window: failing, pressure: calm });
    const r = applyGrant({ target: 1, stableHigh: 20, decision: d, grant, providerHeld: true });
    expect(r.applied).toBe(false);
    expect(r.decision.target).toBe(MIN_TARGET);
    // Unheld, the same grant would have raised it: the hold is what refuses it.
    expect(applyGrant({ target: 1, stableHigh: 20, decision: { target: 1, reason: 'hold', stable: true }, grant }).applied).toBe(true);
  });

  it('nothing waiting does not decay a held model back up to the starting size', () => {
    const d = decideTarget({ target: 1, active: 0, waiting: 0, window: { ok: 0, content: 0, transient: 0 }, pressure: calm, providerHeld: true });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.reason).toMatch(/no window below 50% provider failures measured/);
  });

  it('an empty window keeps the hold; only a measured window below half clears it', () => {
    expect(providerHeld(true, { ok: 0, content: 0, transient: 0 })).toBe(true);
    expect(providerHeld(true, failing)).toBe(true);
    expect(providerHeld(true, healthy)).toBe(false);
  });
});

describe('growth resumes once a window below half is measured with work waiting', () => {
  it('grows again from the minimum', () => {
    const d = decideTarget({ target: 1, active: 1, waiting: 40, window: healthy, pressure: calm, providerHeld: true });
    expect(d.target).toBeGreaterThan(MIN_TARGET);
    expect(d.reason).toMatch(/useful research waiting/);
    const r = applyGrant({ target: 1, stableHigh: 20, decision: d, grant, providerHeld: providerHeld(true, healthy) });
    expect(r.applied).toBe(true);
  });
});

describe("Brain's own pressure still comes first", () => {
  it('database, lag and CPU shrink rules name their own reason over the provider share', () => {
    expect(decideTarget({ target: 8, active: 8, waiting: 9, window: failing, pressure: { ...calm, db: true } }).reason).toMatch(/database saturated/);
    expect(decideTarget({ target: 8, active: 8, waiting: 9, window: failing, pressure: { ...calm, lagMs: 1_500 } }).reason).toMatch(/event loop lagging/);
    expect(decideTarget({ target: 8, active: 8, waiting: 9, window: failing, pressure: { ...calm, cpu: 0.95 } }).reason).toMatch(/CPU at 95%/);
  });
});

/* -------------------------------------------------------------------------- */
/* The controller on real rows                                                 */
/* -------------------------------------------------------------------------- */

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const completer: Completer = async () => {
  throw new Error('model call failed: 503');
};
let play: TestProject;

beforeEach(async () => {
  play = await freshProject();
  expect(play.project.id).toBeTruthy();
  await setBrainOnlyMode(true, 'test', 'cap-16-3 controller suite');
});
afterEach(() => stopAdaptivePool());

async function lane(model: string, outcome: string, why: string | null, n: number): Promise<void> {
  const reason = why ? `model ${model}: ${why}` : `model ${model}`;
  for (let i = 0; i < n; i += 1) await recordBinEvent({ eventType: 'FREE_LANE_ITEM', outcome, reason, evidenceClass: 'MEASURED' });
}

describe('controlStep', () => {
  it('holds a provider-failing model at the minimum across a grant and a restart, and the step is recorded with the share', async () => {
    await getDb().run('DELETE FROM free_lane_capacity', []);
    await getDb().run(
      "INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 12, 20, ?, 'useful research waiting (40), errors acceptable')",
      [new Date().toISOString()],
    );
    await lane('brain-a', 'SUBMITTED', null, 1);
    await lane('brain-a', 'FAILED_RETRYABLE', 'model call failed: 503 Service Unavailable', 7);
    startAdaptivePool({ config: CONFIG, completer, fetchSource: async () => { throw new Error('unused'); }, search: async () => [], pressure: () => calm, stageReading: async () => null, grants: async () => [grant] }, 600_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    const a = (await readCapacity()).find((r) => r.model === 'brain-a')!;
    expect(a.target).toBe(MIN_TARGET);
    expect(a.reason).toMatch(/^provider failing: 88% of 8 calls failed on the provider/);
    const shrink = await getDb().get<{ reason: string }>(
      "SELECT reason FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class = 'brain-a' AND outcome = 'SHRINK' ORDER BY at DESC LIMIT 1",
      [],
    );
    expect(shrink?.reason).toMatch(/-> 1: provider failing/);
    // The grant was never applied to the failing model.
    const granted = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class = 'brain-a' AND reason LIKE '%allocation fp-cap-16-3%'",
      [],
    );
    expect(Number(granted?.n)).toBe(0);

    // A restart is not a measured recovery: the persisted hold resumes at the minimum.
    stopAdaptivePool();
    await getDb().run("DELETE FROM bin_events WHERE event_type = 'FREE_LANE_ITEM'", []);
    startAdaptivePool({ config: CONFIG, completer, fetchSource: async () => { throw new Error('unused'); }, search: async () => [], pressure: () => calm, stageReading: async () => null, grants: async () => [grant] }, 600_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    const after = (await readCapacity()).find((r) => r.model === 'brain-a')!;
    expect(after.target).toBe(MIN_TARGET);
    expect(after.reason).toMatch(/^provider failing: no window below 50%/);
  });
});
