/**
 * What kind of opening a claim establishes, as a closed vocabulary.
 *
 * ---------------------------------------------------------------------------
 * Why this is typed rather than matched
 * ---------------------------------------------------------------------------
 *
 * Deciding whether an accepted claim is a *piece of work* used to be a string
 * comparison: `harvest()` accepted a claim whose `evidence_lane` was the
 * literal `demand_signal`. Fragment planners name their own lanes — the gate
 * counts coverage per declared id, which is the point of a lane — so the two
 * halves were never speaking the same vocabulary. Production wrote seventeen
 * distinct lane ids across 82 claims and `demand_signal` appears zero times.
 * The bridge could not fire, and no amount of correct research was going to
 * make it.
 *
 * Widening the match would have been the wrong repair, because it would make
 * "is this a piece of work" depend on how a planner worded an identifier —
 * model output deciding state, which §8 keeps out. So a claim *declares* a
 * signal from this set, the declaration is validated exactly on submission, and
 * anything outside the set refuses the whole submission rather than being
 * stored and compared against nothing.
 *
 * ---------------------------------------------------------------------------
 * What a signal is, and what it is not
 * ---------------------------------------------------------------------------
 *
 * It says the claim establishes an opening of a named kind. It says nothing
 * about whether the opening is worth taking, what it pays, who the payer is or
 * whether Brain could deliver it — those are the card's unknowns, and a piece
 * arrives with them blank on purpose (§30). It is also **not** a replacement
 * for the evidence lane: lanes carry coverage and remain exactly as they were,
 * because "which question does this answer" and "does this describe an opening"
 * are different questions about one claim.
 *
 * A claim with no signal is ordinary descriptive evidence. That is the common
 * case and it is not a deficiency: most of a good fragment's claims establish
 * the context an opening is read in.
 */
import { OPPORTUNITY_SIGNALS, type CashMechanism, type OpportunitySignal } from './types.ts';

export { OPPORTUNITY_SIGNALS };
export type { OpportunitySignal };

export function isOpportunitySignal(value: unknown): value is OpportunitySignal {
  return typeof value === 'string' && (OPPORTUNITY_SIGNALS as readonly string[]).includes(value);
}

/**
 * The mechanism a piece of the portfolio gets from its own signal.
 *
 * Read from the claim rather than from the bucket that happened to ask the
 * question. A bucket is *where Brain looked*; the signal is *what was found*,
 * and one broad bucket routinely turns up openings of several kinds — the
 * information-asymmetry question produced buyer demand, pricing spreads and a
 * recurring brief in one packet. Taking the mechanism from the bucket would
 * file all of those under one heading that is wrong for most of them.
 */
const MECHANISM: Record<OpportunitySignal, CashMechanism> = {
  ACTIVE_BUYER_DEMAND: 'EXPLICIT_PAID_REQUEST',
  PAID_TASK_OR_CONTRACT: 'EXPLICIT_PAID_REQUEST',
  PRICING_OR_INFORMATION_ASYMMETRY: 'INFORMATION_ASYMMETRY',
  EXPIRING_OPENING: 'TEMPORARY_EXPLOIT',
  SUPPLY_DEMAND_MISMATCH: 'SUPPLY_DEMAND_MISMATCH',
  RESALABLE_ASSET_OPENING: 'RESALE_OR_ASSET',
  RECURRING_OUTSOURCED_WORK: 'PRODUCTIZED_SERVICE',
};

export function mechanismForSignal(signal: OpportunitySignal): CashMechanism {
  return MECHANISM[signal];
}

/**
 * Which signals name the same kind of opening.
 *
 * A worker declares a signal per claim, and two workers reading one RFQ
 * declared it `EXPIRING_OPENING` and `ACTIVE_BUYER_DEMAND`: production held six
 * records of one St. Louis RFQ split across those two, so a signal-exact
 * identity kept them apart. A buyer asking for something — with or without a
 * deadline, as a request or as a paid task — is one opening at one address.
 * The other kinds stay apart, because one price page can genuinely be both a
 * resale opening and a pricing asymmetry. A `Record` over the whole union, so a
 * signal added later is a compile error until somebody says which it joins.
 *
 * Read for identity (`duplicates.ts`) and for whose figures a signal's text
 * states (`proposeTerms`): only a buyer's request publishes what a buyer would
 * pay us.
 */
export const OPENING_FAMILY: Readonly<Record<OpportunitySignal, string>> = Object.freeze({
  ACTIVE_BUYER_DEMAND: 'BUYER_REQUEST',
  EXPIRING_OPENING: 'BUYER_REQUEST',
  PAID_TASK_OR_CONTRACT: 'BUYER_REQUEST',
  RECURRING_OUTSOURCED_WORK: 'RECURRING_OUTSOURCED_WORK',
  PRICING_OR_INFORMATION_ASYMMETRY: 'PRICING_OR_INFORMATION_ASYMMETRY',
  SUPPLY_DEMAND_MISMATCH: 'SUPPLY_DEMAND_MISMATCH',
  RESALABLE_ASSET_OPENING: 'RESALABLE_ASSET_OPENING',
});

