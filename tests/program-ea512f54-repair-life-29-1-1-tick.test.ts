/**
 * LIFE-29-1 repair: a buyer's acceptance of an offer Brain sent becomes the
 * agreement it evidences on the next journey tick, on the terms the rows prove
 * were sent — so the commitment chain a transaction is read as actually starts.
 * A counter-offer agrees at the countered amount only; an offer that does not
 * state a term raises a need and records no agreement.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCashEvent } from '../server/repos/cashMode.ts';
import { getOpportunity, transitionOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { EFFECT_INTENT_KIND } from '../server/services/cash/effects.ts';
import { composeBuyerMessage } from '../server/services/cash/outreach.ts';
import { offerVersion } from '../server/services/cash/perform.ts';
import { recordObservation } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';

let projectId = '';
let opportunityId = '';
let authorityId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const userId = (
    await createUser({
      email: `life291tick-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
  expect(
    (await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok,
  ).toBe(true);
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Intake form repair', mechanism: 'OTHER', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  opportunityId = captured.value.id;
  await updateOpportunity(opportunityId, {
    payer: 'The operations manager',
    reachable_channel: 'ops@intake-buyer.example',
    offer_scope: 'Repair the intake form and confirm submissions arrive.',
    acceptance_condition: 'Three test submissions arrive in the buyer inbox.',
    price_cents: 120_000,
    delivery_method: 'Delivered by the named operator.',
  });
  const from = (await getOpportunity(opportunityId))!.state;
  expect(await transitionOpportunity({ id: opportunityId, from: [from], to: 'EXECUTING' })).toBe(true);
  authorityId = (
    await createAuthority({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'grant',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 1_000_000,
      maxPerActionCents: 400_000,
      maxConcurrent: 3,
      currency: 'USD',
    })
  ).id;
});

/** A contact Brain sent, with the intent carrying the digest of the exact message it sent. */
async function sentContact(occurrence = 'occ1'): Promise<void> {
  const message = composeBuyerMessage((await getOpportunity(opportunityId))!);
  if (!message.ok) throw new Error(message.reason);
  await recordCashEvent({
    projectId,
    opportunityId,
    kind: EFFECT_INTENT_KIND,
    actorRef: 'BRAIN',
    summary: 'about to contact',
    detail: {
      correlationId: `c-${occurrence}`,
      action: 'CONTACT_BUYER',
      occurrence,
      retry: 0,
      authorityId,
      amountCents: null,
      stateAtSend: 'EXECUTING',
      subjectRef: offerVersion(`${message.to}\n${message.subject}\n${message.text}`),
    },
  });
  await recordAction({
    projectId,
    opportunityId,
    authorityId,
    action: 'CONTACT_BUYER',
    performedBy: 'BRAIN',
    reference: `msg-${occurrence}`,
    detail: 'Reached the buyer with the offer on this card.',
    confirmedBy: 'BRAIN',
    requestKey: `perform:${opportunityId}:CONTACT_BUYER:${occurrence}`,
  });
}

async function observe(kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED', evidenceRef: string, amountCents?: number) {
  const seen = await recordObservation({ opportunityId, kind, source: 'PROVIDER', evidenceRef, amountCents: amountCents ?? null, actorRef: 'BRAIN' });
  if (!seen.ok) throw new Error(seen.reason);
  return seen.value;
}

async function pipelineAgreed(): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? AND kind = 'PIPELINE_AGREED'",
    [opportunityId],
  );
  return Number(row?.n ?? 0);
}

async function needsFor(observationId: string): Promise<number> {
  const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM cash_needs WHERE request_key = ?', [`acceptance-terms:${observationId}`]);
  return Number(row?.n ?? 0);
}

