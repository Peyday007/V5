/**
 * Commercial intermediation's discovery buckets (RES-15-4; S-0148, S-0149, S-0150).
 *
 * `intermediationPositions.ts` says *what* research must establish at a position; this
 * says *where discovery starts looking* for transactions that could be held from one.
 * They are ordinary `SearchBucket`s, opened through `openDiscovery`'s one loop, so there
 * is no second scheduler, store or authority path here (§10.3, §20.4).
 *
 * Each bucket is one S-0149 entry point, tagged BUYER_FIRST or SUPPLY_FIRST, with the
 * buyer type and the market structure it asks about, so the set spans different kinds of
 * buyer and market rather than repeating one industry search with the noun changed.
 * Industries appear only as examples inside a question and never as a filter (R01-A1,
 * §18.1); `bucketDiversityProblems` refuses a set where two questions differ only by an
 * industry noun.
 *
 * While `INTERMEDIATION_FAMILY` is current, discovery opens these first; when it lapses
 * they stay in `SEARCH_BUCKETS` and take their turn in the ordinary fair order.
 */
import type { SearchBucket } from './discovery.ts';
import type { CashMechanism } from '../../domain/types.ts';
import {
  ENTRY_POINTS,
  EVIDENCE_FIELDS,
  INTERMEDIATION_FAMILY,
  POSITIONS,
  familyCurrent,
  type FamilyDeclaration,
} from './intermediationPositions.ts';

export type EntryDirection = keyof typeof ENTRY_POINTS;
export type EntryPoint = (typeof ENTRY_POINTS)[EntryDirection][number];

export type BuyerType = 'BUSINESS' | 'CONSUMER' | 'PUBLIC_BODY' | 'INSTITUTION' | 'ANY';
export type MarketStructure =
  | 'FRAGMENTED_LOCAL_SERVICE'
  | 'CONCENTRATED_SUPPLY'
  | 'PUBLIC_PROCUREMENT'
  | 'TWO_SIDED_PLATFORM'
  | 'WHOLESALE_CHAIN'
  | 'CONTRACTED_RECURRING'
  | 'PROJECT_BASED';

export interface IntermediationBucket extends SearchBucket {
  entry: EntryDirection;
  entryPoint: EntryPoint;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  /** The part of the question that is this bucket's own; the shared position/evidence ask follows it. */
  ask: string;
}

export const INTERMEDIATION_BUCKET_PREFIX = 'intermediation-';

const POSITION_LABELS = Object.values(POSITIONS).map((one) => one.label).join(', ');

/** Industries as examples inside a sentence, never as the place the search is confined to. */
const EXAMPLES_SENTENCE =
  `Look in any industry; ${INTERMEDIATION_FAMILY.examples.join(', ')} are examples of where this ` +
  'happens, not limits on where to look.';

/** The S-0148 position comparison and the S-0150 per-position evidence, asked of every bucket. */
const POSITION_EVIDENCE_SENTENCE =
  `For each transaction found, compare the lawful positions it could be held from — ${POSITION_LABELS}, ` +
  'or any other position the evidence shows — and at the position that fits best, name: ' +
  Object.values(EVIDENCE_FIELDS).join('; ') +
  ', and the contracts, rights, liabilities, restrictions and counterparty expectations at exactly ' +
  'that position. Where a source establishes only a public asking price or a total market size, ' +
  'say so, and name separately what is still unknown about reaching that buyer and about whether ' +
  'they convert.';

interface Spec {
  key: string;
  entry: EntryDirection;
  entryPoint: EntryPoint;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  mechanism: CashMechanism;
  title: string;
  ask: string;
}

