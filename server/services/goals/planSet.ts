/**
 * A goal's set of candidate plans, proven distinct (GOAL-23, GOAL-18-4, GOAL-13-6).
 *
 * One plan reaching a goal once is not proof that Brain can turn goals into
 * money. The stronger demonstration is many materially different plans for the
 * same goal — and that is only a demonstration when the count cannot be
 * inflated. So this module:
 *
 *  - reads candidates from what Brain already computes — transaction pathways
 *    (`pathways.ts`), constructed arrangements (`cash/construct.ts`) and the
 *    reconstruction's strategy readings (`reconstruction.ts`) — and owns no
 *    store, scheduler or authority of its own;
 *  - counts a plan distinct only when it differs on a dimension that changes
 *    its economics: mechanism, buyer channel, fulfilment, risk exposure or
 *    revenue stream. Two plans that differ only in wording collapse to one, and
 *    two that would count the same customers or the same cash are one plan, with
 *    the double count flagged;
 *  - gives every plan a complete, traceable model (acquisition and fulfilment
 *    route, costs, capital, timing, controls, evidence), each field marked
 *    PROVEN / ESTIMATED / UNKNOWN, and an acceptance status — ACCEPTED or
 *    PROVISIONAL — under the goal's own configured acceptance condition. Being
 *    compared never qualifies a plan;
 *  - reads a confidence requirement correctly: "90% to reach X" asks that at
 *    most a modelled 10% of outcomes fall below X, on a model shown to be
 *    reliable. It is never "the worst case is X". A floor is reported only from
 *    enforceable commitments; nothing manufactures one;
 *  - publishes confidence only when calibration supports it, and otherwise
 *    withholds it and says why;
 *  - keeps researched, authorized and executed attempts apart, and observed
 *    collections apart from modelled ones;
 *  - shows which plans survive a shared channel or supplier failing, and
 *    rebuilds the alternatives after a named change (`rebuildAfter`).
 *
 * No plan count, amount or confidence is a constant here: each comes from the
 * goal's acceptance condition, and an example in the specification ("ten plans",
 * "$10K") is an illustration, never a threshold. Pure: no database, no clock.
 */
import type { PathFact, TransactionPathway } from './pathways.ts';
import type { VariantReading } from './reconstruction.ts';
import type { ConstructedArrangement } from '../cash/construct.ts';
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** How far a model field is established. A DENIED pathway fact is a known answer and reads as PROVEN (of its denial). */
export type FieldStatus = 'PROVEN' | 'ESTIMATED' | 'UNKNOWN';

export interface ModelField {
  value: number | string | null;
  low: number | null;
  high: number | null;
  status: FieldStatus;
  /** Where the value came from: the trace a reader follows back. */
  basis: string;
}

/** The fields every plan's model carries. None may be absent — an unknown one says UNKNOWN. */
export const MODEL_FIELDS = ['acquisitionRoute', 'fulfilmentRoute', 'costs', 'capital', 'timing', 'controls', 'evidence'] as const;
export type ModelFieldKey = (typeof MODEL_FIELDS)[number];
export type PlanModel = Record<ModelFieldKey, ModelField>;

/** The dimensions on which plans differ materially. Wording is not one of them. */
export const DISTINCTNESS_DIMENSIONS = ['mechanism', 'channel', 'fulfilment', 'risk', 'revenue'] as const;
export type DistinctnessDimension = (typeof DISTINCTNESS_DIMENSIONS)[number];

export type CandidateSource = 'PATHWAY' | 'ARRANGEMENT' | 'STRATEGY' | 'RECONSTRUCTED';

/** One candidate plan, as read from what Brain already computed. */
export interface PlanCandidate {
  id: string;
  title: string;
  source: CandidateSource;
  /**
   * The openings whose economics this plan's model is read from. A calibration
   * speaks for a plan only when it was measured on exactly this set
   * (`calibrationFor`); a plan with none — a constructed arrangement, or an
   * alternative rebuilt on a part nobody measured — is covered by none.
   */
  opportunityIds: string[];
  /** The economic shape: what makes this plan a different plan. */
  dimensions: Record<DistinctnessDimension, string>;
  /** The customer pools it sells to; two plans selling to one pool count its customers once. */
  customers: string[];
  /** Where its cash comes from (a payer, a receivable, a pool); shared cash is counted once. */
  cashSources: string[];
  /** Channels and suppliers it depends on: what a failure takes with it. */
  channels: string[];
  suppliers: string[];
  model: PlanModel;
  /** Modelled collections inside the window, major units. Never observed money. */
  modelled: { p10: number; p50: number; p90: number } | null;
  /** Money actually collected, major units, from ledger rows; zero when nothing has been. */
  observedCollections: number;
  /** Enforceable commitments (signed, escrowed, guaranteed receivables): the only basis for a floor. */
  enforceableCommitments: number;
  /** Money it needs committed before it pays, major units, when known. */
  capitalRequired: number | null;
  /** Days from start to the first settled cash, when known. */
  daysToCash: number | null;
  attempts: { researched: boolean; authorized: boolean; executed: boolean };
  /** Why the arrangement makes money, and which parts carry to another buyer. */
  whyItWorks: string[];
  transfers: string[];
  /** Conditions the candidate's own records name under which it stops transferring. */
  stopsTransferringWhen: string[];
}

/**
 * The goal's acceptance condition, configured per goal. `confidence` is the
 * modelled share of outcomes that must reach `amount` (0.9 for "90% to reach");
 * null asks for no probability, and acceptance then rests on the adverse
 * outcome (p10) reaching the amount. `breadth` is how many distinct accepted
 * plans this goal asks for, when it asks — never a default.
 */
