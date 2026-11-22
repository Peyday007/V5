/**
 * The relational event graph: economic actors, wants, capacities, offers,
 * prices, timing, channels, roles and rights, each edge linked to the raw
 * evidence it was read from (ALGO-16-1, item 3).
 *
 * ---------------------------------------------------------------------------
 * What it is, and what it refuses to be
 * ---------------------------------------------------------------------------
 *
 * Ordinary code reads stored detections and extracted facts into one graph and
 * runs deterministic rules over it. A rule that fires produces a *hypothesis*:
 * what was seen, the facts and raw evidence it rests on, and an explicit list
 * of the conditions nobody has established yet. It is never a verified
 * opportunity — the type has no other status to carry, and every hypothesis
 * carries at least one missing condition, because a join of public records
 * cannot by itself establish that anybody will pay. A job posting is not a
 * request to buy from an outside provider, a supplier advertisement is not
 * capacity reserved for anyone, and a platform price is not a buyer: a fact
 * read from one of those keeps that limit as a missing condition rather than
 * being upgraded on the way in.
 *
 * ---------------------------------------------------------------------------
 * Neighborhoods, so one event costs one neighborhood
 * ---------------------------------------------------------------------------
 *
 * Every rule relates facts about the same subject — the product or service a
 * want, capacity, offer or price is about — so a subject is a neighborhood. A
 * new event recomputes only the neighborhoods it touches (its own subject, and
 * its old one if a re-read moved it), and every other neighborhood's
 * hypotheses are returned from the last computation untouched. A fact that
 * arrives again unchanged is a duplicate and recomputes nothing.
 *
 * The class is pure and in memory, with its own input interface, so it does
 * not wait on whichever extraction produces its facts: `factFromDetection`
 * reads a stored feed detection into one, and `factsFromItem` reads a stored
 * feed item through the deterministic extractor (`feeds/extract.ts`) into the
 * want, offer, capacity, price or renewal it states, with its place, quantity,
 * price and window. The running Brain's graph is not that class alone:
 * `syncEventGraph` keeps one process graph backed by the durable
 * `feed_detections` and `feed_items` rows (the graph's facts are read from
 * those rows, so they survive a restart, a deploy and a second process),
 * reading only rows past its cursors and adding each as an event, so only the
 * neighborhoods those rows touch are recomputed.
 * Construction (`constructArrangements`) calls it on every pass.
 * Nothing here calls a model, so the lane keeps working when every model
 * provider is down. No subject, region, industry or example is a whitelist:
 * the rules relate whatever facts arrive.
 */
import type { DetectedSignal } from '../feeds/detectors.ts';
import { CODE_SIGNAL_SOURCE } from '../feeds/detectors.ts';
import { AUTHOR_HANDLE_SOURCES, PARTNER_OFFER_WORDING, extractItem, recordKindOf, type ExtractableItem, type ExtractedFact } from '../feeds/extract.ts';
import { getDb } from '../../db/database.ts';

/** The version every hypothesis is stamped with, so a rule change is traceable to what it produced. */
export const EVENT_GRAPH_RULES_VERSION = 1;

/** Distinct buyers' requests in one place before demand there reads as repeated. */
export const REPEATED_DEMAND_MIN_BUYERS = 3;

/** Recomputations the graph's log keeps (`EventGraph.recomputations`); older ones are dropped. */
export const EVENT_GRAPH_RECOMPUTATIONS_KEPT = 1_000;

/** What a fact says about its actor and subject. */
export type FactKind = 'WANT' | 'CAPACITY' | 'OFFER' | 'PRICE' | 'RENEWAL';

/** The role the source gives the actor. UNKNOWN when it gives none — never guessed. */
export type ActorRole = 'BUYER' | 'SUPPLIER' | 'PARTNER' | 'UNKNOWN';

/**
 * What kind of record the fact was read from. It decides which conditions a
 * hypothesis built on it still lacks: only a STATED_REQUEST is somebody asking
 * to buy, and even that is not yet a price anyone agreed.
 */
export type FactBasis = 'STATED_REQUEST' | 'JOB_POSTING' | 'SUPPLIER_AD' | 'PLATFORM_PRICE' | 'PUBLIC_RECORD';

/** One piece of raw evidence: the exact stored record a fact was read from. */
export interface EvidenceLink {
  rawId: string;
  source: string;
  url: string | null;
  observedAt: string;
}

/** One extracted fact, the graph's whole input. */
export interface GraphFact {
  id: string;
  kind: FactKind;
  basis: FactBasis;
  actor: { key: string; name: string | null; role: ActorRole };
  /** The product or service it is about, as extracted; normalized here. */
  subject: string;
  region: string | null;
  quantity: number | null;
  unit: string | null;
  /** PRICE: what a buyer pays (BUY) or a seller asks (SELL), in minor units. */
  priceCents: number | null;
  currency: string | null;
  side: 'BUY' | 'SELL' | null;
  /** PRICE (SELL side): the necessary costs the source states per unit, or null when none are stated. */
  statedCostCents: number | null;
  /** When it holds: a request's need-by window, a capacity's availability, a renewal's date (as `from`). */
  window: { from: string; to: string | null };
  channel: string | null;
  rights: string[];
  evidence: EvidenceLink[];
}

export type RuleId =
  | 'BUYER_REQUEST_AGAINST_SUPPLIER'
  | 'REPEATED_DEMAND_LIMITED_SUPPLY'
  | 'RENEWAL_AGAINST_CAPACITY'
  | 'SPREAD_AFTER_COSTS'
  | 'PARTNER_SERVABLE_CONCENTRATION';

/**
 * What a rule detected. `status` has one value on purpose: nothing in this
 * module can produce a verified opportunity, and nothing downstream can read
 * one out of it.
 */
