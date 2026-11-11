/**
 * LIFE-29-3: a buyer's scope change and a disputed delivery are detected from rows production
 * writes — the buyer's own recorded answer in `cash_observations` — not only from a signal a
 * caller hands in. The journey tick records them, and the production probe checks for them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement, recordObservation } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { detectFromRows, exceptionsFromObservations } from '../server/services/cash/deliverables/exceptions.ts';
import type { CommitmentReading, CommitmentTransition } from '../server/services/cash/deliverables/commitments.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement, CashObservation } from '../server/domain/cashJourney.ts';

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


const later = (ms: number) => new Date(Date.now() + ms).toISOString();

async function answer(opportunityId: string, kind: 'BUYER_COUNTERED' | 'BUYER_DECLINED', amountCents: number | null, key: string, observedAt = later(5_000)): Promise<void> {
  const done = await recordObservation({ opportunityId, kind, source: 'PROVIDER', evidenceRef: `reply-${key}`, amountCents, note: 'buyer reply', observedAt, actorRef: userId, requestKey: key });
  if (!done.ok) throw new Error(done.reason);
}

describe('a scope change the buyer recorded is detected and recorded in production', () => {
  it('reads a counter-offer after agreement as a scope change, priced against the agreed amount', async () => {
    const id = await executing();
    await agree(id, 75_000);
    await answer(id, 'BUYER_COUNTERED', 60_000, `counter-${id}`);
    const { detected } = await detectFromRows({ projectId, opportunityId: id, currency: 'USD' });
    const scope = detected.find((e) => e.kind === 'SCOPE_CHANGE');
    expect(scope).toMatchObject({ source: 'ROWS', valueDeltaCents: -15_000 });

    // Before the tick, the probe names the scope change the rows show but nobody recorded.
    const before = await getProbe('r01.life-29-3')!({});
    expect(before.ok).toBe(false);
    expect(before.detail).toContain(scope!.id);

    await advanceJourney(projectId);
    await advanceJourney(projectId);
    const recorded = (await cashEventsOfKind(id, 'exception.detected')).filter((e) => (e.detail as { kind?: string }).kind === 'SCOPE_CHANGE');
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.detail as { remedies: { remedy: string }[] }).remedies.map((r) => r.remedy)).toContain('RENEGOTIATE_SCOPE');
    const after = await getProbe('r01.life-29-3')!({});
    expect(after.detail).not.toContain('not on record');
  });

  it('reads an answer before any agreement as negotiation, not an exception', async () => {
    const id = await executing();
    await answer(id, 'BUYER_COUNTERED', 60_000, `early-${id}`, '2026-01-01T00:00:00.000Z');
    await agree(id, 75_000);
    const { detected } = await detectFromRows({ projectId, opportunityId: id, currency: 'USD' });
    expect(detected.filter((e) => e.id.includes(':observation:'))).toEqual([]);
  });
});

function transition(partial: Partial<CommitmentTransition> & { id: string; kind: string }): CommitmentTransition {
  return {
    duty: { holder: null, action: '' }, deadline: null, terms: [], evidence: [], outcome: 'DONE', outcomeDetail: null, at: null,
    amountCents: null, stage: null, parties: [], branchOf: null, restartOf: null, milestone: null, ...partial,
  };
}

function reading(transitions: CommitmentTransition[]): CommitmentReading {
  return { opportunityId: 'opp', currency: 'USD', transitions, overdue: [] } as unknown as CommitmentReading;
}

function observation(kind: CashObservation['kind'], observedAt: string, amountCents: number | null = null): CashObservation {
  return { id: `obs-${kind}-${observedAt}`, projectId: 'p', opportunityId: 'opp', kind, source: 'PERSON', channel: null, evidenceRef: 'msg-1', amountCents, currency: 'USD', note: null, observedAt, recordedBy: 'u', requestKey: 'k', createdAt: observedAt };
}

describe('exceptionsFromObservations', () => {
  const agreement = transition({ id: 'agreement:a1', kind: 'agreement', at: '2026-06-01T00:00:00.000Z', amountCents: 10_000, stage: 'CONTRACT_SIGNED' });
  const delivery = transition({ id: 'delivery:a1:1', kind: 'delivery', at: '2026-06-05T00:00:00.000Z' });

  it('is a dispute when the buyer contests after delivery, over the difference they stated', () => {
    const found = exceptionsFromObservations(reading([agreement, delivery]), [observation('BUYER_COUNTERED', '2026-06-06T00:00:00.000Z', 4_000)]);
    expect(found).toEqual([expect.objectContaining({ kind: 'DISPUTE', source: 'ROWS', disputedCents: 6_000, transitionId: 'agreement:a1' })]);
  });

  it('is a dispute over the whole agreed amount when the buyer refuses a delivered result', () => {
    const found = exceptionsFromObservations(reading([agreement, delivery]), [observation('BUYER_DECLINED', '2026-06-06T00:00:00.000Z')]);
    expect(found).toEqual([expect.objectContaining({ kind: 'DISPUTE', disputedCents: 10_000 })]);
  });

  it('is a cancellation when the buyer withdraws before anything was delivered', () => {
    const found = exceptionsFromObservations(reading([agreement]), [observation('BUYER_DECLINED', '2026-06-02T00:00:00.000Z')]);
    expect(found).toEqual([expect.objectContaining({ kind: 'CANCELLATION', source: 'ROWS' })]);
  });

  it('is nothing before an agreement, and adds no second dispute to a rejected acceptance', () => {
    expect(exceptionsFromObservations(reading([agreement]), [observation('BUYER_COUNTERED', '2026-05-30T00:00:00.000Z', 9_000)])).toEqual([]);
    const rejected = transition({ id: 'acceptance:a1', kind: 'acceptance', outcome: 'REJECTED', stage: 'WORK_ACCEPTED' });
    expect(exceptionsFromObservations(reading([agreement, delivery, rejected]), [observation('BUYER_DECLINED', '2026-06-06T00:00:00.000Z')])).toEqual([]);
  });
});
