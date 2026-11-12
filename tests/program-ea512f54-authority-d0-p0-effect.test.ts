/**
 * F-PERFORMED-RECORDED-BEFORE-EFFECT (AUTH-20-3 / AUTH-34).
 *
 * The authority ledger used to write disposition PERFORMED the moment authority
 * was granted, before the effect was attempted — so a send the provider never
 * confirmed, one whose outcome is unknown, or a replay of an earlier attempt
 * all read as "Brain did this". A decision is now AUTHORIZED, and what Brain
 * actually did is an AUTHORITY_EFFECT receipt written from the effect's own
 * record, naming the decision that allowed it. Driven through the real action
 * paths: the tick (`advanceWithinAuthority`) and a person's press
 * (`performCommercialAction`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  AUTHORITY_EFFECT_KIND,
  COMMERCIAL_ACTIONS,
  checkCommercialAuthority,
  decideAction,
  recordEffectReceipt,
} from '../server/services/cash/authority.ts';
import { graduatedAuthorityEvidence, policyToActionEvidence, policyToActionRule } from '../server/services/cash/authorityEvidence.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { effectDispositionOf, performCommercialAction } from '../server/services/cash/perform.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKindInProject, recordCashEvent } from '../server/repos/cashMode.ts';
import { CONTACT_BUYER_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type EffectAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `p0-effect-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

async function granted(): Promise<void> {
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
  });
}

/** A card complete enough that the tick marks it READY and may reach the buyer. */
async function readyToTest(): Promise<CashOpportunity> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'A published intake repair request', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id,
    actorRef: 'BRAIN',
    patch: {
      payer: 'The operations manager, who signs',
      reachableChannel: 'ops@intake-repair.example — the address on the notice',
      buyingSignal: 'Wanted: intake repair. Budget $1,200.',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const piece = (await getOpportunity(captured.value.id))!;
  await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
  await updateOpportunity(piece.id, {
    delivery_method: 'Delivered by the named operator, as the card describes.',
    fulfillment_owner: 'The named operator, with the owner reviewing',
  } as never);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: piece.id, field, kind: 'EVIDENCE', value: `A published answer to ${field}.`, claimId: `clm_${field}`, decidedBy: 'BRAIN' });
  }
  return (await getOpportunity(piece.id))!;
}

function adapter(send: EffectAdapter['send']): EffectAdapter {
  return {
    name: 'test.contact',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: CONTACT_BUYER_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send,
  };
}

type Row = { id: string } & Record<string, unknown>;
const rowsOf = async (kind: string): Promise<Row[]> =>
  (await cashEventsOfKindInProject(projectId, kind)).map((e) => ({ ...(e.detail as Record<string, unknown>), id: e.id }));
const decisions = () => rowsOf(AUTHORITY_DECISION_KIND);
const effects = () => rowsOf(AUTHORITY_EFFECT_KIND);

describe('an authorization is never recorded as an effect performed', () => {
  it('a granted decision says AUTHORIZED, on every caller of the shared check', async () => {
    await granted();
    const checked = await checkCommercialAuthority({ projectId, action: 'CONTACT_BUYER', principal: userId });
    expect(checked.ok).toBe(true);
    expect(checked.decisionId).toEqual(expect.any(String));
    const decided = await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API', principal: userId });
    expect(decided.ok).toBe(true);
    expect(decided.ledger.disposition).toBe('AUTHORIZED');
    const rows = await decisions();
    expect(rows.map((r) => r.disposition)).toEqual(['AUTHORIZED', 'AUTHORIZED']);
    expect(rows.some((r) => r.disposition === 'PERFORMED')).toBe(false);
    expect(await effects()).toEqual([]);
    expect(policyToActionRule()).toBeNull();
  });

  it('a press that is authorized but stops before anything is sent records the authorization and no effect', async () => {
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId); // marks READY; no adapter, so nobody is contacted
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    const result = await performCommercialAction({ opportunityId: piece.id, action: 'CONTACT_BUYER', actorRef: userId, expectedOccurrence: '1' });
    expect(result.ok).toBe(false);
    const rows = await decisions();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.disposition === 'AUTHORIZED')).toBe(true);
    expect(await effects()).toEqual([]);
  });
});

