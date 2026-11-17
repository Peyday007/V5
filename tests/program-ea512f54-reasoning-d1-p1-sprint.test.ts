import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listImprovementEvents } from '../server/repos/improvement.ts';
import type { KnowledgeSourceClaim } from '../server/services/research/knowledgeModel.ts';
import {
  BASELINE_METHOD,
  GENERAL_METHOD,
  SPRINT_DISCLAIMER,
  SPRINT_EVENT,
  chooseThreshold,
  compareWithBaseline,
  readSet,
  readSprintProblems,
  runSprintBenchmark,
  splitProblems,
  sprintIfDue,
  type SprintProblem,
  profileOf,
  holdsProbability,
} from '../server/services/improvement/sprint.ts';
import { decideNext } from '../server/services/research/reasoningController.ts';
import { SEED_METHODS } from '../server/services/research/methodLibrary.ts';

/** A gated research claim as the research repository returns it. */
const researchClaim = (id: string, over: Partial<KnowledgeSourceClaim> = {}): KnowledgeSourceClaim => ({
  id,
  claim: `claim ${id}`,
  claimType: 'SOURCED_FACT',
  sourceUrl: `https://example.test/${id}`,
  sourceTitle: `Source ${id}`,
  sourcePublisher: 'Example Publisher',
  sourceDate: '2026-10-01',
  retrievedAt: '2026-10-20T00:00:00.000Z',
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
  structuralFinding: 'BUYER_TYPE',
  laborFinding: null,
  createdAt: '2026-10-20T00:00:00.000Z',
  ...over,
});

let seq = 0;
const problem = (over: Partial<SprintProblem> = {}): SprintProblem => {
  seq += 1;
  return {
    id: `opp_${String(seq).padStart(4, '0')}`,
    projectId: 'prj_1',
    title: `opening ${seq}`,
    mechanism: 'RESALE',
    industry: 'equipment',
    source: 'https://example.test/listing',
    sourceClaimId: null,
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
    claims: [researchClaim(`rfq_${seq}`), researchClaim(`buyer_${seq}`, { structuralFinding: 'UNIT_ECONOMIC' })],
    ...over,
  };
};

/** The research behind an opening was true once and has since lapsed. */
const lapsed = (): KnowledgeSourceClaim[] => [researchClaim(`lapsed_${seq}`, { structuralFinding: 'UNIT_ECONOMIC', validUntil: '2026-10-15' })];

/**
 * A population where payer+price is present on dead openings too, so the
 * baseline over-calls them; what tells them apart is the research behind each
 * opening — current on the live ones, lapsed on the dead ones, absent on the
 * bare cards — never how many card fields are filled.
 */
const population = (): SprintProblem[] => {
  const out: SprintProblem[] = [];
  for (let i = 0; i < 40; i++) out.push(problem());
  for (let i = 0; i < 40; i++) out.push(problem({ state: 'DISCOVERED', buyingSignal: null, paymentTerms: null, fulfillmentOwner: null, claims: lapsed() }));
  for (let i = 0; i < 20; i++) out.push(problem({ state: 'EVIDENCE_CARD', payer: null, priceCents: null, reachableChannel: null, claims: [] }));
  return out;
};

describe('the benchmark measures every quantity per set, with numerator and denominator', () => {
  it('records pathway rate, method quality, decision time, interventions, calibration and robust coverage', () => {
    const ps = population();
    const reading = readSet('BENCHMARK', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.7)));
    for (const m of [reading.actionablePathwayRate, reading.methodQuality, reading.decisionTimeMs, reading.humanInterventions, reading.calibrationBrier, reading.robustTargetCoverage]) {
      expect(typeof m.numerator).toBe('number');
      expect(typeof m.denominator).toBe('number');
    }
    expect(reading.actionablePathwayRate).toMatchObject({ numerator: 40, denominator: 100, value: 0.4 });
    expect(reading.robustTargetCoverage).toMatchObject({ numerator: 40, denominator: 40 });
    expect(reading.falsePositives).toEqual([]);
  });

  it('says INSUFFICIENT_DATA below the minimum sample rather than a number', () => {
    const ps = population().slice(0, 3);
    const reading = readSet('NEW_HELD_OUT', BASELINE_METHOD.key, ps, ps.map((p) => BASELINE_METHOD.run(p, 0.5)));
    expect(reading.actionablePathwayRate.value).toBe('INSUFFICIENT_DATA');
    expect(reading.actionablePathwayRate.denominator).toBe(3);
  });

  it('keeps unknowns unknown: a price without a source yields no provenance and no actionable call', () => {
    const v = GENERAL_METHOD.run(problem({ source: null }), 0.5);
    expect(v.actionable).toBe(false);
    expect(v.provenance ?? null).toBeNull();
    expect(v.findings).toBeGreaterThan(0);
  });
});

