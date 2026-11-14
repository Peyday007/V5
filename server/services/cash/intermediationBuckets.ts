/**
 * Intermediation entry buckets (S-0148, S-0149; RES-15-4).
 *
 * Commercial intermediation is a current high-priority research family
 * (`INTERMEDIATION_FAMILY` in intermediationPositions.ts) because it can use
 * supplier assets, buyer-funded fulfilment and existing industry capacity
 * with little direct owner labour. These are its places to look, as ordinary
 * discovery search buckets — not a second scheduler, store or market list:
 *
 *   * each bucket starts from one S-0149 entry point and is tagged
 *     BUYER_FIRST or SUPPLY_FIRST, with the buyer type and market structure it
 *     asks about, so the set spans different buyers and structures rather
 *     than running near-duplicate industry searches;
 *   * industries appear only as examples inside a question ("for example …,
 *     or any other"), never as a filter, and no question defaults to the
 *     owner's city, physical presence, the existing catalogue, cold email or
 *     AI-produced digital work;
 *   * every question asks for commercially usable evidence at a named
 *     position — payer and reachable channel, observed demand, supplier or
 *     capacity source, price and spread, timing, rights, limits and the
 *     fastest next action — and asks separately about buyer access and
 *     conversion where a source shows only an asking price or market size.
 *
 * `prioritizeIntermediation` orders them first while the family declaration
 * is current; when it lapses they keep their place in the ordinary order.
 */
import type { SearchBucket } from './discovery.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, familyCurrent, type FamilyDeclaration } from './intermediationPositions.ts';

export type EntryDirection = keyof typeof ENTRY_POINTS;
export type EntryPoint = (typeof ENTRY_POINTS)[EntryDirection][number];

export const BUYER_TYPES = ['BUSINESS', 'CONSUMER', 'PUBLIC_BODY', 'NON_PROFIT', 'ANY'] as const;
export type BuyerType = (typeof BUYER_TYPES)[number];

export const MARKET_STRUCTURES = ['FRAGMENTED', 'CONCENTRATED', 'TENDERED', 'PLATFORM', 'CHANNEL', 'RECURRING_CONTRACT', 'SPOT'] as const;
export type MarketStructure = (typeof MARKET_STRUCTURES)[number];

export interface IntermediationBucket extends SearchBucket {
  family: 'COMMERCIAL_INTERMEDIATION';
  direction: EntryDirection;
  entryPoint: EntryPoint;
  buyerType: BuyerType;
  marketStructure: MarketStructure;
}

/** What every intermediation question asks for: evidence a position can be taken, not industry facts. */
const DELIVERABLE =
  ' For each: which position would an intermediary take (introducer, referrer, representative, lead supplier, ' +
  'broker, coordinator, distributor, reseller, subcontracting principal, marketplace, control-right holder or another ' +
  'you find), who is the exact payer and through which channel can they be reached, what is the observed demand, the ' +
  'offer or contract terms, the supplier or capacity source, the price and the spread, the acquisition cost and throughput, ' +
  'the fulfilment obligations, the margin and timing, whether buyers fund it before the supplier is paid, the capital tied up, ' +
  'the rights, liabilities and restrictions at that position, what is still uncertain, and what is the fastest meaningful ' +
  'next action — each with its published, dated source; and where a source shows only a public asking price or a total ' +
  'market size, which buyer-access and conversion questions remain open?';

const examples = (words: string) => ` For example ${words} — or any other market where it holds.`;

/** The entry-point question, without its closing mark, so the deliverable question ends the text. */
const open = (ask: string) => ask.replace(/\?\s*$/, '.');