export interface AcceptanceCondition {
  amount: number;
  daysLeft: number | null;
  confidence: number | null;
  capitalCeiling: number | null;
  /** Model fields that must be at least ESTIMATED for a plan to be accepted; every field by default. */
  requiredFields?: readonly ModelFieldKey[];
  breadth?: number | null;
  /** What the goal optimizes beyond reaching the amount (GOAL-18-4); recorded, not presupposed. */
  objective?: PlanObjective;
}

/** Configurable optimization weights. Absent ones are zero; nothing presupposes one goal's objective for another. */
export interface PlanObjective {
  expected?: number;
  upside?: number;
  downside?: number;
  velocity?: number;
  independence?: number;
}

/** Whether the model's probabilities have been checked against outcomes. */
export interface Calibration {
  calibrated: boolean;
  /** Resolved predictions the calibration was measured on. */
  observations: number;
  basis: string;
  /**
   * The openings of the one plan this calibration was measured on: the quant
   * engine's assurance covers its best combination, and this Brain's record
   * covers the chosen strategy — never every candidate beside them. Null: it
   * speaks for no plan.
   */
  covers: readonly string[] | null;
}

/**
 * The calibration that speaks for this candidate's own model, or an
 * uncalibrated one saying whose it is. One plan's assurance is never lent to
 * another: a pathway, arrangement or strategy is calibrated only when it is
 * the very set of openings the calibration was measured on.
 */
export function calibrationFor(c: Pick<PlanCandidate, 'opportunityIds'>, calibration: Calibration | null): Calibration | null {
  if (!calibration || !calibration.calibrated) return calibration;
  const covers = new Set(calibration.covers ?? []);
  const own = new Set(c.opportunityIds);
  if (own.size > 0 && own.size === covers.size && [...own].every((id) => covers.has(id))) return calibration;
  return {
    calibrated: false,
    observations: 0,
    basis: calibration.covers && calibration.covers.length > 0 ? `the calibration covers ${calibration.covers.join(' + ')} only, not this plan's own model` : 'the calibration names no plan it was measured on',
    covers: calibration.covers,
  };
}

export interface PublishedConfidence {
  /** The modelled share reaching the amount, only when calibration supports it. */
  value: number | null;
  withheld: boolean;
  reason: string;
}

export interface Downside {
  /** The modelled adverse outcome (p10): a 10% modelled chance of falling below it, not a floor. */
  adverse: number | null;
  /** The guaranteed floor: enforceable commitments only. Never inferred from a model. */
  floor: number;
  floorBasis: string;
  /** Modelled outcome above the amount at the expected and upper readings. */
  overTarget: { expected: number | null; upper: number | null };
}

export interface FieldGap {
  field: ModelFieldKey;
  status: FieldStatus;
  basis: string;
}

export interface Plan {
  id: string;
  /** Candidates folded into this plan: paraphrases, or ones counting the same customers or cash. */
  members: string[];
  title: string;
  source: CandidateSource;
  dimensions: Record<DistinctnessDimension, string>;
  /** Canonical form of the dimensions: equal signatures are one plan. */
  signature: string;
  channels: string[];
  suppliers: string[];
  customers: string[];
  cashSources: string[];
  model: PlanModel;
  /** Model fields not yet established well enough for the acceptance condition. */
  gaps: FieldGap[];
  acceptance: 'ACCEPTED' | 'PROVISIONAL';
  acceptanceReasons: string[];
  confidence: PublishedConfidence;
  downside: Downside;
  modelled: { p10: number; p50: number; p90: number } | null;
  observedCollections: number;
  attempts: { researched: boolean; authorized: boolean; executed: boolean };
  capitalRequired: number | null;
  daysToCash: number | null;
  whyItWorks: string[];
  transfers: string[];
  /** What changes in customers, sources, channels, suppliers, budgets or market stop it transferring. */
  repeatability: string[];
  score: number;
}

export interface Collapse {
  kept: string;
  folded: string;
  why: 'PARAPHRASE' | 'SHARED_CUSTOMERS' | 'SHARED_CASH';
  detail: string;
}

export interface Resilience {
  kind: 'CHANNEL' | 'SUPPLIER';
  shared: string;
  /** Plans that fail with it. */
  fails: string[];
  /** Plans that remain alternatives when it fails. */
  survives: string[];
}

export interface PlanSet {
  amount: number;
  candidates: number;
  /** Distinct plans: the only count that is published. */
  distinct: number;
  accepted: number;
  provisional: number;
  plans: Plan[];
  collapses: Collapse[];
  /** Customers or cash two candidates would have counted twice. */
  doubleCounted: { kind: 'CUSTOMERS' | 'CASH'; key: string; candidates: string[] }[];
  resilience: Resilience[];
  attempts: { researched: number; authorized: number; executed: number };
  /**
   * Observed: money the ledger holds, once per plan. Modelled: ONE plan's median
   * (`modelledOf`), never a sum — the plans are alternatives to one another, and
   * adding their medians counted the same buyers and the same goal dozens of
   * times (production 2026-11-18: 82 alternatives summed to 38,735,256 on a
   * $10,000 goal). The leading plan's here; the reading puts the adopted
   * candidate's in its place (`composeGoalReadings`).
   */
  collections: { observed: number; modelledP50: number; modelledOf: string | null };
  confidence: PublishedConfidence;
  /** The goal's breadth requirement, when it states one, and whether accepted distinct plans meet it. */
  breadth: { required: number | null; met: boolean | null };
}

/* ------------------------------------------------------------------ */
/* Reading candidates from Brain's own computations                    */
/* ------------------------------------------------------------------ */

function fieldOf(f: PathFact | null | undefined, basis?: string): ModelField {
  if (!f) return { value: null, low: null, high: null, status: 'UNKNOWN', basis: basis ?? 'nothing records it' };
  const status: FieldStatus = f.status === 'DENIED' ? 'PROVEN' : f.status;
  return { value: f.value, low: f.low, high: f.high, status, basis: basis ? `${basis}: ${f.basis}` : f.basis };
}

