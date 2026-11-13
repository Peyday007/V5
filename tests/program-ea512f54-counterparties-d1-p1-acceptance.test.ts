import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import { clearPaymentReader } from '../server/services/cash/providers/payments.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { Counterparty, Fact } from '../server/services/labor/counterparties/ladder.ts';
import { withoutAuthority, type AuthorityReading, type ReservationEvent } from '../server/services/labor/counterparties/reservations.ts';
import { readTransaction, reservationKey, type TransactionInput } from '../server/services/labor/counterparties/transaction.ts';
import {
  counterpartyBreaches,
  PROVIDER_COUNTERPARTY_PROBE,
  providerCounterparty,
  readProviderTransactions,
} from '../server/services/cash/providers/counterparty.ts';
import { readLadder } from '../server/services/labor/counterparties/ladder.ts';
import { performanceFrom } from '../server/services/labor/counterparties/reservations.ts';
import { compareFulfillers } from '../server/services/labor/counterparties/compare.ts';
import { coordinateSteps, negotiate, planWorkforce, withPerformance } from '../server/services/labor/counterparties/transaction.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, recordCost } from '../server/services/cash/journey/fulfillment.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { recordCounterpartyFacts } from '../server/services/labor/counterparties/ladder.ts';
import { counterpartyLedger, holdsFrom, recordHoldOutcome, recordedReservationEvents, RESERVATION_EVENT_KIND } from '../server/services/labor/counterparties/reservations.ts';
import {
  fulfillerCounterpartyId,
  readOpportunityTransaction,
  reserveOpportunityTransaction,
  sourcedFulfillers,
  transferOpportunityTransaction,
} from '../server/services/labor/counterparties/transaction.ts';

const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
const v = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: `source:${dimension}`, value });
const p = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'PENDING', evidence: null, value });

const LISTED = [v('listing')];
const WILLING = [...LISTED, v('willingness'), v('availability')];
const CAPABLE = [...WILLING, v('eligibility'), v('scope'), v('qualifications'), v('geography')];
const quoted = (price: number, lead: number, capacity: number) => [...CAPABLE, v('price', price), v('paymentTerms', 'net 30'), v('leadTime', lead), v('availableCapacity', capacity)];
const contracted = (price: number, lead: number, capacity: number) => [...quoted(price, lead, capacity), v('reservedCapacity'), v('contract')];

const party = (id: string, facts: Fact[], geography = 'region-a'): Counterparty => ({ id, kind: 'contractor', geography, facts });
const commitment = { id: 'job-1', capacityUnits: 2, geographies: ['region-a', 'region-b'] };

/** The authority owner's reading as the pure reading receives it; on rows only `authorityFor` makes one. */
const HELD: AuthorityReading = { businessId: 'biz-1', action: 'ENGAGE_CONTRACTOR', held: true, reason: 'within the standing commercial authority', authorityId: 'cau_test', policyVersion: 1 };
const NONE = withoutAuthority('biz-1');

const input = (candidates: Counterparty[], events: ReservationEvent[] = [], over: Partial<TransactionInput> = {}): TransactionInput => ({
  commitment, candidates, events, businessId: 'biz-1', window: W,
  authority: HELD, at: '2026-11-13T12:00:00Z',
  source: 'sourced buyer request', ...over,
});
const outcome = (e: ReservationEvent, kind: 'FAILED' | 'PERFORMED', at: string): ReservationEvent => ({ ...e, kind, at });

