/**
 * Commercial intermediation's search buckets: where research enters a market (RES-15-4; S-0149).
 *
 * "Research must span different buyer types and market structures, not merely run
 * near-duplicate industry searches. Discover both buyer-first and supply-first entry
 * points …" The positions a transaction can be held from, the per-position evidence
 * contract and the family's dated priority all live in `intermediationPositions.ts`; this
 * module is only the places discovery looks from, as ordinary `SearchBucket`s, so they are
 * opened, re-asked, harvested and judged by exactly the machinery every other bucket uses
 * (`openDiscovery` in `discovery.ts`). No store, scheduler or authority of its own.
 *
 * Every bucket is tagged with the side it enters from (BUYER_FIRST or SUPPLY_FIRST), the
 * buyer type it reaches and the market structure it reads, and names the S-0149 entry
 * points it covers. Industries appear only as examples inside a question's own words —
 * never as a filter, never as a boundary (R01-A1). No question names the owner's city,
 * physical presence, the existing catalogue, cold email or AI-produced digital work as a
 * default; each asks for the payer, the reachable channel, the supply and the spread at a
 * named position, because the deliverable is evidence per constructed position (S-0150).
 *
 * `bucketDiversity` is pure: it refuses a set in which two questions differ only by an
 * industry noun, which is what a near-duplicate industry search is. `familyOrder` puts
 * these buckets first while the family declaration is current and leaves the ordinary
 * order untouched once it lapses.
 */
import type { CashMechanism } from '../../domain/types.ts';
import type { SearchBucket } from './discovery.ts';
import { ENTRY_POINTS, familyCurrent, INTERMEDIATION_FAMILY, type FamilyDeclaration } from './intermediationPositions.ts';

export type EntrySide = 'BUYER_FIRST' | 'SUPPLY_FIRST';

/** Who pays. Open: a buyer type research discovers is carried as written. */
export type BuyerType = 'BUSINESS' | 'CONSUMER' | 'PUBLIC_BODY' | 'NONPROFIT_OR_INSTITUTION' | (string & {});

/** How the market clears. Open in the same way. */
export type MarketStructure =
  | 'FRAGMENTED_LOCAL_SERVICE'
  | 'RECURRING_CONTRACT'
  | 'PROCUREMENT_TENDER'
  | 'TWO_SIDED_PLATFORM'
  | 'DISTRIBUTION_CHAIN'
  | 'CAPACITY_MARKET'
  | 'ESTABLISHED_INTERMEDIARY'
  | (string & {});

/** One S-0149 entry point, spelled exactly as `ENTRY_POINTS` spells it. */
export type EntryPoint = (typeof ENTRY_POINTS)[EntrySide][number];

export interface IntermediationBucket extends SearchBucket {
  entry: EntrySide;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  /** The S-0149 entry points this bucket's question searches. */
  covers: readonly EntryPoint[];
}

/** The evidence every intermediation question asks for, per position (S-0150). */
const PER_POSITION =
  'For each one, which position could the transaction be held from (introducer, referrer, ' +
  'representative, lead supplier, broker, coordinator, distributor, reseller, subcontracting ' +
  'principal, marketplace, control-right holder, or another that fits better), and at that ' +
  'position who exactly pays, through which reachable channel, on what observed demand, from ' +
  'which supplier or capacity source, at what price and spread, how long until cash, under which ' +
  'rights or contract terms, and what is the fastest meaningful next step?';

const bucket = (
  b: Omit<IntermediationBucket, 'question'> & { ask: string },
): IntermediationBucket =>
  Object.freeze({
    id: b.id,
    mechanism: b.mechanism,
    title: b.title,
    question: `${b.ask} ${PER_POSITION}`,
    entry: b.entry,
    buyerType: b.buyerType,
    marketStructure: b.marketStructure,
    covers: Object.freeze([...b.covers]),
  });

