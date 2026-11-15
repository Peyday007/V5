/**
 * One adapter between the two construction vocabularies (W-8).
 *
 * §82's transaction `Design` (`cash/properties.ts`) says who fulfils, who
 * pays, how buyers aggregate, when money moves and what recurs; §92's
 * `Position` (`domain/construction.ts`) says what the operation holds with the
 * buyer, how the work gets done, whose assets do it, whether capacity is
 * shared and whether it runs an information layer. They describe the same
 * thing from two sides, and until this adapter a mechanism proven in one could
 * not be read in the other: a presold, pooled design a held opening shows
 * working was invisible to positions and to the world map.
 *
 * Money timing and recurrence are now Position dimensions (the design's own
 * sets, `MONEY_TIMINGS` and `RECURRENCES`), so the translation keeps them.
 * Where one vocabulary holds something the other cannot say — a position paid
 * by subscription, rent or financing has no §82 capture structure — the
 * adapter answers null rather than a nearest guess. The one lossy direction is
 * documented on `designToPosition`.
 *
 * Pure: no rows, no clock.
 */
import { coherent, type Design, type Structure } from '../../cash/properties.ts';
import { revenueOf, type Position } from '../../../domain/construction.ts';

/**
 * The §92 position a §82 design occupies.
 *
 * `needsEquipment` decides whose assets do the work, exactly as
 * `coherentPosition` reads it: independent supply brings its own equipment
 * (CONTRACTOR) where the work needs any, and holds none otherwise.
 *
 * Lossy in two places, both because §92 has one position for two designs:
 * SUBCONTRACT with several buyers pooled is the POOL position (a prime
 * contract over shared independent capacity), so it reads back as POOL; and a
 * BROKER pooling buyers is still an introduction, which holds no shared
 * capacity (`coherentPosition`), so it reads back with one buyer at a time —
 * or not at all when it was presold, since a presale needs pooled buyers.
 */
export function designToPosition(d: Design, needsEquipment: boolean): Position {
  const theirs = needsEquipment ? 'CONTRACTOR' : 'NONE';
  const pooled = d.aggregation === 'POOLED_BUYERS' ? 'POOLED' : 'SINGLE';
  let p: Position;
  switch (d.base) {
    // Brain produces the deliverable under its own contract with its own capacity.
    case 'PRODUCE':
      p = { contract: 'PRIME', supply: 'EMPLOY', assets: needsEquipment ? 'LEASED' : 'NONE', aggregation: pooled, information: 'NONE' };
      break;
    // A commission on a sale the supplier makes: an introduction.
    case 'BROKER':
      p = { contract: 'INTRODUCE', supply: 'NETWORK', assets: theirs, aggregation: 'SINGLE', information: 'NONE' };
      break;
    // The supplier pays per referral: we represent the supplier to buyers.
    case 'REFERRAL':
      p = { contract: 'REPRESENT', supply: 'NETWORK', assets: theirs, aggregation: 'SINGLE', information: 'NONE' };
      break;
    case 'SUBCONTRACT':
      p = { contract: 'PRIME', supply: 'NETWORK', assets: theirs, aggregation: pooled, information: 'NONE' };
      break;
    case 'POOL':
      p = { contract: 'PRIME', supply: 'NETWORK', assets: theirs, aggregation: 'POOLED', information: 'NONE' };
      break;
  }
  if (d.funding !== 'ON_DELIVERY') p.moneyTiming = d.funding;
  if (d.repeat !== 'ONE_OFF') p.recurrence = d.repeat;
  return p;
}

/**
 * The §82 design a §92 position is, or null where the design vocabulary has
 * no structure for it (a subscription, rent or financing book; the operator
 * doing the work; a placement) or the result would not be a coherent design.
 */
export function positionToDesign(p: Position): Design | null {
  const revenue = revenueOf(p);
  let base: Structure | null = null;
  if (revenue === 'FEE' && p.contract === 'INTRODUCE' && p.supply === 'NETWORK') base = 'BROKER';
  else if (revenue === 'FEE' && p.contract === 'REPRESENT' && p.supply === 'NETWORK') base = 'REFERRAL';
  else if ((revenue === 'SERVICE' || revenue === 'RESALE' || revenue === 'COMBINED') && p.contract === 'PRIME' && p.supply === 'NETWORK') {
    base = p.aggregation === 'POOLED' ? 'POOL' : 'SUBCONTRACT';
  } else if (revenue === 'SERVICE' && p.contract === 'PRIME' && p.supply === 'EMPLOY') base = 'PRODUCE';
  if (!base) return null;
  const d: Design = {
    base,
    funding: p.moneyTiming ?? 'ON_DELIVERY',
    aggregation: p.aggregation === 'POOLED' ? 'POOLED_BUYERS' : 'SINGLE',
    repeat: p.recurrence ?? 'ONE_OFF',
  };
  return coherent(d) ? d : null;
}
