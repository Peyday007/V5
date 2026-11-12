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

/**
 * Words that describe the operator's own physical actions — being somewhere,
 * handing something out, shipping goods it holds. Unbrokered, these are owner
 * work and the opening is ruled out.
 */
const OWNER_PHYSICAL = new RegExp(
  [
    'door[- ]?hang(?:er|ers|ing)',
    'flyers? (?:distribution|drop)',
    'hand(?:ing)? out (?:flyers|cards|leaflets)',
    'door[- ]to[- ]door',
    'canvass(?:ing)?',
    'in[- ]person',
    '(?:preview|local|curbside|in-store) (?:and )?pick[- ]?up',
    'pick[- ]?up (?:and|from|at) ',
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

/**
 * Physical services a customer buys — cleaning, mowing, hauling, installs, a
 * handyman. Somebody performs them on site, and that somebody is never the
 * owner, so such an opening is a service this operation can only sell and
 * coordinate while an independent provider performs it (owner, 2026-11-07:
 * "My restriction is against ME performing physical work, not against selling
 * or brokering services fulfilled by other people"). Until research names that
 * provider the reading is UNKNOWN — a question about who performs it — and
 * never a refusal: before 2026-11-07 these words alone ruled the opening out,
 * so home-service brokerage was screened before anyone could look for the crew.
 */
const PHYSICAL_SERVICE = new RegExp(
  [
    'on[- ]site',
    'onsite',
    'haul(?:ing)?',
    '(?:light|lighting|fixture|equipment|hvac|solar|fence|flooring|cabinet|appliance|decor(?:ation)?)s? install(?:ation|ations|ing|s)?',
    'install(?:ing)? (?:the )?(?:lights|fixtures|equipment|decorations)',
    'take[- ]?down',
    'set[- ]?up and remov',
    '(?:house|home|office|gutter|leaf|leaves|window|carpet|deep|move[- ]out|post[- ]construction|pressure|power) (?:clean|wash)(?:ing|up|-up)?',
    'mow(?:ing)?',
    'lawn (?:care|service)',
    'snow (?:removal|plowing|plow)',
    'moving (?:labor|help|service)',
    'junk removal',
    'yard work',
    'landscap(?:e|ing)',
    'handyman',
    'pest control',
    'pet (?:sitting|grooming)|dog walking',
    'repair(?:s)? (?:at|in) (?:home|the home)',
  ].join('|'),
  'i',
);

/**
 * Words that say the operator would be the one taking per-job physical work —
 * a gig a platform hands to its drivers or couriers. "Independent contractor"
 * here describes the operator's own status, not somebody it brokers to, so no
 * brokered wording rescues it (production, 2026-11-03: "DropCurb engages drivers
 * per completed pickup … as independent contractors").
 */
const OWNER_AS_GIG_WORKER =
  /\b(?:drivers? per (?:completed )?(?:pickup|delivery|job|trip)|per completed (?:pickup|delivery|job|trip)|become an? (?:driver|courier|dasher|shopper|tasker|hauler)|sign up (?:to|as an?) (?:drive|driver|courier))\b/i;

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
    'book(?:s|ed|ing|ings)? (?:the |a |local )?(?:pros?|providers?|crews?|contractors?|cleaners?|movers?|technicians?)',
    'dispatch(?:es|ed|ing)?',
    'outsourc(?:e|es|ed|ing)',
    'white[- ]label(?:ed)?',
    'partner network',
    '(?:vetted|local|independent) (?:pros|professionals|providers|contractors|crews|technicians)',
    'connects? (?:homeowners|households|customers|clients|buyers) (?:with|to)',
    'contractor network',
    'service marketplace',
    'concierge',
    'engages? (?:independent )?(?:drivers|couriers|haulers|cleaners|movers|crews|contractors) as (?:independent )?(?:subcontractors|contractors)',
    'fulfil(?:l)?ed by (?:a|an|the|local|independent) (?:supplier|partner|vendor|contractor|printer|crew|provider)',
  ].join('|'),
  'i',
);

/** Words that say this operation arranges the work for a fee, rather than doing it. */
const COORDINATES =
  /\b(?:broker(?:age|ed|ing|s)?|referr(?:al|als|ing)|commission|finder'?s fee|subcontract(?:s|ed|ing)? (?:the |each |every )?(?:jobs?|work|orders?|deliver(?:y|ies)|pickups?|moves?)|lead[- ]?gen(?:eration)?|per lead|matchmak(?:ing|er)|marketplace (?:fee|commission|take rate)|dispatch(?:es|ed|ing)? (?:the )?(?:jobs?|orders?|pickups?|deliver(?:y|ies)) to)\b/i;

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
  /** The opening's mechanism (`SUBCONTRACTED_FULFILMENT`, …), where recorded. */
  mechanism?: string | null;
  /** Anything else recorded about the economics or payment that can name a fulfiller. */
  notes?: string | null;
}

