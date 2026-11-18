/**
 * Industry construction (§92): the vocabulary an operator's ambition, an
 * industry's economics and a constructed business are described in.
 *
 * Three closed sets carry the whole capability, and none of them names an
 * industry or a business:
 *
 *   * a **position** — five independent choices about where an operation sits
 *     in a value chain: what it holds with the buyer (`contract`), how the work
 *     gets done (`supply`), whose assets do it (`assets`), whether several
 *     buyers share one capacity (`aggregation`) and whether it runs its own
 *     information layer (`information`). Brokerage, representation, driver or
 *     crew recruitment, subcontracting, capacity coordination and a directly
 *     operated fleet are all positions; nobody listed them as business types.
 *   * an **asset** — what operating a position leaves behind that a later
 *     position needs (contracts, a delivery record, a supply network, density,
 *     a fleet). Strategy is a walk over assets, so "a quick-cash business does
 *     not need to be the final company" is arithmetic rather than advice.
 *   * a **fact key** — the generic unit economics every position is priced
 *     from (what the payer pays per unit of work, what a unit of capacity
 *     produces per day, what independent supply accepts, when each side pays).
 *     A fact carries its status — OBSERVED, VERIFIED, ESTIMATE or ASSUMPTION —
 *     and an absent fact is UNKNOWN, which is a threshold to solve and a
 *     question to research, never a favourable number (invariant 39).
 *
 * Pure types and tables. The engine is `services/industry/construction/`.
 */

/* ------------------------------------------------------------------ position */

/** What the operation holds with the paying buyer. */
export const CONTRACT_HOLDS = ['NONE', 'INTRODUCE', 'REPRESENT', 'PRIME'] as const;
export type ContractHold = (typeof CONTRACT_HOLDS)[number];

/** How the paid work gets done. `SELF` is the operator doing it, which the standing rule forbids. */
export const SUPPLY_MODES = ['SELF', 'RECRUIT', 'NETWORK', 'EMPLOY'] as const;
export type SupplyMode = (typeof SUPPLY_MODES)[number];

/** Whose assets perform the work. */
export const ASSET_MODES = ['NONE', 'CONTRACTOR', 'LEASED', 'OWNED'] as const;
export type AssetMode = (typeof ASSET_MODES)[number];

export const AGGREGATIONS = ['SINGLE', 'POOLED'] as const;
export type AggregationMode = (typeof AGGREGATIONS)[number];

export const INFORMATION_MODES = ['NONE', 'PLATFORM'] as const;
export type InformationMode = (typeof INFORMATION_MODES)[number];

/**
 * How the position is paid: the revenue basis (W-7). Every position the four
 * axes above describe already has a natural basis — an introduction or a
 * placement earns a FEE, a prime contract earns a SERVICE margin — and a
 * position states `revenue` only when it is paid some other way:
 *
 *   * FEE — a fee or commission on a transaction somebody else performs;
 *   * SERVICE — the margin on work delivered under our contract;
 *   * RESALE — the spread on units bought and resold, held as inventory;
 *   * SUBSCRIPTION — a recurring charge for software or an information layer;
 *   * RENT — rent on an asset we own and others operate;
 *   * FINANCING — a financing margin (interest, a factoring discount) on
 *     money advanced against the transaction;
 *   * COMBINED — two transactions with one payer: the service margin and a
 *     financing margin on extended terms.
 *
 * The vocabulary is open to evidence the way roles are: a role research names
 * that nothing here lists is recorded on its fact (`roleId`) and read back as
 * an evidence role, never dropped.
 */
export const REVENUE_BASES = ['FEE', 'SERVICE', 'RESALE', 'SUBSCRIPTION', 'RENT', 'FINANCING', 'COMBINED'] as const;
export type RevenueBasis = (typeof REVENUE_BASES)[number];

export const REVENUE_LABELS: Record<RevenueBasis, string> = {
  FEE: 'a fee or commission',
  SERVICE: 'the margin on work delivered under our contract',
  RESALE: 'the spread on units bought, held and resold',
  SUBSCRIPTION: 'a recurring subscription',
  RENT: 'rent on an asset we own',
  FINANCING: 'a financing margin on money advanced',
  COMBINED: 'a service margin and a financing margin from the same payer',
};

