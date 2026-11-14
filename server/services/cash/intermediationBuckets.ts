/**
 * Discovery's intermediation search buckets (RES-15-4; S-0149).
 *
 * "Research must span different buyer types and market structures, not merely run
 * near-duplicate industry searches. Discover both buyer-first and supply-first entry
 * points …" Each bucket below is one place to look, tagged with the end it starts from,
 * the kind of buyer it is about and the market structure it reads. Together they cover
 * every entry point S-0149 names (`ENTRY_POINTS` in `intermediationPositions.ts`).
 *
 * Industries appear only as examples inside a question, never as a field anything
 * filters on (R01-A1): there is no industry on a bucket. No question names the owner's
 * city, physical presence, the existing catalogue, cold email or AI-produced digital work
 * as a default — `ownerDefaultsIn` is the check.
 *
 * Ordering is the family declaration's: while `INTERMEDIATION_FAMILY` is current each of
 * these buckets comes first in its mechanism's turn of discovery's fair order, and when it
 * lapses they keep their place in the ordinary order (`familyRank`). Fairness across
 * mechanisms is discovery's standing rule and is kept: the family never takes every turn. Pure data and pure functions; discovery's own machinery opens,
 * records and harvests the rounds, so there is no second scheduler or store here.
 */
import type { SearchBucket } from './discovery.ts';
import { ENTRY_POINTS, INTERMEDIATION_FAMILY, familyCurrent, type FamilyDeclaration } from './intermediationPositions.ts';

export type EntryEnd = 'BUYER_FIRST' | 'SUPPLY_FIRST';
export type EntryPoint = (typeof ENTRY_POINTS)['BUYER_FIRST'][number] | (typeof ENTRY_POINTS)['SUPPLY_FIRST'][number];

export interface IntermediationBucket extends SearchBucket {
  entry: EntryEnd;
  /** The kind of buyer the question is about. */
  buyerType: string;
  /** The market structure the question reads. */
  marketStructure: string;
  /** The S-0149 entry points this bucket searches. */
  entryPoints: readonly EntryPoint[];
}

const EXAMPLES =
  `Industries such as ${INTERMEDIATION_FAMILY.examples.join(', ')} are examples of where this happens, not limits, so report any industry where it does. `;
const POSITION =
  ' — and, for each, from which position the money could be earned (introducer, referrer, representative, lead supplier, broker, coordinator, distributor, reseller, subcontracting principal, marketplace, control-right holder or another) and who pays at that position?';

