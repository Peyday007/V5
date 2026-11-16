/**
 * The Release 01 probes for ACQ-21-1, ACQ-21-2, ACQ-21-5, CONT-35 and
 * LEARN-15-1 judge production rows three ways: UNKNOWN while the rows do not
 * show the behaviour, FAIL on a row that contradicts it, PASS when they show it.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  browserCapabilitiesHold,
  methodSelectionHolds,
  separateCapabilitiesHold,
  type CapabilityEventRow,
  type JudgmentRow,
} from '../server/services/factory/program/release01/acquisitionProbe.ts';
import { continuityHolds, ledgerHolds, type AttemptRow } from '../server/services/factory/program/release01/continuityProbe.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { promotionHolds } from '../server/services/factory/program/release01/governanceProbe.ts';
import { decisionMemoryHolds, type ReadingRow } from '../server/services/factory/program/release01/memoryProbe.ts';

const at = '2026-11-13T00:00:00.000Z';
const judgment = (capability: string, outcome: string, route: string | null, reason = 'why'): JudgmentRow => ({
  provider: route,
  outcome,
  reason,
  measures: JSON.stringify({ capability, route }),
  at,
});

describe('the probes are registered in the protected module', () => {
  it.each(['r01.acq-21-1', 'r01.acq-21-2', 'r01.acq-21-5', 'r01.cont-35', 'r01.learn-15-1', 'r01.gov-11', 'r01.gov-22-1', 'r01.arch-01', 'r01.com-13-1', 'r01.opp-03', 'r01.cp-31', 'r01.mem-32', 'r01.chal-33', 'r01.res-07', 'r01.res-15-5', 'r01.goal-13-6', 'r01.goal-18-4', 'r01.goal-23', 'r01.meta-18-1', 'r01.int-38-authority'])('%s, and its query runs: UNKNOWN on an empty Brain', async (name) => {
    await freshProject();
    const probe = getProbe(name);
    expect(probe).not.toBeNull();
    expect((await probe!({})).ok).toBeNull();
  });
});

describe('ACQ-21-2: an access method selected per need, with why', () => {
  it('is UNKNOWN with no judgment, and with judgments that selected nothing', () => {
    expect(methodSelectionHolds([]).ok).toBeNull();
    expect(methodSelectionHolds([judgment('ACQUIRE', 'SEARCH_FIRST', null)]).ok).toBeNull();
  });
  it('fails a route that is not an access method, and a judgment with no reason', () => {
    expect(methodSelectionHolds([judgment('ACQUIRE', 'ROUTE_SELECTED', 'TELEPATHY')]).ok).toBe(false);
    expect(methodSelectionHolds([judgment('ACQUIRE', 'ROUTE_SELECTED', 'HTTP', ' ')]).ok).toBe(false);
  });
  it('passes on selected routes with their reasons', () => {
    const r = methodSelectionHolds([judgment('ACQUIRE', 'ROUTE_SELECTED', 'BULK'), judgment('OPERATE', 'ROUTE_SELECTED', 'BROWSER')]);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/BULK 1, BROWSER 1/);
  });
});

describe('ACQ-21-1: operating systems and acquiring information are separate capabilities', () => {
  it('fails a capability that is neither', () => {
    expect(separateCapabilitiesHold([judgment('PURCHASE', 'ROUTE_SELECTED', 'HTTP')]).ok).toBe(false);
  });
  it('is UNKNOWN until both are exercised and acquisition went beyond an API', () => {
    expect(separateCapabilitiesHold([judgment('ACQUIRE', 'ROUTE_SELECTED', 'NATIVE'), judgment('OPERATE', 'ROUTE_SELECTED', 'BROWSER')]).ok).toBeNull();
    expect(separateCapabilitiesHold([judgment('ACQUIRE', 'ROUTE_SELECTED', 'HTTP')]).ok).toBeNull();
  });
  it('passes when both are judged and information was acquired beyond an API', () => {
    expect(separateCapabilitiesHold([judgment('ACQUIRE', 'ROUTE_SELECTED', 'HTTP'), judgment('OPERATE', 'REFUSED', null)]).ok).toBe(true);
  });
});

describe('ACQ-21-5: browser routines as versioned capabilities', () => {
  const def = (hash = 'h1', version: unknown = 1): CapabilityEventRow => ({ event_type: 'BROWSER_CAPABILITY', outcome: 'DEFINED', measures: JSON.stringify({ host: 'x.test', name: 'n', version, contentHash: hash }), at });
  const decide = (outcome: string, hash = 'h1'): CapabilityEventRow => ({ event_type: 'BROWSER_CAPABILITY', outcome, measures: JSON.stringify({ host: 'x.test', name: 'n', contentHash: hash }), at });
  const run = (outcome: string, hash = 'h1'): CapabilityEventRow => ({ event_type: 'BROWSER_WORKFLOW_RUN', outcome, measures: JSON.stringify({ host: 'x.test', name: 'n', capability: { version: 1, contentHash: hash } }), at });
  it('is UNKNOWN until defined, approved and run', () => {
    expect(browserCapabilitiesHold([]).ok).toBeNull();
    expect(browserCapabilitiesHold([def()]).ok).toBeNull();
    expect(browserCapabilitiesHold([def(), decide('APPROVED')]).ok).toBeNull();
  });
  it('fails an unversioned definition, a run of an undefined version, and a completed run nobody approved', () => {
    expect(browserCapabilitiesHold([def('h1', null)]).ok).toBe(false);
    expect(browserCapabilitiesHold([def(), decide('APPROVED'), run('COMPLETED', 'h2')]).ok).toBe(false);
    expect(browserCapabilitiesHold([def(), run('COMPLETED')]).ok).toBe(false);
    expect(browserCapabilitiesHold([def(), decide('APPROVED'), decide('RETIRED'), run('COMPLETED')]).ok).toBe(false);
  });
  it('passes on an approved version that completed a verified run', () => {
    expect(browserCapabilitiesHold([def(), decide('APPROVED'), run('FAILED'), run('COMPLETED')]).ok).toBe(true);
  });
});

describe('CONT-35: interrupted, reconciled, never duplicated', () => {
  const a = (op: string, state: string, phase: string, outcome: string | null, receipt: string | null = null): AttemptRow => ({ operation_id: op, state, phase, outcome, receipt_ref: receipt });
  it('is UNKNOWN with no external effect, and while nothing interrupted has resolved', () => {
    expect(continuityHolds([]).ok).toBeNull();
    expect(continuityHolds([a('o1', 'SUCCEEDED', 'CONFIRMED', 'SUCCEEDED', 'r1')]).ok).toBeNull();
    expect(continuityHolds([a('o1', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN')]).ok).toBeNull();
  });
  it('fails a commitment made twice, and a confirmation without a receipt', () => {
    expect(continuityHolds([a('o1', 'SUCCEEDED', 'CONFIRMED', 'SUCCEEDED', 'r1'), a('o1', 'SUCCEEDED', 'CONFIRMED', 'SUCCEEDED', 'r2')]).ok).toBe(false);
    expect(continuityHolds([a('o1', 'SUCCEEDED', 'CONFIRMED', 'SUCCEEDED', null)]).ok).toBe(false);
  });
  it('passes on an interrupted effect reconciled to one outcome', () => {
    expect(continuityHolds([a('o1', 'SUCCEEDED', 'UNCERTAIN', 'UNCERTAIN'), a('o1', 'SUCCEEDED', 'CONFIRMED', 'SUCCEEDED', 'r1')]).ok).toBe(true);
  });
});

describe('LEARN-15-1: versioned predictions, exposures and observed outcomes', () => {
  const row = (ledger: string, r: Record<string, unknown>) => ({ measures: JSON.stringify({ ledger, row: r }) });
  const p = (id: string, claimId = 'cash:p:USD:revenue') => row('PREDICTION', { id, claimId, version: 1, outcome: 'revenue', population: 'p', comparableKey: 'k' });
  it('is UNKNOWN with nothing predicted, and with nothing yet observed', () => {
    expect(ledgerHolds([]).ok).toBeNull();
    expect(ledgerHolds([p('c@v1'), row('EXPOSURE', { predictionId: 'c@v1' })]).ok).toBeNull();
  });
  it('fails a prediction missing what it is about, and an outcome against an unrecorded version', () => {
    expect(ledgerHolds([row('PREDICTION', { id: 'c@v1', claimId: 'c', version: 1, outcome: '', population: 'p', comparableKey: 'k' })]).ok).toBe(false);
    expect(ledgerHolds([p('c@v1'), row('OUTCOME', { predictionId: 'c@v9', occurred: true })]).ok).toBe(false);
  });
  it('passes on versions with an observed outcome', () => {
    const r = ledgerHolds([p('c@v1'), p('c@v2'), row('OUTCOME', { predictionId: 'c@v2', occurred: false })]);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/2 version\(s\) of 1 claim\(s\) \(1 revised\)/);
  });
});

describe('GOV-22-1: promoted from a measured blocker, demoted with the requirement kept', () => {
  const ev = (kind: string, detail: Record<string, unknown>) => ({ kind, detail, at });
  it('is UNKNOWN with no promotion', () => {
    expect(promotionHolds([]).ok).toBeNull();
    expect(promotionHolds([ev('PROGRAM_CAPABILITY_DEMOTED', { requirement: 'X', requirementRetained: true })]).ok).toBeNull();
  });
  it('fails a promotion without its evidence or map version, and a demotion that dropped the requirement', () => {
    expect(promotionHolds([ev('PROGRAM_CAPABILITY_PROMOTED', { requirement: 'X', reasons: ['BLOCKED_TRANSACTIONS'], evidence: [], mapVersion: 3 })]).ok).toBe(false);
    expect(promotionHolds([ev('PROGRAM_CAPABILITY_PROMOTED', { requirement: 'X', reasons: ['r'], evidence: ['e'] })]).ok).toBe(false);
    expect(promotionHolds([ev('PROGRAM_CAPABILITY_DEMOTED', { requirement: 'X', requirementRetained: false })]).ok).toBe(false);
  });
  it('passes on a measured promotion applied to the map', () => {
    expect(promotionHolds([ev('PROGRAM_CAPABILITY_PROMOTED', { requirement: 'X', reasons: ['r'], evidence: ['3 blocked transactions'], mapVersion: 4 })]).ok).toBe(true);
  });
});

describe('CAUSAL-14-1..15-2: judged on the portfolios live goals compose', async () => {
  const c = await import('../server/services/factory/program/release01/causalProbe.ts');
  type PS = Parameters<typeof c.graphHolds>[0];
  const fig = (status: string, value: number | null, source: string | null) => ({ meaning: 'free', unit: 'cents', value, source, derivedFrom: [], status, window: null, geography: null });
  const member = (over: Record<string, unknown> = {}) => ({
    opportunityId: 'cop_1', title: 't', nodes: 4, relations: 3, actions: 1,
    route: { route: 'buyer pays on delivery', freeCents: fig('ASSUMED', 100, 'row:cop_1') },
    chain: { stages: [{}], outputUnits: 2, bindingConstraint: 'close', firstUnknown: null },
    discovered: [], unknowns: [],
    whatIf: [{ id: 'w1', opportunityId: 'cop_1', question: 'q', change: 'x', effects: [{ opportunityId: 'cop_1', title: 't', via: 'v', before: { a: 1 }, after: { a: 2 }, note: '' }], breaks: [], branch: null, unknowns: [] }],
    decomposition: [{ id: 's1', question: 'q', observable: 'a paid order', dependsOn: [], origin: 'starting', status: 'UNKNOWN' }],
    ...over,
  });
  const ps = (members: unknown[], extra: Record<string, unknown> = {}): PS => [{ goalId: 'g1', portfolio: { basis: 'COVERAGE', causal: { members, shared: [], account: {}, decisionUnknowns: [] }, assurance: { claimsAtLeast90: false, validationProblems: ['x'] }, marketHistory: [], ...extra } }] as unknown as PS;

  it.each(['r01.causal-14-1', 'r01.causal-14-2', 'r01.causal-14-3', 'r01.causal-14-4', 'r01.causal-14-5', 'r01.causal-14-7', 'r01.causal-15-2'])('%s is registered and UNKNOWN on an empty Brain', async (name) => {
    await freshProject();
    expect((await getProbe(name)!({})).ok).toBeNull();
  });
  it('passes a well-formed reading on every judgment', () => {
    const p = ps([member()]);
    for (const judge of [c.graphHolds, c.lineageHolds, c.chainHolds, c.whatIfHolds, c.assuranceHolds, c.calibrationHolds, c.decompositionHolds]) expect(judge(p).ok).toBe(true);
  });
  it('is UNKNOWN with no members, and with nothing propagated or decomposed', () => {
    expect(c.graphHolds(ps([])).ok).toBeNull();
    expect(c.whatIfHolds(ps([member({ whatIf: [] })])).ok).toBeNull();
    expect(c.decompositionHolds(ps([member({ decomposition: null })])).ok).toBeNull();
    expect(c.assuranceHolds(ps([member()], { assurance: null })).ok).toBeNull();
  });
  it('fails each contradiction', () => {
    expect(c.graphHolds(ps([member({ route: { route: ' ', freeCents: fig('UNKNOWN', null, null) } })])).ok).toBe(false);
    expect(c.lineageHolds(ps([member({ route: { route: 'r', freeCents: fig('EVIDENCED', 5, null) } })])).ok).toBe(false);
    expect(c.lineageHolds(ps([member({ route: { route: 'r', freeCents: fig('UNKNOWN', 5, null) } })])).ok).toBe(false);
    expect(c.chainHolds(ps([member({ chain: { stages: [{}], outputUnits: 3, bindingConstraint: null, firstUnknown: 'reply' } })])).ok).toBe(false);
    expect(c.assuranceHolds(ps([member()], { assurance: { claimsAtLeast90: true, validationProblems: ['an assumed rate'] } })).ok).toBe(false);
    expect(c.calibrationHolds(ps([member()], { assurance: { claimsAtLeast90: true, validationProblems: [] } })).ok).toBe(false);
    expect(c.decompositionHolds(ps([member({ decomposition: [{ id: 's', question: 'q', observable: ' ', dependsOn: [], origin: 'starting', status: 'UNKNOWN' }] })])).ok).toBe(false);
  });
});

describe('MEM-32: each plan reading kept as one complete, linked decision record', () => {
  const reading: ReadingRow = { id: 'gpr_1', workstream_id: 'ws_1', created_at: at };
  const record = (over: Record<string, unknown> = {}) => ({
    id: 'wse_gdr_gpr_1',
    workstream_id: 'ws_1',
    detail: JSON.stringify({
      schema: 1, readingId: 'gpr_1', goalId: 'ws_1', decision: 'Which plan?', chosen: 'A', verdict: 'ON_TRACK',
      alternatives: [{ key: 'A', chosen: true }], evidence: [{ kind: 'GOAL_TARGET', sourceRowId: 'ws_1', fingerprint: 'f' }],
      conditions: [], predicted: null, authority: { actor: 'BRAIN', verdict: 'IN_FORCE', reason: 'r' }, decidedAt: at, reason: 'because',
      chain: { evidence: ['GOAL_TARGET:ws_1'], actions: [], results: { by: 'goal_outcomes.reading_id', readingId: 'gpr_1' } },
      ...over,
    }),
  });
  const readings = new Map([[reading.id, reading]]);

  it('is UNKNOWN with no record, PASS with a complete one', () => {
    expect(decisionMemoryHolds([], readings).ok).toBeNull();
    expect(decisionMemoryHolds([record()], readings).ok).toBe(true);
  });

  it('fails a record that contradicts the requirement', () => {
    expect(decisionMemoryHolds([record()], new Map()).detail).toMatch(/does not exist/);
    expect(decisionMemoryHolds([{ ...record(), id: 'wse_gdr_other' }], readings).detail).toMatch(/not keyed/);
    expect(decisionMemoryHolds([record({ alternatives: undefined })], readings).ok).toBe(false);
    expect(decisionMemoryHolds([record({ evidence: [{ kind: 'GOAL_TARGET', sourceRowId: 'ws_1' }] })], readings).detail).toMatch(/fingerprint/);
    expect(decisionMemoryHolds([record({ reason: '' })], readings).detail).toMatch(/no reason/);
    expect(decisionMemoryHolds([record({ decidedAt: '2020-01-01T00:00:00.000Z' })], readings).detail).toMatch(/not dated/);
    expect(decisionMemoryHolds([record({ chain: { evidence: [], actions: [], results: { readingId: 'x' } } })], readings).detail).toMatch(/link evidence/);
    expect(decisionMemoryHolds([{ ...record(), detail: '{' }], readings).detail).toMatch(/not readable/);
  });
});

describe('MEM-32: the probe accepts what the writer actually writes', () => {
  it('passes a record built by decisionRecord.ts from a reading', async () => {
    const { buildDecisionRecord } = await import('../server/services/goals/decisionRecord.ts');
    const { governingFrom, policyVersions } = await import('../server/services/goals/ownerPolicy.ts');
    const reading = {
      id: 'gpr_w', workstream_id: 'wst_w', digest: 'd', scenario_model_id: null, scenario_run_id: null, verdict: 'CANDIDATE', chosen_strategy: 'S1',
      strategies: JSON.stringify([{ key: 'S1', label: 'Sell', verdict: 'CANDIDATE', opportunityIds: ['cop_w'], links: [{ link: 'PRICE', ok: false, basis: 'none' }], constraintsFailed: [] }]),
      next_test: null, forecast: null, created_at: at,
    } as Parameters<typeof buildDecisionRecord>[0]['reading'];
    const policy = governingFrom('wst_w', policyVersions('wst_w', [{ id: 'wse_p0', workstreamId: 'wst_w', kind: 'GOAL_TERMS_SET', summary: '', detail: {}, actorRef: 'person:usr_o', createdAt: '2026-11-01T00:00:00.000Z' }]));
    const record = buildDecisionRecord({ reading, facts: { opportunities: [{ id: 'cop_w', price_cents: 100, currency: 'USD', deadline: null }], cashNeeds: [] }, policy, pursued: [] });
    const event = { id: `wse_gdr_${reading.id}`, workstream_id: 'wst_w', detail: JSON.stringify(record) };
    const verdict = decisionMemoryHolds([event], new Map([[reading.id, { id: reading.id, workstream_id: 'wst_w', created_at: at }]]));
    expect(verdict.detail).toMatch(/1 decision record/);
    expect(verdict.ok).toBe(true);
  });
});

describe('CHAL-33: a recommendation challenged at the depth its consequence earns', () => {
  it('is UNKNOWN with nothing challenged, PASS on what the optimizer attaches, FAIL on a contradiction', async () => {
    const { challengeHolds } = await import('../server/services/factory/program/release01/challengeProbe.ts');
    const { optimizePortfolio } = await import('../server/services/quant/portfolio.ts');
    expect(challengeHolds([]).ok).toBeNull();
    const act = (key: string, cash: number, capital: number) => ({ key, label: key, cash: [cash], days: [2], justified: true, capital, evidence: { sampleSize: 10_000 } });
    const result = optimizePortfolio({ target: 1000, deadlineDays: 10, startingCapital: 1000, worlds: 200, activities: [act('big', 1500, 600), act('tiny', 150, 1)] });
    expect(result.assurance?.challenge).toBeTruthy();
    const of = (assurance: unknown) => [{ goalId: 'ws_1', portfolio: { assurance } as never }];
    const real = challengeHolds(of(result.assurance));
    expect(real.detail).toMatch(/challenged recommendation/);
    expect(real.ok).toBe(true);
    const c = result.assurance!.challenge!;
    expect(challengeHolds(of({ ...result.assurance, challenge: { ...c, verdict: 'CHALLENGE_FAILED', error: 'boom' } })).ok).toBe(false);
    expect(challengeHolds(of({ ...result.assurance, challenge: { ...c, scrutiny: { ...c.scrutiny, tier: 'NONE' } } })).ok).toBe(false);
    expect(challengeHolds(of({ ...result.assurance, challenge: { ...c, steps: [{ key: 's', scrutiny: { tier: 'DEEP' }, mayProceed: false, heldBy: [] }] } })).detail).toMatch(/held without/);
    expect(challengeHolds(of({ ...result.assurance, challenge: { ...c, independentValidation: null } })).detail).toMatch(/self-agreement/);
  });
});

describe('the construction-reading probes run on a fresh Brain', () => {
  // Construction composes arrangements from the seeded map even on a fresh project, so these read real
  // compositions there: registered, runnable, and never FAIL on what the running code builds.
  it.each(['r01.res-15-4', 'r01.com-13-2'])('%s', async (name) => {
    await freshProject();
    const probe = getProbe(name);
    expect(probe).not.toBeNull();
    const r = await probe!({});
    expect(r.ok, r.detail).not.toBe(false);
  }, 60_000);
});

describe('RES-07, RES-15-5, RES-15-4, GOAL-13-6, GOAL-18-4, GOAL-23, COM-13-2, META-18-1 judged on rows', () => {
  const shares = { BROAD_DISCOVERY: 0.2, TRANSACTION_ROUTES: 0.3, OPERATING_SUPPORT: 0.2, SELF_IMPROVEMENT: 0.15, FORWARD_EXPLORATION: 0.15 };
  const floors = { exploration: 0.15, systemHealth: 0.1, commercial: 0.2, perPurpose: 0.03 };
  const decision = (over: Record<string, unknown> = {}) => ({ fingerprint: 'fp', held: false, shares, floors, changes: [{ purpose: 'TRANSACTION_ROUTES', from: 0.2, to: 0.3, reasons: ['yield'] }], costCountedOnce: { holds: true }, ...over });

  it('RES-07: UNKNOWN when held or unchanged, PASS on a reallocation within floors, FAIL under a floor', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    expect(m.continuousResearchHolds([]).ok).toBeNull();
    expect(m.continuousResearchHolds([decision({ held: true })]).ok).toBeNull();
    expect(m.continuousResearchHolds([decision({ changes: [] })]).ok).toBeNull();
    expect(m.continuousResearchHolds([decision()]).ok).toBe(true);
    expect(m.continuousResearchHolds([decision({ shares: { ...shares, BROAD_DISCOVERY: 0.05, FORWARD_EXPLORATION: 0.05, OPERATING_SUPPORT: 0.45 } })]).detail).toMatch(/exploration/);
    expect(m.continuousResearchHolds([decision({ shares: { ...shares, OPERATING_SUPPORT: undefined } })]).ok).toBe(false);
  });

  it('RES-15-5: cost counted once and every move reasoned', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    expect(m.yieldAllocationHolds([decision()]).ok).toBe(true);
    expect(m.yieldAllocationHolds([decision({ costCountedOnce: { holds: false } })]).ok).toBe(false);
    expect(m.yieldAllocationHolds([decision({ changes: [{ purpose: 'X', reasons: [] }] })]).ok).toBe(false);
  });

  it('RES-15-4: one question per position, never re-asking what is established', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    expect(m.positionResearchHolds([{ key: 'a' }]).ok).toBeNull();
    const q = (over: Record<string, unknown> = {}) => ({ kind: 'POSITION', position: 'broker', asks: ['price'], established: ['payer'], question: 'q', ...over });
    expect(m.positionResearchHolds([{ key: 'a', positionQuestions: [q(), q({ position: 'reseller' })] }]).ok).toBe(true);
    expect(m.positionResearchHolds([{ key: 'a', positionQuestions: [q({ asks: ['payer'] })] }]).detail).toMatch(/asks again/);
    expect(m.positionResearchHolds([{ key: 'a', positionQuestions: [q({ kind: 'CONVERSION' })] }]).ok).toBe(false);
  });

  it('GOAL-13-6, GOAL-18-4, GOAL-23 on recorded readings', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    const tl = (hs: unknown[]) => ({ timelines: { horizons: hs } });
    expect(m.compressedTimelinesHold([]).ok).toBeNull();
    expect(m.compressedTimelinesHold([tl([{ days: 7, reach: 0.4, reachBasis: 'COVERAGE' }, { days: 30, reach: null, reachBasis: null }])]).ok).toBe(true);
    expect(m.compressedTimelinesHold([tl([{ days: 7, reach: 0.4, reachBasis: null }, { days: 30, reach: 0.9, reachBasis: 'COVERAGE' }])]).ok).toBe(false);
    const obj = (outcome: unknown) => ({ objective: { requiredConfidence: 0.9, outcome } });
    expect(m.overperformanceHolds([obj({ expected: 10, upper: 20, adverse: 5, status: 'CANDIDATE' })]).ok).toBe(true);
    expect(m.overperformanceHolds([obj({ expected: 10, upper: 8, adverse: 5, status: 'CANDIDATE' })]).ok).toBe(false);
    expect(m.overperformanceHolds([obj(null)]).ok).toBeNull();
    const set = (over: Record<string, unknown>) => ({ planSet: { candidates: 4, distinct: 2, accepted: 1, plans: [{ signature: 'a' }, { signature: 'b' }], ...over } });
    expect(m.distinctPlansHold([set({})]).ok).toBe(true);
    expect(m.distinctPlansHold([set({ plans: [{ signature: 'a' }, { signature: 'a' }] })]).ok).toBe(false);
    expect(m.distinctPlansHold([set({ distinct: 5 })]).ok).toBe(false);
    expect(m.distinctPlansHold([set({ distinct: 1, accepted: 0, plans: [{ signature: 'a' }] })]).ok).toBeNull();
  });

  it('COM-13-2 and META-18-1: absence is UNKNOWN, a contradiction FAIL', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    expect(m.leverageVerdict({ ok: false, detail: 'none', combinations: 0, revenueCeilingViolations: [] }).ok).toBeNull();
    expect(m.leverageVerdict({ ok: false, detail: 'x', combinations: 3, revenueCeilingViolations: ['p:a'] }).ok).toBe(false);
    expect(m.leverageVerdict({ ok: true, detail: 'x', combinations: 3, revenueCeilingViolations: [] }).ok).toBe(true);
    expect(m.anchoringVerdict({ ok: false, detail: 'vacuous', live: 3, discriminating: 0, violations: [] }).ok).toBeNull();
    expect(m.anchoringVerdict({ ok: false, detail: 'w', live: 3, discriminating: 1, violations: [{}] }).ok).toBe(false);
    expect(m.anchoringVerdict({ ok: true, detail: 'ok', live: 3, discriminating: 1, violations: [] }).ok).toBe(true);
  });
});

describe('INT-38-AUTHORITY: nothing performed is UNKNOWN, never a pass', () => {
  it('maps the joint reader', async () => {
    const m = await import('../server/services/factory/program/release01/researchGoalProbe.ts');
    expect(m.authorityIntegrationVerdict({ ok: true, detail: 'nothing performed yet under the ledger: …', counts: { effects: 0 } }).ok).toBeNull();
    expect(m.authorityIntegrationVerdict({ ok: true, detail: '3 lifecycle effect(s) …', counts: { effects: 3 } }).ok).toBe(true);
    expect(m.authorityIntegrationVerdict({ ok: false, detail: 'AUTH-34 does not hold', counts: { effects: 1 } }).ok).toBe(false);
  });
});
