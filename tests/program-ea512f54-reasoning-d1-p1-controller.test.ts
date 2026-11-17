import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  decideNext,
  foldControllerHistory,
  handOff,
  priorOf,
  readControllerHistory,
  recordActionResult,
  recordControllerDecision,
  runController,
  valueActions,
  type CandidateAction,
  type ControllerSnapshot,
} from '../server/services/research/reasoningController.ts';
import { SEED_METHODS, type ProblemProfile } from '../server/services/research/methodLibrary.ts';
import type { KnowledgeReading, MechanismModel } from '../server/services/research/knowledgeModel.ts';

const problem: ProblemProfile = {
  id: 'prob-1',
  domain: 'equipment-resale',
  question: 'can a resale of idle equipment pay within 30 days',
  features: [
    { feature: 'transaction-question', source: 'https://example.test/listing' },
    { feature: 'multi-party', source: 'https://example.test/listing' },
    { feature: 'time-to-cash', source: 'https://example.test/terms' },
  ],
  available: ['payment-terms'],
};

const claim = (id: string, facet: string, status: KnowledgeReading['claims'][number]['status'], reason: string): KnowledgeReading['claims'][number] => ({
  id,
  facet,
  text: `${facet} claim`,
  status,
  reason,
  provenance: { sourceUrl: `https://example.test/${id}`, sourceTitle: null, publisher: null, publishedAt: null, retrievedAt: '2026-11-01T00:00:00.000Z', retrievalState: 'READ', lane: null, primary: true },
  scope: { geography: null, timeframe: null, population: null, definition: null },
  related: [],
});

const knowledge: KnowledgeReading = {
  subject: 'equipment-resale',
  claims: [claim('c1', 'prices', 'SUPPORTED', 'sourced'), claim('c2', 'timing', 'CONFLICTING', 'two sources disagree on payment days')],
  facets: [],
  needs: ['timing', 'buyer_behaviour'],
  evidence: { claims: 2, sources: 2, primary: 2, byRetrieval: { READ: 2 } },
};

const mechanism = {
  roles: [
    { role: 'moneyMovement', question: 'How does money move?', nodes: [], status: 'UNKNOWN', reason: 'no evidence' },
    { role: 'initiator', question: 'Who initiates the transaction?', nodes: [], status: 'KNOWN', reason: 'sourced' },
  ],
  unknown: ['moneyMovement'],
} as unknown as MechanismModel;

const actions: CandidateAction[] = [
  { key: 'ask-terms', kind: 'RESEARCH', subject: 'payment timing', question: 'How many days until a buyer pays?', resolves: 'days', discriminates: ['holds:time-to-cash', 'fails:moneyMovement'], cost: 0.05 },
  { key: 'ask-colour', kind: 'RESEARCH', subject: 'paint colour', question: 'What colour is it?', resolves: 'colour', discriminates: [], cost: 0 },
];

const snapshot = (over: Partial<ControllerSnapshot> = {}): ControllerSnapshot => ({
  problem,
  knowledge,
  mechanism,
  catalogue: SEED_METHODS,
  outcomes: [],
  evidence: [
    { id: 'c1', source: 'https://example.test/c1', bears: { 'holds:time-to-cash': 'SUPPORTS' } },
    { id: 'c2', source: 'https://example.test/c2', bears: { 'fails:moneyMovement': 'SUPPORTS' } },
    { id: 'rumour', source: null, bears: { 'holds:time-to-cash': 'REFUTES' } },
  ],
  actions,
  now: '2026-11-16T00:00:00.000Z',
  ...over,
});

