/**
 * The industry model: the evidence, organised into the flows of value, money,
 * risk, capacity and contractual authority, with each dimension the owner
 * named (2026-11-07) said to be evidenced, partly evidenced or unknown (§92).
 *
 * Nothing here invents an actor, a flow or a figure. What the evidence does
 * not hold is reported as UNKNOWN, and `economics.ts` turns each load-bearing
 * unknown into a threshold and `construction.ts` into a research question that
 * is asked only when its answer can change the decision.
 *
 * Facts about one quantity are resolved strongest first — an operation's own
 * observed result beats a verified source, which beats a published estimate
 * about a comparable market, which beats an assumption. A weaker fact is never
 * deleted; it is kept beside the one that answers, as `superseded`
 * (invariant 17: new evidence never silently overwrites old).
 */
import {
  FACT_STATUSES,
  MODEL_DIMENSIONS,
  type Fact,
  type FactKey,
  type FactStatus,
  type IndustryEvidence,
  type KnownStatus,
  type ModelDimension,
} from '../../../domain/construction.ts';

export interface ResolvedFact {
  key: FactKey;
  segment: string | null;
  low: number;
  high: number;
  status: KnownStatus;
  sources: Fact['source'][];
  measures: string[];
  /** Weaker facts about the same quantity, kept as history. */
  superseded: Fact[];
}

export interface DimensionCoverage {
  dimension: ModelDimension;
  reading: 'EVIDENCED' | 'PARTIAL' | 'UNKNOWN';
  items: number;
  /** The strongest status any item carries. */
  strongest: KnownStatus;
  note: string;
}

export interface IndustryModel {
  evidence: IndustryEvidence;
  coverage: DimensionCoverage[];
  /** Plain statements of each flow, grouped by kind. */
  valueChain: { kind: string; lines: string[] }[];
  /** Counts of facts by status, so a reader sees how much rests on what. */
  factStatus: Record<KnownStatus, number>;
}

const RANK: Record<FactStatus, number> = Object.fromEntries(FACT_STATUSES.map((s, i) => [s, i])) as Record<FactStatus, number>;

/** The answer for one quantity, for one segment (falling back to the industry-wide figure). */
export function resolveFact(facts: readonly Fact[], key: FactKey, segment: string | null = null): ResolvedFact {
  const pick = (seg: string | null) => facts.filter((f) => f.key === key && (f.segment ?? null) === seg);
  let pool = segment ? pick(segment) : [];
  if (pool.length === 0) pool = pick(null);
  if (pool.length === 0) return { key, segment, low: NaN, high: NaN, status: 'UNKNOWN', sources: [], measures: [], superseded: [] };
  const best = Math.min(...pool.map((f) => RANK[f.status]));
  const top = pool.filter((f) => RANK[f.status] === best);
  return {
    key,
    segment: top[0]!.segment ?? null,
    low: Math.min(...top.map((f) => Math.min(f.low, f.high))),
    high: Math.max(...top.map((f) => Math.max(f.low, f.high))),
    status: top[0]!.status,
    sources: top.map((f) => f.source),
    measures: top.map((f) => f.measures),
    superseded: pool.filter((f) => RANK[f.status] > best),
  };
}

function strongestOf(statuses: string[]): KnownStatus {
  const order: KnownStatus[] = ['OBSERVED', 'VERIFIED', 'ESTIMATE', 'ASSUMPTION', 'UNKNOWN'];
  for (const s of order) if (statuses.includes(s)) return s;
  return 'UNKNOWN';
}

function cover(dimension: ModelDimension, items: { status: string }[], expected: number, note: string): DimensionCoverage {
  const reading = items.length === 0 ? 'UNKNOWN' : items.length >= expected && items.some((i) => i.status !== 'ASSUMPTION') ? 'EVIDENCED' : 'PARTIAL';
  return { dimension, reading, items: items.length, strongest: strongestOf(items.map((i) => i.status)), note };
}

