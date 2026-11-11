/**
 * Finding F3: `readCommitments` accepted declared steps and external
 * dependencies, but no production caller passed either and nothing persisted
 * them, so on production the reading's dependency list was always empty. Now
 * the dependencies the rows imply are derived on every read and recorded by the
 * journey tick, and structure a person states is appended to `cash_events` and
 * read back — with no caller passing anything.
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
import { recordAgreement } from '../server/services/cash/journey/deal.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import { factsFromReading, quantifyConsequence, rehearseStoredCase } from '../server/services/cash/deliverables/exceptions.ts';
import {
  COMMITMENT_STRUCTURE_KIND,
  CommitmentStructureError,
  dependenciesFromRows,
  readCommitments,
  recordCommitmentStructure,
  validateDeclared,
  validateDependency,
} from '../server/services/cash/deliverables/commitments.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';
import type { CashMoneyEntry } from '../server/domain/types.ts';
import type { ObligationReading } from '../server/services/cash/journey/fulfillment.ts';

/* ------------------------------------------------------------- pure readings */
const entry = (kind: string, amountCents: number, over: Partial<CashMoneyEntry> = {}): CashMoneyEntry => ({
  id: `me_${kind}_${amountCents}`, projectId: 'prj', opportunityId: 'opp', commitmentId: null, idempotencyKey: null, payloadFingerprint: null,
  kind: kind as CashMoneyEntry['kind'], amountCents, currency: 'USD', verifiedReference: null, fundsAvailableAt: null,
  occurredAt: '2026-06-01T00:00:00.000Z', note: null, recordedBy: 't', createdAt: '2026-06-01T00:00:00.000Z', ...over,
});
const obligation = (state: 'AWAITING_DELIVERY' | 'ACCEPTED' | 'REJECTED', amountCents = 10_000): ObligationReading => ({
  opportunityId: 'opp',
  agreement: { id: 'a1', opportunityId: 'opp', amountCents, currency: 'USD', acceptanceCondition: 'buyer signs off', releasedAt: null },
  delivery: { state: state === 'AWAITING_DELIVERY' ? 'NOT_DELIVERED' : 'DELIVERED', portions: [] },
  acceptance: { state, condition: 'buyer signs off', evidence: null, reason: null },
  refunds: [],
} as unknown as ObligationReading);

describe('dependenciesFromRows reads what the rows imply, and nothing else', () => {
  it('an agreement\'s acceptance condition is a quality check, satisfied only once accepted', () => {
    const open = dependenciesFromRows({ obligations: [obligation('AWAITING_DELIVERY')], entries: [], currency: 'USD' });
    expect(open).toEqual([expect.objectContaining({ kind: 'quality check', detail: 'buyer signs off', satisfied: null, source: 'rows', ref: 'agreement:a1' })]);
    expect(dependenciesFromRows({ obligations: [obligation('ACCEPTED')], entries: [], currency: 'USD' })[0]!.satisfied).toBe(true);
    expect(dependenciesFromRows({ obligations: [obligation('REJECTED')], entries: [], currency: 'USD' })[0]!.satisfied).toBe(false);
  });

  it('money received for unaccepted work is refund exposure, and paid-but-unsettled money is a payment hold due when funds are available', () => {
    const deps = dependenciesFromRows({
      obligations: [obligation('AWAITING_DELIVERY')],
      entries: [entry('CUSTOMER_PAYMENT', 10_000, { fundsAvailableAt: '2026-06-05T00:00:00.000Z' })],
      currency: 'USD',
    });
    expect(deps.find((d) => d.kind === 'refund exposure')?.detail).toContain('10000 USD received for work not yet accepted');
    expect(deps.find((d) => d.kind === 'payment hold')).toMatchObject({ deadline: '2026-06-05T00:00:00.000Z', satisfied: false });
    const settledAccepted = dependenciesFromRows({
      obligations: [obligation('ACCEPTED')],
      entries: [entry('CUSTOMER_PAYMENT', 10_000), entry('SETTLEMENT', 10_000)],
      currency: 'USD',
    });
    expect(settledAccepted.map((d) => d.kind)).toEqual(['quality check']);
  });

  it('reads the card\'s delivery method, and guesses no term the rows do not carry', () => {
    const deps = dependenciesFromRows({ obligations: [], entries: [], currency: 'USD', card: { deliveryMethod: 'On site, one afternoon', fulfillmentOwner: 'Acme Ltd' } });
    expect(deps).toEqual([expect.objectContaining({ kind: 'delivery method', detail: 'On site, one afternoon', holder: { role: 'provider', ref: 'Acme Ltd' } })]);
    expect(dependenciesFromRows({ obligations: [], entries: [], currency: 'USD', card: { deliveryMethod: null, fulfillmentOwner: null } })).toEqual([]);
  });
});

describe('stated structure is validated', () => {
  it('refuses a step or a dependency that cannot say what it is', () => {
    expect(() => validateDeclared({ id: 'x', kind: 'delivery' })).toThrow(CommitmentStructureError);
    expect(() => validateDeclared({ id: 'x', kind: 'k', action: 'a', outcome: 'MAYBE' })).toThrow(/unknown outcome/);
    expect(() => validateDependency({ kind: 'delivery location' })).toThrow(CommitmentStructureError);
    expect(validateDeclared({ id: ' x ', kind: 'k', action: 'a', holder: { role: 'purchaser', ref: 'p2' }, branchOf: 'agreement:a1' }))
      .toEqual({ id: 'x', kind: 'k', action: 'a', holder: { role: 'purchaser', ref: 'p2' }, branchOf: 'agreement:a1' });
  });
});

