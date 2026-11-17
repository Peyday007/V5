import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { listImprovementEvents } from '../server/repos/improvement.ts';
import {
  BASELINE_METHOD,
  DIMENSIONAL_VALIDATION,
  EXPIRED_WINDOW_COUNTER_MODEL,
  GENERAL_METHOD,
  RECALIBRATION,
  SPRINT_CAPABILITY_EVENT,
  readOwnerInterventions,
  trialCapabilities,
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

/** Openings whose deadline passed before their card was last touched: complete cards that never became pathways. */
const withExpired = (): SprintProblem[] => [
  ...population(),
  ...Array.from({ length: 40 }, () => problem({ state: 'DISCOVERED', deadline: '2026-10-15T00:00:00.000Z' })),
];

describe('the sprint implements and verifies a capability, not only measures (repair F6)', () => {
  it('picks the highest-leverage capability on the benchmark and adopts it only when held-out problems improve', () => {
    const ps = withExpired();
    const split = splitProblems(ps, null);
    const threshold = chooseThreshold(split.BENCHMARK);
    const out = trialCapabilities({ split, threshold, adopted: [], library: [RECALIBRATION, DIMENSIONAL_VALIDATION, EXPIRED_WINDOW_COUNTER_MODEL], ranAt: '2026-11-17T00:00:00.000Z' });
    const trial = out.trials.find((t) => t.capability === EXPIRED_WINDOW_COUNTER_MODEL.key);
    expect(trial?.verdict).toBe('ADOPTED');
    expect(trial!.heldOut.after!).toBeLessThan(trial!.heldOut.before!);
    expect(trial!.benchmark.after!).toBeLessThan(trial!.benchmark.before!);
    expect(trial!.change).toBe('capability:counter-model:expired-window@2026-11-17T00:00:00.000Z');
    expect(out.adopted).toContain(EXPIRED_WINDOW_COUNTER_MODEL.key);
  });

  it('rejects a capability that helps the benchmark but not held-out problems, and reverts an adopted one the results invalidate', () => {
    const ps = withExpired();
    const split = splitProblems(ps, null);
    // On held-out problems the world is the reverse of the benchmark: expired openings closed and complete open ones did not.
    const flip = (q: SprintProblem) => (q.deadline ? { ...q, state: 'COLLECTED' } : q.state === 'READY' ? { ...q, state: 'DISCOVERED' } : q);
    const skewed = { ...split, HELD_OUT: split.HELD_OUT.map(flip), NEW_HELD_OUT: split.NEW_HELD_OUT.map(flip) };
    const threshold = chooseThreshold(split.BENCHMARK);
    const library = [EXPIRED_WINDOW_COUNTER_MODEL];
    const fresh = trialCapabilities({ split: skewed, threshold, adopted: [], library, ranAt: 'r1' });
    expect(fresh.trials[0]?.verdict).toBe('REJECTED');
    expect(fresh.adopted).toEqual([]);
    const reverted = trialCapabilities({ split: skewed, threshold, adopted: [EXPIRED_WINDOW_COUNTER_MODEL.key], library, ranAt: 'r2' });
    expect(reverted.trials[0]?.verdict).toBe('REVERTED');
    expect(reverted.adopted).toEqual([]);
  });

  it('carries an adopted capability into the next run and records each trial as its own linked row', async () => {
    await freshProject();
    const ps = withExpired();
    const deps = {
      read: async () => ps,
      recordDecision: async () => {},
      recordProvenance: async () => {},
      interventions: async () => new Map<string, number>(),
      registerDirected: async () => ({ candidate: { id: 'imc_x' } }),
    };
    const first = await runSprintBenchmark({ ...deps, capabilities: [EXPIRED_WINDOW_COUNTER_MODEL], previous: async () => null });
    expect(first.adoptedCapabilities).toContain(EXPIRED_WINDOW_COUNTER_MODEL.key);
    expect(first.readings[0]?.method).toContain(EXPIRED_WINDOW_COUNTER_MODEL.key);
    const rows = await listImprovementEvents({ kinds: [SPRINT_CAPABILITY_EVENT], limit: 10 });
    expect(rows.some((r) => r.detail['verdict'] === 'ADOPTED' && String(r.detail['change']).startsWith('capability:'))).toBe(true);
    const second = await runSprintBenchmark({ ...deps, capabilities: [EXPIRED_WINDOW_COUNTER_MODEL], previous: async () => ({ at: first.ranAt, cutoff: first.cutoff, adopted: first.adoptedCapabilities }) });
    expect(second.trials.find((t) => t.capability === EXPIRED_WINDOW_COUNTER_MODEL.key)?.verdict).toBe('RETAINED');
    expect(second.adoptedCapabilities).toContain(EXPIRED_WINDOW_COUNTER_MODEL.key);
  });
});

describe('false positives reach repair even when the general method wins (repair F6)', () => {
  it('registers the general method\'s false positives on a run where it earned its cost', async () => {
    await freshProject();
    const registered: Array<{ key: string; samples: string[] }> = [];
    // A few complete cards did not become pathways: the general method calls them, wrongly, and still beats the baseline.
    const ps = [...population(), ...Array.from({ length: 2 }, () => problem({ state: 'DISCOVERED' }))];
    const run = await runSprintBenchmark({
      read: async () => ps,
      previous: async () => null,
      capabilities: [],
      recordDecision: async () => {},
      recordProvenance: async () => {},
      interventions: async () => new Map<string, number>(),
      registerDirected: async (w) => {
        registered.push({ key: w.key, samples: w.samples });
        return { candidate: { id: `imc_${w.key}` } };
      },
    });
    // The general method's FP registration does not depend on it losing to the baseline.
    expect(registered.map((r) => r.key)).toContain('reasoning-sprint:false-positives');
    const fp = registered.find((r) => r.key === 'reasoning-sprint:false-positives');
    expect(fp?.samples.length).toBeGreaterThan(0);
    expect(run.falsePositiveCandidateId).toBe('imc_reasoning-sprint:false-positives');
  });
});

describe('required human interventions are counted from real owner rows, not modelled (repair F6)', () => {
  it('reads Needs-You requests inside each opening\'s life and keeps the method\'s projection separate', async () => {
    const { project } = await freshProject();
    const db = getDb();
    const inside = problem({ projectId: project.id, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
    const outside = problem({ projectId: project.id, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' });
    await db.run(
      `INSERT INTO russell_human_requests (id, project_id, authority_needed, why_not_russell, resume_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['rhr_sprint_1', project.id, 'APPROVAL', 'spend', 'rk_sprint_1', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z'],
    );
    const observed = await readOwnerInterventions([inside, outside]);
    expect(observed.get(inside.id)).toBe(1);
    expect(observed.get(outside.id)).toBe(0);
    const ps = [inside, outside, ...population().slice(0, 4)];
    const reading = readSet('HELD_OUT', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.7)), observed);
    expect(reading.humanInterventions).toMatchObject({ numerator: 1, denominator: 6 });
    expect(reading.projectedHumanInterventions.denominator).toBe(6);
    // Not read is not zero.
    const unread = readSet('HELD_OUT', GENERAL_METHOD.key, ps, ps.map((p) => GENERAL_METHOD.run(p, 0.7)));
    expect(unread.humanInterventions.value).toBe('INSUFFICIENT_DATA');
  });
});
