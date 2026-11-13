import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assessModelLearning } from '../server/services/quant/export.ts';
import type { PredictionRow, ExposureRow, OutcomeRow } from '../server/services/quant/forecast.ts';

const pred = (i: number, key: string, p: number): PredictionRow => ({
  id: `p${key}${i}`, claimId: `c${key}${i}`, version: 1, outcome: 'sale', horizonDays: 30, population: 'x',
  data: ['d'], assumptions: ['a'], probability: p, comparableKey: key, madeAt: '2026-01-01T00:00:00Z',
});

describe('model learning is reachable and judges calibration', () => {
  it('is reachable from quant/export.ts, which production imports', () => {
    expect(readFileSync('server/services/quant/export.ts', 'utf8')).toContain("./learning.ts");
    expect(readFileSync('server/services/quant/learning.ts', 'utf8')).toContain("./forecast.ts");
  });
  it('calls a miscalibrated bucket systematic and a calibrated one an expected miss', () => {
    const predictions: PredictionRow[] = [];
    const exposures: ExposureRow[] = [];
    const outcomes: OutcomeRow[] = [];
    for (let i = 0; i < 30; i++) {
      // bad: forecast 90%, only 30% occur. good: forecast 90%, 90% occur.
      for (const [key, hit] of [['bad', i % 10 < 3], ['good', i % 10 !== 0]] as const) {
        const p = pred(i, key, 0.9);
        predictions.push(p);
        exposures.push({ predictionId: p.id, exposedAt: '2026-01-02T00:00:00Z', atRiskCents: 100 });
        outcomes.push({ predictionId: p.id, observedAt: '2026-02-01T00:00:00Z', occurred: hit, observedCauses: hit ? undefined : ['PARAMETER_ESTIMATE'] });
      }
    }
    const r = assessModelLearning({ predictions, exposures, outcomes });
    const bad = r.diagnoses.find((d) => d.predictionId.startsWith('pbad') && d.contradicted)!;
    const good = r.diagnoses.find((d) => d.predictionId.startsWith('pgood') && d.contradicted)!;
    expect(bad.kind).toBe('SYSTEMATIC');
    expect(good.kind).toBe('EXPECTED_MISS');
    expect(r.corrections[0]?.cause).toBe('PARAMETER_ESTIMATE');
  });
  it('one isolated miss is unjudged, not a model failure', () => {
    const p = pred(1, 'solo', 0.9);
    const r = assessModelLearning({ predictions: [p], exposures: [], outcomes: [{ predictionId: p.id, observedAt: '2026-02-01T00:00:00Z', occurred: false }] });
    expect(r.diagnoses[0]?.kind).toBe('UNJUDGED');
  });
});
