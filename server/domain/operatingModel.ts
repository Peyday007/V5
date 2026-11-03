/**
 * How this operation runs: online, with AI and software doing the work, and
 * the owner doing no physical work. A standing rule of the whole Brain, not one
 * goal's instruction (owner, 2026-11-02: "I DO NOT WANT TO PERFORM PHYSICAL
 * WORK … This must become a permanent rule throughout Brain").
 *
 * It decides three things everywhere an opening is found, researched,
 * constructed, qualified, ranked or planned:
 *
 * 1. The owner never travels, delivers, distributes, meets customers, performs
 *    a service or manages a physical operation.
 * 2. Physical work is still in scope when an independent supplier or
 *    subcontractor performs it and the arrangement is coordinated online —
 *    brokering physical services remotely is a business this rule keeps.
 * 3. Geography is a business variable. No market is preferred because the
 *    owner lives near it; markets are chosen on demand, margin, fulfilment
 *    access, cash timing, competition and how much can be automated.
 *
 * The reading is made from an opening's own words and its recorded fulfiller,
 * by matching, never by a model deciding what somebody meant — the same
 * discipline `cash/exclusions.ts` keeps. An opening it cannot classify is
 * UNKNOWN, which is a question, never a pass and never a refusal
 * (invariant 39).
 */

/** The rule as research questions state it. Kept clear of `CASH_FORBIDDEN_ACTIONS`. */
export const OPERATING_MODEL_SENTENCE =
  'This operation is run entirely online, with AI and software doing as much of the work as ' +
  'possible: the owner does no physical work — no travel, no deliveries, no distributing ' +
  'anything, no meeting customers, no performing a service and no running a physical ' +
  'operation. Work that is physical is still in scope when an independent supplier or ' +
  'subcontractor performs it and this operation coordinates it remotely, as a broker, ' +
  'referrer or subcontracting coordinator. Look in every country and region: where the ' +
  'buyers are is a business choice made on demand, margin, fulfilment access, how fast money ' +
  'settles, competition and how much can be automated — never on where the owner lives.';

/** Words that say the operator would have to be physically present or do the work. */
const OWNER_PHYSICAL = new RegExp(
  [
    'door[- ]?hang(?:er|ers|ing)',
    'flyers? (?:distribution|drop)',
    'hand(?:ing)? out (?:flyers|cards|leaflets)',
    'door[- ]to[- ]door',
    'canvass(?:ing)?',
    'in[- ]person',
    'on[- ]site',
    'onsite',
    '(?:preview|local|curbside|in-store) (?:and )?pick[- ]?up',
    'pick[- ]?up (?:and|from|at) ',
    'haul(?:ing)?',
    '(?:light|lighting|fixture|equipment|hvac|solar|fence|flooring|cabinet|appliance|decor(?:ation)?)s? install(?:ation|ations|ing|s)?',
    'install(?:ing)? (?:the )?(?:lights|fixtures|equipment|decorations)',
    'take[- ]?down',
    'set[- ]?up and remov',
    '(?:house|home|office|gutter|leaf|leaves|window|carpet|deep|move[- ]out|post[- ]construction) clean(?:ing|up|-up)?',
    'mow(?:ing)?',
    'snow (?:removal|plowing|plow)',
    'moving (?:labor|help)',
    'junk removal',
    'yard work',
    'handyman',
    'drive to',
    'local presence',
    'physical(?:ly)? (?:present|presence|attend|deliver|inspect)',
    'pack(?:ing)? and ship',
    'deliver(?:ed|ing|y|ies)? (?:it |them )?(?:to (?:homes|houses|customers|the door|each)|door)',
    'hand[- ]deliver',
    // Reselling physical goods the operator would have to receive, hold and ship.
    'stockx',
    'goat\\.com',
    'sneakers?',
    'air jordan',
    'nike (?:dunk|kobe|air)',
    'retail arbitrage',
    'liquidation (?:pallets?|lots?|stock)',
    'pallets? of',
    'surplus (?:auction|lots?)',
    'auction lots?',
    'copart',
    'salvage (?:car|vehicle)s?',
    // Gig work the operator would do in person.
    'drivers? (?:per|for|to|who)',
    'gig (?:driver|driving|work)',
    'courier',
    'rideshare',
  ].join('|'),
  'i',
);

