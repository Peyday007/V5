/**
 * Repair F6 of SPRINT-18-5: the sprint does not only measure. It selects the
 * highest-leverage missing general reasoning capability (on the benchmark set
 * only), ships it through the existing Factory repair path, and the rerun links
 * the held-out delta to the change that was delivered in between. The general
 * method's own false positives reach repair even when it beats the baseline,
 * and required human interventions are a count of real owner requests, not the
 * method's model of needing a person.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listImprovementEvents } from '../server/repos/improvement.ts';
import type { Weakness } from '../server/domain/improvement.ts';
import { acquireKnowledge, mechanismFromOpening, type KnowledgeReading, type KnowledgeSourceClaim } from '../server/services/research/knowledgeModel.ts';
import {
  BASELINE_METHOD,
  GENERAL_METHOD,
  SPRINT_EVENT,
  capabilitiesOfMiss,
  compareRuns,
  compareWithBaseline,
  rankCapabilityGaps,
  readOwnerInterventions,
  readSet,
  runSprintBenchmark,
  splitProblems,
  type MethodContext,
  type SetReading,
  type SprintDeps,
  type SprintProblem,
} from '../server/services/improvement/sprint.ts';

let seq = 0;
const problem = (over: Partial<SprintProblem> = {}): SprintProblem => {
  seq += 1;
  return {
    id: `opp_f6_${String(seq).padStart(4, '0')}`,
    projectId: 'prj_1',
    title: `opening ${seq}`,
    mechanism: 'RESALE',
    industry: 'equipment',
    source: 'https://example.test/listing',
    sourceClaimId: `clm_f6_${String(seq).padStart(4, '0')}`,
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
    // The market's yes. READY is Brain's own readiness gate and is not an outcome (repair F5).
    state: 'COLLECTED',
    createdAt: `2026-10-${String((seq % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
};

const NOW = new Date('2026-11-16T00:00:00.000Z');

function researchClaim(id: string): KnowledgeSourceClaim {
  return {
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
  };
}

/** Openings whose research says the buyer withdrew: evidence a reasoning method can use and the readiness gate cannot. */
const WITHDRAWN = new Set<string>();

const knowledgeFor = (ps: readonly SprintProblem[]): KnowledgeReading =>
  acquireKnowledge({
    subject: 'project prj_1',
    claims: ps
      .filter((p) => p.sourceClaimId)
      .map((p) => ({
        ...researchClaim(p.sourceClaimId!),
        ...(WITHDRAWN.has(p.id) ? { contradictionState: 'CONTESTED' as const, contradictionNote: 'the buyer withdrew the request' } : {}),
      })),
    now: NOW,
  });

const contextFor = (p: SprintProblem, knowledge: KnowledgeReading = knowledgeFor([p])): MethodContext => {
  const m = mechanismFromOpening(p, knowledge);
  return { knowledge, mechanism: m.ok ? m.model : null };
};

const population = (): SprintProblem[] => {
  const out: SprintProblem[] = [];
  for (let i = 0; i < 40; i++) out.push(problem());
  for (let i = 0; i < 40; i++) out.push(problem({ state: 'DISCOVERED', buyingSignal: null, paymentTerms: null, fulfillmentOwner: null }));
  for (let i = 0; i < 20; i++) out.push(problem({ state: 'EVIDENCE_CARD', payer: null, priceCents: null, reachableChannel: null }));
  return out;
};

/** Every injected dependency, so a run touches only what the test gives it. */
const isolated = (over: SprintDeps = {}): SprintDeps => ({
  previous: async () => null,
  record: async () => {},
  recordDecision: async () => {},
  recordProvenance: async () => {},
  learning: async () => ({ catalogue: [], outcomes: [], procedures: [] }),
  history: async () => new Map(),
  recordResult: async () => {},
  recordProcedure: async () => {},
  sendNeeds: (async () => []) as never,
  interventions: async () => new Map(),
  candidate: async () => null,
  now: () => NOW,
  ...over,
});

