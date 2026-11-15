/**
 * Commercial intermediation as places to look (RES-15-4; S-0148, S-0149, S-0150).
 *
 * `intermediationPositions.ts` says which positions a transaction can be held
 * from and what research must establish at each one. This file says *where
 * discovery starts looking* for those transactions, as ordinary search buckets
 * that `openDiscovery` asks through the machinery every other bucket uses — no
 * scheduler, store or authority of its own (§10.3, §20.4).
 *
 * Each bucket is one S-0149 entry point, read from one side of the transaction
 * (`BUYER_FIRST` or `SUPPLY_FIRST`), about one kind of buyer in one market
 * structure. That is what keeps the set *broad and systematic* rather than one
 * question asked eleven times with a different industry in it: two buckets that
 * differ only by an industry noun are refused by `nearDuplicateBuckets`, and
 * the regression test runs it over this set.
 *
 * Industries appear only as examples inside a question, introduced with "for
 * example" and followed by "or any other market" — never as a filter (R01-A1,
 * §18.1). No question defaults to the owner's city, physical presence, the
 * existing catalogue, cold email or AI-produced digital work: the set is
 * checked against `INTERMEDIATION_FAMILY.notDefaults` by `namedDefaults`.
 *
 * Every question ends with the same request for S-0150's per-position evidence,
 * so what comes back is commercially usable evidence about one constructed
 * position — payer, channel, demand, offer, supplier, spread, timing, rights,
 * next action — and never an industry fact dump.
 */
import type { SearchBucket } from './discovery.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY } from './intermediationPositions.ts';

export type EntryDirection = keyof typeof ENTRY_POINTS;
export type EntryPoint = (typeof ENTRY_POINTS)[EntryDirection][number];

/** Who pays. Open in spirit; these are the kinds this set asks about. */
export type BuyerType = 'BUSINESS' | 'CONSUMER' | 'PUBLIC_BODY' | 'INSTITUTION' | 'NONPROFIT' | (string & {});

/** How the market is shaped, which decides where a position can sit in it. */
export type MarketStructure =
  | 'FRAGMENTED_SERVICE'
  | 'CONCENTRATED_SUPPLY'
  | 'TWO_SIDED_MARKETPLACE'
  | 'DISTRIBUTION_CHAIN'
  | 'CONTRACTED_RECURRING'
  | 'TENDERED_PROJECT'
  | 'SPOT_COMMODITY'
  | (string & {});

export interface IntermediationBucket extends SearchBucket {
  direction: EntryDirection;
  entryPoint: EntryPoint;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
  /** The part of the question that is this bucket's own; the evidence request is shared. */
  ask: string;
}

/** The family the buckets belong to; discovery orders them first while it is current. */
export const INTERMEDIATION_BUCKET_PREFIX = 'intermediation-';

/**
 * S-0148's positions and S-0150's evidence contract, asked of every answer.
 *
 * The positions are listed as examples and "another position" is invited, so
 * the list is never a boundary. The last sentence is S-0150's rule that an
 * asking price or a market size leaves buyer access and conversion open.
 */
export const POSITION_EVIDENCE_ASK =
  ' For each one, say which lawful position the transaction could be held from — introducer, ' +
  'referrer, representative, lead supplier, broker, coordinator, distributor, reseller, ' +
  'subcontracting principal, marketplace, control-right holder or another position the ' +
  'sources show — and name the exact payer and the channel through which that payer is ' +
  'reachable, the observed demand, the offer made or proposed, the supplier or capacity ' +
  'source, the published price and spread, acquisition costs and throughput, fulfilment ' +
  'obligations, margin and timing, whether the buyer funds fulfilment, the capital exposed, ' +
  'the contracts, rights, liabilities and restrictions at that exact position, what remains ' +
  'uncertain, and the fastest meaningful next action. Where a source establishes only a ' +
  'public asking price or a total market size, say so and name the buyer-access and ' +
  'conversion gaps that remain open.';

type Draft = Omit<IntermediationBucket, 'question'>;

