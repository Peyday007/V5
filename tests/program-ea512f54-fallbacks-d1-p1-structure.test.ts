/**
 * FALL-37-1 / FALL-37-2: the fallback structure of a consequential
 * dependency (`server/services/quant/fallbacks.ts`). Every statement is
 * proved across two unrelated domains: a manufacturing supplier behind a
 * client delivery, and the payments provider behind a subscription business.
 * A third, an evidence route behind a research claim, covers the rule that an
 * unverified source is never promoted because the primary failed.
 */
import { describe, expect, it } from 'vitest';
import { makeFigure, unknownFigure, type Figure } from '../server/services/quant/graph.ts';
import {
  availableCapacity,
  chooseReplacement,
  fallbackChain,
  planFallbacks,
  switchTo,
  type Dependency,
  type EconomicModel,
  type Substitute,
} from '../server/services/quant/fallbacks.ts';

function fig(meaning: string, unit: string, value: number, status: 'OBSERVED' | 'EVIDENCED' | 'CONTRACTED' | 'MODELED' = 'EVIDENCED'): Figure {
  const made = makeFigure({ meaning, unit, value, status, source: `test record: ${meaning}` });
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}
const p = (meaning: string, value: number) => fig(meaning, 'probability', value);
const days = (meaning: string, value: number) => fig(meaning, 'days', value);
const usd = (meaning: string, value: number) => fig(meaning, 'USD', value);

function substitute(over: Partial<Substitute> & Pick<Substitute, 'key' | 'label' | 'readiness'>): Substitute {
  return {
    changes: ['PROVIDER'],
    capacity: fig(`${over.label} capacity`, 'units', 500),
    failureProbability: unknownFigure(`${over.label} failure probability`, 'probability'),
    eligibility: { authorized: true, meetsObligations: true, basis: 'approved alternative on record' },
    switchingCost: null,
    timeToSwitchDays: null,
    overrides: {},
    recoveryVerification: null,
    ...over,
  };
}

/* Domain 1: a contract manufacturer behind a client delivery (high impact). */
const supplier: Dependency = {
  key: 'supplier-a',
  label: 'Supplier A (injection moulding)',
  servesActivity: 'deliver 400 enclosures to the client by day 15',
  primaryPath: 'Supplier A moulds and ships 400 enclosures in 10 days',
  primaryFailureProbability: p('Supplier A misses the order', 0.2),
  commonCauses: ['port of Long Beach'],
  failureModes: [
    {
      key: 'missed-ship-date',
      condition: 'Supplier A misses the ship date',
      detectionSignals: ['no advance ship notice 3 days before the date', 'carrier booking cancelled'],
      failureEvidence: ['the supplier portal shows the order unshipped past its date'],
      timeToHarmDays: days('days from a missed ship date to a late client delivery', 5),
      recoveryWindowDays: days('days inside which a switch still delivers on time', 4),
      probability: p('missed ship date', 0.15),
    },
    {
      key: 'quality-reject',
      condition: 'the lot fails incoming inspection',
      detectionSignals: ['first-article inspection fails'],
      failureEvidence: null,
      timeToHarmDays: days('days from a reject to a late delivery', 3),
      recoveryWindowDays: days('days inside which a reorder still delivers', 2),
      probability: p('quality reject', 0.05),
    },
  ],
  substitutes: [
    substitute({
      key: 'supplier-b',
      label: 'Supplier B',
      readiness: 'VALIDATED',
      failureProbability: p('Supplier B fails too', 0.1),
      switchingCost: usd('tooling transfer to B', 1200),
      timeToSwitchDays: days('days to move the order to B', 3),
      overrides: { leadTimeDays: days('B lead time', 14), unitCost: usd('B unit cost', 14) },
      recoveryVerification: 'B ships the lot and it passes incoming inspection',
    }),
    substitute({
      key: 'supplier-c',
      label: 'Supplier C',
      readiness: 'LOCATED',
      failureProbability: p('Supplier C fails too', 0.05),
      overrides: { leadTimeDays: days('C lead time', 8), unitCost: usd('C unit cost', 9) },
    }),
    substitute({
      key: 'supplier-d',
      label: 'Supplier D (reserved slot)',
      readiness: 'RESERVED',
      capacity: fig('D reserved slot', 'units', 300),
      failureProbability: p('Supplier D fails too', 0.3),
      timeToSwitchDays: days('days to call the reserved slot', 1),
      overrides: { leadTimeDays: days('D lead time', 6), unitCost: usd('D unit cost', 16) },
      recoveryVerification: 'D confirms the slot and ships',
    }),
    substitute({
      key: 'print-on-demand-with-deposit',
      label: 'Print on demand, funded by a client deposit',
      readiness: 'VALIDATED',
      changes: ['SUPPLIER', 'PAYMENT_TERMS', 'FINANCING'],
      failureProbability: p('print-on-demand route fails', 0.1),
      eligibility: { authorized: null, meetsObligations: true, basis: 'the client has not agreed to a deposit' },
    }),
    substitute({
      key: 'supplier-e-same-port',
      label: 'Supplier E (same port)',
      readiness: 'VALIDATED',
      failureProbability: p('Supplier E fails too', 0.01),
      commonCauses: ['port of Long Beach'],
    }),
  ],
  consequence: {
    cashAtRisk: usd('order value lost if nothing ships', 50_000),
    obligations: ['deliver 400 enclosures by day 15'],
    capability: null,
    tolerableLoss: usd('expected loss the plan can bear from this supplier', 500),
  },
};

