/**
 * CAP-16-3 repair (episode 2), unit controller-provider-share.
 *
 * S-0171: "Scale ... model instances only after measurements identify the
 * constrained stage" and "Do not enlarge ... merely because a research queue is
 * long." Production 2026-11-15 20:03–21:51Z read 2 accepted of 145–187 lane
 * outcomes with 97–98% provider failures: the controller halved on transient
 * failures, but an ADD_CAPACITY grant and the idle-slot room could still raise
 * a model whose calls were mostly failing on the provider.
 *
 * Now: at half or more of a model's window failing on the provider, its target
 * drops to MIN_TARGET with a reason naming the share; no grant and no idle room
 * raises it until a window below half is measured; Brain's own database, lag
 * and CPU guards still come first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { setBrainOnlyMode } from '../server/services/bins/brainOnly.ts';
import {
  MIN_TARGET,
  PROVIDER_HOLD_PREFIX,
  applyGrant,
  controlStep,
  decideTarget,
  freeLaneSpareSurfaces,
  isProviderHoldReason,
  providerFailureShare,
  readCapacity,
  startAdaptivePool,
  stopAdaptivePool,
  type CapacityGrant,
} from '../server/services/freeLane/capacity.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';
import type { SourceFetch } from '../server/services/sources/fetchForWorker.ts';

const calm = { db: false, lagMs: 5, cpu: 0.1 };
const grant: CapacityGrant = { model: 'brain-a', units: 6, fingerprint: 'fp-provider', reason: 'queued qualified research', decidedAt: '' };

describe('the decision names the provider-failure share and drops to the minimum', () => {
  it('drops to MIN_TARGET at half or more of the window failing on the provider', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 200, window: { ok: 1, content: 1, transient: 48 }, pressure: calm });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.providerHold).toBe(true);
    expect(d.reason.startsWith(PROVIDER_HOLD_PREFIX)).toBe(true);
    expect(d.reason).toContain('96% of 50 calls failed on the provider');
    // Exactly half is the boundary and is held.
    expect(decideTarget({ target: 8, active: 8, waiting: 9, window: { ok: 2, content: 0, transient: 2 }, pressure: calm }).target).toBe(MIN_TARGET);
  });

  it('below half keeps the existing halve-on-overload rule', () => {
    const d = decideTarget({ target: 16, active: 16, waiting: 200, window: { ok: 6, content: 0, transient: 4 }, pressure: calm });
    expect(d.target).toBe(8);
    expect(d.providerHold).toBeUndefined();
  });

  it('a window too small to measure neither starts nor releases a hold', () => {
    expect(providerFailureShare({ ok: 0, content: 0, transient: 3 })).toBeNull();
    expect(decideTarget({ target: 4, active: 4, waiting: 9, window: { ok: 0, content: 0, transient: 3 }, pressure: calm }).providerHold).toBeUndefined();
    // Held and nothing measured since: still held, even with nothing waiting (the decay would raise it to 2).
    for (const waiting of [0, 50]) {
      const held = decideTarget({ target: 1, active: 0, waiting, window: { ok: 1, content: 0, transient: 0 }, pressure: calm, providerHold: true });
      expect(held.target).toBe(MIN_TARGET);
      expect(held.providerHold).toBe(true);
    }
  });

  it('growth resumes once a window below half with waiting work is measured', () => {
    const d = decideTarget({ target: 1, active: 1, waiting: 40, window: { ok: 7, content: 1, transient: 0 }, pressure: calm, providerHold: true });
    expect(d.providerHold).toBeUndefined();
    expect(d.target).toBeGreaterThan(MIN_TARGET);
    expect(d.reason).toMatch(/useful research waiting/);
  });

  it('database, lag and CPU shrink rules still take precedence', () => {
    const failing = { ok: 0, content: 0, transient: 20 };
    expect(decideTarget({ target: 16, active: 16, waiting: 9, window: failing, pressure: { ...calm, db: true } }).reason).toBe('Brain database saturated');
    expect(decideTarget({ target: 16, active: 16, waiting: 9, window: failing, pressure: { ...calm, lagMs: 2_000 } }).reason).toMatch(/event loop lagging/);
    expect(decideTarget({ target: 16, active: 16, waiting: 9, window: failing, pressure: { ...calm, cpu: 0.95 } }).reason).toMatch(/CPU/);
  });
});

describe('an ADD_CAPACITY grant does not raise a model held on its provider', () => {
  it('refuses the grant and keeps MIN_TARGET with the provider reason', () => {
    const held = decideTarget({ target: 1, active: 1, waiting: 99, window: { ok: 0, content: 1, transient: 9 }, pressure: calm });
    const r = applyGrant({ target: 1, stableHigh: 20, decision: held, grant });
    expect(r.applied).toBe(false);
    expect(r.decision.target).toBe(MIN_TARGET);
    expect(r.decision.reason).toContain('90% of 10 calls failed on the provider');
  });

  it('applies the grant again once the provider is measured below half', () => {
    const restored = decideTarget({ target: 4, active: 1, waiting: 99, window: { ok: 8, content: 0, transient: 1 }, pressure: calm, providerHold: true });
    const r = applyGrant({ target: 4, stableHigh: 20, decision: restored, grant });
    expect(r.applied).toBe(true);
    expect(r.decision.target).toBe(10);
  });
});

const CONFIG: LaneConfig = { url: 'http://lane.test/v1', key: null, models: ['brain-a', 'brain-b'], dailyBudget: 100, timeoutMs: 1000 };
const completer: Completer = async () => JSON.stringify({ claims: [] });
const fetchSource = async (url: string): Promise<SourceFetch> => ({
  readable: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
  retrievedAt: new Date().toISOString(), sha256: 'x', text: 'x', truncated: false, totalChars: 1,
});
const items = async (model: string, outcome: string, n: number): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome, reason: `model ${model}: test` });
  }
};
const capacity = async () => new Map((await readCapacity()).map((r) => [r.model, r]));

beforeEach(async () => {
  await freshProject();
  await setBrainOnlyMode(true, 'test', 'provider-share suite');
  await getDb().run('DELETE FROM free_lane_capacity', []);
  await getDb().run('DELETE FROM bin_events', []);
});
afterEach(() => {
  stopAdaptivePool();
  delete process.env['BRAIN_CHEAP_LLM_URL'];
  delete process.env['BRAIN_CHEAP_LLM_MODELS'];
});

describe('the running controller holds a failing provider until it is measured answering', () => {
  it('drops, refuses the grant, survives a restart, and releases only on a measured window below half', async () => {
    await getDb().run(
      "INSERT INTO free_lane_capacity (model, target, stable_high, updated_at, reason) VALUES ('brain-a', 8, 20, '2026-11-15T20:00:00Z', 't'), ('brain-b', 8, 20, '2026-11-15T20:00:00Z', 't')",
      [],
    );
    await items('brain-a', 'RELEASED_TRANSIENT', 19);
    await items('brain-a', 'SUBMITTED', 1);
    const grants = async () => [grant];
    const start = () => startAdaptivePool({ config: CONFIG, completer, fetchSource, search: async () => [], pressure: () => calm, grants, stageReading: async () => null }, 60_000);
    start();
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    let a = (await capacity()).get('brain-a')!;
    expect(a.target).toBe(MIN_TARGET);
    expect(isProviderHoldReason(a.reason)).toBe(true);
    expect(a.reason).toContain('95% of 20 calls failed on the provider');
    const applied = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM bin_events WHERE event_type = 'FREE_LANE_CAPACITY' AND workload_class = 'brain-a' AND reason LIKE '%(allocation fp-provider)%' AND outcome = 'GROW'", []);
    expect(Number(applied?.n)).toBe(0);

    // The failures age out of the window, nothing new is measured: still held, across a restart too.
    await getDb().run("DELETE FROM bin_events WHERE event_type = 'FREE_LANE_ITEM'", []);
    await controlStep();
    expect((await capacity()).get('brain-a')!.target).toBe(MIN_TARGET);
    stopAdaptivePool();
    start();
    await new Promise((r) => setTimeout(r, 50));
    await controlStep();
    a = (await capacity()).get('brain-a')!;
    expect(a.target).toBe(MIN_TARGET);
    expect(isProviderHoldReason(a.reason)).toBe(true);

    // The idle room counts only the one slot a held model has, not its proven 20.
    process.env['BRAIN_CHEAP_LLM_URL'] = 'http://lane.test/v1';
    process.env['BRAIN_CHEAP_LLM_MODELS'] = 'brain-a,brain-b';
    const rows = await capacity();
    const roomHeld = await freeLaneSpareSurfaces();
    expect(roomHeld).toBeLessThanOrEqual(Math.floor((MIN_TARGET + Math.max(rows.get('brain-b')!.target, rows.get('brain-b')!.stableHigh)) / 4));

    // A measured window below half releases the hold.
    await items('brain-a', 'SUBMITTED', 8);
    await controlStep();
    a = (await capacity()).get('brain-a')!;
    expect(isProviderHoldReason(a.reason)).toBe(false);
  }, 60_000);
});
