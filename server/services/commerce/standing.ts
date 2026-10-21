/**
 * Where each product stands, derived from rows and stored nowhere (§73).
 *
 * The ladder is ON_MAP → DEMAND_SEEN → SOURCED → PRICED → COSTED → QUALIFIED,
 * and it stops at the first rung that is not met rather than reporting the
 * highest anything satisfied. Three verdicts sit beside it and end pursuit:
 * BLOCKED (a published rule forbids selling it), THIN_MARGIN (it is costed and
 * one order cannot pay to win a customer), and STALE (nothing says it is
 * still selling).
 *
 * The thresholds are this operation's own policy, in code where a reviewer
 * can see them, and every one of them can only make a product harder to
 * qualify. An unknown never satisfies one: a supplier whose delivery time
 * nobody published has not met a delivery bar, and a demand signal with no
 * date is not evidence that anything is selling now.
 */
import type { CommerceFact, CommerceProduct } from '../../domain/types.ts';
import { formatMoney, type UnitEconomics } from './economics.ts';

/** How recent the newest demand signal must be for a product to count as selling now. */
export const DEMAND_FRESH_MS = 90 * 24 * 60 * 60 * 1000;

/** Independent demand signals a product needs before it can qualify. */
export const MIN_DEMAND_SOURCES = 2;

/** The least one order must leave to spend on winning a customer. */
export const MIN_ACQUISITION_BUDGET_CENTS = 1500;

/** That budget as a share of the retail price. Below it, advertising rarely pays. */
export const MIN_BUDGET_SHARE = 0.35;

/** The slowest published delivery a qualified product may have. */
export const MAX_QUALIFIED_DELIVERY_DAYS = 20;

/** Rules that end pursuit outright, rather than becoming a condition. */
const BLOCKING_RULES = new Set(['PROHIBITED_ITEM', 'INTELLECTUAL_PROPERTY']);

export const COMMERCE_STAGES = [
  'ON_MAP',
  'DEMAND_SEEN',
  'SOURCED',
  'PRICED',
  'COSTED',
  'QUALIFIED',
  'THIN_MARGIN',
  'BLOCKED',
  'STALE',
  'RETIRED',
] as const;
export type CommerceStage = (typeof COMMERCE_STAGES)[number];

export interface ProductStanding {
  productId: string;
  name: string;
  productKey: string;
  stage: CommerceStage;
  /** Why it is where it is, in one sentence the server composed. */
  because: string;
  /** Dated demand signals inside the freshness window, and how many sources gave them. */
  freshDemand: number;
  demandSources: number;
  latestDemandOn: string | null;
  niches: string[];
  complaints: string[];
  /** Published rules that do not end pursuit but a person must read before selling. */
  conditions: string[];
  economics: UnitEconomics;
}

/** True for the stages a follow-up question can still move. */
export function isPursuable(stage: CommerceStage): boolean {
  return stage !== 'BLOCKED' && stage !== 'THIN_MARGIN' && stage !== 'RETIRED';
}

export function readStanding(input: {
  products: readonly CommerceProduct[];
  facts: readonly CommerceFact[];
  economics: readonly UnitEconomics[];
  now?: number;
}): ProductStanding[] {
  const now = input.now ?? Date.now();
  return input.products.map((product) => {
    const facts = input.facts.filter((one) => one.productId === product.id);
    const economics = input.economics.find((one) => one.productId === product.id)!;
    return standOne(product, facts, economics, now);
  });
}

