/**
 * FALLBACK:FORECAST_MISS:SYSTEMATIC:MISSING_MECHANISM, as recorded in production: operator-decision misses
 * (`operator:<id>` claims, written by `operator/decisions.ts verify`) were recorded on the cash forecast
 * path, and their recurring class — every named method research-owned — was handed to Factory as "a failure
 * recurs on the cash forecast path", a job no repository change to that path can do. A failure sits on the
 * pathway of its own claim family, and a class leaves for Factory only when Factory can correct it.
 */
import { describe, expect, it, vi } from 'vitest';
import { assessModelLearning } from '../server/services/quant/export.ts';
import type { MissCause, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import { claimFamily, claimPathway, forecastDependencies, forecastPathways, watchForecastPath } from '../server/services/quant/fallbackWatch.ts';
import { readReliability } from '../server/services/quant/fallbackSwitch.ts';
import type { upsertCandidate } from '../server/repos/improvement.ts';
import { freshProject } from './helpers.ts';

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

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

function factorySpy() {
  return vi.fn<typeof upsertCandidate>(async () => ({ created: true }) as Awaited<ReturnType<typeof upsertCandidate>>);
}

const quiet = { authority: async () => ({ ok: null, reason: 'none' }), replan: () => {} };

describe('the fallback watch keeps a claim family on its own path and hands Factory only what Factory can correct', () => {
  it('names the family and pathway of a claim', () => {
    expect(claimFamily('operator:opd_586fc8e2bb8cb60c')).toBe('operator');
    expect(claimFamily('cash:prj_1:USD:revenue')).toBe('cash');
    expect(claimFamily('claim-bad')).toBe('cash');
    expect(claimPathway('prj_1', 'operator:opd_1')).toBe('operator:prj_1');
    expect(claimPathway('prj_1', 'cash:prj_1:USD:revenue')).toBe('cash-forecast:prj_1');
  });

  it('records research-owned operator misses on the operator path and does not hand them to Factory', async () => {
    const { project } = await freshProject();
    const r = reading(
      claimHistory('operator:opd_586fc8e2bb8cb60c', 'operator:EVIDENCE', ['MISSING_MECHANISM', 'CHANGED_CONDITIONS', 'CAPACITY']),
      claimHistory('operator:opd_e9f961cedc09e6ff', 'operator:EVIDENCE', ['MISSING_MECHANISM', 'CHANGED_CONDITIONS']),
    );
    const toFactory = factorySpy();
    const watch = await watchForecastPath(project.id, r, { ...quiet, toFactory });

    // Every miss is still recorded, labelled with its own family's path.
    expect(watch.failures.length).toBeGreaterThanOrEqual(2);
    expect(watch.failures.every((f) => f.written)).toBe(true);
    expect(watch.failures.every((f) => f.pathway === `operator:${project.id}`)).toBe(true);
    expect(watch.failures.some((f) => f.pathway.startsWith('cash-forecast:'))).toBe(false);

    // The recorded class still recurs and stays visible…
    const cls = watch.recurring.find((c) => c.failureClass === 'FORECAST_MISS:SYSTEMATIC:MISSING_MECHANISM');
    expect(cls).toBeTruthy();
    expect(cls!.occurrences).toBeGreaterThanOrEqual(2);
    expect(cls!.methodsToImprove.every((m) => m.endsWith('(RESEARCH)'))).toBe(true);
    // …but is not handed to Factory as a cash forecast defect.
    const keys = toFactory.mock.calls.map(([c]) => c.weaknessKey);
    expect(keys).not.toContain('FALLBACK:FORECAST_MISS:SYSTEMATIC:MISSING_MECHANISM');
    expect(toFactory.mock.calls.some(([c]) => /cash forecast path/.test(c.title))).toBe(false);
    expect(watch.improvements).toEqual([]);
  });

  it('still hands a class with a Factory-owned method to Factory, and keeps cash claims on the cash forecast path', async () => {
    const { project } = await freshProject();
    const cashClaim = `cash:${project.id}:USD:revenue`;
    const r = reading(
      claimHistory('operator:opd_1', 'operator:BUILD', ['MODEL_IMPLEMENTATION']),
      claimHistory(cashClaim, 'cash', ['PARAMETER_ESTIMATE']),
    );
    const toFactory = factorySpy();
    const watch = await watchForecastPath(project.id, r, { ...quiet, toFactory });

    const keys = toFactory.mock.calls.map(([c]) => c.weaknessKey);
    expect(keys).toContain('FALLBACK:FORECAST_MISS:SYSTEMATIC:MODEL_IMPLEMENTATION');
    const impl = toFactory.mock.calls.find(([c]) => c.weaknessKey === 'FALLBACK:FORECAST_MISS:SYSTEMATIC:MODEL_IMPLEMENTATION')![0];
    expect(impl.kind).toBe('RECURRING_FAILURE_CLASS');
    expect(impl.ownerComponent).toBe('server/services/quant/fallbackWatch.ts');
    expect(impl.problem).toContain('MODEL_IMPLEMENTATION (FACTORY)');
    expect(impl.title).toContain('operator claim path');

    // The cash forecast path is this module's own: its recurring class reaches Factory as before.
    expect(keys).toContain('FALLBACK:FORECAST_MISS:SYSTEMATIC:PARAMETER_ESTIMATE');
    const cash = watch.failures.filter((f) => f.claimId === cashClaim);
    expect(cash.length).toBeGreaterThan(0);
    expect(cash.every((f) => f.pathway === `cash-forecast:${project.id}`)).toBe(true);
    expect(watch.failures.filter((f) => f.claimId === 'operator:opd_1').every((f) => f.pathway === `operator:${project.id}`)).toBe(true);
  });

  it('a class that also occurs on a cash claim is the cash forecast path\'s, and its figures count only the cash claims', async () => {
    const { project } = await freshProject();
    const cashClaim = `cash:${project.id}:USD:revenue`;
    const r = reading(
      claimHistory(cashClaim, 'cash', ['MISSING_MECHANISM']),
      claimHistory('operator:opd_586fc8e2bb8cb60c', 'operator:EVIDENCE', ['MISSING_MECHANISM', 'CHANGED_CONDITIONS', 'CAPACITY']),
      claimHistory('operator:opd_e9f961cedc09e6ff', 'operator:EVIDENCE', ['MISSING_MECHANISM', 'CHANGED_CONDITIONS']),
    );
    const toFactory = factorySpy();
    const watch = await watchForecastPath(project.id, r, { ...quiet, toFactory });

    const failureClass = 'FORECAST_MISS:SYSTEMATIC:MISSING_MECHANISM';
    const ofClass = watch.failures.filter((f) => f.failureClass === failureClass);
    const cash = ofClass.filter((f) => f.pathway === `cash-forecast:${project.id}`);
    const operator = ofClass.filter((f) => f.pathway === `operator:${project.id}`);
    // The failure class this reproduces: the same class on both paths.
    expect(cash.length).toBeGreaterThan(0);
    expect(operator.length).toBeGreaterThan(0);
    expect(watch.recurring.find((c) => c.failureClass === failureClass)!.occurrences).toBe(cash.length + operator.length);

    const call = toFactory.mock.calls.find(([c]) => c.weaknessKey === `FALLBACK:${failureClass}`);
    expect(call).toBeTruthy();
    const candidate = call![0];
    expect(candidate.title).toContain('the cash forecast path');
    // Every figure is the named path's own: the cash claims' occurrences, never the operator decisions'.
    expect(candidate.frequency).toBe(cash.length);
    expect(candidate.problem).toMatch(new RegExp(`^${cash.length} recorded failure\\(s\\) of class ${failureClass} on the cash forecast path:`));
    expect(candidate.problem).not.toMatch(new RegExp(`^${cash.length + operator.length} recorded`));
    // The cash claims named only MISSING_MECHANISM; the operator-only methods are not the forecast's.
    expect(candidate.problem).not.toMatch(/CHANGED_CONDITIONS|CAPACITY/);
    // The operator occurrences are named beside the count, not hidden and not counted.
    expect(candidate.problem).toContain(`A further ${operator.length} of this class sit on the operator claim path and are not counted here.`);
    const samples = (candidate.evidence as { samples: string[] }).samples;
    expect(samples.length).toBe(Math.min(cash.length, 20));
    expect(samples.every((o) => cash.some((f) => f.occurrence === o))).toBe(true);
  });

  it("reads each family's reliability on its own pathway: operator misses are not pooled into the cash forecast's", async () => {
    const { project } = await freshProject();
    const cashClaim = `cash:${project.id}:USD:revenue`;
    const cashOnly = reading(claimHistory(cashClaim, 'cash', ['PARAMETER_ESTIMATE']));
    const mixed = reading(
      claimHistory(cashClaim, 'cash', ['PARAMETER_ESTIMATE']),
      claimHistory('operator:opd_586fc8e2bb8cb60c', 'operator:EVIDENCE', ['MISSING_MECHANISM']),
    );
    const watch = await watchForecastPath(project.id, mixed, { ...quiet, toFactory: factorySpy() });

    // Two pathways, each carrying only its own family's dependencies.
    const byKey = new Map(watch.reliability.pathways.map((p) => [p.pathway, p]));
    expect([...byKey.keys()].sort()).toEqual([`cash-forecast:${project.id}`, `operator:${project.id}`]);
    expect(byKey.get(`cash-forecast:${project.id}`)!.dependencies.map((d) => d.key)).toEqual([cashClaim]);
    expect(byKey.get(`operator:${project.id}`)!.dependencies.map((d) => d.key)).toEqual(['operator:opd_586fc8e2bb8cb60c']);

    // The cash forecast's reliability is what its own claims say, whatever the operator's decisions did.
    const alone = readReliability({ pathways: forecastPathways(project.id, forecastDependencies(cashOnly)), sampleSize: 30 });
    expect(byKey.get(`cash-forecast:${project.id}`)!.reliability).toBe(alone.pathways[0]!.reliability);

    // Every safeguard is judged against its own family's pathway: the cash correction's before/after match
    // the cash forecast read alone.
    const cashSafeguards = watch.safeguards.filter((s) => s.safeguard.includes('PARAMETER_ESTIMATE') || /parameter estimate/.test(s.safeguard));
    const aloneWatch = await watchForecastPath(project.id, cashOnly, { ...quiet, toFactory: factorySpy() });
    expect(cashSafeguards.length).toBeGreaterThan(0);
    expect(cashSafeguards.map((s) => s.successBefore)).toEqual(aloneWatch.safeguards.map((s) => s.successBefore));
  });

  it('a ledger of one family is one pathway, and an empty ledger is still the cash forecast path', () => {
    expect(forecastPathways('prj_1', []).map((p) => p.key)).toEqual(['cash-forecast:prj_1']);
    const r = reading(claimHistory('operator:opd_1', 'operator:BUILD', ['MISSING_MECHANISM']));
    expect(forecastPathways('prj_1', forecastDependencies(r)).map((p) => p.key)).toEqual(['operator:prj_1']);
  });
});
