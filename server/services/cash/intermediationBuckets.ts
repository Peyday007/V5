/**
 * Intermediation entry buckets: where discovery starts looking for a transaction Brain
 * could hold from an intermediary position (RES-15-4; S-0148, S-0149, S-0150).
 *
 * "Research must span different buyer types and market structures, not merely run
 * near-duplicate industry searches. Discover both buyer-first and supply-first entry
 * points …" Each bucket here is one entry point from `ENTRY_POINTS`, tagged with the end it
 * starts from, the kind of buyer it is about and the market structure it looks inside, and
 * every question asks for the per-position evidence S-0150 names rather than industry facts.
 *
 * Industries appear only inside a "(for example: … — examples, not limits)" clause and
 * never as a filter (R01-A1). No question defaults to the owner's city, physical presence,
 * the existing catalogue, cold email or AI-produced digital work.
 *
 * These are ordinary `SearchBucket`s: discovery opens, records and harvests them through
 * its one machinery (no second scheduler, store or authority). Ordering them first while the
 * family declaration is current is `discoveryOrder` in `discovery.ts`.
 *
 * Pure data and pure checks.
 */
import type { CashMechanism } from '../../domain/types.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, POSITIONS } from './intermediationPositions.ts';

export type EntryEnd = keyof typeof ENTRY_POINTS;
export type EntryPoint = (typeof ENTRY_POINTS)[EntryEnd][number];

export type BuyerType = 'BUSINESS' | 'CONSUMER' | 'PUBLIC_BODY' | 'INSTITUTION' | 'SUPPLIER';

export type MarketStructure =
  | 'TENDERED'
  | 'FRAGMENTED'
  | 'CONCENTRATED_SUPPLY'
  | 'PLATFORM_MEDIATED'
  | 'DISTRIBUTION_CHAIN'
  | 'RECURRING_CONTRACT'
  | 'SPOT';

/** Structurally a `SearchBucket` (discovery.ts), plus what makes it an intermediation entry. */
export interface IntermediationBucket {
  id: string;
  mechanism: CashMechanism;
  title: string;
  question: string;
  entry: EntryEnd;
  entryPoint: EntryPoint;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  /** The part of the question that is this bucket's own; the rest is the shared evidence ask. */
  focus: string;
}

export const INTERMEDIATION_BUCKET_PREFIX = 'intermediation-';

const positionList = Object.values(POSITIONS).map((one) => one.label);

/**
 * What every intermediation question asks for, per position (S-0148, S-0150). Built from
 * the position catalogue so a position added there is asked about here.
 */
export const POSITION_EVIDENCE_ASK =
  `For each economically distinct position the transaction could be held from (${positionList.join(', ')}, ` +
  'or another position the sources show), what are: the exact payer and the reachable channel to them, the ' +
  'observed demand, the contractual or proposed offer, the supplier or capacity source, the price and the ' +
  'spread, acquisition cost and throughput, fulfilment obligations, margin and timing to cash, any ' +
  'buyer-funded cash structure (deposit, prepayment, milestones), the capital exposed, the transaction ' +
  'rights, contracts, liabilities and restrictions at that exact position, the limits, what is uncertain, ' +
  'and the fastest meaningful next action — and where a source shows only a public asking price or a total ' +
  'market size, what remains unknown, named separately, about reaching that buyer and converting them?';

const examples = (...names: string[]) => `(for example: ${names.join(', ')} — examples, not limits)`;

interface Spec {
  key: string;
  entry: EntryEnd;
  entryPoint: EntryPoint;
  mechanism: CashMechanism;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  title: string;
  focus: string;
}