describe('the sprint selects the highest-leverage missing capability, on the benchmark only', () => {
  it('attributes each miss to what the general method could not do', () => {
    const noClaim = problem({ sourceClaimId: null });
    const v = GENERAL_METHOD.run(noClaim, 0.5, contextFor(noClaim, knowledgeFor([])));
    expect(capabilitiesOfMiss(noClaim, v)).toEqual(['knowledge-acquisition']);
    const gap = problem({ buyingSignal: null });
    expect(capabilitiesOfMiss(gap, GENERAL_METHOD.run(gap, 0.5, contextFor(gap)))).toEqual(['mechanism-role:trigger']);
    const dead = problem({ state: 'DECLINED' });
    const called = GENERAL_METHOD.run(dead, 0.5, contextFor(dead));
    expect(called.actionable).toBe(true);
    expect(capabilitiesOfMiss(dead, called)).toEqual(['counter-model']);
    // A correct call is not a miss.
    const fine = problem();
    expect(capabilitiesOfMiss(fine, GENERAL_METHOD.run(fine, 0.5, contextFor(fine)))).toEqual([]);
  });

  it('ranks capabilities by how many misses each explains', () => {
    const ps = [
      ...Array.from({ length: 3 }, () => problem({ buyingSignal: null })),
      problem({ fulfillmentOwner: null }),
    ];
    const ranked = rankCapabilityGaps(ps, ps.map((p) => GENERAL_METHOD.run(p, 0.5, contextFor(p))));
    expect(ranked[0]).toMatchObject({ key: 'mechanism-role:trigger', explains: 3, of: 4 });
    expect(ranked[1]).toMatchObject({ key: 'mechanism-role:deliverer', explains: 1 });
    expect(ranked[0]!.ownerPaths.length).toBeGreaterThan(0);
  });

  it('ships the top capability through registerDirected when the general method still wins, with its leverage and paths', async () => {
    // Every collected opening lacks a sourced claim: the general method misses them all and the capability is knowledge acquisition.
    const ps = population();
    const registered: Weakness[] = [];
    const run = await runSprintBenchmark(isolated({
      read: async () => ps,
      knowledge: async () => knowledgeFor([]),
      registerDirected: async (w) => {
        registered.push(w);
        return { candidate: { id: `imc_${registered.length}` } };
      },
    }));
    const split = splitProblems(ps, null);
    const benchmarkReady = split.BENCHMARK.filter((p) => p.state === 'COLLECTED').length;
    expect(run.capabilities[0]).toMatchObject({ key: 'knowledge-acquisition', explains: benchmarkReady });
    const shippedKeys = registered.map((w) => w.key);
    expect(shippedKeys).toContain(run.comparisons.some((c) => c.set !== 'BENCHMARK' && c.earned === false) ? 'reasoning-sprint:general-method' : 'reasoning-sprint:capability:knowledge-acquisition');
    expect(run.shipped).toMatchObject({ capability: 'knowledge-acquisition', shippedAt: NOW.toISOString() });
    const weakness = registered.find((w) => w.key.startsWith('reasoning-sprint:'))!;
    expect(weakness.mutationScope).toContain('server/services/research/**');
  });

  it('does not let held-out outcomes choose the capability', async () => {
    const ps = population();
    const split = splitProblems(ps, null);
    const flipped = [...split.BENCHMARK, ...split.HELD_OUT.map((p) => ({ ...p, state: p.state === 'COLLECTED' ? 'DECLINED' : 'COLLECTED' }))];
    const read = async (input: SprintProblem[]) =>
      (await runSprintBenchmark(isolated({ read: async () => input, knowledge: async () => knowledgeFor([]), registerDirected: async () => ({ candidate: { id: 'imc_x' } }) }))).capabilities;
    expect(await read(flipped)).toEqual(await read(ps));
  });
});

