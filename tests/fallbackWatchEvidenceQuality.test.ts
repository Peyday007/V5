/**
 * FALLBACK:FORECAST_MISS:SYSTEMATIC:EVIDENCE_QUALITY, as recorded in production: five operator-decision
 * misses (`operator:opd_*`), each naming EVIDENCE_QUALITY first and then MISSING_MECHANISM, CAPACITY and
 * CHANGED_CONDITIONS — every one research-owned (`forecast.ts CAUSE_OWNER`), the misses themselves caused by
 * research commissions refused upstream. The class was handed to Factory under the rule before claim families
 * existed; the current rule no longer raises it, but the candidate already in the register stayed open and
 * kept becoming Factory jobs that no repository change can satisfy. The watch that raised it retires it, once,
 * and leaves every class Factory can correct — or that touches the cash forecast — exactly as it was.
 */
import { describe, expect, it, vi } from 'vitest';
import { assessModelLearning } from '../server/services/quant/export.ts';
import type { MissCause, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import { watchForecastPath } from '../server/services/quant/fallbackWatch.ts';
import { getCandidateByKey, listImprovementEvents, patchCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { freshProject } from './helpers.ts';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

const RECORDED_CAUSES: MissCause[] = ['EVIDENCE_QUALITY', 'MISSING_MECHANISM', 'CAPACITY', 'CHANGED_CONDITIONS'];
const RECORDED_DECISIONS = ['opd_acf097f3d701843a', 'opd_dd5342308cd2fac2', 'opd_6722ab7041f2c25f', 'opd_64c054e4c94ef249', 'opd_08c6ae3381425802'];
const KEY = 'FALLBACK:FORECAST_MISS:SYSTEMATIC:EVIDENCE_QUALITY';

/** One claim revised `n` times at 0.9, missing 7 in 10 with `causes` observed on every miss. */
function claimHistory(claimId: string, key: string, causes: MissCause[], n = 30) {
  const predictions: PredictionRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (let i = 0; i < n; i++) {
    const p: PredictionRow = {
      id: `${claimId}#v${i + 1}`, claimId, version: i + 1, outcome: 'decision held', horizonDays: 30, population: 'x',
      data: ['d'], assumptions: ['a'], probability: 0.9, comparableKey: key, madeAt: day(i),
    };
    predictions.push(p);
    const ok = i % 10 < 3;
    outcomes.push({ predictionId: p.id, observedAt: day(i + 35), occurred: ok, ...(ok ? {} : { observedCauses: causes }) });
  }
  return { predictions, outcomes };
}

function reading(...histories: ReturnType<typeof claimHistory>[]) {
  return assessModelLearning({ predictions: histories.flatMap((h) => h.predictions), exposures: [], outcomes: histories.flatMap((h) => h.outcomes) });
}

const recorded = () => reading(...RECORDED_DECISIONS.map((id) => claimHistory(`operator:${id}`, 'operator:EVIDENCE', RECORDED_CAUSES, 10)));

const quiet = { authority: async () => ({ ok: null, reason: 'none' }), replan: () => {} };

/** The candidate as the rule before claim families raised it (no "on <path>" in its text). */
async function staleCandidate(weaknessKey = KEY) {
  const { candidate } = await upsertCandidate({
    weaknessKey,
    kind: 'RECURRING_FAILURE_CLASS',
    title: `A failure recurs: ${weaknessKey.slice('FALLBACK:'.length).toLowerCase().replace(/_/g, ' ')}`,
    problem: '5 recorded failure(s) of class FORECAST_MISS:SYSTEMATIC:EVIDENCE_QUALITY: 0 recovered, 0 did not, 0 detected late.',
    metric: 'READY_OPPORTUNITIES_PER_DAY',
    downstreamMetric: null,
    ownerComponent: 'server/services/quant/fallbackWatch.ts',
    frequency: 5,
    denominator: 20,
    scope: 'LOCAL',
    severity: 'MEDIUM',
    evidence: {},
  });
  return candidate;
}

describe('the fallback watch retires a candidate it raised for a class Factory cannot correct', () => {
  it('reproduces the recorded EVIDENCE_QUALITY class on operator claims and retires its open candidate once', async () => {
    const { project } = await freshProject();
    const stale = await staleCandidate();
    const toFactory = vi.fn<typeof upsertCandidate>(upsertCandidate);

    const watch = await watchForecastPath(project.id, recorded(), { ...quiet, toFactory });

    // The recorded class recurs, on the operator path, with only research-owned methods…
    const cls = watch.recurring.find((c) => c.failureClass === 'FORECAST_MISS:SYSTEMATIC:EVIDENCE_QUALITY');
    expect(cls).toBeTruthy();
    expect(cls!.occurrences).toBeGreaterThanOrEqual(5);
    expect(cls!.methodsToImprove.length).toBeGreaterThan(0);
    expect(cls!.methodsToImprove.every((m) => m.endsWith('(RESEARCH)'))).toBe(true);
    expect(watch.failures.every((f) => f.pathway === `operator:${project.id}`)).toBe(true);

    // …is not handed to Factory again, and the candidate the old rule raised is retired.
    expect(toFactory.mock.calls.map(([c]) => c.weaknessKey)).not.toContain(KEY);
    expect(watch.improvements).toEqual([]);
    expect(watch.retired).toEqual([{ weaknessKey: KEY, retired: true }]);
    const after = await getCandidateByKey(KEY);
    expect(after!.id).toBe(stale.id);
    expect(after!.decision).toBe('REJECTED');
    expect(after!.decisionReason).toContain('operator claim path');
    expect(after!.decisionReason).toContain('EVIDENCE_QUALITY (RESEARCH)');
    const events = await listImprovementEvents({ candidateId: stale.id, kinds: ['DECIDED'] });
    expect(events).toHaveLength(1);

    // A second refresh finds it decided and leaves it alone.
    const again = await watchForecastPath(project.id, recorded(), { ...quiet, toFactory });
    expect(again.retired).toEqual([]);
    expect(await listImprovementEvents({ candidateId: stale.id, kinds: ['DECIDED'] })).toHaveLength(1);
    expect(again.recurring.some((c) => c.failureClass === 'FORECAST_MISS:SYSTEMATIC:EVIDENCE_QUALITY')).toBe(true);
  });

  it('leaves a candidate already in flight (delivered) to the improvement loop that measures it', async () => {
    const { project } = await freshProject();
    const stale = await staleCandidate();
    await patchCandidate(stale.id, { deliveredAt: day(60), deliveredRef: 'sha' });
    const watch = await watchForecastPath(project.id, recorded(), { ...quiet, toFactory: vi.fn<typeof upsertCandidate>(upsertCandidate) });
    expect(watch.retired).toEqual([]);
    expect((await getCandidateByKey(KEY))!.decision).toBeNull();
  });

  it('retires nothing a Factory-owned method or a cash claim makes Factory\'s own', async () => {
    const { project } = await freshProject();
    const cashClaim = `cash:${project.id}:USD:revenue`;
    const factoryKey = 'FALLBACK:FORECAST_MISS:SYSTEMATIC:MODEL_IMPLEMENTATION';
    const cashKey = 'FALLBACK:FORECAST_MISS:SYSTEMATIC:PARAMETER_ESTIMATE';
    await staleCandidate(factoryKey);
    await staleCandidate(cashKey);
    const r = reading(
      claimHistory('operator:opd_1', 'operator:BUILD', ['MODEL_IMPLEMENTATION']),
      claimHistory(cashClaim, 'cash', ['PARAMETER_ESTIMATE']),
    );
    const toFactory = vi.fn<typeof upsertCandidate>(upsertCandidate);
    const watch = await watchForecastPath(project.id, r, { ...quiet, toFactory });

    const keys = toFactory.mock.calls.map(([c]) => c.weaknessKey);
    expect(keys).toContain(factoryKey);
    expect(keys).toContain(cashKey);
    expect(watch.retired).toEqual([]);
    expect((await getCandidateByKey(factoryKey))!.decision).toBeNull();
    expect((await getCandidateByKey(cashKey))!.decision).toBeNull();
  });

  it('retires through the injected register calls, and never one owned by another component', async () => {
    const { project } = await freshProject();
    const retireCandidate = vi.fn(async () => true);
    const foreign = { ...(await staleCandidate()), ownerComponent: 'server/services/improvement/loop.ts' };
    const watch = await watchForecastPath(project.id, recorded(), { ...quiet, toFactory: vi.fn<typeof upsertCandidate>(upsertCandidate), findCandidate: async () => foreign, retireCandidate });
    expect(retireCandidate).not.toHaveBeenCalled();
    expect(watch.retired).toEqual([]);
  });
});
