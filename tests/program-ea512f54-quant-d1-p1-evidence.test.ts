/**
 * COM-13-2 (S-0103), repaired: construction's lever parts take evidence.
 *
 * The finding: construction built every lever part as bare bounds, so
 * prepayment could never be ESTABLISHED on a production arrangement, the
 * credit could never be taken, and the research question construction asks
 * ("establish what share of these buyers will prepay…") had no consumer.
 *
 * These tests drive the real construction entry point on real rows — a
 * researched opening's payment terms, its gated card facts and an accepted
 * research claim — and show the reading moves: willingness, refund
 * obligations and the timing of usable funds become ESTABLISHED for the
 * buyers the evidence is about, the credit is taken, the question stops
 * asking what is answered, and buyers nothing speaks to stay UNKNOWN.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { leverObservations, leverPart, prepaysIn, readDays, readShare, type LeverStatement } from '../server/services/quant/leverEvidence.ts';
import { composeArrangement, type Arrangement } from '../server/services/quant/mechanism.ts';
import { reconstruct } from '../server/services/quant/reconstruct.ts';

const now = new Date('2026-11-14T00:00:00Z');

const st = (id: string, text: string, payer: string | null, opportunityId: string | null = null): LeverStatement => ({
  id,
  text,
  payer,
  industry: 'events',
  opportunityId,
  lineage: [`url:example.test/${id}`],
  source: { kind: 'CLAIM', ref: `clm_${id}` },
  observedAt: '2026-10-01T00:00:00Z',
});

describe('reading lever evidence from researched statements', () => {
  it('reads payment terms, refunds and timing only from sentences that name them', () => {
    expect(prepaysIn('A 50% deposit is paid upfront before work starts.')).toBe(true);
    expect(prepaysIn('Invoices are paid net 30 after delivery.')).toBe(false);
    expect(prepaysIn('They do not pay anything upfront; invoiced on completion.')).toBe(false);
    expect(prepaysIn('The venue seats 200.')).toBeNull();
    expect(readDays('Payouts are available 2 business days after the charge.')).toEqual({ kind: 'POINT', value: 2 });
    expect(readDays('net 45')).toEqual({ kind: 'POINT', value: 45 });
    expect(readShare('12 of 40 planners paid a deposit')).toEqual({ kind: 'COUNT', successes: 12, trials: 40 });
    expect(readShare('about 30% pay upfront')).toEqual({ kind: 'POINT', value: 0.3 });
    const ev = leverObservations(
      [
        st('a', 'Deposits are non-refundable. Payouts are available 2 days after the charge.', 'wedding planners', 'opp_a'),
        st('b', 'Suppliers are paid net 30 after delivery.', 'wedding planners', 'opp_b'),
        st('c', 'In a survey, 18 of 60 wedding planners pay a deposit upfront.', null),
      ],
      { periodDays: 30, currency: 'USD' },
    );
    expect(ev.refundShare.map((o) => o.obs.value)).toEqual([{ kind: 'POINT', value: 0, exact: true }]);
    expect(ev.usableDays.map((o) => o.obs.value)).toEqual([{ kind: 'POINT', value: 2 }]);
    expect(ev.supplierPaymentDays.map((o) => o.obs.value)).toEqual([{ kind: 'POINT', value: 30 }]);
    // Opening a prepays (a deposit), opening b pays after delivery, and the claim states a sampled share.
    expect(ev.prepayWillingness.map((o) => o.obs.value)).toEqual(
      expect.arrayContaining([{ kind: 'COUNT', successes: 1, trials: 1 }, { kind: 'COUNT', successes: 0, trials: 1 }, { kind: 'COUNT', successes: 18, trials: 60 }]),
    );
  });

  it('counts evidence for the buyers it names and only bounds others with it', () => {
    const ev = leverObservations([st('c', '18 of 60 wedding planners pay a deposit upfront.', null), st('d', '9 of 30 wedding planners prepay in full.', null)], { periodDays: 30, currency: 'USD' });
    const named = leverPart(ev.prepayWillingness, { payer: 'Wedding planners', industry: null, arrangement: 'x' }, { min: 0, max: 1 });
    const other = leverPart(ev.prepayWillingness, { payer: 'Dental clinics', industry: null, arrangement: 'x' }, { min: 0, max: 1 });
    expect(named.observations!.every((o) => !o.broad)).toBe(true);
    expect(other.observations!.every((o) => o.broad)).toBe(true);
    const resolve = (part: ReturnType<typeof leverPart>) =>
      reconstruct({ nodes: [{ ...part, key: 'w', label: 'w', unit: 'share', kind: 'RATE' }] }, 'w', now).estimates['w']!;
    expect(resolve(named).distributionJustified).toBe(true);
    expect(resolve(other).distributionJustified).toBe(false);
    // Nothing said: bounds, a question.
    expect(leverPart([], { payer: 'x', industry: null, arrangement: 'x' }, { min: 0, max: 1 })).toEqual({ min: 0, max: 1 });
  });

  it('lets acquisition days evidence acquisition speed without a marketing lever', () => {
    const pt = (id: string, value: number) => ({ observations: [{ id, value: { kind: 'POINT' as const, value, exact: true }, context: {}, lineage: [id], source: { kind: 'CLAIM' as const, ref: id } }] });
    const a: Arrangement = {
      key: 'q', label: 'q', period: 'month', currency: 'USD',
      demand: { buyers: pt('b', 100), needRate: pt('n', 1), reach: { observations: [{ id: 'r', value: { kind: 'COUNT', successes: 5, trials: 10 }, context: {}, lineage: ['r'], source: { kind: 'CLAIM', ref: 'r' } }] }, conversion: { observations: [{ id: 'c', value: { kind: 'COUNT', successes: 2, trials: 10 }, context: {}, lineage: ['c'], source: { kind: 'CLAIM', ref: 'c' } }] } },
      value: pt('v', 100), capture: { kind: 'FEE', fee: pt('f', 100) }, cost: pt('k', 10),
      levers: { aiLabor: { costPerTransaction: pt('ai', 1), throughput: pt('t', 1000) }, settlementDays: pt('s', 7), acquisitionDays: pt('d', 10) },
    };
    const composed = composeArrangement(a, { now });
    const key = composed.traced!.acquisitionSpeed;
    expect(reconstruct(composed.graph, key, now).estimates[key]!.distributionJustified).toBe(true);
  });
});

describe('construction reads lever evidence from production rows', () => {
  afterAll(teardown);
  let projectId = '';
  let userId = '';
  let cashModeId = '';
  beforeEach(async () => {
    const { forgetKnowledge } = await import('../server/services/quant/knowledge.ts');
    forgetKnowledge();
    projectId = (await freshProject()).project.id;
    const { createUser } = await import('../server/repos/identity.ts');
    const { activate } = await import('../server/services/cash/lifecycle.ts');
    const { getCashMode } = await import('../server/repos/cashMode.ts');
    userId = (await createUser({ email: `lever-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
    cashModeId = (await getCashMode(projectId))!.id;
  });

  async function opening(title: string, payer: string, terms: string, refundFact: string) {
    const { createOpportunity, updateOpportunity } = await import('../server/repos/cashPortfolio.ts');
    const { recordCardFact } = await import('../server/repos/cashCardFacts.ts');
    const o = await createOpportunity({
      projectId, cashModeId, ownerUserId: userId, title, mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', industry: 'Events',
      sourceClaimId: `clm_${Math.random().toString(36).slice(2, 12)}`, opportunitySignal: 'RECURRING_OUTSOURCED_WORK', source: 'A publisher', requiredCapabilities: ['PRODUCE_SPREADSHEET'],
    });
    await updateOpportunity(o.id, { payer, payment_terms: terms, offer_scope: 'Seating plans and vendor schedules' } as never);
    await recordCardFact({ projectId, opportunityId: o.id, field: 'payer', kind: 'EVIDENCE', value: payer, claimId: `clm_payer_${o.id}`, decidedBy: 'BRAIN' });
    await recordCardFact({ projectId, opportunityId: o.id, field: 'refundPolicy', kind: 'EVIDENCE', value: refundFact, claimId: `clm_refund_${o.id}`, decidedBy: 'BRAIN' });
    return o;
  }

  it('establishes prepayment for the buyers the evidence is about, takes the credit, and stops asking what is answered', async () => {
    await opening('Seating plans for a June wedding', 'Wedding planners', 'A 50% deposit is paid upfront when booking. Card payouts are available 2 days after the charge.', 'Deposits are non-refundable once the plan is delivered.');
    await opening('Vendor schedule for an autumn wedding', 'Wedding planners', 'Paid in full in advance by card. Payouts are available 3 days after the charge.', 'The deposit is non-refundable.');
    // A supplier the map holds for the same sector, and what research says it is paid: the probe reader constructs without a deliverable.
    const { createNode } = await import('../server/repos/industry.ts');
    const { node: sector } = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Events', origin: 'SEED' });
    await createNode({ projectId, parentId: sector.id, kind: 'FULFILMENT_SOURCE', name: 'Freelance event coordinators', origin: 'SEED' });
    const { recordCardFact } = await import('../server/repos/cashCardFacts.ts');
    const { listOpportunities } = await import('../server/repos/cashPortfolio.ts');
    for (const o of await listOpportunities({ projectId })) {
      await recordCardFact({ projectId, opportunityId: o.id, field: 'fulfillment', kind: 'EVIDENCE', value: 'Freelance coordinators are paid net 30 after the event.', claimId: `clm_supplier_${o.id}`, decidedBy: 'BRAIN' });
    }
    const { constructArrangements, clearConstructionMemo } = await import('../server/services/cash/construct.ts');
    clearConstructionMemo();
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const traced = built.filter((one) => one.leverage && one.leverage.levers.includes('prepayment'));
    expect(traced.length).toBeGreaterThan(0);
    const planners = traced.filter((one) => one.demand.name.toLowerCase() === 'wedding planners');
    expect(planners.length).toBeGreaterThan(0);
    for (const one of planners) {
      const v = one.leverage!.prepayment[0]!;
      expect(v.willingness).toBe('ESTABLISHED');
      expect(v.refundObligations).toBe('ESTABLISHED');
      // Where there is no supplier to pay, usable funds alone decide the timing; a supplier nobody dated keeps it a question.
      if (!one.leverage!.combinations.some((c) => c.levers.includes('fulfilment'))) expect(v.timing === 'ESTABLISHED' || v.tasks.some((t) => /when the supplier must be paid|when prepaid funds become usable/.test(t))).toBe(true);
      if (v.timing === 'ESTABLISHED') expect(v.credited).toBe(true);
      expect(one.question).not.toMatch(/establish what share of these buyers will prepay/);
      expect(one.question).not.toMatch(/establish the refund obligations on prepaid money/);
    }
    expect(planners.some((one) => one.leverage!.prepayment[0]!.credited)).toBe(true);
    // Buyers nothing speaks to keep their questions: the evidence did not travel to them as a distribution.
    for (const one of traced.filter((x) => x.demand.name.toLowerCase() !== 'wedding planners')) {
      expect(one.leverage!.prepayment[0]!.willingness).toBe('UNKNOWN');
    }

    // The probe reader, which constructs with what the project delivers (nothing proved here), sees verified prepayment on production rows.
    const { leverageHoldsOnRows } = await import('../server/services/quant/leverage.ts');
    clearConstructionMemo();
    const r = await leverageHoldsOnRows({ now, perProject: 12, projects: async () => [{ id: projectId }] });
    expect(r.prepayment.established).toBeGreaterThan(0);
    expect(r.prepayment.credited).toBeGreaterThan(0);
  }, 240_000);

  it('reads a buyer who pays after delivery as unwilling, never as a prepayer', async () => {
    await opening('Seating plan, invoiced', 'Wedding planners', 'Invoices are paid net 30 after delivery.', 'Refunds are not offered.');
    await opening('Vendor schedule, invoiced', 'Wedding planners', 'Paid on completion, net 14.', 'Refunds are not offered.');
    const { constructArrangements, clearConstructionMemo } = await import('../server/services/cash/construct.ts');
    clearConstructionMemo();
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheets'], capitalCeilingCents: 50_000, daysLeft: 30, now });
    const planners = built.filter((one) => one.leverage?.levers.includes('prepayment') && one.demand.name.toLowerCase() === 'wedding planners');
    expect(planners.length).toBeGreaterThan(0);
    for (const one of planners) {
      const full = one.leverage!.combinations.find((c) => c.levers.length === one.leverage!.levers.length)!;
      // Settlement is now evidenced too: net terms are what buyers who did not prepay take to pay.
      expect(full.dimensions.cashConversion.p50).not.toBeNull();
      // Willingness is established — as these buyers not prepaying — so no prepayment is presumed of them.
      expect(one.leverage!.prepayment[0]!.willingness).toBe('ESTABLISHED');
    }
    expect(prepaysIn('Invoices are paid net 30 after delivery.')).toBe(false);
    expect(prepaysIn('Paid on completion, net 14.')).toBe(false);
  }, 240_000);
});