const DRAFTS: readonly Draft[] = [
  // ── buyer first ────────────────────────────────────────────────────────────
  {
    id: 'intermediation-explicit-purchase-requests',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    direction: 'BUYER_FIRST',
    entryPoint: 'explicit purchase requests',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'TENDERED_PROJECT',
    title: 'Which published purchase requests could be filled from somebody else’s capacity',
    ask:
      'Which public bodies, institutions or companies have published that they are buying goods ' +
      'or services — a tender, a request for quotation, a sourcing notice — that an existing ' +
      'supplier could fulfil while somebody else arranges, leads or holds the contract, for ' +
      'example in cleaning, concrete or facilities work, or in any other market?',
  },
  {
    id: 'intermediation-direct-inquiries',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    direction: 'BUYER_FIRST',
    entryPoint: 'direct inquiries',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED_SERVICE',
    title: 'Where households publicly ask who can do a job and get no good answer',
    ask:
      'Where are households or individuals publicly asking who can supply a service or product — ' +
      'in forums, community boards, review sites or request pages — and receiving few or no ' +
      'credible answers, while capable suppliers exist that are not seeing those inquiries, for ' +
      'example in the trades, or in any other market?',
  },
  {
    id: 'intermediation-repeat-services',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    direction: 'BUYER_FIRST',
    entryPoint: 'repeat services',
    buyerType: 'BUSINESS',
    marketStructure: 'CONTRACTED_RECURRING',
    title: 'Which services businesses buy again and again from whoever coordinates them',
    ask:
      'Which services do businesses buy on a repeating schedule — weekly, monthly, seasonal — ' +
      'through a coordinator, managing contractor or service aggregator rather than directly ' +
      'from the firm that does the work, for example maintenance, cleaning or marketing ' +
      'services, or any other market?',
  },
  {
    id: 'intermediation-contract-renewals',
    mechanism: 'TEMPORARY_EXPLOIT',
    direction: 'BUYER_FIRST',
    entryPoint: 'contract renewal points',
    buyerType: 'INSTITUTION',
    marketStructure: 'CONTRACTED_RECURRING',
    title: 'Which service contracts are published as coming up for renewal',
    ask:
      'Which institutions — schools, hospitals, housing associations, property managers, ' +
      'municipalities — have published that a supply or service contract expires, is up for ' +
      'renewal or is being re-procured, with the incumbent, the term and the value stated, for ' +
      'example in logistics or facilities contracts, or in any other market?',
  },
  {
    id: 'intermediation-recurring-flows',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    direction: 'BUYER_FIRST',
    entryPoint: 'recurring flows',
    buyerType: 'BUSINESS',
    marketStructure: 'SPOT_COMMODITY',
    title: 'Which recurring flows of goods are bought on the spot each time',
    ask:
      'Which businesses publish that they buy the same goods, materials or loads repeatedly on ' +
      'the spot market — no standing supplier, price re-negotiated every order — so that a ' +
      'standing arrangement between them and a supplier would be worth paying for, for example ' +
      'materials, packaging or freight, or any other market?',
  },
  {
    id: 'intermediation-under-served-channels',
    mechanism: 'INFORMATION_ASYMMETRY',
    direction: 'BUYER_FIRST',
    entryPoint: 'under-served channels',
    buyerType: 'NONPROFIT',
    marketStructure: 'TWO_SIDED_MARKETPLACE',
    title: 'Which groups of buyers no seller is reaching through the channel they use',
    ask:
      'Which groups of buyers — member organisations, associations, nonprofits, buying ' +
      'co-operatives, online communities — publicly buy through a channel that suppliers ' +
      'largely do not sell into, such as a member directory, a group purchasing scheme or a ' +
      'trade association marketplace, for example in AI tooling or regulated-industry ' +
      'partnerships, or in any other market?',
  },
  // ── supply first ───────────────────────────────────────────────────────────
  {
    id: 'intermediation-unused-capacity',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'unused supplier capacity',
    buyerType: 'BUSINESS',
    marketStructure: 'FRAGMENTED_SERVICE',
    title: 'Which suppliers publish that they have capacity standing idle',
    ask:
      'Which suppliers publish that they have unused capacity — idle crews, empty production ' +
      'shifts, open warehouse space, return-leg trucks, off-season equipment — and are asking ' +
      'for work to fill it, for example in manufacturing, logistics or concrete, or in any ' +
      'other market?',
  },
  {
    id: 'intermediation-partner-inventory',
    mechanism: 'RESALE_OR_ASSET',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'distributor or partner inventory',
    buyerType: 'BUSINESS',
    marketStructure: 'DISTRIBUTION_CHAIN',
    title: 'Which distributors invite resellers or agents to sell their inventory',
    ask:
      'Which distributors, wholesalers or manufacturers have published a reseller, agent, dealer or ' +
      'partner programme for stock they hold — with published trade pricing, discount tiers, ' +
      'territory terms or drop-ship arrangements — for example in distribution or ' +
      'manufacturing, or in any other market?',
  },
  {
    id: 'intermediation-bundled-supply',
    mechanism: 'JIGSAW_COMBINATION',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'bundled supply',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'CONCENTRATED_SUPPLY',
    title: 'Which purchases need several suppliers combined that nobody bundles',
    ask:
      'Which purchases — published by public bodies or large buyers — require several separate ' +
      'suppliers to be combined into one delivery (supply plus installation, transport plus ' +
      'storage, product plus service) where the suppliers each publish their part but no one ' +
      'offers the bundle, for example in the trades or logistics, or in any other market?',
  },
  {
    id: 'intermediation-pricing-spreads',
    mechanism: 'CAPABILITY_ARBITRAGE',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'pricing spreads',
    buyerType: 'CONSUMER',
    marketStructure: 'SPOT_COMMODITY',
    title: 'Where a supplier’s published price sits well below what buyers pay',
    ask:
      'Where does a supplier publish a trade, wholesale or off-peak price that is materially ' +
      'below the price consumers or end buyers are published as paying for the same thing, ' +
      'naming both prices, both sources and their dates, for example in cleaning supplies or ' +
      'equipment rental, or in any other market?',
  },
  {
    id: 'intermediation-intermediary-economics',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'existing intermediary economics',
    buyerType: 'BUSINESS',
    marketStructure: 'TWO_SIDED_MARKETPLACE',
    title: 'What intermediaries already earn between suppliers and buyers',
    ask:
      'Which existing intermediaries — brokers, agents, marketplaces, lead sellers, managing ' +
      'contractors — publish what they take between supplier and buyer (a commission, a ' +
      'margin, a per-lead price, a platform fee), and which suppliers publish what they pay ' +
      'them, for example in marketing, freight or regulated-industry referrals, or in any ' +
      'other market?',
  },
];

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze(
  DRAFTS.map((draft): IntermediationBucket => ({ ...draft, question: `${draft.ask}${POSITION_EVIDENCE_ASK}` })),
);

