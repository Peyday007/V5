/**
 * Commercial intermediation: the positions a transaction can be held from, and what
 * research must establish at each one (RES-15-4; S-0148, S-0149, S-0150).
 *
 * "For each potential transaction, examine alternative lawful and economically distinct
 * positions … Investigate relevant contracts, rights, liabilities, restrictions and
 * counterparty expectations at the exact chosen position." A position is not a label: each
 * one here maps onto a transaction design from `properties.ts`, and who pays, who fulfils
 * and who carries the loss are read from that design by `designFacts`, never restated.
 *
 * Three things live here, and nothing else does:
 *
 *   (a) the catalogue of positions S-0148 names, each with its structure mapping and the
 *       contracts, rights, liabilities, restrictions and counterparty expectations to
 *       investigate at exactly that position. The catalogue is open: a position Brain
 *       discovers and records on a row is accepted and carried verbatim (R01-A1) — nothing
 *       here is a whitelist;
 *   (b) the per-position evidence contract S-0150 names, and `positionEvidenceGaps`, which
 *       names every field that is missing. When the only evidence is a public asking price
 *       or a total market size, buyer access and conversion are named as separate open
 *       gaps, because neither figure says anybody can be reached or will buy;
 *   (c) the intermediation family's standing as a current high-priority research and
 *       construction family, through a dated declaration that lapses unless renewed, so it
 *       never becomes a forever-only market.
 *
 * Pure functions and types. No store, scheduler or authority of its own: the research
 * paths that already exist read these and record what they find on their own rows.
 */
import { designFacts, STRUCTURES, type Design, type Structure } from './properties.ts';

// ── (a) positions ────────────────────────────────────────────────────────────

/** What must be investigated at one exact position before relying on it. */
export interface PositionInvestigation {
  contracts: string[];
  rights: string[];
  liabilities: string[];
  restrictions: string[];
  counterpartyExpectations: string[];
}

export interface PositionDefinition {
  label: string;
  /** How the position is held, in a researcher's words. */
  holds: string;
  /** The transaction design the position is, in `properties.ts` terms. */
  design: Design;
  /** What of ours is exposed, and when. */
  capitalExposure: string;
  investigate: PositionInvestigation;
}

const single = (base: Structure): Design => ({ base, funding: 'ON_DELIVERY', aggregation: base === 'POOL' ? 'POOLED_BUYERS' : 'SINGLE', repeat: 'ONE_OFF' });