describe('the controller reasons about one problem end to end', () => {
  it('returns needs, failure modes, a method and representation with reasons, a decomposition and competing scored hypotheses', () => {
    const d = decideNext(snapshot());
    expect(d.informationNeeds).toEqual(['timing', 'buyer_behaviour', 'mechanism:moneyMovement']);
    expect(d.failureModes.map((f) => f.kind)).toEqual(expect.arrayContaining(['CONFLICTING_EVIDENCE', 'UNKNOWN_MECHANISM']));
    expect(d.method?.methodId).toBe('time-to-cash');
    expect(d.method?.reasons.length).toBeGreaterThan(0);
    expect(d.representation?.why).toBeTruthy();
    expect(d.alternativeRepresentations.length).toBeGreaterThan(0);
    expect(d.decomposition.map((s) => s.key)).toEqual(expect.arrayContaining(['need:timing', 'role:moneyMovement', 'conflict:timing']));
    expect(d.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(new Set(d.hypotheses.map((h) => h.basis)).size).toBe(d.hypotheses.length);
    const holds = d.hypotheses.find((h) => h.id === 'holds:time-to-cash')!;
    expect(holds.supports).toEqual(['c1']);
    expect(holds.refutes).toEqual([]); // the unsourced rumour is not evidence
  });
});

describe('the next action is chosen by decision value', () => {
  it('chooses the most valuable action and never one whose answer cannot change the decision', () => {
    const d = decideNext(snapshot());
    expect(d.next?.key).toBe('ask-terms');
    expect(d.valued.find((a) => a.key === 'ask-colour')?.value).toBe(0);
    const onlyIrrelevant = decideNext(snapshot({ actions: [actions[1]!] }));
    expect(onlyIrrelevant.next).toBeNull();
    expect(onlyIrrelevant.verdict).toBe('DECIDE');
  });

  it('uses the value of information when a quantitative model gives paired samples', () => {
    const n = 400;
    const days = Array.from({ length: n }, (_, i) => (i * 7919) % 60);
    const colour = Array.from({ length: n }, (_, i) => (i * 104729) % 5);
    const sell = days.map((d) => (d <= 30 ? 10 : -10));
    const hold = days.map(() => 0);
    const valued = valueActions(
      [
        { key: 'days', kind: 'RESEARCH', subject: 'd', question: 'q', resolves: 'days', discriminates: [], cost: 0 },
        { key: 'colour', kind: 'RESEARCH', subject: 'c', question: 'q', resolves: 'colour', discriminates: [], cost: 0 },
      ],
      [],
      { inputs: [{ key: 'days', values: days }, { key: 'colour', values: colour }], actions: [{ key: 'sell', scores: sell }, { key: 'hold', scores: hold }] },
    );
    expect(valued[0]!.key).toBe('days');
    expect(valued[0]!.valueBasis).toBe('INFORMATION_VALUE');
    expect(valued[0]!.value).toBeGreaterThan(0);
    expect(valued.find((a) => a.key === 'colour')!.value).toBe(0);
  });
});

describe('a result that invalidates the reasoning changes the method', () => {
  it('switches method and records the invalidation as the reason', () => {
    const first = decideNext(snapshot());
    const second = decideNext(
      snapshot({
        prior: priorOf(first),
        results: [{ actionKey: 'ask-terms', hypothesisId: first.leadingHypothesis!, outcome: 'CONTRADICTED', evidence: 'https://example.test/buyer-reply', at: '2026-11-16T01:00:00.000Z' }],
      }),
    );
    expect(second.methodChange?.from).toBe(first.method?.methodId);
    expect(second.methodChange?.to).not.toBe(first.method?.methodId);
    expect(second.methodChange?.reason).toContain('contradicted');
    expect(second.excludedMethods).toContain(first.method?.methodId);
    expect(second.failureModes.some((f) => f.kind === 'METHOD_INVALIDATED')).toBe(true);
    expect(second.capabilityGap?.requestsDomainFacts).toBe(false);
  });

  it('turns a problem no method fits into a method-gap action rather than a request for facts', () => {
    const d = decideNext(
      snapshot({
        problem: { ...problem, features: [{ feature: 'risk-transfer-chain', source: 'https://example.test/k' }], available: [] },
        actions: [],
        hypotheses: [{ id: 'h-a', statement: 'prime carries risk', basis: 'given:a' }, { id: 'h-b', statement: 'sub carries risk', basis: 'given:b' }],
      }),
    );
    expect(d.failureModes.some((f) => f.kind === 'NO_FITTING_METHOD')).toBe(true);
    expect(d.next?.kind).toBe('METHOD_GAP');
  });
});

describe('it adds no store or engine: rows go through the existing writer, actions to existing owners', () => {
  it('records the decision and hands a research need to sendNeeds', async () => {
    await freshProject();
    const sent: unknown[] = [];
    const { decision, handOff: handed } = await runController(snapshot(), { projectId: null, actorRef: 'test' }, {});
    expect(handed.to).toBe('NONE'); // no project named: nothing sent, and it says why
    const rows = await getDb().all<{ outcome: string }>(`SELECT outcome FROM bin_events WHERE event_type = 'REASONING_CONTROLLER_DECISION'`);
    expect(rows.map((r) => r.outcome)).toEqual(['ACT_ON_NEXT']);
    const again = await handOff(decision, { projectId: 'prj_x', actorRef: 'test', orchestrationId: 'orc_1' }, {
      sendNeeds: async (input) => {
        sent.push(input);
        return [{ subject: input.needs[0]!.subject, sent: true, to: 'RESEARCH_UNCERTAINTY', ref: 'unc_1', created: true }];
      },
    });
    expect(again.to).toBe('RESEARCH');
    expect(sent).toHaveLength(1);
  });

  it('hands a FACTORY action to the improvement loop registration, and a method gap to the library rows', async () => {
    await freshProject();
    const factoryDecision = decideNext(snapshot({ actions: [{ ...actions[0]!, kind: 'FACTORY' }] }));
    const registered: string[] = [];
    const f = await handOff(factoryDecision, { projectId: null, actorRef: 't' }, {
      registerDirected: async (w) => {
        registered.push(w.key);
        return { candidate: { id: 'imc_1' }, created: true };
      },
    });
    expect(f).toEqual({ to: 'FACTORY', candidateId: 'imc_1', created: true });
    expect(registered[0]).toContain('reasoning:');

    const gapDecision = decideNext(snapshot({ problem: { ...problem, features: [{ feature: 'risk-transfer-chain', source: 's' }], available: [] }, actions: [] }));
    const g = await handOff(gapDecision, { projectId: null, actorRef: 't' });
    expect(g.to).toBe('METHOD_GAP');
    const rows = await getDb().all<{ event_type: string }>(`SELECT event_type FROM bin_events WHERE event_type IN ('METHOD_CAPABILITY_GAP','METHOD_DECLARED') ORDER BY event_type`);
    expect(rows.map((r) => r.event_type)).toEqual(['METHOD_CAPABILITY_GAP', 'METHOD_DECLARED']);
  });

  it('tracks a result as a row and as a method outcome the library learns from', async () => {
    await freshProject();
    const d = decideNext(snapshot());
    await recordActionResult({ actionKey: 'ask-terms', hypothesisId: d.leadingHypothesis!, outcome: 'CONTRADICTED', evidence: 'e', at: '2026-11-16T02:00:00.000Z' }, d, problem);
    const rows = await getDb().all<{ event_type: string; outcome: string }>(`SELECT event_type, outcome FROM bin_events WHERE event_type IN ('REASONING_CONTROLLER_RESULT','METHOD_OUTCOME') ORDER BY event_type`);
    expect(rows).toEqual([
      { event_type: 'METHOD_OUTCOME', outcome: 'FAILED' },
      { event_type: 'REASONING_CONTROLLER_RESULT', outcome: 'CONTRADICTED' },
    ]);
  });
});

describe('the controller reads its own history back, so a later decision consumes earlier results', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('folds decisions and results per problem, a later decision resetting the results it consumed', async () => {
    await freshProject();
    const first = decideNext(snapshot());
    await recordControllerDecision(first, { caller: 'history-test' });
    const result = { actionKey: 'ask-terms', hypothesisId: first.leadingHypothesis!, outcome: 'CONTRADICTED' as const, evidence: 'e', at: '2026-11-16T03:00:00.000Z', decisionAt: first.at };
    await recordActionResult(result, first, problem, { caller: 'history-test' });
    const history = await readControllerHistory('history-test');
    const h = history.get(problem.id);
    expect(h?.prior).toEqual(priorOf(first));
    expect(h?.decidedAt).toBe(first.at);
    expect(h?.results).toEqual([result]);
    expect((await readControllerHistory('another-caller')).size).toBe(0);

    // The decision taken with that result changes method, and its own row resets what is pending.
    const second = decideNext(snapshot({ prior: h!.prior, results: h!.results, now: '2026-11-16T04:00:00.000Z' }));
    expect(second.methodChange).not.toBeNull();
    const folded = foldControllerHistory([
      { eventType: 'REASONING_CONTROLLER_DECISION', measures: { decision: first } },
      { eventType: 'REASONING_CONTROLLER_RESULT', measures: { problemId: problem.id, result } },
      { eventType: 'REASONING_CONTROLLER_DECISION', measures: { decision: second } },
    ]);
    expect(folded.get(problem.id)?.results).toEqual([]);
    expect(folded.get(problem.id)?.prior.excludedMethods).toContain(first.method!.methodId);
  });

  it('folds the same history whatever order rows written in one millisecond come back in', () => {
    const first = decideNext(snapshot());
    const result = { actionKey: 'ask-terms', hypothesisId: first.leadingHypothesis!, outcome: 'CONTRADICTED' as const, evidence: 'e', at: first.at, decisionAt: first.at };
    const second = decideNext(snapshot({ prior: priorOf(first), results: [result], now: '2026-11-16T04:00:00.000Z' }));
    const D1 = { eventType: 'REASONING_CONTROLLER_DECISION', measures: { decision: first } };
    const R1 = { eventType: 'REASONING_CONTROLLER_RESULT', measures: { problemId: problem.id, result, decisionAt: first.at } };
    const D2 = { eventType: 'REASONING_CONTROLLER_DECISION', measures: { decision: second } };
    // The result belongs to the first decision even when its row precedes it.
    for (const order of [[D1, R1], [R1, D1]]) {
      const h = foldControllerHistory(order).get(problem.id);
      expect(h?.decidedAt).toBe(first.at);
      expect(h?.results).toEqual([result]);
    }
    // Once the second decision exists, the consumed result is never pending again, in any order.
    for (const order of [[D1, R1, D2], [D1, D2, R1], [R1, D2, D1], [D2, R1, D1], [D2, D1, R1], [R1, D1, D2]]) {
      const h = foldControllerHistory(order).get(problem.id);
      expect(h?.decidedAt).toBe(second.at);
      expect(h?.results).toEqual([]);
    }
  });

  it('reads rows that share one millisecond back deterministically from the store', async () => {
    await freshProject();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T06:00:00.000Z'));
    const first = decideNext(snapshot({ now: '2026-11-16T06:00:00.000Z' }));
    const result = { actionKey: 'ask-terms', hypothesisId: first.leadingHypothesis!, outcome: 'CONTRADICTED' as const, evidence: 'e', at: '2026-11-16T06:00:00.000Z', decisionAt: first.at };
    const second = decideNext(snapshot({ prior: priorOf(first), results: [result], now: '2026-11-16T06:00:00.001Z' }));
    await recordControllerDecision(first, { caller: 'tie-test' });
    await recordActionResult(result, first, problem, { caller: 'tie-test' });
    const before = (await readControllerHistory('tie-test')).get(problem.id);
    expect(before?.results).toEqual([result]);
    await recordControllerDecision(second, { caller: 'tie-test' });
    const rows = await getDb().all<{ at: string }>(`SELECT DISTINCT at FROM bin_events WHERE workload_class = 'tie-test'`);
    expect(rows).toHaveLength(1);
    const after = (await readControllerHistory('tie-test')).get(problem.id);
    expect(after?.decidedAt).toBe(second.at);
    expect(after?.results).toEqual([]);
  });

  it('records the absent capability when a result invalidates the method, whatever the next action is', async () => {
    await freshProject();
    const first = decideNext(snapshot());
    const results = [{ actionKey: 'ask-terms', hypothesisId: first.leadingHypothesis!, outcome: 'CONTRADICTED' as const, evidence: 'e', at: '2026-11-16T05:00:00.000Z' }];
    const { decision } = await runController(snapshot({ prior: priorOf(first), results }), { projectId: null, actorRef: 't' });
    expect(decision.methodChange).not.toBeNull();
    expect(decision.next?.kind).not.toBe('METHOD_GAP');
    const rows = await getDb().all<{ event_type: string }>(`SELECT event_type FROM bin_events WHERE event_type = 'METHOD_CAPABILITY_GAP'`);
    expect(rows).toHaveLength(1);
  });
});
