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

const at = '2026-11-13T00:00:00.000Z';
const judgment = (capability: string, outcome: string, route: string | null, reason = 'why'): JudgmentRow => ({
  provider: route,
  outcome,
  reason,
  measures: JSON.stringify({ capability, route }),
  at,
});

describe('the probes are registered in the protected module', () => {
  it.each(['r01.acq-21-1', 'r01.acq-21-2', 'r01.acq-21-5', 'r01.cont-35', 'r01.learn-15-1', 'r01.gov-11', 'r01.gov-22-1'])('%s, and its query runs: UNKNOWN on an empty Brain', async (name) => {
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