const SPECS: readonly Spec[] = [
  {
    key: 'purchase-requests',
    entry: 'BUYER_FIRST',
    entryPoint: 'explicit purchase requests',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'TENDERED',
    title: 'Which published purchase requests could be filled through another firm’s capacity',
    focus:
      'Which public bodies, institutions or companies have published an explicit request to buy goods or ' +
      `services ${examples('cleaning', 'concrete', 'logistics')} — a tender, solicitation, RFQ or posted ` +
      'requirement still open — that an existing supplier could fulfil while somebody else holds the contract ' +
      'or the introduction?',
  },
  {
    key: 'direct-inquiries',
    entry: 'BUYER_FIRST',
    entryPoint: 'direct inquiries',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED',
    title: 'Where buyers publicly ask who can supply them',
    focus:
      'Where are households or small buyers publicly asking who can supply or do something for them — ' +
      `forums, community boards, Q&A sites, review replies ${examples('trades', 'cleaning')} — in a market ` +
      'with many small suppliers and no dominant one, so the inquiry itself is worth routing to whoever can take it?',
  },
  {
    key: 'repeat-services',
    entry: 'BUYER_FIRST',
    entryPoint: 'repeat services',
    mechanism: 'PRODUCTIZED_SERVICE',
    buyerType: 'BUSINESS',
    marketStructure: 'RECURRING_CONTRACT',
    title: 'Which services businesses rebuy on a schedule from whoever is in front of them',
    focus:
      'Which services do businesses buy again and again on a schedule — weekly, monthly, seasonally ' +
      `${examples('cleaning', 'manufacturing', 'marketing')} — where the published evidence shows buyers switch ` +
      'to whoever brings them a supplier, so standing between buyer and supplier earns on every repeat?',
  },
  {
    key: 'renewal-points',
    entry: 'BUYER_FIRST',
    entryPoint: 'contract renewal points',
    mechanism: 'TEMPORARY_EXPLOIT',
    buyerType: 'INSTITUTION',
    marketStructure: 'RECURRING_CONTRACT',
    title: 'Which contracts come up for renewal soon, with the date published',
    focus:
      'Which institutional or public contracts — schools, hospitals, housing bodies, municipalities, ' +
      `associations ${examples('logistics', 'regulated-industry partnerships')} — have a published expiry, ` +
      'renewal or re-procurement date in the coming months, naming the current terms and who decides the renewal?',
  },
  {
    key: 'recurring-flows',
    entry: 'BUYER_FIRST',
    entryPoint: 'recurring flows',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    buyerType: 'BUSINESS',
    marketStructure: 'DISTRIBUTION_CHAIN',
    title: 'Which recurring flows of goods, work or money pass through a chain of firms',
    focus:
      'Which recurring flows of goods, materials, work orders or payments pass between firms in a supply chain ' +
      `${examples('distribution', 'manufacturing', 'concrete')}, published with their volume and frequency, ` +
      'where a party that arranges, consolidates or finances part of the flow is paid per unit moved?',
  },
  {
    key: 'underserved-channels',
    entry: 'BUYER_FIRST',
    entryPoint: 'under-served channels',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    buyerType: 'CONSUMER',
    marketStructure: 'PLATFORM_MEDIATED',
    title: 'Which channels have buyers that suppliers are not reaching',
    focus:
      'Which platforms, communities, languages, regions or buying channels have published buyer demand that ' +
      `established suppliers visibly do not serve ${examples('trades', 'AI', 'marketing')} — unanswered requests, ` +
      'missing listings, long waits — and what would bringing an existing supplier into that channel take?',
  },
  {
    key: 'unused-capacity',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'unused supplier capacity',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    buyerType: 'SUPPLIER',
    marketStructure: 'FRAGMENTED',
    title: 'Which suppliers publish idle capacity they want filled',
    focus:
      'Which suppliers have published idle capacity they want filled — empty slots, unused equipment hours, ' +
      `spare crews, off-peak time, empty return trips ${examples('logistics', 'manufacturing', 'cleaning')} — ` +
      'naming the capacity, its published rate or discount, and what the supplier says about paying whoever fills it?',
  },
  {
    key: 'partner-inventory',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'distributor or partner inventory',
    mechanism: 'RESALE_OR_ASSET',
    buyerType: 'BUSINESS',
    marketStructure: 'CONCENTRATED_SUPPLY',
    title: 'Which manufacturers or distributors recruit partners to move inventory',
    focus:
      'Which manufacturers, importers or wholesalers publish partner, dealer, agent or reseller programmes to ' +
      `move stock or capacity they hold ${examples('distribution', 'manufacturing', 'AI')}, naming the published ` +
      'margin or commission, minimum commitments, territory, and which buyers they say they cannot reach themselves?',
  },
  {
    key: 'bundled-supply',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'bundled supply',
    mechanism: 'JIGSAW_COMBINATION',
    buyerType: 'INSTITUTION',
    marketStructure: 'FRAGMENTED',
    title: 'Which buyers want one package that separate suppliers each sell a part of',
    focus:
      'Which outcomes do buyers want delivered as one package while the parts are sold by separate suppliers ' +
      `who do not combine them ${examples('trades', 'concrete', 'marketing')} — named in published scopes, ` +
      'bid packages or complaints about juggling vendors — and what does each part cost on its own?',
  },
  {
    key: 'pricing-spreads',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'pricing spreads',
    mechanism: 'CAPABILITY_ARBITRAGE',
    buyerType: 'BUSINESS',
    marketStructure: 'SPOT',
    title: 'Where the same supply is priced differently to different buyers',
    focus:
      'Where is the same good, capacity or service sold at published prices that differ by buyer size, channel, ' +
      `region or contract form ${examples('logistics', 'distribution', 'regulated-industry partnerships')}, ` +
      'naming both prices, both sources and dates, and what terms decide whether the spread may lawfully be held?',
  },
  {
    key: 'intermediary-economics',
    entry: 'SUPPLY_FIRST',
    entryPoint: 'existing intermediary economics',
    mechanism: 'INFORMATION_ASYMMETRY',
    buyerType: 'SUPPLIER',
    marketStructure: 'PLATFORM_MEDIATED',
    title: 'What intermediaries already earn, and on what terms',
    focus:
      'Which agents, brokers, platforms, distributors or referral programmes publish what they earn per ' +
      `transaction ${examples('cleaning', 'trades', 'logistics', 'AI')} — commission rates, lead prices, take ` +
      'rates, finder’s fees — and what licence, contract or relationship the published terms say is needed to hold that position?',
  },
];

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze(
  SPECS.map(
    (spec): IntermediationBucket => ({
      id: `${INTERMEDIATION_BUCKET_PREFIX}${spec.key}`,
      mechanism: spec.mechanism,
      title: spec.title,
      question: `${spec.focus} ${POSITION_EVIDENCE_ASK}`,
      entry: spec.entry,
      entryPoint: spec.entryPoint,
      buyerType: spec.buyerType,
      marketStructure: spec.marketStructure,
      focus: spec.focus,
    }),
  ),
);