const supplierModel: EconomicModel = {
  inputs: {
    leadTimeDays: days('Supplier A lead time', 10),
    unitCost: usd('Supplier A unit cost', 10),
    unitPrice: usd('client unit price', 30),
    units: fig('units ordered', 'units', 400, 'CONTRACTED'),
    capacity: fig('Supplier A capacity', 'units', 1000),
    paymentDays: days('client pays this many days after delivery', 15, ),
  },
  capacityInput: 'capacity',
  figures: [
    { key: 'deliveryDays', meaning: 'days to client delivery', unit: 'days', from: ['leadTimeDays'], compute: ([lead]) => lead! + 2 },
    { key: 'deliveryObligationMet', meaning: 'delivery by day 15 (1 = met)', unit: 'boolean', from: ['deliveryDays'], compute: ([d]) => (d! <= 15 ? 1 : 0) },
    { key: 'unitMargin', meaning: 'margin per unit', unit: 'USD', from: ['unitPrice', 'unitCost'], compute: ([price, cost]) => price! - cost! },
    { key: 'unitsDelivered', meaning: 'units the source can deliver', unit: 'units', from: ['units', 'capacity'], compute: ([u, c]) => Math.min(u!, c!) },
    { key: 'contribution', meaning: 'order contribution', unit: 'USD', from: ['unitsDelivered', 'unitMargin'], compute: ([u, m]) => u! * m! },
    { key: 'cashTimingDays', meaning: 'days until the client\'s cash is usable', unit: 'days', from: ['deliveryDays', 'paymentDays'], compute: ([d, pay]) => d! + pay! },
  ],
  portfolio: {
    problem: {
      activities: [{ key: 'order', label: 'client order', cash: [0], days: [0], justified: true }],
      target: 7_000,
      deadlineDays: 30,
      worlds: 400,
      seed: 7,
      challenge: false,
    },
    activityKey: 'order',
    toActivity: (f) => {
      const cash = f.contribution;
      const when = f.cashTimingDays;
      if (!cash || cash.value === null || !when || when.value === null) return null;
      // Three plausible collection outcomes around the derived figures.
      return { cash: [cash.value * 0.9, cash.value, cash.value * 1.05], days: [when.value - 2, when.value, when.value + 4] };
    },
  },
};

/* Domain 2: the payments provider behind a subscription business (low impact). */
const payments: Dependency = {
  key: 'card-processor',
  label: 'Card processor',
  servesActivity: 'collect monthly subscriptions',
  primaryPath: 'Processor X charges cards monthly',
  primaryFailureProbability: p('Processor X freezes the account this month', 0.02),
  commonCauses: ['merchant account M-1'],
  failureModes: [
    {
      key: 'account-frozen',
      condition: 'the processor freezes the merchant account',
      detectionSignals: ['dispute rate above 0.75%', 'processor risk-review email'],
      failureEvidence: ['payouts paused on the processor dashboard'],
      timeToHarmDays: days('days from freeze to a missed payout', 2),
      recoveryWindowDays: days('days inside which another route still collects this cycle', 7),
      probability: p('account freeze', 0.02),
    },
  ],
  substitutes: [
    substitute({
      key: 'processor-y-same-account',
      label: 'Processor Y on the same merchant account',
      readiness: 'VALIDATED',
      failureProbability: p('Processor Y fails', 0.02),
      commonCauses: ['merchant account M-1'],
      timeToSwitchDays: days('days to route to Y', 1),
    }),
    substitute({
      key: 'agency-pays-on-invoice',
      label: 'An agency partner buys seats and pays on invoice',
      readiness: 'RESERVED',
      changes: ['PAYER', 'SEGMENT', 'PAYMENT_TERMS'],
      capacity: fig('seats the agency has committed to', 'seats', 40),
      failureProbability: p('agency route fails', 0.1),
      timeToSwitchDays: days('days to invoice the agency', 5),
      overrides: { paymentDays: days('net-30 invoice', 30) },
      recoveryVerification: 'the agency\'s first invoice is paid and reconciled to the bank',
    }),
  ],
  consequence: {
    cashAtRisk: usd('one month of subscriptions', 2_000),
    obligations: [],
    capability: null,
    tolerableLoss: usd('expected loss the plan can bear from this processor', 100),
  },
};