const SPECS: readonly Spec[] = [
  {
    key: 'purchase-requests',
    entry: 'BUYER_FIRST',
    entryPoint: 'explicit purchase requests',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'PUBLIC_PROCUREMENT',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    title: 'Published purchase requests a third party could fill by arranging supply',
    ask:
      'Which buyers — public bodies, institutions or companies — have published a request to purchase ' +
      'goods or services (a tender, RFQ, bid notice or buying-group call) that the buyer will award to ' +
      'whoever arranges qualifying supply, rather than only to the maker?',
  },
  {
    key: 'direct-inquiries',
    entry: 'BUYER_FIRST',
    entryPoint: 'direct inquiries',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED_LOCAL_SERVICE',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    title: 'Inbound buyer inquiries that suppliers fail to answer',
    ask:
      'Where are households or individuals sending inquiries — quote forms, community requests, ' +
      'review-site questions, call-backs — to many small independent suppliers who answer slowly or ' +
      'not at all, so that somebody routing those inquiries to a supplier with capacity would be paid?',
  },
  {
    key: 'repeat-services',
    entry: 'BUYER_FIRST',
    entryPoint: 'repeat services',
    buyerType: 'BUSINESS',
    marketStructure: 'CONTRACTED_RECURRING',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    title: 'Services companies buy on a schedule from many vendors',
    ask:
      'Which services do companies buy again on a fixed cycle (weekly, monthly, seasonally) from a ' +
      'scattered set of vendors, where consolidating those purchases under one arranger is published ' +
      'as saving them money or management time?',
  },
  {
    key: 'renewal-points',
    entry: 'BUYER_FIRST',
    entryPoint: 'contract renewal points',
    buyerType: 'INSTITUTION',
    marketStructure: 'CONTRACTED_RECURRING',
    mechanism: 'TEMPORARY_EXPLOIT',
    title: 'Supply contracts coming up for renewal or rebid',
    ask:
      'Which schools, hospitals, associations, landlords or other institutions have a published supply ' +
      'or service contract ending, being rebid or up for renewal in the coming months, and what does ' +
      'the record say about the incumbent, the term and how a replacement arrangement is chosen?',
  },
  {
    key: 'recurring-flows',
    entry: 'BUYER_FIRST',
    entryPoint: 'recurring flows',
    buyerType: 'BUSINESS',
    marketStructure: 'WHOLESALE_CHAIN',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Recurring volumes moving between the same kinds of parties',
    ask:
      'Which steady flows of material, product, waste, by-product or work move repeatedly from one kind ' +
      'of business to another (for example offcuts to recyclers, overflow orders to peers, returns to ' +
      'refurbishers), where the party that organises the flow takes a published per-unit margin?',
  },
  {
    key: 'under-served-channels',
    entry: 'BUYER_FIRST',
    entryPoint: 'under-served channels',
    buyerType: 'ANY',
    marketStructure: 'TWO_SIDED_PLATFORM',
    mechanism: 'INFORMATION_ASYMMETRY',
    title: 'Buyer groups the usual sales channels do not reach',
    ask:
      'Which groups of buyers — by language, trade association, online community, procurement portal ' +
      'or geography — have published that they cannot find suppliers through the usual channels, and ' +
      'which suppliers have said they cannot reach those buyers?',
  },
  {
    key: 'unused-capacity',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'unused supplier capacity',
    buyerType: 'BUSINESS',
    marketStructure: 'CONCENTRATED_SUPPLY',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    title: 'Operators publishing idle equipment, crews or time slots',
    ask:
      'Which operators — plants, fleets, workshops, crews, kitchens, warehouses, studios — have published ' +
      'idle hours, spare shifts or open slots they want filled, and on what terms they accept work ' +
      'brought to them by someone else?',
  },
  {
    key: 'partner-inventory',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'distributor or partner inventory',
    buyerType: 'BUSINESS',
    marketStructure: 'WHOLESALE_CHAIN',
    mechanism: 'RESALE_OR_ASSET',
    title: 'Distributor and partner stock open to outside sellers',
    ask:
      'Which wholesalers, manufacturers or distributors publish dealer, partner, drop-ship or ' +
      'consignment programmes letting an outside party sell their inventory, with the published ' +
      'discount, minimums, and who holds the stock and the customer relationship?',
  },
  {
    key: 'bundled-supply',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'bundled supply',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'PROJECT_BASED',
    mechanism: 'JIGSAW_COMBINATION',
    title: 'Jobs that need several suppliers combined into one offer',
    ask:
      'Which buyers want a single accountable offer for a job that today requires several separate ' +
      'suppliers (materials plus labour plus transport plus permits, say), and which complementary ' +
      'suppliers have each published only one piece of it?',
  },
  {
    key: 'pricing-spreads',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'pricing spreads',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED_LOCAL_SERVICE',
    mechanism: 'CAPABILITY_ARBITRAGE',
    title: 'The same supply sold at two published prices to different buyers',
    ask:
      'Where does one supplier, or one class of supplier, publish a trade, bulk or off-peak price that ' +
      'is materially below what consumers are published as paying for the same thing, and what does ' +
      'the source say about who may buy at the lower price and pass it on?',
  },
  {
    key: 'intermediary-economics',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'existing intermediary economics',
    buyerType: 'ANY',
    marketStructure: 'TWO_SIDED_PLATFORM',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'What existing intermediaries publish about their own take',
    ask:
      'Which existing brokers, agents, aggregators, platforms or prime contractors publish their own ' +
      'fee, commission, take rate or margin — in filings, rate cards, partner terms or disputes — and ' +
      'what does that show about where a new intermediary could stand and what it would keep?',
  },
];

function bucketOf(spec: Spec): IntermediationBucket {
  return {
    id: `${INTERMEDIATION_BUCKET_PREFIX}${spec.key}`,
    mechanism: spec.mechanism,
    title: spec.title,
    question: `${spec.ask} ${EXAMPLES_SENTENCE} ${POSITION_EVIDENCE_SENTENCE}`,
    entry: spec.entry,
    entryPoint: spec.entryPoint,
    buyerType: spec.buyerType,
    marketStructure: spec.marketStructure,
    ask: spec.ask,
  };
}

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze(SPECS.map(bucketOf));