describe('CP-31 acceptance: a sourced contractor-delivered transaction', () => {
  it('names a primary and an alternative, verified versus pending facts, and compares cost, capacity and timing', () => {
    const a = party('crew-a', quoted(900, 5, 4));
    const b = party('crew-b', [...quoted(800, 9, 3).filter((f) => f.dimension !== 'price'), p('price', 700)], 'region-b');
    const c = party('crew-c', LISTED);
    const reading = readTransaction(input([c, b, a]));
    expect(reading.source).toBe('sourced buyer request');
    expect(reading.primary?.counterpartyId).toBe('crew-a');
    expect(reading.alternative?.counterpartyId).toBe('crew-b');
    const bFacts = reading.facts.find((f) => f.counterpartyId === 'crew-b')!;
    expect(bFacts.verified).not.toContain('price');
    expect(bFacts.pending).toContainEqual({ dimension: 'price', state: 'PENDING' });
    const bRow = reading.compared.find((r) => r.counterpartyId === 'crew-b')!;
    expect(bRow.figures.cost).toEqual({ value: null, claimed: 700, status: 'PENDING' }); // a pending price is not cheaper
    const aRow = reading.compared.find((r) => r.counterpartyId === 'crew-a')!;
    expect(aRow.figures).toMatchObject({ cost: { value: 900 }, capacity: { value: 4 }, timing: { value: 5 } });
  });

  it('reports a sale not deliverable while its best fulfiller is only listed, willing, capable or quoted', () => {
    for (const facts of [LISTED, WILLING, CAPABLE, quoted(900, 5, 4)]) {
      const reading = readTransaction(input([party('crew-a', facts)]));
      expect(reading.deliverability.deliverable).toBe(false);
    }
    // Even a reservation is not a contract.
    const r1 = readTransaction(input([party('crew-a', quoted(900, 5, 4))]));
    expect(r1.reserve.permitted).toBe(true);
    const held = r1.reserve.permitted ? r1.reserve.event! : null;
    const r2 = readTransaction(input([party('crew-a', quoted(900, 5, 4))], [held!]));
    expect(r2.deliverability).toMatchObject({ deliverable: false, counterpartyId: 'crew-a', holdState: 'HELD' });
  });

  it('does not reserve without the required authority, and names the authority that is missing', () => {
    const reading = readTransaction(input([party('crew-a', quoted(900, 5, 4))], [], { authority: NONE }));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY', missingAuthority: ['ENGAGE_CONTRACTOR'] });
  });

  it('does not reserve a fulfiller that has not quoted', () => {
    const reading = readTransaction(input([party('crew-a', CAPABLE)]));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'NOT_QUOTED' });
  });

  it('walks the whole demonstration: reserve, contract, primary failure, one transfer, no double-commit, honest deliverability', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const b = party('crew-b', contracted(950, 6, 3), 'region-b');
    const first = readTransaction(input([a, b]));
    expect(first.primary?.counterpartyId).toBe('crew-a');
    if (!first.reserve.permitted || !first.reserve.event) throw new Error('expected a reserve');
    const held = first.reserve.event;
    expect(held.key).toBe(reservationKey('job-1', 'crew-a'));

    let events: ReservationEvent[] = [held];
    const live = readTransaction(input([a, b], events));
    expect(live.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-a' });
    expect(live.transfer.applicable).toBe(false); // no report, no transfer
    expect(live.reserve).toMatchObject({ permitted: true, duplicate: true }); // the same key counts once

    // The primary reports a failure: the sale is no longer deliverable on it, and a transfer is planned.
    events = [...events, outcome(held, 'FAILED', '2026-11-14T00:00:00Z')];
    const failed = readTransaction(input([a, b], events, { at: '2026-11-14T01:00:00Z' }));
    expect(failed.deliverability.deliverable).toBe(false);
    expect(failed.transfer).toMatchObject({ applicable: true, from: 'crew-a', to: 'crew-b' });
    if (failed.transfer.plan?.action !== 'TRANSFER') throw new Error('expected a transfer');
    expect(failed.transfer.plan.events.map((e) => [e.kind, e.counterpartyId])).toEqual([['RELEASED', 'crew-a'], ['RESERVED', 'crew-b']]);

    events = [...events, ...failed.transfer.plan.events];
    const after = readTransaction(input([a, b], events, { at: '2026-11-14T02:00:00Z' }));
    expect(after.doubleCommitted).toEqual([]);
    expect(after.deliverability).toMatchObject({ deliverable: true, counterpartyId: 'crew-b' });
    // Planning again transfers nothing a second time: the primary is released, not failed.
    expect(after.transfer.applicable).toBe(false);
    // And nothing reserves crew-a again while crew-b carries the job.
    const again = readTransaction(input([party('crew-a', contracted(100, 1, 9)), b], events));
    expect(again.reserve).toMatchObject({ permitted: false, reason: 'ALREADY_HELD' });
  });

  it('refuses a transfer the authority held does not cover', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const b = party('crew-b', contracted(950, 6, 3));
    const held = readTransaction(input([a, b]));
    if (!held.reserve.permitted || !held.reserve.event) throw new Error('expected a reserve');
    const events = [held.reserve.event, outcome(held.reserve.event, 'FAILED', '2026-11-14T00:00:00Z')];
    const reading = readTransaction(input([a, b], events, { authority: NONE }));
    expect(reading.transfer.plan).toMatchObject({ action: 'REFUSED', reason: 'MISSING_AUTHORITY' });
  });

  it('never transfers a failed job to an alternative that has not quoted, even with verified capacity', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const held = readTransaction(input([a]));
    if (!held.reserve.permitted || !held.reserve.event) throw new Error('expected a reserve');
    const events = [held.reserve.event, outcome(held.reserve.event, 'FAILED', '2026-11-14T00:00:00Z')];
    for (const early of [LISTED, WILLING, CAPABLE]) {
      const b = party('crew-b', [...early, v('availableCapacity', 9)]);
      const reading = readTransaction(input([a, b], events, { at: '2026-11-14T01:00:00Z' }));
      expect(reading.compared.find((r) => r.counterpartyId === 'crew-b')?.eligible).toBe(true);
      expect(reading.transfer).toMatchObject({ applicable: true, from: 'crew-a', to: null });
      expect(reading.transfer.plan).toMatchObject({ action: 'REFUSED', reason: 'NOT_QUOTED' });
      expect(reading.deliverability.deliverable).toBe(false);
    }
  });

  it('transfers past an unquoted alternative to a quoted one', () => {
    const a = party('crew-a', contracted(900, 5, 4));
    const held = readTransaction(input([a]));
    if (!held.reserve.permitted || !held.reserve.event) throw new Error('expected a reserve');
    const events = [held.reserve.event, outcome(held.reserve.event, 'FAILED', '2026-11-14T00:00:00Z')];
    const b = party('crew-b', [...CAPABLE, v('availableCapacity', 9)]);
    const c = party('crew-c', quoted(950, 6, 3));
    const reading = readTransaction(input([a, b, c], events, { at: '2026-11-14T01:00:00Z' }));
    expect(reading.transfer).toMatchObject({ applicable: true, from: 'crew-a', to: 'crew-c' });
    expect(reading.transfer.plan?.action).toBe('TRANSFER');
  });

  it('never books capacity another business already holds', () => {
    const a = party('crew-a', contracted(900, 5, 2));
    const other: ReservationEvent = {
      kind: 'RESERVED', key: 'job-9:crew-a', counterpartyId: 'crew-a', commitmentId: 'job-9', businessId: 'biz-2',
      units: 1, ...W, authorityHeld: ['ENGAGE_CONTRACTOR'], at: '2026-11-12T00:00:00Z',
    };
    const reading = readTransaction(input([a], [other]));
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'CAPACITY' });
  });
});