describe('what Brain did is the effect record\'s to say', () => {
  it('a confirmed send is PERFORMED, with the provider\'s reference, beside the decision that allowed it', async () => {
    registerAdapter(adapter(async (request): Promise<SendOutcome> => ({ kind: 'CONFIRMED', receiptRef: `rcpt_${request.businessId}` })));
    await granted();
    const piece = await readyToTest();
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('EXECUTING');
    const [effect, ...more] = await effects();
    expect(more).toEqual([]);
    expect(effect).toMatchObject({ action: 'CONTACT_BUYER', disposition: 'PERFORMED', receiptRef: `rcpt_cash:${piece.id}:CONTACT_BUYER:1` });
    const decision = (await decisions()).find((d) => d.id === effect!.decisionId);
    expect(decision).toMatchObject({ action: 'CONTACT_BUYER', disposition: 'AUTHORIZED', ok: true });
    const evidence = await policyToActionEvidence();
    expect(evidence.ok, evidence.detail).toBe(true);
    expect(evidence.detail).toMatch(/1 effect receipt\(s\) \(1 performed\)/);
  });

  it('an unknown outcome is UNKNOWN, and nothing on the ledger says it was performed', async () => {
    registerAdapter(adapter(async (): Promise<SendOutcome> => ({ kind: 'UNCERTAIN', reason: 'the connection closed before a response' })));
    await granted();
    const piece = await readyToTest();
    // One pass marks the piece READY and attempts the contact (an adapter is registered).
    await advanceWithinAuthority(projectId);
    expect((await getOpportunity(piece.id))!.state).toBe('READY');
    const all = await effects();
    expect(all.map((e) => e.disposition)).toEqual(['UNKNOWN']);
    expect((await decisions()).some((d) => d.disposition === 'PERFORMED')).toBe(false);
    expect(all.some((e) => e.disposition === 'PERFORMED')).toBe(false);
  });

  it('a refused send is FAILED, and a replay did nothing new', () => {
    expect(effectDispositionOf({ status: 'CONFIRMED' })).toBe('PERFORMED');
    expect(effectDispositionOf({ status: 'RECONCILED' })).toBe('PERFORMED');
    expect(effectDispositionOf({ status: 'REPLAYED' })).toBe('REPLAYED');
    expect(effectDispositionOf({ status: 'FAILED' })).toBe('FAILED');
    expect(effectDispositionOf({ status: 'UNCERTAIN' })).toBe('UNKNOWN');
  });
});

describe('the evidence fails on an effect the ledger did not authorize', () => {
  it('a performed effect naming no decision', async () => {
    await granted();
    await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API', principal: userId });
    await recordEffectReceipt({ projectId, action: 'QUOTE_AND_INVOICE', decisionId: null, disposition: 'PERFORMED', actorRef: 'BRAIN' });
    expect((await policyToActionEvidence()).detail).toMatch(/performed with no authorization decision/);
    expect((await graduatedAuthorityEvidence()).ok).toBe(false);
  });

  it('a performed effect naming a refusal', async () => {
    const refused = await decideAction({ projectId, action: 'SEND_OUTREACH', path: 'BROWSER', principal: userId });
    expect(refused.ok).toBe(false);
    expect(refused.decisionId).toEqual(expect.any(String));
    await recordEffectReceipt({ projectId, action: 'SEND_OUTREACH', decisionId: refused.decisionId, disposition: 'PERFORMED', actorRef: 'BRAIN' });
    expect((await policyToActionEvidence()).detail).toMatch(/did not authorize it/);
  });

  it('a receipt that does not say what happened', async () => {
    await granted();
    await decideAction({ projectId, action: 'QUOTE_AND_INVOICE', path: 'API', principal: userId });
    await recordCashEvent({ projectId, kind: AUTHORITY_EFFECT_KIND, actorRef: 'BRAIN', summary: 'forged', detail: { action: 'QUOTE_AND_INVOICE', decisionId: null, disposition: 'DONE' } });
    expect((await policyToActionEvidence()).detail).toMatch(/does not say what happened/);
  });
});
