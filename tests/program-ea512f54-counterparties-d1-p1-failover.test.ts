/**
 * CP-31 repair: after a provider's refusal the wrapper offered the transfer with candidateIds
 * [the same counterparty], and each deployment registered exactly one provider per area, so no
 * alternative fulfiller existed in the live path. A deployment now names alternatives
 * (`BRAIN_MESSAGING_ALTERNATES`); they are seated behind the chosen provider in the one adapter the
 * engine uses (`failoverCounterparty`), and a definite, retryable refusal moves the commitment to
 * the best of them through the model's own recorders — never to the refused provider, never
 * without the alternative's reported capacity and the live grant, and never double-committed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { clearAdapters, listAdapters, type EffectAdapter, type EffectRequest, type SendOutcome } from '../server/services/effects/adapter.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { messagingAlternates } from '../server/services/cash/providers/config.ts';
import {
  ALTERNATIVE_COUNTERPARTIES,
  RECORDS_COUNTERPARTY,
  failoverCounterparty,
  providerCounterpartyId,
  recordProviderAttempt,
  type ProviderSeat,
  type SeatedAdapter,
} from '../server/services/cash/providers/counterpartyRecord.ts';
import { counterpartyBreaches, readProviderTransactions } from '../server/services/cash/providers/counterparty.ts';
import { doubleCommitted, holdsFrom, recordedReservationEvents } from '../server/services/labor/counterparties/reservations.ts';

let day = 0;
let AT = '';

let primaryCapacity: number | null = 5;
let alternativeCapacity: number | null = 5;
const primarySeat: ProviderSeat = {
  area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER',
  capacityPerDay: async () => primaryCapacity,
};
const alternativeSeat: ProviderSeat = {
  area: 'MESSAGING', provider: 'resend', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER',
  capacityPerDay: async () => alternativeCapacity,
};
const PRIMARY = providerCounterpartyId(primarySeat);
const ALTERNATIVE = providerCounterpartyId(alternativeSeat);

/** A fake provider adapter: every call is counted, and it answers what the test says. */
function fakeAdapter(name: string, answerWith: () => SendOutcome, validate: (p: unknown) => Record<string, unknown> = (p) => p as Record<string, unknown>) {
  const calls: EffectRequest[] = [];
  const adapter: EffectAdapter = {
    name,
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: 'cash.contact_buyer.test',
    validate,
    fingerprintInputs: (payload) => payload,
    async send(request) {
      calls.push(request);
      return answerWith();
    },
  };
  return { adapter, calls };
}

