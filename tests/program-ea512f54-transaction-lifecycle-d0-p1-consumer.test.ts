/**
 * LIFE-29-1/29-3: the journey tick reads each deal as commitments, detects the exceptions its
 * rows show once, and the probes judge those rows. A released agreement is a cancellation; it is
 * recorded once however often the tick runs, and a rehearsal is what makes the probe pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { RECOVERY_EVENT, agreementOfTransition, refundApprovalKey, rehearseStoredCase } from '../server/services/cash/deliverables/exceptions.ts';
import { declare } from '../server/services/cash/journey/fulfillment.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import { needForKey } from '../server/repos/cashPortfolio.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
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
    actorRef: userId,
    ownerUserId: userId,
    title,
    source,
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


async function settled(opportunityId: string): Promise<void> {
  for (const kind of ['CUSTOMER_PAYMENT', 'SETTLEMENT'] as const) {
    const written = await recordMoneyEvent({ projectId, opportunityId, kind, amountCents: 75_000, currency: 'USD', verifiedReference: `${kind}-${opportunityId}`, idempotencyKey: `${kind}:${opportunityId}`, actorRef: userId, appliesTo: null });
    expect(written.ok).toBe(true);
  }
}

const probe = (name: string) => getProbe(name)!({});

describe('probes are registered, and fail with no transaction to read', () => {
  it('registers r01.life-29-1 and r01.life-29-3 and passes neither on nothing', async () => {
    for (const name of ['r01.life-29-1', 'r01.life-29-3']) {
      const r = await probe(name);
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/no opportunity has an agreement/);
    }
  });
});

describe('the journey tick consumes the commitment model', () => {
  it('reads a paid and settled deal as separate commitments that agree with the ledger', async () => {
    const id = await executing();
    await agree(id);
    await settled(id);
    await advanceJourney(projectId);
    const r = await probe('r01.life-29-1');
    expect(r.detail).toMatch(/1 transaction\(s\) read as commitments/);
    expect(r.ok).toBe(true);
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(reading.stages.FUNDS_SETTLED.state).toBe('REACHED');
    expect(reading.stages.WORK_ACCEPTED.state).not.toBe('REACHED');
  });

  it('records the exception a released agreement shows exactly once, however often the tick runs', async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    const first = await advanceJourney(projectId);
    expect(first.exceptions.recorded).toBeGreaterThan(0);
    const events = await cashEventsOfKind(id, 'exception.detected');
    expect(events.length).toBe(first.exceptions.recorded);
    const detail = events[0]!.detail as { kind: string; chosen: unknown; needs: unknown; remedies: unknown[] };
    expect(detail.kind).toBe('CANCELLATION');
    expect(detail.chosen).toBeNull(); // no authority is held, so nothing is taken
    expect(detail.remedies.length).toBeGreaterThan(0);
    const second = await advanceJourney(projectId);
    expect(second.exceptions.recorded).toBe(0);
    expect((await cashEventsOfKind(id, 'exception.detected')).length).toBe(events.length);
  });

  it('r01.life-29-3 fails until a sourced rehearsal with a failure path is traced, then passes', async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    await advanceJourney(projectId);
    const before = await probe('r01.life-29-3');
    expect(before.ok).toBe(false);
    expect(before.detail).toMatch(/no valid, sourced rehearsal/);
    const traced = await rehearseStoredCase({ projectId, opportunityId: id, currency: 'USD', sourceRef: `email-${id}`, actorRef: userId });
    if (traced.eventKind === 'rehearsal.traced') {
      expect((await probe('r01.life-29-3')).ok).toBe(true);
    } else {
      // The trace refused (for example no accepted fulfilment yet): it is recorded as a refusal and never counts.
      expect(traced.rehearsal.valid).toBe(false);
      expect((await probe('r01.life-29-3')).ok).toBe(false);
    }
  });

  it('fails an exception the rows show that was never recorded', async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    const r = await probe('r01.life-29-3'); // the tick has not run
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not on record/);
  });
});

describe('the journey tick carries a case forward (LIFE-29-3 on the live path)', () => {
  it('rehearses a sourced case from its rows on its own, once per change, and the probe passes on that row', async () => {
    const id = await executing('A paid intake repair', 75_000, 'EXPLICIT_PAID_REQUEST', 'https://example.test/requests/intake-repair');
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    expect((await probe('r01.life-29-3')).ok).toBe(false);
    const first = await advanceJourney(projectId);
    expect(first.recovery.rehearsed).toBe(1);
    const traced = await cashEventsOfKind(id, 'rehearsal.traced');
    expect(traced.length).toBe(1);
    const detail = traced[0]!.detail as { sourceRef: string; valid: boolean; exceptions: unknown[]; fingerprint: string | null };
    expect(detail.sourceRef).toBe('https://example.test/requests/intake-repair');
    expect(detail.valid).toBe(true);
    expect(detail.exceptions.length).toBeGreaterThan(0);
    expect(detail.fingerprint).toBeTruthy();
    const r = await probe('r01.life-29-3');
    expect(r.detail).toMatch(/sourced rehearsal/);
    expect(r.ok).toBe(true);
    // Nothing changed, so the next pass traces nothing new.
    const second = await advanceJourney(projectId);
    expect(second.recovery.rehearsed).toBe(0);
    expect((await cashEventsOfKind(id, 'rehearsal.traced')).length).toBe(1);
  });

  it('does not rehearse a case with no source, so it is never mistaken for a demonstration', async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    const pass = await advanceJourney(projectId);
    expect(pass.recovery.rehearsed).toBe(0);
    expect((await cashEventsOfKind(id, 'rehearsal.traced')).length).toBe(0);
    expect((await probe('r01.life-29-3')).ok).toBe(false);
  });

  it('asks once for a refund approval, carries the refund out only after a person approves it, and records the recovery', async () => {
    const id = await executing('A paid intake repair', 75_000, 'EXPLICIT_PAID_REQUEST', 'https://example.test/requests/refund-case');
    const agreement = await agree(id);
    const declared = await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The owner', actorRef: userId });
    expect(declared.ok).toBe(true);
    await settled(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled after paying.', actorRef: userId })).ok).toBe(true);

    const first = await advanceJourney(projectId);
    expect(first.recovery.asked).toBe(1);
    expect(first.recovery.carried).toBe(0);
    const exceptionId = String(((await cashEventsOfKind(id, 'exception.detected'))[0]!.detail as { exceptionId: string }).exceptionId);
    const need = await needForKey(projectId, refundApprovalKey(id));
    expect(need?.state).toBe('OPEN');
    expect(need?.blockedAction).toBe('APPROVED_REFUND');
    expect(need?.expectedCostCents).toBe(75_000);

    // Asked once: a second pass neither re-asks nor refunds on its own.
    const second = await advanceJourney(projectId);
    expect(second.recovery.asked).toBe(0);
    expect(second.recovery.carried).toBe(0);
    expect((await cashEventsOfKind(id, RECOVERY_EVENT)).length).toBe(0);

    // A person approves; the next pass carries it out through the refund path and records who decided.
    expect((await closeNeed({ needId: need!.id, to: 'RESOLVED', resolution: 'Approved: refund the buyer in full.', actorUserId: userId })).ok).toBe(true);
    const third = await advanceJourney(projectId);
    expect(third.recovery.carried).toBe(1);
    const recovered = await cashEventsOfKind(id, RECOVERY_EVENT);
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.detail).toMatchObject({ remedy: 'APPROVED_REFUND', by: userId, amountCents: 75_000, agreementId: agreement.id });
    // One payment at risk, however many exceptions show it: one refund covers each of them.
    expect((recovered[0]!.detail as { exceptionIds: string[] }).exceptionIds).toContain(exceptionId);
    expect((await cashEventsOfKind(id, 'CASH_REFUND_AUTHORIZED')).length).toBe(1);

    // The rehearsal re-traced with the recovery decision in it.
    const traces = await cashEventsOfKind(id, 'rehearsal.traced');
    const last = traces[traces.length - 1]!.detail as { steps: { kind: string; detail: string }[] };
    expect(last.steps.some((st) => st.kind === 'RECOVERY' && /APPROVED_REFUND decided by/.test(st.detail))).toBe(true);

    // Done once: later passes do not refund again.
    const fourth = await advanceJourney(projectId);
    expect(fourth.recovery.carried).toBe(0);
    expect((await cashEventsOfKind(id, RECOVERY_EVENT)).length).toBe(1);
  });

  it('remembers a declined refund and does not ask again', async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The owner', actorRef: userId })).ok).toBe(true);
    await settled(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled after paying.', actorRef: userId })).ok).toBe(true);
    expect((await advanceJourney(projectId)).recovery.asked).toBe(1);
    const exceptionId = String(((await cashEventsOfKind(id, 'exception.detected'))[0]!.detail as { exceptionId: string }).exceptionId);
    const need = (await needForKey(projectId, refundApprovalKey(id)))!;
    expect((await closeNeed({ needId: need.id, to: 'WITHDRAWN', resolution: 'No refund: the work was already done.', actorUserId: userId })).ok).toBe(true);
    const after = await advanceJourney(projectId);
    expect(after.recovery.asked).toBe(0);
    expect(after.recovery.carried).toBe(0);
    expect((await cashEventsOfKind(id, RECOVERY_EVENT)).length).toBe(0);
  });
});

describe('agreementOfTransition (pure)', () => {
  it('reads the agreement from an agreement-scoped transition id and nothing from a ledger row', () => {
    expect(agreementOfTransition('failure:agr_1')).toBe('agr_1');
    expect(agreementOfTransition('delivery:agr_2:3')).toBe('agr_2');
    expect(agreementOfTransition('ledger:men_1')).toBeNull();
    expect(agreementOfTransition(null)).toBeNull();
  });
});

describe('commitmentProblem (pure)', () => {
  it('refuses a reading that contradicts its ledger', async () => {
    const id = await executing();
    await agree(id);
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(commitmentProblem(reading, { payments: 0, settlements: 0 })).toBeNull();
    expect(commitmentProblem(reading, { payments: 75_000, settlements: 75_000 })).toMatch(/does not show them settled/);
    const lying = { ...reading, stages: { ...reading.stages, FUNDS_SETTLED: { ...reading.stages.FUNDS_SETTLED, state: 'REACHED' as const } } };
    expect(commitmentProblem(lying, { payments: 0, settlements: 0 })).toMatch(/no settlement on the ledger/);
  });
});
