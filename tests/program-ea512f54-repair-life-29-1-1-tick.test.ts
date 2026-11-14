/**
 * LIFE-29-1 repair, episode 1: a buyer's acceptance of an offer Brain sent became nothing —
 * no agreement was ever recorded, so the commitment chain never started and the probe found
 * no transaction to read. The journey tick now records the agreement from the offer's own
 * terms, once, and names any term the sent offer did not state as a need instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { agreementsFor, recordObservation } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { EFFECT_INTENT_KIND } from '../server/services/cash/effects.ts';
import { composeBuyerMessage } from '../server/services/cash/outreach.ts';
import { offerVersion } from '../server/services/cash/perform.ts';
import { openNeeds } from '../server/services/cash/needs.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `life291r-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  });
});

afterEach(() => clearAdapters());

const SCOPE = 'One fixed-scope intake repair';
const ACCEPTANCE = 'Form submits and a test enquiry arrives';

/** A piece contacted once; `sent` writes the intent a Brain send carries (its offer digest). */
async function contacted(sent: boolean): Promise<string> {
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
      reachableChannel: 'owner@buyer.example',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: SCOPE,
      acceptanceCondition: ACCEPTANCE,
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
  if (sent) {
    const message = composeBuyerMessage((await getOpportunity(id))!);
    if (!message.ok) throw new Error(message.reason);
    await recordCashEvent({
      projectId, opportunityId: id, kind: EFFECT_INTENT_KIND, actorRef: 'BRAIN', summary: 'About to contact the buyer.',
      detail: { action: 'CONTACT_BUYER', occurrence: 'first', subjectRef: offerVersion(`${message.to}\n${message.subject}\n${message.text}`) },
    });
  }
  const began = await beginExecution({
    opportunityId: id,
    actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER', performedBy: sent ? 'BRAIN' : 'PERSON', detail: 'Sent the scope and price.',
      reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

async function answered(opportunityId: string, kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED', amountCents?: number): Promise<string> {
  const seen = await recordObservation({
    opportunityId, kind, source: 'PROVIDER', evidenceRef: `reply-${kind}-${opportunityId}`,
    amountCents: amountCents ?? null, observedAt: new Date(Date.now() + 60_000).toISOString(), actorRef: 'BRAIN',
  });
  if (!seen.ok) throw new Error(seen.reason);
  return seen.value.id;
}

async function agreedEntries(opportunityId: string) {
  return (await listMoneyEntries({ projectId, opportunityId, limit: 100 })).filter((one) => one.kind === 'PIPELINE_AGREED');
}

describe('an acceptance of a sent offer becomes an agreement on the next tick', () => {
  it('records exactly one agreement and PIPELINE_AGREED entry from the offer as sent, and none on a second tick', async () => {
    const id = await contacted(true);
    const observationId = await answered(id, 'BUYER_ACCEPTED');
    const first = await advanceJourney(projectId);
    expect(first.acceptances.agreed).toBe(1);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      amountCents: 75_000, currency: 'USD', deliverable: SCOPE, acceptanceCondition: ACCEPTANCE,
      evidenceKind: 'WRITTEN_ACCEPTANCE', observationId,
    });
    expect(await agreedEntries(id)).toHaveLength(1);

    const second = await advanceJourney(projectId);
    expect(second.acceptances.agreed).toBe(0);
    expect(await agreementsFor(id)).toHaveLength(1);
    expect(await agreedEntries(id)).toHaveLength(1);
  });

  it('agrees a counter-offer at the countered amount only', async () => {
    const id = await contacted(true);
    await answered(id, 'BUYER_COUNTERED', 60_000);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]!.amountCents).toBe(60_000);
    expect((await agreedEntries(id)).map((one) => one.amountCents)).toEqual([60_000]);
  });

  it('raises a need and records no agreement when no row states the terms that were sent', async () => {
    const id = await contacted(false); // recorded by hand: the words that reached the buyer are on no row
    const observationId = await answered(id, 'BUYER_ACCEPTED');
    const report = await advanceJourney(projectId);
    expect(report.acceptances).toMatchObject({ agreed: 0, needs: 1 });
    expect(await agreementsFor(id)).toHaveLength(0);
    const needs = (await openNeeds(projectId)).filter((one) => one.opportunityId === id && (one.completionCondition ?? "").includes(observationId));
    expect(needs).toHaveLength(1);
    expect(needs[0]!.whyItMatters).toMatch(/the amount, the deliverable, the acceptance condition/);
    await advanceJourney(projectId);
    expect((await openNeeds(projectId)).filter((one) => (one.completionCondition ?? "").includes(observationId))).toHaveLength(1);
  });

  it('raises a need when the card changed after the offer was sent, never agreeing today\'s price', async () => {
    const id = await contacted(true);
    expect((await fillCard({ opportunityId: id, actorRef: userId, patch: { priceCents: 90_000 } })).ok).toBe(true);
    await answered(id, 'BUYER_ACCEPTED');
    const report = await advanceJourney(projectId);
    expect(report.acceptances.needs).toBe(1);
    expect(await agreementsFor(id)).toHaveLength(0);
  });
});

describe('the resulting deal reads as commitments', () => {
  it('passes commitmentProblem against its ledger, every transition carrying duty, deadline, outcome and evidence', async () => {
    const id = await contacted(true);
    await answered(id, 'BUYER_ACCEPTED');
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
