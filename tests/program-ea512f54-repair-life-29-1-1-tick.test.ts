/**
 * LIFE-29-1 repair: a buyer's acceptance of a sent offer becomes the agreement
 * on that offer's terms on the journey tick, without a person re-typing them.
 *
 * The terms are the offer that reached the buyer (the card provably composes
 * the message whose digest every send's intent carries); a counter is agreed at
 * the countered amount only; an offer missing a term raises a need naming it
 * and records no agreement. The resulting deal reads as a chain of commitments
 * that the release probe's own judgment accepts against its ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordObservation } from '../server/services/cash/journey/deal.ts';
import { acceptanceNeedKey, termsAccepted } from '../server/services/cash/journey/acceptance.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { composeBuyerMessage } from '../server/services/cash/outreach.ts';
import { offerVersion } from '../server/services/cash/perform.ts';
import { EFFECT_INTENT_KIND } from '../server/services/cash/effects.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (
    await createUser({
      email: `life291tick-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok,
  ).toBe(true);
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000,
    maxPerActionCents: 200_000,
    maxConcurrent: 5,
    currency: 'USD',
  });
});

afterEach(() => clearAdapters());

const OCCURRENCE = 'first';

/** A piece whose offer was sent to the buyer: contacted, with the send's intent carrying the offer digest. */
async function sentOffer(opts: { withoutAcceptanceCondition?: boolean; sendIntent?: boolean } = {}): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title: 'Monthly bookkeeping cleanup',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The shop owner',
      reachableChannel: 'Email published on the site: owner@shop.example',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-11-01T09:00:00.000Z',
      offerScope: 'Reconcile three months of bank feeds',
      acceptanceCondition: 'Every account reconciles to the statement',
      priceCents: 60_000,
      deliveryMethod: 'Shared ledger file',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
  }
  expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
  const began = await beginExecution({
    opportunityId: id,
    actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER',
      performedBy: 'BRAIN',
      detail: 'Reached the buyer with the offer on this card.',
      reference: `msg-${id}`,
      requestKey: actionKey(id, 'CONTACT_BUYER', OCCURRENCE),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  if (opts.withoutAcceptanceCondition) {
    // The offer that went out stated no acceptance condition: the card the message is composed from has none.
    const cleared = await fillCard({ opportunityId: id, actorRef: userId, patch: { acceptanceCondition: null } });
    if (!cleared.ok) throw new Error(cleared.reason);
  }
  const opportunity = (await getOpportunity(id))!;
  const message = composeBuyerMessage(opportunity);
  if (!message.ok) throw new Error(message.reason);
  if (opts.sendIntent !== false) {
    await recordCashEvent({
      projectId,
      opportunityId: id,
      kind: EFFECT_INTENT_KIND,
      actorRef: 'BRAIN',
      summary: 'About to contact the buyer.',
      detail: { action: 'CONTACT_BUYER', occurrence: OCCURRENCE, subjectRef: offerVersion(`${message.to}\n${message.subject}\n${message.text}`) },
    });
  }
  return id;
}

async function observe(
  opportunityId: string,
  kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED',
  amountCents: number | null = null,
  source: 'PROVIDER' | 'PERSON' = 'PROVIDER',
) {
  const seen = await recordObservation({
    opportunityId,
    kind,
    source,
    evidenceRef: `instantly:email:${kind}:${opportunityId}`,
    amountCents,
    observedAt: new Date(Date.now() + 1000).toISOString(),
    actorRef: 'BRAIN',
  });
  if (!seen.ok) throw new Error(seen.reason);
  return seen.value;
}

const agreedEntries = async (opportunityId: string) =>
  (await listMoneyEntries({ projectId, opportunityId, limit: 100 })).filter((one) => one.kind === 'PIPELINE_AGREED');

describe('an acceptance of a sent offer becomes its agreement on the tick', () => {
  it('records exactly one agreement and PIPELINE_AGREED on the sent terms, and nothing more on a second tick', async () => {
    const id = await sentOffer();
    const seen = await observe(id, 'BUYER_ACCEPTED');

    const first = await advanceJourney(projectId);
    expect(first.acceptances).toEqual({ agreed: 1, needs: 0 });
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      amountCents: 60_000,
      currency: 'USD',
      deliverable: 'Reconcile three months of bank feeds',
      acceptanceCondition: 'Every account reconciles to the statement',
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      observationId: seen.id,
      state: 'AGREED',
    });
    expect(await agreedEntries(id)).toHaveLength(1);

    const second = await advanceJourney(projectId);
    expect(second.acceptances).toEqual({ agreed: 0, needs: 0 });
    expect(await agreementsFor(id)).toHaveLength(1);
    expect(await agreedEntries(id)).toHaveLength(1);
  });

  it('agrees a counter-offer at the countered amount only', async () => {
    const id = await sentOffer();
    const seen = await observe(id, 'BUYER_COUNTERED', 45_000);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ amountCents: 45_000, observationId: seen.id });
    const entries = await agreedEntries(id);
    expect(entries.map((one) => one.amountCents)).toEqual([45_000]);
  });

  it('raises a need naming the term an offer did not state, and records no agreement', async () => {
    const id = await sentOffer({ withoutAcceptanceCondition: true });
    const seen = await observe(id, 'BUYER_ACCEPTED');
    const report = await advanceJourney(projectId);
    expect(report.acceptances).toEqual({ agreed: 0, needs: 1 });
    expect(await agreementsFor(id)).toHaveLength(0);
    expect(await agreedEntries(id)).toHaveLength(0);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey === acceptanceNeedKey(seen.id));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toContain('the acceptance condition');
    // A second tick raises it again as the same need, not a second one.
    await advanceJourney(projectId);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey === acceptanceNeedKey(seen.id))).toHaveLength(1);
  });

  it('does not take the card as the offer when no row records what was sent', async () => {
    const id = await sentOffer({ sendIntent: false });
    await observe(id, 'BUYER_ACCEPTED');
    const report = await advanceJourney(projectId);
    expect(report.acceptances).toEqual({ agreed: 0, needs: 1 });
    expect(await agreementsFor(id)).toHaveLength(0);
  });

  it('leaves an acceptance a person typed in to that person, so their own agreement is the only one', async () => {
    const id = await sentOffer();
    await observe(id, 'BUYER_ACCEPTED', null, 'PERSON');
    const report = await advanceJourney(projectId);
    expect(report.acceptances).toEqual({ agreed: 0, needs: 0 });
    expect(await agreementsFor(id)).toHaveLength(0);
  });

  it('reads the resulting deal as commitments the probe judgment accepts against its ledger', async () => {
    const id = await sentOffer();
    await observe(id, 'BUYER_ACCEPTED');
    await advanceJourney(projectId);
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(commitmentProblem(reading, { payments: 0, settlements: 0 })).toBeNull();
    expect(reading.transitions.length).toBeGreaterThan(0);
    for (const t of reading.transitions) {
      expect(typeof t.duty.action).toBe('string');
      expect('deadline' in t).toBe(true);
      expect(t.outcome).toBeTruthy();
      expect(Array.isArray(t.evidence)).toBe(true);
    }
    expect(reading.stages.FUNDS_SETTLED.state).not.toBe('REACHED');
  });
});

describe('termsAccepted', () => {
  const opportunity = { offerScope: 'Scope', priceCents: 1000, acceptanceCondition: 'Done when' };
  it('never invents a term', () => {
    expect(termsAccepted({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, opportunity, offerIsSent: true, currency: 'USD' })).toEqual({
      ok: true,
      amountCents: 1000,
      deliverable: 'Scope',
      acceptanceCondition: 'Done when',
    });
    expect(termsAccepted({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, opportunity: { ...opportunity, priceCents: null }, offerIsSent: true, currency: 'USD' })).toEqual({ ok: false, missing: 'the amount' });
    expect(termsAccepted({ observation: { kind: 'BUYER_COUNTERED', amountCents: 500, currency: 'EUR' }, opportunity, offerIsSent: true, currency: 'USD' }).ok).toBe(false);
    expect(termsAccepted({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, opportunity, offerIsSent: false, currency: 'USD' }).ok).toBe(false);
  });
});
