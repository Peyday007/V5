import { describe, expect, it } from 'vitest';
import { learnFromCashLedger } from '../server/services/quant/knowledge.ts';
import { assessModelLearning } from '../server/services/quant/learning.ts';
import { observedCausesOf } from '../server/services/quant/ledger.ts';
import { MIN_CALIBRATION_SAMPLE, type OutcomeRow, type PredictionRow } from '../server/services/quant/forecast.ts';

/*
 * FORECAST:CAPACITY, production 2026-11-19: nine operator decisions
 * (`operator/decisions.ts`: claim `operator:opd_*`, comparable key
 * `operator:<kind>`) missed with the capacity-shortfall signal `verify` takes,
 * and were registered as `FORECAST:CAPACITY` — the cash forecast's key, owned
 * by `server/services/cash/forecast.ts`, which no change there can correct.
 *
 * The cause is a commercial-operations one (CAPACITY), so the routing is the
 * branch that reaches the register only when no goal plan rests on the claims:
 * the one the recorded candidate came through ("no goal plan rests on them to
 * carry the correction"). It must be keyed, titled and owned as the operator's.
 */

const DAY = 86_400_000;
const at = (d: number) => new Date(Date.UTC(2026, 0, 1) + d * DAY).toISOString();

/** A committed operator decision, as `decide` records it. */
const decision = (i: number): PredictionRow => ({
  id: `operator:opd_${String(i).padStart(16, '0')}@v1`,
  claimId: `operator:opd_${String(i).padStart(16, '0')}`,
  version: 1,
  outcome: 'the commissioned bin is taken by a worker within the horizon',
  horizonDays: 1,
  population: 'operator decisions of kind COMMISSION',
  data: ['dfx_example'],
  assumptions: ['a worker is free to take it'],
  probability: 0.8,
  comparableKey: 'operator:COMMISSION',
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

/**
 * Verified as `verify` records it — through the ledger's own `observedCausesOf`,
 * with `capacityShortfall` set — so the cause is the one production observed,
 * not one this test names. One hit in five against a stated 80%.
 */
const verified = (p: PredictionRow, i: number): OutcomeRow => {
  const occurred = i % 5 === 0;
  const causes = occurred ? [] : observedCausesOf(p, { capacityShortfall: true });
  return { predictionId: p.id, observedAt: at(i + 0.5), occurred, ...(causes.length ? { observedCauses: causes } : {}) };
};

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

/**
 * The register as production holds it after the misrouting: one live `FORECAST:CAPACITY` row, owned by
 * `cash/forecast.ts`, naming the given claims. Records every decision and event made against it.
 */
type Registry = ReturnType<typeof registry>;
function registry(legacy: { samples: string[]; campaignId?: string | null; decision?: string | null }) {
  const decisions: { id: string; decision: string; reason: string; into: unknown }[] = [];
  const events: { candidateId: string | null; kind: string; detail?: Record<string, unknown> }[] = [];
  const row = {
    id: 'imp_legacy',
    weaknessKey: 'FORECAST:CAPACITY',
    ownerComponent: 'server/services/cash/forecast.ts',
    evidence: { samples: legacy.samples },
    decision: legacy.decision ?? null,
    changeRequestId: null,
    campaignId: legacy.campaignId ?? null,
  };
  const deps = {
    get: (async (key: string) => (key === row.weaknessKey ? row : null)) as never,
    decide: (async (id: string, decision: string, reason: string, extra: { combinedIntoId?: string | null } = {}) => {
      decisions.push({ id, decision, reason, into: extra.combinedIntoId });
      return true;
    }) as never,
    event: (async (e: { candidateId: string | null; kind: string; detail?: Record<string, unknown> }) => {
      events.push(e);
    }) as never,
  };
  return { deps, decisions, events };
}

const operatorClaims = Array.from({ length: 9 }, (_, i) => `operator:opd_${String(i + 1).padStart(16, '0')}`);

type Candidate = { weaknessKey: string; title: string; ownerComponent: string; problem: string; evidence: Record<string, unknown> };

/** Run the learning pass with no goal resting on any claim, capturing what reaches the register. */
async function register(rows: ReturnType<typeof ledger>, registry?: Registry) {
  const out: Candidate[] = [];
  const needs: unknown[] = [];
  await learnFromCashLedger('p', ['USD'], {
    read: async () => rows,
    goals: async () => [],
    routed: async () => false,
    replan: async () => {},
    openings: async () => [],
    note: (async () => {}) as never,
    raise: (async (n: unknown) => {
      needs.push(n);
      return { ok: true, value: { id: `need_${needs.length}` } };
    }) as never,
    toFactory: (async (c: Candidate) => {
      out.push(c);
      return { candidate: registry ? { id: `imp_${c.weaknessKey}`, weaknessKey: c.weaknessKey } : {}, created: true };
    }) as never,
    ...(registry ? { register: registry.deps } : {}),
  });
  return { candidates: out, needs };
}

describe('a CAPACITY miss on the operator\'s decisions is the operator\'s correction, never the cash forecast\'s', () => {
  it('reproduces the failure class: operator capacity misses are a systematic CAPACITY correction for commercial operations', () => {
    const reading = assessModelLearning(ledger({ operator: true, cash: false }));
    expect(reading.calibration.some((b) => b.comparableKey === 'operator:COMMISSION' && b.verdict === 'MISCALIBRATED')).toBe(true);
    const capacity = reading.corrections.find((c) => c.cause === 'CAPACITY');
    expect(capacity).toMatchObject({ cause: 'CAPACITY', owner: 'COMMERCIAL_OPERATIONS' });
    expect(capacity!.claimIds.length).toBeGreaterThan(0);
    expect(capacity!.claimIds.every((c) => c.startsWith('operator:opd_'))).toBe(true);
  });

  it('registers FORECAST:operator:CAPACITY owned by operator/decisions.ts, and never FORECAST:CAPACITY on cash/forecast.ts', async () => {
    const { candidates, needs } = await register(ledger({ operator: true, cash: false }));
    const keys = candidates.map((c) => c.weaknessKey);
    expect(keys).not.toContain('FORECAST:CAPACITY');
    const capacity = candidates.filter((c) => c.weaknessKey.endsWith('CAPACITY'));
    expect(capacity.map((c) => c.weaknessKey)).toEqual(['FORECAST:operator:CAPACITY']);
    const [c] = capacity;
    expect(c!.ownerComponent).toBe('server/services/operator/decisions.ts');
    expect(c!.ownerComponent).not.toBe('server/services/cash/forecast.ts');
    expect(c!.title).not.toMatch(/cash forecast/i);
    expect(c!.title).toMatch(/operator's decision forecasts/);
    expect(c!.title).toMatch(/capacity \(commercial operations\)/);
    expect(c!.problem).toMatch(/no goal plan rests on them/);
    expect(c!.evidence['mutationScope']).not.toContain('server/services/cash/forecast.ts');
    expect(c!.evidence['mutationScope']).toContain('server/services/operator/decisions.ts');
    expect(c!.evidence['correctionOwner']).toBe('COMMERCIAL_OPERATIONS');
    // The operation's own need names the operator's forecasts too, never the cash forecast.
    expect(JSON.stringify(needs)).not.toMatch(/cash forecast/i);
  });

  it("positive control: the cash forecast's own CAPACITY miss keeps FORECAST:CAPACITY on cash/forecast.ts", async () => {
    const { candidates } = await register(ledger({ operator: false, cash: true }));
    const capacity = candidates.filter((c) => c.weaknessKey.endsWith('CAPACITY'));
    expect(capacity.map((c) => c.weaknessKey)).toEqual(['FORECAST:CAPACITY']);
    expect(capacity[0]!.ownerComponent).toBe('server/services/cash/forecast.ts');
    expect(capacity[0]!.title).toMatch(/^The cash forecast is systematically miscalibrated/);
  });

  it('a CAPACITY cause spanning both families yields one candidate per family, each naming only its own claims', async () => {
    const { candidates } = await register(ledger({ operator: true, cash: true }));
    const capacity = candidates.filter((c) => c.weaknessKey.endsWith('CAPACITY'));
    expect(capacity.map((c) => c.weaknessKey).sort()).toEqual(['FORECAST:CAPACITY', 'FORECAST:operator:CAPACITY']);
    const cash = capacity.find((c) => c.weaknessKey === 'FORECAST:CAPACITY')!;
    const operator = capacity.find((c) => c.weaknessKey === 'FORECAST:operator:CAPACITY')!;
    expect(cash.problem).not.toMatch(/operator:/);
    expect(operator.problem).not.toMatch(/cash:/);
    expect(cash.ownerComponent).toBe('server/services/cash/forecast.ts');
    expect(operator.ownerComponent).toBe('server/services/operator/decisions.ts');
  });

  describe('the FORECAST:CAPACITY row production already registered on the operator\'s misses', () => {
    it('is COMBINED into FORECAST:operator:CAPACITY when every claim it names is the operator\'s and nothing engineers it yet', async () => {
      const reg = registry({ samples: operatorClaims });
      await register(ledger({ operator: true, cash: false }), reg);
      expect(reg.decisions).toEqual([
        { id: 'imp_legacy', decision: 'COMBINED', reason: expect.stringMatching(/FORECAST:operator:CAPACITY.*operator\/decisions\.ts/), into: 'imp_FORECAST:operator:CAPACITY' },
      ]);
      expect(reg.events).toEqual([{ candidateId: 'imp_legacy', kind: 'COMBINED', detail: { into: 'imp_FORECAST:operator:CAPACITY', reason: 'MISROUTED_FAMILY', family: 'operator' } }]);
    });

    it('is left alone when it names a cash claim: then it is the cash forecast\'s own', async () => {
      const reg = registry({ samples: [...operatorClaims, 'cash:p:USD:revenue'] });
      await register(ledger({ operator: true, cash: false }), reg);
      expect(reg.decisions).toEqual([]);
    });

    it('is left alone when a campaign already carries it: that work ends it through its own measured decision', async () => {
      const reg = registry({ samples: operatorClaims, campaignId: 'fcp_in_flight' });
      await register(ledger({ operator: true, cash: false }), reg);
      expect(reg.decisions).toEqual([]);
    });

    it('is never decided again once decided', async () => {
      const reg = registry({ samples: operatorClaims, decision: 'KEPT' });
      await register(ledger({ operator: true, cash: false }), reg);
      expect(reg.decisions).toEqual([]);
    });

    it("is never touched by the cash forecast's own CAPACITY correction", async () => {
      const reg = registry({ samples: operatorClaims });
      await register(ledger({ operator: false, cash: true }), reg);
      expect(reg.decisions).toEqual([]);
    });
  });
});
