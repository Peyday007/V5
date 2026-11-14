/**
 * LIFE-29-1 repair: a buyer's acceptance (or counter) answering a sent offer
 * becomes the agreement it evidences on the journey tick, on the terms of the
 * offer that was sent — never terms Brain composed — so the commitment chain
 * starts without a person re-typing what Brain already holds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordObservation } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { acceptanceNeedKey, carriesAgreement, contactAnswered } from '../server/services/cash/journey/acceptance.ts';
import { EFFECT_INTENT_KIND, effectCorrelation } from '../server/services/cash/effects.ts';
import { composeBuyerMessage } from '../server/services/cash/outreach.ts';
import { offerVersion } from '../server/services/cash/perform.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAction } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let authorityId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `life291t-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  authorityId = (await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  })).id;
});

afterEach(() => clearAdapters());

const OCCURRENCE = 'first';

/** A piece whose offer was sent by Brain: the contact, and the intent carrying the offer's digest. */
async function sentOffer(options: { acceptanceCondition?: string | null; intent?: boolean } = {}): Promise<string> {
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'buyer@intake.example',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents: 75_000,
      deliveryMethod: 'One afternoon of configuration',
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
    firstAction: { action: 'CONTACT_BUYER', performedBy: 'BRAIN', detail: 'Reached the buyer with the offer on this card.', reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', OCCURRENCE) },
  });
  if (!began.ok) throw new Error(began.reason);
  if (options.acceptanceCondition === null) {
    // An offer sent before a card had to state its acceptance condition: the
    // words that reached the buyer carry none. Only a row written under the
    // older rule can look like this, so it is written as one.
    await getDb().run('UPDATE cash_opportunities SET acceptance_condition = NULL WHERE id = ?', [id]);
  }
  if (options.intent !== false) {
    const message = composeBuyerMessage((await getOpportunity(id))!);
    if (!message.ok) throw new Error(message.reason);
    await recordCashEvent({
      projectId, opportunityId: id, kind: EFFECT_INTENT_KIND, actorRef: 'BRAIN', summary: 'Brain is about to attempt reaching the buyer.',
      detail: {
        correlationId: effectCorrelation(id, 'CONTACT_BUYER', OCCURRENCE), action: 'CONTACT_BUYER', occurrence: OCCURRENCE, retry: 0,
        authorityId, amountCents: null, stateAtSend: 'READY', subjectRef: offerVersion(`${message.to}\n${message.subject}\n${message.text}`),
      },
    });
  }
  return id;
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

async function answer(opportunityId: string, kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED' | 'BUYER_REPLIED', amountCents: number | null = null): Promise<string> {
  const done = await recordObservation({
    opportunityId, kind, source: 'PROVIDER', evidenceRef: `instantly:email:${kind}:${opportunityId}`,
    amountCents, observedAt: later(5_000), actorRef: 'BRAIN',
  });
  if (!done.ok) throw new Error(done.reason);
  return done.value.id;
}

async function agreedEntries(opportunityId: string) {
  return (await listMoneyEntries({ projectId, opportunityId, limit: 100 })).filter((one) => one.kind === 'PIPELINE_AGREED');
}

describe('the rules the tick reads', () => {
  it('only an acceptance, or a counter that states an amount, can carry an agreement', () => {
    expect(carriesAgreement({ kind: 'BUYER_ACCEPTED', amountCents: null })).toBe(true);
    expect(carriesAgreement({ kind: 'BUYER_COUNTERED', amountCents: 60_000 })).toBe(true);
    expect(carriesAgreement({ kind: 'BUYER_COUNTERED', amountCents: null })).toBe(false);
    expect(carriesAgreement({ kind: 'BUYER_REPLIED', amountCents: null })).toBe(false);
  });

  it('an answer answers the latest contact sent at or before it', () => {
    const c = (id: string, createdAt: string) => ({ id, createdAt }) as CashAction;
    const contacts = [c('a', '2026-11-01T00:00:00.000Z'), c('b', '2026-11-05T00:00:00.000Z')];
    expect(contactAnswered(contacts, '2026-11-03T00:00:00.000Z')?.id).toBe('a');
    expect(contactAnswered(contacts, '2026-11-06T00:00:00.000Z')?.id).toBe('b');
    expect(contactAnswered(contacts, '2026-10-01T00:00:00.000Z')).toBeNull();
  });
});

