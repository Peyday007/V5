/** CP-31: the evidence ladder and the choice of a primary and an alternative fulfiller. */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import { clearPaymentReader } from '../server/services/cash/providers/payments.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import { counterpartyBreaches, PROVIDER_COUNTERPARTY_PROBE, readProviderTransactions } from '../server/services/cash/providers/counterparty.ts';
import { readLadder, type Counterparty, type Fact } from '../server/services/labor/counterparties/ladder.ts';
import { compareFulfillers, type Commitment } from '../server/services/labor/counterparties/compare.ts';

const v = (dimension: string, value?: number | string, evidence = 'src'): Fact => ({ dimension, status: 'VERIFIED', evidence, value: value ?? null });
const p = (dimension: string, value?: number): Fact => ({ dimension, status: 'PENDING', value: value ?? null });

const listed = (id: string, extra: Fact[] = []): Counterparty => ({ id, kind: 'crew', facts: [v('listing'), ...extra] });
const willing = [v('willingness'), v('availability')];
const capable = [v('eligibility'), v('scope'), v('qualifications'), v('geography')];
const quoted = (price: number, lead: number): Fact[] => [v('price', price), v('paymentTerms', 'net 30'), v('leadTime', lead)];

describe('the ladder', () => {
  it('reads a directory listing as LISTING and nothing later', () => {
    const r = readLadder(listed('a'));
    expect(r.stage).toBe('LISTING');
    expect(r.stages.find((s) => s.stage === 'WILLINGNESS')?.missing.map((m) => m.state)).toEqual(['ABSENT', 'ABSENT']);
  });

  it('reads nothing for a counterparty that is not even listed', () => {
    expect(readLadder({ id: 'x', kind: 'k', facts: [] }).stage).toBeNull();
  });

  it('climbs only on verified facts, in order', () => {
    expect(readLadder(listed('a', [...willing, ...capable, ...quoted(10, 2)])).stage).toBe('QUOTE');
    const skipped = readLadder({ id: 'b', kind: 'k', facts: [v('listing'), ...capable, ...quoted(10, 2)] });
    expect(skipped.stage).toBe('LISTING');
    expect(skipped.stages.find((s) => s.stage === 'CAPABILITY')?.inconsistent).toBe(true);
  });

  it('does not accept a verified claim with no evidence, nor an unexplained not-applicable', () => {
    const r = readLadder({ id: 'c', kind: 'k', facts: [v('listing'), { dimension: 'willingness', status: 'VERIFIED' }, v('availability')] });
    expect(r.stage).toBe('LISTING');
    expect(r.stages[1]!.missing).toEqual([{ dimension: 'willingness', state: 'PENDING' }]);
    const na = readLadder({ id: 'd', kind: 'k', facts: [v('listing'), v('willingness'), v('availability'), { dimension: 'geography', status: 'NOT_APPLICABLE', evidence: 'remote service' }, v('eligibility'), v('scope'), v('qualifications')] });
    expect(na.stage).toBe('CAPABILITY');
  });

  it('reaches PERFORMED only through contract, reservation and completion', () => {
    const all = [...willing, ...capable, ...quoted(5, 1), v('reservedCapacity', 3), v('contract'), v('completion')];
    expect(readLadder(listed('e', all)).stage).toBe('PERFORMED');
  });

  it('lets a later fact replace an earlier one on the same dimension', () => {
    const r = readLadder(listed('f', [...willing, { dimension: 'willingness', status: 'UNKNOWN' }]));
    expect(r.stage).toBe('LISTING');
  });

  it('takes any counterparty kind', () => {
    for (const kind of ['carrier', 'licensed intermediary', 'software service', 'something nobody listed']) {
      expect(readLadder({ id: kind, kind, facts: [v('listing')] }).kind).toBe(kind);
    }
  });
});

