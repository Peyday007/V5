/**
 * INT-38-AUTHORITY (S-0517): all actions obey authority (§34) — the lifecycle
 * remedies of LIFE-29-3 joined to the authority path of AUTH-34.
 *
 * Every remedy Brain carries out or refuses names the authority it acted
 * under: the `checkCommercialAuthority` decision for a remedy that is a
 * commercial action (grant id, policy version, consequence class, cause,
 * disposition), or the per-case approval request a person resolved for a
 * remedy that is none — which then says so explicitly. The stop and the grant
 * are re-read at the moment of effect, so a stop, a revocation or an expiry
 * between the approval and the effect refuses the remedy, performs nothing and
 * records what stays owed. Everything here runs through the real repositories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority, revokeAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind, cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  COMMERCIAL_ACTIONS,
  setEmergencyStop,
} from '../server/services/cash/authority.ts';
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
  remedyAuthorityAtEffect,
  type RemedyAuthorityRecord,
} from '../server/services/cash/deliverables/exceptions.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';
import type { CashNeed } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let grantId = '';
const GRANT_EXPIRES = '2099-01-01T00:00:00.000Z';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `int38-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  const grant = await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    expiresAt: GRANT_EXPIRES,
  });
  grantId = grant.id;
});

afterEach(() => clearAdapters());

const SOURCE = 'Inbound email from the buyer, 2026-09-14, asking for a quote';

async function executing(): Promise<string> {
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [], source: SOURCE,
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
    firstAction: {
      action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.',
      reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

/** A real paid deal the buyer then cancelled: the journey tick asks for a refund approval. */
async function paidThenCancelled(): Promise<{ id: string; agreement: CashAgreement; need: CashNeed }> {
  const id = await executing();
  const agreed = await recordAgreement({
    opportunityId: id, amountCents: 75_000, currency: 'USD', deliverable: 'Repair the intake form',
    acceptanceCondition: 'Form submits and a test enquiry arrives', evidenceKind: 'WRITTEN_ACCEPTANCE',
    evidenceRef: `email-${id}`, actorRef: userId,
  });
  if (!agreed.ok) throw new Error(agreed.reason);
  const agreement = agreed.value;
  expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The owner', actorRef: userId })).ok).toBe(true);
  for (const kind of ['CUSTOMER_PAYMENT', 'SETTLEMENT'] as const) {
    const written = await recordMoneyEvent({ projectId, opportunityId: id, kind, amountCents: 75_000, currency: 'USD', verifiedReference: `${kind}-${id}`, idempotencyKey: `${kind}:${id}`, actorRef: userId, appliesTo: null });
    expect(written.ok).toBe(true);
  }
  expect((await releaseAgreement({ agreementId: agreement.id, reason: 'The buyer cancelled.', actorRef: userId })).ok).toBe(true);
  await advanceJourney(projectId);
  const need = (await listNeeds({ projectId })).find((n) => n.opportunityId === id && n.requestKey?.startsWith(REMEDY_APPROVAL_PREFIX));
  if (!need) throw new Error('the journey tick raised no refund approval');
  return { id, agreement, need };
}

const authorityOf = (event: { detail: unknown }): RemedyAuthorityRecord => (event.detail as { authority: RemedyAuthorityRecord }).authority;

describe('a remedy carried out names the authority it was performed under', () => {
  it('a refund names the per-case approval request a person resolved, and that it needed no commercial action', async () => {
    const { id, need } = await paidThenCancelled();
    expect((await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Approved: refund the buyer in full.', actorUserId: userId })).ok).toBe(true);
    const ran = await runNeedContinuations(projectId);
    expect(ran.find((c) => c.needId === need.id)).toMatchObject({ resumed: true });

    const carried = await cashEventsOfKind(id, REMEDY_CARRIED_OUT);
    expect(carried).toHaveLength(1);
    const authority = authorityOf(carried[0]!);
    expect(authority).toMatchObject({
      basis: 'OWNER_APPROVAL',
      commercialAction: null,
      commercialActionNeeded: false,
      approvalRequestId: need.id,
      approvedBy: userId,
      cause: 'OWNER_APPROVED',
      disposition: 'AUTHORIZED',
      emergencyStop: false,
      allowed: true,
      obligations: null,
    });
    expect(authority.reason).toMatch(/needed none/);
    expect((await readObligations(id))[0]!.refunds).toHaveLength(1);
  });

  it('a commercial remedy names the checkCommercialAuthority decision: grant id, policy version, consequence class, cause and disposition', async () => {
    const authority = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'RESCHEDULE', agreementId: 'agr_x', exceptionId: 'missed_date:x',
      amountCents: null, approvalRequestId: null, approvedBy: null,
    });
    expect(authority).toMatchObject({
      basis: 'GRANT',
      commercialAction: 'CONTACT_BUYER',
      commercialActionNeeded: true,
      grantId,
      consequenceClass: 'EXTERNALLY_CONSEQUENTIAL',
      disposition: 'AUTHORIZED',
      emergencyStop: false,
      allowed: true,
    });
    expect(authority.policyVersion).toEqual(expect.any(Number));
    expect(authority.cause).toBeTruthy();
    // The decision is the ledger row the one authority path wrote.
    const rows = await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);
    expect(rows.map((r) => r.id)).toContain(authority.decisionId);
    const row = rows.find((r) => r.id === authority.decisionId)!;
    expect(row.detail).toMatchObject({ action: 'CONTACT_BUYER', cause: authority.cause, disposition: 'AUTHORIZED', policyVersion: authority.policyVersion });
  });
});