/** Organise the evidence into a model. Pure. */
export function buildIndustryModel(evidence: IndustryEvidence): IndustryModel {
  const e = evidence;
  const facts = (...keys: FactKey[]) => e.facts.filter((f) => keys.includes(f.key));
  const flows = (...kinds: string[]) => e.flows.filter((f) => kinds.includes(f.kind));
  const roles = new Set(e.actors.map((a) => a.role));
  const coverage: DimensionCoverage[] = [
    cover('PARTICIPANTS', e.actors, 4, `${roles.size} kinds of participant: ${[...roles].join(', ').toLowerCase() || 'none recorded'}`),
    cover('PAYMENT_AND_CONTRACTS', flows('MONEY', 'AUTHORITY'), 2, `${flows('MONEY').length} money flow(s), ${flows('AUTHORITY').length} contract flow(s)`),
    cover('DEMAND_AND_SUPPLY', [...e.segments, ...facts('account_units_per_month', 'accounts_reachable', 'supply_available')], 3, `${e.segments.length} buyer segment(s); volume and supply ${facts('accounts_reachable', 'supply_available').length ? 'partly sized' : 'not sized'}`),
    cover('PRICING', facts('price_per_unit', 'contractor_rate_per_unit', 'contractor_day_rate', 'broker_take_rate', 'placement_fee'), 2, 'what buyers pay, what supply accepts and what an intermediary keeps'),
    cover('CUSTOMER_OWNERSHIP', [...flows('DEMAND'), ...e.segments.filter((s) => s.acceptsIntermediary !== null)], 2, 'who holds the end customer and whether a buyer pays an intermediary'),
    cover('LABOR_AND_FULFILMENT', [...flows('WORK'), ...facts('labor_cost_per_day', 'units_per_capacity_day', 'hiring_days')], 3, 'who does the work, at what cost and throughput'),
    cover('CAPITAL_AND_CASH_CYCLE', facts('buyer_payment_days', 'supplier_payment_days', 'asset_lease_per_day', 'asset_purchase_cost', 'asset_lease_deposit'), 3, 'when each side is paid and what equipment costs'),
    cover('CAPACITY', [...flows('CAPACITY'), ...facts('units_per_capacity_day', 'pooled_units_per_capacity_day', 'supply_available')], 2, 'throughput per capacity unit and how much independent capacity exists'),
    cover('COMPETITION', e.competition, 1, 'who already serves these buyers and what keeps entrants out'),
    cover('REGULATORY_GATES', e.gates, 1, `${e.gates.length} licence, insurance, bond or program gate(s)`),
    cover('FAILURES_AND_EXPOSURE', [...e.failures, ...flows('RISK')], 2, 'what goes wrong and who carries the loss'),
    cover('SCALE_ECONOMIES', e.scale, 1, e.scale.map((s) => s.kind.toLowerCase()).join(', ') || 'none recorded'),
    cover('BARGAINING_POWER', e.bargaining, 1, 'who can set terms for whom'),
    cover('CHOKEPOINTS', e.chokepoints, 1, `${e.chokepoints.length} chokepoint(s) and what controlling each takes`),
    cover('ADJACENCIES', e.adjacencies, 1, `${e.adjacencies.length} adjacent market(s)`),
  ];
  // Every dimension is reported, in the owner's order.
  coverage.sort((a, b) => MODEL_DIMENSIONS.indexOf(a.dimension) - MODEL_DIMENSIONS.indexOf(b.dimension));

  const name = (id: string) => e.actors.find((a) => a.id === id)?.name ?? id;
  const valueChain = ['DEMAND', 'MONEY', 'WORK', 'CAPACITY', 'RISK', 'AUTHORITY'].map((kind) => ({
    kind,
    lines: flows(kind).map((f) => `${name(f.from)} → ${name(f.to)}: ${f.terms} [${f.status.toLowerCase()}]`),
  }));

  const factStatus: Record<KnownStatus, number> = { OBSERVED: 0, VERIFIED: 0, ESTIMATE: 0, ASSUMPTION: 0, UNKNOWN: 0 };
  for (const f of e.facts) factStatus[f.status] += 1;
  return { evidence: e, coverage, valueChain, factStatus };
}
