import { describe, expect, it } from 'vitest';
import { claimFamily, correctionsByFamily, forecastSubject, learnFromCashLedger, openCorrectionWork } from '../server/services/quant/knowledge.ts';
import { assessModelLearning } from '../server/services/quant/learning.ts';
import { MIN_CALIBRATION_SAMPLE, type Correction, type OutcomeRow, type PredictionRow } from '../server/services/quant/forecast.ts';

/*
 * FORECAST:MISSING_MECHANISM, production 2026-11-19: the project ledger holds
 * the operator's decisions (`operator/decisions.ts`: claim `operator:opd_*`,
 * comparable key `operator:<kind>`, MISSING_MECHANISM from the verify signal)
 * beside the cash forecast. Twelve operator misses were registered as "the
 * cash forecast is systematically miscalibrated", owned by
 * `server/services/cash/forecast.ts`, which no change there can correct. Each
 * claim family is now corrected as itself.
 */

const DAY = 86_400_000;
const at = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY).toISOString();

/** A committed operator decision, as `decide` records it. */
const decision = (i: number): PredictionRow => ({
  id: `pred_op_${i}`,
  claimId: `operator:opd_${String(i).padStart(16, '0')}`,
  version: 1,
  outcome: 'the goal produces a research report within the horizon',
  horizonDays: 2,
  population: 'operator decisions of kind PRIORITIZE_RESEARCH',
  data: ['dfx_example'],
  assumptions: ['research rounds complete'],
  probability: 0.8,
  comparableKey: 'operator:PRIORITIZE_RESEARCH',
  madeAt: at(i),
});

/** A cash claim version with a stated probability, so it is judged in its own bucket. */
const cashVersion = (i: number): PredictionRow => ({
  id: `cash:p:USD:revenue@v${i}`,
  claimId: 'cash:p:USD:revenue',
  version: i,
  outcome: 'revenue of 9000 USD cents',
  horizonDays: 30,
  population: '9 qualified of 11 opportunities in USD',
  data: ['The prices stated on qualified opportunities.'],
  assumptions: ['derived from 9 opportunity row(s)'],
  probability: 0.8,
  comparableKey: 'cash:USD:revenue',
  madeAt: at(i),
});

/** Verified the way `verify` records it: missed, with the mechanism-missing signal. 1 hit in 5 against 80%. */
const verified = (p: PredictionRow, i: number): OutcomeRow => ({
  predictionId: p.id,
  observedAt: at(i + 0.5),
  occurred: i % 5 === 0,
  ...(i % 5 === 0 ? {} : { observedCauses: ['MISSING_MECHANISM' as const] }),
});

function ledger(opts: { operator: boolean; cash: boolean }) {
  const predictions: PredictionRow[] = [];
  const outcomes: OutcomeRow[] = [];
  for (let i = 1; i <= Math.max(MIN_CALIBRATION_SAMPLE, 20); i++) {
    for (const p of [...(opts.operator ? [decision(i)] : []), ...(opts.cash ? [cashVersion(i)] : [])]) {
      predictions.push(p);
      outcomes.push(verified(p, i));
    }
  }
  return { predictions, exposures: [], outcomes };
}

type Candidate = { weaknessKey: string; title: string; ownerComponent: string; problem: string; evidence: Record<string, unknown> };

async function register(rows: ReturnType<typeof ledger>) {
  const out: Candidate[] = [];
  const needs: unknown[] = [];
  await learnFromCashLedger('p', ['USD'], {
    read: async () => rows,
    goals: async () => [],
    note: async () => {
      throw new Error('no goal rests on these claims');
    },
    raise: (async (n: unknown) => {
      needs.push(n);
      return { ok: true, value: { id: 'need' } };
    }) as never,
    toFactory: (async (c: Candidate) => {
      out.push(c);
      return { candidate: {}, created: true };
    }) as never,
  });
  return { candidates: out, needs };
}

