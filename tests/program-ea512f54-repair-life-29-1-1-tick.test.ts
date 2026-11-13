/**
 * LIFE-29-1 repair: a buyer's acceptance or counter-offer on a deal after its
 * first action becomes the agreement it is on the next journey tick, from the
 * terms of the offer it answers — never twice, never at an invented term — and
 * the commitment chain the probe reads starts from it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, recordObservation } from '../server/services/cash/journey/deal.ts';
import { offerTerms } from '../server/services/cash/journey/acceptance.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { openNeeds } from '../server/services/cash/needs.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
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

async function contacted(priceCents = 75_000): Promise<string> {
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id, actorRef: userId,
    patch: {
      payer: 'The owner, who signs', reachableChannel: 'Replied on Tuesday', buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z', offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives', priceCents,
      deliveryMethod: 'One afternoon of configuration', fulfillmentOwner: 'Us', peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
  }
  expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
  const began = await beginExecution({
    opportunityId: id, actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.',
      reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

async function observe(opportunityId: string, kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED', amountCents: number | null = null): Promise<string> {
  const seen = await recordObservation({
    opportunityId, kind, source: 'PERSON', evidenceRef: `reply-${opportunityId}-${kind}`,
    amountCents, observedAt: new Date(Date.now() + 1000).toISOString(), actorRef: userId,
  });
  if (!seen.ok) throw new Error(seen.reason);
  return seen.value.id;
}

const agreedEntries = async (opportunityId: string) =>
  (await listMoneyEntries({ projectId, opportunityId })).filter((one) => one.kind === 'PIPELINE_AGREED');

describe('an acceptance becomes an agreement on the tick', () => {
  it('records exactly one agreement and PIPELINE_AGREED entry from the offer it answers, and none on a second tick', async () => {
    const id = await contacted();
    const observationId = await observe(id, 'BUYER_ACCEPTED');
    const first = await advanceJourney(projectId);
    expect(first.agreements.recorded).toHaveLength(1);
    expect(first.agreements.refused).toEqual([]);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      amountCents: 75_000,
      deliverable: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      observationId,
      recordedBy: 'BRAIN',
    });
    expect(await agreedEntries(id)).toHaveLength(1);

    const second = await advanceJourney(projectId);
    expect(second.agreements.recorded).toEqual([]);
    expect(await agreementsFor(id)).toHaveLength(1);
    expect(await agreedEntries(id)).toHaveLength(1);
  });

  it('agrees a counter-offer at the countered amount only', async () => {
    const id = await contacted();
    const observationId = await observe(id, 'BUYER_COUNTERED', 60_000);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]!.amountCents).toBe(60_000);
    expect(agreements[0]!.observationId).toBe(observationId);
    const entries = await agreedEntries(id);
    expect(entries.map((one) => one.amountCents)).toEqual([60_000]);
  });

  it('raises a need naming the term an offer did not state, and records no agreement', async () => {
    const id = await contacted();
    const cleared = await fillCard({ opportunityId: id, actorRef: userId, patch: { acceptanceCondition: null } });
    expect(cleared.ok).toBe(true);
    const observationId = await observe(id, 'BUYER_ACCEPTED');
    const report = await advanceJourney(projectId);
    expect(report.agreements.recorded).toEqual([]);
    expect(report.agreements.needs).toEqual([{ observationId, missing: ['the acceptance condition'] }]);
    expect(await agreementsFor(id)).toHaveLength(0);
    expect(await agreedEntries(id)).toHaveLength(0);
    const needs = (await openNeeds(projectId)).filter((one) => one.opportunityId === id && /acceptance condition/.test(one.whyItMatters));
    expect(needs).toHaveLength(1);
    // Raised once, however often the tick runs.
    await advanceJourney(projectId);
    expect((await openNeeds(projectId)).filter((one) => one.opportunityId === id && /acceptance condition/.test(one.whyItMatters))).toHaveLength(1);
  });

  it('starts the commitment chain the probe reads: every transition carries duty, deadline, outcome and evidence', async () => {
    const id = await contacted();
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
    const probe = await getProbe('r01.life-29-1')!({});
    expect(probe.ok).toBe(true);
  });
});

describe('a person recording the acceptance Brain already agreed', () => {
  it('reads the standing agreement instead of counting the deal twice, and refuses a different amount', async () => {
    const id = await contacted();
    const observationId = await observe(id, 'BUYER_ACCEPTED');
    await advanceJourney(projectId);
    const [standing] = await agreementsFor(id);
    const base = { opportunityId: id, currency: 'USD', deliverable: 'Repair the intake form', acceptanceCondition: 'Form submits', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: 'email', observationId, actorRef: userId };
    const same = await recordAgreement({ ...base, amountCents: 75_000 });
    expect(same.ok && same.value.id).toBe(standing!.id);
    expect((await recordAgreement({ ...base, amountCents: 50_000 })).ok).toBe(false);
    expect(await agreementsFor(id)).toHaveLength(1);
    expect(await agreedEntries(id)).toHaveLength(1);
  });
});

describe('offerTerms', () => {
  const card = { offerScope: 'Scope', acceptanceCondition: 'Accepted when X', priceCents: 10_000, currency: 'USD' };
  it('takes the price for an acceptance, the countered amount for a counter, and names what is missing', () => {
    expect(offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null }, card, currency: 'USD' })).toMatchObject({ ok: true, amountCents: 10_000 });
    expect(offerTerms({ observation: { kind: 'BUYER_COUNTERED', amountCents: 8_000 }, card, currency: 'USD' })).toMatchObject({ ok: true, amountCents: 8_000 });
    expect(offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null }, card: { ...card, priceCents: null, offerScope: ' ' }, currency: 'USD' }))
      .toEqual({ ok: false, missing: ['the deliverable (the offer scope)', 'the amount'] });
  });
});