async function business(granted = true): Promise<{ projectId: string; opportunityId: string }> {
  const projectId = (await freshProject()).project.id;
  const userId = (await createUser({ email: `cp31f-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  if (granted) {
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    });
  }
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'A paid intake repair',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  return { projectId, opportunityId: captured.value.id };
}

const request = (opportunityId: string): EffectRequest => ({
  providerKey: null,
  businessId: `cash:${opportunityId}:CONTACT_BUYER:1`,
  payload: { to: 'buyer@example.test' },
});
const refusedRetryable: SendOutcome = { kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true, detail: 'nothing was sent' };
const confirmed = (ref: string): SendOutcome => ({ kind: 'CONFIRMED', receiptRef: ref });

async function holds() {
  return holdsFrom(await recordedReservationEvents([PRIMARY, ALTERNATIVE]));
}

beforeEach(() => {
  clearAdapters();
  primaryCapacity = 5;
  alternativeCapacity = 5;
  day += 1;
  AT = new Date(Date.UTC(2032, 2, day, 12)).toISOString();
});
afterEach(() => clearAdapters());

describe('a refused commitment moves to an alternative, never back to the refused provider', () => {
  it('transfers the failed hold to the named alternative, sends through it, and records its receipt', async () => {
    const { opportunityId } = await business();
    const alternative = fakeAdapter('resend.test', () => confirmed('alt-1'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(1);
    expect(outcome.kind).toBe('CONFIRMED');
    expect(outcome.kind === 'CONFIRMED' && outcome.receiptMeta?.fulfilledBy).toBe('resend');
    expect(recorded.outcome).toBe('FAILED');
    expect(recorded.transferred).toBe(true);
    expect(recorded.fulfilledBy).toBe(ALTERNATIVE);
    expect(recorded.transfers).toHaveLength(1);
    expect(recorded.transfers[0]!.from).toBe(PRIMARY);
    expect(recorded.transfers[0]!.to).toBe(ALTERNATIVE);
    expect(recorded.transfers[0]!.decision).toMatch(/^TRANSFER/);
    const all = await holds();
    const mine = all.filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(mine.find((h) => h.counterpartyId === PRIMARY)!.state).toBe('RELEASED');
    expect(mine.find((h) => h.counterpartyId === ALTERNATIVE)!.state).toBe('PERFORMED');
    expect(doubleCommitted(await recordedReservationEvents([PRIMARY, ALTERNATIVE]))).toEqual([]);
  });

  it('never offers the refused provider as its own alternative', async () => {
    const { opportunityId } = await business();
    const same = fakeAdapter('instantly.again', () => confirmed('same'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: primarySeat, adapter: same.adapter }],
    );
    expect(same.calls).toHaveLength(0);
    expect(outcome).toEqual(refusedRetryable);
    expect(recorded.transferred).toBe(false);
    expect(recorded.transfers).toEqual([]);
  });

  it('reserves the alternative when the refused provider held nothing (capacity it did not report)', async () => {
    const { opportunityId } = await business();
    primaryCapacity = null;
    const alternative = fakeAdapter('resend.test', () => confirmed('alt-2'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(recorded.hold?.ok).toBe(false);
    expect(alternative.calls).toHaveLength(1);
    expect(outcome.kind).toBe('CONFIRMED');
    expect(recorded.transfers[0]!.decision).toMatch(/^RESERVED/);
    const mine = (await holds()).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(mine.map((h) => [h.counterpartyId, h.state])).toEqual([[ALTERNATIVE, 'PERFORMED']]);
  });
});

describe('a hold refused on the primary moves the commitment without calling the primary', () => {
  it('capacity already held on the primary: the primary is never called and the alternative takes it', async () => {
    primaryCapacity = 1;
    const { opportunityId } = await business();
    // Another commitment holds the primary's only unit for the day (its outcome is unknown, so it keeps the hold).
    await recordProviderAttempt(primarySeat, { ...request(opportunityId), businessId: `cash:${opportunityId}:CONTACT_BUYER:9` }, async () => ({ kind: 'UNCERTAIN', reason: 'no answer' }), () => AT);
    let primaryCalls = 0;
    const alternative = fakeAdapter('resend.test', () => confirmed('alt-gated'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => { primaryCalls += 1; return confirmed('never'); }, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(primaryCalls).toBe(0);
    expect(recorded.gated).toBe('CAPACITY');
    expect(alternative.calls).toHaveLength(1);
    expect(outcome.kind).toBe('CONFIRMED');
    expect(recorded.fulfilledBy).toBe(ALTERNATIVE);
    expect(recorded.transfers[0]!.to).toBe(ALTERNATIVE);
    const mine = (await holds()).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(mine.map((h) => [h.counterpartyId, h.state])).toEqual([[ALTERNATIVE, 'PERFORMED']]);
    expect(doubleCommitted(await recordedReservationEvents([PRIMARY, ALTERNATIVE]))).toEqual([]);
  });

  it('no live grant: neither provider is called and nothing moves', async () => {
    const { opportunityId } = await business(false);
    let primaryCalls = 0;
    const alternative = fakeAdapter('resend.test', () => confirmed('never'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => { primaryCalls += 1; return confirmed('never'); }, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(primaryCalls).toBe(0);
    expect(alternative.calls).toHaveLength(0);
    expect(recorded.gated).toBe('MISSING_AUTHORITY');
    expect(outcome).toMatchObject({ kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false });
    expect(recorded.transferred).toBe(false);
  });
});

describe('the move keeps every guarantee', () => {
  it('an uncertain outcome is not a refusal: nothing moves and the alternative is never called', async () => {
    const { opportunityId } = await business();
    const alternative = fakeAdapter('resend.test', () => confirmed('never'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => ({ kind: 'UNCERTAIN', reason: 'timed out' }), () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(0);
    expect(outcome.kind).toBe('UNCERTAIN');
    expect(recorded.outcome).toBe('UNKNOWN');
    expect(recorded.transferred).toBe(false);
  });

  it('a refusal the provider does not mark retryable could have left something behind: nothing moves', async () => {
    const { opportunityId } = await business();
    const alternative = fakeAdapter('resend.test', () => confirmed('never'));
    const refused: SendOutcome = { kind: 'REJECTED', category: 'PROVIDER_REJECTED', retryable: false };
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refused, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(0);
    expect(outcome).toEqual(refused);
    expect(recorded.outcome).toBe('FAILED');
    expect(recorded.transferred).toBe(false);
  });

  it('an alternative that reports no capacity is not held and not sent through (§39)', async () => {
    const { opportunityId } = await business();
    alternativeCapacity = null;
    const alternative = fakeAdapter('resend.test', () => confirmed('never'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(0);
    expect(outcome).toEqual(refusedRetryable);
    expect(recorded.transferred).toBe(false);
    expect(recorded.transfers[0]!.to).toBe(ALTERNATIVE);
    expect(recorded.transfers[0]!.decision).toMatch(/^REFUSED/);
  });

  it('without the live grant the alternative is not held and not sent through', async () => {
    const { opportunityId } = await business(false);
    const alternative = fakeAdapter('resend.test', () => confirmed('never'));
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(0);
    // Without the grant the primary's own hold is refused first, so the send is gated before any
    // provider is called (0463667) and the refusal is the definite, non-retryable authority one.
    expect(recorded.gated).toBe('MISSING_AUTHORITY');
    expect(outcome).toMatchObject({ kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false });
    expect(recorded.transferred).toBe(false);
  });

  it('an alternative whose own validation refuses the payload is not offered', async () => {
    const { opportunityId } = await business();
    const picky = fakeAdapter('resend.test', () => confirmed('never'), () => {
      throw new Error('not a message this provider can send');
    });
    const { recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: picky.adapter }],
    );
    expect(picky.calls).toHaveLength(0);
    expect(recorded.transfers).toEqual([]);
  });

  it('an alternative that also refuses leaves the commitment failed and undeliverable, with no live hold', async () => {
    const { opportunityId } = await business();
    const alternative = fakeAdapter('resend.test', () => refusedRetryable);
    const { outcome, recorded } = await recordProviderAttempt(
      primarySeat, request(opportunityId), async () => refusedRetryable, () => AT, [{ seat: alternativeSeat, adapter: alternative.adapter }],
    );
    expect(alternative.calls).toHaveLength(1);
    expect(outcome.kind).toBe('REJECTED');
    const mine = (await holds()).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    expect(mine.some((h) => h.state === 'HELD')).toBe(false);
    expect(mine.find((h) => h.counterpartyId === ALTERNATIVE)!.state).toBe('FAILED');
    expect(recorded.fulfilledBy).toBe(ALTERNATIVE);
  });
});

describe('the live path seats the alternatives the deployment named', () => {
  const ENV = {
    BRAIN_MESSAGING_PROVIDER: 'instantly',
    INSTANTLY_API_KEY: 'x'.repeat(32),
    BRAIN_MESSAGING_ALTERNATES: 'resend, instantly, carrier-pigeon',
    RESEND_API_KEY: 're_test_placeholder',
    BRAIN_MESSAGING_FROM: 'Brain <brain@example.test>',
  } as NodeJS.ProcessEnv;

  it('names only implemented, configured providers other than the chosen one', () => {
    const reading = messagingAlternates(ENV);
    expect(reading.providers).toEqual(['resend']);
    expect(reading.problems.join(' ')).toMatch(/carrier-pigeon is not implemented/);
    expect(messagingAlternates({ ...ENV, RESEND_API_KEY: '' }).providers).toEqual([]);
  });

  it('registers one adapter for the namespace, recording the chosen provider with the alternative behind it', () => {
    const registered = registerCommercialProviders(ENV);
    expect(registered.messaging).toBe('instantly');
    expect(registered.messagingAlternates).toEqual(['resend']);
    const messaging = listAdapters().filter((a) => a.namespace === listAdapters()[0]!.namespace);
    expect(messaging).toHaveLength(1);
    const tagged = messaging[0] as unknown as Record<symbol, unknown>;
    expect(tagged[RECORDS_COUNTERPARTY]).toBe(PRIMARY);
    expect(tagged[ALTERNATIVE_COUNTERPARTIES]).toEqual([ALTERNATIVE]);
  });

  it('seats no alternative a deployment did not name', () => {
    const registered = registerCommercialProviders({ ...ENV, BRAIN_MESSAGING_ALTERNATES: '' });
    expect(registered.messagingAlternates).toBeUndefined();
    const adapter = listAdapters().find((a) => (a as unknown as Record<symbol, unknown>)[RECORDS_COUNTERPARTY] === PRIMARY)!;
    expect((adapter as unknown as Record<symbol, unknown>)[ALTERNATIVE_COUNTERPARTIES]).toEqual([]);
  });

  it('the failover adapter sends through the alternative after the primary refuses', async () => {
    const { opportunityId } = await business();
    const primary = fakeAdapter('instantly.test', () => refusedRetryable);
    const alternative = fakeAdapter('resend.test', () => confirmed('alt-live'));
    const seated: SeatedAdapter[] = [{ seat: alternativeSeat, adapter: alternative.adapter }];
    const adapter = failoverCounterparty({ seat: primarySeat, adapter: primary.adapter }, seated);
    const outcome = await adapter.send(request(opportunityId));
    expect(primary.calls).toHaveLength(1);
    expect(alternative.calls).toHaveLength(1);
    expect(outcome.kind).toBe('CONFIRMED');
  });

  it('the provider reading names the alternative as a candidate and stays free of breaches', async () => {
    const readings = await readProviderTransactions({ env: ENV, at: AT });
    const messaging = readings.find((r) => r.area === 'MESSAGING')!;
    expect(messaging.alternates).toEqual([ALTERNATIVE]);
    expect(messaging.reading.compared.map((c) => c.counterpartyId).sort()).toEqual([PRIMARY, ALTERNATIVE].sort());
    expect(messaging.reading.alternative).not.toBeNull();
    expect(counterpartyBreaches(readings)).toEqual([]);
  });
});