/** Whether a bucket belongs to the intermediation family. */
export function isIntermediationBucket(bucket: Pick<SearchBucket, 'id'>): boolean {
  return bucket.id.startsWith(INTERMEDIATION_BUCKET_PREFIX);
}

// ── checks ───────────────────────────────────────────────────────────────────

/**
 * Industry nouns: what a near-duplicate search changes and nothing else.
 *
 * The family's own examples plus the common trade names a duplicate would swap
 * in. This list is *only* what the diversity check ignores; it never decides
 * what may be searched.
 */
const INDUSTRY_NOUNS = new Set(
  [
    ...INTERMEDIATION_FAMILY.examples.flatMap((one) => one.toLowerCase().split(/[^a-z]+/)),
    'cleaning', 'concrete', 'trade', 'trades', 'logistics', 'freight', 'distribution', 'manufacturing',
    'marketing', 'ai', 'regulated', 'industry', 'partnerships', 'plumbing', 'roofing', 'electrical',
    'hvac', 'landscaping', 'construction', 'facilities', 'janitorial', 'trucking', 'warehousing',
    'healthcare', 'dental', 'legal', 'insurance', 'solar', 'software', 'printing', 'catering',
    'staffing', 'security', 'moving', 'packaging', 'materials', 'equipment', 'rental', 'supplies',
  ].filter(Boolean),
);

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'for', 'to', 'example', 'any', 'other', 'market']);

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && !STOPWORDS.has(word) && !INDUSTRY_NOUNS.has(word)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** At or above this overlap, once industry nouns are removed, two asks are one question. */
export const NEAR_DUPLICATE_SIMILARITY = 0.8;