describe('choosing a primary and an alternative', () => {
  const need: Commitment = { id: 'job', capacityUnits: 2 };
  const base = [...willing, ...capable];

  it('picks a primary and an alternative and shows each figure with its status', () => {
    const a = listed('a', [...base, ...quoted(100, 3), v('availableCapacity', 5)]);
    const b = listed('b', [...base, ...quoted(90, 5), v('availableCapacity', 4)]);
    const c = listed('c', [...base, ...quoted(80, 2), v('availableCapacity', 1)]);
    const r = compareFulfillers(need, [a, b, c]);
    expect(r.primary?.counterpartyId).toBe('b');
    expect(r.alternative?.counterpartyId).toBe('a');
    expect(r.ineligible.map((x) => x.counterpartyId)).toEqual(['c']);
    expect(r.ineligible[0]!.reasons[0]).toMatch(/below the 2/);
    expect(r.primary!.figures.cost).toMatchObject({ value: 90, status: 'VERIFIED' });
  });

  it('never lets a pending or unknown figure beat a verified one', () => {
    const verified = listed('z', [...base, ...quoted(100, 3), v('availableCapacity', 3)]);
    const cheapButPending = listed('a', [...base, p('price', 1), v('paymentTerms', 'x'), v('leadTime', 1), v('availableCapacity', 3)]);
    const r = compareFulfillers(need, [cheapButPending, verified]);
    expect(r.primary?.counterpartyId).toBe('z');
    const pending = r.alternative!;
    expect(pending.figures.cost).toMatchObject({ value: null, claimed: 1, status: 'PENDING' });
    expect(pending.open.join(' ')).toMatch(/price is pending/);
  });

  it('ranks by stage first: a quoted counterparty outranks a merely willing cheaper one', () => {
    const quotedOne = listed('q', [...base, ...quoted(200, 9), v('availableCapacity', 3)]);
    const willingOnly = listed('w', [...willing, v('price', 1), v('availableCapacity', 9)]);
    expect(compareFulfillers(need, [willingOnly, quotedOne]).primary?.counterpartyId).toBe('q');
  });

  it('does not exclude an unknown capacity, and says it is unknown', () => {
    const r = compareFulfillers(need, [listed('a', [...base, ...quoted(10, 1)])]);
    expect(r.primary?.eligible).toBe(true);
    expect(r.primary!.figures.capacity.status).toBe('UNKNOWN');
  });

  it('is not anchored to a location: geography is only a label, excluded only when verified outside', () => {
    const far: Counterparty = { ...listed('far', [...base, ...quoted(5, 4), v('availableCapacity', 9)]), geography: 'elsewhere' };
    const near: Counterparty = { ...listed('near', [...base, ...quoted(50, 1), v('availableCapacity', 9)]), geography: 'here' };
    const open = compareFulfillers(need, [far, near]);
    expect(open.primary?.counterpartyId).toBe('far');
    const bound = compareFulfillers({ ...need, geographies: ['here'] }, [far, near]);
    expect(bound.primary?.counterpartyId).toBe('near');
    expect(bound.ineligible[0]!.reasons[0]).toMatch(/outside/);
  });

  it('surfaces a commitment that needs a person or a role Brain cannot be', () => {
    const human: Commitment = { ...need, humanRequirement: { reason: 'ACCOUNTABILITY_LICENSING', note: 'a licensed signatory' } };
    const alone = listed('machine', [...base, ...quoted(1, 1), v('availableCapacity', 9)]);
    const withPerson: Counterparty = { ...listed('firm', [...base, ...quoted(9, 1), v('availableCapacity', 9)]), humanOperator: true };
    const r = compareFulfillers(human, [alone, withPerson]);
    expect(r.needsHumanOperator).toBe(true);
    expect(r.humanRequirement?.reason).toBe('ACCOUNTABILITY_LICENSING');
    expect(r.primary?.counterpartyId).toBe('firm');
    expect(r.ineligible[0]!.reasons[0]).toMatch(/human operator/);
  });

  it('returns no primary rather than a guess when nobody is eligible', () => {
    expect(compareFulfillers(need, []).primary).toBeNull();
  });
});

describe('CP-31 in the running Brain: boot wires the model to the live providers', () => {
  const ENV = { BRAIN_MESSAGING_PROVIDER: 'resend', RESEND_API_KEY: 're_test_value_not_printed_0001', BRAIN_MESSAGING_FROM: 'Brain <s@brain.example>' } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    clearAdapters();
    clearPaymentReader();
    await freshProject();
  });

  it('boot registers the counterparty reading where production verification runs it, under a non-release name', async () => {
    expect(PROVIDER_COUNTERPARTY_PROBE).not.toMatch(/^r\d{2}\./);
    registerCommercialProviders(ENV);
    const probe = getProbe(PROVIDER_COUNTERPARTY_PROBE);
    expect(probe).not.toBeNull();
    const answer = await probe!({});
    expect(answer.ok).toBe(true);
    expect(answer.detail).toContain('provider:messaging:resend at LISTING');
    expect(answer.detail).toContain('deliverable=false');
    expect(answer.detail).not.toContain('re_test_value_not_printed_0001');
  });

  it('reads each live provider commitment end to end: listed, not willing, not deliverable, not reservable without the grant', async () => {
    registerCommercialProviders(ENV);
    const readings = await readProviderTransactions({ env: ENV, at: '2026-11-13T12:00:00Z' });
    expect(readings.map((r) => r.area)).toEqual(['MESSAGING', 'INVOICES', 'PAYMENTS']);
    const messaging = readings.find((r) => r.area === 'MESSAGING')!.reading;
    expect(messaging.primary?.counterpartyId).toBe('provider:messaging:resend');
    expect(messaging.primary?.stage).toBe('LISTING');
    expect(messaging.facts[0]!.pending.map((m) => m.dimension)).toContain('willingness');
    expect(messaging.deliverability.deliverable).toBe(false);
    expect(messaging.reserve.permitted).toBe(false);
    expect(readings.find((r) => r.area === 'INVOICES')!.reading.primary).toBeNull();
    expect(counterpartyBreaches(readings)).toEqual([]);
  });

  it('names a breach when a reading claims more than the model allows', async () => {
    registerCommercialProviders(ENV);
    const [first] = await readProviderTransactions({ env: ENV, at: '2026-11-13T12:00:00Z' });
    const forged = { ...first!, reading: { ...first!.reading, deliverability: { ...first!.reading.deliverability, deliverable: true, stage: 'QUOTE' as const } } };
    expect(counterpartyBreaches([forged])).toEqual(['MESSAGING: reported deliverable at QUOTE, below CONTRACTED']);
  });
});
