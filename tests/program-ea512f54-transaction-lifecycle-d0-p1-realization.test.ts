/**
 * LIFE-29-2: the journey tick reads each deal's realization from its rows — delivery steps
 * derived from the agreed scope, fulfilled by a declared performer and never by the buyer,
 * delivery and acceptance with their evidence, open redo obligations, the accounting result —
 * records it, records repeat business the rows show as aftercare, and deal construction reads
 * that aftercare. The r01.life-29-2 probe judges those rows.
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
import { recordAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, recordEvent } from '../server/services/cash/journey/fulfillment.ts';
import { advanceJourney } from '../server/services/cash/journey/tick.ts';
import {
  AFTERCARE_EVENT,
  REALIZATION_EVENT,
  readDealRealization,
  realizationInputsFromRows,
  deriveDeliveryPlan,
  recordAftercareEvent,
  repeatBusinessObservations,
  repeatSignalsFromRows,
} from '../server/services/cash/deliverables/realization.ts';
import { realizationProblem } from '../server/services/cash/deliverables/lifecycleProbes.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `life292-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
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


const probe = (name: string) => getProbe(name)!({});

async function supplierDelivers(agreement: CashAgreement, accept: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED'): Promise<void> {
  const declared = await declare({ projectId, agreementId: agreement.id, kind: 'SUPPLIER', performer: 'Acme Forms Ltd', supplierName: 'Acme Forms Ltd', actorRef: userId });
  if (!declared.ok) throw new Error(declared.reason);
  for (const [kind, detail, evidence] of [
    ['WORK_COMPLETE', 'The supplier finished the repair.', `supplier-done-${agreement.id}`],
    ['DELIVERED', 'The repaired form is live.', `delivered-${agreement.id}`],
    [accept, accept === 'ACCEPTED' ? 'The buyer confirmed a test enquiry arrived.' : 'The form still drops enquiries.', `buyer-${accept}-${agreement.id}`],
  ] as const) {
    const done = await recordEvent({ projectId, agreementId: agreement.id, kind, detail, evidenceRef: evidence, actorRef: userId });
    if (!done.ok) throw new Error(`${kind}: ${done.reason}`);
  }
}

describe('r01.life-29-2 is registered and never passes on nothing', () => {
  it('fails with no live agreement to read', async () => {
    const r = await probe('r01.life-29-2');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no opportunity has a live agreement/);
  });
});

describe('delivery derived from rows (pure)', () => {
  const obligation = (kind: string, performer: string) => ({
    agreementId: 'agr_1', deliverable: 'Repair the intake form', agreementState: 'AGREED',
    fulfillment: { kind, performer, supplierName: kind === 'SUPPLIER' ? performer : null }, events: [],
  });

  it('refuses the buyer as fulfiller, and says so', () => {
    const inputs = realizationInputsFromRows({ opportunityId: 'o1', payer: 'Jane Buyer', obligations: [obligation('PERSON', 'jane buyer')] });
    const plan = deriveDeliveryPlan({ scope: inputs.scope, parties: inputs.parties, readings: new Map() });
    expect(plan.steps[0]!.status).toBe('REFUSED');
    expect(plan.steps[0]!.reasons.join(' ')).toMatch(/is the buyer/);
    expect(plan.executable).toBe(false);
  });

  it('keeps a named person accountable and never gives it to a Brain capability', () => {
    const inputs = realizationInputsFromRows({ opportunityId: 'o1', payer: 'Jane Buyer', obligations: [obligation('PERSON', 'Licensed Surveyor')] });
    const plan = deriveDeliveryPlan({ scope: inputs.scope, parties: inputs.parties, readings: new Map() });
    expect(plan.steps[0]!.fulfiller?.kind).toBe('ACCOUNTABLE_PERSON');
    expect(plan.steps[0]!.responsibility).toMatch(/Licensed Surveyor remains accountable/);
  });

  it('does not claim an unproven capability, and names an undeclared obligation as a need', () => {
    const software = realizationInputsFromRows({ opportunityId: 'o1', payer: 'B', obligations: [obligation('SOFTWARE', 'Brain')] });
    const missing = deriveDeliveryPlan({ scope: software.scope, parties: software.parties, readings: new Map([['BUILD_SOFTWARE', 'MISSING']]) });
    expect(missing.steps[0]!.status).toBe('UNASSIGNED');
    expect(missing.steps[0]!.reasons.join(' ')).toMatch(/BUILD_SOFTWARE reads MISSING/);
    const undeclared = realizationInputsFromRows({ opportunityId: 'o1', payer: 'B', obligations: [{ ...obligation('SUPPLIER', 'x'), fulfillment: null }] });
    const plan = deriveDeliveryPlan({ scope: undeclared.scope, parties: undeclared.parties, readings: new Map() });
    expect(plan.unassigned).toEqual(['agr_1']);
  });

  it('a repeat signal needs an accepted delivery first and the same payer', () => {
    const later = [{ id: 'a2', opportunityId: 'o2', payer: 'Jane  Buyer', amountCents: 40_000, evidenceRef: 'email', createdAt: '2026-11-02T00:00:00.000Z', state: 'AGREED' }];
    expect(repeatSignalsFromRows({ deal: { opportunityId: 'o1', payer: 'Jane Buyer', acceptedAt: null }, laterAgreements: later })).toEqual([]);
    expect(repeatSignalsFromRows({ deal: { opportunityId: 'o1', payer: 'Jane Buyer', acceptedAt: '2026-11-03T00:00:00.000Z' }, laterAgreements: later })).toEqual([]);
    const found = repeatSignalsFromRows({ deal: { opportunityId: 'o1', payer: 'Jane Buyer', acceptedAt: '2026-11-01T00:00:00.000Z' }, laterAgreements: later });
    expect(found.map((f) => [f.kind, f.valueCents])).toEqual([['FOLLOW_UP_REQUEST', 40_000]]);
  });
});

describe('the journey tick consumes the realization model', () => {
  it('fails before the tick has read the deal, then records a reading the probe accepts, once', async () => {
    const id = await executing();
    const agreement = await agree(id);
    await supplierDelivers(agreement);
    const before = await probe('r01.life-29-2');
    expect(before.ok).toBe(false);
    expect(before.detail).toMatch(/no realization is on record/);

    const first = await advanceJourney(projectId);
    expect(first.realization.recorded).toBe(1);
    const events = await cashEventsOfKind(id, REALIZATION_EVENT);
    expect(events.length).toBe(1);
    const detail = events[0]!.detail as { plan: { steps: { key: string; fulfiller: { kind: string } | null }[] }; reading: { delivered: string[]; accepted: string[]; realized: boolean } };
    expect(detail.plan.steps.map((s) => [s.key, s.fulfiller?.kind])).toEqual([[agreement.id, 'EXISTING_SUPPLIER']]);
    expect(detail.reading.delivered).toEqual([agreement.id]);
    expect(detail.reading.accepted).toEqual([agreement.id]);
    expect(detail.reading.realized).toBe(true);

    const r = await probe('r01.life-29-2');
    expect(r.detail).toMatch(/1 deal\(s\): 1 delivery step\(s\) derived from agreed scope, 1 accepted/);
    expect(r.ok).toBe(true);

    const second = await advanceJourney(projectId);
    expect(second.realization.recorded).toBe(0);
    expect((await cashEventsOfKind(id, REALIZATION_EVENT)).length).toBe(1);
  });

  it('a rejected delivery is not realized and carries an open redo obligation', async () => {
    const id = await executing();
    const agreement = await agree(id);
    await supplierDelivers(agreement, 'REJECTED');
    await advanceJourney(projectId);
    const reading = (await readDealRealization({ projectId, opportunityId: id, currency: 'USD' }))!;
    expect(reading.reading.realized).toBe(false);
    expect(reading.reading.rejected).toEqual([agreement.id]);
    expect(reading.reading.redoObligations.filter((o) => o.open).map((o) => o.stepKey)).toEqual([agreement.id]);
    expect(realizationProblem(reading)).toBeNull();
    expect((await probe('r01.life-29-2')).ok).toBe(true);
  });

  it('the probe refuses a reading that names the buyer as fulfiller or calls an unaccepted deal realized', async () => {
    const id = await executing();
    await agree(id);
    const reading = (await readDealRealization({ projectId, opportunityId: id, currency: 'USD' }))!;
    expect(realizationProblem(reading)).toBeNull();
    const step = reading.plan.steps[0]!;
    const buyerFulfils = { ...reading, plan: { ...reading.plan, steps: [{ ...step, status: 'ASSIGNED' as const, fulfiller: { kind: 'SOURCED_PROVIDER' as const, ref: reading.buyerId } }] } };
    expect(realizationProblem(buyerFulfils)).toMatch(/names the buyer as fulfiller/);
    const lying = { ...reading, reading: { ...reading.reading, realized: true } };
    expect(realizationProblem(lying)).toMatch(/says realized with a step not accepted/);
  });

  it('records repeat business from the rows once, and deal construction reads it', async () => {
    const first = await executing('A paid intake repair');
    const agreement = await agree(first);
    await supplierDelivers(agreement);
    await advanceJourney(projectId);
    const again = await executing('A second intake job');
    await agree(again, 40_000, 'Add a booking step');
    const tick = await advanceJourney(projectId);
    expect(tick.realization.aftercare).toBe(1);
    const records = await cashEventsOfKind(first, AFTERCARE_EVENT);
    expect(records.length).toBe(1);
    expect((records[0]!.detail as { kind: string; valueCents: number }).kind).toBe('FOLLOW_UP_REQUEST');
    expect((await advanceJourney(projectId)).realization.aftercare).toBe(0);

    const observations = await repeatBusinessObservations(projectId, 'USD');
    expect(observations.map((o) => [o.context['payer'], o.value])).toEqual([['the owner who signs', { kind: 'POINT', value: 400 }]]);
    const r = await probe('r01.life-29-2');
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/1 repeat-business record\(s\) feeding deal construction/);
  });

  it('a stated aftercare relationship needs evidence, and is recorded once by its key', async () => {
    const id = await executing();
    const record = { kind: 'SATISFACTION' as const, partyId: 'buyer', at: '2026-11-10T00:00:00.000Z', evidence: '', score: 0.9 };
    const refused = await recordAftercareEvent({ projectId, opportunityId: id, record, recordKey: 'csat-1', actorRef: userId });
    expect(refused.ok).toBe(false);
    const ok = await recordAftercareEvent({ projectId, opportunityId: id, record: { ...record, evidence: 'survey response 1' }, recordKey: 'csat-1', actorRef: userId });
    expect(ok).toEqual({ ok: true, created: true });
    const repeat = await recordAftercareEvent({ projectId, opportunityId: id, record: { ...record, evidence: 'survey response 1' }, recordKey: 'csat-1', actorRef: userId });
    expect(repeat).toEqual({ ok: true, created: false });
    expect((await cashEventsOfKind(id, AFTERCARE_EVENT)).length).toBe(1);
  });
});
