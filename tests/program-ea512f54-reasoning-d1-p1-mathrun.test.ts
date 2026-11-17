/**
 * Repair F4: per-question mathematics, per-number provenance and forecast-vs-
 * realized correction have a production consumer — the sprint run — and cover
 * every material opening's numbers, not one synthetic price on five rows.
 */
import { describe, expect, it } from 'vitest';
import { acquireKnowledge, type KnowledgeSourceClaim } from '../server/services/research/knowledgeModel.ts';
import type { MathSelection, NumberProvenance } from '../server/services/quant/mathToolkit.ts';
import {
  BASELINE_METHOD,
  DEMONSTRATED_PER_RUN,
  GENERAL_METHOD,
  mathQuestionOf,
  runSprintBenchmark,
  sprintForecastLedger,
  type SprintDeps,
  type SprintProblem,
} from '../server/services/improvement/sprint.ts';

const NOW = new Date('2026-11-16T00:00:00.000Z');

let seq = 0;
const problem = (over: Partial<SprintProblem> = {}): SprintProblem => {
  seq += 1;
  const id = `opp_m${String(seq).padStart(4, '0')}`;
  return {
    id,
    projectId: 'prj_m',
    title: `opening ${seq}`,
    mechanism: 'RESALE',
    industry: 'equipment',
    source: 'https://example.test/listing',
    sourceClaimId: `clm_${id}`,
    payer: 'Acme',
    reachableChannel: 'email',
    buyingSignal: 'posted RFQ',
    acceptanceCondition: 'delivered and inspected',
    priceCents: 120000,
    currency: 'USD',
    paymentTerms: 'net 15',
    fulfillmentOwner: 'supplier',
    deadline: null,
    humanHours: 1,
    state: 'READY',
    createdAt: `2026-10-${String((seq % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
};

const claim = (id: string): KnowledgeSourceClaim => ({
  id,
  claim: `${id.replace(/[^a-z0-9]/gi, '')}-request`,
  claimType: 'SOURCED_FACT',
  sourceUrl: `https://example.org/${id}`,
  sourceTitle: `Source ${id}`,
  sourcePublisher: 'Example Publisher',
  sourceDate: '2026-10-01',
  retrievedAt: '2026-11-01T10:00:00Z',
  retrievalState: 'RETRIEVED',
  evidenceLane: null,
  geography: null,
  timeframe: null,
  population: null,
  definition: null,
  contradictionState: 'UNCHALLENGED',
  contradictionNote: null,
  contradictionKind: null,
  reconciliation: null,
  reconciledClaimId: null,
  accepted: true,
  sourced: true,
  primarySource: true,
  structuralFinding: null,
  laborFinding: null,
  createdAt: '2026-11-01T10:00:00Z',
});

function harness(ps: SprintProblem[], over: Partial<SprintDeps> = {}) {
  const selections: MathSelection[] = [];
  const provenance: NumberProvenance[] = [];
  const knowledge = acquireKnowledge({ subject: 'prj_m', claims: ps.map((p) => claim(p.sourceClaimId!)), now: NOW });
  const deps: SprintDeps = {
    read: async () => ps,
    previous: async () => null,
    record: async () => {},
    recordDecision: async () => {},
    recordSelection: async (s) => {
      selections.push(s);
    },
    recordProvenance: async (p) => {
      provenance.push(p);
    },
    priorForecasts: async () => [],
    registerDirected: async () => ({ candidate: { id: 'imc_x' } }),
    learning: async () => ({ catalogue: [], outcomes: [], procedures: [] }),
    history: async () => new Map(),
    recordResult: async () => {},
    recordProcedure: async () => {},
    sendNeeds: (async () => []) as never,
    knowledge: async () => knowledge,
    now: () => NOW,
    ...over,
  };
  return { deps, selections, provenance };
}