export interface NearDuplicate {
  a: string;
  b: string;
  reason: 'SAME_ENTRY' | 'SAME_QUESTION_BUT_INDUSTRY';
  similarity: number;
}

type Comparable = Pick<IntermediationBucket, 'id' | 'direction' | 'entryPoint' | 'buyerType' | 'marketStructure'> & {
  ask?: string;
  question: string;
};

/**
 * The pairs in a bucket set that are near-duplicate searches.
 *
 * Two buckets are one search when they read from the same side, at the same
 * entry point, about the same buyer type in the same market structure — or when
 * their own question is the same once industry nouns are taken out. Pure: it
 * reads only the buckets it is given.
 */
export function nearDuplicateBuckets(buckets: readonly Comparable[]): NearDuplicate[] {
  const out: NearDuplicate[] = [];
  const tokens = buckets.map((one) => contentTokens(one.ask ?? one.question));
  for (let i = 0; i < buckets.length; i += 1) {
    for (let j = i + 1; j < buckets.length; j += 1) {
      const a = buckets[i]!;
      const b = buckets[j]!;
      const similarity = jaccard(tokens[i]!, tokens[j]!);
      if (
        a.direction === b.direction &&
        a.entryPoint === b.entryPoint &&
        a.buyerType === b.buyerType &&
        a.marketStructure === b.marketStructure
      ) {
        out.push({ a: a.id, b: b.id, reason: 'SAME_ENTRY', similarity });
      } else if (similarity >= NEAR_DUPLICATE_SIMILARITY) {
        out.push({ a: a.id, b: b.id, reason: 'SAME_QUESTION_BUT_INDUSTRY', similarity });
      }
    }
  }
  return out;
}

/**
 * The defaults research must not fall back on, as patterns a question would
 * use to fall back on them (`INTERMEDIATION_FAMILY.notDefaults`).
 */
const DEFAULT_PATTERNS: Record<string, RegExp> = {
  'the owner’s city': /\b(?:the owner['’]s|your|our|my) (?:own )?(?:city|town|area|metro)\b|\bnear (?:you|us|me)\b|\blocal to (?:you|us|me)\b/i,
  'physical presence': /\bphysical(?:ly)? presen|\bin[- ]person\b|\bon[- ]site by (?:you|us|the owner)\b/i,
  'the existing catalogue': /\b(?:existing|our|current) catalog(?:ue)?\b|\bwhat (?:we|brain) already (?:sell|make)s?\b/i,
  'cold email': /\bcold[- ]?e-?mail|\bemail (?:addresses|outreach|campaign)/i,
  'AI-produced digital work': /\bAI[- ](?:produced|generated|made)\b|\bdigital (?:work|deliverables?) (?:we|brain) (?:make|produce)/i,
};

/** Which of the family's not-defaults a question names. Empty when it names none. */
export function namedDefaults(question: string): string[] {
  return INTERMEDIATION_FAMILY.notDefaults.filter((label) => DEFAULT_PATTERNS[label]?.test(question) ?? false);
}

/** Every S-0149 entry point no bucket in the set covers. */
export function uncoveredEntryPoints(buckets: readonly Pick<IntermediationBucket, 'entryPoint'>[]): EntryPoint[] {
  const covered = new Set<string>(buckets.map((one) => one.entryPoint));
  return [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST].filter((one) => !covered.has(one));
}
