/**
 * CP-31 repair, episode 1: the probe r01.cp-31 timed out waiting for a pooled
 * connection (§61). One opportunity reading asked for the same opportunity row
 * twice and for the same commercial-authority decision twice. These tests pin
 * the cut: a reading is identical to the one the separate reads composed, and
 * it issues one getOpportunity and one checkCommercialAuthority.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ getOpportunity: 0, checkCommercialAuthority: 0, cashEventsOfKind: 0 }));

vi.mock('../server/repos/cashPortfolio.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/cashPortfolio.ts')>();
  return { ...actual, getOpportunity: (...args: Parameters<typeof actual.getOpportunity>) => { calls.getOpportunity += 1; return actual.getOpportunity(...args); } };
});
vi.mock('../server/services/cash/authority.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/cash/authority.ts')>();
  return {
    ...actual,
    checkCommercialAuthority: (...args: Parameters<typeof actual.checkCommercialAuthority>) => { calls.checkCommercialAuthority += 1; return actual.checkCommercialAuthority(...args); },
  };
});
vi.mock('../server/repos/cashMode.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/cashMode.ts')>();
  return { ...actual, cashEventsOfKind: (...args: Parameters<typeof actual.cashEventsOfKind>) => { calls.cashEventsOfKind += 1; return actual.cashEventsOfKind(...args); } };
});

import { freshProject } from './helpers.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { Fact } from '../server/services/labor/counterparties/ladder.ts';
import { recordCounterpartyFacts } from '../server/services/labor/counterparties/ladder.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, recordCost } from '../server/services/cash/journey/fulfillment.ts';
import { authorityFor, recordedReservationEvents, RESERVE_ACTION } from '../server/services/labor/counterparties/reservations.ts';
import {
  authorizedTermsFor,
  fulfillerCounterpartyId,
  negotiateOnTerms,
  readOpportunityTransaction,
  readTransaction,
  reserveOpportunityTransaction,
  sourcedCandidate,
  sourcedFulfillers,
  transferOpportunityTransaction,
} from '../server/services/labor/counterparties/transaction.ts';
import { recordHoldOutcome, holdsFrom } from '../server/services/labor/counterparties/reservations.ts';

const W = { windowStart: '2031-03-01T00:00:00Z', windowEnd: '2031-03-08T00:00:00Z' };
const reset = () => { calls.getOpportunity = 0; calls.checkCommercialAuthority = 0; calls.cashEventsOfKind = 0; };

describe('CP-31 repair: one opportunity reading costs fewer pooled queries and reads the same', () => {
  let projectId = '';
  let userId = '';

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

  async function contractedSupplier(opportunityId: string, supplier: string, cents: number): Promise<void> {
    const agreed = await recordAgreement({
      opportunityId, amountCents: 90_000, currency: 'USD', deliverable: 'Replace 40m of gutter',
      acceptanceCondition: 'Gutters installed and inspected', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${opportunityId}`, actorRef: userId,
    });
    if (!agreed.ok) throw new Error(agreed.reason);
    const declared = await declare({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER', performer: supplier, supplierName: supplier, actorRef: userId });
    if (!declared.ok) throw new Error(declared.reason);
    const cost = await recordCost({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER_COMMITMENT', amountCents: cents, detail: 'Signed work order', actorRef: userId });
    if (!cost.ok) throw new Error(cost.reason);
  }

  const said = (ref: string) => (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: ref, value });
  const record = (id: string, facts: Fact[]) =>
    recordCounterpartyFacts({ projectId, counterparty: { id, kind: 'contractor', geography: 'region-a', humanOperator: true }, facts, actorRef: userId });

  /** An opportunity with a contracted primary (Harbor) and a quoted alternative (Northside). */
  async function primaryAndAlternative(): Promise<{ opportunityId: string; harbor: string; northside: string }> {
    const opportunityId = await sourcedOpportunity('Northside Crew');
    await contractedSupplier(opportunityId, 'Harbor Contractors', 30_000);
    const harbor = fulfillerCounterpartyId('Harbor Contractors');
    const northside = fulfillerCounterpartyId('Northside Crew');
    const h = said('email reply from Harbor Contractors (msg-harbor-1)');
    await record(harbor, [
      h('willingness'), h('availability'), h('eligibility'), h('scope'), h('qualifications'), h('geography', 'region-a'),
      h('paymentTerms', 'net 30'), h('leadTime', 5), h('availableCapacity', 2), h('reservedCapacity'),
    ]);
    const n = said('phone quote from Northside Crew (call-ns-1)');
    await record(northside, [
      n('willingness'), n('availability'), n('eligibility'), n('scope'), n('qualifications'), n('geography', 'region-a'),
      n('price', 36_000), n('paymentTerms', 'net 15'), n('leadTime', 7), n('availableCapacity', 3),
    ]);
    return { opportunityId, harbor, northside };
  }

  /** The reading as the separate reads composed it before the cut: every row read on its own. */
  async function composedSeparately(opportunityId: string, at: string) {
    const fulfillers = await sourcedFulfillers(opportunityId);
    const candidates = [];
    for (const f of fulfillers) candidates.push(await sourcedCandidate(f, f.sources.some((s) => s.startsWith('fulfillment:')) ? 'supplier' : 'fulfiller'));
    const reading = readTransaction({
      commitment: { id: `opportunity:${opportunityId}`, capacityUnits: 1 },
      businessId: projectId, window: W, at, source: `opportunity:${opportunityId}`,
      candidates, events: await recordedReservationEvents(candidates.map((c) => c.id)),
      authority: await authorityFor(projectId, RESERVE_ACTION),
    });
    const terms = await authorizedTermsFor(projectId);
    const negotiations = candidates.map((c) => negotiateOnTerms(c, fulfillers.find((f) => f.counterpartyId === c.id) ?? null, terms));
    return { fulfillers, reading, negotiations };
  }

  beforeEach(async () => {
    clearAdapters();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `cp31r-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    });
  });

  it('A01: the reading is identical to the separately composed one, before and after a hold, a failure and a transfer', async () => {
    const { opportunityId, harbor, northside } = await primaryAndAlternative();
    const at = '2031-02-10T00:00:00Z';
    const check = async (when: string) => {
      const expected = await composedSeparately(opportunityId, when);
      const got = await readOpportunityTransaction({ opportunityId, window: W, at: when });
      expect(got.reading).toEqual(expected.reading);
      expect(got.negotiations).toEqual(expected.negotiations);
      expect(got.fulfillers).toEqual(expected.fulfillers);
      expect(got.detail).toBe(expected.reading.deliverability.reason);
      return got.reading!;
    };

    const before = await check(at);
    expect(before.primary?.counterpartyId).toBe(harbor);
    expect(before.alternative?.counterpartyId).toBe(northside);
    expect(before.facts.map((f) => f.counterpartyId).sort()).toEqual([harbor, northside].sort());
    expect(before.reserve).toMatchObject({ permitted: true, counterpartyId: harbor });
    expect(before.deliverability.deliverable).toBe(false);

    const reserved = (await reserveOpportunityTransaction({ opportunityId, window: W, at }, userId)).reading!;
    expect(reserved.reserve).toMatchObject({ permitted: true, counterpartyId: harbor });
    expect(reserved.authority).toMatchObject({ businessId: projectId, held: true });
    expect((await check(at)).deliverability).toMatchObject({ deliverable: true, counterpartyId: harbor });

    const [hold] = holdsFrom(await recordedReservationEvents([harbor]));
    expect((await recordHoldOutcome({ counterpartyId: harbor, key: hold!.key, kind: 'FAILED', at: '2031-02-11T00:00:00Z', actorRef: userId })).recorded).toBe(true);
    const failed = await check('2031-02-11T01:00:00Z');
    expect(failed.transfer).toMatchObject({ applicable: true, from: harbor, to: northside });

    await transferOpportunityTransaction({ opportunityId, window: W, at: '2031-02-11T01:00:00Z' }, userId);
    const after = await check('2031-02-11T02:00:00Z');
    expect(after.doubleCommitted).toEqual([]);
    expect(after.deliverability).toMatchObject({ deliverable: false, counterpartyId: northside, holdState: 'HELD' });
  });

  it('A01: one reading issues getOpportunity once and checkCommercialAuthority once', async () => {
    const { opportunityId } = await primaryAndAlternative();
    reset();
    const got = await readOpportunityTransaction({ opportunityId, window: W, at: '2031-02-10T00:00:00Z' });
    expect(got.reading).not.toBeNull();
    expect(got.negotiations.length).toBeGreaterThan(0);
    expect(calls.getOpportunity).toBe(1);
    expect(calls.checkCommercialAuthority).toBe(1);
  });

  it('a recorded decision reads the authority once under the lock and still writes exactly its event', async () => {
    const { opportunityId, harbor } = await primaryAndAlternative();
    reset();
    const reserved = await reserveOpportunityTransaction({ opportunityId, window: W, at: '2031-02-10T00:00:00Z' }, userId);
    expect(reserved.reading!.reserve).toMatchObject({ permitted: true, counterpartyId: harbor });
    expect(reserved.negotiations.length).toBeGreaterThan(0);
    expect(calls.getOpportunity).toBe(1);
    expect(calls.checkCommercialAuthority).toBe(1);
    expect(await recordedReservationEvents([harbor])).toHaveLength(1);
  });

  it('a reserve action other than the negotiating one still reads both decisions', async () => {
    const { opportunityId } = await primaryAndAlternative();
    reset();
    const got = await readOpportunityTransaction({ opportunityId, window: W, at: '2031-02-10T00:00:00Z', action: 'CONTACT_BUYER' });
    expect(got.reading!.authority.action).toBe('CONTACT_BUYER');
    expect(got.negotiations.every((n) => n.terms.priceCeiling === 200_000)).toBe(true);
    expect(calls.checkCommercialAuthority).toBe(2);
  });

  it('recordedReservationEvents returns the same events in the same order for duplicate and unsorted ids, reading each ledger once', async () => {
    const { opportunityId, harbor, northside } = await primaryAndAlternative();
    await reserveOpportunityTransaction({ opportunityId, window: W, at: '2031-02-10T00:00:00Z' }, userId);
    const [hold] = holdsFrom(await recordedReservationEvents([harbor]));
    await recordHoldOutcome({ counterpartyId: harbor, key: hold!.key, kind: 'FAILED', at: '2031-02-11T00:00:00Z', actorRef: userId });
    await transferOpportunityTransaction({ opportunityId, window: W, at: '2031-02-11T01:00:00Z' }, userId);

    const canonical = await recordedReservationEvents([harbor, northside].sort());
    expect(canonical.length).toBeGreaterThanOrEqual(3);
    reset();
    const shuffled = await recordedReservationEvents([northside, harbor, northside, harbor, harbor]);
    expect(shuffled).toEqual(canonical);
    expect(calls.cashEventsOfKind).toBe(2);
    expect(await recordedReservationEvents([])).toEqual([]);
  });
});
