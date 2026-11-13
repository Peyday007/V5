import { describe, expect, it } from 'vitest';
import { claimHorizon, recordCashForecast, recordCashOutcomes } from '../server/services/quant/ledger.ts';
import type { CashForecast } from '../server/services/cash/forecast.ts';
import { assessModelLearning } from '../server/services/quant/export.ts';
import { learnFromCashLedger } from '../server/services/quant/knowledge.ts';
import { claimCausesOf, statedFigures, type ExposureRow, type OutcomeRow, type PredictionRow } from '../server/services/quant/forecast.ts';
import type { CashOutcome } from '../server/domain/cashJourney.ts';

/*
 * F-CAUSES-UNREACHABLE-IN-PRODUCTION: on production rows, the only signal an
 * outcome carries is a timing overrun, so a systematic miss used to be
 * diagnosed with no cause, and nothing was corrected or routed. The cause is
 * now read from the measured ledger itself — the claim's own figures, the
 * side its outcomes fell on, and whether two claims miss together — and a
 * correction that no goal's plan carries goes to the register.
 *
 * Every ledger here is built the way production builds it: predictions in the
 * exact text `recordCashForecast` writes, outcomes recorded by
 * `recordCashOutcomes` from `cash_outcomes` rows. No test writes a cause.
 */

const DAY = 86_400_000;
const at = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY).toISOString();

/** A cash claim as `recordCashForecast` states it. */
const cashClaim = (figure: 'revenue' | 'contribution', v: number, range: [number, number], rows = 9, value = rows * range[0]): PredictionRow => ({
  id: `cash:p:USD:${figure}@v${v}`,
  claimId: `cash:p:USD:${figure}`,
  version: v,
  outcome: `${figure} of ${value} USD cents (range ${range[0]}..${range[1]})`,
  horizonDays: 30,
  population: `${rows} qualified of ${rows + 2} opportunities in USD`,
  data: [figure === 'revenue' ? 'The prices stated on qualified opportunities.' : 'Price minus exposure, on the opportunities that answer both.'],
  assumptions: [`derived from ${rows} opportunity row(s)`],
  probability: null,
  comparableKey: `cash:USD:${figure}`,
  madeAt: at(v),
});

const ended = (i: number, kind: CashOutcome['kind'], cents: number): CashOutcome => ({
  id: `${kind === 'ACTUAL_COST' ? 'k' : 'r'}${i}`,
  projectId: 'p',
  opportunityId: `o${i}`,
  kind,
  mechanism: null,
  channel: null,
  valueCents: cents,
  valueMs: null,
  valueText: null,
  currency: 'USD',
  basis: 'b',
  createdAt: at(i + 0.5),
  requestKey: `outcome:o${i}:${kind}:COLLECTED`,
});

/**
 * 30 versions of each claim, each exposed and then resolved by one deal that ended
 * after it. The ranges imply 80% (9 rows); the realized figures say how often and on
 * which side they actually landed.
 */
async function productionLedger(realized: (i: number) => { contribution: number; revenue?: number }) {
  const predictions: PredictionRow[] = [];
  const exposures: ExposureRow[] = [];
  const outcomes: OutcomeRow[] = [];
  const measured: CashOutcome[] = [];
  for (let i = 1; i <= 30; i++) {
    for (const figure of ['contribution', 'revenue'] as const) {
      const p = cashClaim(figure, i, figure === 'contribution' ? [100, 1000] : [1000, 5000]);
      predictions.push(p);
      exposures.push({ predictionId: p.id, exposedAt: p.madeAt, atRiskCents: null });
    }
    const r = realized(i);
    measured.push(ended(i, 'REALIZED_CONTRIBUTION', r.contribution));
    if (r.revenue !== undefined) measured.push(ended(i, 'ACTUAL_COST', r.revenue - r.contribution));
  }
  const deps = {
    projectId: 'p',
    read: async () => ({ predictions, exposures, outcomes }),
    record: async () => undefined,
  };
  outcomes.push(...(await recordCashOutcomes('p', measured, deps as never)));
  return { predictions, exposures, outcomes };
}