export function isIntermediationBucket(bucket: Pick<SearchBucket, 'id'>): boolean {
  return bucket.id.startsWith(INTERMEDIATION_BUCKET_PREFIX);
}

// ── checks ───────────────────────────────────────────────────────────────────

/** Every S-0149 entry point no bucket covers. Empty when the set is complete. */
export function uncoveredEntryPoints(buckets: readonly IntermediationBucket[]): EntryPoint[] {
  const covered = new Set<string>(buckets.map((one) => one.entryPoint));
  const all = [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST] as EntryPoint[];
  return all.filter((point) => !covered.has(point));
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'for', 'and', 'or', 'on', 'by', 'at', 'is', 'are', 'that', 'which', 'what', 'who', 'with', 'from', 'as', 'it', 'its', 'their', 'they', 'be', 'industry', 'industries', 'sector', 'sectors', 'business', 'businesses', 'companies', 'firms']);

function tokens(text: string, industries: readonly string[]): Set<string> {
  let lowered = text.toLowerCase();
  for (const noun of industries) lowered = lowered.split(noun.toLowerCase()).join(' ');
  return new Set(lowered.split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const word of a) if (b.has(word)) both += 1;
  return both / (a.size + b.size - both);
}

export interface DiversityProblem {
  kind: 'NEAR_DUPLICATE' | 'ONE_BUYER_TYPE' | 'ONE_MARKET_STRUCTURE' | 'ONE_DIRECTION';
  detail: string;
}

/**
 * Pure: why a bucket set is not a broad search. Two questions whose own asks are the same
 * once industry nouns are removed are near-duplicates — the same search with the industry
 * changed. A set must also span more than one buyer type, market structure and direction.
 */
export function bucketDiversityProblems(
  buckets: readonly Pick<IntermediationBucket, 'id' | 'ask' | 'entry' | 'buyerType' | 'marketStructure'>[],
  industries: readonly string[] = INDUSTRY_NOUNS,
  threshold = 0.8,
): DiversityProblem[] {
  const problems: DiversityProblem[] = [];
  const sets = buckets.map((one) => tokens(one.ask, industries));
  for (let i = 0; i < buckets.length; i += 1) {
    for (let j = i + 1; j < buckets.length; j += 1) {
      if (jaccard(sets[i]!, sets[j]!) >= threshold) {
        problems.push({ kind: 'NEAR_DUPLICATE', detail: `${buckets[i]!.id} and ${buckets[j]!.id} differ only by industry` });
      }
    }
  }
  if (buckets.length > 1) {
    if (new Set(buckets.map((one) => one.buyerType)).size < 2) problems.push({ kind: 'ONE_BUYER_TYPE', detail: 'every bucket asks about the same buyer type' });
    if (new Set(buckets.map((one) => one.marketStructure)).size < 2) problems.push({ kind: 'ONE_MARKET_STRUCTURE', detail: 'every bucket asks about the same market structure' });
    if (new Set(buckets.map((one) => one.entry)).size < 2) problems.push({ kind: 'ONE_DIRECTION', detail: 'buckets are all buyer-first or all supply-first' });
  }
  return problems;
}

/** Industry nouns the diversity check treats as interchangeable: the family's examples and common siblings. */
export const INDUSTRY_NOUNS: readonly string[] = Object.freeze([
  ...INTERMEDIATION_FAMILY.examples,
  'regulated-industry',
  'janitorial',
  'construction',
  'roofing',
  'plumbing',
  'electrical',
  'hvac',
  'landscaping',
  'freight',
  'trucking',
  'warehousing',
  'wholesale',
  'printing',
  'packaging',
  'catering',
  'healthcare',
  'insurance',
  'legal',
  'accounting',
  'software',
]);

/** The defaults S-0149 forbids research to fall back on, as patterns over a question. */
export const FORBIDDEN_DEFAULTS: readonly RegExp[] = Object.freeze([
  /\bcity\b/i,
  /physical presence/i,
  /\bcatalog(ue)?\b/i,
  /cold[- ]e-?mail/i,
  /\be-?mail\b/i,
  /ai[- ]produced|digital work/i,
]);

/** Which forbidden default a question names, if any. */
export function forbiddenDefaultsIn(question: string): string[] {
  return FORBIDDEN_DEFAULTS.filter((pattern) => pattern.test(question)).map((pattern) => pattern.source);
}

// ── ordering ─────────────────────────────────────────────────────────────────

/**
 * Pure: put intermediation buckets first while the family declaration is current, keeping
 * the relative order `ordered` already gave each part. When it lapses, `ordered` is
 * returned as it is, so the buckets keep their place in the ordinary fair order.
 */
export function orderForFamily<T extends Pick<SearchBucket, 'id'>>(
  ordered: readonly T[],
  now: Date | string,
  declaration: FamilyDeclaration = INTERMEDIATION_FAMILY,
): T[] {
  if (!familyCurrent(declaration, now)) return [...ordered];
  return [...ordered.filter(isIntermediationBucket), ...ordered.filter((one) => !isIntermediationBucket(one))];
}