/**
 * When the payer's money moves, and what makes the purchase happen again (W-8).
 *
 * The §82 transaction design (`cash/properties.ts`) and the §92 position are
 * one vocabulary for these two dimensions: the design's `funding` and `repeat`
 * are these sets, and a position states them only when they differ from the
 * default (paid on delivery, once), so every key and stored position written
 * before they existed reads exactly as it did.
 */
export const MONEY_TIMINGS = ['ON_DELIVERY', 'PREPAID', 'THRESHOLD_PRESALE'] as const;
export type MoneyTiming = (typeof MONEY_TIMINGS)[number];
export const RECURRENCES = ['ONE_OFF', 'RECURRING_COHORT', 'SUBSCRIPTION'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export interface Position {
  contract: ContractHold;
  supply: SupplyMode;
  assets: AssetMode;
  aggregation: AggregationMode;
  information: InformationMode;
  /** Absent: the position's natural basis (`naturalRevenue`). */
  revenue?: RevenueBasis;
  /** Absent: paid on delivery. */
  moneyTiming?: MoneyTiming;
  /** Absent: a one-off purchase. */
  recurrence?: Recurrence;
}

/** Work whose doing needs equipment someone must own or lease, read from its words. */
export const EQUIPMENT_WORDS = /\b(truck|van|vehicle|fleet|trailer|equipment|machine|machinery|vessel|aircraft|warehouse|plant|crane|excavator)s?\b/i;

/** The basis a position earns on when it states none. */
export function naturalRevenue(p: Pick<Position, 'contract'>): RevenueBasis {
  return p.contract === 'PRIME' ? 'SERVICE' : 'FEE';
}

/** The basis a position is actually paid on. */
export function revenueOf(p: Position): RevenueBasis {
  return p.revenue ?? naturalRevenue(p);
}

/** True when a position is paid on something other than its natural basis. */
export function hasOwnRevenue(p: Position): boolean {
  return p.revenue !== undefined && p.revenue !== naturalRevenue(p);
}

/** The economic mechanisms the owner named (2026-11-07), read off a position rather than chosen. */
export const MECHANISMS = [
  'DEMAND_OWNERSHIP',
  'SUPPLY_COORDINATION',
  'BROKERAGE',
  'REPRESENTATION',
  'SUBCONTRACTING',
  'AGGREGATION',
  'TRANSACTION_FACILITATION',
  'CAPACITY_COORDINATION',
  'FULFILMENT_OWNERSHIP',
  'CONTRACT_CONTROL',
  'INFORMATION_ADVANTAGE',
  'ASSET_OWNERSHIP',
  'RESALE',
  'SUBSCRIPTION',
  'ASSET_RENTAL',
  'FINANCING',
  'TRANSACTION_COMBINATION',
] as const;
export type Mechanism = (typeof MECHANISMS)[number];

/* ------------------------------------------------------------------- assets */

/** What operating a position accumulates, and what a buyer or a later position requires. */
export const ASSETS = [
  'BUYER_RELATIONSHIPS',
  'CUSTOMER_CONTRACTS',
  'DELIVERY_RECORD',
  'SUPPLY_NETWORK',
  'LABOR_PIPELINE',
  'OPERATING_CAPABILITY',
  'CAPACITY',
  'CAPACITY_EQUITY',
  'DENSITY',
  'DATA',
  'INSURANCE_COVER',
  'OPERATING_AUTHORITY',
  'PROGRAM_SELECTION',
  'INVENTORY',
  'RECEIVABLES_BOOK',
  'SUBSCRIBER_BASE',
] as const;
export type Asset = (typeof ASSETS)[number];

export const ASSET_LABELS: Record<Asset, string> = {
  BUYER_RELATIONSHIPS: 'buyer relationships',
  CUSTOMER_CONTRACTS: 'customer contracts held in our name',
  DELIVERY_RECORD: 'a performance record buyers can check',
  SUPPLY_NETWORK: 'a network of independent operators',
  LABOR_PIPELINE: 'a recruiting pipeline of workers',
  OPERATING_CAPABILITY: 'an operating team (dispatch, management, compliance)',
  CAPACITY: 'operating capacity (equipment, premises, machines) under our control',
  CAPACITY_EQUITY: 'owned capacity (equipment, premises, machines)',
  DENSITY: 'density — several buyers’ volume on shared capacity',
  DATA: 'an information layer (scheduling, matching, pricing data)',
  INSURANCE_COVER: 'the insurance buyers require',
  OPERATING_AUTHORITY: 'the licences or registrations the work requires',
  PROGRAM_SELECTION: 'selection into a buyer’s partner program',
  INVENTORY: 'inventory held for resale',
  RECEIVABLES_BOOK: 'a book of financed receivables and the repayment record behind it',
  SUBSCRIBER_BASE: 'paying subscribers',
};

/** What controlling ambition the operator can state. */
export const CONTROL_TARGETS = ['DEMAND', 'SUPPLY', 'FULFILMENT', 'ASSETS', 'CHOKEPOINTS', 'CONTRACTS', 'INFORMATION'] as const;
export type ControlTarget = (typeof CONTROL_TARGETS)[number];

/** The assets that make each kind of control real. */
export const CONTROL_ASSETS: Record<ControlTarget, Asset[]> = {
  DEMAND: ['CUSTOMER_CONTRACTS', 'BUYER_RELATIONSHIPS'],
  SUPPLY: ['SUPPLY_NETWORK', 'LABOR_PIPELINE'],
  FULFILMENT: ['OPERATING_CAPABILITY', 'CAPACITY'],
  ASSETS: ['CAPACITY_EQUITY', 'CAPACITY'],
  CHOKEPOINTS: [],
  CONTRACTS: ['CUSTOMER_CONTRACTS'],
  INFORMATION: ['DATA'],
};

/* ------------------------------------------------------------------- facts */

/**
 * The unit economics every position is priced from. Generic on purpose: a
 * "unit" is whatever the industry sells (a delivered stop, a cleaned square
 * foot, a billed hour) and a "capacity unit" is whatever produces it (a van, a
 * crew, a machine). The evidence names the units; the engine never does.
 */
export const FACT_KEYS = {
  price_per_unit: { label: 'What the paying buyer pays per unit of work', unit: 'USD/unit', segment: true, kind: 'POSITIVE' },
  units_per_capacity_day: { label: 'Units one capacity unit completes per working day', unit: 'units/day', segment: true, kind: 'POSITIVE' },
  pooled_units_per_capacity_day: { label: 'Units per capacity-day when several buyers share the capacity', unit: 'units/day', segment: true, kind: 'POSITIVE' },
  contractor_rate_per_unit: { label: 'What an independent operator with its own equipment accepts per unit', unit: 'USD/unit', segment: true, kind: 'POSITIVE' },
  /*
   * A supplier's total for one run of a stated quantity ("$0.47 per piece for a
   * 10,000-home run, total $4,675"): what a pooled design pays whether one
   * buyer or many take part — the mechanism's `fixed_cost` (quant/mechanism.ts).
   */
  fixed_cost_per_run: { label: 'What supply charges for one whole run of the stated quantity', unit: 'USD/run', segment: true, kind: 'POSITIVE' },
  contractor_day_rate: { label: 'What an independent operator with its own equipment accepts per day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  labor_cost_per_day: { label: 'Fully loaded cost of one employed worker-day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  asset_lease_per_day: { label: 'Leasing or renting one capacity unit per day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  asset_lease_deposit: { label: 'Deposit to lease one capacity unit', unit: 'USD', segment: false, kind: 'POSITIVE' },
  asset_purchase_cost: { label: 'Buying one capacity unit', unit: 'USD', segment: false, kind: 'POSITIVE' },
  asset_ownership_cost_per_day: { label: 'Maintaining an owned capacity unit per day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  variable_cost_per_day: { label: 'Fuel and consumables per operated capacity-day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  insurance_per_capacity_year: { label: 'Insurance per operated capacity unit per year', unit: 'USD/year', segment: false, kind: 'POSITIVE' },
  broker_take_rate: { label: 'Share of the price an intermediary keeps', unit: 'share', segment: false, kind: 'RATE' },
  placement_fee: { label: 'What an operator pays per worker placed', unit: 'USD/placement', segment: true, kind: 'POSITIVE' },
  placements_per_month: { label: 'Workers one recruiter can place per month', unit: 'placements/month', segment: false, kind: 'POSITIVE' },
  recruiting_cost_per_placement: { label: 'Advertising and screening cost per placed worker', unit: 'USD/placement', segment: false, kind: 'POSITIVE' },
  buyer_payment_days: { label: 'Days from work done to the buyer’s payment arriving', unit: 'days', segment: true, kind: 'POSITIVE' },
  supplier_payment_days: { label: 'Days from work done to paying supply', unit: 'days', segment: false, kind: 'POSITIVE' },
  account_units_per_month: { label: 'Units one won account buys per month', unit: 'units/month', segment: true, kind: 'POSITIVE' },
  account_win_rate: { label: 'Share of pitched accounts that sign', unit: 'share', segment: true, kind: 'RATE' },
  outreach_cost_per_account: { label: 'What pitching one account costs', unit: 'USD/account', segment: true, kind: 'POSITIVE' },
  sales_cycle_days: { label: 'Days from first pitch to first paid work', unit: 'days', segment: true, kind: 'POSITIVE' },
  accounts_reachable: { label: 'Accounts of this kind reachable in the market', unit: 'accounts', segment: true, kind: 'POSITIVE' },
  supply_available: { label: 'Independent operators available to coordinate', unit: 'operators', segment: false, kind: 'POSITIVE' },
  overhead_per_month: { label: 'Base overhead per month (software, admin, accounting)', unit: 'USD/month', segment: false, kind: 'POSITIVE' },
  manager_cost_per_month: { label: 'A hired operations manager per month, so the owner does no physical work', unit: 'USD/month', segment: false, kind: 'POSITIVE' },
  platform_cost_per_month: { label: 'Running our own dispatch / information layer per month', unit: 'USD/month', segment: false, kind: 'POSITIVE' },
  hiring_days: { label: 'Days to hire and onboard employed workers', unit: 'days', segment: false, kind: 'POSITIVE' },
  /*
   * Operational reliability, learned from operating: priced in only when a fact
   * exists, because an unmeasured failure rate is not zero and not a guess —
   * it is simply not modelled until somebody measures it.
   */
  failure_rate: { label: 'Share of units that fail and are redone or refunded at our cost', unit: 'share', segment: false, kind: 'RATE' },
  /* The revenue bases beyond a fee and a service margin (W-7). */
  purchase_cost_per_unit: { label: 'What buying one unit for resale costs', unit: 'USD/unit', segment: false, kind: 'POSITIVE' },
  inventory_days: { label: 'Days of sales held as inventory', unit: 'days', segment: false, kind: 'POSITIVE' },
  subscription_price_per_month: { label: 'What one subscriber pays per month', unit: 'USD/month', segment: true, kind: 'POSITIVE' },
  asset_rent_per_day: { label: 'Rent one owned capacity unit earns per rented day', unit: 'USD/day', segment: false, kind: 'POSITIVE' },
  asset_utilisation: { label: 'Share of working days an owned unit is rented', unit: 'share', segment: false, kind: 'RATE' },
  financing_margin: { label: 'Share of the face value earned per financing advance (interest, discount or fee)', unit: 'share', segment: true, kind: 'RATE' },
  financing_term_days: { label: 'Days an advance is outstanding before it is repaid', unit: 'days', segment: true, kind: 'POSITIVE' },
  default_rate: { label: 'Share of financed face value never repaid', unit: 'share', segment: true, kind: 'RATE' },
  capital_cost_rate: { label: 'Annual cost of the capital advanced', unit: 'share', segment: false, kind: 'RATE' },
  /*
   * Who stands in a commercial role, as research recorded it (W-6). No formula
   * reads it: it records that a role is occupied and by whom, and — when the
   * fact names the paying buyer — that this buyer pays an intermediary.
   */
  role_occupants: { label: 'Parties recorded standing in a commercial role', unit: 'occupants', segment: true, kind: 'POSITIVE' },
} as const satisfies Record<string, { label: string; unit: string; segment: boolean; kind: 'POSITIVE' | 'RATE' }>;
export type FactKey = keyof typeof FACT_KEYS;
export const FACT_KEY_LIST = Object.keys(FACT_KEYS) as FactKey[];

export function isFactKey(value: unknown): value is FactKey {
  return typeof value === 'string' && value in FACT_KEYS;
}

/**
 * How long a reading of each kind of quantity stays current (W-10). A fact
 * carries the day it was observed and is current until `validUntil` — the
 * observation day plus its class's window, unless the fact declares its own.
 * Past it the fact is still evidence and is never dropped, but its range is
 * widened (`STALE_WIDENING_PER_WINDOW`), because the world it measured has had
 * time to move.
 */
export const FRESHNESS_CLASSES = {
  /** Prices, rates and costs move with the market, wages and competition. */
  PRICE: { days: 180, because: 'prices, rates and costs are re-set by the market within months' },
  /** Volumes, conversion and selling effort drift with demand and with the seller. */
  VOLUME: { days: 365, because: 'demand, conversion and selling effort drift over a year' },
  /** Payment and contract terms are written into agreements that run for years. */
  TERMS: { days: 730, because: 'payment and contract terms are fixed in agreements that run for years' },
  /** Legal requirements and who stands in a role change slowly. */
  STRUCTURE: { days: 1095, because: 'legal requirements and who occupies a role change over years, not months' },
} as const;
export type FreshnessClass = keyof typeof FRESHNESS_CLASSES;

/** Each fact key's class. A Record over every key, so a new key is a compile error until classed. */
export const FACT_FRESHNESS: Record<FactKey, FreshnessClass> = {
  price_per_unit: 'PRICE',
  units_per_capacity_day: 'VOLUME',
  pooled_units_per_capacity_day: 'VOLUME',
  contractor_rate_per_unit: 'PRICE',
  fixed_cost_per_run: 'PRICE',
  contractor_day_rate: 'PRICE',
  labor_cost_per_day: 'PRICE',
  asset_lease_per_day: 'PRICE',
  asset_lease_deposit: 'PRICE',
  asset_purchase_cost: 'PRICE',
  asset_ownership_cost_per_day: 'PRICE',
  variable_cost_per_day: 'PRICE',
  insurance_per_capacity_year: 'PRICE',
  broker_take_rate: 'PRICE',
  placement_fee: 'PRICE',
  placements_per_month: 'VOLUME',
  recruiting_cost_per_placement: 'PRICE',
  buyer_payment_days: 'TERMS',
  supplier_payment_days: 'TERMS',
  account_units_per_month: 'VOLUME',
  account_win_rate: 'VOLUME',
  outreach_cost_per_account: 'PRICE',
  sales_cycle_days: 'VOLUME',
  accounts_reachable: 'VOLUME',
  supply_available: 'VOLUME',
  overhead_per_month: 'PRICE',
  manager_cost_per_month: 'PRICE',
  platform_cost_per_month: 'PRICE',
  hiring_days: 'VOLUME',
  failure_rate: 'VOLUME',
  purchase_cost_per_unit: 'PRICE',
  inventory_days: 'VOLUME',
  subscription_price_per_month: 'PRICE',
  asset_rent_per_day: 'PRICE',
  asset_utilisation: 'VOLUME',
  financing_margin: 'PRICE',
  financing_term_days: 'TERMS',
  default_rate: 'VOLUME',
  capital_cost_rate: 'PRICE',
  role_occupants: 'STRUCTURE',
};

/**
 * How much an expired fact's range widens per elapsed window past its
 * `validUntil`, as a share of its own value, up to `STALE_WIDENING_CAP`. A
 * stated convention, not evidence: a reading one window out of date could
 * have moved a quarter either way.
 */
export const STALE_WIDENING_PER_WINDOW = 0.25;
export const STALE_WIDENING_CAP = 1;

/** The day a fact of this key observed on `observedAt` stops being current. */
export function validUntilFor(key: FactKey, observedAt: string): string {
  const days = FRESHNESS_CLASSES[FACT_FRESHNESS[key]].days;
  return new Date(Date.parse(observedAt) + days * 86_400_000).toISOString();
}

/**
 * How strongly a fact is known, strongest first. OBSERVED is something seen
 * rather than supposed: this operation's own result (a quoted price, a signed
 * rate, a measured conversion) or a sourced claim that cleared the evidence
 * gate (W-5), dated and carrying the claim as its lineage. VERIFIED is a
 * person's attestation and is never written by a machine. ESTIMATE is a
 * published figure about a comparable market. ASSUMPTION is a hypothesis: a
 * stated range nobody has checked, or a claim that reasons rather than
 * reports. Absent is UNKNOWN.
 */
export const FACT_STATUSES = ['OBSERVED', 'VERIFIED', 'ESTIMATE', 'ASSUMPTION'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];
export type KnownStatus = FactStatus | 'UNKNOWN';

export interface FactSource {
  title: string;
  url: string | null;
  kind: 'PRIMARY' | 'SECONDARY' | 'OPERATOR' | 'OUTCOME' | 'MAP';
  claimId?: string | null;
}

export interface Fact {
  key: FactKey;
  /** The buyer segment (actor id) a segment fact is about; null for the industry as a whole. */
  segment: string | null;
  low: number;
  high: number;
  status: FactStatus;
  source: FactSource;
  /** What the figure measures, in the source's terms. */
  measures: string;
  /** The market the figure was measured in, when it differs from the target. */
  geography?: string | null;
  /** When the figure was observed (the source's date, else when it was read). Absent: undated. */
  observedAt?: string | null;
  /** When it stops being current; from `FACT_FRESHNESS` unless the fact declared its own. */
  validUntil?: string | null;
  /** The commercial role the figure is about (W-6): a seed id, or a role research named that no seed lists. */
  roleId?: string | null;
  /** Who stands in that role, for a `role_occupants` fact. */
  occupant?: string | null;
  /** The industry-map node a project-level fact was established under. */
  nodeId?: string | null;
}

/* ------------------------------------------------------------- industry model */

export const ACTOR_ROLES = ['BUYER', 'END_CUSTOMER', 'OPERATOR', 'LABOR', 'ASSET_PROVIDER', 'INTERMEDIARY', 'PLATFORM', 'REGULATOR', 'INSURER', 'FINANCIER'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export type EvidenceStatus = 'VERIFIED' | 'ESTIMATE' | 'ASSUMPTION';

export interface Actor {
  id: string;
  name: string;
  role: ActorRole;
  description: string;
  status: EvidenceStatus;
  source: FactSource;
}

export const FLOW_KINDS = ['MONEY', 'WORK', 'RISK', 'CAPACITY', 'AUTHORITY', 'DEMAND', 'INFORMATION', 'FINANCING', 'OBLIGATION'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export interface Flow {
  from: string;
  to: string;
  kind: FlowKind;
  terms: string;
  status: EvidenceStatus;
  source: FactSource;
  /** Who pays in this relationship, by name, as the evidence declares it (W-13). Null: not established. */
  payer?: string | null;
  /** Who supplies what is paid for, by name, as the evidence declares it. Null: not established. */
  supplier?: string | null;
}

/** A buyer the operation could sell to, with what it demands first. */
export interface Segment {
  actorId: string;
  /** WORK: buys the work done. LABOR: buys workers placed with it. */
  buys: 'WORK' | 'LABOR';
  /** Assets this buyer requires before it contracts at all. */
  requires: Asset[];
  /** Whether it will pay an intermediary that does not hold the contract (null: not established). */
  acceptsIntermediary: boolean | null;
  /** Ways of doing the work this buyer refuses, where a source says so (e.g. it requires the operator's own employees). */
  refuses?: { supply?: SupplyMode[]; because: string };
  /** How it is reached. */
  channel: string;
  /** What the first paid transaction with it looks like. */
  firstTransaction: string;
  status: EvidenceStatus;
  source: FactSource;
}

/** A position predicate: a gate or failure applies when every stated axis matches. */
export interface Applies {
  contract?: ContractHold[];
  supply?: SupplyMode[];
  assets?: AssetMode[];
  aggregation?: AggregationMode[];
  /** Applies only to positions paid on one of these bases (a lending licence applies to FINANCING). */
  revenue?: RevenueBasis[];
  /** Applies only when selling to one of these segments. */
  segments?: string[];
}

export interface Gate {
  id: string;
  name: string;
  kind: 'LICENCE' | 'INSURANCE' | 'BOND' | 'REGISTRATION' | 'PROGRAM_SELECTION';
  applies: Applies;
  /** Money paid before the first transaction, in dollars. Null is unknown, never zero. */
  upfrontLow: number | null;
  upfrontHigh: number | null;
  days: number | null;
  grants: Asset[];
  /** Assets that must already be held before this gate can be passed at all. */
  requires?: Asset[];
  status: EvidenceStatus;
  source: FactSource;
}

export interface Chokepoint {
  id: string;
  name: string;
  why: string;
  /** What holding it takes. */
  controlledBy: Asset[];
  status: EvidenceStatus;
  source: FactSource;
}

export interface StructuralNote {
  id: string;
  statement: string;
  status: EvidenceStatus;
  source: FactSource;
}

export interface ScaleEconomy extends StructuralNote {
  kind: 'DENSITY' | 'SCALE' | 'SCOPE';
  rewards: Asset;
}

export interface FailureMode extends StructuralNote {
  applies: Applies;
  /** A one-off loss in dollars when it happens, where a source states one. */
  costLow?: number | null;
  costHigh?: number | null;
}

export interface Adjacency extends StructuralNote {
  name: string;
  via: Asset[];
}

export interface BargainingPower extends StructuralNote {
  holder: string;
  over: string;
}

/** Everything known about an industry, from whatever recorded it. */
export interface IndustryEvidence {
  industry: string;
  geography: string | null;
  /** What one unit of work and one unit of capacity are here. */
  workUnit: string;
  capacityUnit: string;
  /** Whether the work needs equipment (a vehicle, a machine); false for pure labour. */
  needsEquipment: boolean;
  actors: Actor[];
  flows: Flow[];
  segments: Segment[];
  gates: Gate[];
  chokepoints: Chokepoint[];
  scale: ScaleEconomy[];
  failures: FailureMode[];
  adjacencies: Adjacency[];
  competition: StructuralNote[];
  bargaining: BargainingPower[];
  facts: Fact[];
  /** Where each part came from: a reference pack, the industry map, the operator, outcomes. */
  provenance: string[];
}

/** The owner's 2026-11-07 list of what an industry model must cover. */
export const MODEL_DIMENSIONS = [
  'PARTICIPANTS',
  'PAYMENT_AND_CONTRACTS',
  'DEMAND_AND_SUPPLY',
  'PRICING',
  'CUSTOMER_OWNERSHIP',
  'LABOR_AND_FULFILMENT',
  'CAPITAL_AND_CASH_CYCLE',
  'CAPACITY',
  'COMPETITION',
  'REGULATORY_GATES',
  'FAILURES_AND_EXPOSURE',
  'SCALE_ECONOMIES',
  'BARGAINING_POWER',
  'CHOKEPOINTS',
  'ADJACENCIES',
] as const;
export type ModelDimension = (typeof MODEL_DIMENSIONS)[number];

/** Working days in a month — a stated convention, used everywhere a day becomes a month. */
export const WORKING_DAYS_PER_MONTH = 21.7;
/** Working days in a year, for annual costs per operated day. */
export const WORKING_DAYS_PER_YEAR = 260;
