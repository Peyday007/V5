import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listImprovementEvents } from '../server/repos/improvement.ts';
import { MECHANISM_HOLDS, decideNext, readControllerHistory } from '../server/services/research/reasoningController.ts';
import { acquireKnowledge, mechanismFromOpening, type KnowledgeReading, type KnowledgeSourceClaim } from '../server/services/research/knowledgeModel.ts';
import {
  BASELINE_METHOD,
  GATE_METHOD,
  GENERAL_METHOD,
  SPRINT_DISCLAIMER,
  SPRINT_CALLER,
  SPRINT_EVENT,
  chooseDemonstrated,
  chooseThreshold,
  controllerSnapshotOf,
  pendingResult,
  productionOutcome,
  compareWithBaseline,
  readSet,
  readSprintProblems,
  actionableInProduction,
  resolvedInProduction,
  runSprintBenchmark,
  splitProblems,
  sprintIfDue,
  type MethodContext,
  type SprintProblem,
} from '../server/services/improvement/sprint.ts';

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
    sourceClaimId: `clm_${String(seq).padStart(4, '0')}`,
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
    // The market's yes: money was collected. READY is Brain's own gate and is not an outcome (repair F5).
    state: 'COLLECTED',
    createdAt: `2026-10-${String((seq % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
};

const NOW = new Date('2026-11-16T00:00:00.000Z');

/** The research claim an opening's card was drawn from: a read, primary source unless overridden. */
function researchClaim(id: string, over: Partial<KnowledgeSourceClaim> = {}): KnowledgeSourceClaim {
  return {
    id,
    // One content word unique to the claim, so claims about different openings are not read as about the same thing.
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
    ...over,
  };
}

/** Openings whose research says the buyer withdrew: the evidence a reasoning method can use and the gate cannot. */
const WITHDRAWN = new Set<string>();
const WITHDRAWN_CLAIM: Partial<KnowledgeSourceClaim> = { contradictionState: 'CONTESTED', contradictionNote: 'the buyer withdrew the request' };

/** A project's knowledge holding the claim behind every given opening. */
const knowledgeFor = (ps: readonly SprintProblem[], over: Partial<KnowledgeSourceClaim> = {}): KnowledgeReading =>
  acquireKnowledge({
    subject: 'project prj_1',
    claims: ps.filter((p) => p.sourceClaimId).map((p) => researchClaim(p.sourceClaimId!, WITHDRAWN.has(p.id) ? { ...WITHDRAWN_CLAIM, ...over } : over)),
    now: NOW,
  });

/** Layers 1 and 2 for one opening, as the sprint gives them to the general method. */
const contextFor = (p: SprintProblem, knowledge: KnowledgeReading = knowledgeFor([p])): MethodContext => {
  const m = mechanismFromOpening(p, knowledge);
  return { knowledge, mechanism: m.ok ? m.model : null };
};

/**
 * Every opening the market resolved passed the readiness gate — complete cards
 * all — so the gate (and payer-and-price) calls every one of them actionable.
 * Forty collected; forty were declined after READY, and the research behind
 * those says the buyer withdrew. The rest the market has not resolved: ten sit
 * at Brain's own READY, ten are undecided with incomplete cards.
 */
const population = (): SprintProblem[] => {
  const out: SprintProblem[] = [];
  for (let i = 0; i < 40; i++) out.push(problem());
  for (let i = 0; i < 40; i++) {
    const p = problem({ state: 'DECLINED' });
    WITHDRAWN.add(p.id);
    out.push(p);
  }
  for (let i = 0; i < 10; i++) out.push(problem({ state: 'READY' }));
  for (let i = 0; i < 10; i++) out.push(problem({ state: 'DISCOVERED', buyingSignal: null, paymentTerms: null, fulfillmentOwner: null }));
  return out;
};

describe('the benchmark measures every quantity per set, with numerator and denominator', () => {
  it('records pathway rate, method quality, decision time, interventions, calibration and robust coverage', () => {
    const ps = population();
    const reading = readSet('BENCHMARK', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.6, contextFor(p))));
    for (const m of [reading.actionablePathwayRate, reading.methodQuality, reading.decisionTimeMs, reading.humanInterventions, reading.calibrationBrier, reading.robustTargetCoverage]) {
      expect(typeof m.numerator).toBe('number');
      expect(typeof m.denominator).toBe('number');
    }
    // Only the eighty the market resolved are scored; the twenty it has not are counted, not read as failures.
    expect(reading.unresolved).toBe(20);
    expect(reading.actionablePathwayRate).toMatchObject({ numerator: 40, denominator: 80, value: 0.5 });
    expect(reading.calibrationBrier.denominator).toBe(80);
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
    const unsourced = problem({ source: null, sourceClaimId: null });
    const v = GENERAL_METHOD.run(unsourced, 0.5, contextFor(unsourced));
    expect(v.actionable).toBe(false);
    expect(v.provenance ?? null).toBeNull();
    expect(v.findings).toBeGreaterThan(0);
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
    const t1 = chooseThreshold(split.BENCHMARK, GENERAL_METHOD, (p) => contextFor(p));
    const flipped = split.HELD_OUT.map((p) => ({ ...p, state: p.state === 'COLLECTED' ? 'DECLINED' : 'COLLECTED' }));
    const t2 = chooseThreshold(splitProblems([...split.BENCHMARK, ...flipped], null).BENCHMARK, GENERAL_METHOD, (p) => contextFor(p));
    expect(t2).toBe(t1);
  });
});

describe('the general method is compared with a simpler baseline on the same problems', () => {
  it('states whether the extra complexity earned its cost, against payer-and-price and against the readiness gate', () => {
    const ps = population();
    const g = readSet('HELD_OUT', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.6, contextFor(p))));
    for (const baseline of [BASELINE_METHOD, GATE_METHOD]) {
      const b = readSet('HELD_OUT', baseline.key, ps, ps.map((p) => baseline.run(p, 0.6)));
      const cmp = compareWithBaseline(g, b);
      expect(cmp.earned).toBe(true);
      expect(cmp.statement).toContain('earned its cost');
      expect(cmp.statement).toContain(baseline.key);
    }
    // Where the openings whose research said the buyer withdrew closed anyway, the general method loses and says so.
    const surprising = population().map((p) => (WITHDRAWN.has(p.id) ? { ...p, state: 'COLLECTED' } : p));
    const g2 = readSet('HELD_OUT', GENERAL_METHOD.key, surprising, surprising.map((p) => GENERAL_METHOD.run(p, 0.6, contextFor(p))));
    const b2 = readSet('HELD_OUT', BASELINE_METHOD.key, surprising, surprising.map((p) => BASELINE_METHOD.run(p, 0.6)));
    const lost = compareWithBaseline(g2, b2);
    expect(lost.earned).toBe(false);
    expect(lost.statement).toContain('did not earn its cost');
  });
});

describe('the ground truth is the market, never the readiness gate the general method shares (repair F5)', () => {
  it('READY and EXECUTING are Brain\'s own gate and pursuit, not outcomes; DELIVERING, COLLECTED, DECLINED and ARCHIVED are', () => {
    for (const state of ['READY', 'EXECUTING', 'DISCOVERED', 'EVIDENCE_CARD']) expect(resolvedInProduction({ state })).toBe(false);
    for (const state of ['DELIVERING', 'COLLECTED']) expect(actionableInProduction({ state })).toBe(true);
    for (const state of ['DECLINED', 'ARCHIVED']) {
      expect(resolvedInProduction({ state })).toBe(true);
      expect(actionableInProduction({ state })).toBe(false);
    }
    expect(actionableInProduction({ state: 'READY' })).toBe(false);
    expect(productionOutcome({ state: 'READY' }, MECHANISM_HOLDS)).toBeNull();
    expect(productionOutcome({ state: 'EXECUTING' }, MECHANISM_HOLDS)).toBeNull();
  });

  it('a method that re-implements the gate scores nothing on openings only the gate has judged', () => {
    // Every opening at READY: the gate replica would be perfect if READY were the truth. It is not an outcome, so nothing is scored.
    const ps = Array.from({ length: 12 }, () => problem({ state: 'READY' }));
    const r = readSet('HELD_OUT', GATE_METHOD.key, ps, ps.map((p) => GATE_METHOD.run(p, 0.6)));
    expect(r.unresolved).toBe(12);
    expect(r.actionablePathwayRate).toMatchObject({ value: 'INSUFFICIENT_DATA', numerator: 0, denominator: 0 });
    expect(r.calibrationBrier.value).toBe('INSUFFICIENT_DATA');
    expect(r.falsePositives).toEqual([]);
    expect(chooseThreshold(ps, GATE_METHOD)).toBe(0.5);
  });

  it('matching the gate earns nothing: without research evidence the general method does not beat the gate it shares', () => {
    const ps = population();
    const none = knowledgeFor([]);
    const g = readSet('HELD_OUT', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.6, contextFor(p, none))));
    const gate = readSet('HELD_OUT', GATE_METHOD.key, ps, ps.map((p) => GATE_METHOD.run(p, 0.6)));
    expect(compareWithBaseline(g, gate).earned).toBe(false);
    // And the gate itself is no better than payer-and-price on what the market resolved: every resolved card passed it.
    const payer = readSet('HELD_OUT', BASELINE_METHOD.key, ps, ps.map((p) => BASELINE_METHOD.run(p, 0.6)));
    expect(gate.actionablePathwayRate).toEqual(payer.actionablePathwayRate);
    expect(gate.calibrationBrier).toEqual(payer.calibrationBrier);
    expect(compareWithBaseline(gate, payer).earned).toBe(false);
  });

  it('a run compares the general method with both baselines on every set, and a loss to the gate is a held-out loss', async () => {
    await freshProject();
    const ps = population();
    const registered: string[] = [];
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => knowledgeFor([]),
      record: async () => {},
      recordDecision: async () => {},
      recordProvenance: async () => {},
      registerDirected: async (w) => {
        registered.push(w.key);
        return { candidate: { id: `imc_${w.key}` } };
      },
      learning: async () => ({ catalogue: [], outcomes: [], procedures: [] }),
      history: async () => new Map(),
      recordResult: async () => {},
      recordProcedure: async () => {},
      sendNeeds: (async () => []) as never,
      now: () => NOW,
    });
    expect(new Set(run.comparisons.map((c) => c.baseline.method))).toEqual(new Set([BASELINE_METHOD.key, GATE_METHOD.key]));
    expect(run.comparisons.filter((c) => c.baseline.method === GATE_METHOD.key).map((c) => c.set).sort()).toEqual(['BENCHMARK', 'HELD_OUT', 'NEW_HELD_OUT']);
    expect(run.comparisons.some((c) => c.set === 'HELD_OUT' && c.baseline.method === GATE_METHOD.key && c.earned === false)).toBe(true);
    expect(registered).toContain('reasoning-sprint:general-method');
  });
});

describe('a run records its readings, feeds failure to the existing repair path, and is wired into the tick', () => {
  it('records one improvement event with every reading and the disclaimer, and demonstrates controller and provenance rows', async () => {
    await freshProject();
    const decisions: string[] = [];
    const provenance: string[] = [];
    const ps = population();
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => knowledgeFor(ps),
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
    expect(run.readings).toHaveLength(9);
    expect(run.disclaimer).toBe(SPRINT_DISCLAIMER);
    expect(decisions.length).toBeGreaterThan(0);
    expect(provenance.length).toBeGreaterThan(0);
    const [event] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
    expect(event?.detail['disclaimer']).toBe(SPRINT_DISCLAIMER);
    expect((event?.detail['readings'] as unknown[]).length).toBe(9);
  });

  it('registers a held-out loss through registerDirected and not anywhere else', async () => {
    await freshProject();
    const registered: string[] = [];
    // The general method weighs the research; here the openings it said the buyer withdrew from did close, so it loses.
    const ps = population().map((p) => (WITHDRAWN.has(p.id) ? { ...p, state: 'COLLECTED' } : p));
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => knowledgeFor(ps),
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

describe('the controller loop runs on real openings: results are tracked, the method changes, actions are handed off', () => {
  it('tracks what production said about an earlier decision, changes method, and the library learns from it', async () => {
    await freshProject();
    const sent: string[] = [];
    const sendNeeds = async (input: { needs: readonly { subject: string }[] }) => {
      sent.push(input.needs[0]!.subject);
      return [{ subject: input.needs[0]!.subject, sent: true as const, to: 'RESEARCH_UNCERTAINTY' as const, ref: 'unc_1', created: true }];
    };
    const open = problem({ id: 'opp_loop', state: 'DISCOVERED', buyingSignal: null, paymentTerms: null, updatedAt: '2026-11-10T00:00:00.000Z' });

    // Run 1: the opening is undecided; the controller decides on it and hands its next action to research.
    const first = await runSprintBenchmark({ read: async () => [open], previous: async () => null, sendNeeds, now: () => new Date('2026-11-15T00:00:00.000Z') });
    expect(first.loop.decisions).toBe(1);
    expect(first.loop.resultsTracked).toBe(0);
    expect(first.loop.handOffs['RESEARCH']).toBe(1);
    expect(sent).toHaveLength(1);
    const before = (await readControllerHistory(SPRINT_CALLER)).get('opp_loop');
    // With no research claim behind it, the controller leads with one of its own counter-models, not a given hypothesis.
    expect(before?.prior.leadingHypothesis).toMatch(/^fails:/);
    expect(before?.prior.methodId).not.toBeNull();

    // Run 2: the market took it after that decision — delivery of an agreed sale began — which contradicts what it led with.
    const ready = { ...open, state: 'DELIVERING', updatedAt: '2026-11-16T00:00:00.000Z' };
    const second = await runSprintBenchmark({ read: async () => [ready], previous: async () => null, sendNeeds, now: () => new Date('2026-11-17T00:00:00.000Z') });
    expect(second.loop.resultsTracked).toBe(1);
    expect(second.loop.methodChanges).toBe(1);
    expect(second.loop.capabilityGaps).toBe(1);
    expect(second.loop.errors).toEqual([]);

    const rows = await getDb().all<{ event_type: string; outcome: string; measures: string }>(
      `SELECT event_type, outcome, measures FROM bin_events WHERE workload_class = ? ORDER BY at ASC, id ASC`,
      [SPRINT_CALLER],
    );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('REASONING_CONTROLLER_RESULT');
    expect(types).toContain('METHOD_OUTCOME');
    expect(types).toContain('METHOD_CAPABILITY_GAP');
    expect(rows.find((r) => r.event_type === 'METHOD_OUTCOME')?.outcome).toBe('FAILED');
    const changed = rows.filter((r) => r.event_type === 'REASONING_CONTROLLER_DECISION').map((r) => JSON.parse(r.measures).decision);
    expect(changed).toHaveLength(2);
    expect(changed[1].methodChange.from).toBe(before!.prior.methodId);
    expect(changed[1].capabilityGap).not.toBeNull();
    expect(changed[1].excludedMethods).toContain(before!.prior.methodId);

    // The result is tracked once: a third run with nothing new tracks nothing and decides nothing again.
    const third = await runSprintBenchmark({ read: async () => [ready], previous: async () => null, sendNeeds, now: () => new Date('2026-11-18T00:00:00.000Z') });
    expect(third.loop.resultsTracked).toBe(0);
    expect(third.loop.decisions).toBe(0);
    const [event] = await listImprovementEvents({ kinds: [SPRINT_EVENT], limit: 1 });
    expect(event?.detail['loop']).toBeDefined();
  });

  it('reads a result only from the row changing after the decision, and only once production has said', () => {
    const p = problem({ id: 'opp_x', state: 'DECLINED', updatedAt: '2026-11-02T00:00:00.000Z' });
    const history = { problemId: 'opp_x', decidedAt: '2026-11-01T00:00:00.000Z', prior: { methodId: 'm', representation: 'm', leadingHypothesis: 'pathway-holds', excludedMethods: [] }, results: [] };
    expect(productionOutcome(p, 'pathway-holds')).toBe('CONTRADICTED');
    expect(productionOutcome({ state: 'EVIDENCE_CARD' }, 'pathway-holds')).toBeNull();
    expect(pendingResult(p, history)?.outcome).toBe('CONTRADICTED');
    expect(pendingResult({ ...p, updatedAt: '2026-10-31T00:00:00.000Z' }, history)).toBeNull();
    expect(pendingResult(p, { ...history, results: [{ actionKey: 'k', hypothesisId: 'pathway-holds', outcome: 'CONTRADICTED', evidence: 'e', at: 'x', decisionAt: history.decidedAt }] })).toBeNull();
    expect(chooseDemonstrated([p], new Map([['opp_x', history]]))).toHaveLength(1);
  });
});

describe('competing hypotheses are generated from the mechanism and weighed only on sourced research claims (repair-F3)', () => {
  it('a complete card with no research claim behind it has no evidence: card fields are not evidence', () => {
    const p = problem({ sourceClaimId: null });
    const ctx = contextFor(p, knowledgeFor([]));
    const decision = decideNext(controllerSnapshotOf(p, ctx));
    const holds = decision.hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    expect(holds.supports).toEqual([]);
    expect(holds.refutes).toEqual([]);
    expect(decision.hypotheses.map((h) => h.id)).not.toContain('pathway-holds');
    expect(decision.hypotheses.map((h) => h.id)).not.toContain('pathway-fails');
    const v = GENERAL_METHOD.run(p, 0.5, ctx);
    expect(v.actionable).toBe(false);
    expect(v.probability).toBe(0.5);
    expect(controllerSnapshotOf(p, ctx).evidence).toEqual([]);
  });

  it('generates one counter-model per applicable mechanism role, and a supported claim refutes those it evidences', () => {
    const p = problem();
    const decision = decideNext(controllerSnapshotOf(p, contextFor(p)));
    const ids = decision.hypotheses.map((h) => h.id);
    for (const role of ['initiator', 'access', 'rights', 'riskBearer', 'trigger', 'deliverer', 'moneyMovement', 'failure', 'reusable']) {
      expect(ids).toContain(`fails:${role}`);
    }
    const holds = decision.hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    expect(holds.supports).toEqual([`claim:${p.sourceClaimId}`]);
    expect(decision.leadingHypothesis).toBe(MECHANISM_HOLDS);
    const trigger = decision.hypotheses.find((h) => h.id === 'fails:trigger')!;
    expect(trigger.refutes).toEqual([`claim:${p.sourceClaimId}`]);
    // A role nothing evidences stays at its prior: unknown, not counted against.
    const rights = decision.hypotheses.find((h) => h.id === 'fails:rights')!;
    expect(rights.supports).toEqual([]);
    expect(rights.refutes).toEqual([]);
  });

  it('the score is a function of distinct sourced claims, not of how many card fields are filled', () => {
    const full = problem();
    const sparse = problem({ reachableChannel: null, buyingSignal: null, fulfillmentOwner: null, paymentTerms: null });
    const a = decideNext(controllerSnapshotOf(full, contextFor(full))).hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    const b = decideNext(controllerSnapshotOf(sparse, contextFor(sparse))).hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    expect(a.score).toBe(b.score);
    expect(a.supports).toHaveLength(1);
  });

  it('a contested claim behind the card supports the counter-models and refutes the pathway', () => {
    const p = problem();
    const ctx = contextFor(p, knowledgeFor([p], { contradictionState: 'CONTESTED', contradictionNote: 'the buyer withdrew the request' }));
    const decision = decideNext(controllerSnapshotOf(p, ctx));
    const holds = decision.hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    expect(holds.refutes).toEqual([`claim:${p.sourceClaimId}`]);
    expect(decision.hypotheses.find((h) => h.id === 'fails:initiator')!.supports).toEqual([`claim:${p.sourceClaimId}`]);
    expect(decision.leadingHypothesis).not.toBe(MECHANISM_HOLDS);
    expect(GENERAL_METHOD.run(p, 0.5, ctx).actionable).toBe(false);
  });

  it('an unsourced claim is not evidence, whatever it says', () => {
    const p = problem();
    const ctx = contextFor(p, knowledgeFor([p], { sourceUrl: null, sourced: false }));
    const holds = decideNext(controllerSnapshotOf(p, ctx)).hypotheses.find((h) => h.id === MECHANISM_HOLDS)!;
    expect(holds.supports).toEqual([]);
    expect(GENERAL_METHOD.run(p, 0.5, ctx).actionable).toBe(false);
  });

  it('the production run weighs every scored opening on its project knowledge', async () => {
    const ps = population();
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      knowledge: async () => knowledgeFor([]),
      record: async () => {},
      recordDecision: async () => {},
      recordProvenance: async () => {},
      registerDirected: async () => ({ candidate: { id: 'imc_x' } }),
      learning: async () => ({ catalogue: [], outcomes: [], procedures: [] }),
      history: async () => new Map(),
      recordResult: async () => {},
      recordProcedure: async () => {},
      sendNeeds: (async () => []) as never,
      now: () => NOW,
    });
    // With no research claims at all, the general method calls nothing actionable, however complete the cards are.
    for (const r of run.readings.filter((x) => x.method === GENERAL_METHOD.key)) expect(r.actionablePathwayRate.numerator).toBe(0);
  });
});
