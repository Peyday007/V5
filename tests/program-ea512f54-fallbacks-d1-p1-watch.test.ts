/**
 * FALL-37-4 repair-F4: the switch criteria, early warning, reliability reading
 * and failure record run in production. `knowledge.ts loadCashKnowledge` (read
 * by every goal scenario and the causal routes) runs `fallbackWatch.ts` on the
 * forecast it already holds, so a miss on the ledger becomes a failure in
 * `bin_events`, drift re-reads the plans resting on the claim, each correction
 * is judged by `switchDecision`, and a recurring class reaches Factory.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assessModelLearning } from '../server/services/quant/export.ts';
import type { MissCause, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import { correctionSwitchFacts, driftSignals, forecastFailures, watchForecastPath } from '../server/services/quant/fallbackWatch.ts';
import { forgetKnowledge, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { readFailureRecoveries, recordOutcome, recordPrediction } from '../server/services/quant/ledger.ts';
import { getCandidateByKey } from '../server/repos/improvement.ts';
import { getDb } from '../server/db/database.ts';
import { freshProject } from './helpers.ts';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

/** One claim revised `n` times, each version forecast at 0.9 and resolved; `hit(i)` says which landed. */
function claimHistory(claimId: string, key: string, n: number, hit: (i: number) => boolean, cause: MissCause) {
  const predictions: PredictionRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (let i = 0; i < n; i++) {
    const p: PredictionRow = {
      id: `${claimId}#v${i + 1}`, claimId, version: i + 1, outcome: 'sale', horizonDays: 30, population: 'x',
      data: ['d'], assumptions: ['a'], probability: 0.9, comparableKey: key, madeAt: day(i),
    };
    predictions.push(p);
    const ok = hit(i);
    // Measured 35 days after it was made: five days after the 30-day horizon closed.
    outcomes.push({ predictionId: p.id, observedAt: day(i + 35), occurred: ok, ...(ok ? {} : { observedCauses: [cause] }) });
  }
  return { predictions, outcomes };
}

function reading(...histories: ReturnType<typeof claimHistory>[]) {
  return assessModelLearning({
    predictions: histories.flatMap((h) => h.predictions),
    exposures: [],
    outcomes: histories.flatMap((h) => h.outcomes),
  });
}