function standOne(
  product: CommerceProduct,
  facts: readonly CommerceFact[],
  economics: UnitEconomics,
  now: number,
): ProductStanding {
  const demand = facts.filter((one) => one.finding === 'PRODUCT_DEMAND');
  const dated = demand
    .map((one) => ({ one, at: one.observedOn ? Date.parse(one.observedOn) : Number.NaN }))
    .filter((entry) => Number.isFinite(entry.at));
  const fresh = dated.filter((entry) => now - entry.at <= DEMAND_FRESH_MS);
  const sources = new Set(
    fresh.map((entry) => (entry.one.publisher ?? entry.one.subject).toLowerCase()),
  );
  const latest = dated.reduce<number | null>((max, entry) => (max === null || entry.at > max ? entry.at : max), null);

  const rules = facts.filter((one) => one.finding === 'RESTRICTION');
  const blocking = rules.filter((one) => BLOCKING_RULES.has(one.value ?? ''));
  const conditions = rules
    .filter((one) => !BLOCKING_RULES.has(one.value ?? ''))
    .map((one) => `${one.value}: ${one.subject}`);

  const base = {
    productId: product.id,
    name: product.name,
    productKey: product.productKey,
    freshDemand: fresh.length,
    demandSources: sources.size,
    latestDemandOn: latest === null ? null : new Date(latest).toISOString().slice(0, 10),
    niches: [...new Set(facts.filter((one) => one.finding === 'NICHE_SIGNAL').map((one) => one.subject))],
    complaints: [
      ...new Set(facts.filter((one) => one.finding === 'CUSTOMER_COMPLAINT').map((one) => one.subject)),
    ],
    conditions,
    economics,
  };
  const at = (stage: CommerceStage, because: string): ProductStanding => ({ ...base, stage, because });

  if (product.retiredAt) return at('RETIRED', `Retired: ${product.retiredReason ?? 'no reason recorded'}.`);
  if (blocking.length > 0) {
    return at(
      'BLOCKED',
      `A published rule ends pursuit: ${blocking.map((one) => `${one.value} (${one.subject})`).join('; ')}.`,
    );
  }
  if (dated.length === 0) {
    return at('ON_MAP', 'Named by a source, and no dated signal yet says it is selling.');
  }
  if (fresh.length === 0) {
    return at('STALE', `The newest demand signal is from ${base.latestDemandOn}, older than the window.`);
  }
  if (!economics.supplier) {
    return at('DEMAND_SEEN', `${fresh.length} recent demand signal(s); no supplier offer established yet.`);
  }
  if (!economics.retail) {
    return at('SOURCED', 'A supplier offer is established; no published retail price yet.');
  }
  if (economics.contributionBeforeAdsCents === null) {
    return at('PRICED', `Supplier and retail are known; the contribution is withheld: ${economics.withheld}.`);
  }

  const budget = economics.contributionBeforeAdsCents;
  const share = economics.budgetShare ?? 0;
  if (budget < MIN_ACQUISITION_BUDGET_CENTS || share < MIN_BUDGET_SHARE) {
    return at(
      'THIN_MARGIN',
      `One order leaves ${formatMoney(budget, economics.currency)} (${Math.round(share * 100)}% of ` +
        `the lowest retail price) to win a customer, below this operation's floor of ` +
        `${formatMoney(MIN_ACQUISITION_BUDGET_CENTS, economics.currency)} and ` +
        `${Math.round(MIN_BUDGET_SHARE * 100)}%.`,
    );
  }
  if (economics.contributionAfterAdsCents !== null && economics.contributionAfterAdsCents <= 0) {
    return at(
      'THIN_MARGIN',
      `A published advertising cost per order leaves ` +
        `${formatMoney(economics.contributionAfterAdsCents, economics.currency)} per order.`,
    );
  }

  const gaps: string[] = [];
  if (sources.size < MIN_DEMAND_SOURCES) {
    gaps.push(`${sources.size} independent recent demand source(s), and ${MIN_DEMAND_SOURCES} are needed`);
  }
  if (economics.supplier.days === null) {
    gaps.push(`no published delivery time from ${economics.supplier.subject}`);
  } else if (economics.supplier.days > MAX_QUALIFIED_DELIVERY_DAYS) {
    gaps.push(
      `${economics.supplier.subject} publishes ${economics.supplier.days} days to deliver, over ` +
        `${MAX_QUALIFIED_DELIVERY_DAYS}`,
    );
  }
  if (gaps.length > 0) {
    return at(
      'COSTED',
      `One order leaves ${formatMoney(budget, economics.currency)} to win a customer; not yet ` +
        `qualified: ${gaps.join('; ')}.`,
    );
  }
  return at(
    'QUALIFIED',
    `Selling now (${sources.size} sources, latest ${base.latestDemandOn}); one order leaves ` +
      `${formatMoney(budget, economics.currency)} (${Math.round(share * 100)}%) to win a customer, ` +
      `shipped by ${economics.supplier.subject} in ${economics.supplier.days} day(s).`,
  );
}