describe('an acceptance answering a sent offer becomes its agreement on the tick', () => {
  it('records exactly one agreement and one PIPELINE_AGREED on the offer’s terms, and none on a second tick', async () => {
    const id = await sentOffer();
    const observationId = await answer(id, 'BUYER_ACCEPTED');

    const first = await advanceJourney(projectId);
    expect(first.acceptances.agreed).toHaveLength(1);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      amountCents: 75_000,
      currency: 'USD',
      deliverable: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      evidenceRef: `instantly:email:BUYER_ACCEPTED:${id}`,
      observationId,
      recordedBy: 'BRAIN',
    });
    expect(await agreedEntries(id)).toHaveLength(1);

    const second = await advanceJourney(projectId);
    expect(second.acceptances.agreed).toHaveLength(0);
    expect(await agreementsFor(id)).toHaveLength(1);
    expect(await agreedEntries(id)).toHaveLength(1);
  });

  it('a counter-offer is agreed at the countered amount only', async () => {
    const id = await sentOffer();
    const observationId = await answer(id, 'BUYER_COUNTERED', 60_000);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ amountCents: 60_000, observationId });
    const entries = await agreedEntries(id);
    expect(entries.map((one) => one.amountCents)).toEqual([60_000]);
  });

  it('a reply is never an agreement', async () => {
    const id = await sentOffer();
    await answer(id, 'BUYER_REPLIED');
    await advanceJourney(projectId);
    expect(await agreementsFor(id)).toHaveLength(0);
  });

  it('an offer that states no acceptance condition raises a need naming it and records no agreement', async () => {
    const id = await sentOffer({ acceptanceCondition: null });
    const observationId = await answer(id, 'BUYER_ACCEPTED');
    const tick = await advanceJourney(projectId);
    expect(tick.acceptances.needs).toEqual([{ observationId, missing: 'acceptanceCondition' }]);
    expect(await agreementsFor(id)).toHaveLength(0);
    expect(await agreedEntries(id)).toHaveLength(0);
    const needs = (await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey === acceptanceNeedKey(observationId));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toContain('acceptanceCondition');
    // A second tick raises the same need, not another.
    await advanceJourney(projectId);
    expect((await listNeeds({ projectId, states: ['OPEN'] })).filter((one) => one.requestKey === acceptanceNeedKey(observationId))).toHaveLength(1);
  });

  it('a contact with no record of the words sent is not read as an offer: a need, no agreement', async () => {
    const id = await sentOffer({ intent: false });
    const observationId = await answer(id, 'BUYER_ACCEPTED');
    const tick = await advanceJourney(projectId);
    expect(tick.acceptances.needs).toEqual([{ observationId, missing: 'the offer that was sent' }]);
    expect(await agreementsFor(id)).toHaveLength(0);
  });

  it('the resulting deal reads as commitments that pass the probe’s check against its ledger', async () => {
    const id = await sentOffer();
    await answer(id, 'BUYER_ACCEPTED');
    await advanceJourney(projectId);
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    const entries = await listMoneyEntries({ projectId, opportunityId: id, limit: 100 });
    const sum = (kind: string) => entries.filter((one) => one.kind === kind).reduce((n, one) => n + one.amountCents, 0);
    expect(commitmentProblem(reading, { payments: sum('CUSTOMER_PAYMENT'), settlements: sum('SETTLEMENT') })).toBeNull();
    expect(reading.transitions.length).toBeGreaterThan(0);
    for (const t of reading.transitions) {
      expect(typeof t.duty.action).toBe('string');
      expect('deadline' in t).toBe(true);
      expect(t.outcome).toBeTruthy();
      expect(Array.isArray(t.evidence)).toBe(true);
    }
  });
});