describe('FALL-37-4 runs in production through the cash knowledge refresh', () => {
  it('is called from loadCashKnowledge, a module production imports', () => {
    const knowledge = readFileSync('server/services/quant/knowledge.ts', 'utf8');
    expect(knowledge).toContain("from './fallbackWatch.ts'");
    expect(knowledge).toMatch(/watchFallbacks\(projectId, currencies, learning\)/);
    const watch = readFileSync('server/services/quant/fallbackWatch.ts', 'utf8');
    for (const name of ['switchDecision(', 'authorityForSwitch', 'earlyWarning(', 'readReliability(', 'recordFailureRecovery(', 'recurringFailureClasses(']) expect(watch).toContain(name);
  });

  it('records every diagnosed miss as a failure, with timeliness, what was tried and whether the path recovered', () => {
    const r = reading(claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE'));
    const failures = forecastFailures(r);
    expect(failures.length).toBeGreaterThan(0);
    const systematic = failures.filter((f) => f.failureClass === 'FORECAST_MISS:SYSTEMATIC:PARAMETER_ESTIMATE');
    expect(systematic.length).toBeGreaterThan(0);
    for (const f of systematic) {
      expect(f.dependency).toBe('claim-bad');
      expect(f.detectionDelayDays).toBe(5);
      expect(f.timeToHarmDays).toBe(30);
      expect(f.tried).toEqual(['correction of PARAMETER_ESTIMATE by RESEARCH']);
      expect(f.methodsToImprove).toEqual(['PARAMETER_ESTIMATE (RESEARCH)']);
    }
    // v3 hits at i=0..2 then misses: the miss at i=3 is followed by another miss (i=4) — not recovered —
    // and the miss at i=9 is followed by a hit (i=10) — recovered. The last version has nothing after it.
    const at = (v: number) => failures.find((f) => f.occurrence.startsWith(`forecast-miss:claim-bad#v${v}:`));
    expect(at(4)!.recovered).toBe(false);
    expect(at(10)!.recovered).toBe(true);
    expect(at(30)!.recovered).toBeNull();
  });

  it('judges a research correction an automatic failover and a commercial-operations one an escalation', () => {
    expect(correctionSwitchFacts({ owner: 'RESEARCH' })).toMatchObject({ internal: true, reversible: true, spendsUnapprovedMoney: false });
    expect(correctionSwitchFacts({ owner: 'COMMERCIAL_OPERATIONS' })).toMatchObject({ internal: false, spendsUnapprovedMoney: null });
  });

  it('turns a miscalibrated bucket into a drift warning at the calibrator threshold', () => {
    const signals = driftSignals(reading(claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE')));
    expect(signals.some((s) => s.kind === 'FORECAST_DRIFT' && s.dependency === 'claim-bad' && (s.observed ?? 0) > s.threshold!)).toBe(true);
  });

  it('writes failures once, re-reads dependent plans, judges switches and hands a recurring class to Factory', async () => {
    const { project } = await freshProject();
    const r = reading(
      claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE'),
      claimHistory('claim-ops', 'ops', 30, (i) => i % 10 < 3, 'CAPACITY'),
    );
    const replan = vi.fn();
    const authority = vi.fn(async () => ({ ok: null, reason: 'no commercial action applies' }));
    const dependents = new Map([['claim-bad', ['goal-1']]]);

    const first = await watchForecastPath(project.id, r, { replan, authority, dependents });
    expect(first.failures.length).toBeGreaterThan(0);
    expect(first.failures.every((f) => f.written)).toBe(true);
    const stored = await readFailureRecoveries(project.id);
    expect(stored.map((s) => s.occurrence).sort()).toEqual(first.failures.map((f) => f.occurrence).sort());

    // Preventive action: the plan resting on the drifting claim is handed back.
    expect(first.warnings.actions.some((a) => a.dependency === 'claim-bad' && a.kind === 'FORECAST_DRIFT')).toBe(true);
    expect(replan).toHaveBeenCalledWith('goal-1', expect.stringContaining('preventive'));
    expect(first.replanned).toEqual(['goal-1']);

    // Switch criteria, through the one authority reading.
    expect(authority).toHaveBeenCalled();
    const research = first.switches.find((s) => s.cause === 'PARAMETER_ESTIMATE')!;
    const ops = first.switches.find((s) => s.cause === 'CAPACITY')!;
    expect(research.decision.action).toBe('AUTO_FAILOVER');
    expect(ops.decision.action).toBe('ESCALATE');
    expect(ops.decision.reasons.join(' ')).toMatch(/not known/);

    // Reliability is read and no assurance is invented: the corrected forecast's own miss rate is unknown.
    expect(first.reliability.assurance.supported).toBe(false);
    expect(first.reliability.assuredFloor).toBeNull();

    // Recurring classes with a method to improve reach the improvement register.
    const key = 'FALLBACK:FORECAST_MISS:SYSTEMATIC:PARAMETER_ESTIMATE';
    expect(first.improvements.map((i) => i.weaknessKey)).toContain(key);
    const candidate = await getCandidateByKey(key);
    expect(candidate?.kind).toBe('RECURRING_FAILURE_CLASS');
    // Expected misses name no method, so they are never a Factory objective.
    expect(first.improvements.some((i) => i.weaknessKey.includes('EXPECTED'))).toBe(false);

    // The same reading again writes nothing new.
    const again = await watchForecastPath(project.id, r, { replan, authority, dependents });
    expect(again.failures.every((f) => !f.written)).toBe(true);
    expect(again.improvements.every((i) => !i.created)).toBe(true);
  });

  it('settles a recovery the first record left unknown, keeping both rows', async () => {
    const { project } = await freshProject();
    const full = claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE');
    const authority = async () => ({ ok: null, reason: 'none' });
    // First refresh: the last miss (v30) has nothing after it, so its recovery is unknown.
    const before = await watchForecastPath(project.id, reading(full), { authority, replan: () => {} });
    const last = before.failures.find((f) => f.occurrence.startsWith('forecast-miss:claim-bad#v30:'))!;
    expect(last.recovered).toBeNull();
    // A later version lands: the path recovered, and the record says so.
    const next: PredictionRow = { ...full.predictions[29]!, id: 'claim-bad#v31', version: 31, madeAt: day(30) };
    const later = { predictions: [...full.predictions, next], outcomes: [...full.outcomes, { predictionId: next.id, observedAt: day(65), occurred: true }] };
    await watchForecastPath(project.id, reading(later), { authority, replan: () => {} });
    const settled = (await readFailureRecoveries(project.id)).find((r) => r.occurrence === last.occurrence)!;
    expect(settled.recovered).toBe(true);
    const rows = await getDb().all<{ id: string }>(`SELECT id FROM bin_events WHERE event_type = 'FALLBACK_FAILURE_RECOVERY' AND reason LIKE ? AND project_id = ?`, ['claim-bad:%', project.id]);
    expect(rows.length).toBe(before.failures.length + 1);
  });

  it('records ledger misses as failures when the knowledge refresh runs on real ledger rows', async () => {
    const { project } = await freshProject();
    const claimId = `cash:${project.id}:USD:revenue`;
    for (let i = 0; i < 30; i++) {
      const p = await recordPrediction(
        { claimId, outcome: 'sale', horizonDays: 30, population: 'x', data: ['d'], assumptions: ['a'], probability: 0.9, comparableKey: 'k' },
        { projectId: project.id, now: () => day(i) },
      );
      await recordOutcome(p.id, i % 4 === 0, i % 4 === 0 ? {} : { assumptionBroke: true }, { projectId: project.id, now: () => day(i + 35), evidence: `row-${i}` });
    }
    forgetKnowledge();
    const knowledge = await loadCashKnowledge(project.id);
    expect(knowledge.fallbacks).toBeTruthy();
    const stored = await readFailureRecoveries(project.id);
    expect(stored.length).toBe(knowledge.fallbacks!.failures.length);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((s) => s.dependency === claimId)).toBe(true);
  });
});

/**
 * repair-F5-2: multi-level reliability on production records. The watch reads
 * the goals resting on the forecast from their own plan readings
 * (`goal_plan_readings`), so goal-portfolio reliability and correlated downside
 * are stated — at their conservative common-cause bounds — rather than always
 * null, and each correction's effect as a safeguard is read.
 */
describe('the watch reads reliability at the goal-portfolio level from plan readings', () => {
  async function planReading(goalId: string, forecast: Record<string, unknown>, at: string) {
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'X', NULL, '[]', NULL, ?, ?)`,
      [`gpr-${goalId}-${at}`, goalId, `d-${at}`, JSON.stringify(forecast), at],
    );
  }

  it('states goal-portfolio reliability and correlated downside from the latest reading of each dependent goal', async () => {
    const { project } = await freshProject();
    const r = reading(claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE'));
    // An earlier reading of goal-a is superseded by the latest one.
    await planReading('goal-a', { acceptance: { candidate: { reach: 0.2, reachBasis: 'PROBABILITY' } } }, day(1));
    await planReading('goal-a', { acceptance: { candidate: { reach: 0.95, reachBasis: 'PROBABILITY' } } }, day(2));
    await planReading('goal-b', { acceptance: { candidate: { reach: 0.9, reachBasis: 'PROBABILITY' } } }, day(2));
    const dependents = new Map([['claim-bad', ['goal-a', 'goal-b']]]);

    const watch = await watchForecastPath(project.id, r, { authority: async () => ({ ok: null, reason: 'none' }), replan: () => {}, dependents });

    expect(watch.reliability.goalPortfolios).toEqual([
      { goalId: 'goal-a', reach: 0.95, basis: 'PROBABILITY' },
      { goalId: 'goal-b', reach: 0.9, basis: 'PROBABILITY' },
    ]);
    // Common cause: both goals rest on one forecast, so neither the product nor independence is assumed.
    expect(watch.reliability.portfolioReliability).toBeCloseTo(0.85, 10);
    expect(watch.reliability.correlatedDownside).toBeCloseTo(0.15, 10);
    expect(watch.reliability.portfolioBasis).toBe('PROBABILITY');
    expect(watch.reliability.timeToRecoveryDays === null || typeof watch.reliability.timeToRecoveryDays === 'number').toBe(true);
    // Each correction is read as a safeguard on the pathway's chance of success; its expected net is not invented.
    expect(watch.safeguards.length).toBeGreaterThan(0);
    expect(watch.safeguards.every((s) => s.expectedNetDelta === null)).toBe(true);
  });

  it('a coverage reach is stated but never supports an assurance, and an unread goal leaves the portfolio unknown', async () => {
    const { project } = await freshProject();
    const r = reading(claimHistory('claim-bad', 'bad', 30, (i) => i % 10 < 3, 'PARAMETER_ESTIMATE'));
    await planReading('goal-c', { reach: 0.97 }, day(3));
    const covered = await watchForecastPath(project.id, r, { authority: async () => ({ ok: null, reason: 'none' }), replan: () => {}, dependents: new Map([['claim-bad', ['goal-c']]]) });
    expect(covered.reliability.portfolioReliability).toBeCloseTo(0.97, 10);
    expect(covered.reliability.portfolioBasis).toBe('COVERAGE');
    expect(covered.reliability.assurance.supported).toBe(false);
    expect(covered.reliability.assurance.statement).toMatch(/coverage/);

    const unread = await watchForecastPath(project.id, r, { authority: async () => ({ ok: null, reason: 'none' }), replan: () => {}, dependents: new Map([['claim-bad', ['goal-c', 'goal-never-read']]]) });
    expect(unread.reliability.goalPortfolios.find((g) => g.goalId === 'goal-never-read')).toEqual({ goalId: 'goal-never-read', reach: null, basis: null });
    expect(unread.reliability.portfolioReliability).toBeNull();
    expect(unread.reliability.correlatedDownside).toBeNull();
  });
});
