/**
 * META-18-3 / SPRINT-18-5 repair F4: the math toolkit has production consumers.
 * The cash ledger's every new forecast figure keeps its provenance, its method
 * selection and the forecast-vs-realized correction; the sprint's own
 * probabilities (baseline and general) carry provenance, for every changed
 * opening rather than a handful of demonstrations.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  BIAS_EVENT,
  MATH_EVENTS,
  cashFigureProvenance,
  keepCashNumberProvenance,
  validateProvenance,
  type CashProvenanceReport,
} from '../server/services/quant/mathToolkit.ts';
import { keepCashLedger, type CashProvenanceInput } from '../server/services/quant/ledger.ts';
import type { CashForecast, Estimate } from '../server/services/cash/forecast.ts';
import type { OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';
import {
  BASELINE_METHOD,
  DEMONSTRATED_PER_RUN,
  GENERAL_METHOD,
  fitBaselineRates,
  generalProbabilityProvenance,
  runSprintBenchmark,
  type SprintProblem,
} from '../server/services/improvement/sprint.ts';

const est = (valueCents: number | null, low: number | null = null, high: number | null = null, fromRows = 4): Estimate => ({
  valueCents,
  lowCents: low,
  highCents: high,
  fromRows: valueCents === null ? 0 : fromRows,
  confidence: 'LOW' as Estimate['confidence'],
  basis: 'median of opportunity prices',
  unknown: valueCents === null ? ['Price'] : [],
  blocking: '',
});

const forecast = (over: Partial<CashForecast> = {}): CashForecast =>
  ({
    currency: 'USD',
    qualified: 4,
    considered: 6,
    upfrontCash: est(20_000, 10_000, 30_000),
    ongoingCosts: est(null),
    revenue: est(100_000, 80_000, 120_000),
    contribution: est(60_000, 40_000, 80_000),
    timeToFirstDollar: { days: null } as unknown as CashForecast['timeToFirstDollar'],
    breakEven: { days: null } as unknown as CashForecast['breakEven'],
    humanHours: { total: null, fromRows: 0, unknown: [] },
    ...over,
  }) as CashForecast;

describe('cash forecast figures keep their provenance in production', () => {
  it('builds a valid record for a stated figure and an unknown one for a withheld figure', () => {
    const ok = cashFigureProvenance({ projectId: 'prj_x', currency: 'USD', name: 'revenue', estimate: est(100_000, 80_000, 120_000), horizon: 'per deal', retrievedAt: '2026-11-17T00:00:00Z' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.record).toMatchObject({ value: 100_000, units: 'USD_cents', nature: 'ESTIMATE', quantity: { kind: 'GROSS_BILLED' } });
    expect(ok.record.alternatives.map((a) => a.value)).toEqual([80_000, 120_000]);
    expect(ok.record.sources[0]!.ref).toContain('cash_forecast:prj_x:USD:revenue');
    expect(validateProvenance(ok.record).ok).toBe(true);
    const withheld = cashFigureProvenance({ projectId: 'prj_x', currency: 'USD', name: 'contribution', estimate: est(null), horizon: 'per deal', retrievedAt: '2026-11-17T00:00:00Z' });
    expect(withheld.ok && withheld.record).toMatchObject({ value: null, nature: 'UNKNOWN' });
  });

  it('records selection, provenance and a systematic bias, and carries the correction into the figure', async () => {
    const preds: PredictionRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `cash:prj_x:USD:revenue@v${i + 1}`, claimId: 'cash:prj_x:USD:revenue', version: i + 1,
      outcome: 'revenue of 100000 USD cents (range 90000..110000)', horizonDays: 30, population: 'p', data: ['d'], assumptions: [],
      probability: null, comparableKey: 'cash:USD:revenue', madeAt: '2026-10-01T00:00:00Z',
    }));
    const outs: OutcomeRow[] = preds.map((p, i) => ({ predictionId: p.id, observedAt: '2026-10-20T00:00:00Z', occurred: false, realized: 70_000 + (i % 5) * 1000, evidence: `cash_outcomes:${i}` }));
    const events: { eventType: string; outcome?: string | null; measures?: Record<string, unknown> | null }[] = [];
    const report: CashProvenanceReport = await keepCashNumberProvenance(
      {
        projectId: 'prj_x',
        forecasts: [{ currency: 'USD', horizon: 'per deal', figures: [{ name: 'revenue', estimate: est(100_000, 90_000, 110_000), claimId: 'cash:prj_x:USD:revenue' }] }],
        ledger: { predictions: preds, exposures: [], outcomes: outs },
        newOutcomes: true,
        retrievedAt: '2026-11-17T00:00:00Z',
      },
      { record: async (e) => { events.push(e as (typeof events)[number]); } },
    );
    expect(report).toMatchObject({ provenance: 1, selections: 1, systematic: 1, refused: [] });
    expect(events.map((e) => e.eventType).sort()).toEqual([BIAS_EVENT, MATH_EVENTS.SELECTION, MATH_EVENTS.PROVENANCE].sort());
    const prov = events.find((e) => e.eventType === MATH_EVENTS.PROVENANCE)!.measures!['provenance'] as { alternatives: { label: string; value: number }[] };
    const corrected = prov.alternatives.find((a) => a.label.startsWith('corrected for realized bias'));
    expect(corrected?.value).toBe(72_000);
    const selection = events.find((e) => e.eventType === MATH_EVENTS.SELECTION)!.measures!['selection'] as { selected: string[] };
    expect(selection.selected).toEqual(expect.arrayContaining(['cash_flow_identities', 'statistical_estimation_calibration', 'forecasting_state_estimation']));
  });

  it('is called by keepCashLedger for every new forecast version, and not again for an unchanged one', async () => {
    const projectId = (await freshProject()).project.id;
    const held: { predictions: PredictionRow[]; exposures: never[]; outcomes: OutcomeRow[] } = { predictions: [], exposures: [], outcomes: [] };
    const calls: CashProvenanceInput[] = [];
    const deps = {
      read: async () => ({ predictions: [...held.predictions], exposures: [...held.exposures], outcomes: [...held.outcomes] }),
      record: async () => {},
      forecast: async () => forecast(),
      measured: async () => [],
      sprintHorizon: async () => 30,
      provenance: async (input: CashProvenanceInput) => { calls.push(input); },
    };
    const first = await keepCashLedger(projectId, ['USD'], deps);
    expect(first.written.length).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.forecasts[0]!.figures.map((f) => f.name)).toEqual(['revenue', 'contribution', 'upfrontCash']);
    expect(calls[0]!.forecasts[0]!.horizon).toContain('30 day');
    held.predictions.push(...first.written);
    await keepCashLedger(projectId, ['USD'], deps);
    expect(calls).toHaveLength(1);
  });
});

let seq = 0;
const problem = (over: Partial<SprintProblem> = {}): SprintProblem => {
  seq += 1;
  return {
    id: `opp_p${String(seq).padStart(4, '0')}`, projectId: 'prj_1', title: `opening ${seq}`, mechanism: 'RESALE', industry: 'equipment',
    source: 'https://example.test/listing', sourceClaimId: null, payer: 'Acme', reachableChannel: 'email', buyingSignal: 'posted RFQ',
    acceptanceCondition: 'delivered', priceCents: 120000, currency: 'USD', paymentTerms: 'net 15', fulfillmentOwner: 'supplier',
    deadline: null, humanHours: 1, state: 'READY', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
  };
};

describe("the sprint's own probabilities carry provenance", () => {
  it('fits the baseline on the benchmark: its probabilities are measured base rates, never 0.6/0.2', () => {
    const bench = [
      ...Array.from({ length: 6 }, () => problem()),
      ...Array.from({ length: 2 }, () => problem({ state: 'DISCOVERED' })),
      ...Array.from({ length: 4 }, () => problem({ payer: null, state: 'DISCOVERED' })),
    ];
    const rates = fitBaselineRates(bench, '2026-11-17T00:00:00Z');
    expect(rates.withPayerAndPrice).toMatchObject({ hits: 6, considered: 8, probability: 0.75 });
    expect(rates.without).toMatchObject({ hits: 0, considered: 4, probability: 0 });
    expect(rates.withPayerAndPrice.provenance && validateProvenance(rates.withPayerAndPrice.provenance).ok).toBe(true);
    const v = BASELINE_METHOD.run(bench[0]!, 0.5, { baseRates: rates });
    expect(v.probability).toBe(0.75);
    expect(v.provenance?.quantity.kind).toBe('PROBABILITY');
    // An empty kind is unknown, and the baseline states the uninformed prior rather than a chosen figure.
    const empty = fitBaselineRates([], '2026-11-17T00:00:00Z');
    expect(empty.without).toMatchObject({ probability: 0.5, considered: 0 });
    expect(empty.without.provenance?.nature).toBe('UNKNOWN');
    expect(BASELINE_METHOD.run(problem(), 0.5).probability).toBe(0.5);
  });

  it("records the general method's probability with the evidence counts it multiplies", () => {
    const p = problem({ buyingSignal: null });
    const v = GENERAL_METHOD.run(p, 0.5, {});
    const prov = generalProbabilityProvenance(p, v.decision!, '2026-11-17T00:00:00Z');
    expect(prov.record).not.toBeNull();
    expect(prov.record!.quantity.kind).toBe('PROBABILITY');
    expect(validateProvenance(prov.record!).ok).toBe(true);
    if (prov.record!.value !== null) expect(prov.record!.value).toBeCloseTo(v.probability, 2);
    else expect(prov.record!.nature).toBe('UNKNOWN');
  });

  it('records provenance for every changed opening, not only the demonstrated handful, plus rates and a selection', async () => {
    await freshProject();
    const ps = Array.from({ length: 30 }, (_, i) => problem({ state: i % 3 === 0 ? 'DISCOVERED' : 'READY' }));
    const keys: string[] = [];
    const selections: string[] = [];
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => { throw new Error('no knowledge in this test'); },
      recordDecision: async () => {},
      recordResult: async () => {},
      recordProcedure: async () => {},
      sendNeeds: (async () => ({})) as never,
      recordProvenance: async (p) => { keys.push(p.key); },
      recordSelection: async (s) => { selections.push(s.subject); },
      registerDirected: async () => ({ candidate: { id: 'imc_x' } }),
      record: async () => ({}) as never,
    });
    const gross = keys.filter((k) => k.startsWith('gross-billed:'));
    const general = keys.filter((k) => k.startsWith('sprint-general-probability:'));
    expect(gross.length).toBeGreaterThan(DEMONSTRATED_PER_RUN);
    expect(general.length).toBe(ps.length);
    expect(keys).toEqual(expect.arrayContaining(['sprint-baseline:payer-and-price', 'sprint-baseline:missing-payer-or-price']));
    expect(selections).toEqual(['intelligence sprint']);
    expect(run.loop.provenanceRecorded).toBe(keys.length);
    expect(run.loop.selectionsRecorded).toBe(1);
  });
});