function textOf(f: PathFact): string | null {
  return f.value === null ? null : String(f.value);
}

function weakest(...statuses: FieldStatus[]): FieldStatus {
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  if (statuses.includes('ESTIMATED')) return 'ESTIMATED';
  return 'PROVEN';
}

/**
 * A pathway's distinctness dimensions, read only from fields Brain computes —
 * never from the card's prose. A paraphrased offer or channel ("Monthly
 * bookkeeping for small firms" against "Small-business bookkeeping, monthly")
 * is one plan, and word-set comparison of free text could not tell it from a
 * different one: any changed word would count as a new mechanism. So:
 *
 *   * mechanism — who makes what is sold: Brain producing it with a named
 *     capability, an outside fulfiller Brain brokers, or nobody established yet;
 *   * channel — the acquisition method (`acquisitionOf`), an enumeration;
 *   * fulfilment — Brain's capability, or the kind of outside fulfiller;
 *   * risk — the correlation group the pathway already fails together with;
 *   * revenue — whether the deal repeats (`frequency`), not a sentence about it.
 *
 * Coarser than prose, deliberately: two plans that differ only in what the card
 * calls them are one plan, and the count can only be raised by a different
 * economic shape.
 */
export function pathwayDimensions(p: TransactionPathway): Record<DistinctnessDimension, string> {
  const fulfillerKind = p.producedBy ? `brain:${p.producedBy}` : p.fulfiller.value !== null && p.fulfiller.status !== 'UNKNOWN' ? 'external' : 'unestablished';
  const mechanism = p.producedBy ? `produce ${p.producedBy}` : fulfillerKind === 'external' ? 'broker' : 'unfulfilled';
  return {
    mechanism: `${p.origin.toLowerCase()} ${mechanism}`,
    channel: p.acquisition.method.toLowerCase(),
    fulfilment: fulfillerKind,
    risk: p.correlationGroup,
    revenue: isRecurring(p) ? 'recurring' : 'one-off',
  };
}

function isRecurring(p: TransactionPathway): boolean {
  const v = p.frequency.value;
  return v === 'repeats' || (typeof v === 'number' && v > 1);
}

/** A transaction pathway as a candidate plan. */
export function candidateFromPathway(p: TransactionPathway, extra: Partial<Pick<PlanCandidate, 'observedCollections' | 'enforceableCommitments' | 'attempts'>> = {}): PlanCandidate {
  const channel = textOf(p.channel) ?? p.acquisition.method;
  const fulfiller = textOf(p.fulfiller) ?? (p.producedBy ? `Brain: ${p.producedBy}` : 'unknown fulfiller');
  const buyer = textOf(p.buyer) ?? p.correlationGroup;
  const costs = weakest(fieldOf(p.acquisitionCost).status, fieldOf(p.fulfilmentCost).status);
  const evidenceStatus: FieldStatus = p.counts.unknown === 0 ? (p.counts.estimated === 0 ? 'PROVEN' : 'ESTIMATED') : 'UNKNOWN';
  const controls: ModelField =
    p.permissionsMissing.length > 0
      ? { value: p.permissionsMissing.join('; '), low: null, high: null, status: 'UNKNOWN', basis: 'permissions not yet granted' }
      : fieldOf(p.rights, 'rights');
  return {
    id: p.opportunityId,
    title: p.title,
    source: 'PATHWAY',
    opportunityIds: [p.opportunityId],
    dimensions: pathwayDimensions(p),
    customers: [buyer],
    cashSources: [buyer],
    channels: [channel],
    suppliers: p.producedBy ? [] : [fulfiller],
    model: {
      acquisitionRoute: fieldOf(p.channel, `${p.acquisition.method} (${p.acquisition.basis})`),
      fulfilmentRoute: fieldOf(p.fulfiller, p.producedBy ? `Brain produces it (${p.producedBy})` : 'fulfiller'),
      costs: {
        value: typeof p.acquisitionCost.value === 'number' && typeof p.fulfilmentCost.value === 'number' ? p.acquisitionCost.value + p.fulfilmentCost.value : null,
        low: null,
        high: null,
        status: costs,
        basis: `acquisition: ${p.acquisitionCost.basis}; fulfilment: ${p.fulfilmentCost.basis}`,
      },
      capital: fieldOf(p.capital),
      timing: fieldOf(p.daysToCash),
      controls,
      evidence: { value: `${p.counts.proven} proven, ${p.counts.estimated} estimated, ${p.counts.unknown} unknown`, low: null, high: null, status: evidenceStatus, basis: 'the pathway’s commercial facts' },
    },
    modelled: { p10: p.contribution.p10, p50: p.contribution.p50, p90: p.contribution.p90 },
    observedCollections: extra.observedCollections ?? 0,
    enforceableCommitments: extra.enforceableCommitments ?? 0,
    capitalRequired: typeof p.capital.value === 'number' ? p.capital.value : p.capital.high,
    daysToCash: typeof p.daysToCash.value === 'number' ? p.daysToCash.value : p.daysToCash.high,
    attempts: extra.attempts ?? { researched: true, authorized: p.permissionsMissing.length === 0 && p.executable, executed: false },
    whyItWorks: [textOf(p.motivation) ? `the buyer’s motivation: ${textOf(p.motivation)}` : null, p.producedBy ? `Brain fulfils it with ${p.producedBy}` : null].filter((s): s is string => s !== null),
    transfers: p.moves.map((m) => `${m.action.toLowerCase()}: ${m.construct}`).slice(0, 6),
    stopsTransferringWhen: p.notExecutable.slice(0, 6),
  };
}

/**
 * A scenario input of an arrangement as a plan field (W2b): PROVEN only for a
 * value evidence or this Brain's history states, ESTIMATED for a distribution
 * the evidence justifies (`inferred.justified`), and otherwise UNKNOWN — a
 * swept range or bounds-only inference is never shown as an estimate. Pure.
 */
