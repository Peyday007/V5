/**
 * META-18-3 (S-0197, S-0198): the mathematics is selected per question, and
 * every material number keeps its provenance.
 */
import { describe, expect, it } from 'vitest';
import {
  buildNumberProvenance,
  checkDimensions,
  forecastBias,
  recordMathSelection,
  recordNumberProvenance,
  selectMathematics,
  validateProvenance,
  type BuildProvenanceInput,
  type NumberProvenance,
} from '../server/services/quant/mathToolkit.ts';
import { makeFigure, unknownFigure, type Figure } from '../server/services/quant/graph.ts';
import type { CalibrationBucket, OutcomeRow, PredictionRow } from '../server/services/quant/forecast.ts';

function fig(meaning: string, unit: string, value: number, source = 'invoice-rows:2026-11'): Figure {
  const r = makeFigure({ meaning, unit, value, status: 'OBSERVED', source, bounds: { low: value * 0.9, high: value * 1.1 } });
  if (!r.ok) throw new Error(r.reason);
  return r.figure;
}

const src = { ref: 'cash_outcomes:abc', retrievedAt: '2026-11-15T00:00:00Z' };

function netContribution(overrides: Partial<BuildProvenanceInput> = {}): BuildProvenanceInput {
  return {
    key: 'net-contribution:deal-1',
    quantity: { kind: 'NET_CONTRIBUTION' },
    units: 'USD/month',
    horizon: '2026-12 (one month)',
    formula: { op: '-', args: [{ op: '*', args: [{ ref: 'price' }, { ref: 'volume' }] }, { ref: 'cost' }] },
    inputs: [
      { key: 'price', figure: fig('price per unit', 'USD/unit', 40), source: src },
      { key: 'volume', figure: fig('units sold', 'unit/month', 100), source: src },
      { key: 'cost', figure: fig('fulfilment cost', 'USD/month', 1500), source: src },
    ],
    alternatives: [{ label: 'low price', parameters: { price: 30 } }],
    interdependence: ['volume and cost share fulfilment capacity'],
    applicability: { method: 'cash_flow_identities', evidence: ['contract:deal-1 states price per unit and monthly volume'] },
    form: 'IDENTITY',
    ...overrides,
  };
}

describe('selectMathematics', () => {
  it('records a per-question fitness judgment from evidence, never a fixed rule', () => {
    const s = selectMathematics({
      question: 'How long until the receivable settles?',
      subject: 'deal-1',
      candidates: [
        { family: 'time_to_event_settlement', purpose: 'settlement time', preconditions: [{ condition: 'observed payment dates exist', state: 'HOLDS', evidence: ['cash_outcomes:*'] }] },
        { family: 'queuing_theory', purpose: 'backlog', preconditions: [{ condition: 'arrivals are independent', state: 'FAILS', evidence: ['orders batch monthly'] }] },
        { family: 'real_options', purpose: 'defer', preconditions: [{ condition: 'volatility is measurable', state: 'UNKNOWN', evidence: [] }] },
      ],
    });
    expect(s.selected).toEqual(['time_to_event_settlement']);
    expect(s.judgments.map((j) => j.verdict)).toEqual(['FIT', 'UNFIT', 'UNJUDGED']);
    expect(s.judgments.every((j) => j.reasons.length > 0)).toBe(true);
    expect(s.openQuestions).toEqual([{ family: 'real_options', condition: 'volatility is measurable' }]);
  });

  it('accepts a family outside the illustrative list when declared with a reason, refuses it otherwise', () => {
    const s = selectMathematics({
      question: 'q',
      subject: 's',
      candidates: [
        { family: 'auction_theory', purpose: 'bid', declaredReason: 'the buyer runs a sealed-bid tender', preconditions: [{ condition: 'bids are sealed', state: 'HOLDS', evidence: ['tender doc'] }] },
        { family: 'extreme_value_theory', purpose: 'tail', preconditions: [{ condition: 'x', state: 'HOLDS', evidence: ['y'] }] },
      ],
    });
    expect(s.judgments[0]).toMatchObject({ family: 'auction_theory', declared: true, verdict: 'FIT' });
    expect(s.judgments[1]).toMatchObject({ declared: true, verdict: 'REFUSED' });
    expect(s.selected).toEqual(['auction_theory']);
  });

  it('a precondition claimed without evidence is read as unknown', () => {
    const s = selectMathematics({ question: 'q', subject: 's', candidates: [{ family: 'causal_inference', purpose: 'p', preconditions: [{ condition: 'no confounder', state: 'HOLDS', evidence: [] }] }] });
    expect(s.judgments[0]!.verdict).toBe('UNJUDGED');
  });
});