describe('a dependency yields failure modes, signals, time to harm, recovery window, substitutes and consequences', () => {
  it.each([
    ['manufacturing supplier', supplier],
    ['payments provider', payments],
  ])('%s', (_name, dependency) => {
    const plan = planFallbacks(dependency);
    expect(plan.failureModes.length).toBeGreaterThan(0);
    for (const mode of plan.failureModes) {
      expect(mode.detectionSignals.length).toBeGreaterThan(0);
      expect(mode.timeToHarmDays.value).not.toBeNull();
      expect(mode.recoveryWindowDays.value).not.toBeNull();
    }
    expect(plan.substitutes.length).toBe(dependency.substitutes.length);
    expect(plan.consequence.cashAtRisk.value).toBeGreaterThan(0);
    expect(plan.servesActivity).toBe(dependency.servesActivity);
  });
});

describe('the number of alternatives is a recorded judgment, never a fixed count', () => {
  it('a high-impact supplier needs two independent validated or reserved alternatives; a low-impact processor needs none', () => {
    const high = planFallbacks(supplier).alternatives;
    const low = planFallbacks(payments).alternatives;
    expect(high.required).toBe(2);
    expect(high.met).toBe(true);
    expect(high.counted).toEqual(['supplier-b', 'supplier-d']);
    expect(high.basis).toMatch(/2 independent substitute/);
    expect(low.required).toBe(0);
    expect(low.basis).toMatch(/within the tolerable/);
    expect(high.required).not.toBe(low.required);
  });

  it('a substitute sharing a common cause with the primary does not count as independent, however reliable', () => {
    const plan = planFallbacks(supplier);
    const e = plan.substitutes.find((one) => one.key === 'supplier-e-same-port')!;
    expect(e.sharedWithPrimary).toEqual(['port of Long Beach']);
    expect(plan.alternatives.counted).not.toContain('supplier-e-same-port');
    const y = planFallbacks(payments).substitutes.find((one) => one.key === 'processor-y-same-account')!;
    expect(y.sharedWithPrimary).toEqual(['merchant account M-1']);
  });

  it('without the probabilities it needs, the judgment says it cannot be made and what is missing, never zero', () => {
    const unsized = { ...payments, primaryFailureProbability: unknownFigure('freeze probability', 'probability') };
    const judged = planFallbacks(unsized).alternatives;
    expect(judged.required).toBeNull();
    expect(judged.met).toBeNull();
    expect(judged.missing).toContain('card-processor: primary failure probability');
  });
});

describe('a substitute can change the mechanism, not only the vendor', () => {
  it('the supplier and the processor each carry a mechanism change beside equivalent swaps', () => {
    const s = planFallbacks(supplier).substitutes;
    expect(s.find((one) => one.key === 'supplier-b')!.changesMechanism).toBe(false);
    expect(s.find((one) => one.key === 'print-on-demand-with-deposit')!).toMatchObject({ changesMechanism: true, changes: ['SUPPLIER', 'PAYMENT_TERMS', 'FINANCING'] });
    const q = planFallbacks(payments).substitutes;
    expect(q.find((one) => one.key === 'agency-pays-on-invoice')!).toMatchObject({ changesMechanism: true, changes: ['PAYER', 'SEGMENT', 'PAYMENT_TERMS'] });
  });

  it('a mechanism change whose authority is not on record is ineligible until reconciled', () => {
    const reading = planFallbacks(supplier).substitutes.find((one) => one.key === 'print-on-demand-with-deposit')!;
    expect(reading.eligible).toBe(false);
    expect(reading.ineligibleBecause.join(' ')).toMatch(/no authority to switch to it is on record; reconcile/);
  });
});

