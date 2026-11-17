/**
 * META-18-3, repair F4: the mathematical toolkit has production consumers.
 *
 * The finding this answers: per-question selection and forecast-versus-realized
 * correction were reached only from tests, and per-number provenance covered a
 * single synthetic price identity on at most five openings a day. Here the cash
 * ledger refresh (`keepCashLedger`, reached from every goal-plan reading) and
 * the intelligence sprint (every scored opening, not a sample) state each
 * material number with its provenance, judge which mathematics fits each
 * question, and read their forecasts against realized results with the
 * correction a systematic error proposes.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { keepCashLedger } from '../server/services/quant/ledger.ts';
import type { CashForecast } from '../server/services/cash/forecast.ts';
import {
  BIAS_EVENT,
  MATH_EVENTS,
  estimateProvenance,
  probabilityProvenance,
  type BiasReading,
  type MathSelection,
  type NumberProvenance,
} from '../server/services/quant/mathToolkit.ts';
import {
  BASELINE_METHOD,
  DEMONSTRATED_PER_RUN,
  GENERAL_METHOD,
  SPRINT_CALLER,
  methodForecastReading,
  runSprintBenchmark,
  type SprintProblem,
} from '../server/services/improvement/sprint.ts';

async function events(type: string, caller?: string): Promise<{ outcome: string | null; reason: string | null; measures: string | null }[]> {
  return getDb().all(
    `SELECT outcome, reason, measures FROM bin_events WHERE event_type = ?${caller ? ' AND workload_class = ?' : ''} ORDER BY at, id`,
    caller ? [type, caller] : [type],
  );
}

const forecast = (revenueCents: number): CashForecast =>
  ({
    currency: 'USD',
    considered: 4,
    qualified: 3,
    revenue: { valueCents: revenueCents, lowCents: revenueCents - 200, highCents: revenueCents + 200, fromRows: 3, basis: 'median of 3 priced openings', unknown: [], confidence: 'MEDIUM', blocking: '' },
    contribution: { valueCents: null, lowCents: null, highCents: null, fromRows: 0, basis: 'no opening states its costs', unknown: ['Economics'], confidence: 'NONE', blocking: 'costs' },
    upfrontCash: { valueCents: 500, lowCents: 500, highCents: 500, fromRows: 1, basis: 'one opening states its exposure', unknown: [], confidence: 'LOW', blocking: '' },
    ongoingCosts: { valueCents: null, lowCents: null, highCents: null, fromRows: 0, basis: 'none stated', unknown: ['Economics'], confidence: 'NONE', blocking: 'costs' },
    timeToFirstDollar: { days: 30, lowDays: null, highDays: null },
    breakEven: { days: null, lowDays: null, highDays: null },
    humanHours: { total: null, fromRows: 0, unknown: [] },
  }) as unknown as CashForecast;

describe('the cash ledger refresh states its material numbers with provenance and a method judgment', () => {
  it('records provenance for every forecast figure — unknown ones as unknown — and a selection per figure, once per new version', async () => {
    await freshProject();
    await keepCashLedger('prj_math', ['USD'], { forecast: async () => forecast(1000), measured: async () => [] });
    const prov = await events(MATH_EVENTS.PROVENANCE, 'cash-ledger');
    const records = prov.map((r) => (JSON.parse(r.measures!) as { provenance: NumberProvenance }).provenance);
    const byKey = new Map(records.map((r) => [r.key, r]));
    const revenue = byKey.get('cash:prj_math:USD:revenue')!;
    expect(revenue.value).toBe(10);
    expect(revenue.units).toBe('USD');
    expect(revenue.quantity.kind).toBe('GROSS_BILLED');
    expect(revenue.horizon).toContain('30 day(s)');
    expect(revenue.sources[0]!.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(revenue.computation.dimensionCheck.ok).toBe(true);
    expect(revenue.alternatives.map((a) => a.value)).toEqual([8, 12]);
    expect(revenue.sensitivity[0]!.elasticity).toBeCloseTo(1);
    expect(revenue.applicability.evidence).toContain('median of 3 priced openings');
    // A figure no row supports is recorded as unknown, never as a convenient number.
    const contribution = byKey.get('cash:prj_math:USD:contribution')!;
    expect(contribution.value).toBeNull();
    expect(contribution.nature).toBe('UNKNOWN');
    expect(contribution.alternatives[0]!.label).toContain('Economics');
    expect(byKey.has('cash:prj_math:USD:upfrontCash')).toBe(true);
    expect(byKey.has('cash:prj_math:USD:ongoingCosts')).toBe(true);

    const sel = await events(MATH_EVENTS.SELECTION, 'cash-ledger');
    expect(sel).toHaveLength(4);
    const revenueSelection = sel.map((r) => (JSON.parse(r.measures!) as { selection: MathSelection }).selection).find((s) => s.subject.endsWith(':revenue'))!;
    // Rows state it: the identity fits. Too few resolved outcomes and one version: those families are unfit, with the count as evidence.
    expect(revenueSelection.selected).toEqual(['cash_flow_identities']);
    expect(revenueSelection.judgments.find((j) => j.family === 'statistical_estimation_calibration')!.verdict).toBe('UNFIT');

    // The same forecast again is not a new claim, so nothing is re-recorded.
    await keepCashLedger('prj_math', ['USD'], { forecast: async () => forecast(1000), measured: async () => [] });
    expect(await events(MATH_EVENTS.PROVENANCE, 'cash-ledger')).toHaveLength(prov.length);
    // A revised forecast is a new version and its numbers get provenance again.
    await keepCashLedger('prj_math', ['USD'], { forecast: async () => forecast(1400), measured: async () => [] });
    const after = (await events(MATH_EVENTS.PROVENANCE, 'cash-ledger')).map((r) => (JSON.parse(r.measures!) as { provenance: NumberProvenance }).provenance);
    expect(after.filter((r) => r.key === 'cash:prj_math:USD:revenue').map((r) => r.value)).toEqual([10, 14]);
  });
});

describe('a systematic forecast error proposes a correction that reaches the number', () => {
  it('carries a figure bias as the bias-corrected alternative of the money figure', () => {
    const bias: BiasReading[] = [
      { comparableKey: 'cash:USD:revenue', basis: 'FIGURE', n: 25, bias: -0.3, zScore: -5, verdict: 'SYSTEMATIC', correction: { kind: 'SCALE_FIGURE', amount: 0.7, rationale: 'realized ran 30% under' } },
    ];
    const built = estimateProvenance({
      key: 'k',
      quantity: { kind: 'GROSS_BILLED', definition: 'revenue per deal' },
      currency: 'USD',
      horizon: '30 days',
      estimate: { valueCents: 1000, lowCents: 800, highCents: 1200, fromRows: 3, basis: 'rows' },
      sourceRef: 'cash_forecast:x',
      retrievedAt: '2026-11-16T00:00:00.000Z',
      method: 'spread',
      comparableKey: 'cash:USD:revenue',
      bias,
    });
    expect(built.ok).toBe(true);
    const corrected = built.ok ? built.record.alternatives.find((a) => a.label.startsWith('corrected')) : undefined;
    expect(corrected?.value).toBeCloseTo(7);
  });

  it('refuses a probability with no source rather than carrying it', () => {
    const built = probabilityProvenance({
      key: 'p',
      definition: 'p',
      value: 0.4,
      horizon: 'h',
      sourceRef: '',
      retrievedAt: '2026-11-16',
      method: 'm',
      evidence: [],
      alternatives: [{ label: 'other', value: 0.5 }],
      comparableKey: 'c',
    });
    expect(built.ok).toBe(false);
  });
});

let seq = 0;
const problem = (over: Partial<SprintProblem> = {}): SprintProblem => {
  seq += 1;
  return {
    id: `opm_${String(seq).padStart(4, '0')}`,
    projectId: 'prj_math',
    title: `opening ${seq}`,
    mechanism: 'RESALE',
    industry: 'equipment',
    source: 'https://example.test/listing',
    sourceClaimId: null,
    payer: 'Acme',
    reachableChannel: 'email',
    buyingSignal: 'posted RFQ',
    acceptanceCondition: 'delivered',
    priceCents: 120000,
    currency: 'USD',
    paymentTerms: 'net 15',
    fulfillmentOwner: 'supplier',
    deadline: null,
    humanHours: 1,
    state: 'DECLINED',
    createdAt: `2026-10-${String((seq % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
};

describe('the sprint states every scored opening’s numbers, judges its methods against what production resolved', () => {
  it('reads a method whose probabilities production contradicts as systematic and proposes the shift', () => {
    // The baseline says 0.6 on every opening that has a payer and price; production declined all thirty.
    const ps = Array.from({ length: 30 }, () => problem());
    const verdicts = ps.map((p) => BASELINE_METHOD.run(p, 0.6));
    const reading = methodForecastReading(BASELINE_METHOD.key, ps, verdicts, '2026-11-16T00:00:00.000Z');
    const prob = reading.bias.find((b) => b.basis === 'PROBABILITY')!;
    expect(prob.verdict).toBe('SYSTEMATIC');
    expect(prob.correction?.kind).toBe('SHIFT_PROBABILITY');
    expect(prob.correction?.amount).toBeCloseTo(-0.6);
    expect(reading.calibration?.verdict).toBe('MISCALIBRATED');
    // Openings production has not resolved are not outcomes.
    const open = methodForecastReading(BASELINE_METHOD.key, ps.map((p) => ({ ...p, state: 'EVIDENCE_CARD' })), verdicts, '2026-11-16T00:00:00.000Z');
    expect(open.bias).toEqual([]);
  });

  it('records provenance and a selection for every scored opening — beyond the demonstration sample — and only what changed on the next run', async () => {
    await freshProject();
    const ps = Array.from({ length: 3 * DEMONSTRATED_PER_RUN }, (_, i) => problem({ state: i % 3 === 0 ? 'READY' : i % 3 === 1 ? 'DECLINED' : 'EVIDENCE_CARD' }));
    const deps = {
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => {
        throw new Error('no knowledge in this fixture');
      },
      recordDecision: async () => {},
      sendNeeds: (async () => ({})) as never,
      registerDirected: async () => ({ candidate: { id: 'imc_math' } }),
      now: () => new Date('2026-11-16T00:00:00.000Z'),
    };
    const run = await runSprintBenchmark(deps);
    const prov = (await events(MATH_EVENTS.PROVENANCE, SPRINT_CALLER)).map((r) => (JSON.parse(r.measures!) as { provenance: NumberProvenance }).provenance);
    const opened = new Set(prov.map((r) => r.key.split(':').pop()));
    expect(opened.size).toBe(ps.length);
    expect(opened.size).toBeGreaterThan(DEMONSTRATED_PER_RUN);
    for (const p of ps) {
      const mine = prov.filter((r) => r.key.endsWith(p.id));
      expect(mine.map((r) => r.quantity.kind).sort()).toEqual(['GROSS_BILLED', 'PROBABILITY', 'PROBABILITY']);
      const baseline = mine.find((r) => r.key.includes(BASELINE_METHOD.key))!;
      expect(baseline.sources[0]!.ref).toBe(`rule:${BASELINE_METHOD.key}`);
      expect(baseline.value).toBe(0.6);
      expect(baseline.nature).toBe('UNCALIBRATED_PROBABILITY');
      expect(mine.find((r) => r.key.includes(GENERAL_METHOD.key))!.alternatives.length).toBeGreaterThan(0);
    }
    const sel = await events(MATH_EVENTS.SELECTION, SPRINT_CALLER);
    expect(sel).toHaveLength(ps.length);
    expect(run.math.provenanceRecorded).toBe(prov.length);
    expect(run.math.selectionsRecorded).toBe(ps.length);
    expect(Object.keys(run.math.bias).sort()).toEqual([BASELINE_METHOD.key, GENERAL_METHOD.key].sort());
    expect((await events(BIAS_EVENT, SPRINT_CALLER)).length).toBe(2);

    // The next run states the same numbers: nothing is re-recorded, and the run says so.
    const again = await runSprintBenchmark({ ...deps, now: () => new Date('2026-11-17T00:00:00.000Z') });
    expect(again.math.provenanceRecorded).toBe(0);
    expect(again.math.selectionsRecorded).toBe(0);
    expect(again.math.provenanceUnchanged).toBe(prov.length);
  });
});
