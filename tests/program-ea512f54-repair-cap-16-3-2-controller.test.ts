/**
 * CAP-16-3 repair, episode 2: restore model throughput before scaling it (S-0171).
 *
 * Production, 2026-11-15 20:03–23:03Z, probe r01.cap-16-3: 2 accepted of 145–187
 * lane outcomes in six hours, with 97–98% of them provider failures. The
 * controller halved a model on overload, then growth, an ADD_CAPACITY grant or
 * an idle-slot fill raised it again on the next step, so most of the calls kept
 * failing on the provider. Now a model whose window shows provider failures at or
 * above half drops to MIN_TARGET, and nothing raises it until a window below half
 * is measured.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_TARGET,
  PROVIDER_FAILURE_HOLD_SHARE,
  applyGrant,
  decideTarget,
  providerFailureShare,
  type CapacityGrant,
  type Pressure,
  type Window,
} from '../server/services/freeLane/capacity.ts';

const calm: Pressure = { db: false, lagMs: 5, cpu: 0.1 };
const failingWindow: Window = { ok: 2, content: 0, transient: 98 }; // the recorded 98%
const grant: CapacityGrant = { model: 'brain-a', units: 16, fingerprint: 'alloc-1', reason: 'queued qualified research', decidedAt: '2026-11-15T20:00:00.000Z' };

describe('a model failing on the provider is restored before it is scaled', () => {
  it('drops to MIN_TARGET with a reason naming the provider-failure share (the recorded failure class)', () => {
    const d = decideTarget({ target: 24, active: 24, waiting: 187, window: failingWindow, pressure: calm });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.providerHeld).toBe(true);
    expect(d.stable).toBe(false);
    expect(d.reason).toMatch(/provider failing: 98% of 100 calls failed on the provider/);
  });

  it('holds at exactly half, the threshold', () => {
    expect(PROVIDER_FAILURE_HOLD_SHARE).toBe(0.5);
    const d = decideTarget({ target: 8, active: 8, waiting: 20, window: { ok: 2, content: 0, transient: 2 }, pressure: calm });
    expect(d.target).toBe(MIN_TARGET);
    expect(d.providerHeld).toBe(true);
    expect(d.reason).toContain('50%');
  });

  it('an ADD_CAPACITY grant does not raise a held model, and applyGrant still answers MIN_TARGET with the share', () => {
    const decision = decideTarget({ target: MIN_TARGET, active: 1, waiting: 187, window: failingWindow, pressure: calm });
    const out = applyGrant({ target: MIN_TARGET, stableHigh: 26, decision, grant });
    expect(out.applied).toBe(false);
    expect(out.decision.target).toBe(MIN_TARGET);
    expect(out.decision.reason).toMatch(/98% of 100 calls failed on the provider/);
  });

  it('stays held through a window with no calls or too few to judge, so an idle-slot fill cannot raise it', () => {
    const empty = decideTarget({ target: MIN_TARGET, active: 0, waiting: 50, window: { ok: 0, content: 0, transient: 0 }, pressure: calm, providerHeld: true });
    expect(empty.target).toBe(MIN_TARGET);
    expect(empty.providerHeld).toBe(true);
    const oneFailure = decideTarget({ target: MIN_TARGET, active: 1, waiting: 50, window: { ok: 0, content: 0, transient: 1 }, pressure: calm, providerHeld: true });
    expect(oneFailure.target).toBe(MIN_TARGET);
    expect(oneFailure.providerHeld).toBe(true);
    expect(applyGrant({ target: MIN_TARGET, stableHigh: 26, decision: oneFailure, grant }).applied).toBe(false);
  });

  it('growth resumes once a window below half provider failures is measured with work waiting', () => {
    const recovered: Window = { ok: 6, content: 1, transient: 1 };
    expect(providerFailureShare(recovered)).toBeLessThan(0.5);
    const d = decideTarget({ target: MIN_TARGET, active: 1, waiting: 50, window: recovered, pressure: calm, providerHeld: true });
    expect(d.providerHeld).toBeFalsy();
    expect(d.target).toBeGreaterThan(MIN_TARGET);
    const out = applyGrant({ target: MIN_TARGET, stableHigh: 26, decision: d, grant });
    expect(out.applied).toBe(true);
    expect(out.decision.target).toBeGreaterThan(d.target - 1);
  });

  it('database, lag and CPU shrink rules still take precedence, and the hold survives them', () => {
    const db = decideTarget({ target: 8, active: 8, waiting: 20, window: failingWindow, pressure: { ...calm, db: true } });
    expect(db.reason).toBe('Brain database saturated');
    expect(db.target).toBe(MIN_TARGET);
    expect(db.providerHeld).toBe(true);
    const lag = decideTarget({ target: 8, active: 8, waiting: 20, window: failingWindow, pressure: { ...calm, lagMs: 5_000 } });
    expect(lag.reason).toMatch(/event loop lagging/);
    expect(lag.providerHeld).toBe(true);
    const cpu = decideTarget({ target: 8, active: 8, waiting: 20, window: failingWindow, pressure: { ...calm, cpu: 0.95 } });
    expect(cpu.reason).toMatch(/CPU at 95%/);
    expect(cpu.providerHeld).toBe(true);
    // A healthy model under pressure still halves, as before.
    const healthy = decideTarget({ target: 8, active: 8, waiting: 20, window: { ok: 10, content: 0, transient: 0 }, pressure: { ...calm, db: true } });
    expect(healthy.target).toBe(4);
    expect(healthy.providerHeld).toBeFalsy();
  });

  it('a healthy model is unaffected: under half provider failures it grows as before', () => {
    const d = decideTarget({ target: 4, active: 4, waiting: 20, window: { ok: 9, content: 0, transient: 1 }, pressure: calm });
    expect(d.providerHeld).toBeFalsy();
    expect(d.target).toBe(8);
  });
});
