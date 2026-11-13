/**
 * CP-31 repair (repair-transfer-only-to-self): after a provider refused a commitment the wrapper
 * offered the transfer with candidateIds [the same counterparty], and boot registered exactly one
 * provider per area, so no alternative fulfiller existed in the live path. Boot now registers the
 * alternates a deployment names (`BRAIN_MESSAGING_ALTERNATES`) behind the primary, the wrapper
 * offers the transfer to every provider seated in the area, and the provider reading compares them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { CONTACT_BUYER_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, listAdapters, type EffectRequest, type SendOutcome } from '../server/services/effects/adapter.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { alternateProviders } from '../server/services/cash/providers/config.ts';
import {
  RECORDS_COUNTERPARTY,
  providerCounterpartyId,
  recordProviderAttempt,
  seatedCounterparties,
  type ProviderSeat,
} from '../server/services/cash/providers/counterpartyRecord.ts';
import { counterpartyBreaches, readProviderTransactions } from '../server/services/cash/providers/counterparty.ts';
import { recordCounterpartyFacts, type Fact } from '../server/services/labor/counterparties/ladder.ts';
import { doubleCommitted, holdsFrom, recordedReservationEvents } from '../server/services/labor/counterparties/reservations.ts';

const INSTANTLY_KEY = 'instantly_test_key_never_stored_000001';
const PRIMARY_ONLY = { BRAIN_MESSAGING_PROVIDER: 'instantly', INSTANTLY_API_KEY: INSTANTLY_KEY } as NodeJS.ProcessEnv;
const WITH_ALTERNATE = {
  ...PRIMARY_ONLY,
  BRAIN_MESSAGING_ALTERNATES: 'resend, instantly, resend',
  RESEND_API_KEY: 're_test_key_never_stored_0001',
  BRAIN_MESSAGING_FROM: 'Brain <brain@example.test>',
} as NodeJS.ProcessEnv;

const instantly: ProviderSeat = {
  area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER', capacityPerDay: async () => 5,
};
const INSTANTLY = providerCounterpartyId(instantly);
const RESEND = providerCounterpartyId({ area: 'MESSAGING', provider: 'resend' });

let day = 0;
let AT = '';
beforeEach(() => {
  clearAdapters();
  day += 1;
  AT = new Date(Date.UTC(2032, 0, day, 12)).toISOString();
});
afterEach(() => clearAdapters());

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

/** The alternate's own record, as a person or an earlier operation would have established it: quoted, with capacity. */
async function quotedAlternate(projectId: string): Promise<void> {
  const evidence = 'test: the alternate provider\'s published plan and a confirmed test send';
  const facts: Fact[] = [
    { dimension: 'listing', status: 'VERIFIED', evidence, value: 'resend' },
    { dimension: 'willingness', status: 'VERIFIED', evidence },
    { dimension: 'availability', status: 'VERIFIED', evidence },
    { dimension: 'eligibility', status: 'VERIFIED', evidence, value: 'SEND_A_MESSAGE' },
    { dimension: 'scope', status: 'VERIFIED', evidence, value: 'SEND_A_MESSAGE' },
    { dimension: 'qualifications', status: 'NOT_APPLICABLE', evidence: 'a hosted API holds no licence' },
    { dimension: 'geography', status: 'NOT_APPLICABLE', evidence: 'a hosted software service has no service area' },
    { dimension: 'price', status: 'VERIFIED', evidence, value: 0 },
    { dimension: 'paymentTerms', status: 'VERIFIED', evidence, value: 'monthly' },
    { dimension: 'leadTime', status: 'VERIFIED', evidence, value: 0 },
    { dimension: 'availableCapacity', status: 'VERIFIED', evidence, value: 10 },
  ];
  await recordCounterpartyFacts({ projectId, counterparty: { id: RESEND, kind: 'software service', geography: null, humanOperator: false }, facts, actorRef: 'BRAIN' });
}

const request = (opportunityId: string): EffectRequest => ({ providerKey: null, businessId: `cash:${opportunityId}:CONTACT_BUYER:1`, payload: {} });
const refused = async (): Promise<SendOutcome> => ({ kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true });