export function fieldFromInput(input: ModelInput | null | undefined, what: string): ModelField | null {
  if (!input) return null;
  const evidenced = input.provenance === 'EVIDENCE' || input.provenance === 'HISTORICAL';
  if (evidenced && input.value !== null) return { value: input.value, low: input.value, high: input.value, status: 'PROVEN', basis: `${what}: ${input.note}`.slice(0, 400) };
  if (input.inferred?.justified) return { value: input.inferred.p50, low: input.inferred.p10, high: input.inferred.p90, status: 'ESTIMATED', basis: `${what}: ${input.note}`.slice(0, 400) };
  return null;
}

/**
 * A constructed arrangement as a candidate plan. Every part it has not
 * established stays UNKNOWN. `modelled` is the arrangement's own scenario
 * conversion (`estimatedFromArrangement` with the project's knowledge), so a
 * cost, capital, timing or way to the buyer that accepted evidence establishes
 * is read from it (W2b) rather than left unknown.
 */
export function candidateFromArrangement(a: ConstructedArrangement, modelled: ModelledOpportunity | null = null): PlanCandidate {
  const unknown = (what: string): ModelField => ({ value: null, low: null, high: null, status: 'UNKNOWN', basis: `${what} is not yet established for this construction` });
  const costs = fieldFromInput(modelled?.directCost, 'direct cost per deal');
  const capitalField = fieldFromInput(modelled?.capital, 'money tied up');
  const days = fieldFromInput(modelled?.daysToCash, 'days to usable cash');
  // The buyers are reached by outreach; the route counts as established only where their reply or agreement rate is evidenced.
  const reached = fieldFromInput(modelled?.respond, 'these buyers\' reply rate') ?? fieldFromInput(modelled?.close, 'these buyers\' agreement rate');
  const asNumber = (f: ModelField | null): number | null => (f === null ? null : typeof f.value === 'number' ? f.value : f.high);
  const known = (value: string, basis: string, evidenced: boolean): ModelField => ({ value, low: null, high: null, status: evidenced ? 'PROVEN' : 'ESTIMATED', basis });
  const buyer = a.demand.name;
  const supplier = a.supply?.name ?? null;
  const exposure = a.stress.exposure;
  return {
    id: a.key,
    title: a.label,
    source: 'ARRANGEMENT',
    // A construction is not an opening any calibration was measured on.
    opportunityIds: [],
    dimensions: {
      mechanism: `${a.design.base} ${a.design.funding}`,
      channel: a.design.aggregation,
      fulfilment: arrangementFulfilment(a),
      risk: `${exposure} ${a.sector ?? buyer}`,
      revenue: a.design.repeat,
    },
    customers: [buyer],
    cashSources: [buyer],
    channels: [],
    suppliers: supplier ? [supplier] : [],
    model: {
      acquisitionRoute: reached ? { ...reached, value: 'outreach to these buyers', basis: reached.basis } : unknown('how buyers are reached'),
      fulfilmentRoute: supplier ? known(supplier, `supply: ${a.supply?.from ?? 'unknown'}`, a.supply?.claimId !== null && a.supply?.claimId !== undefined) : known('Brain', 'Brain fulfils it', true),
      costs: costs ?? unknown('direct cost'),
      capital:
        a.stress.worstCaseCents !== null
          ? { value: a.stress.worstCaseCents / 100, low: null, high: a.stress.worstCaseCents / 100, status: 'ESTIMATED', basis: `worst case at risk (${exposure})` }
          : (capitalField ?? unknown('capital at risk')),
      timing: days ?? known(a.design.funding, 'when the buyer’s money moves, from the design', false),
      // No record states the rights a construction needs until a person grants them: nothing evidences this.
      controls: unknown('rights and controls'),
      evidence: { value: `${a.evidenced} evidenced part(s); unknown: ${a.unknownParts.join(', ') || 'none'}`, low: null, high: null, status: a.unknownParts.length > 0 ? 'UNKNOWN' : 'ESTIMATED', basis: 'the construction’s decomposition' },
    },
    modelled: a.value.p50 !== null && a.value.p10 !== null && a.value.p90 !== null ? { p10: a.value.p10, p50: a.value.p50, p90: a.value.p90 } : null,
    observedCollections: 0,
    enforceableCommitments: 0,
    capitalRequired: a.stress.worstCaseCents !== null ? a.stress.worstCaseCents / 100 : asNumber(capitalField),
    daysToCash: asNumber(days),
    attempts: { researched: a.unknownParts.length === 0, authorized: false, executed: false },
    whyItWorks: a.properties.map((p) => String(p)).slice(0, 6),
    transfers: a.precedent ? [`the design of ${a.precedent.title}, carried to a different buyer`] : [],
    stopsTransferringWhen: a.stress.failures.map((f) => f.effect).slice(0, 6),
  };
}

/**
 * An arrangement's fulfilment dimension, from the kind of its supply part and
 * never its name (production 2026-11-24: `supply.name` is a map node's or an
 * event-graph actor's free text, and a claim sentence filed as a supplier
 * reached the signature as "fulfilment=ad agency broadcaster committee
 * company …"). The vocabulary is `pathwayDimensions`', so an arrangement and
 * an opening with the same economic shape compare as one: Brain's own
 * capability (or no supply, which the arrangement reads as Brain fulfilling
 * it), an outside supplier a gated claim establishes, or one nothing has
 * established yet. Pure.
 */
export function arrangementFulfilment(a: Pick<ConstructedArrangement, 'supply'>): string {
  const supply = a.supply;
  if (!supply || supply.from === 'CAPABILITY') return 'brain';
  return supply.claimId ? 'external' : 'unestablished';
}