export function isIntermediationBucket(bucket: { id: string }): boolean {
  return bucket.id.startsWith(INTERMEDIATION_BUCKET_PREFIX);
}

// ── checks ───────────────────────────────────────────────────────────────────

/**
 * Industry nouns: the family's own examples and the common ones beside them. Only used to
 * strip industry from a question when judging diversity, and to see that an industry is
 * named only as an example — never to decide which industries may be searched.
 */
export const INDUSTRY_TERMS: readonly string[] = Object.freeze([
  ...INTERMEDIATION_FAMILY.examples.map((one) => one.toLowerCase()),
  'regulated industry',
  'regulated industries',
  'plumbing',
  'roofing',
  'landscaping',
  'hvac',
  'electrical',
  'freight',
  'trucking',
  'warehousing',
  'catering',
  'printing',
  'staffing',
  'insurance',
  'real estate',
  'healthcare',
  'dental',
  'legal',
  'accounting',
  'construction',
  'packaging',
  'janitorial',
  'solar',
  'software',
]);

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'by', 'with', 'who', 'which', 'what', 'that', 'is', 'are', 'it', 'its', 'as', 'at', 'from', 'do', 'does']);

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INDUSTRY_PATTERN = new RegExp(
  `\\b(?:${[...INDUSTRY_TERMS].sort((a, b) => b.length - a.length).map(escape).join('|')})\\b`,
  'gi',
);

function withoutIndustry(text: string): string {
  return text.replace(INDUSTRY_PATTERN, ' ');
}