describe('boot seats the alternates a deployment named, behind the primary', () => {
  it('registers a configured alternate after the primary, both recorded as counterparties', () => {
    registerCommercialProviders(WITH_ALTERNATE);
    const messaging = listAdapters().filter((a) => a.namespace === CONTACT_BUYER_NAMESPACE.name);
    // The primary first: the effect path serves the namespace with the first adapter registered.
    expect(messaging.map((a) => (a as unknown as Record<symbol, unknown>)[RECORDS_COUNTERPARTY])).toEqual([INSTANTLY, RESEND]);
    expect(seatedCounterparties(instantly)).toEqual([INSTANTLY, RESEND]);
    expect(seatedCounterparties({ area: 'MESSAGING', provider: 'resend' })).toEqual([RESEND, INSTANTLY]);
    // The primary named again and repeats are dropped.
    expect(alternateProviders('MESSAGING', WITH_ALTERNATE).map((r) => r.provider)).toEqual(['resend']);
  });

  it('never registers an alternate whose settings are incomplete, nor one without a primary', () => {
    registerCommercialProviders({ ...PRIMARY_ONLY, BRAIN_MESSAGING_ALTERNATES: 'resend' } as NodeJS.ProcessEnv);
    expect(seatedCounterparties(instantly)).toEqual([INSTANTLY]);
    clearAdapters();
    const { BRAIN_MESSAGING_PROVIDER: _primary, ...noPrimary } = WITH_ALTERNATE;
    expect(registerCommercialProviders(noPrimary as NodeJS.ProcessEnv).messaging).toBeNull();
    expect(listAdapters().filter((a) => a.namespace === CONTACT_BUYER_NAMESPACE.name)).toHaveLength(0);
  });
});

describe('a refusal is transferred to an alternative, never back to the provider that refused', () => {
  it('moves the commitment to the quoted alternate: the refusal released, one hold, no double commitment', async () => {
    registerCommercialProviders(WITH_ALTERNATE);
    const { projectId, opportunityId } = await business();
    await quotedAlternate(projectId);
    const { outcome, recorded } = await recordProviderAttempt(instantly, request(opportunityId), refused, () => AT);
    expect(outcome.kind).toBe('REJECTED'); // the provider's answer is returned untouched
    expect(recorded.outcome).toBe('FAILED');
    expect(recorded.transferred).toBe(true);
    expect(recorded.transferredTo).toBe(RESEND);
    const events = await recordedReservationEvents([INSTANTLY, RESEND]);
    const holds = holdsFrom(events).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(holds.find((h) => h.counterpartyId === INSTANTLY)?.state).toBe('RELEASED');
    expect(holds.find((h) => h.counterpartyId === RESEND)?.state).toBe('HELD');
    expect(holds.filter((h) => h.state === 'HELD')).toHaveLength(1);
    expect(doubleCommitted(events)).toEqual([]);
  });

  it('with no alternate seated, nothing moves and the refusal stays FAILED', async () => {
    registerCommercialProviders(PRIMARY_ONLY);
    const { projectId, opportunityId } = await business();
    await quotedAlternate(projectId); // on record, but not seated by this deployment: not a candidate
    const { recorded } = await recordProviderAttempt(instantly, request(opportunityId), refused, () => AT);
    expect(recorded.transferred).toBe(false);
    const holds = holdsFrom(await recordedReservationEvents([INSTANTLY, RESEND])).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(holds.map((h) => [h.counterpartyId, h.state])).toEqual([[INSTANTLY, 'FAILED']]);
  });
});

describe('the provider reading compares the primary and its alternates', () => {
  it('names the alternate as a candidate, judges each on its own record, and finds no breach', async () => {
    registerCommercialProviders(WITH_ALTERNATE);
    const { projectId } = await business();
    await quotedAlternate(projectId);
    const readings = await readProviderTransactions({ env: WITH_ALTERNATE, at: AT });
    const messaging = readings.find((r) => r.area === 'MESSAGING')!;
    expect(messaging.reading.compared.map((r) => r.counterpartyId).sort()).toEqual([INSTANTLY, RESEND].sort());
    expect(messaging.evidencedIds).toEqual([RESEND]);
    expect([messaging.reading.primary?.counterpartyId, messaging.reading.alternative?.counterpartyId].sort()).toEqual([INSTANTLY, RESEND].sort());
    expect(counterpartyBreaches(readings)).toEqual([]);
  });

  it('flags an alternate read past LISTING without its own record', () => {
    const reading = { primary: null, alternative: { counterpartyId: RESEND, kind: 'software service', stage: 'QUOTE' } } as never;
    const breaches = counterpartyBreaches([{
      area: 'MESSAGING', capability: 'SEND_A_MESSAGE', evidenced: false, evidencedIds: [],
      reading: { ...(reading as object), deliverability: { deliverable: false, stage: null }, reserve: { permitted: false }, authority: { held: false }, doubleCommitted: [] } as never,
    }]);
    expect(breaches).toEqual([`MESSAGING: alternative ${RESEND} read past LISTING from configuration alone`]);
  });
});