/** Mechanisms that are, by definition, somebody else performing the work this operation sells. */
const BROKERED_MECHANISMS = new Set(['SUBCONTRACTED_FULFILMENT', 'SUPPLY_DEMAND_MISMATCH', 'BROKERAGE', 'REFERRAL_FEE', 'LEAD_GENERATION', 'MARKETPLACE']);

/** Every recorded field of an opening that can say who performs it. */
export function operatingFactsOf(o: {
  title: string;
  offerScope?: string | null;
  fulfillmentOwner?: string | null;
  mechanism?: string | null;
  deliveryMethod?: string | null;
  economicsNote?: string | null;
  paymentTerms?: string | null;
}): OperatingFacts {
  return {
    title: o.title,
    offerScope: o.offerScope ?? null,
    fulfillmentOwner: o.fulfillmentOwner ?? null,
    mechanism: o.mechanism ?? null,
    delivery: o.deliveryMethod ?? null,
    notes: [o.economicsNote, o.paymentTerms].filter(Boolean).join(' \n ') || null,
  };
}

/** Pure: whether delivering this opening would need the owner's physical work. */
export function operatingFit(facts: OperatingFacts): OperatingFit {
  const words = [facts.title, facts.offerScope, facts.captureMechanism, facts.delivery, facts.notes].filter(Boolean).join(' \n ');
  const fulfiller = facts.fulfillmentOwner?.trim() ?? '';
  const physical = words.match(OWNER_PHYSICAL)?.[0] ?? null;
  const service = words.match(PHYSICAL_SERVICE)?.[0] ?? null;
  const brokeredMechanism = facts.mechanism && BROKERED_MECHANISMS.has(facts.mechanism) ? facts.mechanism.toLowerCase().replace(/_/g, ' ') : null;
  // Words can excuse any physical part; a recorded mechanism vouches only for a service someone else performs.
  const brokeredWords = words.match(BROKERED)?.[0] ?? null;
  const brokered = brokeredWords ?? (service ? brokeredMechanism : null);
  const ownFulfiller = fulfiller !== '' && OWNER_OR_BRAIN.test(fulfiller) && !THIRD_PARTY_FULFILLER.test(fulfiller);
  const thirdParty = fulfiller && THIRD_PARTY_FULFILLER.test(fulfiller) && !OWNER_OR_BRAIN.test(fulfiller);
  const gig = words.match(OWNER_AS_GIG_WORKER)?.[0] ?? null;
  /*
   * A listing that recruits drivers or movers is a gig the operator would do
   * itself. An arrangement that brokers jobs to them — a referral fee, a
   * commission, a dispatched order — is B2C logistics coordinated online. The
   * gig test ran first and ruled both out; "independent contractor" alone is
   * how a gig platform describes its own workers, so it does not count.
   */
  const coordinates = words.match(COORDINATES)?.[0] ?? null;
  if (gig && !coordinates) {
    return { kind: 'OWNER_PHYSICAL', because: `it is per-job physical work the operator would do itself ("${gig}"); the owner does no physical work` };
  }
  if (gig) {
    return { kind: 'BROKERED_PHYSICAL', because: `independent workers do the physical part ("${gig}") and this operation coordinates them online ("${coordinates}")` };
  }
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
  // Named as the owner's own work it is the owner's, whatever the mechanism says.
  if (service && ownFulfiller && !brokeredWords) {
    return { kind: 'OWNER_PHYSICAL', because: `the service ("${service}") would be performed by ${fulfiller}; the owner does no physical work` };
  }
  if (service && (brokered || thirdParty)) {
    return { kind: 'BROKERED_PHYSICAL', because: `the service ("${service}") is performed by ${thirdParty ? fulfiller : 'an independent provider'} and sold and coordinated online ("${brokered ?? fulfiller}")` };
  }
  if (service) {
    return {
      kind: 'UNKNOWN',
      because: `a physical service ("${service}") that this operation can only sell and coordinate: which independent provider performs it is not yet established`,
    };
  }
  if (brokered || thirdParty) return { kind: 'BROKERED_PHYSICAL', because: `coordinated online ("${brokered ?? fulfiller}")` };
  return words.trim() ? { kind: 'REMOTE', because: 'nothing in it needs anybody physically present' } : { kind: 'UNKNOWN', because: 'nothing recorded says how it is delivered' };
}

/** Whether a reading rules the opening out under the standing rule. */
export function breaksOperatingModel(fit: OperatingFit): boolean {
  return fit.kind === 'OWNER_PHYSICAL';
}

/**
 * The line every kernel's research question opens its context with, carrying the
 * standing rule — one place, so no kernel can ask a question without it.
 */
export function sprintGoalLine(objective: string, lead = 'This is for'): string {
  return `${lead} a short cash sprint whose goal is: ${objective} ${OPERATING_MODEL_SENTENCE}`;
}