const M = (m: CashMechanism): CashMechanism => m;

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze([
  // ── buyer-first ──────────────────────────────────────────────────────────
  bucket({
    id: 'intermediation-purchase-requests',
    mechanism: M('EXPLICIT_PAID_REQUEST'),
    title: 'Businesses publicly asking to buy something a supplier already provides',
    entry: 'BUYER_FIRST',
    buyerType: 'BUSINESS',
    marketStructure: 'FRAGMENTED_LOCAL_SERVICE',
    covers: ['explicit purchase requests', 'direct inquiries'],
    ask:
      'Where are businesses publishing explicit requests to buy a service or supply that an existing ' +
      'supplier could fulfil — request-for-quote boards, buyer forums, trade groups, inquiry pages — ' +
      '(commercial cleaning or concrete work are examples, not limits), naming the request, the date ' +
      'and the stated budget?',
  }),
  bucket({
    id: 'intermediation-public-renewals',
    mechanism: M('EXISTING_BUYING_SIGNAL'),
    title: 'Public bodies whose service contracts come up for renewal',
    entry: 'BUYER_FIRST',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'PROCUREMENT_TENDER',
    covers: ['contract renewal points', 'recurring flows'],
    ask:
      'Which public bodies, schools or agencies have a published service or supply contract expiring ' +
      'or being re-let soon, naming the contract, its current holder and value, the renewal date, ' +
      'and whether the incumbent subcontracts or a teaming partner could bid alongside them?',
  }),
  bucket({
    id: 'intermediation-repeat-services',
    mechanism: M('SUBCONTRACTED_FULFILMENT'),
    title: 'Services an organisation buys again and again from whoever answers',
    entry: 'BUYER_FIRST',
    buyerType: 'NONPROFIT_OR_INSTITUTION',
    marketStructure: 'RECURRING_CONTRACT',
    covers: ['repeat services', 'recurring flows'],
    ask:
      'Which services do institutions — clinics, property managers, nonprofits, campuses — re-order on ' +
      'a fixed cycle without a standing supplier (maintenance trades or recurring marketing work are ' +
      'examples), naming who orders, how often, the published or quoted price per cycle, and how a new ' +
      'supplier is chosen?',
  }),
  bucket({
    id: 'intermediation-underserved-consumers',
    mechanism: M('SUPPLY_DEMAND_MISMATCH'),
    title: 'Households asking for help a channel does not serve well',
    entry: 'BUYER_FIRST',
    buyerType: 'CONSUMER',
    marketStructure: 'TWO_SIDED_PLATFORM',
    covers: ['under-served channels', 'direct inquiries'],
    ask:
      'Where do households repeatedly post that they cannot find, book or get a reply from a supplier ' +
      'for something they will pay for — community boards, review sites, platform listings with ' +
      'no takers — naming the channel, the volume of unanswered asks, the price people say they will ' +
      'pay, and which suppliers have capacity but are absent from that channel?',
  }),
  // ── supply-first ─────────────────────────────────────────────────────────
  bucket({
    id: 'intermediation-idle-capacity',
    mechanism: M('CAPABILITY_ARBITRAGE'),
    title: 'Suppliers publishing capacity they cannot fill',
    entry: 'SUPPLY_FIRST',
    buyerType: 'BUSINESS',
    marketStructure: 'CAPACITY_MARKET',
    covers: ['unused supplier capacity'],
    ask:
      'Which operators are publicly advertising unused capacity — empty trucks on backhaul lanes, idle ' +
      'production lines, open crew days, warehouse space (logistics and manufacturing are examples, not ' +
      'limits) — naming the operator, the capacity and its dates, the rate they ask, and the buyers ' +
      'who currently pay more for the same capacity elsewhere?',
  }),
  bucket({
    id: 'intermediation-partner-inventory',
    mechanism: M('RESALE_OR_ASSET'),
    title: 'Distributor and partner inventory looking for resellers',
    entry: 'SUPPLY_FIRST',
    buyerType: 'BUSINESS',
    marketStructure: 'DISTRIBUTION_CHAIN',
    covers: ['distributor or partner inventory', 'bundled supply'],
    ask:
      'Which distributors, wholesalers or manufacturers publish reseller, partner or dealer programmes ' +
      'with stock or service they want sold on, naming the programme, its wholesale and suggested ' +
      'resale price, the minimums and territory terms, and which buyer segment the programme says is ' +
      'under-covered?',
  }),
  bucket({
    id: 'intermediation-price-spreads',
    mechanism: M('INFORMATION_ASYMMETRY'),
    title: 'The same supply priced very differently to different buyers',
    entry: 'SUPPLY_FIRST',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'PROCUREMENT_TENDER',
    covers: ['pricing spreads'],
    ask:
      'Where do published award notices, price lists or contract registers show public buyers paying ' +
      'well above what the same supply is published at by its maker or wholesaler, naming both prices ' +
      'and their sources, the buyer, and the vehicle (framework, schedule, cooperative contract) that ' +
      'a supplier must be on to sell to that buyer?',
  }),
  bucket({
    id: 'intermediation-bundled-supply',
    mechanism: M('JIGSAW_COMBINATION'),
    title: 'Buyers who need several suppliers delivered as one outcome',
    entry: 'SUPPLY_FIRST',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED_LOCAL_SERVICE',
    covers: ['bundled supply', 'unused supplier capacity'],
    ask:
      'Which outcomes do households buy that need two or more separate suppliers to deliver — a move ' +
      'with storage and cleaning, a renovation with several trades, an event with venue and catering — ' +
      'naming the suppliers who each publish one part, their published prices, and what a single ' +
      'coordinated package sells for where one is offered?',
  }),
  bucket({
    id: 'intermediation-existing-intermediaries',
    mechanism: M('SUPPLY_DEMAND_MISMATCH'),
    title: 'How the intermediaries already in a market are paid',
    entry: 'SUPPLY_FIRST',
    buyerType: 'NONPROFIT_OR_INSTITUTION',
    marketStructure: 'ESTABLISHED_INTERMEDIARY',
    covers: ['existing intermediary economics', 'contract renewal points'],
    ask:
      'In which markets do existing agents, brokers, referral networks or regulated-industry partners ' +
      '(insurance, healthcare and freight are examples) publish their fee, commission or referral terms, ' +
      'naming the intermediary, who pays it and how much, the licence or partnership that lets them ' +
      'hold the position, and whether the terms let a newcomer join under them as a sub-agent or partner?',
  }),
]);

