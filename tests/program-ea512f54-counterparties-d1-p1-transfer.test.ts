/**
 * CP-31 repair: a refused provider send could only be "transferred" to the same provider.
 *
 * The wrapper offered the model's transfer `candidateIds: [the failed counterparty]`, and each
 * deployment registered exactly one messaging and one billing provider, so no alternative
 * fulfiller existed in the live path. Now a deployment may register configured alternates behind
 * the chosen provider (`BRAIN_MESSAGING_ALTERNATES`), every fulfiller is a transfer candidate, and
 * when the model moves the commitment the alternative carries it — once, under the transfer's own
 * hold, with the failed hold released in the same write — and an unknown is never sent twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { CONTACT_BUYER_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, listAdapters, type EffectAdapter, type EffectRequest, type SendOutcome } from '../server/services/effects/adapter.ts';
import { messagingAlternates } from '../server/services/cash/providers/config.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import {
  RECORDS_COUNTERPARTY,
  fulfillingCounterparties,
  providerCounterpartyId,
  recordProviderAttempt,
  type ProviderFulfiller,
  type ProviderSeat,
} from '../server/services/cash/providers/counterpartyRecord.ts';
import { counterpartyBreaches, readProviderTransactions } from '../server/services/cash/providers/counterparty.ts';
import { recordCounterpartyFacts, type Fact } from '../server/services/labor/counterparties/ladder.ts';
import { doubleCommitted, holdsFrom, recordedReservationEvents } from '../server/services/labor/counterparties/reservations.ts';

const INSTANTLY_KEY = 'inst_0123456789abcdefghijklmnop';
const RESEND = { RESEND_API_KEY: 're_test_0123456789', BRAIN_MESSAGING_FROM: 'Brain <sales@brain.example>' };
const ENV = {
  BRAIN_MESSAGING_PROVIDER: 'instantly',
  INSTANTLY_API_KEY: INSTANTLY_KEY,
  BRAIN_MESSAGING_ALTERNATES: 'resend',
  ...RESEND,
} as NodeJS.ProcessEnv;

let day = 0;
let AT = '';

const seat = (provider: string): ProviderSeat => ({
  area: 'MESSAGING', provider, capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: async () => 5,
});
const PRIMARY = seat('primary-mail');
const ALTERNATE = seat('alternate-mail');
const PRIMARY_ID = providerCounterpartyId(PRIMARY);
const ALTERNATE_ID = providerCounterpartyId(ALTERNATE);

/** A test adapter for the contact namespace that answers as told and counts its sends. */
function adapter(name: string, answer: () => SendOutcome): EffectAdapter & { sends: number } {
  const one = {
    name, effectClass: 'EXTERNAL_OPAQUE' as const, namespace: CONTACT_BUYER_NAMESPACE.name, sends: 0,
    validate: (payload: unknown) => payload as Record<string, unknown>,
    fingerprintInputs: (payload: Record<string, unknown>) => payload,
    async send(): Promise<SendOutcome> { one.sends += 1; return answer(); },
  };
  return one;
}

