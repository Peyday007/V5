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
import { checkCommercialAuthority } from '../cash/authority.ts';
import { listAdTests, listLaunches, listOrders } from '../../repos/commerceLaunch.ts';
import { adsConfig, storeConfig, supplierConfig, type ConnectionReading } from './connect/config.ts';
import { CONNECT_ADS, CONNECT_STORE, CONNECT_SUPPLIER } from './launch.ts';
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
  connections: ConnectionLine[];
  launches: {
    product: string;
    price: string | null;
    supplier: string | null;
    listed: boolean;
    problem: string | null;
    stopped: string | null;
    adTests: { round: number; state: string; spend: string; outcome: string | null }[];
  }[];
  orders: { name: string; amount: string; state: string; tracking: string | null; problem: string | null }[];
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

/**
 * Each connection selling needs, read now: the deployment's configuration and
 * the owner's grant, never a flag. A line that is not ready says exactly what
 * to set or grant (§74).
 */
export interface ConnectionLine {
  capability: string;
  state: 'READY' | 'NOT_CONNECTED' | 'NOT_GRANTED';
  needs: string;
}

export async function commerceConnections(projectId: string): Promise<ConnectionLine[]> {
  const lines: ConnectionLine[] = [];
  const pairs: [string, ConnectionReading, string, string][] = [
    ['A storefront', storeConfig(), 'LIST_PRODUCT', CONNECT_STORE],
    ['Ordering from a supplier', supplierConfig(), 'FULFIL_ORDER', CONNECT_SUPPLIER],
    ['Advertising', adsConfig(), 'RUN_ADS', CONNECT_ADS],
  ];
  for (const [capability, reading, action, connect] of pairs) {
    if (!reading.configured) {
      lines.push({ capability, state: 'NOT_CONNECTED', needs: `${connect} Missing: ${reading.problems.join(', ')}.` });
      continue;
    }
    const decision = await checkCommercialAuthority({ projectId, action });
    lines.push(
      decision.ok
        ? { capability, state: 'READY', needs: 'Nothing.' }
        : { capability, state: 'NOT_GRANTED', needs: `Add ${action} to the standing commercial authority (${decision.reason}).` },
    );
  }
  lines.push({
    capability: 'Taking a payment',
    state: storeConfig().configured ? 'READY' : 'NOT_CONNECTED',
    needs: storeConfig().configured
      ? 'Payments are set up in the store itself (Shopify Payments), in the owner’s name.'
      : 'Connect the store, then turn on Shopify Payments in its settings.',
  });
  return lines;
}

/** The connections, as the earlier sentence-list shape the view and CLI read. */
export const NOT_CONNECTED_CAPABILITIES = ['A storefront', 'Ordering from a supplier', 'Advertising', 'Taking a payment'] as const;

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
  const connections = await commerceConnections(projectId);
  const [launches, tests, orders] = await Promise.all([
    listLaunches(projectId),
    listAdTests(projectId),
    listOrders(projectId),
  ]);
  const productById = new Map(snapshot.products.map((one) => [one.id, one]));
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
    notConnected: connections
      .filter((one) => one.state !== 'READY')
      .map((one) => ({ capability: one.capability, needs: one.needs })),
    connections,
    launches: launches.map((launch) => ({
      product: productById.get(launch.productId)?.name ?? launch.productId,
      price: launch.priceCents === null ? null : formatMoney(launch.priceCents, launch.currency),
      supplier: launch.supplierName
        ? `${launch.supplierName}: ${formatMoney(launch.supplierUnitCents, 'USD')} + ${formatMoney(launch.supplierShippingCents, 'USD')} shipping, ${launch.supplierMaxDays ?? '?'} days`
        : null,
      listed: launch.storeProductId !== null,
      problem: launch.problem,
      stopped: launch.stopReason,
      adTests: tests
        .filter((test) => test.launchId === launch.id)
        .map((test) => ({
          round: test.round,
          state: test.state,
          spend: formatMoney(test.spendCents ?? 0, launch.currency ?? 'USD'),
          outcome: test.outcome,
        })),
    })),
    orders: orders.map((order) => ({
      name: order.storeOrderName,
      amount: formatMoney(order.amountCents, order.currency),
      state: order.state,
      tracking: order.trackingNumber,
      problem: order.problem,
    })),
  };
}