describe('the chain from primary path to recovery verification is exported, and unknown links are null', () => {
  it('supplier: every link is present where stated and null where not', () => {
    const chain = fallbackChain(supplier, 'missed-ship-date');
    expect(chain.primaryPath).toBe(supplier.primaryPath);
    expect(chain.failureCondition).toBe('Supplier A misses the ship date');
    expect(chain.failureEvidence).toEqual(['the supplier portal shows the order unshipped past its date']);
    const b = chain.replacements.find((one) => one.substitute === 'supplier-b')!;
    expect(b.eligibility).toMatchObject({ eligible: true, authorized: true, meetsObligations: true });
    expect(b.switchingCost?.value).toBe(1200);
    expect(b.timeToSwitchDays?.value).toBe(3);
    expect(b.recoveryVerification).toMatch(/passes incoming inspection/);
    expect(b.impact).toBeNull();
    const c = chain.replacements.find((one) => one.substitute === 'supplier-c')!;
    expect(c.switchingCost).toBeNull();
    expect(c.timeToSwitchDays).toBeNull();
    expect(c.recoveryVerification).toBeNull();
    expect(fallbackChain(supplier, 'quality-reject').failureEvidence).toBeNull();
  });

  it('processor: the chain carries each replacement\'s re-derived impact when a model is given', () => {
    const model: EconomicModel = {
      inputs: { monthly: usd('monthly subscriptions', 2_000), paymentDays: days('card payout delay', 2) },
      figures: [{ key: 'cashTimingDays', meaning: 'days until a month\'s cash is usable', unit: 'days', from: ['paymentDays'], compute: ([d]) => d! }],
    };
    const chain = fallbackChain(payments, 'account-frozen', model);
    const agency = chain.replacements.find((one) => one.substitute === 'agency-pays-on-invoice')!;
    expect(agency.impact?.before.cashTimingDays!.value).toBe(2);
    expect(agency.impact?.after.cashTimingDays!.value).toBe(30);
    expect(agency.impact?.changed).toContain('cashTimingDays');
    expect(agency.recoveryVerification).toMatch(/reconciled to the bank/);
  });
});

describe('LOCATED, VALIDATED and RESERVED are distinct, and a located substitute adds no capacity', () => {
  it('supplier: C is located, so capacity counts B, D and the rest but not C; reserved counts D alone', () => {
    const plan = planFallbacks(supplier);
    const c = plan.substitutes.find((one) => one.key === 'supplier-c')!;
    expect(c.readiness).toBe('LOCATED');
    expect(c.availableCapacity.status).toBe('UNKNOWN');
    expect(c.availableCapacity.value).toBeNull();
    expect(plan.reservedCapacity.value).toBe(300);
    // B 500 + D 300 + print-on-demand 500 + E 500 — C's 500 is not there.
    expect(plan.validatedCapacity.value).toBe(1800);
  });

  it('processor: the reserved agency route is reserved capacity; the validated processor is not', () => {
    const plan = planFallbacks(payments);
    expect(plan.reservedCapacity.value).toBe(40);
    expect(new Set(plan.substitutes.map((one) => one.readiness))).toEqual(new Set(['VALIDATED', 'RESERVED']));
    expect(availableCapacity(payments.substitutes[1]!).value).toBe(40);
  });

  it('a located substitute would have counted toward alternatives if it were validated', () => {
    const validatedC = { ...supplier, substitutes: supplier.substitutes.map((one) => (one.key === 'supplier-c' ? { ...one, readiness: 'VALIDATED' as const } : one)) };
    expect(planFallbacks(validatedC).alternatives).toMatchObject({ required: 1, counted: ['supplier-c'] });
  });

  it('the replacement chosen when the primary fails is reserved first, and never a located one', () => {
    expect(chooseReplacement(supplier)?.key).toBe('supplier-d');
    expect(chooseReplacement(payments)?.key).toBe('agency-pays-on-invoice');
    const onlyLocated = { ...supplier, substitutes: [supplier.substitutes[1]!] };
    expect(chooseReplacement(onlyLocated)).toBeNull();
  });
});