describe('a systematic miss is corrected under the claim family it was made on', () => {
  it('reproduces the failure class: operator misses are a systematic MISSING_MECHANISM correction', () => {
    const reading = assessModelLearning(ledger({ operator: true, cash: false }));
    expect(reading.calibration.some((b) => b.comparableKey === 'operator:PRIORITIZE_RESEARCH' && b.verdict === 'MISCALIBRATED')).toBe(true);
    expect(reading.corrections[0]).toMatchObject({ cause: 'MISSING_MECHANISM', owner: 'RESEARCH' });
    expect(reading.corrections[0]!.claimIds.every((c) => c.startsWith('operator:opd_'))).toBe(true);
  });

  it('operator misses are never registered as a cash-forecast defect', async () => {
    const { candidates, needs } = await register(ledger({ operator: true, cash: false }));
    expect(candidates.map((c) => c.weaknessKey)).toEqual(['FORECAST:operator:MISSING_MECHANISM']);
    const [c] = candidates;
    expect(c!.ownerComponent).toBe('server/services/operator/decisions.ts');
    expect(c!.title).not.toMatch(/cash forecast/i);
    expect(c!.title).toMatch(/operator's decision forecasts/);
    expect(c!.evidence['mutationScope']).not.toContain('server/services/cash/forecast.ts');
    expect(c!.evidence['correctionOwner']).toBe('RESEARCH');
    // No cash-forecast need is opened for claims the cash forecast never made.
    expect(JSON.stringify(needs)).not.toMatch(/cash forecast/i);
  });

  it('the cash forecast keeps its own routing unchanged', async () => {
    const { candidates } = await register(ledger({ operator: false, cash: true }));
    expect(candidates.map((c) => c.weaknessKey)).toEqual(['FORECAST:MISSING_MECHANISM']);
    expect(candidates[0]!.ownerComponent).toBe('server/services/cash/forecast.ts');
    expect(candidates[0]!.title).toMatch(/^The cash forecast is systematically miscalibrated/);
  });

  it('one cause spanning both families is split into one correction per family, each counting its own misses', async () => {
    const rows = ledger({ operator: true, cash: true });
    const reading = assessModelLearning(rows);
    const split = correctionsByFamily(reading.corrections, reading.diagnoses).filter((c) => c.cause === 'MISSING_MECHANISM');
    expect(split.map((c) => c.family).sort()).toEqual(['cash', 'operator']);
    const total = reading.corrections.find((c) => c.cause === 'MISSING_MECHANISM')!.misses;
    expect(split.reduce((s, c) => s + c.misses, 0)).toBe(total);
    const { candidates } = await register(rows);
    const keys = candidates.map((c) => c.weaknessKey);
    expect(keys).toContain('FORECAST:MISSING_MECHANISM');
    expect(keys).toContain('FORECAST:operator:MISSING_MECHANISM');
    const cash = candidates.find((c) => c.weaknessKey === 'FORECAST:MISSING_MECHANISM')!;
    expect(cash.problem).not.toMatch(/operator:/);
  });

  it('names claim families', () => {
    expect(claimFamily('cash:prj_1:USD:revenue')).toBe('cash');
    expect(claimFamily('operator:opd_abc')).toBe('operator');
    expect(claimFamily('x7')).toBe('x7');
  });

  it("a correction's own text names the forecast it was made on, never the cash forecast for another family", async () => {
    const opened = async (correction: Correction) => {
      const needs: { blockedAction: string }[] = [];
      await openCorrectionWork('p', correction, '', {
        openings: async () => [],
        raise: (async (n: { blockedAction: string }) => {
          needs.push(n);
          return { ok: true, value: { id: 'need' } };
        }) as never,
      });
      return needs.map((n) => n.blockedAction);
    };
    const operator = await opened({ cause: 'MISSING_MECHANISM', owner: 'RESEARCH', claimIds: ['operator:opd_1', 'operator:opd_2'], misses: 12 });
    expect(operator).toEqual(["Correct the missing mechanism in the operator's decision forecasts (research)"]);
    // The cash forecast's own need reads exactly as it did.
    const cash = await opened({ cause: 'MISSING_MECHANISM', owner: 'COMMERCIAL_OPERATIONS', claimIds: ['cash:p:USD:revenue'], misses: 3 });
    expect(cash).toEqual(["Correct the cash forecast's missing mechanism (commercial operations)"]);

    // The goal-record summaries take their subject from the same place.
    expect(forecastSubject(['operator:opd_1'])).toEqual({ subject: "The operator's decision forecasts", noun: "the operator's decision forecasts", cash: false });
    expect(forecastSubject(['cash:p:USD:revenue'])).toEqual({ subject: 'The cash forecast', noun: 'the cash forecast', cash: true });
    expect(forecastSubject(['x7:a']).subject).toBe('The x7 forecasts on the ledger');
    expect(forecastSubject(['cash:p:USD:revenue', 'operator:opd_1']).subject).not.toMatch(/cash/);
  });
});
