import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  assessLedger,
  ledgerFromRows,
  observedCausesOf,
  predictionIdOf,
  readLedger,
  recordExposure,
  recordOutcome,
  recordPrediction,
} from '../server/services/quant/ledger.ts';
import type { PredictionRow } from '../server/services/quant/forecast.ts';

const claim = (claimId: string, over: Partial<Parameters<typeof recordPrediction>[0]> = {}) => ({
  claimId,
  outcome: 'sale closes',
  horizonDays: 30,
  population: 'qualified buyers',
  data: ['crm export'],
  assumptions: ['reply rate holds'],
  probability: 0.9,
  comparableKey: 'k',
  ...over,
});

describe('the prediction, exposure and outcome ledgers have a writer and a reader', () => {
  it('is reachable from quant/export.ts, which production imports', () => {
    expect(readFileSync('server/services/quant/export.ts', 'utf8')).toContain('./ledger.ts');
  });

  it('writes versioned predictions that supersede without editing, and reads them back', async () => {
    await freshProject();
    const v1 = await recordPrediction(claim('c1'));
    const v2 = await recordPrediction(claim('c1', { probability: 0.6 }));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.id).toBe(predictionIdOf('c1', 2));
    const { predictions } = await readLedger();
    expect(predictions.map((p) => [p.id, p.probability])).toEqual([['c1@v1', 0.9], ['c1@v2', 0.6]]);
    const rows = await getDb().all<{ event_type: string; evidence_class: string }>(
      `SELECT event_type, evidence_class FROM bin_events WHERE event_type = 'FORECAST_PREDICTION'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.evidence_class === 'MEASURED')).toBe(true);
  });

  it('refuses a probability outside 0..1', async () => {
    await expect(recordPrediction(claim('bad', { probability: 1.5 }), { read: async () => ({ predictions: [], exposures: [], outcomes: [] }), record: async () => undefined })).rejects.toThrow(/between 0 and 1/);
  });

  it('records exposure with an unstated figure as null, not zero', async () => {
    await freshProject();
    const p = await recordPrediction(claim('c2'));
    await recordExposure(p.id, null);
    const { exposures } = await readLedger();
    expect(exposures[0]).toMatchObject({ predictionId: p.id, atRiskCents: null });
  });

  it('records an outcome once, against an existing version, and never overwrites it', async () => {
    await freshProject();
    const p = await recordPrediction(claim('c3'));
    await expect(recordOutcome('nope@v1', true)).rejects.toThrow(/no prediction/);
    await recordOutcome(p.id, false);
    await expect(recordOutcome(p.id, true)).rejects.toThrow(/already recorded/);
    const { outcomes } = await readLedger();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.occurred).toBe(false);
  });

  it('a row that does not parse is skipped, and the first outcome for a version stands', () => {
    const o = (occurred: boolean) => ({ measures: JSON.stringify({ ledger: 'OUTCOME', row: { predictionId: 'x@v1', observedAt: 't', occurred } }) });
    const out = ledgerFromRows([{ measures: '{not json' }, { measures: null }, o(true), o(false)]);
    expect(out.outcomes).toHaveLength(1);
    expect(out.outcomes[0]?.occurred).toBe(true);
  });
});

describe('observedCauses has a producer, from measurements and the claim itself', () => {
  const base: PredictionRow = { id: 'a@v1', claimId: 'a', version: 1, outcome: 'o', horizonDays: 30, population: 'p', data: ['d'], assumptions: ['x'], probability: 0.9, comparableKey: 'k', madeAt: 't' };

  it('names no cause from the miss alone', () => {
    expect(observedCausesOf(base)).toEqual([]);
    expect(observedCausesOf(base, { lateByDays: 0 })).toEqual([]);
  });

  it('maps each measured signal to its cause class', () => {
    expect(observedCausesOf(base, { lateByDays: 3, capacityShortfall: true, assumptionBroke: true, calculationDisagrees: true, dataFromOtherPopulation: true, selectedSample: true, executionDeviated: true, mechanismMissing: true }).sort()).toEqual(
      ['CAPACITY', 'CHANGED_CONDITIONS', 'EXECUTION_BEHAVIOR', 'EXTERNAL_DATA_TRANSFER', 'MISSING_MECHANISM', 'MODEL_IMPLEMENTATION', 'SELECTION_BIAS', 'TIMING'].sort(),
    );
  });

  it('a claim that names no data is itself evidence-quality', () => {
    expect(observedCausesOf({ ...base, data: [] })).toEqual(['EVIDENCE_QUALITY']);
  });
});

describe('a systematic miss reaches an owner from recorded rows alone', () => {
  it('records 30 comparable claims, a miscalibrated bucket, and the correction the ledger itself supports', async () => {
    await freshProject();
    for (let i = 0; i < 30; i++) {
      const p = await recordPrediction(claim(`m${i}`, { comparableKey: 'bad' }));
      await recordExposure(p.id, 100);
      const hit = i % 10 < 3; // forecast 90%, about 30% occur
      await recordOutcome(p.id, hit, hit ? {} : { capacityShortfall: true });
    }
    const reading = await assessLedger();
    expect(reading.ledger).toHaveLength(30);
    expect(reading.diagnoses.some((d) => d.kind === 'SYSTEMATIC')).toBe(true);
    expect(reading.corrections[0]).toMatchObject({ cause: 'CAPACITY', owner: 'COMMERCIAL_OPERATIONS' });
  });

  it('one isolated miss is unjudged, never called a model failure', async () => {
    await freshProject();
    const p = await recordPrediction(claim('solo'));
    await recordOutcome(p.id, false, { capacityShortfall: true });
    const reading = await assessLedger();
    expect(reading.diagnoses[0]?.kind).toBe('UNJUDGED');
    expect(reading.corrections).toEqual([]);
  });
});

describe('the cash forecast is the ledger\'s producer', () => {
  it('quant/ledger.ts calls cash/forecast.ts and records its figures', async () => {
    expect(readFileSync('server/services/quant/ledger.ts', 'utf8')).toContain("../cash/forecast.ts");
    const { recordCashForecast } = await import('../server/services/quant/ledger.ts');
    const est = (v: number | null) => ({ valueCents: v, lowCents: v, highCents: v, fromRows: v === null ? 0 : 2, confidence: 'SEVERAL_ROWS' as const, basis: 'prices', unknown: [], blocking: '' });
    const dur = { days: 14, lowDays: 7, highDays: 21, fromRows: 2, confidence: 'SEVERAL_ROWS' as const, basis: 'b', unknown: [], blocking: '' };
    const rows: unknown[] = [];
    const deps = { record: (async (e: { measures: unknown }) => { rows.push(e.measures); }) as never, read: async () => ({ predictions: [], exposures: [], outcomes: [] }) };
    const written = await recordCashForecast('prj', {
      currency: 'USD', qualified: 2, considered: 3, upfrontCash: est(null), ongoingCosts: est(null),
      revenue: est(5000), contribution: est(null), timeToFirstDollar: dur, breakEven: dur,
      humanHours: { total: null, fromRows: 0, unknown: [] },
    }, deps);
    expect(written.map((w) => w.claimId)).toEqual(['cash:prj:USD:revenue']);
    expect(written[0]?.horizonDays).toBe(14);
    expect(rows).toHaveLength(1);
  });
});