async function business(): Promise<{ projectId: string; opportunityId: string }> {
  const projectId = (await freshProject()).project.id;
  const userId = (await createUser({ email: `cp31t-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
  });
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  return { projectId, opportunityId: captured.value.id };
}

/** Evidence that the alternate has quoted and has capacity: what the transfer's quote gate needs. */
async function quoted(projectId: string, counterpartyId: string): Promise<void> {
  const evidence = 'alternate provider account plan, read by the operator';
  const facts: Fact[] = [
    { dimension: 'listing', status: 'VERIFIED', evidence, value: 'alternate-mail' },
    { dimension: 'willingness', status: 'VERIFIED', evidence },
    { dimension: 'availability', status: 'VERIFIED', evidence },
    { dimension: 'eligibility', status: 'VERIFIED', evidence },
    { dimension: 'scope', status: 'VERIFIED', evidence, value: 'SEND_A_MESSAGE' },
    { dimension: 'qualifications', status: 'NOT_APPLICABLE', evidence: 'a hosted software service holds no licence' },
    { dimension: 'geography', status: 'NOT_APPLICABLE', evidence: 'a hosted software service has no service area' },
    { dimension: 'price', status: 'VERIFIED', evidence, value: 0 },
    { dimension: 'paymentTerms', status: 'VERIFIED', evidence, value: 'monthly plan' },
    { dimension: 'leadTime', status: 'VERIFIED', evidence, value: 0 },
    { dimension: 'availableCapacity', status: 'VERIFIED', evidence, value: 5 },
  ];
  await recordCounterpartyFacts({
    projectId, counterparty: { id: counterpartyId, kind: 'software service', geography: null, humanOperator: false }, facts, actorRef: 'BRAIN',
  });
}

const request = (opportunityId: string): EffectRequest => ({
  providerKey: null, businessId: `cash:${opportunityId}:CONTACT_BUYER:1`, payload: {},
});
const refused: SendOutcome = { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true };

beforeEach(() => {
  clearAdapters();
  day += 1;
  AT = new Date(Date.UTC(2032, 0, day, 12)).toISOString();
});
afterEach(() => clearAdapters());

describe('the transfer is offered real alternatives', () => {
  it('the wrapper names every registered fulfiller as a candidate, so a refusal moves to the alternative', async () => {
    const { projectId, opportunityId } = await business();
    await quoted(projectId, ALTERNATE_ID);
    const { recorded } = await recordProviderAttempt(PRIMARY, request(opportunityId), async () => refused, () => AT, [ALTERNATE_ID]);
    expect(recorded.outcome).toBe('FAILED');
    expect(recorded.transferred).toBe(true);
    expect(recorded.transferredTo).toBe(ALTERNATE_ID);
    expect(recorded.transferredTo).not.toBe(PRIMARY_ID);
    const holds = holdsFrom(await recordedReservationEvents([PRIMARY_ID, ALTERNATE_ID]));
    expect(holds.find((h) => h.counterpartyId === PRIMARY_ID)?.state).toBe('RELEASED');
    expect(holds.find((h) => h.counterpartyId === ALTERNATE_ID)?.state).toBe('HELD');
  });

  it('the alternative carries a transferred commitment once, its answer is the effect\'s, and nothing is double-committed', async () => {
    const { projectId, opportunityId } = await business();
    await quoted(projectId, ALTERNATE_ID);
    const first = adapter('primary-mail', () => refused);
    const second = adapter('alternate-mail', () => ({ kind: 'CONFIRMED', receiptRef: 'alt-1' }));
    const composite = fulfillingCounterparties([{ seat: PRIMARY, adapter: first }, { seat: ALTERNATE, adapter: second }] satisfies ProviderFulfiller[], () => AT);
    expect(composite[RECORDS_COUNTERPARTY]).toBe(PRIMARY_ID);

    const outcome = await composite.send(request(opportunityId));
    expect(outcome).toEqual({ kind: 'CONFIRMED', receiptRef: 'alt-1' });
    expect([first.sends, second.sends]).toEqual([1, 1]);
    const events = await recordedReservationEvents([PRIMARY_ID, ALTERNATE_ID]);
    const holds = holdsFrom(events);
    expect(holds.find((h) => h.counterpartyId === PRIMARY_ID)?.state).toBe('RELEASED');
    expect(holds.find((h) => h.counterpartyId === ALTERNATE_ID)?.state).toBe('PERFORMED');
    expect(doubleCommitted(events)).toEqual([]);
  });

  it('moves nothing, and sends nothing twice, when the alternative has not quoted or the first answer is unknown', async () => {
    const a = await business();
    const unquotedAlt = adapter('alternate-mail', () => ({ kind: 'CONFIRMED', receiptRef: 'never' }));
    const refusing = fulfillingCounterparties([{ seat: PRIMARY, adapter: adapter('primary-mail', () => refused) }, { seat: ALTERNATE, adapter: unquotedAlt }], () => AT);
    expect(await refusing.send(request(a.opportunityId))).toEqual(refused);
    expect(unquotedAlt.sends).toBe(0);

    const b = await business();
    await quoted(b.projectId, ALTERNATE_ID);
    const standby = adapter('alternate-mail', () => ({ kind: 'CONFIRMED', receiptRef: 'never' }));
    const uncertain = fulfillingCounterparties([{ seat: PRIMARY, adapter: adapter('primary-mail', () => ({ kind: 'UNCERTAIN', reason: 'timed out' })) }, { seat: ALTERNATE, adapter: standby }], () => AT);
    expect((await uncertain.send(request(b.opportunityId))).kind).toBe('UNCERTAIN');
    expect(standby.sends).toBe(0); // an unknown is never read as "it did not happen"
  });

  it('refuses an alternative of another effect class rather than misreport the composite\'s guarantee', () => {
    const reconcilable = { ...adapter('alternate-mail', () => refused), effectClass: 'EXTERNAL_RECONCILABLE' as const, reconcile: async () => ({ kind: 'ABSENT' as const }) };
    expect(() => fulfillingCounterparties([{ seat: PRIMARY, adapter: adapter('primary-mail', () => refused) }, { seat: ALTERNATE, adapter: reconcilable }])).toThrow(/effect class/);
  });
});

describe('the live path registers alternates', () => {
  it('a configured alternate is registered behind the chosen provider, under the one namespace adapter', () => {
    expect(messagingAlternates(ENV)).toEqual(['resend']);
    const registration = registerCommercialProviders(ENV);
    expect(registration).toMatchObject({ messaging: 'instantly', alternates: { messaging: ['resend'], billing: [] } });
    const contact = listAdapters().filter((one) => one.namespace === CONTACT_BUYER_NAMESPACE.name);
    expect(contact).toHaveLength(1);
    expect((contact[0] as unknown as Record<symbol, unknown>)[RECORDS_COUNTERPARTY]).toBe('provider:messaging:instantly');
  });

  it('an alternate that is unimplemented, the chosen one, or not configured is not registered', () => {
    expect(messagingAlternates({ ...ENV, BRAIN_MESSAGING_ALTERNATES: 'pigeon, instantly' })).toEqual([]);
    expect(messagingAlternates({ BRAIN_MESSAGING_PROVIDER: 'instantly', INSTANTLY_API_KEY: INSTANTLY_KEY, BRAIN_MESSAGING_ALTERNATES: 'resend' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(messagingAlternates({ ...ENV, BRAIN_MESSAGING_PROVIDER: '' })).toEqual([]);
  });

  it('the provider reading carries the alternate as a candidate, and reports no breach', async () => {
    registerCommercialProviders(ENV);
    const readings = await readProviderTransactions({ env: ENV, at: AT });
    const messaging = readings.find((r) => r.area === 'MESSAGING')!;
    const ids = messaging.reading.compared.map((r) => r.counterpartyId).sort();
    expect(ids).toEqual(['provider:messaging:instantly', 'provider:messaging:resend']);
    expect(messaging.reading.alternative).not.toBeNull();
    expect(counterpartyBreaches(readings)).toEqual([]);
  });
});