/**
 * A strategy reading of the reconstruction as a candidate plan: its members'
 * pathways, combined. Its dimensions are the union of its members' — a reading
 * whose members are one pathway is that pathway's plan, and collapses into it.
 */
export function candidateFromStrategy(r: VariantReading, pathways: ReadonlyMap<string, PlanCandidate>): PlanCandidate | null {
  const members = r.members.map((m) => pathways.get(m)).filter((c): c is PlanCandidate => c !== undefined);
  if (members.length === 0) return null;
  const union = (pick: (c: PlanCandidate) => string[]): string[] => [...new Set(members.flatMap(pick))];
  const dims = {} as Record<DistinctnessDimension, string>;
  for (const d of DISTINCTNESS_DIMENSIONS) dims[d] = [...new Set(members.map((m) => m.dimensions[d]))].sort().join(' + ');
  const model = {} as PlanModel;
  for (const f of MODEL_FIELDS) {
    const fields = members.map((m) => m.model[f]);
    model[f] = { value: fields.map((x) => x.value).filter((v) => v !== null).join('; ') || null, low: null, high: null, status: weakest(...fields.map((x) => x.status)), basis: `members: ${fields.map((x) => x.basis).join(' | ')}`.slice(0, 400) };
  }
  if (r.changes.length > 0) {
    const assumed = r.changes.some((c) => c.basis === 'ASSUMPTION');
    model.controls = { ...model.controls, status: assumed ? 'UNKNOWN' : model.controls.status, basis: `${model.controls.basis}; strategy changes: ${r.changes.map((c) => `${c.label} (${c.basis})`).join(', ')}`.slice(0, 400) };
  }
  return {
    id: `strategy:${r.key}`,
    title: `Strategy ${r.key}`,
    source: 'STRATEGY',
    opportunityIds: union((c) => c.opportunityIds),
    dimensions: dims,
    customers: union((c) => c.customers),
    cashSources: union((c) => c.cashSources),
    channels: union((c) => c.channels),
    suppliers: union((c) => c.suppliers),
    model,
    modelled: { p10: r.settledP10, p50: r.settledP50, p90: r.settledP90 },
    observedCollections: members.reduce((s, m) => s + m.observedCollections, 0),
    enforceableCommitments: members.reduce((s, m) => s + m.enforceableCommitments, 0),
    capitalRequired: r.committed,
    daysToCash: members.reduce<number | null>((a, m) => (m.daysToCash === null ? a : a === null ? m.daysToCash : Math.min(a, m.daysToCash)), null),
    attempts: { researched: members.every((m) => m.attempts.researched), authorized: members.every((m) => m.attempts.authorized), executed: members.every((m) => m.attempts.executed) },
    whyItWorks: union((c) => c.whyItWorks),
    transfers: union((c) => c.transfers),
    stopsTransferringWhen: [...union((c) => c.stopsTransferringWhen), ...(r.why ? [r.why] : []), ...(r.implausible ?? []).map((f) => `${f.kind}: ${f.detail}`)],
  };
}

/* ------------------------------------------------------------------ */
/* Distinctness                                                        */
/* ------------------------------------------------------------------ */

const FILLER = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'via', 'by', 'with', 'from', 'in', 'on', 'at', 'our', 'their', 'its', 'we', 'they', 'service', 'services', 'offer', 'offering', 'plan', 'based']);

/** Canonical form of one dimension: case, punctuation, word order, filler and plural endings removed. */
export function canonical(text: string): string {
  const hit = canonicalMemo.get(text);
  if (hit !== undefined) return hit;
  const value = readCanonical(text);
  if (canonicalMemo.size >= CANONICAL_MEMO_MAX) canonicalMemo.clear();
  canonicalMemo.set(text, value);
  return value;
}

/**
 * `buildPlanSet` compares every candidate with every group, and each
 * comparison re-canonicalised the same few thousand phrases (W15, production
 * 2026-11-17: `canonical` and `overlap` were the heaviest planner frames in
 * 10–20 s event-loop stalls). Canonical form is pure in its text, so each
 * phrase is read once; the table is bounded and emptied when full.
 */
const CANONICAL_MEMO_MAX = 16_384;
const canonicalMemo = new Map<string, string>();