export const INTERMEDIATION_BUCKETS: readonly IntermediationBucket[] = Object.freeze([
  {
    id: 'int-buyer-requests',
    mechanism: 'EXPLICIT_PAID_REQUEST',
    title: 'Businesses publishing a request to buy that nobody has filled',
    entry: 'BUYER_FIRST',
    buyerType: 'business',
    marketStructure: 'fragmented supply, many small providers',
    entryPoints: ['explicit purchase requests', 'direct inquiries'],
    question:
      EXAMPLES +
      'Which businesses are publishing explicit requests for quotes or direct inquiries right now — quote requests, wanted posts, ' +
      'tender notices, sourcing requests — for goods or services sold by many small providers, naming the buyer, what they asked for, ' +
      'the quantity, the date, any stated budget, and where the request was published' + POSITION,
  },
  {
    id: 'int-buyer-renewals',
    mechanism: 'INFORMATION_ASYMMETRY',
    title: 'Public bodies and institutions with contracts coming up for renewal',
    entry: 'BUYER_FIRST',
    buyerType: 'public body or institution',
    marketStructure: 'contracted procurement with fixed terms',
    entryPoints: ['repeat services', 'contract renewal points', 'recurring flows'],
    question:
      EXAMPLES +
      'Which public bodies, schools, hospitals, housing associations or other institutions buy a service repeatedly under contracts ' +
      'that come up for renewal in the next few months, naming the buyer, the service, the incumbent if published, the contract value, ' +
      'the renewal or expiry date, how often the service recurs, and the published route for a new supplier to bid' + POSITION,
  },
  {
    id: 'int-buyer-underserved',
    mechanism: 'INFORMATION_ASYMMETRY',
    title: 'Consumers who cannot find a provider through the channels they use',
    entry: 'BUYER_FIRST',
    buyerType: 'consumer or household',
    marketStructure: 'two-sided market with thin listings',
    entryPoints: ['under-served channels', 'direct inquiries'],
    question:
      EXAMPLES +
      'Where are consumers or households publicly asking for a provider and not getting answers — forums, community boards, review ' +
      'sites, marketplace categories with few listings — naming the channel, what they want, how many such requests appear and how ' +
      'often, what they say they would pay, and which providers exist but are not present in that channel' + POSITION,
  },
  {
    id: 'int-supply-capacity',
    mechanism: 'SUBCONTRACTED_FULFILMENT',
    title: 'Suppliers with capacity they publish as unused',
    entry: 'SUPPLY_FIRST',
    buyerType: 'business buyers of a supplier’s output',
    marketStructure: 'capacity-constrained production with fixed costs',
    entryPoints: ['unused supplier capacity', 'bundled supply'],
    question:
      EXAMPLES +
      'Which suppliers, plants, fleets, crews or facilities publish unused capacity — open production slots, idle equipment, empty ' +
      'runs, spare hours — or sell a bundle of supply that buyers would otherwise assemble from several sources, naming the supplier, ' +
      'the capacity and when it is free, the published rate or minimum order, and which buyers usually purchase it' + POSITION,
  },
  {
    id: 'int-supply-inventory',
    mechanism: 'RESALE_OR_ASSET',
    title: 'Distributor and partner inventory priced differently across channels',
    entry: 'SUPPLY_FIRST',
    buyerType: 'trade and retail buyers',
    marketStructure: 'tiered distribution with list and trade prices',
    entryPoints: ['distributor or partner inventory', 'pricing spreads'],
    question:
      EXAMPLES +
      'Where do distributors, wholesalers or partner programmes hold inventory or allocations that sell at a published price below ' +
      'what another channel pays for the same thing, naming the source, the item, the quantity available, both published prices with ' +
      'dates, the resale or partner terms, and who buys at the higher price' + POSITION,
  },
  {
    id: 'int-supply-intermediaries',
    mechanism: 'CAPABILITY_ARBITRAGE',
    title: 'How existing intermediaries in a market are paid',
    entry: 'SUPPLY_FIRST',
    buyerType: 'any party that pays an intermediary',
    marketStructure: 'brokered or agent-mediated market',
    entryPoints: ['existing intermediary economics', 'pricing spreads'],
    question:
      EXAMPLES +
      'In which markets do existing intermediaries — agents, brokers, coordinators, lead sellers, resellers — publish how they are ' +
      'paid, naming the market, which side pays, the published commission, fee or margin, the volume an intermediary handles, how ' +
      'suppliers recruit them, and what licence or contract term decides who may hold that position' + POSITION,
  },
]);

export const INTERMEDIATION_BUCKET_IDS: ReadonlySet<string> = new Set(INTERMEDIATION_BUCKETS.map((one) => one.id));

// ── checks ───────────────────────────────────────────────────────────────────

/** Every S-0149 entry point no bucket in the set covers. */
export function uncoveredEntryPoints(buckets: readonly IntermediationBucket[]): EntryPoint[] {
  const covered = new Set<string>(buckets.flatMap((one) => one.entryPoints));
  return [...ENTRY_POINTS.BUYER_FIRST, ...ENTRY_POINTS.SUPPLY_FIRST].filter((point) => !covered.has(point));
}

/**
 * Industry nouns a near-duplicate search would swap. The family's examples plus common
 * ones; the list is only what the diversity check strips, never what discovery searches.
 */