describe('the rerun links its held-out delta to the change delivered since', () => {
  const reading = (set: SetReading['set'], rate: number, brier: number): SetReading => ({
    set,
    method: GENERAL_METHOD.key,
    problems: 20,
    unresolved: 0,
    actionablePathwayRate: { value: rate, numerator: rate * 20, denominator: 20 },
    methodQuality: { value: 1, numerator: 20, denominator: 20 },
    decisionTimeMs: { value: 1, numerator: 20, denominator: 20 },
    humanInterventions: { value: 0, numerator: 0, denominator: 20 },
    modelledNeedsPerson: { value: 0, numerator: 0, denominator: 20 },
    calibrationBrier: { value: brier, numerator: brier * 20, denominator: 20 },
    robustTargetCoverage: { value: rate, numerator: rate * 20, denominator: 20 },
    falsePositives: [],
  });
  const shipped = { capability: 'knowledge-acquisition', candidateId: 'imc_1', shippedAt: '2026-11-15T00:00:00.000Z' };
  const delivered = { id: 'imc_1', weaknessKey: 'reasoning-sprint:capability:knowledge-acquisition', deliveredAt: '2026-11-15T12:00:00.000Z', deliveredRef: 'sha:abc123', decision: null };

  it('IMPROVED names the delivered ref and every delta', () => {
    const r = compareRuns({
      previousRunAt: '2026-11-15T00:00:00.000Z',
      previousReadings: [reading('BENCHMARK', 0.2, 0.3), reading('HELD_OUT', 0.2, 0.3)],
      readings: [reading('BENCHMARK', 0.4, 0.2), reading('HELD_OUT', 0.35, 0.25)],
      shipped,
      candidate: delivered,
      now: NOW.toISOString(),
    });
    expect(r.verdict).toBe('IMPROVED');
    expect(r.deliveredRef).toBe('sha:abc123');
    expect(r.deltas.find((d) => d.set === 'HELD_OUT' && d.measure === 'actionablePathwayRate')?.delta).toBeCloseTo(0.15);
    expect(r.statement).toContain('sha:abc123');
  });

  it('the benchmark improving alone is not an improvement: only held-out decides', () => {
    const r = compareRuns({
      previousRunAt: '2026-11-15T00:00:00.000Z',
      previousReadings: [reading('BENCHMARK', 0.2, 0.3), reading('HELD_OUT', 0.3, 0.2)],
      readings: [reading('BENCHMARK', 0.6, 0.1), reading('HELD_OUT', 0.25, 0.22)],
      shipped,
      candidate: delivered,
      now: NOW.toISOString(),
    });
    expect(r.verdict).toBe('NOT_IMPROVED');
  });

  it('links nothing while the change is undelivered', () => {
    const r = compareRuns({ previousRunAt: '2026-11-15T00:00:00.000Z', previousReadings: [], readings: [], shipped, candidate: { ...delivered, deliveredAt: null }, now: NOW.toISOString() });
    expect(r.verdict).toBe('NO_CHANGE_DELIVERED');
    expect(r.deliveredRef).toBeNull();
  });

  it('a run reads the previous run, records the rerun linked to the delivered change, and re-ships a capability that did not help', async () => {
    await freshProject();
    const ps = population();
    const registered: Weakness[] = [];
    // The run records to the real improvement_events table, so the second run reads what the first recorded.
    const deps = isolated({
      read: async () => ps,
      knowledge: async () => knowledgeFor([]),
      registerDirected: async (w) => {
        registered.push(w);
        return { candidate: { id: 'imc_cap' } };
      },
    });
    delete deps.record;
    const first = await runSprintBenchmark({ ...deps, now: () => new Date('2026-11-14T00:00:00.000Z') });
    expect(first.rerun).toBeNull();
    expect(first.shipped?.candidateId).toBe('imc_cap');

    const [row] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
    const second = await runSprintBenchmark({
      ...deps,
      previous: async () => ({
        at: row!.at,
        cutoff: (row!.detail['cutoff'] as string | null) ?? null,
        readings: row!.detail['readings'] as unknown[],
        shipped: row!.detail['shipped'] as never,
      }),
      candidate: async (id) => ({ id, weaknessKey: 'reasoning-sprint:capability:knowledge-acquisition', deliveredAt: '2026-11-15T00:00:00.000Z', deliveredRef: 'sha:def456', decision: null }),
      now: () => NOW,
    });
    expect(second.rerun?.shipped?.candidateId).toBe('imc_cap');
    expect(second.rerun?.deliveredRef).toBe('sha:def456');
    // Nothing changed in the rows, so the delivered change did not move held-out: that is said, and the capability goes back to repair.
    expect(second.rerun?.verdict).toBe('NOT_IMPROVED');
    expect(registered.length).toBeGreaterThanOrEqual(2);
    const [recorded] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
    expect((recorded!.detail['rerun'] as { deliveredRef?: string }).deliveredRef).toBe('sha:def456');
    expect(recorded!.detail['capabilities']).toBeDefined();
  });
});