/** The economically distinct positions S-0148 names. Examples of the space, never its boundary. */
export const POSITIONS = {
  INTRODUCER: {
    label: 'introducer',
    holds: 'makes one introduction between a buyer and a supplier and is paid a fee by the supplier for it, taking no part in the sale',
    design: single('REFERRAL'),
    capitalExposure: 'none: nothing is bought or held; only effort before the fee is earned',
    investigate: {
      contracts: ['introduction or finder’s-fee agreement with the supplier, signed before the introduction'],
      rights: ['the right to the fee when an introduced buyer later buys, and for how long (tail period)'],
      liabilities: ['claims that the introducer represented the supplier’s offer'],
      restrictions: ['whether an unlicensed introducer may be paid in this activity and where the buyer is', 'disclosure of the fee to the buyer'],
      counterpartyExpectations: ['the supplier expects introductions it would not have had; the buyer expects no hidden steering'],
    },
  },
  REFERRER: {
    label: 'referrer',
    holds: 'sends qualified buyers to a supplier repeatedly under a standing referral arrangement and is paid per referral or per sale',
    design: { base: 'REFERRAL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    capitalExposure: 'none beyond the cost of acquiring the buyers referred',
    investigate: {
      contracts: ['referral or affiliate agreement stating the qualifying event, the rate and the payment terms'],
      rights: ['attribution of a referred buyer, and audit of the supplier’s records of it'],
      liabilities: ['clawback of fees on refunds or cancellations'],
      restrictions: ['referral-fee rules for the activity (some regulated services forbid or cap them)', 'advertising and disclosure rules for paid referrals'],
      counterpartyExpectations: ['the supplier expects buyers that convert; the buyer expects the referral to be disclosed'],
    },
  },
  REPRESENTATIVE: {
    label: 'representative',
    holds: 'sells on the supplier’s behalf as its agent, on its paper and at its prices, for a commission',
    design: single('BROKER'),
    capitalExposure: 'none: the supplier contracts with and invoices the buyer',
    investigate: {
      contracts: ['sales-agency or representation agreement: territory, exclusivity, commission, termination'],
      rights: ['commission on repeat orders from the accounts it opened, and on termination'],
      liabilities: ['statements made to buyers on the supplier’s behalf'],
      restrictions: ['agent registration or licensing in the activity and the buyer’s jurisdiction', 'non-compete clauses with the supplier’s competitors'],
      counterpartyExpectations: ['the supplier expects a pipeline and adherence to its terms; the buyer expects to deal with the supplier'],
    },
  },
  LEAD_SUPPLIER: {
    label: 'lead supplier',
    holds: 'generates buyer inquiries and sells them to one or more suppliers per lead, before any sale',
    design: { base: 'REFERRAL', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' },
    capitalExposure: 'the acquisition spend that produces a lead, before a supplier pays for it',
    investigate: {
      contracts: ['lead-purchase agreement: what a valid lead is, price per lead, returns policy, exclusivity of a lead'],
      rights: ['ownership of the inquiry data and the right to sell it'],
      liabilities: ['consent and privacy obligations for the buyer’s contact details'],
      restrictions: ['consent rules for contacting and sharing a buyer’s details', 'lead-generation rules in regulated activities'],
      counterpartyExpectations: ['the supplier expects genuine, recent, in-area inquiries; the buyer expects to be contacted only by whom they asked'],
    },
  },
  BROKER: {
    label: 'broker',
    holds: 'brings buyer and supplier to agreement on a transaction neither had found, for a commission on it',
    design: single('BROKER'),
    capitalExposure: 'none: the buyer pays the supplier and the commission follows',
    investigate: {
      contracts: ['brokerage or commission agreement, and whether the buyer, the supplier or both pay'],
      rights: ['the commission when the parties close directly afterwards (circumvention protection)'],
      liabilities: ['duty to disclose conflicts when paid by one side'],
      restrictions: ['broker licensing in the activity (real estate, freight, insurance, finance and others require one)'],
      counterpartyExpectations: ['both sides expect a real counterparty and an honest account of terms'],
    },
  },
  COORDINATOR: {
    label: 'coordinator',
    holds: 'organises several suppliers to deliver one outcome the buyer asked for, for a coordination fee, while each supplier contracts directly',
    design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'POOLED_BUYERS', repeat: 'ONE_OFF' },
    capitalExposure: 'none if each supplier invoices the buyer directly; the fee is the coordinator’s',
    investigate: {
      contracts: ['coordination agreement with the buyer, and the scope boundaries with each supplier'],
      rights: ['authority to direct suppliers on the buyer’s behalf'],
      liabilities: ['whether coordinating makes it responsible for the combined outcome'],
      restrictions: ['whether coordinating the activity counts as performing it under the activity’s licensing'],
      counterpartyExpectations: ['the buyer expects one point of contact; suppliers expect clear scope and payment from the buyer'],
    },
  },
  DISTRIBUTOR: {
    label: 'distributor',
    holds: 'buys a supplier’s goods or capacity in volume and sells it on to many buyers at its own price',
    design: { base: 'POOL', funding: 'ON_DELIVERY', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    capitalExposure: 'stock or committed volume bought before buyers pay for it',
    investigate: {
      contracts: ['distribution agreement: territory, minimum purchase, pricing, returns, exclusivity'],
      rights: ['the right to resell, and any exclusive territory or channel'],
      liabilities: ['product liability and warranty obligations passed down to it'],
      restrictions: ['resale-price and territorial restrictions', 'import, storage or handling rules for the goods'],
      counterpartyExpectations: ['the supplier expects minimum volumes; buyers expect availability and after-sale support'],
    },
  },
  RESELLER: {
    label: 'reseller',
    holds: 'buys from a supplier for a specific buyer’s order and resells it under its own terms, keeping the margin',
    design: { base: 'SUBCONTRACT', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'ONE_OFF' },
    capitalExposure: 'the purchase price of each order, unless the buyer prepays it',
    investigate: {
      contracts: ['reseller agreement or authorised-reseller terms; the sale contract with the buyer'],
      rights: ['authorisation to resell the brand or service, and to use its marks'],
      liabilities: ['the buyer’s claims land on the reseller, as seller'],
      restrictions: ['whether the supplier permits resale, and at what minimum price'],
      counterpartyExpectations: ['the buyer expects the reseller to stand behind the sale; the supplier expects its terms honoured'],
    },
  },
  SUBCONTRACTING_PRINCIPAL: {
    label: 'subcontracting principal',
    holds: 'contracts with the buyer for the whole job and subcontracts its delivery to one or more suppliers, keeping the margin',
    design: single('SUBCONTRACT'),
    capitalExposure: 'what is owed to subcontractors before the buyer pays, unless the buyer funds the job by deposit or milestones',
    investigate: {
      contracts: ['the prime contract with the buyer, and back-to-back subcontracts carrying its obligations down'],
      rights: ['payment milestones and deposits from the buyer'],
      liabilities: ['the principal answers to the buyer for the subcontractor’s work, defects and delay'],
      restrictions: ['licensing, insurance and bonding the principal itself must hold to contract for the activity'],
      counterpartyExpectations: ['the buyer expects the principal to be accountable; subcontractors expect to be paid regardless of the buyer'],
    },
  },
  MARKETPLACE: {
    label: 'marketplace',
    holds: 'runs a venue where many buyers and suppliers transact with each other, and takes a fee on each transaction or listing',
    design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'POOLED_BUYERS', repeat: 'SUBSCRIPTION' },
    capitalExposure: 'the cost of attracting both sides before the venue clears transactions',
    investigate: {
      contracts: ['terms of service for each side; payment-processing terms if it handles funds'],
      rights: ['the fee on transactions concluded through it, and on those diverted off it'],
      liabilities: ['platform liability for listings, payments held and disputes'],
      restrictions: ['payment-handling and marketplace-facilitator rules', 'consumer-protection obligations of a platform'],
      counterpartyExpectations: ['both sides expect liquidity on the other side, and fair dispute handling'],
    },
  },
  CONTROL_RIGHT_HOLDER: {
    label: 'control-right holder',
    holds: 'holds a right others need to transact — an exclusive territory, an option, a licence, an allocation, a contract position — and is paid for its use or assignment',
    design: { base: 'BROKER', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'RECURRING_COHORT' },
    capitalExposure: 'whatever acquiring or keeping the right costs before anyone pays to use it',
    investigate: {
      contracts: ['the instrument that grants the right, and whether it may be assigned, sublicensed or exercised for others'],
      rights: ['exactly what the right controls, for how long, and its renewal'],
      liabilities: ['obligations that come with the right (minimums, performance, upkeep)'],
      restrictions: ['transfer and change-of-control restrictions on the right'],
      counterpartyExpectations: ['the grantor expects the right to be used as granted; users expect it to be valid and enforceable'],
    },
  },
} as const satisfies Record<string, PositionDefinition>;

export type CataloguedPosition = keyof typeof POSITIONS;
export const POSITION_KEYS = Object.keys(POSITIONS) as CataloguedPosition[];

/** A position as research holds it: a catalogued one, or one Brain discovered and named itself. */
export interface ResolvedPosition {
  /** The name exactly as recorded on the row. */
  name: string;
  /** The catalogue key it matched, or null for a position Brain discovered. */
  catalogued: CataloguedPosition | null;
  definition: PositionDefinition | null;
  /** Read from the design; null for a discovered position until a design is recorded for it. */
  facts: ReturnType<typeof designFacts> | null;
}

function normalise(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Resolve a recorded position. A name the catalogue knows maps to its definition; any other
 * non-empty name is a position Brain discovered and is carried verbatim, never refused (R01-A1).
 * A discovered position may arrive with its own design, which then supplies its facts.
 */
export function resolvePosition(name: string, design?: Design | null): ResolvedPosition {
  const key = normalise(name);
  const catalogued = (POSITION_KEYS as string[]).includes(key) ? (key as CataloguedPosition) : null;
  if (catalogued) {
    const definition: PositionDefinition = POSITIONS[catalogued];
    return { name, catalogued, definition, facts: designFacts(design ?? definition.design) };
  }
  return { name, catalogued: null, definition: null, facts: design ? designFacts(design) : null };
}

/** The positions to compare for one potential transaction: every catalogued one, then any Brain discovered. */
export function positionsToExamine(discovered: readonly string[] = []): ResolvedPosition[] {
  const out = POSITION_KEYS.map((key) => resolvePosition(key));
  const seen = new Set<string>(POSITION_KEYS);
  for (const name of discovered) {
    if (!name.trim()) continue;
    const key = normalise(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolvePosition(name));
  }
  return out;
}

/** The structure label a position's design stands on, for a reader. */
export function positionStructureLabel(position: ResolvedPosition): string | null {
  return position.definition ? STRUCTURES[position.definition.design.base].label : null;
}

// ── (b) the per-position evidence contract ───────────────────────────────────

/** Every field S-0150 names, with the question it asks at a position. */
export const EVIDENCE_FIELDS = {
  payer: 'who exactly pays at this position, by name or a precise buyer type',
  channel: 'the reachable channel through which that payer is reached',
  demand: 'observed demand: an explicit purchase request, inquiry or repeat purchase, not an estimate',
  offer: 'the contractual or proposed offer made at this position',
  supply: 'the supplier or capacity source that fulfils it',
  price: 'the price the payer pays',
  spread: 'the spread or fee kept at this position',
  acquisitionCost: 'what it costs to acquire one payer',
  throughput: 'how many transactions the channel and supply can carry per period',
  fulfilment: 'the fulfilment obligations held at this position',
  margin: 'the margin per transaction after acquisition and fulfilment',
  timing: 'the time from agreement to cash',
  cashStructure: 'the buyer-funded cash structure, where it is defensible (deposit, prepayment, milestones)',
  capitalExposure: 'the capital exposed before the payer pays',
  rights: 'the transaction rights held at this position',
  limits: 'the limits on volume, territory, term or price',
  uncertainties: 'what remains uncertain and how it would be resolved',
  nextAction: 'the fastest meaningful next action',
} as const;

export type EvidenceField = keyof typeof EVIDENCE_FIELDS;
export const EVIDENCE_FIELD_KEYS = Object.keys(EVIDENCE_FIELDS) as EvidenceField[];

/** What a source established. Only the first two say nothing about access or conversion. */
export type EvidenceBasis = 'PUBLIC_ASKING_PRICE' | 'TOTAL_MARKET_SIZE' | 'OBSERVED_TRANSACTION' | 'BUYER_INQUIRY' | 'CONTRACT' | 'SUPPLIER_QUOTE' | (string & {});

const NARROW_BASES: ReadonlySet<string> = new Set(['PUBLIC_ASKING_PRICE', 'TOTAL_MARKET_SIZE']);

export interface PositionFacts {
  /** Field values as research recorded them; null, empty or absent is missing. */
  fields: Partial<Record<EvidenceField, string | number | null>>;
  /** What the sources behind these fields established. */
  bases?: readonly EvidenceBasis[];
}

export type PositionGap =
  | { kind: 'FIELD'; field: EvidenceField; ask: string }
  | { kind: 'BUYER_ACCESS' | 'CONVERSION'; ask: string };

function present(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return value.trim().length > 0;
}

/**
 * Whether the only thing the sources established is a public asking price or a total
 * market size — neither says the payer can be reached or that anyone buys this way.
 */
export function narrowEvidence(facts: PositionFacts): boolean {
  const bases = facts.bases ?? [];
  return bases.length > 0 && bases.every((basis) => NARROW_BASES.has(basis));
}

/**
 * Every S-0150 field missing at one position, each asked at that exact position. When the
 * only evidence is a public asking price or a total market size, buyer access and conversion
 * are named as separate gaps to investigate — whatever else the fields claim.
 */
export function positionEvidenceGaps(position: ResolvedPosition | string, facts: PositionFacts): PositionGap[] {
  const resolved = typeof position === 'string' ? resolvePosition(position) : position;
  const at = ` (at the ${resolved.definition?.label ?? resolved.name} position)`;
  const gaps: PositionGap[] = [];
  for (const field of EVIDENCE_FIELD_KEYS) {
    if (!present(facts.fields[field])) gaps.push({ kind: 'FIELD', field, ask: EVIDENCE_FIELDS[field] + at });
  }
  if (narrowEvidence(facts)) {
    // The remaining gaps only: once later research names a payer and a channel to
    // them, access is no longer what is missing — but conversion still is until a
    // demand observation stands beside it.
    if (!(present(facts.fields.payer) && present(facts.fields.channel))) {
      gaps.push({ kind: 'BUYER_ACCESS', ask: `a public asking price or market size does not show the payer can be reached: establish a reachable channel to a named payer${at}` });
    }
    if (!present(facts.fields.demand)) {
      gaps.push({ kind: 'CONVERSION', ask: `a public asking price or market size does not show anyone buys through this route: establish observed conversion from that channel${at}` });
    }
  }
  return gaps;
}

// ── (c) the family's standing ────────────────────────────────────────────────

/** The entry points research starts from (S-0149). Examples of where to look, not a list of where only. */
export const ENTRY_POINTS = {
  BUYER_FIRST: ['explicit purchase requests', 'direct inquiries', 'repeat services', 'contract renewal points', 'recurring flows', 'under-served channels'],
  SUPPLY_FIRST: ['unused supplier capacity', 'distributor or partner inventory', 'bundled supply', 'pricing spreads', 'existing intermediary economics'],
} as const;

export interface FamilyDeclaration {
  key: string;
  priority: 'HIGH';
  /** ISO date the priority took effect. */
  since: string;
  /** ISO date by which it must be renewed; after it the priority is not current. */
  reviewBy: string;
  why: string;
  /** Industries named as examples; never a boundary on the search. */
  examples: readonly string[];
  /** Defaults research must not fall back on. */
  notDefaults: readonly string[];
}

export const INTERMEDIATION_FAMILY: FamilyDeclaration = {
  key: 'COMMERCIAL_INTERMEDIATION',
  priority: 'HIGH',
  since: '2026-11-14',
  reviewBy: '2027-02-14',
  why: 'it can use supplier assets, buyer-funded fulfilment and existing industry capacity while requiring little direct owner labour',
  examples: ['cleaning', 'concrete', 'trades', 'logistics', 'distribution', 'manufacturing', 'marketing', 'AI', 'regulated-industry partnerships'],
  notDefaults: ['the owner’s city', 'physical presence', 'the existing catalogue', 'cold email', 'AI-produced digital work'],
};

/** Whether a family's priority is current at `now`: only inside its declared window. */
export function familyCurrent(declaration: FamilyDeclaration, now: Date | string): boolean {
  const at = typeof now === 'string' ? Date.parse(now) : now.getTime();
  const since = Date.parse(declaration.since);
  const reviewBy = Date.parse(declaration.reviewBy);
  if (![at, since, reviewBy].every(Number.isFinite)) return false;
  return at >= since && at < reviewBy;
}

/** Renew a family's priority to a new review date; the declaration itself is never mutated. */
export function renewFamily(declaration: FamilyDeclaration, reviewBy: string): FamilyDeclaration {
  return { ...declaration, reviewBy };
}