/** One line per signal, for the prompt that asks a worker to choose one. */
export const SIGNAL_GUIDE: Record<OpportunitySignal, string> = {
  ACTIVE_BUYER_DEMAND:
    'a named buyer has published that they want something and it is open now',
  PAID_TASK_OR_CONTRACT:
    'a specific paid task, bounty, solicitation or contract with a stated payment',
  PRICING_OR_INFORMATION_ASYMMETRY:
    'the same deliverable at two published prices, or a fact somebody is visibly paying to obtain',
  EXPIRING_OPENING:
    'the source states a closing date, an expiry, or a limited remaining quantity',
  SUPPLY_DEMAND_MISMATCH:
    'a published demand and a published available supply that are not connected',
  RESALABLE_ASSET_OPENING:
    'an asset with a published asking price and published evidence of demand above it',
  RECURRING_OUTSOURCED_WORK:
    'one narrow brief commissioned repeatedly as separate custom jobs',
};

/**
 * The deadline a source publishes for an opening, validated, or null.
 *
 * One rule for both submission doors (the MCP tool and the provider path), for
 * the reason `validateMonetizationMethod` gives: a rule applied by one of two
 * readers is worse than none.
 *
 * Strict on purpose. YYYY-MM-DD and nothing else — no time, no zone, no prose —
 * because the reader (`closedBy` in services/cash/validation.ts) treats a bare
 * date as closing at the end of that day in UTC, and anything looser would be
 * a guess about which day was meant. A calendar date that does not exist is
 * refused rather than rolled over. And only alongside an opportunity signal: a
 * closing date belongs to an opening, and a claim that establishes no opening
 * has nothing for it to close.
 */
export function validateClosesOn(input: {
  where: string;
  closesOn: unknown;
  hasSignal: boolean;
}): { ok: true; value: string | null } | { ok: false; error: string } {
  const { where, closesOn } = input;
  if (closesOn === undefined || closesOn === null || closesOn === '') return { ok: true, value: null };
  if (typeof closesOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(closesOn)) {
    return {
      ok: false,
      error: `${where}: closes_on must be the published deadline as YYYY-MM-DD, or omitted.`,
    };
  }
  const parsed = new Date(`${closesOn}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== closesOn) {
    return { ok: false, error: `${where}: closes_on ${closesOn} is not a calendar date.` };
  }
  if (!input.hasSignal) {
    return {
      ok: false,
      error:
        `${where}: closes_on needs an opportunity_signal on the same claim. A closing date ` +
        'belongs to an opening, and this claim establishes none.',
    };
  }
  return { ok: true, value: closesOn };
}

/**
 * Whether a signal's own text publishes what a *buyer* would pay.
 *
 * Only a buyer's request does; a seller's page — a price list, a rate card, an
 * asking price — publishes what that seller charges. `proposeTerms` reads a
 * signal's figures as a price only when this holds, and the harvest refuses to
 * make an untagged claim an opening when its source is the seller's own page
 * (`sellersOwnPage`): the same distinction, read once from the tag and once
 * from the source, because an untagged claim has no tag to read it from. A
 * piece captured by hand has no signal, and its text is what the person
 * recorded as the request.
 */
export function isBuyerRequestSignal(signal: OpportunitySignal | null): boolean {
  return signal === null || OPENING_FAMILY[signal] === 'BUYER_REQUEST';
}

/** What a seller's page path is called: its price list, rate card or plans. */
const PRICE_PAGE_SEGMENT = /^(pricing|prices?|price-list|pricelist|rates?|rate-card|ratecard|plans|plans-and-pricing|pricing-plans|fees|fee-schedule|packages)$/i;
/** A seller speaking of its own prices. */
const SELLER_VERB = /\b(charges?|charging|publishes|lists|prices (?:its|at|from)|is priced|offers|sells|quotes|advertises|starts at|starting at)\b/i;
/** A currency beside a number, either order. */
const STATED_PRICE = /([$€£]\s?\d)|(\b(?:usd|eur|gbp)\s?\d)|(\d\s?(?:usd|eur|gbp|dollars?|euros?)\b)/i;
/** A listing of sellers for a searcher to choose from: a buyer's search, not a buyer's request. */
const SUPPLIER_LISTING = /\bnear me\b|^\s*(?:the\s+)?(?:top\s+)?\d+\s+best\b|^\s*(?:the\s+)?best\s+\d+\b|\bdirectory of\b/i;

function urlParts(url: string | null): { host: string; stem: string; path: string[] } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const stem = host.split('.')[0] ?? '';
    const path = parsed.pathname.split('/').filter(Boolean).map((segment) => segment.replace(/\.[a-z0-9]+$/i, ''));
    return { host, stem, path };
  } catch {
    return null;
  }
}

/**
 * Why an untagged claim's source is a seller's own page, or null when it is not.
 *
 * Lane promotion (`signalledClaims`) reads a claim's kind from the lane it was
 * filed in, and the lane names what the claim was meant to be, not what it is.
 * Production promoted "Rev.com publishes a per-minute price of $1.99" — a
 * supplier's own rate card — as recurring outsourced work, and "The 10 Best
 * Christmas Decorators Near Me", a listing of suppliers, as an active buyer.
 * Neither is a buyer paying; both are a seller's page. Deliberately narrow:
 * a missed one is filed as before and judged by its card; a refused one stays
 * citable context, and a worker who tags it as an opening still files it.
 */
export function sellersOwnPage(claim: {
  claim: string;
  sourceUrl: string | null;
  sourceTitle?: string | null;
  sourcePublisher?: string | null;
}): string | null {
  const parts = urlParts(claim.sourceUrl);
  if (parts && parts.path.some((segment) => PRICE_PAGE_SEGMENT.test(segment))) {
    return `its source is ${parts.host}'s own price page`;
  }
  const text = claim.claim;
  const names = [claim.sourcePublisher, parts?.host, parts && parts.stem.length >= 3 ? parts.stem : null]
    .filter((name): name is string => !!name && name.trim().length >= 3)
    .map((name) => name.trim().toLowerCase());
  // The publisher is the claim's subject — named before anything else is said — and states a price for itself.
  const head = text.toLowerCase().slice(0, 60);
  const subject = names.find((name) => head.includes(name));
  if (subject && STATED_PRICE.test(text) && SELLER_VERB.test(text)) {
    return `it is ${subject} stating its own price`;
  }
  for (const words of [claim.sourceTitle ?? '', text]) {
    const listing = words.match(SUPPLIER_LISTING)?.[0];
    if (listing) return `its source is a listing of suppliers ("${listing.trim()}"), not a buyer asking`;
  }
  return null;
}