describe('the controller generates its own competing hypotheses and weighs them against real claims', () => {
  it('holds no fixed hypothesis: every one is a representation it selected or a counter-model of a failure it found', () => {
    for (const p of [problem(), problem({ claims: lapsed(), buyingSignal: null }), problem({ claims: [] })]) {
      const d = GENERAL_METHOD.run(p, 0.5).decision!;
      expect(d.hypotheses.length).toBeGreaterThanOrEqual(2);
      for (const h of d.hypotheses) expect(h.basis).toMatch(/^(representation|counter):/);
      expect(d.hypotheses.map((h) => h.id)).not.toContain('pathway-holds');
      expect(d.hypotheses.map((h) => h.id)).not.toContain('pathway-fails');
      expect(new Set(d.hypotheses.map((h) => h.basis)).size).toBe(d.hypotheses.length);
    }
  });

  it('counts only the opening\'s sourced research claims as evidence, never a filled or empty card field', () => {
    const full = problem();
    const d = GENERAL_METHOD.run(full, 0.5).decision!;
    const claimIds = new Set(full.claims.map((c) => c.id));
    const cited = d.hypotheses.flatMap((h) => [...h.supports, ...h.refutes]);
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(claimIds.has(id)).toBe(true);
    // Seven filled fields over the same two claims weigh exactly what three filled fields over them weigh.
    const sparse = problem({ claims: full.claims, buyingSignal: null, paymentTerms: null, fulfillmentOwner: null, acceptanceCondition: null });
    const d2 = (p: SprintProblem) => GENERAL_METHOD.run(p, 0.5).decision!;
    const best = (p: SprintProblem) => d2(p).hypotheses.filter((h) => h.basis.startsWith('representation:')).map((h) => h.supports.length);
    expect(Math.max(...best(sparse))).toBe(Math.max(...best(full)));
    // A full card with no research behind it has no evidence at all: nothing supports or refutes anything.
    const bare = d2(problem({ claims: [] }));
    expect(bare.hypotheses.every((h) => h.supports.length === 0 && h.refutes.length === 0)).toBe(true);
    expect(holdsProbability(bare)).toBe(0.5);
  });

  it('a lapsed claim becomes a counter-model it supports, and refutes the transaction working as modelled', () => {
    const p = problem({ claims: lapsed() });
    const { knowledge, mechanism } = profileOf(p);
    expect(knowledge.claims.find((c) => c.id === p.claims[0]!.id)?.status).toBe('OUTDATED');
    expect(mechanism?.unknown).toContain('initiator');
    const d = GENERAL_METHOD.run(p, 0.5).decision!;
    const counter = d.hypotheses.find((h) => h.id === 'fails:prices')!;
    expect(counter.supports).toEqual([p.claims[0]!.id]);
    for (const h of d.hypotheses.filter((one) => one.basis.startsWith('representation:'))) expect(h.refutes).toEqual([p.claims[0]!.id]);
    expect(holdsProbability(d)).toBeLessThan(0.5);
    expect(GENERAL_METHOD.run(p, 0.5).actionable).toBe(false);
  });

  it('is the same controller any caller gets: the sprint passes it no hypotheses and no evidence of its own', () => {
    const p = problem();
    const { profile, knowledge, mechanism } = profileOf(p);
    const direct = decideNext({ problem: profile, knowledge, mechanism, catalogue: SEED_METHODS, outcomes: [], evidence: [], actions: [], now: p.updatedAt });
    expect(direct.hypotheses.map((h) => [h.id, h.score])).toEqual(GENERAL_METHOD.run(p, 0.5).decision!.hypotheses.map((h) => [h.id, h.score]));
  });
});