describe('a systematic miss on production-shaped rows is attributed from the ledger', () => {
  it('misses on both sides of the claimed ranges are a parameter estimate, routed to research', async () => {
    // Contribution lands inside 100..1000 only 1 time in 5, against an implied 80%; misses alternate sides.
    const rows = await productionLedger((i) => ({ contribution: i % 5 === 0 ? 500 : i % 2 ? 50 : 5000 }));
    // The only signal production records is timing, and none of these deals was late.
    expect(rows.outcomes.every((o) => (o.observedCauses ?? []).length === 0)).toBe(true);
    const reading = assessModelLearning(rows);
    const systematic = reading.diagnoses.filter((d) => d.kind === 'SYSTEMATIC');
    expect(systematic.length).toBeGreaterThan(0);
    for (const d of systematic) {
      expect(d.causes).toEqual(['PARAMETER_ESTIMATE']);
      expect(d.attribution).toBe('LEDGER');
      expect(d.owner).toBe('RESEARCH');
      expect(d.reason).toMatch(/too narrow/);
    }
    expect(reading.corrections[0]).toMatchObject({ cause: 'PARAMETER_ESTIMATE', owner: 'RESEARCH', claimIds: ['cash:p:USD:contribution'] });
  });

  it('misses that fall on one side are a shifted draw: selection bias', async () => {
    const rows = await productionLedger((i) => ({ contribution: i % 5 === 0 ? 500 : 20 }));
    const reading = assessModelLearning(rows);
    const d = reading.diagnoses.find((x) => x.kind === 'SYSTEMATIC')!;
    expect(d.causes).toEqual(['SELECTION_BIAS']);
    expect(d.reason).toMatch(/below the claimed ranges/);
    expect(reading.corrections[0]).toMatchObject({ cause: 'SELECTION_BIAS', owner: 'RESEARCH' });
  });

  it('two claims missed by the same deals are not independent draws: dependency assumption', async () => {
    // Revenue and contribution miss on exactly the same deals, and land together otherwise.
    const rows = await productionLedger((i) => (i % 5 === 0 ? { contribution: 500, revenue: 3000 } : { contribution: 20, revenue: 200 }));
    const reading = assessModelLearning(rows);
    const causes = new Set(reading.diagnoses.filter((d) => d.kind === 'SYSTEMATIC').flatMap((d) => d.causes));
    expect(causes.has('DEPENDENCY_ASSUMPTION')).toBe(true);
    expect(reading.corrections.map((c) => c.cause)).toContain('DEPENDENCY_ASSUMPTION');
  });

  it('an observed signal is not overridden by the fallback', () => {
    const p = cashClaim('contribution', 1, [100, 1000]);
    const predictions: PredictionRow[] = [];
    const outcomes: OutcomeRow[] = [];
    for (let i = 0; i < 30; i++) {
      const q = { ...p, id: `x${i}`, claimId: `x${i}` };
      predictions.push(q);
      outcomes.push({ predictionId: q.id, observedAt: at(i), occurred: i % 5 === 0, ...(i % 5 ? { observedCauses: ['TIMING' as const] } : {}) });
    }
    const reading = assessModelLearning({ predictions, exposures: [], outcomes });
    const d = reading.diagnoses.find((x) => x.kind === 'SYSTEMATIC')!;
    expect(d.causes).toEqual(['TIMING']);
    expect(d.attribution).toBe('OBSERVED');
  });
});