const INTERMEDIATION_IDS: ReadonlySet<string> = new Set(INTERMEDIATION_BUCKETS.map((one) => one.id));

/** Whether a bucket is one of the intermediation family's own. */
export function isIntermediationBucket(bucket: Pick<SearchBucket, 'id'>): boolean {
  return INTERMEDIATION_IDS.has(bucket.id);
}

// ── coverage and diversity ───────────────────────────────────────────────────

/** The S-0149 entry points no bucket in the set covers. Empty when every one is searched. */
export function uncoveredEntryPoints(buckets: readonly Pick<IntermediationBucket, 'covers'>[]): EntryPoint[] {
  const covered = new Set<string>(buckets.flatMap((one) => one.covers));
  return [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST].filter((one) => !covered.has(one));
}

/**
 * Industry nouns that, swapped one for another, make a near-duplicate search. Drawn from
 * the family's examples plus common trades; an industry missing here is not excluded from
 * anything — this list only decides which words are ignored when two questions are compared.
 */
const INDUSTRY_NOUNS = new Set([
  ...INTERMEDIATION_FAMILY.examples.flatMap((one) => one.toLowerCase().split(/[^a-z]+/)),
  'cleaning', 'concrete', 'trade', 'trades', 'logistics', 'distribution', 'manufacturing', 'marketing', 'ai',
  'plumbing', 'electrical', 'roofing', 'landscaping', 'painting', 'hvac', 'freight', 'trucking', 'catering',
  'staffing', 'security', 'janitorial', 'construction', 'insurance', 'healthcare', 'legal', 'accounting',
  'printing', 'packaging', 'moving', 'storage', 'regulated', 'industry', 'partnerships', 'commercial',
  'residential', 'software', 'design', 'web', 'seo',
]);