describe('an acceptance of a sent offer becomes its agreement on the tick', () => {
  it('A01: yields exactly one agreement and one PIPELINE_AGREED on the next tick, and none on a second', async () => {
    await sentContact();
    const accepted = await observe('BUYER_ACCEPTED', 'instantly:email:em_1:i_status:4');
    const first = await advanceJourney(projectId);
    expect(first.acceptances.agreed).toHaveLength(1);
    const agreements = await agreementsFor(opportunityId);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      amountCents: 120_000,
      deliverable: 'Repair the intake form and confirm submissions arrive.',
      acceptanceCondition: 'Three test submissions arrive in the buyer inbox.',
      evidenceKind: 'WRITTEN_ACCEPTANCE',
      observationId: accepted.id,
      state: 'AGREED',
    });
    expect(await pipelineAgreed()).toBe(1);

    const second = await advanceJourney(projectId);
    expect(second.acceptances.agreed).toHaveLength(0);
    expect(await agreementsFor(opportunityId)).toHaveLength(1);
    expect(await pipelineAgreed()).toBe(1);
  });

  it('A01: a counter-offer yields an agreement at the countered amount only', async () => {
    await sentContact();
    const countered = await observe('BUYER_COUNTERED', 'buyer email: "we can do $900"', 90_000);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(opportunityId);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ amountCents: 90_000, observationId: countered.id });
    expect(agreements.some((one) => one.amountCents === 120_000)).toBe(false);
  });

  it('A01: an offer that states no acceptance condition yields a need and no agreement', async () => {
    await updateOpportunity(opportunityId, { acceptance_condition: null });
    await sentContact();
    const accepted = await observe('BUYER_ACCEPTED', 'buyer email: "yes"');
    const pass = await advanceJourney(projectId);
    expect(pass.acceptances.needs).toEqual([{ observationId: accepted.id, missing: ['the acceptance condition'] }]);
    expect(await agreementsFor(opportunityId)).toHaveLength(0);
    expect(await needsFor(accepted.id)).toBe(1);
    await advanceJourney(projectId);
    expect(await needsFor(accepted.id)).toBe(1);
  });

  it('a contact no row records the words of, or a card changed since the send, yields a need rather than a guess', async () => {
    await recordAction({ projectId, opportunityId, authorityId, action: 'CONTACT_BUYER', performedBy: 'PERSON', reference: 'by hand', detail: 'Called them.', confirmedBy: 'owner', requestKey: `hand:${opportunityId}` });
    const byHand = await observe('BUYER_ACCEPTED', 'phone call');
    let pass = await advanceJourney(projectId);
    expect(pass.acceptances.needs[0]?.observationId).toBe(byHand.id);
    expect(await agreementsFor(opportunityId)).toHaveLength(0);

    await sentContact('occ2');
    await updateOpportunity(opportunityId, { price_cents: 150_000 });
    const changed = await observe('BUYER_ACCEPTED', 'buyer email after the card changed');
    pass = await advanceJourney(projectId);
    expect(pass.acceptances.needs.map((one) => one.observationId)).toContain(changed.id);
    expect(await agreementsFor(opportunityId)).toHaveLength(0);
  });

  it('an acceptance a person already answered with an agreement is left alone', async () => {
    await sentContact();
    await observe('BUYER_ACCEPTED', 'buyer email: "go ahead"');
    const { recordAgreement } = await import('../server/services/cash/journey/deal.ts');
    const byPerson = await recordAgreement({
      opportunityId,
      amountCents: 110_000,
      currency: 'USD',
      deliverable: 'Repair the intake form.',
      acceptanceCondition: 'It works.',
      evidenceKind: 'SIGNED_AGREEMENT',
      evidenceRef: 'signed pdf',
      actorRef: 'owner',
    });
    expect(byPerson.ok).toBe(true);
    const pass = await advanceJourney(projectId);
    expect(pass.acceptances.agreed).toHaveLength(0);
    expect(await agreementsFor(opportunityId)).toHaveLength(1);
  });

  it('A01: readCommitments on the resulting deal passes commitmentProblem, every transition carrying duty, deadline, outcome and evidence', async () => {
    await sentContact();
    await observe('BUYER_ACCEPTED', 'instantly:email:em_2:i_status:4');
    await advanceJourney(projectId);
    const reading = await readCommitments({ projectId, opportunityId, currency: 'USD' });
    expect(commitmentProblem(reading, { payments: 0, settlements: 0 })).toBeNull();
    expect(reading.transitions.length).toBeGreaterThan(0);
    for (const t of reading.transitions) {
      expect(typeof t.duty.action).toBe('string');
      expect('deadline' in t).toBe(true);
      expect(t.outcome).toBeTruthy();
      expect(Array.isArray(t.evidence)).toBe(true);
    }
  });
});
