/**
 * LIFE-29-2: the journey tick derives each declared obligation's delivery plan from its agreed
 * scope, reads delivery, acceptance and redo from the fulfilment rows, records the aftercare a
 * buyer's rows show, and arrangement construction reads that aftercare as the buyer's repeat rate.
 * r01.life-29-2 judges those rows and passes on nothing less.
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
  DELIVERY_REALIZED_EVENT,
  aftercareByPayer,
  realizationOfObligation,
  type ObligationRows,
} from '../server/services/cash/deliverables/realization.ts';
import '../server/services/cash/deliverables/lifecycleProbes.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { constructArrangements } from '../server/services/cash/construct.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import type { CashAgreement } from '../server/domain/cashJourney.ts';
import type { CashFulfillment } from '../server/domain/cashFulfillment.ts';

const PAYER = 'The owner, who signs';
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

async function executing(title: string, payer = PAYER): Promise<string> {
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title, mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [] });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer,
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
    firstAction: { action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.', reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first') },
  });
  if (!began.ok) throw new Error(began.reason);
  return id;
}

async function agree(opportunityId: string, deliverable: string, amountCents = 75_000): Promise<CashAgreement> {
  const done = await recordAgreement({
    opportunityId, amountCents, currency: 'USD', deliverable,
    acceptanceCondition: 'Form submits and a test enquiry arrives',
    evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${opportunityId}-${deliverable}`, actorRef: userId,
  });
  if (!done.ok) throw new Error(done.reason);
  return done.value;
}

async function performedAndAccepted(agreement: CashAgreement, performer = 'The operator'): Promise<void> {
  expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer, actorRef: userId })).ok).toBe(true);
  for (const [kind, evidenceRef] of [['WORK_COMPLETE', 'work-log'], ['DELIVERED', 'handover-email'], ['ACCEPTED', 'buyer-signoff']] as const) {
    const done = await recordEvent({ projectId, agreementId: agreement.id, kind, detail: `${kind.toLowerCase()} as recorded`, evidenceRef: `${evidenceRef}-${agreement.id}`, actorRef: userId });
    expect(done.ok, done.ok ? '' : done.reason).toBe(true);
  }
}

const probe = () => getProbe('r01.life-29-2')!({});

describe('r01.life-29-2 is registered and does not pass on nothing', () => {
  it('fails with no declared obligation', async () => {
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no obligation has been declared/);
  });

  it('fails while a planned obligation has no accepted delivery', async () => {
    const id = await executing('A paid intake repair');
    const agreement = await agree(id, 'Repair the intake form');
    expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The operator', actorRef: userId })).ok).toBe(true);
    await advanceJourney(projectId);
    const r = await probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no delivery has been accepted/);
  });
});

const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const repeatRate = async (): Promise<number[]> =>
  (await constructArrangements({ projectId, currency: 'USD', delivers: ['web forms'], capitalCeilingCents: null, daysLeft: 30 }))
    .filter((a) => a.design.repeat !== 'ONE_OFF' && sameName(a.demand.name, PAYER))
    .map((a) => a.repeatRate?.aftercare ?? 0);

describe('the journey tick derives delivery from the agreed scope and records aftercare', () => {
  it('records a plan from the deliverable, the acceptance evidence and the buyer aftercare, once', async () => {
    const id = await executing('A paid intake repair');
    const agreement = await agree(id, 'Repair the intake form');
    await performedAndAccepted(agreement);
    const report = await advanceJourney(projectId);
    expect(report.realization.obligations).toBe(1);

    const realized = await cashEventsOfKind(id, DELIVERY_REALIZED_EVENT);
    const last = realized.at(-1)!.detail as { agreementId: string; scopeFrom: string; plan: { steps: { promise: string; status: string; fulfiller: { kind: string } | null }[] }; realization: { accepted: string[]; delivered: string[] } };
    expect(last.agreementId).toBe(agreement.id);
    expect(last.scopeFrom).toBe('agreement.deliverable');
    expect(last.plan.steps.map((s) => s.promise)).toEqual(['Repair the intake form']);
    expect(last.plan.steps[0]!.status).toBe('ASSIGNED');
    expect(last.plan.steps[0]!.fulfiller?.kind).toBe('SOURCED_PROVIDER');
    expect(last.realization.delivered).toEqual([agreement.id]);
    expect(last.realization.accepted).toEqual([agreement.id]);

    const after = await cashEventsOfKind(id, AFTERCARE_EVENT);
    expect(after.map((e) => (e.detail as { aftercareKey: string }).aftercareKey)).toEqual([`SATISFACTION:${agreement.id}`]);

    // Idempotent: another pass appends nothing new.
    await advanceJourney(projectId);
    expect((await cashEventsOfKind(id, DELIVERY_REALIZED_EVENT)).length).toBe(realized.length);
    expect((await cashEventsOfKind(id, AFTERCARE_EVENT)).length).toBe(1);

    const r = await probe();
    expect(r.ok, r.detail).toBe(true);
    expect(r.detail).toMatch(/1 accepted with evidence/);
  });

  it('records a later agreement from the same buyer as repeat business that construction reads', async () => {
    const first = await executing('A paid intake repair');
    await recordCardFact({ projectId, opportunityId: first, field: 'payer', kind: 'EVIDENCE', value: PAYER, decidedBy: userId });
    const a1 = await agree(first, 'Repair the intake form');
    const before = await repeatRate();
    await performedAndAccepted(a1);
    await advanceJourney(projectId);
    const second = await executing('The same buyer asks for a booking widget');
    await agree(second, 'Add a booking widget', 40_000);
    await advanceJourney(projectId);

    const repeat = (await cashEventsOfKind(first, AFTERCARE_EVENT)).map((e) => e.detail as { aftercareKey: string; record: { kind: string; valueCents: number | null } });
    const followUp = repeat.find((d) => d.record.kind === 'FOLLOW_UP_REQUEST');
    expect(followUp?.record.valueCents).toBe(40_000);

    const byPayer = await aftercareByPayer(projectId);
    const reading = [...byPayer.values()].find((one) => one.payer === PAYER)!;
    expect(reading.accepted).toBe(1);
    expect(reading.repeats).toBe(1);
    expect(reading.statedRepeatValueCents).toBe(40_000);

    // Construction reads it: every repeating arrangement for this buyer now resolves its repeat rate from the buyer's aftercare.
    const after = await repeatRate();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((n) => n === 0)).toBe(true);
    expect(after.length).toBe(before.length);
    expect(after.every((n) => n === 1)).toBe(true);
  });

  it('notices when the recorded realization no longer matches the fulfilment rows', async () => {
    const id = await executing('A paid intake repair');
    const agreement = await agree(id, 'Repair the intake form');
    expect((await declare({ projectId, agreementId: agreement.id, kind: 'PERSON', performer: 'The operator', actorRef: userId })).ok).toBe(true);
    await recordEvent({ projectId, agreementId: agreement.id, kind: 'WORK_COMPLETE', detail: 'done', evidenceRef: 'log', actorRef: userId });
    await recordEvent({ projectId, agreementId: agreement.id, kind: 'DELIVERED', detail: 'sent', evidenceRef: 'handover', actorRef: userId });
    await advanceJourney(projectId);
    // Accepted after the last tick: the record is stale until the tick runs again.
    await recordEvent({ projectId, agreementId: agreement.id, kind: 'ACCEPTED', detail: 'signed off', evidenceRef: 'signoff', actorRef: userId });
    const stale = await probe();
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/disagree with the fulfilment rows/);
    await advanceJourney(projectId);
    expect((await probe()).ok).toBe(true);
  });
});

describe('delivery is derived from the real scope, never a buyer as fulfiller (pure)', () => {
  const agreement = { id: 'agr-1', opportunityId: 'opp-1', deliverable: 'Translate the contract', acceptanceCondition: 'Buyer approves', currency: 'USD', amountCents: 10_000 } as CashAgreement;
  const rows = (fulfillment: Partial<CashFulfillment>, payer: string | null = 'Acme Ltd'): ObligationRows => ({
    agreement,
    fulfillment: { id: 'ful-1', kind: 'PERSON', performer: 'A translator', supplierName: null, ...fulfillment } as CashFulfillment,
    payer,
    events: [],
  });

  it('refuses a performer who is the buyer', () => {
    const { plan } = realizationOfObligation(rows({ kind: 'SUPPLIER', performer: 'ACME ltd', supplierName: 'Acme  Ltd.' }), new Map());
    expect(plan.steps[0]!.status).toBe('REFUSED');
    expect(plan.executable).toBe(false);
  });

  it('never claims an unproven Brain capability', () => {
    const missing = realizationOfObligation(rows({ kind: 'SOFTWARE', performer: 'Factory' }), new Map([['BUILD_SOFTWARE', 'MISSING']]));
    expect(missing.plan.steps[0]!.status).toBe('UNASSIGNED');
    const present = realizationOfObligation(rows({ kind: 'SOFTWARE', performer: 'Factory' }), new Map([['BUILD_SOFTWARE', 'PRESENT']]));
    expect(present.plan.steps[0]!.fulfiller).toEqual({ kind: 'BRAIN_CAPABILITY', ref: 'BUILD_SOFTWARE' });
  });

  it('opens a redo when the buyer rejects the delivery', () => {
    const r = rows({});
    r.events = [
      { kind: 'DELIVERED', createdAt: '2026-10-01T00:00:00.000Z', evidenceRef: 'sent', detail: 'sent' },
      { kind: 'REJECTED', createdAt: '2026-10-02T00:00:00.000Z', evidenceRef: 'reply', detail: 'wrong dialect' },
    ] as ObligationRows['events'];
    const { realization } = realizationOfObligation(r, new Map());
    expect(realization.rejected).toEqual(['agr-1']);
    expect(realization.redoObligations.filter((o) => o.open).map((o) => o.stepKey)).toEqual(['agr-1']);
    expect(realization.realized).toBe(false);
  });
});
