/**
 * LIFE-29-3 (repair F2): the acceptance demonstration and an approved remedy are reachable in
 * production, through the journey tick alone. Nothing here calls `rehearseStoredCase` or
 * `carryOutApprovedRefund` directly: a person's only acts are the ones the running Brain already
 * offers (recording an agreement, a delivery, an acceptance, money, and resolving a need), and the
 * tick does the rest — asks for the approval a committing remedy needs, carries out the remedy a
 * person approved, and traces a settled, sourced case with its failure path once, which is what
 * makes r01.life-29-3 pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { needForKey } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, readObligation, recordEvent } from '../server/services/cash/journey/fulfillment.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import { remedyApprovalKey } from '../server/services/cash/deliverables/exceptions.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `life29-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  });
});

afterEach(() => clearAdapters());

async function executing(title = 'A paid intake repair', priceCents = 75_000, mechanism = 'EXPLICIT_PAID_REQUEST', source: string | null = null): Promise<string> {
  const captured = await capture({
    projectId,
    source,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: mechanism as 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied on Tuesday',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents,
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
    firstAction: {
      action: 'CONTACT_BUYER',
      performedBy: 'PERSON',
      detail: 'Sent the scope and price.',
      reference: `msg-${id}`,
      requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

async function agree(opportunityId: string, amountCents = 75_000, deliverable = 'Repair the intake form'): Promise<CashAgreement> {
  const done = await recordAgreement({
    opportunityId,
    amountCents,
    currency: 'USD',
    deliverable,
    acceptanceCondition: 'Form submits and a test enquiry arrives',
    evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${opportunityId}-${deliverable}`,
    actorRef: userId,
  });
  if (!done.ok) throw new Error(done.reason);
  return done.value;
}


async function settled(opportunityId: string, amountCents = 75_000): Promise<void> {
  for (const kind of ['CUSTOMER_PAYMENT', 'SETTLEMENT'] as const) {
    const written = await recordMoneyEvent({ projectId, opportunityId, kind, amountCents, currency: 'USD', verifiedReference: `${kind}-${opportunityId}`, idempotencyKey: `${kind}:${opportunityId}`, actorRef: userId, appliesTo: null });
    expect(written.ok).toBe(true);
  }
}

async function performedBy(agreement: CashAgreement): Promise<void> {
  const done = await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The owner', actorRef: userId });
  if (!done.ok) throw new Error(done.reason);
}

async function event(agreement: CashAgreement, kind: string): Promise<void> {
  const done = await recordEvent({ projectId, agreementId: agreement.id, kind, detail: kind.toLowerCase(), evidenceRef: `ev-${kind}-${agreement.id}`, actorRef: userId });
  if (!done.ok) throw new Error(done.reason);
}

const probe = (name: string) => getProbe(name)!({});

describe('an approved remedy is carried out by the tick (LIFE-29-3)', () => {
  it('asks a person to approve a refund for a rejected delivery, and carries it out once they do', async () => {
    const id = await executing('Disputed repair', 75_000, 'EXPLICIT_PAID_REQUEST', 'https://example.test/request/disputed');
    const agreement = await agree(id);
    await performedBy(agreement);
    await settled(id);
    await event(agreement, 'WORK_COMPLETE');
    await event(agreement, 'DELIVERED');
    await event(agreement, 'REJECTED');

    await advanceJourney(projectId);
    const [detected] = await cashEventsOfKind(id, 'exception.detected');
    const exceptionId = String((detected!.detail as { exceptionId: string }).exceptionId);
    expect((detected!.detail as { kind: string }).kind).toBe('DISPUTE');
    const need = await needForKey(projectId, remedyApprovalKey(id, exceptionId, 'APPROVED_REFUND'));
    expect(need?.state).toBe('OPEN');
    expect(need?.expectedCostCents).toBe(75_000);

    // Unapproved, nothing is carried out however often the tick runs.
    await advanceJourney(projectId);
    expect(await cashEventsOfKind(id, 'remedy.carried_out')).toHaveLength(0);
    expect((await readObligation(agreement)).refunds).toHaveLength(0);

    // The person's approval is resolving the need on the surface they already use.
    expect((await closeNeed({ needId: need!.id, to: 'RESOLVED', resolution: 'Approved: refund in full.', actorUserId: userId })).ok).toBe(true);
    const pass = await advanceJourney(projectId);
    expect(pass.remedies.carriedOut).toBe(1);
    const carried = await cashEventsOfKind(id, 'remedy.carried_out');
    expect(carried).toHaveLength(1);
    expect(carried[0]!.actorRef).toBe(userId);
    expect(carried[0]!.detail).toMatchObject({ remedy: 'APPROVED_REFUND', approvedBy: userId, exceptionId });
    const refunds = (await readObligation(agreement)).refunds;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountCents).toBe(75_000);

    // Carried out once: the next pass does not refund again.
    await advanceJourney(projectId);
    expect(await cashEventsOfKind(id, 'remedy.carried_out')).toHaveLength(1);
    expect((await readObligation(agreement)).refunds).toHaveLength(1);
  });

  it('a withdrawn approval is a decline: nothing is carried out', async () => {
    const id = await executing('Declined refund', 75_000, 'EXPLICIT_PAID_REQUEST', 'https://example.test/request/declined');
    const agreement = await agree(id);
    await performedBy(agreement);
    await settled(id);
    await event(agreement, 'WORK_COMPLETE');
    await event(agreement, 'DELIVERED');
    await event(agreement, 'REJECTED');
    await advanceJourney(projectId);
    const [detected] = await cashEventsOfKind(id, 'exception.detected');
    const need = await needForKey(projectId, remedyApprovalKey(id, String((detected!.detail as { exceptionId: string }).exceptionId), 'APPROVED_REFUND'));
    expect((await closeNeed({ needId: need!.id, to: 'WITHDRAWN', resolution: 'Not refunding; we will redo it.', actorUserId: userId })).ok).toBe(true);
    await advanceJourney(projectId);
    expect(await cashEventsOfKind(id, 'remedy.carried_out')).toHaveLength(0);
    expect((await readObligation(agreement)).refunds).toHaveLength(0);
  });
});

describe('the acceptance demonstration is produced by the tick (LIFE-29-3)', () => {
  async function milestoneCase(source: string | null): Promise<{ id: string; kept: CashAgreement }> {
    const id = await executing('Two-milestone repair', 100_000, 'EXPLICIT_PAID_REQUEST', source);
    const kept = await agree(id, 75_000, 'Repair the intake form');
    const dropped = await agree(id, 25_000, 'Migrate the old enquiries');
    expect((await releaseAgreement({ agreementId: dropped.id, reason: 'The buyer cancelled the second milestone.', actorRef: userId })).ok).toBe(true);
    await performedBy(kept);
    await settled(id);
    await event(kept, 'WORK_COMPLETE');
    await event(kept, 'DELIVERED');
    await event(kept, 'ACCEPTED');
    return { id, kept };
  }

  it('traces a sourced, accepted and settled case with its failure and recovery once, and the probe passes', async () => {
    const { id } = await milestoneCase('https://example.test/request/two-milestones');
    await advanceJourney(projectId);
    const before = await probe('r01.life-29-3');
    expect(before.ok).toBe(false);
    // The cancellation's committing remedy waits on a person, so the trace waits for the decision.
    expect(await cashEventsOfKind(id, 'rehearsal.traced')).toHaveLength(0);
    // The release shows on the agreement and on its ledger entry: each is a cancellation, each needs a decision.
    const detected = await cashEventsOfKind(id, 'exception.detected');
    expect(detected.length).toBeGreaterThan(0);
    for (const one of detected) {
      expect((one.detail as { kind: string }).kind).toBe('CANCELLATION');
      const need = await needForKey(projectId, remedyApprovalKey(id, String((one.detail as { exceptionId: string }).exceptionId), 'ORDERLY_CANCELLATION'));
      expect(need?.state).toBe('OPEN');
      // One decision outstanding still holds the trace back.
      expect((await advanceJourney(projectId)).rehearsals).toBe(0);
      expect((await closeNeed({ needId: need!.id, to: 'RESOLVED', resolution: 'Release the second milestone in order.', actorUserId: userId })).ok).toBe(true);
    }

    const pass = await advanceJourney(projectId);
    expect(pass.rehearsals).toBe(1);
    const decided = await cashEventsOfKind(id, 'remedy.decided');
    expect(decided).toHaveLength(detected.length);
    const traces = await cashEventsOfKind(id, 'rehearsal.traced');
    expect(traces).toHaveLength(1);
    const trace = traces[0]!.detail as { valid: boolean; sourceRef: string; reached: string[]; steps: { kind: string; detail: string }[] };
    expect(trace.valid).toBe(true);
    expect(trace.sourceRef).toBe('https://example.test/request/two-milestones');
    expect(trace.reached).toEqual(expect.arrayContaining(['WORK_ACCEPTED', 'FUNDS_SETTLED']));
    for (const kind of ['STATE_CHANGE', 'IDENTITY', 'MONEY', 'EXCEPTION', 'AUTHORITY', 'RECOVERY']) {
      expect(trace.steps.some((s) => s.kind === kind)).toBe(true);
    }
    expect(trace.steps.find((s) => s.kind === 'RECOVERY')!.detail).toContain('ORDERLY_CANCELLATION');

    const after = await probe('r01.life-29-3');
    expect(after.detail).toMatch(/sourced rehearsal\(s\) traced/);
    expect(after.ok).toBe(true);

    // Traced once, however often the tick runs.
    expect((await advanceJourney(projectId)).rehearsals).toBe(0);
    expect(await cashEventsOfKind(id, 'rehearsal.traced')).toHaveLength(1);
  });

  it('does not trace a case that names no source', async () => {
    const { id } = await milestoneCase(null);
    await advanceJourney(projectId);
    for (const one of await cashEventsOfKind(id, 'exception.detected')) {
      const need = await needForKey(projectId, remedyApprovalKey(id, String((one.detail as { exceptionId: string }).exceptionId), 'ORDERLY_CANCELLATION'));
      expect((await closeNeed({ needId: need!.id, to: 'RESOLVED', resolution: 'Release it.', actorUserId: userId })).ok).toBe(true);
    }
    expect((await advanceJourney(projectId)).rehearsals).toBe(0);
    expect(await cashEventsOfKind(id, 'rehearsal.traced')).toHaveLength(0);
    expect(await cashEventsOfKind(id, 'rehearsal.refused')).toHaveLength(0);
    expect((await probe('r01.life-29-3')).ok).toBe(false);
  });
});