describe('a configured software-service provider is a counterparty', () => {
  it('reads its facts from the existing provider status line', () => {
    const cp = providerCounterparty({
      area: 'MESSAGING', capability: 'SEND_A_MESSAGE', state: 'CONNECTED', provider: 'instantly', mode: null, detail: '', nextAction: '',
    })!;
    expect(cp).toMatchObject({ id: 'provider:messaging:instantly', kind: 'software service', humanOperator: false });
    const ladder = readLadder(cp);
    // Listed, and configured — but configuration is not willingness: nothing above LISTING is asserted.
    expect(ladder.stage).toBe('LISTING');
    expect(cp.facts.find((f) => f.dimension === 'listing')?.evidence).toMatch(/commercialProviderStatus/);
    expect(cp.facts.find((f) => f.dimension === 'configuration')).toMatchObject({ status: 'VERIFIED', value: 'SEND_A_MESSAGE' });
    expect(cp.facts.find((f) => f.dimension === 'configuration')?.evidence).toMatch(/CONNECTED/);
  });

  it('never reads a CONNECTED configuration as willingness, availability, scope or eligibility', () => {
    const cp = providerCounterparty({
      area: 'PAYMENTS', capability: 'TAKE_A_PAYMENT', state: 'CONNECTED', provider: 'stripe', mode: 'LIVE', detail: '', nextAction: '',
    })!;
    for (const dimension of ['willingness', 'availability', 'scope', 'eligibility']) {
      expect(cp.facts.find((f) => f.dimension === dimension)?.status, dimension).toBe('PENDING');
    }
    const willingness = readLadder(cp).stages.find((s) => s.stage === 'WILLINGNESS')!;
    expect(willingness.reached).toBe(false);
    expect(willingness.missing.map((m) => m.dimension).sort()).toEqual(['availability', 'willingness']);
    // The configuration reading is carried, not dropped, as a fact the ladder does not read.
    expect(readLadder(cp).other.map((f) => f.dimension)).toContain('configuration');
  });

  it('is pending when configured but not registered, and absent when no provider is chosen', () => {
    const pending = providerCounterparty({ area: 'INVOICES', capability: 'ISSUE_AN_INVOICE', state: 'MISSING', provider: 'stripe', mode: 'TEST', detail: '', nextAction: '' })!;
    expect(readLadder(pending).stage).toBe('LISTING');
    expect(pending.facts.find((f) => f.dimension === 'configuration')?.status).toBe('PENDING');
    expect(pending.facts.find((f) => f.dimension === 'mode')?.value).toBe('TEST');
    expect(providerCounterparty({ area: 'PAYMENTS', capability: 'TAKE_A_PAYMENT', state: 'MISSING', provider: null, mode: null, detail: '', nextAction: '' })).toBeNull();
  });
});