describe('the claim\'s own figures carry evidence-quality and implementation causes', () => {
  it('reads the figures recordCashForecast writes', () => {
    expect(statedFigures(cashClaim('revenue', 1, [1000, 5000], 4, 9000))).toEqual({ value: 9000, low: 1000, high: 5000, rows: 4, population: 4 });
  });

  it('a figure derived from fewer rows than its population is evidence quality', () => {
    const p = { ...cashClaim('contribution', 1, [100, 1000], 3), population: '7 qualified of 9 opportunities in USD' };
    expect(claimCausesOf(p)).toEqual(['EVIDENCE_QUALITY']);
  });

  it('a total its own rows and range cannot produce is a model implementation defect', () => {
    expect(claimCausesOf(cashClaim('revenue', 1, [1000, 5000], 4, 90_000))).toEqual(['MODEL_IMPLEMENTATION']);
    expect(claimCausesOf(cashClaim('revenue', 1, [1000, 5000], 4, 9000))).toEqual([]);
  });

  it('an implementation defect reaches Factory from production-shaped rows', async () => {
    const rows = await productionLedger((i) => ({ contribution: i % 5 === 0 ? 500 : i % 2 ? 50 : 5000 }));
    // The model stated a total its own nine rows in 100..1000 cannot add up to.
    const broken = { ...rows, predictions: rows.predictions.map((p) => (p.claimId.endsWith('contribution') ? { ...p, outcome: p.outcome.replace(/of \d+/, 'of 99999') } : p)) };
    const reading = assessModelLearning(broken);
    expect(reading.corrections[0]).toMatchObject({ cause: 'MODEL_IMPLEMENTATION', owner: 'FACTORY' });
  });
});

describe('a correction always produces work', () => {
  it('a research correction no goal plan carries goes to the register', async () => {
    const rows = await productionLedger((i) => ({ contribution: i % 5 === 0 ? 500 : i % 2 ? 50 : 5000 }));
    const register: { weaknessKey: string; evidence: Record<string, unknown> }[] = [];
    const reading = await learnFromCashLedger('p', ['USD'], {
      read: async () => rows,
      goals: async () => [],
      note: async () => {
        throw new Error('no goal to note');
      },
      toFactory: (async (c: { weaknessKey: string; evidence: Record<string, unknown> }) => {
        register.push(c);
        return { candidate: {}, created: true };
      }) as never,
    });
    expect(reading.corrections[0]?.cause).toBe('PARAMETER_ESTIMATE');
    expect(register.map((c) => c.weaknessKey)).toEqual(['FORECAST:PARAMETER_ESTIMATE']);
    expect(register[0]!.evidence['correctionOwner']).toBe('RESEARCH');
  });
});

/*
 * F-HORIZON-ALWAYS-NULL: the cash forecast withholds `timeToFirstDollar` on every
 * production row, and the ledger took the claim's horizon from it alone, so every
 * production prediction stated no horizon. The forecast below is the shape
 * `cashForecast` returns in production — time to first dollar withheld.
 */
