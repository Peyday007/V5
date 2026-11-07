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

export interface Position {
  contract: ContractHold;
  supply: SupplyMode;
  assets: AssetMode;
  aggregation: AggregationMode;
  information: InformationMode;
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
  'FLEET',
  'FLEET_EQUITY',
  'ROUTE_DENSITY',
  'DISPATCH_DATA',
  'INSURANCE_COVER',
  'OPERATING_AUTHORITY',
  'PROGRAM_SELECTION',
] as const;
export type Asset = (typeof ASSETS)[number];

export const ASSET_LABELS: Record<Asset, string> = {
  BUYER_RELATIONSHIPS: 'buyer relationships',
  CUSTOMER_CONTRACTS: 'customer contracts held in our name',
  DELIVERY_RECORD: 'a performance record buyers can check',
  SUPPLY_NETWORK: 'a network of independent operators',
  LABOR_PIPELINE: 'a recruiting pipeline of workers',
  OPERATING_CAPABILITY: 'an operating team (dispatch, management, compliance)',
  FLEET: 'operating equipment under our control',
  FLEET_EQUITY: 'owned equipment',
  ROUTE_DENSITY: 'density — several buyers’ volume on shared capacity',
  DISPATCH_DATA: 'an information layer (dispatch, routing, pricing data)',
  INSURANCE_COVER: 'the insurance buyers require',
  OPERATING_AUTHORITY: 'the licences or registrations the work requires',
  PROGRAM_SELECTION: 'selection into a buyer’s partner program',
};

/** What controlling ambition the operator can state. */
export const CONTROL_TARGETS = ['DEMAND', 'SUPPLY', 'FULFILMENT', 'ASSETS', 'CHOKEPOINTS', 'CONTRACTS', 'INFORMATION'] as const;
export type ControlTarget = (typeof CONTROL_TARGETS)[number];

/** The assets that make each kind of control real. */
export const CONTROL_ASSETS: Record<ControlTarget, Asset[]> = {
  DEMAND: ['CUSTOMER_CONTRACTS', 'BUYER_RELATIONSHIPS'],
  SUPPLY: ['SUPPLY_NETWORK', 'LABOR_PIPELINE'],
  FULFILMENT: ['OPERATING_CAPABILITY', 'FLEET'],
  ASSETS: ['FLEET_EQUITY', 'FLEET'],
  CHOKEPOINTS: [],
  CONTRACTS: ['CUSTOMER_CONTRACTS'],
  INFORMATION: ['DISPATCH_DATA'],
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
} as const satisfies Record<string, { label: string; unit: string; segment: boolean; kind: 'POSITIVE' | 'RATE' }>;
export type FactKey = keyof typeof FACT_KEYS;
export const FACT_KEY_LIST = Object.keys(FACT_KEYS) as FactKey[];

export function isFactKey(value: unknown): value is FactKey {
  return typeof value === 'string' && value in FACT_KEYS;
}

/**
 * How strongly a fact is known, strongest first. OBSERVED is this operation's
 * own result (a quoted price, a signed rate, a measured conversion); VERIFIED
 * is a primary source or a gated claim about this market; ESTIMATE is a
 * published figure about a comparable market; ASSUMPTION is a stated range
 * nobody has checked. Absent is UNKNOWN.
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

export const FLOW_KINDS = ['MONEY', 'WORK', 'RISK', 'CAPACITY', 'AUTHORITY', 'DEMAND'] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];

export interface Flow {
  from: string;
  to: string;
  kind: FlowKind;
  terms: string;
  status: EvidenceStatus;
  source: FactSource;
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
