/**
 * CAP-16-3 repair, episode 2 (S-0171): restore a failing model route before
 * scaling it. Production 2026-11-15: 97–98% of 145–187 lane outcomes over six
 * hours were provider failures while the grant and the grow branch could still
 * raise the failing model's target. At half or more provider failures a model
 * drops to MIN_TARGET, and nothing raises it until a window below half is
 * measured; Brain's own pressure rules still come first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  MIN_TARGET,
  PROVIDER_HOLD_MARK,
  applyGrant,
  controlStep,
  decideTarget,
  providerFailing,
  providerRecovered,
  readCapacity,
  startAdaptivePool,
  stopAdaptivePool,
  type CapacityGrant,
} from '../server/services/freeLane/capacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const calm = { db: false, lagMs: 5, cpu: 0.1 };
const failing = { ok: 1, content: 1, transient: 8 };
const grant: CapacityGrant = { model: 'brain-a', units: 6, fingerprint: 'fp-cap163', reason: 'queued qualified research', decidedAt: '' };

describe('the decision at half or more provider failures', () => {
  it('drops to MIN_TARGET with a reason naming the provider-failure share', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 40, window: failing, pressure: calm });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.providerHeld).toBe(true);
    expect(d.reason).toContain(PROVIDER_HOLD_MARK);
    expect(d.reason).toContain('80% of 10 outcomes failed on the provider');
    // Exactly half is "at or above half".
    expect(decideTarget({ target: 8, active: 8, waiting: 11, window: { ok: 5, content: 0, transient: 5 }, pressure: calm }).target).toBe(MIN_TARGET);
    // Below half keeps the ordinary overload rule: halve at 30%.
    const overloaded = decideTarget({ target: 8, active: 8, waiting: 11, window: { ok: 6, content: 0, transient: 4 }, pressure: calm });
    expect(overloaded.target).toBe(4);
    expect(overloaded.providerHeld).toBeUndefined();
  });

  it('does not enter the hold on fewer than four outcomes', () => {
    expect(providerFailing({ ok: 0, content: 0, transient: 3 })).toBe(false);
    expect(providerFailing({ ok: 2, content: 0, transient: 2 })).toBe(true);
    expect(providerRecovered({ ok: 0, content: 0, transient: 0 })).toBe(false);
    expect(providerRecovered({ ok: 2, content: 0, transient: 1 })).toBe(true);
  });

  it('applyGrant does not raise a provider-held target', () => {
    const d = decideTarget({ target: 4, active: 4, waiting: 40, window: failing, pressure: calm });
    const r = applyGrant({ target: MIN_TARGET, stableHigh: 26, decision: d, grant });
    expect(r.applied).toBe(false);
    expect(r.decision.target).toBe(MIN_TARGET);
    expect(r.decision.reason).toContain('failed on the provider');
  });

  it('keeps the hold through an empty or still-failing window, even with a backlog that would fill idle slots', () => {
    const empty = decideTarget({ target: MIN_TARGET, active: 0, waiting: 200, window: { ok: 0, content: 0, transient: 0 }, pressure: calm, providerHeld: true });
    expect(empty.target).toBe(MIN_TARGET);
    expect(empty.providerHeld).toBe(true);
    expect(empty.reason).toContain('no outcome measured');
    const still = decideTarget({ target: MIN_TARGET, active: 1, waiting: 200, window: { ok: 1, content: 0, transient: 1 }, pressure: calm, providerHeld: true });
    expect(still.target).toBe(MIN_TARGET);
    expect(still.providerHeld).toBe(true);
    expect(applyGrant({ target: MIN_TARGET, stableHigh: 26, decision: still, grant }).applied).toBe(false);
  });

  it('resumes growth once a window below half provider failures with waiting work is measured', () => {
    const d = decideTarget({ target: MIN_TARGET, active: 1, waiting: 20, window: { ok: 4, content: 0, transient: 0 }, pressure: calm, providerHeld: true });
    expect(d.providerHeld).toBeUndefined();
    expect(d.target).toBeGreaterThan(MIN_TARGET);
    // And a grant may raise it again.
    const hold = { target: MIN_TARGET, reason: 'database connections contended', stable: true };
    expect(applyGrant({ target: MIN_TARGET, stableHigh: 26, decision: hold, grant }).applied).toBe(true);
  });

  it('lets database, lag and CPU rules take precedence, without dropping the hold', () => {
    for (const pressure of [{ ...calm, db: true }, { ...calm, lagMs: 1_500 }, { ...calm, cpu: 0.95 }]) {
      const d = decideTarget({ target: 16, active: 16, waiting: 40, window: failing, pressure });
      expect(d.reason).toMatch(/^Brain (database saturated|event loop lagging|CPU at)/);
      expect(d.target).toBe(MIN_TARGET);
      expect(d.providerHeld).toBe(true);
      // A healthy route under the same pressure still just halves.
      expect(decideTarget({ target: 16, active: 16, waiting: 40, window: { ok: 9, content: 0, transient: 0 }, pressure }).target).toBe(8);
    }
  });
});

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const completer: Completer = async () => JSON.stringify({ claims: [] });
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
  retrievedAt: new Date().toISOString(), sha256: 'x', text: 'x', truncated: false, totalChars: 1,
});

async function items(model: string, outcome: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason: `model ${model}: t` });
  }
}

beforeEach(async () => {
  await freshProject();
  await setBrainOnlyMode(true, 'test', 'cap-16-3 repair suite');
});
afterEach(() => stopAdaptivePool());

describe('the running controller', () => {
  it('holds a provider-failing model at its minimum against a grant, across a restart, until it answers', async () => {
    await getDb().run('DELETE FROM free_lane_capacity', []);
    await getDb().run("INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 8, 26, '2026-11-15T00:00:00Z', 't'), ('brain-b', 8, 26, '2026-11-15T00:00:00Z', 't')", []);
    await items('brain-a', 'RELEASED_TRANSIENT', 9);
    await items('brain-a', 'SUBMITTED', 1);
    const options = { config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, stageReading: async () => null, grants: async () => [grant] };
    startAdaptivePool(options, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    const rows = async () => new Map((await readCapacity()).map((r) => [r.model, r]));
    expect((await rows()).get('brain-a')!.target).toBe(MIN_TARGET);
    expect((await rows()).get('brain-a')!.reason).toContain(PROVIDER_HOLD_MARK);
    expect((await rows()).get('brain-b')!.target).toBeGreaterThan(MIN_TARGET);

    // A restart resumes the hold from the persisted row rather than at half of the old target.
    stopAdaptivePool();
    await getDb().run("DELETE FROM bin_events WHERE event_type = 'FREE_LANE_ITEM'", []);
    startAdaptivePool(options, 60_000);
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    expect((await rows()).get('brain-a')!.target).toBe(MIN_TARGET);
    expect((await rows()).get('brain-a')!.reason).toContain('no outcome measured');

    // A window below half provider failures ends the hold.
    await items('brain-a', 'SUBMITTED', 5);
    await controlStep();
    expect((await rows()).get('brain-a')!.reason).not.toContain(PROVIDER_HOLD_MARK);
  }, 60_000);
});
