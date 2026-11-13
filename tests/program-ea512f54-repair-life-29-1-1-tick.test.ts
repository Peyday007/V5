/**
 * LIFE-29-1 repair, episode 1: production read "no opportunity has an
 * agreement: no transaction to read as commitments". A buyer's acceptance Brain
 * read (a provider's reply status) waited for a person to re-type terms the
 * sent offer already stated, so no agreement was recorded and the chain of
 * commitments never started. The journey tick now records the agreement from
 * the sent offer's own terms, or a need naming the term no row states.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, openNeedForKey, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { agreementsFor } from '../server/repos/cashJourney.ts';
import { listMoneyEntries } from '../server/repos/cashLedger.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture, fillCard } from '../server/services/cash/opportunities.ts';
import { applyProposal, proposeTerms } from '../server/services/cash/answers.ts';
import { advanceWithinAuthority } from '../server/services/cash/operate.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { COMMERCIAL_EFFECTS } from '../server/services/cash/effects.ts';
import { recordObservation } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { offerTerms } from '../server/services/cash/journey/acceptance.ts';
import { readCommitments } from '../server/services/cash/deliverables/commitments.ts';
import { commitmentProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { clearAdapters, registerAdapter, type EffectAdapter } from '../server/services/effects/adapter.ts';
import type { CashOpportunity } from '../server/domain/types.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `life291-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Take one legitimate opportunity to collected revenue.' })).ok).toBe(true);
  await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
  });
  // The messaging provider the contact goes out through.
  const adapter: EffectAdapter = {
    name: 'sandbox.contact_buyer',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: COMMERCIAL_EFFECTS.CONTACT_BUYER.namespace.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async () => ({ kind: 'CONFIRMED', receiptRef: `msg-${Math.random().toString(36).slice(2, 8)}` }),
  };
  registerAdapter(adapter);
});
afterEach(() => clearAdapters());

/** A qualified card Brain contacts through the provider, so the sent offer's digest is on the intent row. */
async function contacted(patch: Record<string, unknown> = {}): Promise<CashOpportunity> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'A published intake repair request', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  const filled = await fillCard({
    opportunityId: captured.value.id, actorRef: 'BRAIN',
    patch: { payer: 'The operations manager, who signs', reachableChannel: 'ops@intake-buyer.example — the address on the notice', buyingSignal: 'Wanted: intake repair. Budget $1,200.', signalObservedAt: '2026-09-15T09:00:00.000Z', peakFundingCents: 0 },
  });
  if (!filled.ok) throw new Error(filled.reason);
  const piece = (await getOpportunity(captured.value.id))!;
  await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
  await updateOpportunity(piece.id, { delivery_method: 'Delivered by the named operator.', fulfillment_owner: 'The named operator', ...patch } as never);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({ projectId, opportunityId: piece.id, field, kind: 'EVIDENCE', value: `A published answer to ${field}.`, claimId: `clm_${field}`, decidedBy: 'BRAIN' });
  }
  await advanceWithinAuthority(projectId);
  const sent = (await getOpportunity(piece.id))!;
  expect(sent.state).toBe('EXECUTING');
  return sent;
}

const observe = async (opportunityId: string, kind: 'BUYER_ACCEPTED' | 'BUYER_COUNTERED', source: 'PROVIDER' | 'PERSON', ref: string, amountCents: number | null = null) => {
  const seen = await recordObservation({ opportunityId, kind, source, evidenceRef: ref, amountCents, actorRef: source === 'PERSON' ? userId : 'BRAIN' });
  if (!seen.ok) throw new Error(seen.reason);
  return seen.value;
};
const pipeline = async (opportunityId: string) =>
  (await listMoneyEntries({ projectId, opportunityId, limit: 2000 })).filter((e) => e.kind === 'PIPELINE_AGREED');