const bucket = (b: Omit<IntermediationBucket, 'family' | 'question'> & { ask: string; examples: string }): IntermediationBucket => ({
  id: b.id,
  mechanism: b.mechanism,
  title: b.title,
  family: 'COMMERCIAL_INTERMEDIATION',
  direction: b.direction,
  entryPoint: b.entryPoint,
  buyerType: b.buyerType,
  marketStructure: b.marketStructure,
  question: open(b.ask) + examples(b.examples) + DELIVERABLE,
});

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze([
  bucket({
    id: 'intermediation-purchase-requests',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    title: 'Published requests for supply a supplier network could fill',
    direction: 'BUYER_FIRST',
    entryPoint: 'explicit purchase requests',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'TENDERED',
    ask: 'Which buyers have published a request for goods or services — tenders, solicitations, requests for quote, procurement notices — that an arranger could fill by placing it with an existing supplier rather than delivering it?',
    examples: 'facility cleaning, concrete work or freight lanes',
  }),
  bucket({
    id: 'intermediation-direct-inquiries',
    mechanism: 'EXISTING_BUYING_SIGNAL',
    title: 'Buyers asking where to get something, with nobody answering',
    direction: 'BUYER_FIRST',
    entryPoint: 'direct inquiries',
    buyerType: 'CONSUMER',
    marketStructure: 'FRAGMENTED',
    ask: 'Where are buyers publicly asking who can supply something — forum and community posts, association boards, directory inquiries, review-site questions — and getting few or no credible answers from suppliers?',
    examples: 'home trades, specialised repairs or custom manufacturing',
  }),
  bucket({
    id: 'intermediation-repeat-services',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    title: 'Services bought again and again that a coordinator could take over',
    direction: 'BUYER_FIRST',
    entryPoint: 'repeat services',
    buyerType: 'BUSINESS',
    marketStructure: 'FRAGMENTED',
    ask: 'Which services do organisations buy repeatedly from many small suppliers, so that one coordinator holding the relationship and subcontracting the work would be paid on every repeat?',
    examples: 'commercial cleaning, grounds maintenance or equipment servicing',
  }),
  bucket({
    id: 'intermediation-renewal-points',
    mechanism: 'TEMPORARY_EXPLOIT',
    title: 'Contracts coming up for renewal where the buyer is open to a new supplier',
    direction: 'BUYER_FIRST',
    entryPoint: 'contract renewal points',
    buyerType: 'PUBLIC_BODY',
    marketStructure: 'RECURRING_CONTRACT',
    ask: 'Which published contracts, frameworks or service agreements come up for renewal or re-tender in the next months, where an arranger representing a supplier could be placed at the renewal?',
    examples: 'waste handling, transport or managed services',
  }),
  bucket({
    id: 'intermediation-recurring-flows',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Recurring flows of goods or work that pass through a middle position',
    direction: 'BUYER_FIRST',
    entryPoint: 'recurring flows',
    buyerType: 'BUSINESS',
    marketStructure: 'CONCENTRATED',
    ask: 'Which recurring flows of goods, materials, data or work move regularly between the same kinds of parties, where a position in the middle — scheduling, aggregating, financing or routing them — is paid on every cycle?',
    examples: 'distribution of consumables, inbound logistics or outsourced marketing production',
  }),
  bucket({
    id: 'intermediation-underserved-channels',
    mechanism: 'INFORMATION_ASYMMETRY',
    title: 'Buyer groups suppliers are not reaching through any channel',
    direction: 'BUYER_FIRST',
    entryPoint: 'under-served channels',
    buyerType: 'NON_PROFIT',
    marketStructure: 'CHANNEL',
    ask: 'Which groups of buyers are under-served by the channels suppliers currently sell through — missing from the marketplaces, distributors or associations suppliers use — so that a representative or channel partner could reach them?',
    examples: 'membership organisations, rural buyers or regulated-industry partners',
  }),
  bucket({
    id: 'intermediation-unused-capacity',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'Supplier capacity sitting unused that buyers would pay for',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'unused supplier capacity',
    buyerType: 'BUSINESS',
    marketStructure: 'SPOT',
    ask: 'Which suppliers have published unused capacity — idle equipment, open production slots, empty routes, available crews or space — that buyers elsewhere would pay for if someone arranged it?',
    examples: 'manufacturing lines, vehicles or skilled trade crews',
  }),
  bucket({
    id: 'intermediation-partner-inventory',
    mechanism: 'RESALE_OR_ASSET',
    title: 'Distributor or partner inventory available to resell or represent',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'distributor or partner inventory',
    buyerType: 'ANY',
    marketStructure: 'CHANNEL',
    ask: 'Which distributors, wholesalers or manufacturers publish programmes for resellers, agents or partners to sell their inventory, with what margin or commission, and which buyers they do not yet reach?',
    examples: 'building materials, industrial supplies or software',
  }),
  bucket({
    id: 'intermediation-bundled-supply',
    mechanism: 'JIGSAW_COMBINATION',
    title: 'Separate supplies buyers would pay more for together',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'bundled supply',
    buyerType: 'BUSINESS',
    marketStructure: 'FRAGMENTED',
    ask: 'Which goods or services are bought from several separate suppliers that a buyer would pay more for as one bundle, so that a lead supplier or coordinator assembling them takes the spread?',
    examples: 'fit-out work, event logistics or marketing campaigns',
  }),
  bucket({
    id: 'intermediation-pricing-spreads',
    mechanism: 'CAPABILITY_ARBITRAGE',
    title: 'The same thing priced differently in two places',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'pricing spreads',
    buyerType: 'ANY',
    marketStructure: 'PLATFORM',
    ask: 'Where is the same good or service published at materially different prices in two markets, channels or regions, with evidence that buyers on the expensive side would buy from the cheap side through an arranger?',
    examples: 'equipment rental, components or AI-assisted services',
  }),
  bucket({
    id: 'intermediation-intermediary-economics',
    mechanism: 'SUPPLY_DEMAND_MISMATCH',
    title: 'What existing intermediaries are paid, and where their position is open',
    direction: 'SUPPLY_FIRST',
    entryPoint: 'existing intermediary economics',
    buyerType: 'ANY',
    marketStructure: 'CONCENTRATED',
    ask: 'Which existing brokers, agents, distributors or marketplaces publish what they are paid — commission, fee or margin — and where is their position open to a new entrant, under-served or failing its suppliers or buyers?',
    examples: 'freight brokerage, staffing or insurance-adjacent referrals',
  }),
]);