// The remaining clauses of S-0468/S-0469: learning who performs, negotiating within
// authorized terms, coordinating steps and checking completion, and workforce planning.
describe('CP-31 remaining clauses', () => {
  const W = { windowStart: '2026-12-01T00:00:00Z', windowEnd: '2026-12-08T00:00:00Z' };
  const LATER = '2026-12-20T00:00:00Z';
  const v = (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: `source:${dimension}`, value });
  const quoted = (price: number, lead: number, capacity: number) => [
    v('listing'), v('willingness'), v('availability'), v('eligibility'), v('scope'), v('qualifications'), v('geography'),
    v('price', price), v('paymentTerms', 'net 30'), v('leadTime', lead), v('availableCapacity', capacity),
  ];
  const party = (id: string, facts: Fact[], kind = 'contractor'): Counterparty => ({ id, kind, geography: 'region-a', facts });
  const ev = (kind: ReservationEvent['kind'], key: string, counterpartyId: string, at: string, over: Partial<ReservationEvent> = {}): ReservationEvent => ({
    kind, key, counterpartyId, commitmentId: `job-${key}`, businessId: 'biz-1', units: 1, ...W, authorityHeld: [], at, ...over,
  });

  describe('CP-31 clauses: learn which counterparties actually perform', () => {
    const history = [
      ev('RESERVED', 'a1', 'crew-a', '2026-11-01T00:00:00Z'), ev('PERFORMED', 'a1', 'crew-a', '2026-11-02T00:00:00Z'),
      ev('RESERVED', 'b1', 'crew-b', '2026-11-01T00:00:00Z'), ev('FAILED', 'b1', 'crew-b', '2026-11-02T00:00:00Z'),
      ev('RESERVED', 'c1', 'crew-c', '2026-11-01T00:00:00Z'),
    ];

    it('reads reliability from reported outcomes only; an unreported hold is neither', () => {
      expect(performanceFrom(history, 'crew-a', LATER)).toMatchObject({ performed: 1, failed: 0, reliability: 1, evidence: ['a1'] });
      expect(performanceFrom(history, 'crew-b', LATER)).toMatchObject({ performed: 0, failed: 1, reliability: 0 });
      expect(performanceFrom(history, 'crew-c', LATER)).toMatchObject({ performed: 0, failed: 0, unreported: 1, reliability: null });
    });

    it('an untried counterparty gets UNKNOWN performance facts, never a favourable default', () => {
      const c = withPerformance(party('crew-c', quoted(900, 5, 4)), history, LATER);
      expect(c.facts.filter((f) => f.dimension === 'reliability')).toEqual([{ dimension: 'reliability', status: 'UNKNOWN', evidence: null, value: null }]);
    });

    it('a counterparty that failed ranks below an otherwise equal one that performed', () => {
      const parties = [party('crew-b', quoted(900, 5, 4)), party('crew-a', quoted(900, 5, 4))].map((p) => withPerformance(p, history, LATER));
      const cmp = compareFulfillers({ id: 'job-x', capacityUnits: 1 }, parties);
      expect(cmp.primary?.counterpartyId).toBe('crew-a');
      expect(cmp.primary?.reliability).toBe(1);
      expect(cmp.alternative?.reliability).toBe(0);
    });

    it('readTransaction applies the learned performance without being told', () => {
      const reading = readTransaction({
        commitment: { id: 'job-x', capacityUnits: 1 }, candidates: [party('crew-b', quoted(900, 5, 4)), party('crew-a', quoted(900, 5, 4))],
        events: history, businessId: 'biz-1', window: { windowStart: '2027-01-01T00:00:00Z', windowEnd: '2027-01-02T00:00:00Z' },
        authority: NONE, at: LATER,
      });
      expect(reading.primary?.counterpartyId).toBe('crew-a');
    });
  });

  describe('CP-31 clauses: negotiate authorized terms', () => {
    const terms = { priceCeiling: 1000, maxLeadTime: 7, paymentTerms: ['net 30'], authority: HELD };

    it('accepts within the ceiling, counters at the ceiling and never above it', () => {
      expect(negotiate(party('a', quoted(900, 5, 4)), terms)).toMatchObject({ action: 'ACCEPT', price: 900 });
      expect(negotiate(party('a', quoted(1400, 5, 4)), terms)).toMatchObject({ action: 'COUNTER', price: 1000 });
    });

    it('declines terms outside the authorization and refuses a pending price', () => {
      expect(negotiate(party('a', quoted(900, 12, 4)), terms).action).toBe('DECLINE');
      expect(negotiate(party('a', [...quoted(900, 5, 4), v('paymentTerms', 'upfront')]), terms).action).toBe('DECLINE');
      const pending = party('a', [...quoted(900, 5, 4), { dimension: 'price', status: 'PENDING', evidence: null, value: 500 }]);
      expect(negotiate(pending, terms)).toMatchObject({ action: 'NEEDS_QUOTE', missing: [{ dimension: 'price', state: 'PENDING' }] });
    });

    it('does not accept without the authority, and names it', () => {
      expect(negotiate(party('a', quoted(900, 5, 4)), { ...terms, authority: NONE })).toMatchObject({ action: 'MISSING_AUTHORITY', missingAuthority: ['ENGAGE_CONTRACTOR'] });
    });
  });

  describe('CP-31 clauses: coordinate project steps and check completion', () => {
    it('a step is DONE only on a PERFORMED report; a silent hold past its window is UNKNOWN and its dependants wait', () => {
      const events = [
        ev('RESERVED', 's1', 'crew-a', '2026-11-01T00:00:00Z'), ev('PERFORMED', 's1', 'crew-a', '2026-12-02T00:00:00Z'),
        ev('RESERVED', 's2', 'crew-b', '2026-11-01T00:00:00Z'),
      ];
      const steps = [
        { id: 'prep', dependsOn: [], holdKey: 's1' },
        { id: 'build', dependsOn: ['prep'], holdKey: 's2' },
        { id: 'finish', dependsOn: ['build'], holdKey: null },
      ];
      const during = coordinateSteps(steps, events, '2026-12-03T00:00:00Z');
      expect(during.map((s) => s.state)).toEqual(['DONE', 'IN_PROGRESS', 'WAITING']);
      const after = coordinateSteps(steps, events, LATER);
      expect(after.map((s) => s.state)).toEqual(['DONE', 'UNKNOWN', 'WAITING']);
      const failed = coordinateSteps(steps, [...events, ev('FAILED', 's2', 'crew-b', '2026-12-04T00:00:00Z')], LATER);
      expect(failed[1]).toMatchObject({ state: 'FAILED', counterpartyId: 'crew-b' });
    });
  });

  describe('CP-31 clauses: workforce planning, hiring preparation, performance management, partner networks', () => {
    it('covers demand from any kind of counterparty across businesses without counting a unit twice', () => {
      const parties = [party('partner-x', quoted(900, 5, 3), 'distribution partner'), party('employee-y', quoted(950, 5, 1), 'employee')];
      const demands = [
        { commitment: { id: 'job-1', capacityUnits: 2 }, businessId: 'biz-1', window: W },
        { commitment: { id: 'job-2', capacityUnits: 3 }, businessId: 'biz-2', window: W },
      ];
      const [one, two] = planWorkforce(demands, parties, [], LATER);
      expect(one).toMatchObject({ shortfall: 0, coveredBy: [{ counterpartyId: 'partner-x', freeUnits: 2 }] });
      // partner-x has 1 unit left and employee-y has 1: two units, not five.
      expect(two!.coveredBy.reduce((n, c) => n + c.freeUnits, 0)).toBe(2);
      expect(two).toMatchObject({ shortfall: 1, roleBrief: { capacityUnits: 1 } });
      // A hire is one option beside sourcing, never the only one.
      expect(two!.options).toEqual(['SOURCE_COUNTERPARTY', 'EXTEND_PARTNER_NETWORK', 'PREPARE_HIRE']);
    });

    it('runs a business with no employee at all, and flags counterparties that do not perform', () => {
      const history = [ev('RESERVED', 'z1', 'crew-z', '2026-11-01T00:00:00Z'), ev('FAILED', 'z1', 'crew-z', '2026-11-02T00:00:00Z')];
      const [line] = planWorkforce(
        [{ commitment: { id: 'job-9', capacityUnits: 1 }, businessId: 'biz-1', window: { windowStart: '2027-01-01T00:00:00Z', windowEnd: '2027-01-02T00:00:00Z' } }],
        [party('carrier-q', quoted(500, 2, 2), 'carrier'), party('crew-z', quoted(400, 2, 2))], history, LATER,
      );
      expect(line).toMatchObject({ shortfall: 0, options: [] });
      expect(line!.underperformers).toEqual(['crew-z']);
    });
  });
});