/* --------------------------------------------------------- production path */
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


describe('on production rows, with no caller passing anything', () => {
  it('the reading carries the dependencies its rows imply', async () => {
    const id = await executing();
    await agree(id);
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(reading.dependencies.map((d) => d.kind)).toEqual(expect.arrayContaining(['quality check', 'delivery method']));
    expect(reading.dependencies.find((d) => d.kind === 'quality check')?.detail).toBe('Form submits and a test enquiry arrives');
    // They are binding terms of any exception's consequence.
    expect(quantifyConsequence(reading, { id: 'e', kind: 'DISPUTE', detail: 'd', source: 'ROWS', transitionId: null, evidence: [], at: null, raisedBy: null, valueDeltaCents: null, disputedCents: null } as never).bindingTerms)
      .toEqual(expect.arrayContaining([expect.stringContaining('quality check')]));
  });

  it('the journey tick records them once per change', async () => {
    const id = await executing();
    await agree(id);
    await advanceJourney(projectId);
    const first = await cashEventsOfKind(id, COMMITMENT_STRUCTURE_KIND);
    expect(first).toHaveLength(1);
    expect(first[0]!.actorRef).toBe('BRAIN');
    expect(((first[0]!.detail as { dependencies: { kind: string }[] }).dependencies).map((d) => d.kind)).toEqual(expect.arrayContaining(['quality check']));
    await advanceJourney(projectId);
    expect(await cashEventsOfKind(id, COMMITMENT_STRUCTURE_KIND)).toHaveLength(1);
    // Money paid and not settled changes what binds the deal: recorded again.
    const paid = await recordMoneyEvent({ projectId, opportunityId: id, kind: 'CUSTOMER_PAYMENT', amountCents: 75_000, currency: 'USD', verifiedReference: `pay-${id}`, idempotencyKey: `pay:${id}`, actorRef: userId, appliesTo: null });
    expect(paid.ok).toBe(true);
    await advanceJourney(projectId);
    const events = await cashEventsOfKind(id, COMMITMENT_STRUCTURE_KIND);
    expect(events).toHaveLength(2);
    expect(((events[1]!.detail as { dependencies: { kind: string }[] }).dependencies).map((d) => d.kind)).toEqual(expect.arrayContaining(['payment hold', 'refund exposure']));
  });

  it('structure a person states is persisted and read back: a branch, a second purchaser, a deadline, an escalation path', async () => {
    const id = await executing();
    const agreement = await agree(id);
    await recordCommitmentStructure({
      projectId, opportunityId: id, actorRef: userId, reason: 'the buyer\'s second site joins',
      declared: [{ id: 'site-2', kind: 'delivery', action: 'Configure the second site', holder: { role: 'provider', ref: 'Us' }, deadline: '2026-01-01T00:00:00.000Z', parties: [{ role: 'purchaser', ref: 'Second site' }], branchOf: `agreement:${agreement.id}`, milestone: 'site 2 of 2' }],
      dependencies: [{ kind: 'escalation path', detail: 'The owner calls the buyer before any release.' }, { kind: 'delivery location', detail: '12 High St' }],
    });
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD', now: '2026-02-01T00:00:00.000Z' });
    const step = reading.transitions.find((t) => t.id === 'site-2');
    expect(step).toMatchObject({ branchOf: `agreement:${agreement.id}`, milestone: 'site 2 of 2', deadline: '2026-01-01T00:00:00.000Z' });
    expect(reading.parties).toEqual(expect.arrayContaining([{ role: 'purchaser', ref: 'Second site' }]));
    expect(reading.overdue).toContain('site-2');
    expect(reading.dependencies.map((d) => d.kind)).toEqual(expect.arrayContaining(['escalation path', 'delivery location', 'quality check']));
    expect(factsFromReading(reading).escalationPath).toBe(true);

    // A later statement of the same dependency supersedes it for reading; history stays.
    await recordCommitmentStructure({ projectId, opportunityId: id, actorRef: userId, dependencies: [{ kind: 'escalation path', detail: 'The owner calls the buyer before any release.', satisfied: false }] });
    const later = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(later.dependencies.filter((d) => d.kind === 'escalation path')).toEqual([expect.objectContaining({ satisfied: false })]);
    expect(factsFromReading(later).escalationPath).toBeUndefined();
    expect(await cashEventsOfKind(id, COMMITMENT_STRUCTURE_KIND)).toHaveLength(2);
  });

  it('the stored rehearsal reads the stated structure without being handed it', async () => {
    const id = await executing();
    await agree(id);
    await recordCommitmentStructure({ projectId, opportunityId: id, actorRef: userId, dependencies: [{ kind: 'cancellation provision', detail: '48h notice' }] });
    const stored = await rehearseStoredCase({ projectId, opportunityId: id, currency: 'USD', sourceRef: `email-${id}`, actorRef: userId });
    const steps = (await cashEventsOfKind(id, stored.eventKind))[0]!;
    expect(steps).toBeTruthy();
    const reading = await readCommitments({ projectId, opportunityId: id, currency: 'USD' });
    expect(reading.dependencies.find((d) => d.kind === 'cancellation provision')?.detail).toBe('48h notice');
  });

  it('refuses an empty statement', async () => {
    const id = await executing();
    await expect(recordCommitmentStructure({ projectId, opportunityId: id, actorRef: userId })).rejects.toThrow(/nothing was stated/);
  });
});
