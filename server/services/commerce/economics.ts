/**
 * What one order of a product is worth, from published figures only (§73).
 *
 * ---------------------------------------------------------------------------
 * The number that matters is what you can spend to win a customer
 * ---------------------------------------------------------------------------
 *
 * Advertising cost per order is the line a source almost never publishes for
 * one product, and it is the line that decides whether a store makes money.
 * So the reading does not pretend to know it. It computes the contribution
 * **before** acquisition — the retail price less the supplier's unit cost,
 * shipping, payment processing and every other published line — and reports
 * that figure as the **acquisition budget**: the most one order can cost to
 * win and still break even. A campaign is then judged against a number Brain
 * established rather than one it hoped for. Where a source does publish an
 * advertising cost per order, the contribution after acquisition is reported
 * beside it.
 *
 * ---------------------------------------------------------------------------
 * The conservative end of every range, and a withheld total rather than a
 * guessed one
 * ---------------------------------------------------------------------------
 *
 * The lowest published retail price, because that is what the product
 * actually competes at. The cheapest supplier offer, because choosing a
 * supplier is a decision and it is named. The highest published figure for
 * every cost line. A load-bearing line with no figure withholds the
 * contribution and names the line, because a total that steps over a blank is
 * smaller than anything published says — §30's rule, at the figure that
 * decides whether a store is opened. Two currencies withhold it too: Brain
 * never converts, because a rate is a fact about a day nobody recorded.
 */
import type { CommerceCostComponent, CommerceFact, CommerceProduct } from '../../domain/types.ts';

/** The cost lines a contribution cannot be computed without. */
export const LOAD_BEARING_COSTS: readonly CommerceCostComponent[] = Object.freeze([
  'SHIPPING_TO_CUSTOMER',
  'PAYMENT_PROCESSING',
]);

export interface ChosenSupplier {
  subject: string;
  unitCostCents: number;
  days: number | null;
  sourceClaimId: string;
}

export interface CostLine {
  component: CommerceCostComponent;
  /** The amount charged per order, after a rate is applied to the retail price. */
  perOrderCents: number;
  /** How it was published: an amount, or a rate in basis points. */
  published: { amountCents: number } | { rateBps: number };
  sourceClaimId: string;
}

export interface UnitEconomics {
  productId: string;
  currency: string | null;
  retail: { lowCents: number; highCents: number; sellers: number } | null;
  supplier: ChosenSupplier | null;
  suppliers: number;
  lines: CostLine[];
  /** Retail less every published line except advertising. Null when withheld. */
  contributionBeforeAdsCents: number | null;
  /** The same, after a published advertising cost per order, where there is one. */
  contributionAfterAdsCents: number | null;
  /** Contribution before advertising as a share of the retail price, 0..1. */
  budgetShare: number | null;
  /** Why the contribution is withheld, or null when it is not. */
  withheld: string | null;
  /** The load-bearing lines nobody has published a figure for. */
  missing: string[];
}

function money(cents: number, currency: string | null): string {
  return `${currency ?? ''} ${(cents / 100).toFixed(2)}`.trim();
}

export function formatMoney(cents: number | null, currency: string | null): string {
  return cents === null ? 'not established' : money(cents, currency);
}

export function readEconomics(input: {
  products: readonly CommerceProduct[];
  facts: readonly CommerceFact[];
}): UnitEconomics[] {
  return input.products.map((product) =>
    readOne(product, input.facts.filter((one) => one.productId === product.id)),
  );
}

function readOne(product: CommerceProduct, facts: readonly CommerceFact[]): UnitEconomics {
  const prices = facts.filter(
    (one) => (one.finding === 'RETAIL_PRICE' || one.finding === 'COMPETITOR') && one.amountCents !== null,
  );
  const offers = facts.filter((one) => one.finding === 'SUPPLIER_OFFER' && one.amountCents !== null);
  const costs = facts.filter((one) => one.finding === 'COST_LINE');

  const currencies = new Set<string>();
  for (const one of [...prices, ...offers, ...costs]) {
    if (one.currency) currencies.add(one.currency);
  }
  const currency = currencies.size === 1 ? [...currencies][0]! : null;

  const retail =
    prices.length > 0
      ? {
          lowCents: Math.min(...prices.map((one) => one.amountCents!)),
          highCents: Math.max(...prices.map((one) => one.amountCents!)),
          sellers: new Set(prices.map((one) => one.subject.toLowerCase())).size,
        }
      : null;

  const cheapest = [...offers].sort((a, b) => a.amountCents! - b.amountCents!)[0] ?? null;
  const supplier: ChosenSupplier | null = cheapest
    ? {
        subject: cheapest.subject,
        unitCostCents: cheapest.amountCents!,
        days: cheapest.days,
        sourceClaimId: cheapest.sourceClaimId,
      }
    : null;

  // The highest published figure per line: the conservative end, never an average.
  const worst = new Map<CommerceCostComponent, CommerceFact>();
  for (const one of costs) {
    const component = one.value as CommerceCostComponent;
    const held = worst.get(component);
    if (!held || perOrder(one, retail?.lowCents ?? 0) > perOrder(held, retail?.lowCents ?? 0)) {
      worst.set(component, one);
    }
  }

  const base: Omit<UnitEconomics, 'contributionBeforeAdsCents' | 'contributionAfterAdsCents' | 'budgetShare' | 'withheld' | 'missing' | 'lines'> = {
    productId: product.id,
    currency,
    retail,
    supplier,
    suppliers: offers.length,
  };

  const missing: string[] = [];
  if (!retail) missing.push('RETAIL_PRICE');
  if (!supplier) missing.push('SUPPLIER_OFFER');
  for (const component of LOAD_BEARING_COSTS) {
    if (!worst.has(component)) missing.push(component);
  }

  const lines: CostLine[] = [...worst.entries()].map(([component, fact]) => ({
    component,
    perOrderCents: perOrder(fact, retail?.lowCents ?? 0),
    published: fact.rateBps !== null ? { rateBps: fact.rateBps } : { amountCents: fact.amountCents ?? 0 },
    sourceClaimId: fact.sourceClaimId,
  }));

  const withhold = (why: string): UnitEconomics => ({
    ...base,
    lines,
    contributionBeforeAdsCents: null,
    contributionAfterAdsCents: null,
    budgetShare: null,
    withheld: why,
    missing,
  });

  if (currencies.size > 1) {
    return withhold(
      `the figures are published in ${[...currencies].sort().join(' and ')}, and Brain never ` +
        'converts a currency',
    );
  }
  if (missing.length > 0) {
    return withhold(`no published figure yet for ${missing.join(', ')}`);
  }

  const retailCents = retail!.lowCents;
  let before = retailCents - supplier!.unitCostCents;
  for (const line of lines) {
    if (line.component === 'AD_COST_PER_ORDER') continue;
    before -= line.perOrderCents;
  }
  const ad = lines.find((one) => one.component === 'AD_COST_PER_ORDER');
  return {
    ...base,
    lines,
    contributionBeforeAdsCents: before,
    contributionAfterAdsCents: ad ? before - ad.perOrderCents : null,
    budgetShare: retailCents > 0 ? before / retailCents : null,
    withheld: null,
    missing,
  };
}

/** A line's charge on one order. A rate is applied to the price and rounded up. */
function perOrder(fact: CommerceFact, retailCents: number): number {
  if (fact.rateBps !== null) return Math.ceil((retailCents * fact.rateBps) / 10_000);
  return fact.amountCents ?? 0;
}
