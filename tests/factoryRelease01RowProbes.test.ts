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

const at = '2026-11-13T00:00:00.000Z';
const judgment = (capability: string, outcome: string, route: string | null, reason = 'why'): JudgmentRow => ({
  provider: route,
  outcome,
  reason,
  measures: JSON.stringify({ capability, route }),
  at,
});

describe('the probes are registered in the protected module', () => {
  it.each(['r01.acq-21-1', 'r01.acq-21-2', 'r01.acq-21-5', 'r01.cont-35', 'r01.learn-15-1'])('%s, and its query runs: UNKNOWN on an empty Brain', async (name) => {
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