describe('a stop, revocation or expiry after approval refuses the remedy at the moment of effect', () => {
  it('an approved refund reached while the emergency stop is on is refused, refunds nothing, and records what stays owed', async () => {
    const { id, agreement, need } = await paidThenCancelled();
    expect((await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Approved: refund the buyer in full.', actorUserId: userId })).ok).toBe(true);
    // The owner stops the project between the approval and the effect.
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'pause everything' });
    const ran = await runNeedContinuations(projectId);
    expect(ran.find((c) => c.needId === need.id)).toMatchObject({ resumed: false, retry: false });

    expect(await cashEventsOfKind(id, REMEDY_CARRIED_OUT)).toHaveLength(0);
    const refused = await cashEventsOfKind(id, REMEDY_REFUSED);
    expect(refused).toHaveLength(1);
    const authority = authorityOf(refused[0]!);
    expect(authority).toMatchObject({
      basis: 'OWNER_APPROVAL',
      commercialActionNeeded: false,
      approvalRequestId: need.id,
      cause: 'EMERGENCY_STOP',
      disposition: 'REFUSED',
      emergencyStop: true,
      allowed: false,
    });
    expect(authority.obligations).toMatchObject({
      remedy: { remedy: 'APPROVED_REFUND', agreementId: agreement.id, amountCents: 75_000 },
      heldCents: expect.any(Number),
      heldCommitmentIds: expect.any(Array),
    });
    expect((await readObligations(id))[0]!.refunds).toHaveLength(0);
  });

  it('a commercial remedy reached under the stop is refused through the authority path and leaves its obligations owed', async () => {
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'pause everything' });
    const authority = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'ESCALATE', agreementId: 'agr_y', exceptionId: 'dispute:y',
      amountCents: null, approvalRequestId: null, approvedBy: null,
    });
    expect(authority).toMatchObject({ basis: 'GRANT', commercialAction: 'CONTACT_BUYER', cause: 'EMERGENCY_STOP', disposition: 'REFUSED', emergencyStop: true, allowed: false, grantId });
    expect(authority.obligations?.remedy).toMatchObject({ remedy: 'ESCALATE', agreementId: 'agr_y' });
  });

  it('a commercial remedy reached after its grant was revoked is refused with the REVOKED cause and its obligations', async () => {
    await revokeAuthority({ authorityId: grantId, actorUserId: userId, reason: 'no more outreach' });
    const authority = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'RESCHEDULE', agreementId: 'agr_z', exceptionId: 'missed_date:z',
      amountCents: null, approvalRequestId: null, approvedBy: null,
    });
    expect(authority).toMatchObject({ basis: 'GRANT', cause: 'REVOKED', disposition: 'REFUSED', allowed: false, emergencyStop: false });
    expect(authority.obligations?.remedy).toMatchObject({ remedy: 'RESCHEDULE', agreementId: 'agr_z' });
  });

  it('a commercial remedy reached after its grant expired is refused, with its obligations', async () => {
    const authority = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'SUBSTITUTE_PROVIDER', agreementId: 'agr_e', exceptionId: 'missed_date:e',
      amountCents: 10_000, approvalRequestId: null, approvedBy: null, at: '2100-01-01T00:00:00.000Z',
    });
    expect(authority).toMatchObject({ basis: 'GRANT', commercialAction: 'ENGAGE_CONTRACTOR', disposition: 'REFUSED', allowed: false, grantId: null });
    expect(authority.obligations?.remedy).toMatchObject({ remedy: 'SUBSTITUTE_PROVIDER', amountCents: 10_000 });
  });

  it('an orderly cancellation records that it needed no commercial action, and is refused under the stop', async () => {
    const approved = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'ORDERLY_CANCELLATION', agreementId: 'agr_c', exceptionId: 'cancellation:c',
      amountCents: null, approvalRequestId: 'need_c', approvedBy: userId,
    });
    expect(approved).toMatchObject({ commercialAction: null, commercialActionNeeded: false, basis: 'OWNER_APPROVAL', approvalRequestId: 'need_c', allowed: true });
    await setEmergencyStop({ projectId, on: true, actorUserId: userId, reason: 'pause everything' });
    const stopped = await remedyAuthorityAtEffect({
      projectId, opportunityId: null, remedy: 'ORDERLY_CANCELLATION', agreementId: 'agr_c', exceptionId: 'cancellation:c',
      amountCents: null, approvalRequestId: 'need_c', approvedBy: userId,
    });
    expect(stopped).toMatchObject({ commercialActionNeeded: false, cause: 'EMERGENCY_STOP', allowed: false });
    expect(stopped.obligations?.remedy.remedy).toBe('ORDERLY_CANCELLATION');
  });
});

describe('every refusal carries an authority record, and no second authority path exists', () => {
  it('a withdrawn approval is refused with an authority record that says nothing was approved', async () => {
    const { id, need } = await paidThenCancelled();
    expect((await closeNeed({ needId: need.id, to: 'WITHDRAWN', resolution: 'Declined.', actorUserId: userId })).ok).toBe(true);
    await runNeedContinuations(projectId);
    const refused = await cashEventsOfKind(id, REMEDY_REFUSED);
    expect(refused).toHaveLength(1);
    expect(authorityOf(refused[0]!)).toMatchObject({ basis: 'NOT_APPROVED', approvalRequestId: need.id, commercialActionNeeded: false, allowed: false });
  });

  it('exceptions.ts reads authority only through the existing path: no new table, scheduler or check', () => {
    const source = readFileSync(new URL('../server/services/cash/deliverables/exceptions.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/CREATE TABLE|setInterval|setTimeout|getDb\(/);
    expect(source).toMatch(/checkCommercialAuthority\(/);
    expect(source).toMatch(/emergencyStopOn\(/);
  });
});