describe('per-method findings reach repair even when the general method wins', () => {
  it('registers the general method held-out false positives although it beat the baseline', async () => {
    const ps = population();
    // Complete, evidenced cards the market declined: the general method calls them actionable, as do both baselines.
    for (let i = 0; i < 30; i++) ps.push(problem({ state: 'DECLINED' }));
    // And declined openings whose research said the buyer withdrew: the general method gets these right where
    // payer-and-price and the readiness gate cannot, so it wins on what the market resolved — and still has false positives.
    for (let i = 0; i < 30; i++) {
      const p = problem({ state: 'DECLINED' });
      WITHDRAWN.add(p.id);
      ps.push(p);
    }
    const registered: Weakness[] = [];
    const run = await runSprintBenchmark(isolated({
      read: async () => ps,
      knowledge: async () => knowledgeFor(ps),
      registerDirected: async (w) => {
        registered.push(w);
        return { candidate: { id: `imc_${w.key}` } };
      },
    }));
    const wins = run.comparisons.filter((c) => c.set !== 'BENCHMARK' && c.earned !== false && c.general.falsePositives.length > 0);
    expect(wins.length).toBeGreaterThan(0);
    const fp = registered.find((w) => w.key === 'reasoning-sprint:false-positives');
    expect(fp).toBeDefined();
    expect(fp!.samples.every((id) => ps.find((p) => p.id === id)?.state === 'DECLINED')).toBe(true);
    // The wins it was credited with are wins over the readiness gate as well, not only over payer-and-price.
    expect(wins.some((c) => c.baseline.method === 'baseline:readiness-gate')).toBe(true);
    expect(run.falsePositiveCandidateId).toBe('imc_reasoning-sprint:false-positives');
  });
});

describe('required human interventions are real owner requests, not the method model', () => {
  it('readSet counts problems a real request named, and says INSUFFICIENT_DATA when none were read', () => {
    // Declined by the market, so the outcome measures are readable and the comparison states its people figure.
    const ps = Array.from({ length: 6 }, () => problem({ state: 'DECLINED', payer: null }));
    const verdicts = ps.map((p) => GENERAL_METHOD.run(p, 0.5, contextFor(p)));
    const unread = readSet('HELD_OUT', GENERAL_METHOD.key, ps, verdicts);
    expect(unread.humanInterventions.value).toBe('INSUFFICIENT_DATA');
    const real = readSet('HELD_OUT', GENERAL_METHOD.key, ps, verdicts, new Map([[ps[0]!.id, 2]]));
    expect(real.humanInterventions).toMatchObject({ numerator: 1, denominator: 6 });
    // The model of needing a person is kept apart, and is what methods are compared on.
    expect(real.modelledNeedsPerson.denominator).toBe(6);
    const b = readSet('HELD_OUT', BASELINE_METHOD.key, ps, ps.map((p) => BASELINE_METHOD.run(p, 0.5)), new Map([[ps[0]!.id, 2]]));
    expect(compareWithBaseline(real, b).statement).toContain('people');
  });

  it('reads Needs-You requests that name an opening from russell_human_requests', async () => {
    const { project } = await freshProject();
    const named = problem({ projectId: project.id, createdAt: '2026-11-01T00:00:00.000Z' });
    const other = problem({ projectId: project.id, createdAt: '2026-11-01T00:00:00.000Z' });
    const before = problem({ projectId: project.id, createdAt: '2026-11-10T00:00:00.000Z' });
    const insert = (id: string, text: string, at: string) =>
      getDb().run(
        `INSERT INTO russell_human_requests (id, project_id, authority_needed, why_not_russell, resume_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, project.id, 'SPEND', text, `resume:${id}`, at, at],
      );
    await insert('rhr_1', `price for ${named.id} needs approval`, '2026-11-05T00:00:00.000Z');
    await insert('rhr_2', `and again for ${named.id}`, '2026-11-06T00:00:00.000Z');
    await insert('rhr_3', `about ${before.id}, raised before it existed`, '2026-11-05T00:00:00.000Z');
    const counts = await readOwnerInterventions([named, other, before]);
    expect(counts.get(named.id)).toBe(2);
    expect(counts.get(other.id) ?? 0).toBe(0);
    expect(counts.get(before.id) ?? 0).toBe(0);
  });
});