export interface GraphHypothesis {
  status: 'HYPOTHESIS';
  /** Stable across recomputation: rule, version, neighborhood and the facts it joined. */
  key: string;
  rule: RuleId;
  ruleVersion: number;
  neighborhood: string;
  summary: string;
  actorKeys: string[];
  /**
   * The actors the joined facts name, each with the name its record states (or
   * null) and the role the record gave it — what construction reads as the
   * buyer and supplier sides of a design. Sorted by key.
   */
  actors: { key: string; name: string | null; role: ActorRole }[];
  factIds: string[];
  evidence: EvidenceLink[];
  /** Never empty: what nobody has established yet. */
  missingConditions: string[];
  figures: Record<string, number>;
}

/** An actor → subject edge: one fact, with the evidence it was read from. */
export interface GraphEdge {
  actorKey: string;
  neighborhood: string;
  factId: string;
  kind: FactKind;
  role: ActorRole;
  evidence: EvidenceLink[];
}

export interface AddResult {
  /** Neighborhoods recomputed for this event; empty for a duplicate. */
  affected: string[];
  /** The hypotheses of the affected neighborhoods after recomputation. */
  hypotheses: GraphHypothesis[];
}

/** The neighborhood key for a subject: lowercased, punctuation folded, whitespace collapsed. */
export function neighborhoodOf(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function regionOf(region: string | null): string | null {
  const r = (region ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return r || null;
}

/** The condition a fact's basis leaves unestablished, or null when its basis is a stated request. */
function basisGap(fact: GraphFact): string | null {
  switch (fact.basis) {
    case 'JOB_POSTING':
      return `${fact.actor.name ?? fact.actor.key}'s job posting is hiring, not a request to buy from an outside provider`;
    case 'SUPPLIER_AD':
      return `${fact.actor.name ?? fact.actor.key}'s advertisement is not capacity reserved for any buyer`;
    case 'PLATFORM_PRICE':
      return `the platform price for ${fact.subject} is a listing, not a buyer's agreed price`;
    case 'PUBLIC_RECORD':
      return `the public record on ${fact.actor.name ?? fact.actor.key} does not state willingness to transact`;
    case 'STATED_REQUEST':
      return null;
  }
}

/** Whether two windows overlap; an open end runs forever. */
function overlaps(a: GraphFact['window'], b: GraphFact['window']): boolean {
  const aFrom = Date.parse(a.from);
  const bFrom = Date.parse(b.from);
  const aTo = a.to ? Date.parse(a.to) : Infinity;
  const bTo = b.to ? Date.parse(b.to) : Infinity;
  return aFrom <= bTo && bFrom <= aTo;
}

function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function evidenceOf(facts: readonly GraphFact[]): EvidenceLink[] {
  const seen = new Set<string>();
  const out: EvidenceLink[] = [];
  for (const fact of facts) {
    for (const link of fact.evidence) {
      if (seen.has(link.rawId)) continue;
      seen.add(link.rawId);
      out.push(link);
    }
  }
  return out;
}

function hypothesis(
  rule: RuleId,
  neighborhood: string,
  facts: readonly GraphFact[],
  summary: string,
  missing: readonly (string | null)[],
  figures: Record<string, number> = {},
): GraphHypothesis {
  const factIds = uniq(facts.map((f) => f.id)).sort();
  const missingConditions = uniq([
    ...missing.filter((m): m is string => !!m),
    ...facts.map(basisGap).filter((m): m is string => !!m),
    'a detection is not a verified opportunity: nobody has confirmed the parties will transact on these terms',
  ]);
  return {
    status: 'HYPOTHESIS',
    key: `${rule}:v${EVENT_GRAPH_RULES_VERSION}:${neighborhood}:${factIds.join(',')}`,
    rule,
    ruleVersion: EVENT_GRAPH_RULES_VERSION,
    neighborhood,
    summary,
    actorKeys: uniq(facts.map((f) => f.actor.key)).sort(),
    actors: [...new Map(facts.map((f) => [f.actor.key, f.actor] as const)).values()].sort((a, b) => a.key.localeCompare(b.key)).map((a) => ({ ...a })),
    factIds,
    evidence: evidenceOf(facts),
    missingConditions,
    figures,
  };
}

const supplyKinds = new Set<FactKind>(['CAPACITY', 'OFFER']);

/** Every rule over one neighborhood's facts. Pure and deterministic: same facts, same hypotheses, same order. */
export function detectInNeighborhood(neighborhood: string, facts: readonly GraphFact[]): GraphHypothesis[] {
  const sorted = [...facts].sort((a, b) => a.id.localeCompare(b.id));
  const wants = sorted.filter((f) => f.kind === 'WANT');
  const supply = sorted.filter((f) => supplyKinds.has(f.kind));
  const out: GraphHypothesis[] = [];

  // A buyer's request against a supplier able to meet it, in the same place and time.
  for (const want of wants) {
    for (const offer of supply) {
      if (offer.actor.key === want.actor.key) continue;
      if (regionOf(want.region) !== regionOf(offer.region)) continue;
      if (!overlaps(want.window, offer.window)) continue;
      out.push(
        hypothesis(
          'BUYER_REQUEST_AGAINST_SUPPLIER',
          neighborhood,
          [want, offer],
          `${want.actor.name ?? want.actor.key} wants ${want.subject}${want.region ? ` in ${want.region}` : ''}; ${offer.actor.name ?? offer.actor.key} offers it there in the same window`,
          [
            'the buyer has not confirmed a budget or a price',
            want.quantity !== null && offer.quantity !== null && offer.quantity < want.quantity
              ? `the supplier's stated quantity (${offer.quantity}) is below the request (${want.quantity})`
              : null,
            offer.quantity === null ? "the supplier's quantity is not stated" : null,
            'no right to broker or resell between them is established',
          ],
        ),
      );
    }
  }

  // Repeated demand in one place against limited supply there.
  const byRegion = new Map<string, GraphFact[]>();
  for (const fact of sorted) {
    const region = regionOf(fact.region);
    if (!region) continue;
    byRegion.set(region, [...(byRegion.get(region) ?? []), fact]);
  }
  for (const [region, local] of [...byRegion].sort(([a], [b]) => a.localeCompare(b))) {
    const localWants = local.filter((f) => f.kind === 'WANT');
    const buyers = uniq(localWants.map((f) => f.actor.key));
    if (buyers.length < REPEATED_DEMAND_MIN_BUYERS) continue;
    const localSupply = local.filter((f) => supplyKinds.has(f.kind));
    const demanded = localWants.every((f) => f.quantity !== null) ? localWants.reduce((s, f) => s + f.quantity!, 0) : null;
    const supplied = localSupply.every((f) => f.quantity !== null) ? localSupply.reduce((s, f) => s + f.quantity!, 0) : null;
    const limited = localSupply.length === 0 || (demanded !== null && supplied !== null && supplied < demanded);
    if (!limited) continue;
    out.push(
      hypothesis(
        'REPEATED_DEMAND_LIMITED_SUPPLY',
        neighborhood,
        [...localWants, ...localSupply],
        `${buyers.length} buyers want ${neighborhood} in ${region} against ${localSupply.length === 0 ? 'no recorded supply' : `${supplied} supplied of ${demanded} wanted`}`,
        [
          localSupply.length === 0 ? `supply in ${region} is unrecorded, not shown absent` : null,
          demanded === null ? 'not every request states a quantity, so total demand is unmeasured' : null,
          'whether these buyers would pay an outside provider is not established',
        ],
        { buyers: buyers.length, ...(demanded !== null ? { demanded } : {}), ...(supplied !== null ? { supplied } : {}) },
      ),
    );
  }

  // A contract renewal against a provider with capacity for it.
  for (const renewal of sorted.filter((f) => f.kind === 'RENEWAL')) {
    for (const capacity of sorted.filter((f) => f.kind === 'CAPACITY')) {
      if (capacity.actor.key === renewal.actor.key) continue;
      if (regionOf(renewal.region) !== regionOf(capacity.region)) continue;
      if (!overlaps({ from: renewal.window.from, to: renewal.window.from }, capacity.window)) continue;
      out.push(
        hypothesis(
          'RENEWAL_AGAINST_CAPACITY',
          neighborhood,
          [renewal, capacity],
          `${renewal.actor.name ?? renewal.actor.key}'s ${renewal.subject} contract renews ${renewal.window.from.slice(0, 10)}; ${capacity.actor.name ?? capacity.actor.key} has capacity then`,
          [
            'whether the renewal is open to a new provider is not established',
            "the incumbent's terms and the buyer's switching cost are unknown",
          ],
        ),
      );
    }
  }

  // A published buy/sell spread after the costs the source states.
  const prices = sorted.filter((f) => f.kind === 'PRICE' && f.priceCents !== null && f.currency);
  for (const buy of prices.filter((f) => f.side === 'BUY')) {
    for (const sell of prices.filter((f) => f.side === 'SELL')) {
      if (sell.actor.key === buy.actor.key) continue;
      if (buy.currency !== sell.currency || (buy.unit ?? '') !== (sell.unit ?? '')) continue;
      const gross = buy.priceCents! - sell.priceCents!;
      const net = sell.statedCostCents === null ? null : gross - sell.statedCostCents;
      if ((net ?? gross) <= 0) continue;
      out.push(
        hypothesis(
          'SPREAD_AFTER_COSTS',
          neighborhood,
          [buy, sell],
          `${neighborhood}: bought at ${buy.priceCents} and sold at ${sell.priceCents} ${buy.currency}${buy.unit ? ` per ${buy.unit}` : ''}, ${net === null ? `a gross spread of ${gross} before costs` : `${net} after stated costs of ${sell.statedCostCents}`}`,
          [
            net === null ? 'the necessary costs (transport, fees, handling) are not stated, so the spread is before costs' : null,
            regionOf(buy.region) !== regionOf(sell.region) ? 'the two prices are in different places; moving the goods is not priced' : null,
            'neither price is an agreed transaction at volume',
          ],
          { grossCents: gross, ...(net !== null ? { netCents: net } : {}) },
        ),
      );
    }
  }

  // A concentration of requests a partner, rather than a local supplier, could serve.
  const partners = supply.filter((f) => f.actor.role === 'PARTNER');
  if (partners.length > 0) {
    for (const [region, local] of [...byRegion].sort(([a], [b]) => a.localeCompare(b))) {
      const localWants = local.filter((f) => f.kind === 'WANT');
      const buyers = uniq(localWants.map((f) => f.actor.key));
      if (buyers.length < REPEATED_DEMAND_MIN_BUYERS) continue;
      for (const partner of partners) {
        if (buyers.includes(partner.actor.key)) continue;
        out.push(
          hypothesis(
            'PARTNER_SERVABLE_CONCENTRATION',
            neighborhood,
            [...localWants, partner],
            `${buyers.length} requests for ${neighborhood} in ${region} that ${partner.actor.name ?? partner.actor.key} could serve as a partner`,
            [
              `no agreement with ${partner.actor.name ?? partner.actor.key} to serve these buyers exists`,
              regionOf(partner.region) !== region ? `${partner.actor.name ?? partner.actor.key} is recorded ${partner.region ? `in ${partner.region}` : 'without a region'}, not in ${region}` : null,
              'the partner terms and the margin left for Brain are unknown',
            ],
            { buyers: buyers.length },
          ),
        );
      }
    }
  }

  return out;
}

function sameFact(a: GraphFact, b: GraphFact): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The graph itself. Holds facts by neighborhood and the last hypotheses each
 * neighborhood produced; `add` recomputes only what the new event touches.
 */
export class EventGraph {
  private readonly facts = new Map<string, GraphFact>();
  private readonly members = new Map<string, Set<string>>();
  private readonly detected = new Map<string, GraphHypothesis[]>();
  /**
   * The most recent neighborhood recomputations, in order — what an event
   * actually cost. Only the last `EVENT_GRAPH_RECOMPUTATIONS_KEPT` are kept: the
   * process graph lives as long as the process, and an unbounded log of every
   * recomputation it ever made was a heap that grew with each feed item read.
   */
  readonly recomputations: string[] = [];

  /** Add (or re-read) one fact. A duplicate recomputes nothing; a moved fact recomputes both sides. */
  add(fact: GraphFact): AddResult {
    if (fact.evidence.length === 0) throw new Error(`fact ${fact.id} has no raw evidence; every edge must link to what it was read from`);
    const previous = this.facts.get(fact.id);
    if (previous && sameFact(previous, fact)) return { affected: [], hypotheses: [] };
    const affected = new Set<string>();
    if (previous) {
      const old = neighborhoodOf(previous.subject);
      this.members.get(old)?.delete(fact.id);
      affected.add(old);
    }
    const hood = neighborhoodOf(fact.subject);
    this.facts.set(fact.id, fact);
    if (!this.members.has(hood)) this.members.set(hood, new Set());
    this.members.get(hood)!.add(fact.id);
    affected.add(hood);
    const keys = [...affected].sort();
    for (const key of keys) this.recompute(key);
    return { affected: keys, hypotheses: keys.flatMap((key) => this.detected.get(key) ?? []) };
  }

  /** Take several facts out at once, recomputing each neighborhood they leave once. */
  removeMany(factIds: Iterable<string>): AddResult {
    const affected = new Set<string>();
    for (const factId of factIds) {
      const previous = this.facts.get(factId);
      if (!previous) continue;
      this.facts.delete(factId);
      const hood = neighborhoodOf(previous.subject);
      this.members.get(hood)?.delete(factId);
      affected.add(hood);
    }
    const keys = [...affected].sort();
    for (const key of keys) this.recompute(key);
    return { affected: keys, hypotheses: keys.flatMap((key) => this.detected.get(key) ?? []) };
  }

  /** Take a fact out (its row was rolled back to SHADOW, or no longer names an entity). Recomputes only its neighborhood. */
  remove(factId: string): AddResult {
    const previous = this.facts.get(factId);
    if (!previous) return { affected: [], hypotheses: [] };
    this.facts.delete(factId);
    const hood = neighborhoodOf(previous.subject);
    this.members.get(hood)?.delete(factId);
    this.recompute(hood);
    return { affected: [hood], hypotheses: this.detected.get(hood) ?? [] };
  }

  has(factId: string): boolean {
    return this.facts.has(factId);
  }

  size(): number {
    return this.facts.size;
  }

  private recompute(neighborhood: string): void {
    this.recomputations.push(neighborhood);
    if (this.recomputations.length > 2 * EVENT_GRAPH_RECOMPUTATIONS_KEPT) this.recomputations.splice(0, this.recomputations.length - EVENT_GRAPH_RECOMPUTATIONS_KEPT);
    const facts = [...(this.members.get(neighborhood) ?? [])].map((id) => this.facts.get(id)!);
    if (facts.length === 0) {
      this.members.delete(neighborhood);
      this.detected.delete(neighborhood);
      return;
    }
    this.detected.set(neighborhood, detectInNeighborhood(neighborhood, facts));
  }

  /** Every current hypothesis, neighborhood by neighborhood. */
  hypotheses(): GraphHypothesis[] {
    return [...this.detected.keys()].sort().flatMap((key) => this.detected.get(key)!);
  }

  /** The actor → subject edges, each with the evidence its fact was read from. */
  edges(): GraphEdge[] {
    return [...this.facts.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({ actorKey: f.actor.key, neighborhood: neighborhoodOf(f.subject), factId: f.id, kind: f.kind, role: f.actor.role, evidence: f.evidence }));
  }

  neighborhoods(): string[] {
    return [...this.members.keys()].sort();
  }
}

/**
 * A stored feed detection as a graph fact.
 *
 * A detection is a signal about its entity (`detectors.ts`: a cluster of job
 * posts shows an employer hiring), so it enters as a WANT on the JOB_POSTING
 * basis, and every hypothesis built on it carries that limit as a missing
 * condition. Its members are its raw evidence. Null when the detection names no
 * entity — a want with nobody wanting it relates to nothing.
 */
export function factFromDetection(
  detection: Pick<DetectedSignal, 'groupKey' | 'label' | 'entityKey' | 'entityName' | 'category' | 'windowFrom' | 'windowTo' | 'memberIds' | 'sourceUrls'>,
  source: string | ((rawId: string) => string),
): GraphFact | null {
  if (!detection.entityKey) return null;
  const sourceOf = typeof source === 'string' ? () => source : source;
  return {
    id: `detection:${detection.groupKey}`,
    kind: 'WANT',
    basis: 'JOB_POSTING',
    actor: { key: detection.entityKey, name: detection.entityName, role: 'UNKNOWN' },
    subject: detection.category ?? detection.label,
    region: null,
    quantity: null,
    unit: null,
    priceCents: null,
    currency: null,
    side: null,
    statedCostCents: null,
    window: { from: detection.windowFrom, to: detection.windowTo },
    channel: null,
    rights: [],
    evidence: detection.memberIds.map((rawId, i) => ({ rawId, source: sourceOf(rawId), url: detection.sourceUrls[i] ?? null, observedAt: detection.windowTo })),
  };
}

// ---------------------------------------------------------------------------
// A stored feed item as graph facts, through the deterministic extractor
// ---------------------------------------------------------------------------

/** Wording that makes a public record a renewal (a contract, licence or term coming up again). */
const RENEWAL_WORDING = /\b(renewal|renews|renewing|up for renewal|re-?bid|contract (?:expires|expiration|ends))\b/i;
/** Wording that makes a seller's advertisement a statement of capacity rather than a plain offer. */
const CAPACITY_WORDING = /\b(capacity|availability|available (?:now|for|from)|now booking|openings?|slots? (?:open|available)|accepting (?:new )?(?:clients|customers|orders))\b/i;

/**
 * The words a title uses to say what kind of record it is ("Request for
 * quotes:", "now booking", "for sale"), not what it is about. They are
 * dropped from the subject so a request and an advert about the same thing
 * meet in one neighborhood; the kind itself is kept on the fact.
 */
const KIND_WORDS =
  /\b(request for (?:proposals?|quotes?|bids?)|rfp|rfq|invitation to bid|seeking (?:quotes|bids|a contractor|a vendor|a supplier)|looking for (?:a )?(?:contractor|vendor|supplier|provider)|need(?:s|ed)? (?:a )?(?:contractor|vendor|supplier)|we offer|our services|available for hire|for sale|now booking|free estimates?|call us|list(?:ed)? (?:price|at)|price list|marketplace price|asking price)\b/gi;

/** A partner declaration ("subcontract work welcome", "trade accounts") is likewise record-kind wording, not the subject. */
const PARTNER_KIND_WORDS = new RegExp(PARTNER_OFFER_WORDING.source, 'gi');

/** A record's subject: its deliverable key with the record-kind words taken out, or the key itself if nothing is left. */
export function itemSubject(deliverable: string): string {
  const stripped = deliverable.replace(KIND_WORDS, ' ').replace(PARTNER_KIND_WORDS, ' ').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  return stripped || deliverable;
}

/** The one value a field states, or null when the record states none or several that disagree — never guessed. */
function single(facts: readonly ExtractedFact[], field: ExtractedFact['field']): ExtractedFact | null {
  const found = facts.filter((f) => f.field === field);
  if (found.length === 0) return null;
  const values = new Set(found.map((f) => String(f.value)));
  return values.size === 1 ? found[0]! : null;
}

/**
 * The unit a price is per: the record's stated quantity unit for a per-unit
 * price, `per-unit` when it is a rate whose unit the record does not name, and
 * null for a total. A rate and a total are never one unit, so a budget for the
 * whole job is never read against an hourly rate as a spread.
 */
function priceUnit(price: ExtractedFact, quantityUnit: string | null, text: string): string | null {
  if (price.unit !== 'per-unit') return null;
  if (quantityUnit) return quantityUnit;
  // The period or unit the record writes after the figure ("$80/hr", "$4,000 a month"): an hourly rate is never a monthly one.
  const at = text.indexOf(price.evidence.text);
  const after = at >= 0 ? text.slice(at + price.evidence.text.length, at + price.evidence.text.length + 24) : '';
  const m = RATE_UNIT.exec(after);
  const word = m ? (m[1] ?? m[2] ?? '').toLowerCase() : '';
  const unit = RATE_UNITS[word];
  return unit ? `per-${unit}` : 'per-unit';
}

const RATE_UNIT = /^\s*(?:(?:\/|per\b|an?\b)\s*(hours?|hrs?|h|days?|weeks?|wks?|months?|mos?|years?|yrs?|words?|pages?|units?|items?)\b|(hourly|daily|weekly|monthly|annually|yearly)\b)/i;
const RATE_UNITS: Record<string, string> = {
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', h: 'hour', hourly: 'hour',
  day: 'day', days: 'day', daily: 'day',
  week: 'week', weeks: 'week', wk: 'week', wks: 'week', weekly: 'week',
  month: 'month', months: 'month', mo: 'month', mos: 'month', monthly: 'month',
  year: 'year', years: 'year', yr: 'year', yrs: 'year', annually: 'year', yearly: 'year',
  word: 'word', words: 'word', page: 'page', pages: 'page', unit: 'unit', units: 'unit', item: 'item', items: 'item',
};

/**
 * Read one stored feed item into graph facts (ALGO-16-1 items 2 → 3).
 *
 * The record's kind (`recordKindOf`) decides what the fact can be, and nothing
 * is upgraded on the way: a record stating a request is a WANT on the
 * STATED_REQUEST basis (and, when it states a budget, a BUY price); a job
 * posting is a WANT on the JOB_POSTING basis, carrying that limit as a missing
 * condition; a seller's advertisement is an OFFER, or CAPACITY when it says it
 * has room, on the SUPPLIER_AD basis; a platform listing is a SELL price on the
 * PLATFORM_PRICE basis; a public record that names a renewal and a date is a
 * RENEWAL. News and records the parser cannot classify are not facts.
 *
 * Place, quantity and price come from the extractor's normalized facts, and
 * only when the record states exactly one — two places or two prices are an
 * ambiguity for the model lane, not a value to pick. The actor's role is what
 * the record says (BUYER only for a stated request, SUPPLIER for a seller,
 * PARTNER for a seller whose own record declares it serves through or for
 * others — subcontract or overflow work, white-label, wholesale or trade
 * accounts, a referral, reseller or partner programme: `PARTNER_OFFER_WORDING`).
 * PARTNER is the record's own declaration, never guessed from a plain advert
 * or from where the seller is. Every fact's raw evidence is the
 * stored item itself. Pure.
 */
export function factsFromItem(item: ExtractableItem): GraphFact[] {
  const kind = recordKindOf(item);
  const extracted = extractItem(item);
  const deliverable = extracted.find((f) => f.field === 'deliverable');
  if (!deliverable) return [];
  const subject = itemSubject(String(deliverable.value));
  const actorKey = extracted.find((f) => f.entityKey)?.entityKey ?? `item:${item.id}`;
  // A forum handle is attribution, not a name a buyer or supplier is known by (`AUTHOR_HANDLE_SOURCES`).
  const actorName = AUTHOR_HANDLE_SOURCES.has(item.source) ? null : item.organization?.trim() || null;
  const place = single(extracted, 'location');
  const quantity = single(extracted, 'quantity');
  const price = single(extracted, 'price');
  const observedAt = item.publishedAt ?? item.fetchedAt;
  const stated = extracted
    .filter((f) => f.field === 'date' && f.evidence.field !== 'publishedAt')
    .map((f) => String(f.value))
    .sort();
  const from = observedAt;
  const fromDay = from.slice(0, 10);
  const later = stated.filter((day) => day >= fromDay);
  const window = { from, to: later.length > 0 ? `${later[later.length - 1]}T23:59:59.999Z` : null };
  const evidence: EvidenceLink[] = [{ rawId: item.id, source: item.source, url: item.url, observedAt }];
  const base = {
    subject,
    region: place ? String(place.value) : null,
    quantity: quantity ? Number(quantity.value) : null,
    unit: quantity?.unit ?? null,
    priceCents: null as number | null,
    currency: null as string | null,
    side: null as GraphFact['side'],
    statedCostCents: null,
    window,
    channel: item.source,
    rights: [] as string[],
    evidence,
  };
  const text = `${item.title}\n${item.body ?? ''}`;
  switch (kind) {
    case 'STATED_REQUEST': {
      const out: GraphFact[] = [{ ...base, id: `item:${item.id}`, kind: 'WANT', basis: 'STATED_REQUEST', actor: { key: actorKey, name: actorName, role: 'BUYER' } }];
      if (price && price.currency) {
        out.push({
          ...base,
          id: `item:${item.id}:price`,
          kind: 'PRICE',
          basis: 'STATED_REQUEST',
          actor: { key: actorKey, name: actorName, role: 'BUYER' },
          priceCents: Number(price.value),
          currency: price.currency,
          unit: priceUnit(price, base.unit, text),
          side: 'BUY',
        });
      }
      return out;
    }
    case 'JOB_POSTING':
      return [{ ...base, id: `item:${item.id}`, kind: 'WANT', basis: 'JOB_POSTING', actor: { key: actorKey, name: actorName, role: 'UNKNOWN' } }];
    case 'SUPPLIER_AD': {
      const out: GraphFact[] = [
        {
          ...base,
          id: `item:${item.id}`,
          kind: CAPACITY_WORDING.test(text) ? 'CAPACITY' : 'OFFER',
          basis: 'SUPPLIER_AD',
          actor: { key: actorKey, name: actorName, role: PARTNER_OFFER_WORDING.test(text) ? 'PARTNER' : 'SUPPLIER' },
          priceCents: price ? Number(price.value) : null,
          currency: price?.currency ?? null,
        },
      ];
      // The rate a provider asks is a sell price — still an advert's, never an agreed one — so a buyer's
      // stated budget for the same work can be read against it (SPREAD_AFTER_COSTS).
      if (price && price.currency) {
        out.push({
          ...base,
          id: `item:${item.id}:price`,
          kind: 'PRICE',
          basis: 'SUPPLIER_AD',
          // The same actor, in the role its own advert declared (a partner stays a partner).
          actor: { ...out[0]!.actor },
          priceCents: Number(price.value),
          currency: price.currency,
          unit: priceUnit(price, base.unit, text),
          side: 'SELL',
        });
      }
      return out;
    }
    case 'PLATFORM_PRICE':
      if (!price || !price.currency) return [];
      return [
        {
          ...base,
          id: `item:${item.id}`,
          kind: 'PRICE',
          basis: 'PLATFORM_PRICE',
          actor: { key: actorKey, name: actorName, role: 'SUPPLIER' },
          priceCents: Number(price.value),
          currency: price.currency,
          unit: priceUnit(price, base.unit, text),
          side: 'SELL',
        },
      ];
    case 'PUBLIC_RECORD':
    case 'NEWS':
    case 'UNKNOWN': {
      // A renewal needs both the wording and the date it renews on; the date is the window's start.
      if (!RENEWAL_WORDING.test(text) || later.length === 0) return [];
      return [
        {
          ...base,
          id: `item:${item.id}`,
          kind: 'RENEWAL',
          basis: 'PUBLIC_RECORD',
          actor: { key: actorKey, name: actorName, role: 'UNKNOWN' },
          window: { from: `${later[0]}T00:00:00.000Z`, to: null },
        },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// The running Brain's graph, backed by the durable detection rows
// ---------------------------------------------------------------------------

/** Rows read per page while syncing; a large backlog is read in pages, never in one statement. */
export const EVENT_GRAPH_SYNC_PAGE = 500;

/** One stored `feed_detections` row, as the sync reads it. */
interface StoredDetection {
  id: string;
  rule_id: string;
  group_key: string;
  label: string;
  entity_key: string | null;
  category: string | null;
  window_from: string;
  window_to: string;
  member_ids: string;
  source_urls: string;
  mode: string;
  updated_at: string;
}

/** One stored `feed_items` row, as the sync reads it. */
interface StoredItem {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string | null;
  organization: string | null;
  published_at: string | null;
  fetched_at: string;
}

/** What one sync did, so a caller can say what an event actually cost. */
export interface EventGraphSync {
  /** Rows read because they moved past a cursor: detection rows, plus stored feed items (`itemsRead`). */
  read: number;
  /** Facts added or re-read with a change. */
  added: number;
  /** Facts taken out: rolled back to SHADOW, naming no entity any more, or from an item fetched before the window. */
  removed: number;
  /** Rows that changed in a way the graph does not read (a duplicate): nothing recomputed. */
  unchanged: number;
  /** Distinct neighborhoods recomputed by this sync. */
  recomputed: string[];
  /** Facts the graph holds after it. */
  facts: number;
  hypotheses: number;
  /** The cursor after this sync: the last row read, by (updated_at, id). */
  cursor: { updatedAt: string; id: string } | null;
  /** Of `read`, stored feed items read through the extractor since the item cursor. */
  itemsRead: number;
  /** The item cursor after this sync: the last `feed_items` row read, by (fetched_at, id). */
  itemCursor: { fetchedAt: string; id: string } | null;
  at: string;
}

interface ProcessGraph {
  graph: EventGraph;
  cursor: { updatedAt: string; id: string } | null;
  itemCursor: { fetchedAt: string; id: string } | null;
  /**
   * When each stored item the graph holds facts from was fetched, so a
   * long-lived process lets an item go once it falls out of
   * `EVENT_GRAPH_ITEM_WINDOW_MS`, exactly as a fresh process would never read it.
   */
  items: Map<string, string>;
  last: EventGraphSync | null;
  running: Promise<EventGraphSync> | null;
}

/**
 * How far back a fresh process reads stored feed items: a fact older than this
 * is past any window a hypothesis could still act on. Detection rows have no
 * floor because a rule's ACTIVE output is already bounded by its own window.
 */
export const EVENT_GRAPH_ITEM_WINDOW_MS = 120 * 86_400_000;

function emptyGraph(): ProcessGraph {
  return { graph: new EventGraph(), cursor: null, itemCursor: null, items: new Map(), last: null, running: null };
}

/** Remember when a stored item that gave the process graph facts was fetched. */
function holdItem(held: ProcessGraph, itemId: string, fetchedAt: string, facts: readonly GraphFact[]): void {
  if (facts.length === 0) return;
  const prior = held.items.get(itemId);
  if (prior === undefined || fetchedAt > prior) held.items.set(itemId, fetchedAt);
}

/** Every id `factsFromItem` can give one stored item's facts. */
export function itemFactIds(itemId: string): string[] {
  return [`item:${itemId}`, `item:${itemId}:price`];
}

/**
 * Let go of every item fetched before the window's floor: the same facts a
 * fresh process, reading from `EVENT_GRAPH_ITEM_WINDOW_MS` back, would never
 * have read. Without it the process graph held every item it ever read for as
 * long as the process lived. Returns the facts removed and the neighborhoods
 * recomputed.
 */
function expireItems(held: ProcessGraph, floor: string): { removed: number; affected: string[] } {
  const gone: string[] = [];
  for (const [itemId, fetchedAt] of held.items) {
    if (fetchedAt >= floor) continue;
    held.items.delete(itemId);
    for (const id of itemFactIds(itemId)) if (held.graph.has(id)) gone.push(id);
  }
  if (gone.length === 0) return { removed: 0, affected: [] };
  return { removed: gone.length, affected: held.graph.removeMany(gone).affected };
}

let processGraph: ProcessGraph = emptyGraph();

/** The process graph (after at least one `syncEventGraph`, the durable rows' graph). */
export function currentEventGraph(): EventGraph {
  return processGraph.graph;
}

/** What the last sync did, or null before the first one. */
export function lastEventGraphSync(): EventGraphSync | null {
  return processGraph.last;
}

/** Forget the process graph; the next sync rebuilds it from the rows. For a test, or a rule-version change. */
export function resetEventGraph(): void {
  processGraph = emptyGraph();
}

/** Which source each raw item came from, so every evidence link names its own feed. */
async function sourcesOf(itemIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(itemIds)];
  for (let i = 0; i < ids.length; i += EVENT_GRAPH_SYNC_PAGE) {
    const chunk = ids.slice(i, i + EVENT_GRAPH_SYNC_PAGE);
    const rows = await getDb().all<{ id: string; source: string }>(
      `SELECT id, source FROM feed_items WHERE id IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const row of rows) out.set(row.id, row.source);
  }
  return out;
}

function parsedList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

/** What one structure pass handed the graph. */
export interface ExtractedItemsUpdate {
  /** Graph facts the pass's records support (`factsFromItem`), each linked to its stored item. */
  facts: number;
  /** Facts the graph took as new or changed; one it already held unchanged is a duplicate. */
  added: number;
  /** Neighborhoods recomputed for them, and only those. */
  affected: string[];
}

/**
 * Hand the records a deterministic-extraction pass just read to the process
 * graph, as the event that changed it: the Structure stage feeding Connect
 * directly, so a request, offer, capacity, price or renewal reaches the rules
 * and construction on the tick it was read. The facts are `factsFromItem`'s,
 * under the same ids `syncEventGraph` gives the same stored rows, so the graph
 * has one fact per record whichever path reaches it first and the other is a
 * duplicate that recomputes nothing — one store, one fact shape, no second
 * authority. Only the neighborhoods these facts touch are recomputed. Code
 * detections are derived leads, not records, and are not read here. Pure code:
 * no model.
 */
export function addExtractedItems(items: readonly ExtractableItem[]): ExtractedItemsUpdate {
  const graph = processGraph.graph;
  const affected = new Set<string>();
  let facts = 0;
  let added = 0;
  for (const item of items) {
    if (item.source === CODE_SIGNAL_SOURCE) continue;
    const itemFacts = factsFromItem(item);
    holdItem(processGraph, item.id, item.fetchedAt, itemFacts);
    for (const fact of itemFacts) {
      facts += 1;
      const result = graph.add(fact);
      if (result.affected.length > 0) added += 1;
      for (const hood of result.affected) affected.add(hood);
    }
  }
  return { facts, added, affected: [...affected].sort() };
}

/**
 * Bring the process graph up to date with the durable `feed_detections` and
 * `feed_items` rows.
 *
 * Stored feed items (not code detections, which are derived) are read past
 * their own (fetched_at, id) cursor — a fresh process from
 * `EVENT_GRAPH_ITEM_WINDOW_MS` back — through `factsFromItem`, so the wants,
 * offers, capacities, prices and renewals the records state, with their places,
 * reach the rules; without them every rule but a job-post cluster has nothing
 * to join.
 *
 * Incremental: it reads only rows whose `updated_at` moved past its cursor (a
 * new detection, one that grew, one promoted or rolled back), in pages, and
 * adds each as one event, so only the neighborhoods those rows touch are
 * recomputed and an unchanged row recomputes nothing. A fresh process starts
 * with no cursor and reads every row once — the rows are the graph's durable
 * state, so nothing is lost across a restart. Only ACTIVE detections enter: a
 * SHADOW rule's output is unverified (its promotion gate is `detectors.ts`),
 * and a detection rolled back to SHADOW leaves the graph. Concurrent callers
 * share one sync. Nothing here calls a model.
 */
export function syncEventGraph(now: Date = new Date()): Promise<EventGraphSync> {
  const held = processGraph;
  if (held.running) return held.running;
  const run = (async (): Promise<EventGraphSync> => {
    const recomputed = new Set<string>();
    let read = 0;
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    for (;;) {
      const cursor = held.cursor;
      const rows = await getDb().all<StoredDetection>(
        cursor
          ? `SELECT id, rule_id, group_key, label, entity_key, category, window_from, window_to, member_ids, source_urls, mode, updated_at
               FROM feed_detections WHERE updated_at > ? OR (updated_at = ? AND id > ?)
              ORDER BY updated_at, id LIMIT ${EVENT_GRAPH_SYNC_PAGE}`
          : `SELECT id, rule_id, group_key, label, entity_key, category, window_from, window_to, member_ids, source_urls, mode, updated_at
               FROM feed_detections ORDER BY updated_at, id LIMIT ${EVENT_GRAPH_SYNC_PAGE}`,
        cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [],
      );
      if (rows.length === 0) break;
      const sources = await sourcesOf(rows.flatMap((row) => parsedList(row.member_ids)));
      for (const row of rows) {
        read += 1;
        const factId = `detection:${row.rule_id}|${row.group_key}`;
        const memberIds = parsedList(row.member_ids);
        const fact =
          row.mode === 'ACTIVE' && memberIds.length > 0
            ? factFromDetection(
                {
                  groupKey: `${row.rule_id}|${row.group_key}`,
                  label: row.label,
                  entityKey: row.entity_key,
                  entityName: row.entity_key,
                  category: row.category,
                  windowFrom: row.window_from,
                  windowTo: row.window_to,
                  memberIds,
                  sourceUrls: parsedList(row.source_urls),
                },
                (rawId) => sources.get(rawId) ?? 'feed',
              )
            : null;
        const result = fact ? held.graph.add(fact) : held.graph.remove(factId);
        if (result.affected.length === 0) unchanged += 1;
        else if (fact) added += 1;
        else removed += 1;
        for (const hood of result.affected) recomputed.add(hood);
      }
      const last = rows[rows.length - 1]!;
      held.cursor = { updatedAt: last.updated_at, id: last.id };
      if (rows.length < EVENT_GRAPH_SYNC_PAGE) break;
    }
    // The stored records themselves, through the deterministic extractor: the wants, offers,
    // capacities, prices and renewals they state, with place, quantity, price and window — the
    // facts every rule but a job-post cluster needs. Code detections are derived, not records.
    let itemsRead = 0;
    for (;;) {
      const cursor = held.itemCursor;
      const floor = new Date(now.getTime() - EVENT_GRAPH_ITEM_WINDOW_MS).toISOString();
      const rows = await getDb().all<StoredItem>(
        cursor
          ? `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
              WHERE source <> ? AND (fetched_at > ? OR (fetched_at = ? AND id > ?))
              ORDER BY fetched_at, id LIMIT ${EVENT_GRAPH_SYNC_PAGE}`
          : `SELECT id, source, url, title, body, organization, published_at, fetched_at FROM feed_items
              WHERE source <> ? AND fetched_at >= ?
              ORDER BY fetched_at, id LIMIT ${EVENT_GRAPH_SYNC_PAGE}`,
        cursor ? [CODE_SIGNAL_SOURCE, cursor.fetchedAt, cursor.fetchedAt, cursor.id] : [CODE_SIGNAL_SOURCE, floor],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        read += 1;
        itemsRead += 1;
        const facts = factsFromItem({
          id: row.id,
          source: row.source,
          url: row.url,
          title: row.title,
          body: row.body,
          organization: row.organization,
          publishedAt: row.published_at,
          fetchedAt: row.fetched_at,
        });
        if (facts.length === 0) {
          unchanged += 1;
          continue;
        }
        holdItem(held, row.id, row.fetched_at, facts);
        let moved = false;
        for (const fact of facts) {
          const result = held.graph.add(fact);
          if (result.affected.length > 0) moved = true;
          for (const hood of result.affected) recomputed.add(hood);
        }
        if (moved) added += 1;
        else unchanged += 1;
      }
      const last = rows[rows.length - 1]!;
      held.itemCursor = { fetchedAt: last.fetched_at, id: last.id };
      if (rows.length < EVENT_GRAPH_SYNC_PAGE) break;
    }
    const expired = expireItems(held, new Date(now.getTime() - EVENT_GRAPH_ITEM_WINDOW_MS).toISOString());
    removed += expired.removed;
    for (const hood of expired.affected) recomputed.add(hood);
    const sync: EventGraphSync = {
      read,
      added,
      removed,
      unchanged,
      recomputed: [...recomputed].sort(),
      facts: held.graph.size(),
      hypotheses: held.graph.hypotheses().length,
      cursor: held.cursor,
      itemsRead,
      itemCursor: held.itemCursor,
      at: now.toISOString(),
    };
    held.last = sync;
    return sync;
  })();
  held.running = run;
  return run.finally(() => {
    if (held.running === run) held.running = null;
  });
}