function shape(question: string): string {
  return question
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0 && !INDUSTRY_NOUNS.has(word))
    .join(' ');
}

export interface DiversityReading {
  ok: boolean;
  /** Pairs of bucket ids whose questions differ only by industry nouns. */
  nearDuplicates: Array<[string, string]>;
  buyerTypes: string[];
  marketStructures: string[];
  sides: EntrySide[];
  uncovered: EntryPoint[];
  problems: string[];
}

/**
 * Whether a bucket set is broad: both sides, more than one buyer type and market structure,
 * every S-0149 entry point covered, and no two questions that differ only by an industry noun.
 */
export function bucketDiversity(buckets: readonly IntermediationBucket[]): DiversityReading {
  const nearDuplicates: Array<[string, string]> = [];
  const shapes = buckets.map((one) => shape(one.question));
  for (let i = 0; i < buckets.length; i += 1) {
    for (let j = i + 1; j < buckets.length; j += 1) {
      if (shapes[i] === shapes[j]) nearDuplicates.push([buckets[i]!.id, buckets[j]!.id]);
    }
  }
  const buyerTypes = [...new Set(buckets.map((one) => one.buyerType))];
  const marketStructures = [...new Set(buckets.map((one) => one.marketStructure))];
  const sides = [...new Set(buckets.map((one) => one.entry))];
  const uncovered = uncoveredEntryPoints(buckets);
  const problems: string[] = [];
  if (nearDuplicates.length > 0) problems.push(`near-duplicate searches differing only by industry: ${nearDuplicates.map((p) => p.join(' ~ ')).join(', ')}`);
  if (buyerTypes.length < 2) problems.push('only one buyer type is searched');
  if (marketStructures.length < 2) problems.push('only one market structure is searched');
  if (!sides.includes('BUYER_FIRST')) problems.push('no buyer-first entry point');
  if (!sides.includes('SUPPLY_FIRST')) problems.push('no supply-first entry point');
  if (uncovered.length > 0) problems.push(`entry points not searched: ${uncovered.join(', ')}`);
  return { ok: problems.length === 0, nearDuplicates, buyerTypes, marketStructures, sides, uncovered, problems };
}

/** Phrases that would make a question default to something S-0149 says not to default to. */
export const FORBIDDEN_DEFAULTS: readonly RegExp[] = Object.freeze([
  /owner[’']?s? (own )?(city|town|area|location)/i,
  /physical presence/i,
  /in person/i,
  /existing catalog(ue)?/i,
  /cold[- ]?e?mail/i,
  /\bAI[- ](produced|generated)\b/i,
  /digital (work|deliverable|product)s? (we|brain) (make|produce)/i,
]);

/** The ids of buckets whose question names one of the forbidden defaults. */
export function defaultingBuckets(buckets: readonly SearchBucket[]): string[] {
  return buckets.filter((one) => FORBIDDEN_DEFAULTS.some((re) => re.test(one.question))).map((one) => one.id);
}

// ── ordering ─────────────────────────────────────────────────────────────────

/**
 * The family's own buckets first while its declaration is current, each set keeping its
 * relative order; the input order unchanged once the declaration lapses.
 */
export function familyOrder<T extends Pick<SearchBucket, 'id'>>(
  ordered: readonly T[],
  now: Date | string,
  declaration: FamilyDeclaration = INTERMEDIATION_FAMILY,
): T[] {
  if (!familyCurrent(declaration, now)) return [...ordered];
  return [...ordered.filter(isIntermediationBucket), ...ordered.filter((one) => !isIntermediationBucket(one))];
}

const reading = bucketDiversity(INTERMEDIATION_BUCKETS);
if (!reading.ok) throw new Error(`INTERMEDIATION_BUCKETS is not broad: ${reading.problems.join('; ')}`);
