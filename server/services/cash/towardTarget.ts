/**
 * What a deal adds toward a goal's target — the one rule the quant engine
 * (`composeGoalModel`'s `goal_met`), the plan gate (`conservative`, the best
 * case, the deals a strategy needs) and the portfolio's spend share, so the
 * engine and the gate cannot disagree about whether the target is met
 * (planningReliability round 3, 2026-11-21).
 *
 * The defect it answers: the plan gate compared GROSS revenue with a NET target
 * ("net settled cash") while the engine subtracted cost, so 14 agreements worth
 * $23,560 read as "no new deals needed" against $12,000 although they keep
 * about $10,070, and a case needing 147 net-positive deals read as needing 13.
 *
 * Its own module because the portfolio (`goals/portfolio.ts`) and the engine
 * (`goalScenario.ts`) both read it and goalScenario already imports the
 * portfolio: a shared leaf keeps the import graph acyclic. Pure.
 */
import type { GoalMetric } from '../../domain/register.ts';
import type { ModelInput } from './goalScenario.ts';

/**
 * Whether a target counts money kept rather than money taken. A goal whose
 * words say net, profit or contribution is stored as `CONTRIBUTION`
 * (`readObjective`, `setTarget`), and its ledger reading subtracts every cost;
 * so does its plan. Any other metric counts what settles, as before.
 */
export function countsNet(metric: GoalMetric | null | undefined): boolean {
  return metric === 'CONTRIBUTION';
}

/** What `agreedCostUnits` reads of an opening. */
export interface AgreedTerms {
  agreedDeals: number;
  agreedValue: number;
  price: ModelInput;
}

/**
 * How many deals' direct cost the agreements already held carry. An agreement
 * is work still to deliver, so its cost is still to be paid, and it is the
 * larger of two readings:
 *   * the lots its value fills — agreements smaller than one deal share it, but
 *     the lot is bought whole: four stores taking $4,940 each of one $26,000
 *     truckload cost one truckload (the rule `agreedLots` applies to capital);
 *   * its value in deals — a $7,200 contract for a $2,700-a-month service is
 *     2.67 deals of work, never one.
 * With no price, one deal an agreement. Pure.
 */
export function agreedCostUnits(one: AgreedTerms): number {
  if (one.agreedDeals <= 0) return 0;
  const price = one.price.value ?? one.price.low;
  if (price === null || !(price > 0) || !(one.agreedValue > 0)) return one.agreedDeals;
  const share = one.agreedValue / price;
  const lots = Math.min(one.agreedDeals, Math.ceil(share - 1e-9));
  return Math.max(lots, share);
}

/**
 * The deals whose direct cost a plan pays: every new deal won, and what the
 * agreements already held carry (`agreedCostUnits`). The engine's `goal_met`
 * (`directCostTerm`), the plan's conservative figure and the portfolio's spend
 * all read this one count, so the engine and the gate cannot drift. Pure.
 */
export function costedDeals(won: number, one: AgreedTerms): number {
  return Math.max(0, won) + agreedCostUnits(one);
}

/** `costedDeals` × the opening's cost, as the engine's expression for opening `o` (e.g. `o2`). */
export function directCostTerm(o: string, one: AgreedTerms): string {
  return `(${o}_won + ${agreedCostUnits(one)}) * ${o}_cost`;
}

/**
 * One deal's direct cost as a plan sizes and bounds with it: the stated figure,
 * else a justified reconstruction's `end` (p90 'HIGH' for sizing what is needed, p10 'LOW'
 * for a best case), else zero. A cost nobody stated is the ECONOMICS link's to
 * refuse (`conservative` returns null on it); a blind sweep's bound never sizes
 * a strategy.
 */
export function costPerDeal(one: { directCost: ModelInput }, end: 'HIGH' | 'LOW' = 'HIGH'): number {
  const c = one.directCost;
  if (c.value !== null) return Math.max(0, c.value);
  const inferred = c.inferred?.justified ? c.inferred : null;
  const figure = end === 'HIGH' ? inferred?.p90 : inferred?.p10;
  return Math.max(0, figure ?? 0);
}

/**
 * What one new deal adds toward the target at `price`: the price, or — on a net
 * target — the price less the deal's direct cost (never below zero). Deals
 * needed are the remaining target ÷ this, never ÷ the price, when the target is net.
 */
export function perDealToward(one: { directCost: ModelInput }, price: number, net: boolean, end: 'HIGH' | 'LOW' = 'HIGH'): number {
  return net ? Math.max(0, price - costPerDeal(one, end)) : price;
}

/** What the agreements already held add toward the target: their value, less their deals' direct cost on a net target. */
export function agreedToward(one: AgreedTerms & { directCost: ModelInput }, net: boolean, end: 'HIGH' | 'LOW' = 'HIGH'): number {
  if (!net || one.agreedValue <= 0) return one.agreedValue;
  return one.agreedValue - costedDeals(0, one) * costPerDeal(one, end);
}