describe('switching a failed supplier re-derives the economics through graph.ts and portfolio.ts', () => {
  it('lead time, cost, delivery obligation, cash timing and portfolio reach are recalculated, not copied', () => {
    const impact = switchTo(supplier, 'supplier-b', supplierModel);
    expect(impact.before.deliveryDays!.value).toBe(12);
    expect(impact.after.deliveryDays!.value).toBe(16);
    expect(impact.before.deliveryObligationMet!.value).toBe(1);
    expect(impact.after.deliveryObligationMet!.value).toBe(0);
    expect(impact.before.unitMargin!.value).toBe(20);
    expect(impact.after.unitMargin!.value).toBe(16);
    expect(impact.before.contribution!.value).toBe(8_000);
    expect(impact.after.contribution!.value).toBe(6_400);
    expect(impact.before.cashTimingDays!.value).toBe(27);
    expect(impact.after.cashTimingDays!.value).toBe(31);
    // Derived, with lineage back to the substitute's own figures.
    expect(impact.after.contribution!.derivedFrom.length).toBeGreaterThan(0);
    expect(impact.changed).toEqual(expect.arrayContaining(['leadTimeDays', 'unitCost', 'deliveryDays', 'deliveryObligationMet', 'contribution', 'cashTimingDays']));
    // The portfolio is re-evaluated over the same worlds: the target is reachable before and not after.
    expect(impact.reachBefore).toBeGreaterThan(0.5);
    expect(impact.reachAfter).toBe(0);
  });

  it('switching to a located supplier leaves capacity, contribution and reach unknown rather than borrowing its stated capacity', () => {
    const impact = switchTo(supplier, 'supplier-c', supplierModel);
    expect(impact.after.capacity!.status).toBe('UNKNOWN');
    expect(impact.after.contribution!.status).toBe('UNKNOWN');
    expect(impact.after.deliveryDays!.value).toBe(10);
    expect(impact.reachAfter).toBeNull();
    expect(impact.portfolioUnreadBecause).toMatch(/unknown after the switch/);
  });

  it('a reserved supplier\'s switch is read in full', () => {
    const impact = switchTo(supplier, 'supplier-d', supplierModel);
    expect(impact.after.unitsDelivered!.value).toBe(300);
    expect(impact.after.contribution!.value).toBe(300 * 14);
    expect(impact.reachAfter).not.toBeNull();
  });
});

describe('an unverified evidence source is never promoted when the primary evidence route fails', () => {
  const evidence: Dependency = {
    key: 'county-permit-records',
    label: 'County permit records',
    servesActivity: 'size the market of new pool permits',
    primaryPath: 'the county open-data permit API',
    primaryFailureProbability: p('the API is down this week', 0.3),
    failureModes: [
      {
        key: 'api-down',
        condition: 'the open-data API answers 503',
        detectionSignals: ['three consecutive 5xx answers'],
        failureEvidence: ['the fetch log shows 503 for the permit endpoint'],
        timeToHarmDays: days('days until the sizing is stale', 7),
        recoveryWindowDays: days('days to source it another way', 7),
        probability: p('api down', 0.3),
      },
    ],
    substitutes: [
      substitute({
        key: 'aggregator-blog',
        label: 'A permit-trends aggregator blog',
        readiness: 'VALIDATED',
        failureProbability: p('aggregator unavailable', 0.01),
        evidenceRoute: { verified: false, basis: 'secondary, unsourced counts' },
        timeToSwitchDays: days('instant', 0),
      }),
      substitute({
        key: 'captured-snapshot',
        label: 'The permit snapshot Brain captured last month',
        readiness: 'RESERVED',
        changes: ['PROVIDER'],
        failureProbability: p('snapshot unusable', 0.05),
        evidenceRoute: { verified: true, basis: 'captured from the primary record, hashed' },
        timeToSwitchDays: days('read the snapshot', 1),
      }),
    ],
    consequence: {
      cashAtRisk: usd('research spend wasted on a wrong sizing', 3_000),
      obligations: [],
      capability: 'market sizing',
      tolerableLoss: usd('tolerable', 100),
    },
  };

  it('the unverified route is ineligible and is not chosen, however fast or reliable', () => {
    const plan = planFallbacks(evidence);
    const blog = plan.substitutes.find((one) => one.key === 'aggregator-blog')!;
    expect(blog.eligible).toBe(false);
    expect(blog.ineligibleBecause.join(' ')).toMatch(/evidence route is unverified .* does not promote it/);
    expect(plan.alternatives.counted).not.toContain('aggregator-blog');
    expect(chooseReplacement(evidence)?.key).toBe('captured-snapshot');
    const withoutSnapshot = { ...evidence, substitutes: [evidence.substitutes[0]!] };
    expect(chooseReplacement(withoutSnapshot)).toBeNull();
  });
});
