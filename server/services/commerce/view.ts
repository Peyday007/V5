/**
 * The commerce kernel as a person reads it (§73), derived on the read path and
 * written nowhere. Reading it opens no round and creates no product.
 *
 * It says plainly which half of a dropshipping operation exists: the research
 * that finds a product and proves its numbers. The other half — a store, a
 * supplier account, a payment processor, an ad account, orders and
 * fulfilment — is listed by name as not connected, with what a person would
 * have to supply, because a status that implied a store existed would be the
 * most expensive lie this surface could tell.
 */
import { getCommerceProgramme } from '../../repos/commerce.ts';
import { commerceSnapshot } from './graph.ts';
import { planFrom } from './kernel.ts';
import { formatMoney } from './economics.ts';
import {
  MAX_QUALIFIED_DELIVERY_DAYS,
  MIN_ACQUISITION_BUDGET_CENTS,
  MIN_BUDGET_SHARE,
  MIN_DEMAND_SOURCES,
} from './standing.ts';
import type { CommerceProgramme } from '../../domain/types.ts';
import type { CommerceStage } from './standing.ts';

export interface CommerceProductView {
  id: string;
  name: string;
  stage: CommerceStage;
  because: string;
  demandSources: number;
  latestDemandOn: string | null;
  retail: string | null;
  supplier: { name: string; unitCost: string; days: number | null } | null;
  /** What one order leaves to spend on winning a customer, or why it is withheld. */
  acquisitionBudget: string;
  niches: string[];
  complaints: string[];
  conditions: string[];
}

export interface CommerceView {
  programme: CommerceProgramme | null;
  counts: Record<CommerceStage, number> & { products: number; openRounds: number };
  products: CommerceProductView[];
  openRounds: { id: string; purpose: string; product: string | null; round: number; createdAt: string }[];
  next: { purpose: string; product: string | null; why: string }[];
  policy: string[];
  notConnected: { capability: string; needs: string }[];
}

const ORDER: Record<CommerceStage, number> = {
  QUALIFIED: 0,
  COSTED: 1,
  PRICED: 2,
  SOURCED: 3,
  DEMAND_SEEN: 4,
  ON_MAP: 5,
  STALE: 6,
  THIN_MARGIN: 7,
  BLOCKED: 8,
  RETIRED: 9,
};

/** The half of the operation that does not exist yet, named rather than implied. */
export const NOT_CONNECTED: readonly { capability: string; needs: string }[] = Object.freeze([
  {
    capability: 'A storefront',
    needs: 'A store a person owns (Shopify or similar) and an admin API token set on the deployment.',
  },
  {
    capability: 'Taking a payment',
    needs: 'Payments enabled on that store, in the owner’s name.',
  },
  {
    capability: 'Ordering from a supplier',
    needs: 'A supplier account (CJ Dropshipping or similar) with its API key on the deployment, and a grant to place supplier orders.',
  },
  {
    capability: 'Advertising',
    needs: 'An ad account in the owner’s name, its token on the deployment, and a spending ceiling the owner sets.',
  },
  {
    capability: 'Orders, fulfilment and customer service',
    needs: 'Built after the three above exist; nothing here can be tested against a real order until then.',
  },
]);

export async function commerceView(projectId: string): Promise<CommerceView> {
  const programme = await getCommerceProgramme(projectId);
  const snapshot = await commerceSnapshot(projectId);
  const names = new Map(snapshot.products.map((one) => [one.productKey, one.name]));

  const counts = {
    ON_MAP: 0,
    DEMAND_SEEN: 0,
    SOURCED: 0,
    PRICED: 0,
    COSTED: 0,
    QUALIFIED: 0,
    THIN_MARGIN: 0,
    BLOCKED: 0,
    STALE: 0,
    RETIRED: 0,
    products: snapshot.products.length,
    openRounds: snapshot.openRounds,
  };
  for (const one of snapshot.standing) counts[one.stage] += 1;

  const products: CommerceProductView[] = [...snapshot.standing]
    .sort((a, b) => ORDER[a.stage] - ORDER[b.stage] || b.demandSources - a.demandSources || a.name.localeCompare(b.name))
    .map((one) => {
      const e = one.economics;
      return {
        id: one.productId,
        name: one.name,
        stage: one.stage,
        because: one.because,
        demandSources: one.demandSources,
        latestDemandOn: one.latestDemandOn,
        retail: e.retail
          ? e.retail.lowCents === e.retail.highCents
            ? formatMoney(e.retail.lowCents, e.currency)
            : `${formatMoney(e.retail.lowCents, e.currency)} to ${formatMoney(e.retail.highCents, e.currency)}`
          : null,
        supplier: e.supplier
          ? { name: e.supplier.subject, unitCost: formatMoney(e.supplier.unitCostCents, e.currency), days: e.supplier.days }
          : null,
        acquisitionBudget:
          e.contributionBeforeAdsCents === null
            ? `withheld: ${e.withheld}`
            : `${formatMoney(e.contributionBeforeAdsCents, e.currency)} per order`,
        niches: one.niches,
        complaints: one.complaints,
        conditions: one.conditions,
      };
    });

  const plan = programme ? planFrom(snapshot) : { asks: [], declined: [] };
  return {
    programme,
    counts,
    products,
    openRounds: snapshot.rounds
      .filter((one) => one.state === 'OPEN')
      .map((one) => ({
        id: one.id,
        purpose: one.purpose,
        product: one.productKey ? (names.get(one.productKey) ?? one.productKey) : null,
        round: one.round,
        createdAt: one.createdAt,
      })),
    next: plan.asks.map((one) => ({ purpose: one.purpose, product: one.productName, why: one.why })),
    policy: [
      `A product qualifies only with at least ${MIN_DEMAND_SOURCES} independent demand signals from the last 90 days.`,
      `One order must leave at least ${formatMoney(MIN_ACQUISITION_BUDGET_CENTS, 'USD')} and ` +
        `${Math.round(MIN_BUDGET_SHARE * 100)}% of the lowest retail price to spend on winning a customer.`,
      `The chosen supplier must publish delivery in ${MAX_QUALIFIED_DELIVERY_DAYS} days or fewer.`,
      'Every figure is the conservative published end, and a missing line withholds the total rather than being guessed.',
    ],
    notConnected: [...NOT_CONNECTED],
  };
}