const INDUSTRY_NOUNS = [
  ...INTERMEDIATION_FAMILY.examples,
  'cleaning', 'janitorial', 'concrete', 'construction', 'roofing', 'plumbing', 'electrical', 'hvac', 'landscaping', 'trades',
  'logistics', 'freight', 'trucking', 'warehousing', 'distribution', 'manufacturing', 'fabrication', 'marketing', 'advertising',
  'ai', 'software', 'staffing', 'healthcare', 'dental', 'legal', 'insurance', 'real estate', 'restaurant', 'food', 'retail',
  'automotive', 'printing', 'security', 'catering', 'moving', 'storage', 'regulated-industry partnerships', 'regulated',
];

function skeleton(text: string): string {
  let out = ` ${text.toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ')} `;
  for (const noun of [...INDUSTRY_NOUNS].sort((a, b) => b.length - a.length)) {
    out = out.split(` ${noun.toLowerCase()} `).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Pairs of bucket questions that differ only by an industry noun: the near-duplicate
 * searches S-0149 forbids. Empty is a diverse set.
 */
export function nearDuplicates(buckets: readonly Pick<SearchBucket, 'id' | 'question'>[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Map<string, string>();
  for (const one of buckets) {
    const key = skeleton(one.question);
    const prior = seen.get(key);
    if (prior) out.push([prior, one.id]);
    else seen.set(key, one.id);
  }
  return out;
}

/** Refuse a bucket set that is not diverse: near-duplicates, one end only, one buyer type or one market structure. */
export function assertDiverse(buckets: readonly IntermediationBucket[]): void {
  const dupes = nearDuplicates(buckets);
  if (dupes.length > 0) throw new Error(`near-duplicate searches differ only by industry: ${dupes.map(([a, b]) => `${a}~${b}`).join(', ')}`);
  if (new Set(buckets.map((one) => one.entry)).size < 2) throw new Error('intermediation buckets must start from both the buyer and the supply end');
  if (new Set(buckets.map((one) => one.buyerType)).size < 2) throw new Error('intermediation buckets must span more than one buyer type');
  if (new Set(buckets.map((one) => one.marketStructure)).size < 2) throw new Error('intermediation buckets must span more than one market structure');
}

const OWNER_DEFAULTS: ReadonlyArray<[string, RegExp]> = [
  [INTERMEDIATION_FAMILY.notDefaults[0]!, /\b(the )?owner['’]?s? (city|town|area|location)\b|\bnear (you|the owner)\b/i],
  [INTERMEDIATION_FAMILY.notDefaults[1]!, /\bphysical presence\b|\bin person\b|\bon[- ]site by the owner\b/i],
  [INTERMEDIATION_FAMILY.notDefaults[2]!, /\b(existing|our|brain['’]s) catalog(ue)?\b/i],
  [INTERMEDIATION_FAMILY.notDefaults[3]!, /\bcold[- ]?e-?mail/i],
  [INTERMEDIATION_FAMILY.notDefaults[4]!, /\bAI[- ](produced|generated|made)\b|\bdigital work\b/i],
];

/** The S-0149 defaults a question falls back on, by the family's own words. */
export function ownerDefaultsIn(text: string): string[] {
  return OWNER_DEFAULTS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// ── ordering ─────────────────────────────────────────────────────────────────

/**
 * 0 for a bucket of the family while its declaration is current, 1 otherwise. Discovery's
 * `fairOrder` reads it inside each mechanism's turn: while the window is open a family
 * bucket is offered before any other bucket of the same mechanism, and once it lapses every
 * bucket ranks 1 and the ordinary order returns.
 */
export function familyRank(
  bucket: { id: string },
  now: Date | string,
  declaration: FamilyDeclaration = INTERMEDIATION_FAMILY,
  ids: ReadonlySet<string> = INTERMEDIATION_BUCKET_IDS,
): 0 | 1 {
  return ids.has(bucket.id) && familyCurrent(declaration, now) ? 0 : 1;
}
