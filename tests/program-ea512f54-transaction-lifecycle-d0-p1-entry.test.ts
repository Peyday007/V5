/**
 * LIFE-29-3, repair F2: the rehearsal and an approved remedy have production entry points.
 *
 * The journey tick traces a real, sourced case with a failure path through
 * `rehearseStoredCase` (and again only when the case changed), so r01.life-29-3
 * can pass on rows production writes. A refund that would remedy an exception is
 * asked for as a need; a project owner resolving it is the approval, and the need
 * continuation carries the refund out through `carryOutApprovedRefund`. A
 * withdrawal, or a resolver who may not approve refunds, carries nothing out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, readObligations } from '../server/services/cash/journey/fulfillment.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import { runNeedContinuations } from '../server/services/cash/operate.ts';
import {
  REMEDY_APPROVAL_PREFIX,
  REMEDY_CARRIED_OUT,
  REMEDY_REFUSED,
  parseRemedyApprovalKey,
  remedyApprovalKey,
} from '../server/services/cash/deliverables/exceptions.ts';
import '../server/services/cash/deliverables/lifecycleProbes.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';
import type { CashNeed } from '../server/domain/types.ts';

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
    mechanism: mechanism as 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: [],
    source,
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
const SOURCE = 'Inbound email from the buyer, 2026-09-14, asking for a quote';

async function paidThenCancelled(source: string | null = SOURCE): Promise<{ id: string; agreement: CashAgreement }> {
  const id = await executing('A paid intake repair', 75_000, 'EXPLICIT_PAID_REQUEST', source);
  const agreement = await agree(id);
  expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The owner', actorRef: userId })).ok).toBe(true);
  await settled(id);
  expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
  return { id, agreement };
}

async function approvalNeed(opportunityId: string): Promise<CashNeed | undefined> {
  return (await listNeeds({ projectId })).find((n) => n.opportunityId === opportunityId && n.requestKey?.startsWith(REMEDY_APPROVAL_PREFIX));
}

describe('the approval key', () => {
  it('round-trips an exception id that itself contains colons, and refuses anything else', () => {
    const key = remedyApprovalKey('APPROVED_REFUND', 'agr_1', 'cancellation:agreement:agr_1');
    expect(parseRemedyApprovalKey(key)).toEqual({ remedy: 'APPROVED_REFUND', agreementId: 'agr_1', exceptionId: 'cancellation:agreement:agr_1' });
    expect(parseRemedyApprovalKey('remedy-approval:NOT_A_REMEDY:a:b')).toBeNull();
    expect(parseRemedyApprovalKey('capability:x')).toBeNull();
    expect(parseRemedyApprovalKey(null)).toBeNull();
  });
});

describe('the journey tick rehearses a sourced case and carries out an approved remedy', () => {
  it('traces a sourced case with a failure path on the tick, so r01.life-29-3 passes on production rows, and only again when it changed', async () => {
    const { id } = await paidThenCancelled();
    expect((await probe('r01.life-29-3')).ok).toBe(false);
    const first = await advanceJourney(projectId);
    expect(first.exceptions.rehearsed).toBe(1);
    const traced = await cashEventsOfKind(id, 'rehearsal.traced');
    expect(traced).toHaveLength(1);
    const detail = traced[0]!.detail as { sourceRef: string; valid: boolean; exceptions: { kind: string }[]; steps: { kind: string }[] };
    expect(detail.sourceRef).toBe(SOURCE);
    expect(detail.valid).toBe(true);
    expect(detail.exceptions.map((e) => e.kind)).toContain('CANCELLATION');
    expect(detail.steps.some((s) => s.kind === 'EXCEPTION')).toBe(true);
    expect(traced[0]!.actorRef).toBe('BRAIN');
    const verdict = await probe('r01.life-29-3');
    expect(verdict.detail).toMatch(/sourced rehearsal/);
    expect(verdict.ok).toBe(true);
    const again = await advanceJourney(projectId);
    expect(again.exceptions.rehearsed).toBe(0);
    expect(await cashEventsOfKind(id, 'rehearsal.traced')).toHaveLength(1);
  });

  it('does not trace a case that names no source', async () => {
    const { id } = await paidThenCancelled(null);
    const report = await advanceJourney(projectId);
    expect(report.exceptions.recorded).toBeGreaterThan(0);
    expect(report.exceptions.rehearsed).toBe(0);
    expect(await cashEventsOfKind(id, 'rehearsal.traced')).toHaveLength(0);
    expect(await cashEventsOfKind(id, 'rehearsal.refused')).toHaveLength(0);
  });

  it('asks for a refund approval once; resolving it carries the refund out once, and the next trace records the recovery', async () => {
    const { id, agreement } = await paidThenCancelled();
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    const needs = (await listNeeds({ projectId })).filter((n) => n.opportunityId === id && n.requestKey?.startsWith(REMEDY_APPROVAL_PREFIX));
    expect(needs).toHaveLength(1);
    const need = needs[0]!;
    const key = parseRemedyApprovalKey(need.requestKey)!;
    expect(key.remedy).toBe('APPROVED_REFUND');
    expect(key.agreementId).toBe(agreement.id);
    expect(need.expectedCostCents).toBe(75_000);

    // Nothing is refunded before a person approves.
    expect(await cashEventsOfKind(id, REMEDY_CARRIED_OUT)).toHaveLength(0);
    expect((await readObligations(id))[0]!.refunds).toHaveLength(0);

    expect((await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Approved: refund the buyer in full.', actorUserId: userId })).ok).toBe(true);
    const ran = await runNeedContinuations(projectId);
    expect(ran.find((c) => c.needId === need.id)).toMatchObject({ resumed: true, retry: false });
    const carried = await cashEventsOfKind(id, REMEDY_CARRIED_OUT);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.detail).toMatchObject({ needId: need.id, exceptionId: key.exceptionId, approvedBy: userId, amountCents: 75_000 });
    const refunds = (await readObligations(id))[0]!.refunds;
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountCents).toBe(75_000);

    // The continuation claimed the need: a second pass carries nothing out again.
    await runNeedContinuations(projectId);
    expect(await cashEventsOfKind(id, REMEDY_CARRIED_OUT)).toHaveLength(1);
    expect((await readObligations(id))[0]!.refunds).toHaveLength(1);

    // The case changed (a remedy was carried out), so the tick traces it again, with the recovery.
    await advanceJourney(projectId);
    const traces = await cashEventsOfKind(id, 'rehearsal.traced');
    const last = traces[traces.length - 1]!.detail as { steps: { kind: string; detail: string }[]; recovered: { remedy: string }[] };
    expect(last.recovered.map((r) => r.remedy)).toContain('APPROVED_REFUND');
    expect(last.steps.some((s) => s.kind === 'RECOVERY' && s.detail.includes('APPROVED_REFUND'))).toBe(true);
  });

  it('carries nothing out when the approval is withdrawn', async () => {
    const { id } = await paidThenCancelled();
    await advanceJourney(projectId);
    const need = (await approvalNeed(id))!;
    expect((await closeNeed({ needId: need.id, to: 'WITHDRAWN', resolution: 'Declined: we will redo the work instead.', actorUserId: userId })).ok).toBe(true);
    const ran = await runNeedContinuations(projectId);
    expect(ran.find((c) => c.needId === need.id)).toMatchObject({ resumed: false, retry: false });
    expect(await cashEventsOfKind(id, REMEDY_CARRIED_OUT)).toHaveLength(0);
    expect(await cashEventsOfKind(id, REMEDY_REFUSED)).toHaveLength(1);
    expect((await readObligations(id))[0]!.refunds).toHaveLength(0);
  });

  it('carries nothing out when the person who resolved it may not approve a refund', async () => {
    const { id } = await paidThenCancelled();
    await advanceJourney(projectId);
    const need = (await approvalNeed(id))!;
    const stranger = (await createUser({ email: `member-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Member', password: 'correct horse battery staple' })).id;
    expect((await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Approved.', actorUserId: stranger })).ok).toBe(true);
    const ran = await runNeedContinuations(projectId);
    expect(ran.find((c) => c.needId === need.id)).toMatchObject({ resumed: false, retry: false });
    const refused = await cashEventsOfKind(id, REMEDY_REFUSED);
    expect(refused).toHaveLength(1);
    expect(String((refused[0]!.detail as { note: string }).note)).toMatch(/may not approve a refund/);
    expect((await readObligations(id))[0]!.refunds).toHaveLength(0);
  });
});