function tokens(text: string): Set<string> {
  return new Set(
    withoutIndustry(text.replace(/\(for example:[^)]*\)/gi, ' '))
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((one) => one.length > 0 && !STOP.has(one)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const one of a) if (b.has(one)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Two questions are near-duplicates when, with industry removed, they ask the same thing. */
export const NEAR_DUPLICATE_SIMILARITY = 0.8;

export interface NearDuplicate {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Every pair of buckets whose questions differ only by industry noun (or barely differ at
 * all once industry is removed). A bucket's own `focus` is compared when it has one, so the
 * shared evidence ask does not make every pair look alike.
 */
export function nearDuplicateBuckets(buckets: readonly { id: string; question: string; focus?: string }[]): NearDuplicate[] {
  const read = buckets.map((one) => ({ id: one.id, words: tokens(one.focus ?? one.question), whole: withoutIndustry(one.question).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }));
  const out: NearDuplicate[] = [];
  for (let i = 0; i < read.length; i += 1) {
    for (let j = i + 1; j < read.length; j += 1) {
      const a = read[i]!;
      const b = read[j]!;
      const similarity = a.whole === b.whole ? 1 : jaccard(a.words, b.words);
      if (similarity >= NEAR_DUPLICATE_SIMILARITY) out.push({ a: a.id, b: b.id, similarity });
    }
  }
  return out;
}

/** The defaults S-0149 forbids, as patterns a question must not contain. */
const DEFAULT_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['the owner’s city', /\b(owner['’]?s|your|our|my|the home)\s+(city|town|metro|area)\b/i],
  ['physical presence', /\b(physical presence|in[- ]person|on[- ]site|walk[- ]in|door[- ]to[- ]door)\b/i],
  ['the existing catalogue', /\b(existing|current|our|brain['’]?s)\s+(catalogue|catalog|offerings?|products? list)\b/i],
  ['cold email', /\bcold[- ]?(e-?mail|outreach|call)/i],
  ['AI-produced digital work', /\b(ai[- ](produced|generated|made)|deliverables? brain (can )?(make|produce)s?)\b/i],
];

/** Which forbidden defaults a question names. Empty when it names none. */
export function defaultViolations(question: string): string[] {
  return DEFAULT_PATTERNS.filter(([, pattern]) => pattern.test(question)).map(([name]) => name);
}

/** Industry nouns that appear in a question outside an "(for example: …)" clause, i.e. as a filter. */
export function industryFilters(question: string): string[] {
  const outside = question.replace(/\(for example:[^)]*\)/gi, ' ');
  return [...new Set((outside.match(INDUSTRY_PATTERN) ?? []).map((one) => one.toLowerCase()))];
}

export interface BucketSetVerdict {
  ok: boolean;
  missingEntryPoints: EntryPoint[];
  missingEnds: EntryEnd[];
  buyerTypes: BuyerType[];
  marketStructures: MarketStructure[];
  nearDuplicates: NearDuplicate[];
  defaults: Array<{ id: string; names: string[] }>;
  industryFilters: Array<{ id: string; terms: string[] }>;
  reasons: string[];
}

/**
 * Whether a set of intermediation buckets is broad and systematic: both ends, every S-0149
 * entry point, more than one buyer type and market structure, no near-duplicates, no
 * forbidden default and no industry used as a filter.
 */
export function checkBucketSet(buckets: readonly IntermediationBucket[]): BucketSetVerdict {
  const allPoints = [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST] as EntryPoint[];
  const covered = new Set(buckets.map((one) => one.entryPoint));
  const ends = new Set(buckets.map((one) => one.entry));
  const missingEntryPoints = allPoints.filter((one) => !covered.has(one));
  const missingEnds = (Object.keys(ENTRY_POINTS) as EntryEnd[]).filter((one) => !ends.has(one));
  const buyerTypes = [...new Set(buckets.map((one) => one.buyerType))];
  const marketStructures = [...new Set(buckets.map((one) => one.marketStructure))];
  const nearDuplicates = nearDuplicateBuckets(buckets);
  const defaults = buckets.map((one) => ({ id: one.id, names: defaultViolations(one.question) })).filter((one) => one.names.length > 0);
  const filters = buckets.map((one) => ({ id: one.id, terms: industryFilters(one.question) })).filter((one) => one.terms.length > 0);
  const reasons: string[] = [];
  if (missingEnds.length) reasons.push(`no ${missingEnds.join(' or ')} bucket`);
  if (missingEntryPoints.length) reasons.push(`entry points not covered: ${missingEntryPoints.join(', ')}`);
  if (buyerTypes.length < 2) reasons.push('only one buyer type');
  if (marketStructures.length < 2) reasons.push('only one market structure');
  for (const dup of nearDuplicates) reasons.push(`${dup.a} and ${dup.b} differ only by industry`);
  for (const one of defaults) reasons.push(`${one.id} defaults to ${one.names.join(', ')}`);
  for (const one of filters) reasons.push(`${one.id} uses ${one.terms.join(', ')} as a filter rather than an example`);
  return { ok: reasons.length === 0, missingEntryPoints, missingEnds, buyerTypes, marketStructures, nearDuplicates, defaults, industryFilters: filters, reasons };
}