describe('checkDimensions', () => {
  it('passes a formula whose units reconcile and refuses one that does not', () => {
    const units = { price: 'USD/unit', volume: 'unit/month', cost: 'USD/month' };
    const formula = { op: '-' as const, args: [{ op: '*' as const, args: [{ ref: 'price' }, { ref: 'volume' }] }, { ref: 'cost' }] };
    expect(checkDimensions(formula, units, 'USD/month')).toEqual({ ok: true, unit: 'month^-1*USD' });
    const bad = checkDimensions({ op: '+', args: [{ ref: 'price' }, { ref: 'cost' }] }, units, 'USD/month');
    expect(bad.ok).toBe(false);
    const wrongDeclared = checkDimensions(formula, units, 'USD');
    expect(wrongDeclared.ok).toBe(false);
  });
});

describe('buildNumberProvenance', () => {
  it('builds a full record: identity exact on its inputs, alternatives and sensitivity computed', () => {
    const r = buildNumberProvenance(netContribution());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.value).toBe(2500);
    expect(r.record.nature).toBe('EXACT_CONDITIONAL_ON_INPUTS');
    expect(r.record.alternatives[0]).toMatchObject({ label: 'low price', value: 1500 });
    const price = r.record.sensitivity.find((s) => s.input === 'price')!;
    expect(price.change).toBeCloseTo(400);
    expect(r.record.uncertainty.bounds).not.toBeNull();
    expect(r.record.sources.every((s) => s.retrievedAt)).toBe(true);
    expect(validateProvenance(r.record).ok).toBe(true);
  });

  it('carries an unknown input as unknown and never shows a value', () => {
    const base = netContribution();
    const r = buildNumberProvenance({ ...base, inputs: base.inputs.map((i) => (i.key === 'volume' ? { ...i, figure: unknownFigure('units sold', 'unit/month') } : i)) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.value).toBeNull();
    expect(r.record.nature).toBe('UNKNOWN');
    expect(r.record.unknownInputs).toEqual(['volume']);
    expect(r.record.alternatives[0]!.value).toBeNull();
  });

  it('refuses a convenient figure: an assumed input', () => {
    const base = netContribution();
    const assumed = makeFigure({ meaning: 'units sold', unit: 'unit/month', value: 1000, status: 'ASSUMED', source: 'guess' });
    if (!assumed.ok) throw new Error(assumed.reason);
    const r = buildNumberProvenance({ ...base, inputs: base.inputs.map((i) => (i.key === 'volume' ? { ...i, figure: assumed.figure } : i)) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toMatch(/volume/);
  });

  it('refuses a formula whose units do not reconcile', () => {
    const r = buildNumberProvenance(netContribution({ formula: { op: '+', args: [{ ref: 'price' }, { ref: 'cost' }] } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join(' ')).toMatch(/cannot add/);
  });

  it('names every missing field', () => {
    const r = buildNumberProvenance(netContribution({ alternatives: [], applicability: { method: 'x', evidence: [] }, horizon: '' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(expect.arrayContaining(['time horizon', 'alternative parameterizations', 'applicability evidence']));
    const empty = validateProvenance({ sources: [{ input: 'a', ref: 'r', retrievedAt: '' }] } as unknown as NumberProvenance);
    expect(empty.missing).toEqual(expect.arrayContaining(['quantity kind', 'units', 'time horizon', 'retrieval date of "a"', 'formula', 'sensitivity']));
  });

  it('marks a probability uncalibrated unless its bucket is calibrated', () => {
    const p = (bucket: CalibrationBucket | null) =>
      buildNumberProvenance({
        key: 'p-close', quantity: { kind: 'PROBABILITY' }, units: '1', horizon: '30 days',
        formula: { op: '/', args: [{ ref: 'won' }, { ref: 'tried' }] },
        inputs: [{ key: 'won', figure: fig('won', 'deal', 6), source: src }, { key: 'tried', figure: fig('tried', 'deal', 20), source: src }],
        alternatives: [{ label: 'prior', parameters: { won: 4 } }],
        applicability: { method: 'statistical_estimation_calibration', evidence: ['same buyer class'] },
        form: 'PROBABILITY', calibration: bucket,
      });
    const a = p(null);
    expect(a.ok && a.record.nature).toBe('UNCALIBRATED_PROBABILITY');
    const b = p({ comparableKey: 'k', windowStart: null, windowEnd: null, scope: 'POOLED', n: 30, meanForecast: 0.3, observedRate: 0.3, gap: 0, zScore: 0, verdict: 'CALIBRATED' });
    expect(b.ok && b.record.nature).toBe('CALIBRATED_PROBABILITY');
  });
});

describe('forecastBias', () => {
  const pred = (i: number, probability: number | null, outcome = 'win'): PredictionRow => ({
    id: `c${i}@v1`, claimId: `c${i}`, version: 1, outcome, horizonDays: 30, population: 'p', data: ['d'], assumptions: [],
    probability, comparableKey: 'k', madeAt: '2026-10-01T00:00:00Z',
  });

  it('proposes a correction when probability bias exceeds the calibration band', () => {
    const preds = Array.from({ length: 40 }, (_, i) => pred(i, 0.8));
    const outs: OutcomeRow[] = preds.map((p, i) => ({ predictionId: p.id, observedAt: '2026-10-20T00:00:00Z', occurred: i < 10 }));
    const [b] = forecastBias(preds, [], outs);
    expect(b).toMatchObject({ basis: 'PROBABILITY', verdict: 'SYSTEMATIC' });
    expect(b!.correction?.kind).toBe('SHIFT_PROBABILITY');
    expect(b!.correction!.amount).toBeCloseTo(-0.55);
  });

  it('a calibrated bucket proposes nothing; a thin one is insufficient', () => {
    const preds = Array.from({ length: 40 }, (_, i) => pred(i, 0.5));
    const outs: OutcomeRow[] = preds.map((p, i) => ({ predictionId: p.id, observedAt: '2026-10-20T00:00:00Z', occurred: i % 2 === 0 }));
    expect(forecastBias(preds, [], outs)[0]).toMatchObject({ verdict: 'WITHIN_BAND', correction: null });
    expect(forecastBias(preds.slice(0, 3), [], outs.slice(0, 3))[0]!.verdict).toBe('INSUFFICIENT');
  });

  it('scales a figure forecast whose realized results run systematically low', () => {
    const preds = Array.from({ length: 25 }, (_, i) => pred(i, null, 'cash per deal (range 900..1100)'));
    const outs: OutcomeRow[] = preds.map((p, i) => ({ predictionId: p.id, observedAt: '2026-10-20T00:00:00Z', occurred: false, realized: 700 + (i % 5) * 10, evidence: `cash_outcomes:${i}` }));
    const fig = forecastBias(preds, [], outs).find((b) => b.basis === 'FIGURE')!;
    expect(fig.verdict).toBe('SYSTEMATIC');
    expect(fig.correction?.kind).toBe('SCALE_FIGURE');
    expect(fig.correction!.amount).toBeCloseTo(0.72);
  });
});

describe('records go through the existing append-only writer', () => {
  it('writes a validated provenance and a selection; refuses an invalid record', async () => {
    const written: { eventType: string }[] = [];
    const record = async (e: { eventType: string }) => { written.push(e); };
    const r = buildNumberProvenance(netContribution());
    if (!r.ok) throw new Error('expected ok');
    await recordNumberProvenance(r.record, { record: record as never, projectId: 'prj_x' });
    await recordMathSelection(selectMathematics({ question: 'q', subject: 's', candidates: [] }), { record: record as never });
    expect(written.map((w) => w.eventType)).toEqual(['NUMBER_PROVENANCE', 'MATH_METHOD_SELECTION']);
    await expect(recordNumberProvenance({ ...r.record, horizon: '' }, { record: record as never })).rejects.toThrow(/time horizon/);
  });
});
