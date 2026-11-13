/*
 * CP-31: the sourced-transaction reading has a production caller.
 *
 * The finding this answers: readOpportunityTransaction, coordinateSteps,
 * planWorkforce and withPerformance were reached only from tests, so no
 * production record could ever demonstrate S-0468/S-0469. They are now read
 * through two doors that already exist — the project's labor reading
 * (`laborView`, which `GET /api/projects/:projectId/labor` and `npm run
 * report:labor` serve) and a program probe registered at boot — and the last
 * test below fails if either door stops reaching them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { clearAdapters } from '../server/services/effects/adapter.ts';
import { clearPaymentReader } from '../server/services/cash/providers/payments.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import { getProbe } from '../server/services/factory/program/probes.ts';
import type { Fact } from '../server/services/labor/counterparties/ladder.ts';
import { recordCounterpartyFacts } from '../server/services/labor/counterparties/ladder.ts';
import { holdsFrom, recordHoldOutcome, recordedReservationEvents } from '../server/services/labor/counterparties/reservations.ts';
import { fulfillerCounterpartyId, reserveOpportunityTransaction } from '../server/services/labor/counterparties/transaction.ts';
import { OPPORTUNITY_COUNTERPARTY_PROBE, projectCounterparties } from '../server/services/labor/counterparties/operations.ts';
import { laborView } from '../server/services/labor/view.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { actionKey, beginExecution, capture, fillCard, markReady } from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { recordAgreement } from '../server/services/cash/journey/deal.ts';
import { declare, recordCost } from '../server/services/cash/journey/fulfillment.ts';

const AT = '2031-02-10T00:00:00.000Z';
const W = { windowStart: '2031-03-01T00:00:00Z', windowEnd: '2031-03-08T00:00:00Z' };

describe('CP-31: the sourced-transaction reading is reached from the running Brain', () => {
  let projectId = '';
  let userId = '';

  async function sourcedOpportunity(owner: string): Promise<string> {
    const captured = await capture({
      projectId, actorRef: userId, ownerUserId: userId, title: 'Fence repair for a landlord',
      mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: [],
    });
    if (!captured.ok) throw new Error(captured.reason);
    const id = captured.value.id;
    const filled = await fillCard({
      opportunityId: id, actorRef: userId,
      patch: {
        payer: 'The landlord, who signs', reachableChannel: 'Replied by email', buyingSignal: 'Asked for a quote',
        signalObservedAt: '2031-02-01T09:00:00.000Z', offerScope: 'Repair 20m of fence', acceptanceCondition: 'Fence repaired and inspected',
        priceCents: 80_000, deliveryMethod: 'Subcontracted crew on site', fulfillmentOwner: owner, peakFundingCents: 0,
      },
    });
    if (!filled.ok) throw new Error(filled.reason);
    for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
      await recordCardFact({ projectId, opportunityId: id, field, kind: 'PERSON', value: `The owner's answer to ${field}.`, decidedBy: userId });
    }
    expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
    const began = await beginExecution({
      opportunityId: id, actorRef: userId,
      firstAction: { action: 'CONTACT_BUYER', performedBy: 'PERSON', detail: 'Sent the scope and price.', reference: `msg-${id}`, requestKey: actionKey(id, 'CONTACT_BUYER', 'first') },
    });
    if (!began.ok) throw new Error(began.reason);
    return id;
  }

  async function contractedSupplier(opportunityId: string, supplier: string, cents: number): Promise<void> {
    const agreed = await recordAgreement({
      opportunityId, amountCents: 80_000, currency: 'USD', deliverable: 'Repair 20m of fence',
      acceptanceCondition: 'Fence repaired and inspected', evidenceKind: 'WRITTEN_ACCEPTANCE', evidenceRef: `email-${opportunityId}`, actorRef: userId,
    });
    if (!agreed.ok) throw new Error(agreed.reason);
    const declared = await declare({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER', performer: supplier, supplierName: supplier, actorRef: userId });
    if (!declared.ok) throw new Error(declared.reason);
    const cost = await recordCost({ projectId, agreementId: agreed.value.id, kind: 'SUPPLIER_COMMITMENT', amountCents: cents, detail: 'Signed work order', actorRef: userId });
    if (!cost.ok) throw new Error(cost.reason);
  }

  const record = (id: string, facts: Fact[]) =>
    recordCounterpartyFacts({ projectId, counterparty: { id, kind: 'contractor', geography: 'region-a', humanOperator: true }, facts, actorRef: userId });
  const said = (ref: string) => (dimension: string, value: number | string | null = null): Fact => ({ dimension, status: 'VERIFIED', evidence: ref, value });

  beforeEach(async () => {
    clearAdapters();
    clearPaymentReader();
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `cp31e-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'Cash Mode commercial authority',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000, maxPerActionCents: 200_000, maxConcurrent: 5, currency: 'USD',
    });
  });

  it("the project's labor reading carries the opportunity's primary, alternative, verified and pending facts, steps and workforce", async () => {
    const opportunityId = await sourcedOpportunity('Eastside Crew');
    await contractedSupplier(opportunityId, 'Lakeside Builders', 25_000);
    const lakeside = fulfillerCounterpartyId('Lakeside Builders');
    const eastside = fulfillerCounterpartyId('Eastside Crew');

    const view = await laborView(projectId);
    const one = view.counterparties.opportunities.find((o) => o.opportunityId === opportunityId)!;
    expect(one).toBeDefined();
    const reading = one.transaction.reading!;
    expect(reading.source).toBe(`opportunity:${opportunityId}`);
    expect(reading.authority).toMatchObject({ businessId: projectId, held: true });
    expect(reading.compared.map((r) => r.counterpartyId).sort()).toEqual([eastside, lakeside].sort());
    // Verified from the ledger; everything a listing does not establish is pending, never assumed.
    const ledger = reading.facts.find((f) => f.counterpartyId === lakeside)!;
    expect(ledger.verified).toEqual(expect.arrayContaining(['listing', 'price', 'contract']));
    expect(ledger.pending.map((m) => m.dimension)).toEqual(expect.arrayContaining(['willingness', 'availability']));
    expect(reading.deliverability.deliverable).toBe(false);
    expect(reading.reserve).toMatchObject({ permitted: false, reason: 'NOT_QUOTED' });
    // One step per place the rows name a fulfiller; nobody holds them yet.
    expect(one.steps.map((s) => s.state)).toEqual(one.steps.map(() => 'READY'));
    expect(one.steps.map((s) => s.id)).toContain(`opportunity:${opportunityId}:fulfillmentOwner`);
    // No verified capacity anywhere: a shortfall, closed by sourcing before hiring is even listed.
    expect(view.counterparties.workforce).toEqual([
      expect.objectContaining({ commitmentId: `opportunity:${opportunityId}`, shortfall: 1, options: ['SOURCE_COUNTERPARTY', 'EXTEND_PARTNER_NETWORK', 'PREPARE_HIRE'] }),
    ]);
    expect(view.counterparties.breaches).toEqual([]);
    expect(view.counterparties.summary).toMatch(/1 opportunity names a fulfiller/);
  });

  it('boot registers the opportunity reading as a non-release probe that reads production rows through the model', async () => {
    expect(OPPORTUNITY_COUNTERPARTY_PROBE).not.toMatch(/^r\d{2}\./);
    registerCommercialProviders({} as NodeJS.ProcessEnv);
    const probe = getProbe(OPPORTUNITY_COUNTERPARTY_PROBE);
    expect(probe).not.toBeNull();

    const opportunityId = await sourcedOpportunity('Eastside Crew');
    await contractedSupplier(opportunityId, 'Lakeside Builders', 25_000);
    const lakeside = fulfillerCounterpartyId('Lakeside Builders');
    const eastside = fulfillerCounterpartyId('Eastside Crew');
    const from = (who: string) => said(`written quote from ${who}, 2031-02-02`);
    await record(lakeside, [
      ...['willingness', 'availability', 'eligibility', 'scope', 'qualifications'].map((d) => from('Lakeside')(d)),
      from('Lakeside')('geography', 'region-a'), from('Lakeside')('paymentTerms', 'net 30'), from('Lakeside')('leadTime', 5),
      from('Lakeside')('availableCapacity', 2), from('Lakeside')('reservedCapacity'),
    ]);
    await record(eastside, [
      ...['willingness', 'availability', 'eligibility', 'scope', 'qualifications'].map((d) => from('Eastside')(d)),
      from('Eastside')('geography', 'region-a'), from('Eastside')('price', 31_000), from('Eastside')('paymentTerms', 'net 15'),
      from('Eastside')('leadTime', 7), from('Eastside')('availableCapacity', 3),
    ]);

    const before = await probe!({ project: projectId });
    expect(before.ok).toBe(true);
    expect(before.detail).toContain(`${opportunityId}: ${lakeside} at CONTRACTED, ${eastside}`);
    expect(before.detail).toContain('reserve=permitted');

    // A real hold, then a reported failure: the reading plans the transfer and never calls the sale deliverable.
    await reserveOpportunityTransaction({ opportunityId, window: W, at: AT }, userId);
    const [hold] = holdsFrom(await recordedReservationEvents([lakeside]));
    expect((await recordHoldOutcome({ counterpartyId: lakeside, key: hold!.key, kind: 'FAILED', at: '2031-02-11T00:00:00Z', actorRef: userId })).recorded).toBe(true);

    const after = await projectCounterparties(projectId, { at: '2031-02-11T01:00:00.000Z', window: W });
    const one = after.opportunities.find((o) => o.opportunityId === opportunityId)!;
    expect(one.transaction.reading!.transfer).toMatchObject({ applicable: true, from: lakeside, to: eastside });
    expect(one.transaction.reading!.deliverability.deliverable).toBe(false);
    expect(one.steps.find((s) => s.counterpartyId === lakeside)?.state).toBe('FAILED');
    expect(after.breaches).toEqual([]);
    expect((await probe!({ project: projectId })).ok).toBe(true);
    // The probe wrote nothing: still exactly one hold, failed, and no transfer made by reading.
    expect(holdsFrom(await recordedReservationEvents([lakeside, eastside])).map((h) => [h.counterpartyId, h.state])).toEqual([[lakeside, 'FAILED']]);
  });

  it('reports a project with no named fulfiller honestly, with nothing invented', async () => {
    await sourcedOpportunity('Brain');
    const view = await laborView(projectId);
    expect(view.counterparties.opportunities.every((o) => o.transaction.reading === null)).toBe(true);
    expect(view.counterparties.workforce).toEqual([]);
  });

  it('each S-0468/S-0469 entry point has a production caller reachable from a served door', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk('server');
    const own = 'server/services/labor/counterparties/transaction.ts';
    const callers = (fn: string) => files.filter((f) => f !== own && new RegExp(`\\b${fn}\\(`).test(readFileSync(f, 'utf8')));
    for (const fn of ['readOpportunityTransaction', 'coordinateSteps', 'planWorkforce', 'transactionBreaches']) {
      expect(callers(fn), fn).toContain('server/services/labor/counterparties/operations.ts');
    }
    // operations.ts is reached from the labor reading the route serves and from the boot registration.
    expect(readFileSync('server/services/labor/view.ts', 'utf8')).toMatch(/projectCounterparties\(/);
    expect(readFileSync('server/routes/labor.ts', 'utf8')).toMatch(/laborView\(/);
    expect(readFileSync('server/services/cash/providers/register.ts', 'utf8')).toMatch(/registerProbe\(OPPORTUNITY_COUNTERPARTY_PROBE/);
    expect(readFileSync('server/index.ts', 'utf8')).toMatch(/registerCommercialProviders\(/);
  });
});
