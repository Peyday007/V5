/**
 * CP-31 repair: the counterparty model had no producer in the running Brain — no route, job,
 * tick or effect wrote a COUNTERPARTY_FACT or COUNTERPARTY_RESERVATION row. Every commercial
 * provider registered at boot is now wrapped (`counterpartyRecord.ts`), so each real send holds
 * the provider's reported capacity under the project's live grant, records the provider's answer
 * as the hold's outcome, and records the facts a receipt establishes; the probe reads those rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { cashEventsOfKind } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { clearAdapters, listAdapters, type EffectRequest, type SendOutcome } from '../server/services/effects/adapter.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import {
  RECORDS_COUNTERPARTY,
  providerCounterpartyId,
  recordProviderAttempt,
  type ProviderSeat,
} from '../server/services/cash/providers/counterpartyRecord.ts';
import { counterpartyBreaches, readProviderTransactions } from '../server/services/cash/providers/counterparty.ts';
import { FACT_EVENT_KIND, recordedCounterparty, factFor } from '../server/services/labor/counterparties/ladder.ts';
import { RESERVATION_EVENT_KIND, holdsFrom, recordedReservationEvents, counterpartyLedger } from '../server/services/labor/counterparties/reservations.ts';

const ENV = { BRAIN_MESSAGING_PROVIDER: 'instantly' } as NodeJS.ProcessEnv;
// The provider's ledger is shared by every business, as production's is, so each test sends on a
// day of its own: a performed send uses up its day's capacity for everyone after it.
let day = 0;
let AT = '';

let capacity: number | null = 5;
const seat: ProviderSeat = {
  area: 'MESSAGING', provider: 'instantly', capability: 'SEND_A_MESSAGE', action: 'CONTACT_BUYER',
  capacityPerDay: async () => capacity,
};
const ID = providerCounterpartyId(seat);

/** A business on a fresh database, or — `another` — a second business beside the first on the same one. */
async function business(granted = true, another = false): Promise<{ projectId: string; opportunityId: string }> {
  const projectId = another
    ? (await createProject({ name: `Second business ${Math.random().toString(36).slice(2, 8)}` })).id
    : (await freshProject()).project.id;
  const userId = (await createUser({ email: `cp31p-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
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

const request = (opportunityId: string, occurrence = '1', retry = 0): EffectRequest => ({
  providerKey: null,
  businessId: `cash:${opportunityId}:CONTACT_BUYER:${occurrence}${retry > 0 ? `:${retry}` : ''}`,
  payload: {},
});
const answer = (outcome: SendOutcome) => async () => outcome;
const confirmed = (ref: string): SendOutcome => ({ kind: 'CONFIRMED', receiptRef: ref });

beforeEach(() => {
  clearAdapters();
  capacity = 5;
  day += 1;
  AT = new Date(Date.UTC(2031, 0, day, 12)).toISOString();
});
afterEach(() => clearAdapters());

describe('a real send writes the counterparty rows', () => {
  it('holds capacity under the live grant, records PERFORMED on a receipt, and the facts the receipt establishes', async () => {
    const { opportunityId } = await business();
    const { outcome, recorded } = await recordProviderAttempt(seat, request(opportunityId), answer(confirmed('lead-1')), () => AT);
    expect(outcome).toEqual(confirmed('lead-1'));
    expect(recorded.hold).toMatchObject({ ok: true, duplicate: false });
    expect(recorded.outcome).toBe('PERFORMED');

    const rows = await cashEventsOfKind(counterpartyLedger(ID), RESERVATION_EVENT_KIND);
    expect(rows.map((r) => (r.detail.event as { kind: string }).kind)).toEqual(['RESERVED', 'PERFORMED']);
    const [hold] = holdsFrom(await recordedReservationEvents([ID]));
    expect(hold).toMatchObject({ state: 'PERFORMED', commitmentId: `cash:${opportunityId}:CONTACT_BUYER:1` });
    expect((rows[0]!.detail.event as { authorityHeld: string[] }).authorityHeld).toEqual(['CONTACT_BUYER']);

    const party = (await recordedCounterparty(ID))!;
    for (const dimension of ['listing', 'willingness', 'availability', 'scope']) {
      expect(factFor(party.facts, dimension)).toMatchObject({ status: 'VERIFIED', evidence: expect.stringContaining('lead-1') });
    }
    expect(factFor(party.facts, 'availableCapacity')).toMatchObject({ status: 'VERIFIED', value: 5 });

    // A second receipt changes no fact, so no fact row is written again.
    const before = (await cashEventsOfKind(counterpartyLedger(ID), FACT_EVENT_KIND)).length;
    await recordProviderAttempt(seat, request(opportunityId, '2'), answer(confirmed('lead-2')), () => AT);
    expect((await cashEventsOfKind(counterpartyLedger(ID), FACT_EVENT_KIND)).length).toBe(before);
  });

  it('never double-books the shared capacity across separate businesses', async () => {
    capacity = 1;
    const a = await business();
    const b = await business(true, true);
    const first = await recordProviderAttempt(seat, request(a.opportunityId), answer({ kind: 'UNCERTAIN', reason: 'no answer' }), () => AT);
    expect(first.recorded.hold, JSON.stringify(first.recorded)).toMatchObject({ ok: true });
    expect(first.recorded.outcome).toBe('UNKNOWN'); // an unknown outcome keeps its hold
    let calls = 0;
    const second = await recordProviderAttempt(seat, request(b.opportunityId), async () => { calls += 1; return confirmed('lead-b'); }, () => AT);
    expect(second.recorded.hold).toMatchObject({ ok: false, reason: 'CAPACITY', remaining: 0 });
    // The refused hold gates the send: the provider is never called, so the last unit is not booked twice.
    expect(calls).toBe(0);
    expect(second.recorded.gated).toBe('CAPACITY');
    expect(second.outcome).toMatchObject({ kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true });
    expect(second.recorded.outcome).toBeNull();
    const live = holdsFrom(await recordedReservationEvents([ID])).filter((h) => h.state === 'HELD');
    expect(live).toHaveLength(1);
    expect(live[0]!.businessId).toBe(a.projectId);
  });

  it('one unit of shared capacity is one provider send, whichever business asks second', async () => {
    capacity = 1;
    const a = await business();
    const b = await business(true, true);
    let sends = 0;
    // The path every wrapped adapter's send takes, with a counting provider in place of the network.
    // The first send's outcome is unknown, so its hold keeps the unit (invariant 26).
    const provider = async (): Promise<SendOutcome> => { sends += 1; return { kind: 'UNCERTAIN', reason: 'no answer' }; };
    const first = await recordProviderAttempt(seat, request(a.opportunityId), provider, () => AT);
    const second = await recordProviderAttempt(seat, request(b.opportunityId), provider, () => AT);
    const third = await recordProviderAttempt(seat, request(b.opportunityId, '2'), provider, () => AT);
    expect(first.outcome.kind).toBe('UNCERTAIN');
    expect(second.outcome.kind).toBe('REJECTED');
    expect(third.outcome.kind).toBe('REJECTED');
    expect(sends).toBe(1); // one unit of capacity, one send — across both businesses
    const mine = holdsFrom(await recordedReservationEvents([ID])).filter((h) => h.businessId === a.projectId || h.businessId === b.projectId);
    expect(mine.map((h) => [h.businessId, h.state])).toEqual([[a.projectId, 'HELD']]);
  });

  it('records a refusal as FAILED, establishes no willingness, and offers it to the model\'s transfer', async () => {
    const { opportunityId } = await business();
    const { recorded } = await recordProviderAttempt(seat, request(opportunityId), answer({ kind: 'REJECTED', category: 'DEPENDENCY_UNAVAILABLE', retryable: true }), () => AT);
    expect(recorded.outcome).toBe('FAILED');
    expect(recorded.transferred).toBe(false); // no alternative with evidenced capacity: nothing moves
    expect(holdsFrom(await recordedReservationEvents([ID]))[0]!.state).toBe('FAILED');
    expect(await recordedCounterparty(ID)).toBeNull();
  });

  it('holds nothing without the live grant, and nothing against capacity the provider did not report', async () => {
    const ungranted = await business(false);
    let calls = 0;
    const refused = await recordProviderAttempt(seat, request(ungranted.opportunityId), async () => { calls += 1; return confirmed('x'); }, () => AT);
    expect(refused.recorded.hold).toMatchObject({ ok: false, reason: 'MISSING_AUTHORITY', missing: ['CONTACT_BUYER'] });
    // Without the grant the send does not happen either: nothing commits capacity it was not authorized to.
    expect(calls).toBe(0);
    expect(refused.recorded.gated).toBe('MISSING_AUTHORITY');
    expect(refused.outcome).toMatchObject({ kind: 'REJECTED', category: 'NOT_AUTHORIZED', retryable: false });
    capacity = null;
    const granted = await business();
    const unknown = await recordProviderAttempt(seat, request(granted.opportunityId), answer(confirmed('y')), () => AT);
    expect(unknown.recorded.hold).toMatchObject({ ok: false, reason: 'CAPACITY_UNKNOWN' });
    // No reported capacity is nothing to over-book: the send is not stopped (§39 invents none to refuse against).
    expect(unknown.recorded.gated).toBeNull();
    expect(unknown.outcome).toEqual(confirmed('y'));
    expect(await recordedReservationEvents([ID])).toHaveLength(0);
  });

  it('releases an attempt a person closed when the retry is sent, so one commitment never holds twice', async () => {
    const { opportunityId } = await business();
    await recordProviderAttempt(seat, request(opportunityId, '1', 0), answer({ kind: 'UNCERTAIN', reason: 'timed out' }), () => AT);
    await recordProviderAttempt(seat, request(opportunityId, '1', 1), answer(confirmed('lead-r')), () => AT);
    const holds = holdsFrom(await recordedReservationEvents([ID])).filter((h) => h.commitmentId === `cash:${opportunityId}:CONTACT_BUYER:1`);
    // By attempt (#0, #1): rows written in one millisecond come back in either order.
    expect([...holds].sort((a, b) => (a.key < b.key ? -1 : 1)).map((h) => [h.key.slice(-2), h.state])).toEqual([['#0', 'RELEASED'], ['#1', 'PERFORMED']]);
  });
});

describe('the production wiring and its reading', () => {
  it('every provider registered at boot records its sends as a counterparty', () => {
    registerCommercialProviders(ENV);
    const adapters = listAdapters();
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      expect((adapter as unknown as Record<symbol, unknown>)[RECORDS_COUNTERPARTY]).toBe(ID);
    }
  });

  it('the provider reading consumes the recorded rows: evidenced past LISTING, and no breach', async () => {
    registerCommercialProviders(ENV);
    const { opportunityId } = await business();
    await recordProviderAttempt(seat, request(opportunityId), answer(confirmed('lead-9')), () => AT);
    const readings = await readProviderTransactions({ env: ENV, at: AT });
    const messaging = readings.find((r) => r.area === 'MESSAGING')!;
    expect(messaging.evidenced).toBe(true);
    expect(messaging.reading.primary?.counterpartyId).toBe(ID);
    expect(messaging.reading.facts[0]!.verified).toEqual(expect.arrayContaining(['willingness', 'availability']));
    expect(counterpartyBreaches(readings)).toEqual([]);
  });
});