/** Words that say somebody else performs the physical part and this operation coordinates it. */
const BROKERED = new RegExp(
  [
    'broker(?:age|ed|ing|s)?',
    'referr(?:al|als|ing)',
    'refer (?:them|it|buyers|customers)',
    'commission',
    "finder'?s fee",
    'subcontract(?:ed|or|ors|ing)?',
    'independent (?:contractor|installer|crew|supplier|provider|cleaner|mover)s?',
    'drop[- ]?ship(?:ping|ped|per|s)?',
    'supplier (?:ships|delivers|fulfils|fulfills|performs)',
    'ships? (?:direct|directly) to',
    'lead[- ]?gen(?:eration)?',
    'sell(?:ing)? (?:the )?leads',
    'leads? sold to',
    'per lead',
    'leads? (?:to|for) (?:local )?(?:contractors|installers|providers|crews|movers|cleaners|haulers)',
    'matchmak(?:ing|er)',
    'marketplace (?:fee|commission|take rate)',
    'print[- ]on[- ]demand',
    'fulfil(?:l)?ed by (?:a|an|the|local|independent) (?:supplier|partner|vendor|contractor|printer|crew|provider)',
  ].join('|'),
  'i',
);

/** A recorded fulfiller that is a third party rather than the owner or Brain. */
const THIRD_PARTY_FULFILLER =
  /\b(?:contractor|subcontractor|supplier|vendor|partner|installer|crew|printer|manufacturer|wholesaler|provider|company|agency|studio|dropship)s?\b/i;
const OWNER_OR_BRAIN = /\b(?:brain|owner|me|myself|we|us|our team|a person|peyton)\b/i;

export type OperatingFit =
  /** Sold, delivered and managed online by Brain and software. */
  | { kind: 'REMOTE'; because: string }
  /** Physical work exists, and a third party performs it while this operation coordinates. */
  | { kind: 'BROKERED_PHYSICAL'; because: string }
  /** Delivering it would need the owner to do physical work. Never pursued. */
  | { kind: 'OWNER_PHYSICAL'; because: string }
  /** Nothing said either way: asked, never assumed. */
  | { kind: 'UNKNOWN'; because: string };

export interface OperatingFacts {
  title: string;
  offerScope?: string | null;
  fulfillmentOwner?: string | null;
  /** How we would be paid, where recorded. */
  captureMechanism?: string | null;
  /** What delivering it takes, where recorded. */
  delivery?: string | null;
}

/** Pure: whether delivering this opening would need the owner's physical work. */
export function operatingFit(facts: OperatingFacts): OperatingFit {
  const words = [facts.title, facts.offerScope, facts.captureMechanism, facts.delivery].filter(Boolean).join(' \n ');
  const fulfiller = facts.fulfillmentOwner?.trim() ?? '';
  const physical = words.match(OWNER_PHYSICAL)?.[0] ?? null;
  const brokered = words.match(BROKERED)?.[0] ?? null;
  const thirdParty = fulfiller && THIRD_PARTY_FULFILLER.test(fulfiller) && !OWNER_OR_BRAIN.test(fulfiller);
  if (physical && (brokered || thirdParty)) {
    return {
      kind: 'BROKERED_PHYSICAL',
      because: `the physical part ("${physical}") is performed by ${thirdParty ? fulfiller : 'an independent party'} and coordinated online ("${brokered ?? fulfiller}")`,
    };
  }
  if (physical) {
    return {
      kind: 'OWNER_PHYSICAL',
      because: `delivering it needs physical work ("${physical}") and nothing names an independent supplier or subcontractor to perform it; the owner does no physical work`,
    };
  }
  if (brokered || thirdParty) return { kind: 'BROKERED_PHYSICAL', because: `coordinated online ("${brokered ?? fulfiller}")` };
  return words.trim() ? { kind: 'REMOTE', because: 'nothing in it needs anybody physically present' } : { kind: 'UNKNOWN', because: 'nothing recorded says how it is delivered' };
}

/** Whether a reading rules the opening out under the standing rule. */
export function breaksOperatingModel(fit: OperatingFit): boolean {
  return fit.kind === 'OWNER_PHYSICAL';
}
