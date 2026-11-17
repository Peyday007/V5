import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listImprovementEvents } from '../server/repos/improvement.ts';
import { readControllerHistory } from '../server/services/research/reasoningController.ts';
import {
  BASELINE_METHOD,
  GENERAL_METHOD,
  SPRINT_DISCLAIMER,
  SPRINT_CALLER,
  SPRINT_EVENT,
  chooseDemonstrated,
  chooseThreshold,
  pendingResult,
  productionOutcome,
  compareWithBaseline,
  readSet,
  readSprintProblems,
  runSprintBenchmark,
  splitProblems,
  sprintIfDue,
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
    ...over,
  };
};

/** A population where payer+price is present on dead openings too, so the baseline over-calls them. */
const population = (): SprintProblem[] => {
  const out: SprintProblem[] = [];
  for (let i = 0; i < 40; i++) out.push(problem());
  for (let i = 0; i < 40; i++) out.push(problem({ state: 'DISCOVERED', buyingSignal: null, paymentTerms: null, fulfillmentOwner: null }));
  for (let i = 0; i < 20; i++) out.push(problem({ state: 'EVIDENCE_CARD', payer: null, priceCents: null, reachableChannel: null }));
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
    expect(before?.prior.leadingHypothesis).toBe('pathway-fails');
    expect(before?.prior.methodId).not.toBeNull();

    // Run 2: production moved the opening to READY after that decision, which contradicts what it led with.
    const ready = { ...open, state: 'READY', updatedAt: '2026-11-16T00:00:00.000Z' };
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