function readCanonical(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER.has(w))
    .map((w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(' ');
}

export function signatureOf(dimensions: Record<DistinctnessDimension, string>): string {
  return DISTINCTNESS_DIMENSIONS.map((d) => `${d}=${canonical(dimensions[d])}`).join('|');
}

/** The dimensions on which two candidates differ; empty means one plan in two wordings. */
export function differingDimensions(a: Record<DistinctnessDimension, string>, b: Record<DistinctnessDimension, string>): DistinctnessDimension[] {
  return DISTINCTNESS_DIMENSIONS.filter((d) => canonical(a[d]) !== canonical(b[d]));
}

/* ------------------------------------------------------------------ */
/* Confidence, acceptance and the downside                             */
/* ------------------------------------------------------------------ */

/**
 * The modelled share of outcomes at or above `amount`, read off p10/p50/p90 by
 * linear interpolation between them. Outside p10–p90 the model says no more
 * than "below 10%" or "above 90%", and so does this: it returns the bound.
 */
export function modelledShareReaching(m: { p10: number; p50: number; p90: number }, amount: number): number {
  if (amount <= m.p10) return 0.9;
  if (amount > m.p90) return 0.1;
  if (amount <= m.p50) return m.p50 === m.p10 ? 0.5 : 0.9 - 0.4 * ((amount - m.p10) / (m.p50 - m.p10));
  return m.p90 === m.p50 ? 0.1 : 0.5 - 0.4 * ((amount - m.p50) / (m.p90 - m.p50));
}

export function publishedConfidence(modelled: { p10: number; p50: number; p90: number } | null, amount: number, calibration: Calibration | null): PublishedConfidence {
  if (!modelled) return { value: null, withheld: true, reason: 'no modelled distribution of outcomes' };
  if (!calibration || !calibration.calibrated) {
    return { value: null, withheld: true, reason: `withheld: the model is not calibrated against resolved outcomes${calibration ? ` (${calibration.observations} observation(s); ${calibration.basis})` : ''}` };
  }
  return { value: modelledShareReaching(modelled, amount), withheld: false, reason: `calibrated on ${calibration.observations} resolved outcome(s): ${calibration.basis}` };
}

function downsideOf(c: { modelled: PlanCandidate['modelled']; enforceableCommitments: number }, amount: number): Downside {
  return {
    adverse: c.modelled?.p10 ?? null,
    floor: c.enforceableCommitments,
    floorBasis:
      c.enforceableCommitments > 0
        ? 'enforceable commitments only (signed, escrowed or guaranteed); correlated or systemic risk can still reach them'
        : 'no enforceable commitment: the plan has no guaranteed floor, and its adverse reading is not one',
    overTarget: { expected: c.modelled ? c.modelled.p50 - amount : null, upper: c.modelled ? c.modelled.p90 - amount : null },
  };
}

function acceptanceOf(c: PlanCandidate, condition: AcceptanceCondition, calibration: Calibration | null): { status: 'ACCEPTED' | 'PROVISIONAL'; reasons: string[]; gaps: FieldGap[] } {
  const required = condition.requiredFields ?? MODEL_FIELDS;
  const gaps: FieldGap[] = required.filter((f) => c.model[f].status === 'UNKNOWN').map((f) => ({ field: f, status: c.model[f].status, basis: c.model[f].basis }));
  const reasons: string[] = [];
  if (gaps.length > 0) reasons.push(`unestablished: ${gaps.map((g) => g.field).join(', ')}`);
  if (!c.modelled) reasons.push('no modelled outcome');
  else if (condition.confidence !== null) {
    if (!calibration?.calibrated) reasons.push(`the goal asks for ${Math.round(condition.confidence * 100)}% and the model is not calibrated, so no probability can be claimed`);
    else if (modelledShareReaching(c.modelled, condition.amount) < condition.confidence)
      reasons.push(`modelled share reaching ${condition.amount} is ${Math.round(modelledShareReaching(c.modelled, condition.amount) * 100)}%, below the ${Math.round(condition.confidence * 100)}% the goal asks`);
  } else if (c.modelled.p10 < condition.amount) reasons.push(`the adverse reading (${Math.round(c.modelled.p10)}) is below ${condition.amount}`);
  if (condition.daysLeft !== null && (c.daysToCash === null || c.daysToCash > condition.daysLeft))
    reasons.push(c.daysToCash === null ? 'settlement timing is unknown' : `cash settles in ${c.daysToCash} days, after the ${condition.daysLeft} left`);
  if (condition.capitalCeiling !== null && (c.capitalRequired === null || c.capitalRequired > condition.capitalCeiling))
    reasons.push(c.capitalRequired === null ? 'capital required is unknown' : `needs ${c.capitalRequired}, above the ${condition.capitalCeiling} ceiling`);
  return { status: reasons.length === 0 ? 'ACCEPTED' : 'PROVISIONAL', reasons, gaps };
}

function repeatabilityOf(c: PlanCandidate): string[] {
  const out = [
    ...c.channels.map((ch) => `the channel “${ch}” stops reaching buyers`),
    ...c.suppliers.map((s) => `the supplier “${s}” stops delivering or changes terms`),
    ...c.customers.map((cu) => `the customer pool “${cu}” is exhausted or its need changes`),
    ...(c.capitalRequired !== null ? [`the budget falls below ${c.capitalRequired}`] : ['the capital it needs is unknown, so a budget change cannot be judged']),
  ];
  if (c.observedCollections > 0) out.push('a past collection does not prove the same conversion again: it is re-measured on the next attempt');
  else out.push('its conversion is modelled, not observed');
  return [...new Set([...out, ...c.stopsTransferringWhen])];
}

function scoreOf(c: PlanCandidate, amount: number, objective: PlanObjective | undefined): number {
  if (!c.modelled) return 0;
  const o = objective ?? { expected: 1 };
  const velocity = c.daysToCash !== null ? 1 / (1 + c.daysToCash) : 0;
  const independence = 1 / (1 + c.channels.length + c.suppliers.length);
  return (
    (o.expected ?? 0) * (c.modelled.p50 / Math.max(amount, 1)) +
    (o.upside ?? 0) * (c.modelled.p90 / Math.max(amount, 1)) +
    (o.downside ?? 0) * (c.modelled.p10 / Math.max(amount, 1)) +
    (o.velocity ?? 0) * velocity +
    (o.independence ?? 0) * independence
  );
}

/* ------------------------------------------------------------------ */
/* Building the set                                                    */
/* ------------------------------------------------------------------ */

/** The first of `b` whose canonical form is in `a`'s canonical set. */
function overlap(a: ReadonlySet<string>, b: string[]): string | null {
  for (const x of b) if (a.has(canonical(x))) return x;
  return null;
}

/** The richer of two candidates leads a merged plan: more established fields, then more modelled value. */
function richness(c: PlanCandidate): number {
  const established = MODEL_FIELDS.filter((f) => c.model[f].status !== 'UNKNOWN').length;
  return established * 1e9 + (c.modelled?.p50 ?? 0);
}

export function buildPlanSet(candidates: readonly PlanCandidate[], condition: AcceptanceCondition, calibration: Calibration | null = null): PlanSet {
  const ordered = [...candidates].sort((a, b) => richness(b) - richness(a) || a.id.localeCompare(b.id));
  const groups: { lead: PlanCandidate; members: PlanCandidate[] }[] = [];
  const collapses: Collapse[] = [];
  const doubleCounted: PlanSet['doubleCounted'] = [];
  // Each candidate's signature once, not once per group it is compared with (W15).
  const signatures = new Map(ordered.map((c) => [c, signatureOf(c.dimensions)]));
  // And each member's customer and cash sets once, not once per later candidate.
  const customerSets = new Map(ordered.map((c) => [c, new Set(c.customers.map(canonical))]));
  const cashSets = new Map(ordered.map((c) => [c, new Set(c.cashSources.map(canonical))]));
  for (const c of ordered) {
    let joined = false;
    const signature = signatures.get(c)!;
    for (const g of groups) {
      if (signatures.get(g.lead) === signature) {
        collapses.push({ kept: g.lead.id, folded: c.id, why: 'PARAPHRASE', detail: 'equal on mechanism, channel, fulfilment, risk and revenue' });
      } else {
        const customers = g.members.map((m) => overlap(customerSets.get(m)!, c.customers)).find((x) => x !== null) ?? null;
        const cash = customers ? null : (g.members.map((m) => overlap(cashSets.get(m)!, c.cashSources)).find((x) => x !== null) ?? null);
        if (!customers && !cash) continue;
        const kind = customers ? 'CUSTOMERS' : 'CASH';
        const key = (customers ?? cash) as string;
        const existing = doubleCounted.find((d) => d.kind === kind && canonical(d.key) === canonical(key));
        if (existing) existing.candidates.push(c.id);
        else doubleCounted.push({ kind, key, candidates: [...g.members.map((m) => m.id), c.id] });
        collapses.push({ kept: g.lead.id, folded: c.id, why: customers ? 'SHARED_CUSTOMERS' : 'SHARED_CASH', detail: `both would count “${key}”` });
      }
      g.members.push(c);
      joined = true;
      break;
    }
    if (!joined) groups.push({ lead: c, members: [c] });
  }

  const plans: Plan[] = groups.map(({ lead, members }) => {
    const own = calibrationFor(lead, calibration);
    const acc = acceptanceOf(lead, condition, own);
    const union = (pick: (c: PlanCandidate) => string[]): string[] => [...new Set(members.flatMap(pick))];
    return {
      id: lead.id,
      members: members.map((m) => m.id),
      title: lead.title,
      source: lead.source,
      dimensions: lead.dimensions,
      signature: signatureOf(lead.dimensions),
      channels: union((m) => m.channels),
      suppliers: union((m) => m.suppliers),
      customers: union((m) => m.customers),
      cashSources: union((m) => m.cashSources),
      model: lead.model,
      gaps: acc.gaps,
      acceptance: acc.status,
      acceptanceReasons: acc.reasons,
      confidence: publishedConfidence(lead.modelled, condition.amount, own),
      downside: downsideOf(lead, condition.amount),
      modelled: lead.modelled,
      // Cash and customers are counted once per plan: the lead's figures, never a sum of folded members.
      observedCollections: Math.max(...members.map((m) => m.observedCollections)),
      attempts: { researched: members.some((m) => m.attempts.researched), authorized: members.some((m) => m.attempts.authorized), executed: members.some((m) => m.attempts.executed) },
      capitalRequired: lead.capitalRequired,
      daysToCash: lead.daysToCash,
      whyItWorks: union((m) => m.whyItWorks),
      transfers: union((m) => m.transfers),
      repeatability: repeatabilityOf(lead),
      score: scoreOf(lead, condition.amount, condition.objective),
    };
  });
  plans.sort((a, b) => (a.acceptance === b.acceptance ? 0 : a.acceptance === 'ACCEPTED' ? -1 : 1) || b.score - a.score || a.id.localeCompare(b.id));

  const accepted = plans.filter((p) => p.acceptance === 'ACCEPTED').length;
  const required = condition.breadth ?? null;
  // The plans are alternatives: the set's modelled median is its leading modelled plan's, never their sum.
  const leading = plans.find((p) => p.modelled !== null) ?? null;
  const modelledP50 = leading?.modelled?.p50 ?? 0;
  return {
    amount: condition.amount,
    candidates: candidates.length,
    distinct: plans.length,
    accepted,
    provisional: plans.length - accepted,
    plans,
    collapses,
    doubleCounted,
    resilience: resilienceOf(plans),
    attempts: {
      researched: plans.filter((p) => p.attempts.researched).length,
      authorized: plans.filter((p) => p.attempts.authorized).length,
      executed: plans.filter((p) => p.attempts.executed).length,
    },
    collections: { observed: plans.reduce((s, p) => s + p.observedCollections, 0), modelledP50, modelledOf: leading?.id ?? null },
    confidence: calibration?.calibrated
      ? { value: null, withheld: true, reason: 'a set-level probability needs the plans’ joint distribution; read each plan’s own' }
      : { value: null, withheld: true, reason: 'withheld: the model is not calibrated against resolved outcomes' },
    breadth: { required, met: required === null ? null : accepted >= required },
  };
}

/** For each channel or supplier more than one plan depends on, which plans fail with it and which remain. */
export function resilienceOf(plans: readonly Plan[]): Resilience[] {
  const out: Resilience[] = [];
  for (const kind of ['CHANNEL', 'SUPPLIER'] as const) {
    const by = new Map<string, { label: string; ids: Set<string> }>();
    for (const p of plans) for (const x of kind === 'CHANNEL' ? p.channels : p.suppliers) {
      const k = canonical(x);
      const entry = by.get(k) ?? { label: x, ids: new Set<string>() };
      entry.ids.add(p.id);
      by.set(k, entry);
    }
    for (const { label, ids } of by.values()) {
      if (ids.size < 2) continue;
      out.push({ kind, shared: label, fails: [...ids], survives: plans.filter((p) => !ids.has(p.id)).map((p) => p.id) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rebuilding after a change                                           */
/* ------------------------------------------------------------------ */

export type PlanChange =
  | { kind: 'CHANNEL_FAILED'; channel: string }
  | { kind: 'SUPPLIER_FAILED'; supplier: string }
  | { kind: 'CUSTOMERS_LOST'; customers: string }
  | { kind: 'BUDGET_CUT'; budget: number };

export interface Rebuild {
  change: PlanChange;
  surviving: Plan[];
  removed: { id: string; why: string }[];
  /**
   * Alternatives rebuilt from a removed plan: the failed part swapped for one a
   * surviving plan already uses. The swapped part's economics are unknown for
   * this plan, so each starts PROVISIONAL until research establishes it.
   */
  reconstructed: Plan[];
  set: PlanSet;
}

function hits(list: string[], name: string): boolean {
  return list.some((x) => canonical(x) === canonical(name));
}

/**
 * Recompute the alternatives after a named change. Plans the change breaks are
 * removed; for a failed channel or supplier each removed plan is rebuilt on a
 * channel or supplier a surviving plan already has, with that part UNKNOWN.
 * A budget cut or a lost customer pool rebuilds nothing it cannot justify.
 */
export function rebuildAfter(candidates: readonly PlanCandidate[], change: PlanChange, condition: AcceptanceCondition, calibration: Calibration | null = null): Rebuild {
  const removed: { id: string; why: string }[] = [];
  const kept: PlanCandidate[] = [];
  const broken: PlanCandidate[] = [];
  for (const c of candidates) {
    const why =
      change.kind === 'CHANNEL_FAILED' && hits(c.channels, change.channel)
        ? `depends on the failed channel “${change.channel}”`
        : change.kind === 'SUPPLIER_FAILED' && hits(c.suppliers, change.supplier)
          ? `depends on the failed supplier “${change.supplier}”`
          : change.kind === 'CUSTOMERS_LOST' && hits(c.customers, change.customers)
            ? `sells to the lost customer pool “${change.customers}”`
            : change.kind === 'BUDGET_CUT' && (c.capitalRequired === null || c.capitalRequired > change.budget)
              ? c.capitalRequired === null
                ? `capital required is unknown against a budget of ${change.budget}`
                : `needs ${c.capitalRequired}, above the new budget of ${change.budget}`
              : null;
    if (why) {
      removed.push({ id: c.id, why });
      broken.push(c);
    } else kept.push(c);
  }

  const rebuilt: PlanCandidate[] = [];
  if (change.kind === 'CHANNEL_FAILED' || change.kind === 'SUPPLIER_FAILED') {
    const isChannel = change.kind === 'CHANNEL_FAILED';
    const failed = isChannel ? change.channel : change.supplier;
    const pool = [...new Set(kept.flatMap((c) => (isChannel ? c.channels : c.suppliers)))].filter((x) => canonical(x) !== canonical(failed));
    for (const c of broken) {
      const replacement = pool.find((x) => !hits(isChannel ? c.channels : c.suppliers, x));
      if (!replacement) continue;
      const field: ModelFieldKey = isChannel ? 'acquisitionRoute' : 'fulfilmentRoute';
      const swap = (list: string[]) => [...list.filter((x) => canonical(x) !== canonical(failed)), replacement];
      rebuilt.push({
        ...c,
        id: `${c.id}~${canonical(replacement).replace(/\s+/g, '-')}`,
        title: `${c.title} — rebuilt on ${replacement}`,
        source: 'RECONSTRUCTED',
        // Its swapped part was never measured, so no calibration of the original reaches it.
        opportunityIds: [],
        dimensions: { ...c.dimensions, [isChannel ? 'channel' : 'fulfilment']: replacement },
        channels: isChannel ? swap(c.channels) : c.channels,
        suppliers: isChannel ? c.suppliers : swap(c.suppliers),
        model: { ...c.model, [field]: { value: replacement, low: null, high: null, status: 'UNKNOWN', basis: `rebuilt after “${failed}” failed; ${replacement} is unproven for this plan` } },
        attempts: { researched: false, authorized: false, executed: false },
        observedCollections: 0,
        stopsTransferringWhen: [...c.stopsTransferringWhen, `rebuilt on ${replacement}: its economics for this buyer are not established`],
      });
    }
  }

  const set = buildPlanSet([...kept, ...rebuilt], condition, calibration);
  const rebuiltIds = new Set(rebuilt.map((r) => r.id));
  return {
    change,
    surviving: set.plans.filter((p) => !rebuiltIds.has(p.id)),
    removed,
    reconstructed: set.plans.filter((p) => rebuiltIds.has(p.id)),
    set,
  };
}

/** A few lines a person reads: the count that is published, and why it is not larger. */
export function renderPlanSet(s: PlanSet): string[] {
  const lines = [
    `${s.distinct} distinct plan(s) from ${s.candidates} candidate(s): ${s.accepted} accepted, ${s.provisional} provisional.`,
    `Attempts — researched ${s.attempts.researched}, authorized ${s.attempts.authorized}, executed ${s.attempts.executed}. Collections — observed ${Math.round(s.collections.observed)}, modelled median ${Math.round(s.collections.modelledP50)}.`,
    `Confidence: ${s.confidence.withheld ? s.confidence.reason : String(s.confidence.value)}.`,
  ];
  for (const c of s.collapses.slice(0, 5)) lines.push(`Folded ${c.folded} into ${c.kept} (${c.why}): ${c.detail}.`);
  for (const r of s.resilience.slice(0, 5)) lines.push(`If ${r.kind.toLowerCase()} “${r.shared}” fails: ${r.fails.length} fail, ${r.survives.length} remain.`);
  if (s.breadth.required !== null) lines.push(`Breadth asked: ${s.breadth.required} accepted distinct plan(s) — ${s.breadth.met ? 'met' : 'not met'}.`);
  return lines;
}