describe('CP-31 in the running Brain: boot wires the model to the live providers', () => {
  const ENV = { BRAIN_MESSAGING_PROVIDER: 'resend', RESEND_API_KEY: 're_test_value_not_printed_0001', BRAIN_MESSAGING_FROM: 'Brain <s@brain.example>' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    clearAdapters();
    clearPaymentReader();
    await freshProject();
  });

  it('boot registers the counterparty reading where production verification runs it, under a non-release name', async () => {
    expect(PROVIDER_COUNTERPARTY_PROBE).not.toMatch(/^r\d{2}\./);
    registerCommercialProviders(ENV);
    const probe = getProbe(PROVIDER_COUNTERPARTY_PROBE);
    expect(probe).not.toBeNull();
    const answer = await probe!({});
    expect(answer.ok).toBe(true);
    expect(answer.detail).toContain('provider:messaging:resend at LISTING');
    expect(answer.detail).toContain('deliverable=false');
    expect(answer.detail).not.toContain('re_test_value_not_printed_0001');
  });

  it('reads each live provider commitment end to end: listed, not willing, not deliverable, not reservable without the grant', async () => {
    registerCommercialProviders(ENV);
    const readings = await readProviderTransactions({ env: ENV, at: '2026-11-13T12:00:00Z' });
    expect(readings.map((r) => r.area)).toEqual(['MESSAGING', 'INVOICES', 'PAYMENTS']);
    const messaging = readings.find((r) => r.area === 'MESSAGING')!.reading;
    expect(messaging.primary?.counterpartyId).toBe('provider:messaging:resend');
    expect(messaging.primary?.stage).toBe('LISTING');
    expect(messaging.facts[0]!.pending.map((m) => m.dimension)).toContain('willingness');
    expect(messaging.deliverability.deliverable).toBe(false);
    expect(messaging.reserve.permitted).toBe(false);
    expect(readings.find((r) => r.area === 'INVOICES')!.reading.primary).toBeNull();
    expect(counterpartyBreaches(readings)).toEqual([]);
  });

  it('names a breach when a reading claims more than the model allows', async () => {
    registerCommercialProviders(ENV);
    const [first] = await readProviderTransactions({ env: ENV, at: '2026-11-13T12:00:00Z' });
    const forged = { ...first!, reading: { ...first!.reading, deliverability: { ...first!.reading.deliverability, deliverable: true, stage: 'QUOTE' as const } } };
    expect(counterpartyBreaches([forged])).toEqual(['MESSAGING: reported deliverable at QUOTE, below CONTRACTED']);
  });
});