describe('A01: an acceptance Brain read becomes exactly one agreement on the sent offer\'s terms', () => {
  it('records one agreement and one PIPELINE_AGREED entry on the next tick, and none on a second', async () => {
    const piece = await contacted();
    expect(piece.offerScope && piece.acceptanceCondition && piece.priceCents).toBeTruthy();
    const accepted = await observe(piece.id, 'BUYER_ACCEPTED', 'PROVIDER', 'instantly reply r-1 (interest status: won)');
    expect(await agreementsFor(piece.id)).toEqual([]);

    const first = await advanceJourney(projectId);
    const agreements = await agreementsFor(piece.id);
    expect(agreements).toHaveLength(1);
    expect(first.agreements.recorded).toEqual([agreements[0]!.id]);
    expect(agreements[0]).toMatchObject({
      observationId: accepted.id, amountCents: piece.priceCents, deliverable: piece.offerScope, acceptanceCondition: piece.acceptanceCondition,
      evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: expect.stringContaining(accepted.id),
    });
    expect(await pipeline(piece.id)).toHaveLength(1);

    const second = await advanceJourney(projectId);
    expect(second.agreements.recorded).toEqual([]);
    expect(await agreementsFor(piece.id)).toHaveLength(1);
    expect(await pipeline(piece.id)).toHaveLength(1);
  });

  it('agrees a counter-offer at the countered amount only', async () => {
    const piece = await contacted();
    const countered = await observe(piece.id, 'BUYER_COUNTERED', 'PROVIDER', 'instantly reply r-2 "can you do $900?"', 90_000);
    await advanceJourney(projectId);
    await advanceJourney(projectId);
    const agreements = await agreementsFor(piece.id);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({ observationId: countered.id, amountCents: 90_000, deliverable: piece.offerScope });
    expect((await pipeline(piece.id)).map((e) => e.amountCents)).toEqual([90_000]);
  });

  it('raises a need naming the term the offer does not settle, and records no agreement', async () => {
    const piece = await contacted();
    // The buyer "accepted" a figure the offer never stated: the offer does not state that agreement's amount.
    const accepted = await observe(piece.id, 'BUYER_ACCEPTED', 'PROVIDER', 'instantly reply r-3 "yes at $400"', 40_000);
    const report = await advanceJourney(projectId);
    expect(await agreementsFor(piece.id)).toEqual([]);
    expect(report.agreements.needs).toEqual([{ observationId: accepted.id, missing: [expect.stringContaining('the amount')] }]);
    const need = await openNeedForKey(projectId, `agreement-terms:${accepted.id}`);
    expect(need?.whyItMatters).toContain('the amount');
    await advanceJourney(projectId);
    expect(await agreementsFor(piece.id)).toEqual([]);
    expect(await pipeline(piece.id)).toEqual([]);
  });

  it('never agrees on a card edited since the offer went out', async () => {
    const piece = await contacted();
    await updateOpportunity(piece.id, { price_cents: (piece.priceCents ?? 0) + 50_000 } as never);
    const accepted = await observe(piece.id, 'BUYER_ACCEPTED', 'PROVIDER', 'instantly reply r-4 (won)');
    const report = await advanceJourney(projectId);
    expect(await agreementsFor(piece.id)).toEqual([]);
    expect(report.agreements.needs[0]).toMatchObject({ observationId: accepted.id, missing: [expect.stringContaining('card has changed')] });
  });

  it('an acceptance a person recorded by hand stays theirs to agree', async () => {
    const piece = await contacted();
    await observe(piece.id, 'BUYER_ACCEPTED', 'PERSON', 'buyer email "yes, go ahead"');
    const report = await advanceJourney(projectId);
    expect(report.agreements).toEqual({ recorded: [], needs: [], refused: [] });
    expect(await agreementsFor(piece.id)).toEqual([]);
  });

  it('the resulting deal reads as commitments that pass the probe\'s check against its ledger', async () => {
    const piece = await contacted();
    await observe(piece.id, 'BUYER_ACCEPTED', 'PROVIDER', 'instantly reply r-5 (won)');
    await advanceJourney(projectId);
    const reading = await readCommitments({ projectId, opportunityId: piece.id, currency: 'USD' });
    expect(commitmentProblem(reading, { payments: 0, settlements: 0 })).toBeNull();
    expect(reading.stages.CONTRACT_SIGNED.state).toBe('REACHED');
    expect(reading.transitions.length).toBeGreaterThan(0);
    for (const t of reading.transitions) {
      expect(t.duty.action).toEqual(expect.any(String));
      expect('deadline' in t).toBe(true);
      expect(t.outcome).toBeTruthy();
      expect(Array.isArray(t.evidence)).toBe(true);
    }
  });
});

describe('offerTerms (pure)', () => {
  const offer = { offerScope: 'Repair the form', acceptanceCondition: 'A test enquiry arrives', priceCents: 120_000, currency: 'USD' };
  it('agrees an acceptance at the offer price, and refuses an acceptance of a different amount', () => {
    expect(offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, offer, currency: 'USD' })).toMatchObject({ ok: true, amountCents: 120_000 });
    expect(offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: 120_000, currency: 'USD' }, offer, currency: 'USD' })).toMatchObject({ ok: true, amountCents: 120_000 });
    const off = offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: 100_000, currency: 'USD' }, offer, currency: 'USD' });
    expect(off.ok).toBe(false);
  });
  it('never invents a missing term', () => {
    const none = offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, offer: { ...offer, priceCents: null, offerScope: null }, currency: 'USD' });
    expect(none).toMatchObject({ ok: false });
    if (!none.ok) expect(none.missing.join(' ')).toMatch(/deliverable.*amount/);
    const noCondition = offerTerms({ observation: { kind: 'BUYER_ACCEPTED', amountCents: null, currency: null }, offer: { ...offer, acceptanceCondition: null }, currency: 'USD' });
    expect(noCondition).toEqual({ ok: false, missing: [expect.stringContaining('acceptance condition')] });
    const counterWithout = offerTerms({ observation: { kind: 'BUYER_COUNTERED', amountCents: null, currency: null }, offer, currency: 'USD' });
    expect(counterWithout).toEqual({ ok: false, missing: [expect.stringContaining('counter-offer stated none')] });
  });
});
