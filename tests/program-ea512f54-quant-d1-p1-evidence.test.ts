/**
 * COM-13-2 (S-0103), review finding repair-lever-parts-never-take-evidence.
 *
 * At 1c6da40 construction built every lever part as bare bounds and nothing
 * read observations into them, so `verifyPrepayment` could never return
 * ESTABLISHED on a production arrangement and the prepayment question
 * construction asks research had no consumer.
 *
 * Pinned here: the lever parts take what the project's rows state — EVIDENCE
 * card facts and an opening's published payment terms — through the
 * production entry point (`constructArrangements`). The arrangement's own
 * payer establishes a part; another payer's terms only bound it; nothing
 * stated stays UNKNOWN.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { leverEvidenceFrom, readLeverSentence } from '../server/services/quant/leverEvidence.ts';
import type { CashCardFact, CashOpportunity } from '../server/domain/types.ts';

const now = new Date('2026-11-14T00:00:00Z');

describe('a sentence is read only for the part whose words it names', () => {
  it('reads prepayment willingness, refunds and usable funds', () => {
    expect(readLeverSentence('48 of 80 customers prepaid in full at booking.', 'USD', 30)['prepayment.willingness']).toEqual({ kind: 'COUNT', successes: 48, trials: 80 });
    expect(readLeverSentence('About 35% of buyers pay a deposit up front.', 'USD', 30)['prepayment.willingness']).toEqual({ kind: 'POINT', value: 0.35 });
    expect(readLeverSentence('Full payment is required in advance of the service.', 'USD', 30)['prepayment.willingness']).toEqual({ kind: 'POINT', value: 1, exact: true });
    expect(readLeverSentence('Refunds were issued on 6 of 120 prepaid orders.', 'USD', 30)['prepayment.refundShare']).toEqual({ kind: 'COUNT', successes: 6, trials: 120 });
    expect(readLeverSentence('Deposits are non-refundable.', 'USD', 30)['prepayment.refundShare']).toEqual({ kind: 'POINT', value: 0, exact: true });
    expect(readLeverSentence('Card payments are paid out and usable within 2 days.', 'USD', 30)['prepayment.usableDays']).toEqual({ kind: 'POINT', value: 2, exact: true });
  });
  it('reads a supplier’s terms, failures and capacity, converted to the period', () => {
    expect(readLeverSentence('The laundry supplier invoices net 30.', 'USD', 30)['fulfilment.paymentDays']).toEqual({ kind: 'POINT', value: 30, exact: true });
    expect(readLeverSentence('The supplier reports 4% of deliveries late.', 'USD', 30)['fulfilment.failureRate']).toEqual({ kind: 'POINT', value: 0.04 });
    expect(readLeverSentence('Each supplier can handle 20 loads per week.', 'USD', 28)['fulfilment.capacity']).toEqual({ kind: 'POINT', value: 80 });
  });
  it('reads AI labor and buyer settlement, and nothing from a sentence that names neither', () => {
    expect(readLeverSentence('The automated model costs $0.40 per document.', 'USD', 30)['aiLabor.costPerTransaction']).toEqual({ kind: 'POINT', value: 0.4 });
    expect(readLeverSentence('Hotel clients pay invoices net 45.', 'USD', 30).settlementDays).toEqual({ kind: 'POINT', value: 45, exact: true });
    expect(readLeverSentence('Hotels in the region number about 1,200.', 'USD', 30)).toEqual({});
    // A supplier's payment term is not a buyer's prepayment.
    expect(readLeverSentence('The supplier requires payment in advance.', 'USD', 30)['prepayment.willingness']).toBeUndefined();
  });
});

describe('the rows become observations about the payer they were measured on', () => {
  it('reads EVIDENCE facts and payment terms, and ignores recommendations, duplicates and payerless openings', () => {
    const opp = (id: string, over: Partial<CashOpportunity> = {}) => ({ id, payer: 'Independent hotels', industry: 'Hospitality', currency: 'USD', duplicateOfId: null, paymentTerms: null, sourceClaimId: null, title: id, createdAt: '2026-11-01T00:00:00Z', signalObservedAt: null, ...over }) as CashOpportunity;
    const fact = (id: string, opportunityId: string, value: string, kind: CashCardFact['kind'] = 'EVIDENCE') => ({ id, opportunityId, projectId: 'p', field: 'cashDates', kind, value, claimId: `clm_${id}`, needId: null, basis: null, assumptions: null, uncertainty: null, decidedBy: 'BRAIN', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }) as CashCardFact;
    const ev = leverEvidenceFrom({
      opportunities: [opp('a', { paymentTerms: 'Clients pay invoices net 15.' }), opp('dup', { duplicateOfId: 'a' }), opp('nobody', { payer: null })],
      facts: [
        fact('f1', 'a', '48 of 80 customers prepaid in full at booking. Refunds were issued on 6 of 120 prepaid orders.'),
        fact('f2', 'a', '90% of buyers prepay.', 'RECOMMENDATION'),
        fact('f3', 'dup', '70 of 80 customers prepaid.'),
        fact('f4', 'nobody', '70 of 80 customers prepaid.'),
      ],
      currency: 'USD',
      periodDays: 30,
    });
    expect(ev['prepayment.willingness']).toHaveLength(1);
    expect(ev['prepayment.willingness'][0]).toMatchObject({ value: { kind: 'COUNT', successes: 48, trials: 80 }, context: { payer: 'independent hotels' }, source: { kind: 'CLAIM', ref: 'clm_f1' } });
    expect(ev['prepayment.refundShare'][0]!.value).toEqual({ kind: 'COUNT', successes: 6, trials: 120 });
    expect(ev.settlementDays[0]).toMatchObject({ value: { kind: 'POINT', value: 15, exact: true }, source: { kind: 'CASH_OPPORTUNITY', ref: 'a' } });
  });
});

describe('construction maps the rows onto one payer’s lever parts', () => {
  it('establishes prepayment from the payer’s own rows and only bounds it from another payer’s', async () => {
    const { leverPartsFor, designLevers } = await import('../server/services/cash/construct.ts');
    const { verifyPrepayment } = await import('../server/services/quant/leverage.ts');
    const opp = { id: 'a', payer: 'Independent hotels', industry: 'Hospitality', currency: 'USD', duplicateOfId: null, paymentTerms: null, sourceClaimId: null, title: 'a', createdAt: '2026-11-01T00:00:00Z', signalObservedAt: null } as unknown as CashOpportunity;
    const fact = (id: string, value: string) => ({ id, opportunityId: 'a', projectId: 'p', field: 'cashDates', kind: 'EVIDENCE', value, claimId: `clm_${id}`, needId: null, basis: null, assumptions: null, uncertainty: null, decidedBy: 'BRAIN', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }) as CashCardFact;
    const ev = leverEvidenceFrom({
      opportunities: [opp],
      facts: [fact('w', '48 of 80 customers prepaid in full at booking.'), fact('r', 'Refunds were issued on 6 of 120 prepaid orders.'), fact('u', 'Card payments are paid out and usable within 2 days.'), fact('s', 'The regional laundry supplier invoices net 30.')],
      currency: 'USD',
      periodDays: 30,
    });
    const design = { base: 'SUBCONTRACT', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as never;
    const arrangement = (payer: string) => ({
      key: 'm', label: payer, period: '30 days', currency: 'USD',
      demand: { buyers: { min: 0, max: 1000 }, needRate: { min: 0, max: 4 }, reach: { min: 0, max: 1 }, conversion: { min: 0, max: 1 } },
      value: { min: 0, max: 10_000 }, capture: { kind: 'MARGIN' as const, supplyCost: { min: 0, max: 5_000 } }, cost: { min: 0, max: 100 },
      levers: designLevers(design, 'SUPPLIER', leverPartsFor(ev, payer)),
    });
    const own = verifyPrepayment(arrangement('Independent hotels'), now)[0]!;
    expect(own).toMatchObject({ willingness: 'ESTABLISHED', refundObligations: 'ESTABLISHED', timing: 'ESTABLISHED', usableBeforeSupplierPayment: true, credited: true, tasks: [] });
    const other = verifyPrepayment(arrangement('Boutique spas'), now)[0]!;
    expect(other).toMatchObject({ willingness: 'UNKNOWN', refundObligations: 'UNKNOWN', timing: 'UNKNOWN', credited: false });
    expect(other.tasks.length).toBeGreaterThan(0);
  });
});

describe('construction’s lever parts take the evidence in the running Brain', () => {
  afterAll(teardown);

  it('establishes prepayment for the payer whose rows state it, composes the credit, and leaves other populations UNKNOWN', async () => {
    const { project } = await freshProject();
    const projectId = project.id;
    const { createUser } = await import('../server/repos/identity.ts');
    const { activate } = await import('../server/services/cash/lifecycle.ts');
    const { capture } = await import('../server/services/cash/opportunities.ts');
    const { updateOpportunity } = await import('../server/repos/cashPortfolio.ts');
    const { recordCardFact } = await import('../server/repos/cashCardFacts.ts');
    const { createNode } = await import('../server/repos/industry.ts');
    const { constructArrangements, clearConstructionMemo } = await import('../server/services/cash/construct.ts');

    const user = await createUser({ email: `lever-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    expect((await activate({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);

    const { node: sector } = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Commercial laundry', origin: 'SEED' });
    await createNode({ projectId, parentId: sector.id, kind: 'BUYER_TYPE', name: 'Independent hotels', origin: 'SEED' });
    await createNode({ projectId, parentId: sector.id, kind: 'BOTTLENECK', name: 'Linen turnaround', origin: 'SEED' });
    await createNode({ projectId, parentId: sector.id, kind: 'FULFILMENT_SOURCE', name: 'Regional laundries', origin: 'SEED' });

    clearConstructionMemo();
    const before = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const hotelsBefore = before.filter((one) => one.leverage && one.demand.name === 'Independent hotels' && one.leverage.levers.includes('prepayment'));
    for (const one of hotelsBefore) expect(one.leverage!.prepayment[0]!.willingness).toBe('UNKNOWN');

    // Research answers the prepayment question for these buyers: an opening filed with their terms, and its card facts.
    const captured = await capture({ projectId, actorRef: user.id, ownerUserId: user.id, title: 'Hotel linen service prepayment terms', mechanism: 'SUBCONTRACTED_FULFILMENT', currency: 'USD' });
    if (!captured.ok) throw new Error(captured.reason);
    await updateOpportunity(captured.value.id, { payer: 'Independent hotels', industry: 'Hospitality', payment_terms: 'Clients pay invoices net 14.' } as never);
    const evidence = (field: string, value: string) =>
      recordCardFact({ projectId, opportunityId: captured.value.id, field, kind: 'EVIDENCE', value, claimId: `clm_${field}_${captured.value.id}`, decidedBy: 'BRAIN' });
    await evidence('buyingEvidence', '48 of 80 customers prepaid in full at booking.');
    await evidence('disqualifiers', 'Refunds were issued on 6 of 120 prepaid orders.');
    await evidence('cashDates', 'Card payments are paid out and usable within 2 days.');
    await evidence('fulfillment', 'The regional laundry supplier invoices net 30.');

    clearConstructionMemo();
    const after = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const prepaid = after.filter((one) => one.leverage && one.leverage.levers.includes('prepayment'));
    const hotels = prepaid.filter((one) => one.demand.name === 'Independent hotels');
    expect(hotels.length, 'a traced prepaid arrangement for the payer the rows describe').toBeGreaterThan(0);
    for (const one of hotels) {
      const v = one.leverage!.prepayment[0]!;
      expect(v.willingness, one.key).toBe('ESTABLISHED');
      expect(v.refundObligations, one.key).toBe('ESTABLISHED');
      expect(v.timing, one.key).toBe('ESTABLISHED');
      // The research question no longer asks what the rows answered.
      expect(one.question).not.toMatch(/establish what share of these buyers will prepay/);
      expect(one.question).not.toMatch(/establish the refund obligations on prepaid money/);
      if (!one.leverage!.levers.includes('fulfilment')) {
        // Every condition is evidenced, so the credit is composed; Brain pays its own outlay on day 0 and
        // money usable on day 2 arrives after it, so the composed credit is read as funding nothing.
        expect(v.usableBeforeSupplierPayment).toBe(false);
        expect(v.credited).toBe(true);
        expect(v.tasks).toEqual([]);
      }
    }
    // Where a supplier fulfils, usable in 2 days against net 30 is established, usable first, and the credit is taken.
    const supplied = hotels.find((one) => one.leverage!.levers.includes('fulfilment'));
    if (supplied) {
      const v = supplied.leverage!.prepayment[0]!;
      expect(v.timing).toBe('ESTABLISHED');
      expect(v.usableBeforeSupplierPayment).toBe(true);
      expect(v.credited).toBe(true);
    }
    // Another population's arrangements — the reverse designs' "buyers to be found" — are not established by these buyers' terms.
    for (const one of prepaid.filter((x) => x.origin === 'REVERSE')) {
      expect(one.leverage!.prepayment[0]!.willingness, one.key).toBe('UNKNOWN');
      expect(one.leverage!.prepayment[0]!.credited).toBe(false);
    }
  }, 300_000);
});
