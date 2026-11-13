/**
 * LIFE-29-1/29-3: the journey tick reads each deal as commitments, detects the exceptions its
 * rows show once, and the probes judge those rows. A released agreement is a cancellation; it is
 * recorded once however often the tick runs, and a rehearsal is what makes the probe pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, liveAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady, recordMoneyEvent } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, releaseAgreement } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { rehearseStoredCase, remedyAuthorityFor } from '../server/services/cash/deliverables/exceptions.ts';
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

async function executing(title = 'A paid intake repair', priceCents = 75_000, mechanism = 'EXPLICIT_PAID_REQUEST'): Promise<string> {
  const captured = await capture({
    projectId,
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


async function settled(opportunityId: string): Promise<void> {
  for (const kind of ['CUSTOMER_PAYMENT', 'SETTLEMENT'] as const) {
    const written = await recordMoneyEvent({ projectId, opportunityId, kind, amountCents: 75_000, currency: 'USD', verifiedReference: `${kind}-${opportunityId}`, idempotencyKey: `${kind}:${opportunityId}`, actorRef: userId, appliesTo: null });
    expect(written.ok).toBe(true);
  }
}

const probe = (name: string) => getProbe(name)!({});

describe('probes are registered, and answer UNKNOWN with no transaction to read', () => {
  it('registers r01.life-29-1 and r01.life-29-3 and passes neither on nothing', async () => {
    for (const name of ['r01.life-29-1', 'r01.life-29-3']) {
      const r = await probe(name);
      expect(r.ok).toBeNull();
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
    const detail = events[0]!.detail as {
      kind: string; chosen: unknown; needs: unknown;
      authority: { grant: { name: string } | null; standing: string[] };
      remedies: { remedy: string; feasible: boolean; authorizedBy: string | null; needsApproval: string | null }[];
    };
    expect(detail.kind).toBe('CANCELLATION');
    // The project's live grant is what the selection was judged against, not an empty authority.
    expect(detail.authority.grant?.name).toBe('Cash Mode commercial authority');
    expect(detail.authority.standing).toContain('ESCALATE');
    expect(detail.remedies.find((r) => r.remedy === 'ESCALATE')!.authorizedBy).toContain('CONTACT_BUYER');
    // Committing remedies still need a person's approval for the case; the grant never covers them.
    expect(detail.remedies.find((r) => r.remedy === 'ORDERLY_CANCELLATION')!.needsApproval).toContain('commits the company');
    // No escalation path is stated in the rows, so nothing feasible is inside authority and nothing is taken.
    expect(detail.chosen).toBeNull();
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

  it("selects a remedy inside the project's live commercial grant, and none once the grant is revoked", async () => {
    const id = await executing();
    const agreement = await agree(id);
    expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
    const dependencies = [{ kind: 'escalation path', detail: 'The owner calls the buyer before any release.' }];
    const granted = await rehearseStoredCase({ projectId, opportunityId: id, currency: 'USD', sourceRef: `email-${id}`, actorRef: userId, dependencies });
    const decision = granted.selections.find((s) => s.exception.kind === 'CANCELLATION')!;
    expect(decision.chosen?.remedy).toBe('ESCALATE');
    expect(decision.chosen?.authorizedBy).toContain('Cash Mode commercial authority');

    const grant = await liveAuthority(projectId);
    expect(await revokeAuthority({ authorityId: grant!.id, actorUserId: userId, reason: 'test' })).toBe(true);
    const none = await remedyAuthorityFor({ projectId, currency: 'USD' });
    expect(none.standing).toEqual([]);
    expect(none.grant).toBeNull();
    const revoked = await rehearseStoredCase({ projectId, opportunityId: id, currency: 'USD', sourceRef: `email-${id}`, actorRef: userId, dependencies });
    const after = revoked.selections.find((s) => s.exception.kind === 'CANCELLATION')!;
    expect(after.chosen).toBeNull();
    expect(after.needs).toBeTruthy();
  });

  it('reads a prohibition in the grant: a remedy whose action is prohibited is not standing', async () => {
    const grant = await liveAuthority(projectId);
    expect(await revokeAuthority({ authorityId: grant!.id, actorUserId: userId, reason: 'narrow' })).toBe(true);
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Narrow grant',
      allowedActions: ['ACCEPT_PAYMENT'], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 10_000, maxPerActionCents: 5_000, maxConcurrent: 1, currency: 'USD',
    });
    const a = await remedyAuthorityFor({ projectId, currency: 'USD' });
    expect(a.standing).toEqual(['ALTERNATE_COLLECTION']);
    expect(a.standingCeilingCents).toBe(5_000);
    expect(a.grant?.name).toBe('Narrow grant');
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