/*
 * The S-0469 demonstration on a sourced record. Nothing below hands the model a
 * counterparty, a fact or an authority: the candidates are the fulfillers the
 * opportunity's own rows name (its card's fulfillmentOwner and the supplier a
 * person declared for its agreement), the price and contract are read from the
 * ledger's supplier commitment (the rows commitments.ts reads as owedToSuppliers),
 * further facts reach the model only through the recorded-facts path with the
 * record that established them, and the authority is the project's live grant.
 */
describe('CP-31 acceptance on a sourced opportunity: the rows feed the model', () => {
  const W2 = { windowStart: '2031-03-01T00:00:00Z', windowEnd: '2031-03-08T00:00:00Z' };
  let projectId = '';
  let userId = '';
  let authorityId = '';

  const grant = async () => {
    authorityId = (await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    })).id;
  };

  /** A captured, qualified opportunity in execution whose card names `owner` as who fulfils it. */
  async function sourcedOpportunity(owner: string): Promise<string> {
    const captured = await capture({
      projectId, actorRef: userId, ownerUserId: userId, title: 'Gutter replacement for a property manager',
      mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
    });
    if (!captured.ok) throw new Error(captured.reason);
    const id = captured.value.id;
    const filled = await fillCard({
      opportunityId: id, actorRef: userId,
      patch: {
        payer: 'The property manager, who signs', reachableChannel: 'Replied by email', buyingSignal: 'Asked for a quote',
        signalObservedAt: '2031-02-01T09:00:00.000Z', offerScope: 'Replace 40m of gutter', acceptanceCondition: 'Gutters installed and inspected',
        priceCents: 90_000, deliveryMethod: 'Subcontracted crew on site', fulfillmentOwner: owner, peakFundingCents: 0,
      },
    });
    if (!filled.ok) throw new Error(filled.reason);
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
    }
    expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
    const began = await beginExecution({
      opportunityId: id, actorRef: userId,
      firstAction: { action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.', reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first') },
    });
    if (!began.ok) throw new Error(began.reason);
    return id;
  }

  /** The agreement, its declared supplier, and the supplier commitment in the ledger. */
  async function contractedSupplier(opportunityId: string, supplier: string, cents: number): Promise<string> {
    const agreed = await recordAgreement({
      opportunityId, amountCents: 90_000, currency: 'USD', deliverable: 'Replace 40m of gutter',
      acceptanceCondition: 'Gutters installed and inspected', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${opportunityId}`, actorRef: userId,
    });
    if (!agreed.ok) throw new Error(agreed.reason);
    const declared = await declare({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER', performer: supplier, supplierName: supplier, actorRef: userId });
    if (!declared.ok) throw new Error(declared.reason);
    const cost = await recordCost({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER_COMMITMENT', amountCents: cents, detail: 'Signed work order', actorRef: userId });
    if (!cost.ok) throw new Error(cost.reason);
    return agreed.value.id;
  }

  /** What a person learned from each counterparty, recorded with the record it came from. */
  const record = (id: string, facts: Fact[]) =>
    recordCounterpartyFacts({ projectId, counterparty: { id, kind: 'contractor', geography: 'region-a', humanOperator: true }, facts, actorRef: userId });
  const said = (ref: string) => (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: ref, value });

  beforeEach(async () => {
    clearAdapters();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `cp31s-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
    await grant();
  });

  it('reads its candidates and their verified facts from the opportunity and the supplier commitment, not from the caller', async () => {
    const opportunityId = await sourcedOpportunity('Northside Crew');
    await contractedSupplier(opportunityId, 'Harbor Contractors', 30_000);
    // The ledger rows this reads are the ones the commitment reading owes the supplier on.
    const commitments = await readCommitments({ projectId, opportunityId, currency: 'USD' });
    expect(commitments.owedToSuppliers.reduce((n, o) => n + o.owedCents, 0)).toBe(30_000);

    const fulfillers = await sourcedFulfillers(opportunityId);
    const harbor = fulfillerCounterpartyId('Harbor Contractors');
    const northside = fulfillerCounterpartyId('Northside Crew');
    expect(fulfillers.map((f) => f.counterpartyId).sort()).toEqual([harbor, northside].sort());
    expect(fulfillers.find((f) => f.counterpartyId === northside)!.sources).toEqual([`opportunity:${opportunityId}:fulfillmentOwner`]);
    const h = fulfillers.find((f) => f.counterpartyId === harbor)!;
    expect(h.sources[0]).toMatch(/^fulfillment:/);
    const owedEntry = commitments.owedToSuppliers[0]!.entries[0]!;
    expect(h.facts.find((f) => f.dimension === 'price')).toMatchObject({ status: 'VERIFIED', value: 30_000, evidence: expect.stringContaining(owedEntry) });
    expect(h.facts.find((f) => f.dimension === 'contract')).toMatchObject({ status: 'VERIFIED', evidence: expect.stringContaining(owedEntry) });

    const { reading } = await readOpportunityTransaction({ opportunityId, window: W2, at: '2031-02-10T00:00:00Z' });
    expect(reading!.source).toBe(`opportunity:${opportunityId}`);
    expect(reading!.authority).toMatchObject({ businessId: projectId, held: true, authorityId });
    // Nothing above LISTING is asserted for either: willingness, capability, terms are pending tasks.
    const hLedger = reading!.facts.find((f) => f.counterpartyId === harbor)!;
    expect(hLedger.verified).toEqual(expect.arrayContaining(['listing', 'price', 'contract']));
    expect(hLedger.pending.map((m) => m.dimension)).toEqual(expect.arrayContaining(['willingness', 'availability', 'paymentTerms', 'leadTime', 'reservedCapacity']));
    expect(reading!.deliverability.deliverable).toBe(false);
    expect(reading!.reserve).toMatchObject({ permitted: false, reason: 'NOT_QUOTED' });
  });

  it('walks the demonstration on rows: primary and alternative, authority from the live grant, failure, one transfer, no double-commit', async () => {
    const opportunityId = await sourcedOpportunity('Northside Crew');
    await contractedSupplier(opportunityId, 'Harbor Contractors', 30_000);
    const harbor = fulfillerCounterpartyId('Harbor Contractors');
    const northside = fulfillerCounterpartyId('Northside Crew');
    const fromHarbor = said('email reply from Harbor Contractors, 2031-02-02 (msg-harbor-1)');
    await record(harbor, [
      fromHarbor('willingness'), fromHarbor('availability'), fromHarbor('eligibility'), fromHarbor('scope'),
      fromHarbor('qualifications'), fromHarbor('geography', 'region-a'), fromHarbor('paymentTerms', 'net 30'),
      fromHarbor('leadTime', 5), fromHarbor('availableCapacity', 2), fromHarbor('reservedCapacity'),
    ]);
    const fromNorthside = said('phone quote from Northside Crew, 2031-02-03 (call-ns-1)');
    await record(northside, [
      fromNorthside('willingness'), fromNorthside('availability'), fromNorthside('eligibility'), fromNorthside('scope'),
      fromNorthside('qualifications'), fromNorthside('geography', 'region-a'), fromNorthside('price', 36_000),
      fromNorthside('paymentTerms', 'net 15'), fromNorthside('leadTime', 7), fromNorthside('availableCapacity', 3),
    ]);
    const shape = { opportunityId, window: W2, at: '2031-02-10T00:00:00Z' };

    const before = (await readOpportunityTransaction(shape)).reading!;
    expect(before.primary?.counterpartyId).toBe(harbor);
    expect(before.alternative?.counterpartyId).toBe(northside);
    const row = (id: string) => before.compared.find((r) => r.counterpartyId === id)!;
    expect(row(harbor).figures).toMatchObject({ cost: { value: 30_000 }, capacity: { value: 2 }, timing: { value: 5 } });
    expect(row(northside).figures).toMatchObject({ cost: { value: 36_000 }, capacity: { value: 3 }, timing: { value: 7 } });
    // Northside has quoted but has no contract: pending, and not a deliverable alternative yet.
    expect(before.facts.find((f) => f.counterpartyId === northside)!.pending.map((m) => m.dimension)).toEqual(expect.arrayContaining(['reservedCapacity', 'contract']));

    // Without the live grant nothing is reserved, and nothing is written.
    expect(await revokeAuthority({ authorityId, actorUserId: userId, reason: 'test: no grant' })).toBe(true);
    const refused = (await reserveOpportunityTransaction(shape, userId)).reading!;
    expect(refused.reserve).toMatchObject({ permitted: false, reason: 'MISSING_AUTHORITY', missingAuthority: ['ENGAGE_CONTRACTOR'] });
    expect(await recordedReservationEvents([harbor, northside])).toEqual([]);

    // With the grant: one hold on the primary, and a retry writes nothing more.
    await grant();
    const reserved = (await reserveOpportunityTransaction(shape, userId)).reading!;
    expect(reserved.reserve).toMatchObject({ permitted: true, counterpartyId: harbor });
    await reserveOpportunityTransaction(shape, userId);
    expect(await cashEventsOfKind(counterpartyLedger(harbor), RESERVATION_EVENT_KIND)).toHaveLength(1);
    const live = (await readOpportunityTransaction(shape)).reading!;
    expect(live.deliverability).toMatchObject({ deliverable: true, counterpartyId: harbor, stage: 'CONTRACTED' });

    // The primary reports a failure: not deliverable, and the job moves to the alternative exactly once.
    const [hold] = holdsFrom(await recordedReservationEvents([harbor]));
    expect((await recordHoldOutcome({ counterpartyId: harbor, key: hold!.key, kind: 'FAILED', at: '2031-02-11T00:00:00Z', actorRef: userId })).recorded).toBe(true);
    const failed = (await readOpportunityTransaction({ ...shape, at: '2031-02-11T01:00:00Z' })).reading!;
    expect(failed.deliverability.deliverable).toBe(false);
    expect(failed.transfer).toMatchObject({ applicable: true, from: harbor, to: northside });
    await transferOpportunityTransaction({ ...shape, at: '2031-02-11T01:00:00Z' }, userId);
    await transferOpportunityTransaction({ ...shape, at: '2031-02-11T02:00:00Z' }, userId);
    const holds = holdsFrom(await recordedReservationEvents([harbor, northside]));
    expect(holds.map((h) => [h.counterpartyId, h.state]).sort()).toEqual([[harbor, 'RELEASED'], [northside, 'HELD']].sort());

    // Carried by an alternative that has not contracted: held, honestly not deliverable, never double-committed.
    const after = (await readOpportunityTransaction({ ...shape, at: '2031-02-11T03:00:00Z' })).reading!;
    expect(after.doubleCommitted).toEqual([]);
    expect(after.deliverability).toMatchObject({ deliverable: false, counterpartyId: northside, holdState: 'HELD' });
    expect(after.reserve).toMatchObject({ permitted: false, reason: 'ALREADY_HELD' });
  });

  it('offers no candidate when only Brain fulfils it', async () => {
    const opportunityId = await sourcedOpportunity('Brain');
    expect(await sourcedFulfillers(opportunityId)).toEqual([]);
    const answer = await readOpportunityTransaction({ opportunityId, window: W2, at: '2031-02-10T00:00:00Z' });
    expect(answer.reading).toBeNull();
  });
});