/* ------------------------------------------------------------- the checks */

/**
 * Industry nouns a question may use as examples only. The family's examples
 * plus common market nouns: a set of questions that differ only by these is
 * one search wearing several hats.
 */
const INDUSTRY_WORDS = [
  ...INTERMEDIATION_FAMILY.examples,
  'construction', 'plumbing', 'electrical', 'roofing', 'landscaping', 'hvac', 'freight', 'trucking', 'warehousing',
  'retail', 'wholesale', 'restaurants', 'hospitality', 'healthcare', 'legal', 'insurance', 'software', 'printing',
  'janitorial', 'moving', 'staffing', 'agriculture', 'energy', 'telecom', 'automotive', 'real estate',
];

function skeleton(question: string, industries: readonly string[]): string {
  let text = ` ${question.toLowerCase()} `;
  for (const word of [...industries].sort((a, b) => b.length - a.length)) {
    text = text.split(word.toLowerCase()).join(' § ');
  }
  return text.replace(/[^a-z§ ]+/g, ' ').replace(/(§\s*)+/g, '§ ').replace(/\s+/g, ' ').trim();
}

/**
 * Refuse a bucket set in which two questions differ only by an industry noun.
 * Pure: it reads only the questions.
 */
export function bucketDiversity(buckets: readonly Pick<SearchBucket, 'id' | 'question'>[], industries: readonly string[] = INDUSTRY_WORDS): { ok: boolean; duplicates: Array<[string, string]> } {
  const seen = new Map<string, string>();
  const duplicates: Array<[string, string]> = [];
  for (const b of buckets) {
    const key = skeleton(b.question, industries);
    const prior = seen.get(key);
    if (prior) duplicates.push([prior, b.id]);
    else seen.set(key, b.id);
  }
  return { ok: duplicates.length === 0, duplicates };
}

/** The S-0149 entry points no bucket covers; empty when every one is covered. */
export function uncoveredEntryPoints(buckets: readonly IntermediationBucket[] = INTERMEDIATION_BUCKETS): EntryPoint[] {
  const covered = new Set(buckets.map((b) => b.entryPoint));
  return (Object.values(ENTRY_POINTS).flat() as EntryPoint[]).filter((one) => !covered.has(one));
}

/** Defaults a question must not fall back on (the family's `notDefaults`), as patterns. */
const DEFAULT_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'the owner’s city', pattern: /\b(your|the owner'?s?|our|my) (own )?(city|town|area|neighbou?rhood)\b|\bnear (you|me|us)\b|\blocal to (you|me|us)\b/i },
  { name: 'physical presence', pattern: /\b(in person|on[- ]site visit|physically (present|visit)|door[- ]to[- ]door|walk[- ]in)\b/i },
  { name: 'the existing catalogue', pattern: /\b(existing|current|our|your) (catalog(ue)?|product line|offerings?)\b/i },
  { name: 'cold email', pattern: /\bcold[- ]?(e-?mail|outreach|call)/i },
  { name: 'AI-produced digital work', pattern: /\b(ai[- ](generated|produced|written)|digital deliverables?|websites?|landing pages?|logos?|spreadsheets?|pitch decks?)\b/i },
];

/** The defaults a question falls back on; empty when it falls back on none. */
export function forbiddenDefaults(question: string): string[] {
  return DEFAULT_PATTERNS.filter((one) => one.pattern.test(question)).map((one) => one.name);
}

/* ------------------------------------------------------------ the ordering */

const INTERMEDIATION_IDS = new Set(INTERMEDIATION_BUCKETS.map((b) => b.id));

/** Whether a bucket is one of the intermediation family's. */
export function isIntermediationBucket(b: Pick<SearchBucket, 'id'>): boolean {
  return INTERMEDIATION_IDS.has(b.id);
}

/**
 * Order discovery's buckets: while the family declaration is current, the
 * intermediation buckets come first (keeping their relative order); when it
 * lapses the order is returned unchanged, so they keep their ordinary place.
 */
export function prioritizeIntermediation<T extends Pick<SearchBucket, 'id'>>(ordered: readonly T[], now: Date | string, declaration: FamilyDeclaration = INTERMEDIATION_FAMILY): T[] {
  if (!familyCurrent(declaration, now)) return [...ordered];
  return [...ordered.filter(isIntermediationBucket), ...ordered.filter((b) => !isIntermediationBucket(b))];
}