/**
 * Signals that observe a moment rather than a pattern: a request, a task, a
 * price or a listing seen on one day. One with no published deadline is
 * "now" only for `RECOMMENDATION_POLICY.demandFreshDays` after its source's
 * date — a resale price seen in April is not a market in November. A
 * recurring outsourced brief is a pattern across dated examples, and is not.
 */
export const POINT_IN_TIME_SIGNALS: ReadonlySet<OpportunitySignal> = new Set<OpportunitySignal>(
  OPPORTUNITY_SIGNALS.filter((signal) => signal !== 'RECURRING_OUTSOURCED_WORK'),
);

/**
 * When a point-in-time observation stops being "now", or why it already has.
 *
 * A published deadline is the answer when there is one. Otherwise the
 * source's own date plus the freshness window; a source older than the window
 * is stale (`{ stale: true }`). An undated source has no expiry it can be held
 * to and no observation date either — never its retrieval date, which would
 * make a years-old page look fresh.
 */
export function observationExpiry(input: {
  signal: OpportunitySignal;
  closesOn: string | null;
  sourceDate: string | null;
  freshDays: number;
  now: Date;
}): { stale: true; observedAt: string } | { stale: false; expiresAt: string | null; observedAt: string | null } {
  const parsed = input.sourceDate ? Date.parse(input.sourceDate) : Number.NaN;
  const observedAt = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  if (input.closesOn) return { stale: false, expiresAt: input.closesOn, observedAt };
  if (!POINT_IN_TIME_SIGNALS.has(input.signal) || observedAt === null) return { stale: false, expiresAt: null, observedAt };
  const until = parsed + input.freshDays * 86_400_000;
  if (until < input.now.getTime()) return { stale: true, observedAt };
  return { stale: false, expiresAt: new Date(until).toISOString().slice(0, 10), observedAt };
}

/** How an opening of each kind is named: what it is, never a sentence a source wrote. */
export const SIGNAL_TITLE: Record<OpportunitySignal, string> = {
  ACTIVE_BUYER_DEMAND: 'Buyer request',
  PAID_TASK_OR_CONTRACT: 'Paid task',
  PRICING_OR_INFORMATION_ASYMMETRY: 'Price gap',
  EXPIRING_OPENING: 'Closing opening',
  SUPPLY_DEMAND_MISMATCH: 'Unmet demand',
  RESALABLE_ASSET_OPENING: 'Resale',
  RECURRING_OUTSOURCED_WORK: 'Recurring outsourced work',
};

/**
 * An opening's title, from its structured parts: the kind of opening, who it
 * is for (the claim's buyer population, else the deliverable the round asked
 * about) and who published it. The source's own sentence is the opening's
 * buying signal, never its name: production read strategies called "Only: The
 * 10 Best Christmas Decorators Near Me…" because a claim sentence was filed as
 * a title. The platform owns a name (§4); a source does not.
 */
export function openingTitle(input: {
  signal: OpportunitySignal;
  population: string | null;
  deliverable: string | null;
  publisher: string | null;
  sourceUrl: string | null;
}): string {
  const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const who = clean(input.population) || (clean(input.deliverable) ? `${clean(input.deliverable)} buyers` : 'buyer not yet named');
  const from = clean(input.publisher) || urlParts(input.sourceUrl)?.host || 'an unnamed source';
  const title = `${SIGNAL_TITLE[input.signal]}: ${who} — ${from}`;
  return title.length > 160 ? `${title.slice(0, 159)}…` : title;
}