describe('a production cash claim states its horizon', () => {
  const withheldDays = { days: null, lowDays: null, highDays: null, fromRows: 0, confidence: 'NONE' as const, basis: 'cash dates', unknown: ['Cash dates'], blocking: 'No opportunity yet states when cash would arrive.' };
  const est = (v: number | null, low = v, high = v, rows = v === null ? 0 : 9) => ({ valueCents: v, lowCents: low, highCents: high, fromRows: rows, confidence: rows === 0 ? 'NONE' as const : 'SEVERAL_ROWS' as const, basis: 'The prices stated on qualified opportunities.', unknown: [], blocking: '' });
  const productionForecast: CashForecast = {
    currency: 'USD', qualified: 9, considered: 11,
    upfrontCash: est(500), ongoingCosts: est(null), revenue: est(9000, 1000, 5000), contribution: est(null),
    timeToFirstDollar: withheldDays, breakEven: withheldDays,
    humanHours: { total: null, fromRows: 0, unknown: [] },
  };
  const empty = async () => ({ predictions: [] as PredictionRow[], exposures: [] as ExposureRow[], outcomes: [] as OutcomeRow[] });
  const sink = async () => undefined;

  it('takes the horizon a person set for the cash sprint when the forecast withholds time to first dollar', async () => {
    const written = await recordCashForecast('p', productionForecast, { read: empty, record: sink as never, now: () => at(0), sprintHorizon: async () => 7 });
    expect(written).toHaveLength(1);
    expect(written[0]!.horizonDays).toBe(7);
    expect(written[0]!.assumptions).toContain('horizon: 7 day(s), the cash sprint horizon set when Cash Mode was activated');
    // The horizon assumption does not disturb the figures the claim's own causes are read from.
    expect(statedFigures(written[0]!)).toMatchObject({ value: 9000, low: 1000, high: 5000, rows: 9, population: 9 });
  });

  it('a diagnosis of a production claim no longer says the claim states no horizon', async () => {
    const [p] = await recordCashForecast('p', productionForecast, { read: empty, record: sink as never, now: () => at(0), sprintHorizon: async () => 7 });
    const reading = assessModelLearning({
      predictions: [p!],
      exposures: [{ predictionId: p!.id, exposedAt: at(0), atRiskCents: 500 }],
      outcomes: [{ predictionId: p!.id, observedAt: at(3), occurred: false, realized: 9999 }],
    });
    expect(reading.diagnoses.length).toBeGreaterThan(0);
    for (const d of reading.diagnoses) expect(d.claimGaps).not.toContain('the claim states no horizon');
  });

  it('the stated horizon is what a deal is measured late against: a deal past it is a timing overrun', async () => {
    const margins: CashForecast = { ...productionForecast, revenue: est(null), contribution: { ...est(4500, 100, 1000), basis: 'Price minus exposure, on the opportunities that answer both.' } };
    const record = async (sprint: number | null) => {
      const [p] = await recordCashForecast('p', margins, { read: empty, record: sink as never, now: () => at(0), sprintHorizon: async () => sprint });
      const exposures: ExposureRow[] = [{ predictionId: p!.id, exposedAt: at(0), atRiskCents: 500 }];
      // One deal, inside the claimed range, that ended ten and a half days after the claim.
      return recordCashOutcomes('p', [ended(10, 'REALIZED_CONTRIBUTION', 500)], { projectId: 'p', read: async () => ({ predictions: [p!], exposures, outcomes: [] }), record: sink as never });
    };
    const [onSprint] = await record(7);
    expect(onSprint).toMatchObject({ occurred: true, observedCauses: ['TIMING'] });
    // Without a stated horizon the same deal could not be measured late at all.
    const [unstated] = await record(null);
    expect(unstated!.observedCauses).toBeUndefined();
  });

  it('a stated time to first dollar still wins, and a project with no cash sprint is never given an invented horizon', async () => {
    const stated: CashForecast = { ...productionForecast, timeToFirstDollar: { ...withheldDays, days: 14 } };
    expect(await claimHorizon('p', stated, async () => 7)).toMatchObject({ days: 14 });
    expect(await claimHorizon('p', productionForecast, async () => null)).toBeNull();
    const written = await recordCashForecast('p', productionForecast, { read: empty, record: sink as never, sprintHorizon: async () => null });
    expect(written[0]!.horizonDays).toBeNull();
  });

  it('a claim recorded before the fix, with no horizon, is revised by the next forecast rather than repeated', async () => {
    const [old] = await recordCashForecast('p', productionForecast, { read: empty, record: sink as never, now: () => at(0), sprintHorizon: async () => null });
    const revised = await recordCashForecast('p', productionForecast, {
      read: async () => ({ predictions: [old!], exposures: [], outcomes: [] }), record: sink as never, now: () => at(1), sprintHorizon: async () => 7,
    });
    expect(revised.map((r) => [r.version, r.horizonDays])).toEqual([[2, 7]]);
  });
});