describe('the sprint run is a production consumer of per-question mathematics and per-number provenance', () => {
  it('judges and records the mathematics of every material opening, far beyond the five demonstrated ones', async () => {
    const ps = [...Array.from({ length: 30 }, () => problem()), ...Array.from({ length: 10 }, () => problem({ state: 'DISCOVERED', payer: null, priceCents: null }))];
    const { deps, selections, provenance } = harness(ps);
    const run = await runSprintBenchmark(deps);
    expect(run.math.material).toBeGreaterThan(DEMONSTRATED_PER_RUN);
    expect(run.math.selections).toBe(run.math.material);
    expect(selections).toHaveLength(run.math.material);
    // Every actionable opening's question is judged, and an opening with a sourced price selects the cash-flow identity.
    const ready = ps.filter((p) => p.state === 'READY').map((p) => `cash_opportunities:${p.id}`);
    expect(ready.every((s) => selections.some((sel) => sel.subject === s))).toBe(true);
    expect(selections.find((s) => s.subject === ready[0])?.selected).toContain('cash_flow_identities');
    // Gross billed and BOTH methods' probabilities are recorded with provenance — the baseline's fixed 0.6 included.
    const keys = provenance.map((p) => p.key);
    expect(keys).toContain(`gross-billed:${ps[0]!.id}`);
    expect(keys).toContain(`p-actionable:${GENERAL_METHOD.key}:${ps[0]!.id}`);
    expect(keys).toContain(`p-actionable:${BASELINE_METHOD.key}:${ps[0]!.id}`);
    const baseline = provenance.find((p) => p.key === `p-actionable:${BASELINE_METHOD.key}:${ps[0]!.id}`)!;
    expect(baseline.value).toBe(0.6);
    expect(baseline.quantity.kind).toBe('PROBABILITY');
    expect(baseline.alternatives.length).toBeGreaterThan(0);
    expect(run.math.provenanceRecorded).toBe(provenance.length);
  });

  it('a price with no source is not selected for the identity and is never recorded as gross billed', () => {
    const p = problem({ source: null, sourceClaimId: null });
    const q = mathQuestionOf(p, 0);
    const identity = q.candidates.find((c) => c.family === 'cash_flow_identities')!;
    expect(identity.preconditions.some((c) => c.state === 'FAILS')).toBe(true);
  });

  it('compares earlier forecasts with what production did, and corrects a systematic error in what it records', async () => {
    // An earlier run forecast 0.9 for forty openings that production has since declined: a systematic over-forecast.
    const dead = Array.from({ length: 40 }, () => problem({ state: 'DECLINED' }));
    const ps = [...dead, ...Array.from({ length: 10 }, () => problem())];
    const earlier = { at: '2026-11-01T00:00:00.000Z', forecasts: { [BASELINE_METHOD.key]: Object.fromEntries(dead.map((p) => [p.id, 0.9])) } };
    const ledger = sprintForecastLedger([earlier], ps, NOW);
    expect(ledger.predictions).toHaveLength(40);
    expect(ledger.outcomes).toHaveLength(40);
    expect(ledger.outcomes.every((o) => o.occurred === false)).toBe(true);

    const { deps, provenance } = harness(ps, { priorForecasts: async () => [earlier] });
    const run = await runSprintBenchmark(deps);
    expect(run.math.forecastsResolved).toBe(40);
    const bias = run.math.bias.find((b) => b.comparableKey === BASELINE_METHOD.key);
    expect(bias?.verdict).toBe('SYSTEMATIC');
    expect(run.math.correctionsApplied).toBeGreaterThan(0);
    // The baseline's 0.6 on a READY opening is recorded corrected downward, with the measured error as a sourced input.
    const ready = ps.find((p) => p.state === 'READY')!;
    const rec = provenance.find((p) => p.key === `p-actionable:${BASELINE_METHOD.key}:${ready.id}`)!;
    expect(rec.value).toBeLessThan(0.6);
    expect(rec.sources.map((s) => s.input)).toContain('shift');
    // The realized rate the forecasts were judged against is itself a recorded number with provenance.
    expect(provenance.some((p) => p.key.startsWith(`observed-rate:${BASELINE_METHOD.key}`))).toBe(true);
  });
});
