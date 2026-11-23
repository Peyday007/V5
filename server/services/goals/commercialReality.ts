/**
 * The commercial reality check (§116; owner, 2026-11-23): the seven things
 * a strategy must establish before its money may count toward an accepted
 * plan. A strategy that fails any of them can still be modelled while
 * research looks for what it lacks, but it cannot be counted in an accepted
 * plan, and no simulation result makes up for a failed check.
 *
 *   1. PURCHASE: a real product or service is bought. A reward, prize,
 *      grant, rebate, settlement or wage is not a purchase (`paymentNatureOf`).
 *   2. BUYERS_BUY_IT: identifiable customers are shown buying it. The price
 *      rests on evidence about these buyers, not on an assumption or on a
 *      transfer from another market nobody has bridged.
 *   3. BUYER_POPULATION: a valid buyer population. One named organisation is
 *      one buyer and makes one deal unless evidence shows it buys again.
 *   4. ACQUISITION: a credible way to reach the buyers. A stated channel, or
 *      a buyer already in contact or agreed.
 *   5. VOLUME: the deals counted are evidenced. One deal needs its buyer; a
 *      second deal needs evidence of the volume.
 *   6. DELIVERY_AND_PAYMENT: someone named delivers it, and the money is
 *      collected before the deadline. Pay-on-award that is not shown to
 *      settle in time does not count.
 *   7. ECONOMICS: one deal still makes money at the unfavourable end of its
 *      price and cost.
 *
 * It reads only the fields the goal model already holds, which come from the
 * same evidence as the simulation, so the check and the model cannot disagree
 * about the facts. Pure.
 */
import { describesOneBody, namesOneOrganisation } from '../../domain/industry.ts';
import { nonPurchaseSentence, paymentNatureOf } from '../../domain/paymentNature.ts';
import type { ModelledOpportunity } from '../cash/goalScenario.ts';

export const REALITY_REQUIREMENTS = ['PURCHASE', 'BUYERS_BUY_IT', 'BUYER_POPULATION', 'ACQUISITION', 'VOLUME', 'DELIVERY_AND_PAYMENT', 'ECONOMICS'] as const;
export type RealityRequirement = (typeof REALITY_REQUIREMENTS)[number];

export interface RealityFailure {
  requirement: RealityRequirement;
  why: string;
}

export interface CommercialReality {
  opportunityId: string;
  validated: boolean;
  failing: RealityFailure[];
}

const EVIDENCED = new Set(['EVIDENCE', 'HISTORICAL']);

type Leg = Pick<ModelledOpportunity, 'opportunity' | 'price' | 'directCost' | 'volume' | 'repeatable' | 'daysToCash' | 'fulfilledBy' | 'competitiveAward' | 'agreed' | 'agreedDeals' | 'estimated'>;

/** The seven requirements of one strategy, as the goal model holds it. Pure. */
export function commercialRealityOf(leg: Leg, daysLeft: number | null): CommercialReality {
  const o = leg.opportunity;
  const failing: RealityFailure[] = [];
  const fail = (requirement: RealityRequirement, why: string) => failing.push({ requirement, why });
  const text = [o.title, o.offerScope, o.buyingSignal, o.source, leg.price.note].filter(Boolean).join('. ');
  const nature = paymentNatureOf(text);
  if (nature.nature !== 'PURCHASE') fail('PURCHASE', `its money is ${nonPurchaseSentence(nature)}`);
  if (!leg.agreed) {
    if (!EVIDENCED.has(leg.price.provenance)) fail('BUYERS_BUY_IT', `nothing shows these buyers paying this price (${leg.price.provenance.toLowerCase()}: ${leg.price.note.slice(0, 120)})`);
    else if (leg.estimated?.transfer && leg.estimated.transfer.unbridged.length > 0) fail('BUYERS_BUY_IT', `its price is carried from "${leg.estimated.transfer.precedent.slice(0, 60)}" with ${leg.estimated.transfer.unbridged.join(', ')} not bridged`);
  }
  const volumeHigh = leg.volume.high ?? leg.volume.value ?? 1;
  if (o.payer && (namesOneOrganisation(o.payer) || describesOneBody(o.payer)) && volumeHigh > 1 && !EVIDENCED.has(leg.volume.provenance)) fail('BUYER_POPULATION', `"${o.payer.slice(0, 60)}" is one organisation, counted for up to ${Math.round(volumeHigh)} deals with no evidence it buys more than once`);
  if (!leg.agreed && !o.reachableChannel) fail('ACQUISITION', 'no way to reach the buyers is established');
  if (!leg.agreed && leg.repeatable && volumeHigh > 1 && !EVIDENCED.has(leg.volume.provenance)) fail('VOLUME', `up to ${Math.round(volumeHigh)} deals counted, and nothing establishes that many (${leg.volume.note.slice(0, 120)})`);
  if (!leg.fulfilledBy && !o.fulfillmentOwner) fail('DELIVERY_AND_PAYMENT', 'nobody is named to deliver it');
  const settles = leg.daysToCash.high ?? leg.daysToCash.value;
  if (leg.competitiveAward && !EVIDENCED.has(leg.daysToCash.provenance)) fail('DELIVERY_AND_PAYMENT', 'it is paid on an award after the work, and nothing shows the money arriving in time');
  else if (daysLeft !== null && settles !== null && EVIDENCED.has(leg.daysToCash.provenance) && (leg.daysToCash.low ?? settles) > daysLeft) fail('DELIVERY_AND_PAYMENT', `its money arrives after ${leg.daysToCash.low ?? settles} days, past the ${daysLeft} days left`);
  const priceLow = leg.price.low ?? leg.price.value;
  const costHigh = leg.directCost.high ?? leg.directCost.value ?? 0;
  if (priceLow !== null && priceLow - costHigh <= 0) fail('ECONOMICS', `at its lowest price (${priceLow}) and highest direct cost (${costHigh}) one deal loses money`);
  return { opportunityId: o.id, validated: failing.length === 0, failing };
}

/** A plan's check: every strategy its money counts must pass. Pure. */
export function planCommercialReality(legs: readonly Leg[], daysLeft: number | null): { validated: boolean; failing: string[]; legs: CommercialReality[] } {
  const read = legs.map((leg) => commercialRealityOf(leg, daysLeft));
  const failing = read.flatMap((one) => one.failing.map((f) => `${one.opportunityId}: ${f.requirement} — ${f.why}`));
  return { validated: read.length > 0 && failing.length === 0, failing: read.length === 0 ? ['no strategy is counted'] : failing, legs: read };
}