describe('held-out problems never choose the method, and a rerun adds new held-out tasks', () => {
  it('splits deterministically and puts openings created after the previous cutoff in NEW_HELD_OUT', () => {
    const ps = population();
    const a = splitProblems(ps, null);
    const b = splitProblems(ps, null);
    expect(a.BENCHMARK.map((p) => p.id)).toEqual(b.BENCHMARK.map((p) => p.id));
    expect(a.BENCHMARK.length + a.HELD_OUT.length).toBe(ps.length);
    const later = problem({ createdAt: '2026-12-01T00:00:00.000Z' });
    const c = splitProblems([...ps, later], '2026-11-30T00:00:00.000Z');
    expect(c.NEW_HELD_OUT.map((p) => p.id)).toEqual([later.id]);
    expect(c.BENCHMARK.map((p) => p.id)).toEqual(a.BENCHMARK.map((p) => p.id));
  });

  it('tunes its threshold on the benchmark alone: changing held-out outcomes does not move it', () => {
    const ps = population();
    const split = splitProblems(ps, null);
    const t1 = chooseThreshold(split.BENCHMARK);
    const flipped = split.HELD_OUT.map((p) => ({ ...p, state: p.state === 'READY' ? 'DISCOVERED' : 'READY' }));
    const t2 = chooseThreshold(splitProblems([...split.BENCHMARK, ...flipped], null).BENCHMARK);
    expect(t2).toBe(t1);
  });
});

describe('the general method is compared with a simpler baseline on the same problems', () => {
  it('states whether the extra complexity earned its cost', () => {
    const ps = population();
    const g = readSet('HELD_OUT', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.7)));
    const b = readSet('HELD_OUT', BASELINE_METHOD.key, ps, ps.map((p) => BASELINE_METHOD.run(p, 0.7)));
    const cmp = compareWithBaseline(g, b);
    expect(cmp.earned).toBe(true);
    expect(cmp.statement).toContain('earned its cost');
    // Where openings missing load-bearing fields closed anyway, the stricter method loses and says so.
    const surprising = population().map((p) => ({ ...p, state: p.payer ? 'COLLECTED' : p.state }));
    const g2 = readSet('HELD_OUT', GENERAL_METHOD.key, surprising, surprising.map((p) => GENERAL_METHOD.run(p, 0.7)));
    const b2 = readSet('HELD_OUT', BASELINE_METHOD.key, surprising, surprising.map((p) => BASELINE_METHOD.run(p, 0.7)));
    const lost = compareWithBaseline(g2, b2);
    expect(lost.earned).toBe(false);
    expect(lost.statement).toContain('did not earn its cost');
  });
});

describe('a run records its readings, feeds failure to the existing repair path, and is wired into the tick', () => {
  it('records one improvement event with every reading and the disclaimer, and demonstrates controller and provenance rows', async () => {
    await freshProject();
    const decisions: string[] = [];
    const provenance: string[] = [];
    const run = await runSprintBenchmark({
      read: async () => population(),
      previous: async () => null,
      recordDecision: async (d) => {
        decisions.push(d.problemId);
      },
      recordProvenance: async (p) => {
        provenance.push(p.key);
      },
      registerDirected: async () => {
        throw new Error('the general method should not lose on this population');
      },
    });
    expect(run.readings).toHaveLength(6);
    expect(run.disclaimer).toBe(SPRINT_DISCLAIMER);
    expect(decisions.length).toBeGreaterThan(0);
    expect(provenance.length).toBeGreaterThan(0);
    const [event] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
    expect(event?.detail['disclaimer']).toBe(SPRINT_DISCLAIMER);
    expect((event?.detail['readings'] as unknown[]).length).toBe(6);
  });

  it('registers a held-out loss through registerDirected and not anywhere else', async () => {
    await freshProject();
    const registered: string[] = [];
    // The general method demands every load-bearing field; here dead-looking openings did close, so it loses.
    const ps = [...population().map((p) => ({ ...p, state: p.payer ? 'COLLECTED' : p.state }))];
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      recordDecision: async () => {},
      recordProvenance: async () => {},
      registerDirected: async (w) => {
        registered.push(w.key);
        return { candidate: { id: 'imc_sprint' } };
      },
    });
    expect(registered).toEqual(['reasoning-sprint:general-method']);
    expect(run.repairCandidateId).toBe('imc_sprint');
  });

  it('runs at most once per interval, and reads real openings from production rows', async () => {
    await freshProject();
    expect(await readSprintProblems()).toEqual([]);
    const first = await sprintIfDue(new Date('2026-11-17T00:00:00.000Z'), { read: async () => [] });
    expect(first).not.toBeNull();
    const second = await sprintIfDue(new Date('2026-11-17T01:00:00.000Z'), { read: async () => [] });
    expect(second).toBeNull();
    const rows = await getDb().all<{ kind: string }>(`SELECT kind FROM improvement_events WHERE kind = ?`, [SPRINT_EVENT]);
    expect(rows).toHaveLength(1);
  });

  it('is run by the improvement tick', () => {
    expect(readFileSync('server/services/improvement/loop.ts', 'utf8')).toContain("import('./sprint.ts')");
  });
});
