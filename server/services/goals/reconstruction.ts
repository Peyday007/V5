/**
 * The reconstruction loop (§99): when a goal's plan falls short of its
 * required probability, find out why, and build substantially different plans
 * instead of re-reading the same one.
 *
 * Production, 2026-11-09 (Goals plan 42692716368): the $10K plan read 2.6%
 * coverage and Brain's only response was "find more openings". Nothing asked
 * which assumption held the plan down — fixed sending capacity, cold email as
 * the only way in, unit prices as listed, cash as slow as listed — and nothing
 * weighed spending the $3,000 the owner had set aside on what was binding.
 *
 * The loop is pure and reuses the one engine every plan already uses
 * (`evaluateGoalPortfolio`, over the same openings, limits and correlation):
 *
 *   1. Diagnose. Move each kind of input to the favourable end of what is
 *      known about it, one at a time, and measure what the plan gains. The
 *      factor that gains most is binding; if moving every factor at once
 *      still cannot reach the requirement, the limitation is structural — the
 *      openings, channel or model must change, not the estimates.
 *   2. Challenge. Each implicit assumption of the plan is named with its
 *      evidence status, and the dimension that tests it.
 *   3. Construct. Generic operators change one dimension each: buy sending
 *      capacity, buy inbound demand, sell through a marketplace or partner,
 *      reshape the transaction (bundle, retainer, implementation fee), ask for
 *      a deposit. Operators come from the cost evidence (`acquisitionLevers.ts`)
 *      and the plan's own openings — never from a list of businesses.
 *   4. Evaluate and combine. Every variant goes through the same engine.
 *      Variants that improve the plan materially are combined greedily, across
 *      dimensions, while the combination still improves materially and still
 *      fits the money limits. Each combination is evaluated once.
 *   5. Conclude. The strongest plan, what binds it still, what is measured,
 *      what is assumed, and whether its reach is a probability or coverage.
 *      What the world must supply for the next step becomes the search brief
 *      the goal's next discovery round is asked (§89).
 *
 * The loop stops when no change improves the plan materially, not after a
 * fixed number of rounds: the operators are finite and each combination is
 * evaluated once. It never relabels coverage as probability, and an assumed
 * input stays assumed however good the number it produces.
 */
import type { ModelInput, ModelledOpportunity } from '../cash/goalScenario.ts';
import { evaluateGoalPortfolio, type GateInput, type GoalPortfolio, type PlannedOpening } from './portfolio.ts';
import { ACQUISITION_LEVERS, DAYS_TO_FIRST_PROOF, PARTNER_TERMS, budgetsAllowed, purchaseCapacity, buyInbound, dailyVolumePlan, type AcquisitionLever, type VolumePlan } from './acquisitionLevers.ts';
import { CONVERSION_BOUNDS, MATERIAL_SHARE, SHAPE_MULTIPLES } from './pathways.ts';
import { createHash } from 'node:crypto';
import { sharedEvaluator, type Evaluator } from './reasoning/evaluatorPool.ts';
import { applyProgram, exploreDirections, programOf, renderExploration, repriceOpening, PRICE_ELASTICITY, type ExploreContext, type Exploration, type Transform } from './reasoning/directions.ts';
import { sweepVariables, type VariableSweep } from './reasoning/variables.ts';

/** A change smaller than this, in reach and in median settled cash, is not an improvement. */
export const MATERIAL_REACH = 0.02;
export const MATERIAL_P50 = 0.1;
/**
 * Worlds per screened variant; the strongest is read again at the plan's own
 * count. An evaluation's cost grows with worlds × openings, so screening holds
 * that product near SCREEN_WORK: a plan of a dozen openings screens at about
 * 600 worlds, one of forty at about 200 (never fewer than SCREEN_MIN_WORLDS).
 */
export const SCREEN_WORLDS = 600;
export const SCREEN_WORK = 7_200;
export const SCREEN_MIN_WORLDS = 150;
/**
 * The plausibility critic (C-4). A reading is IMPLAUSIBLE — kept and shown,
 * never the plan Brain concludes with — when any of these is broken:
 *   RETURN: its median settled cash is more than RETURN_BOUND times the money
 *     behind it (what it commits plus the goal's capital ceiling). No record
 *     Brain holds turns a month's money twentyfold, and the production reading
 *     of 2026-11-14 read $34.5M on $3K.
 *   DEALS: its median deals exceed DEAL_CAPACITY_MULTIPLE times the
 *     opportunities Brain's whole measured outreach record produced (at least
 *     one): the record measured 2 opportunities from 4,096 sends.
 *   MARKET: its median deals exceed every market it sells into, at the top of
 *     their ranges.
 *   HEADROOM: it reaches the target more often than every estimate at its
 *     favourable end does (with HEADROOM_SLACK for sampling): a contradiction.
 */
export const RETURN_BOUND = 20;
export const DEAL_CAPACITY_MULTIPLE = 25;
export const HEADROOM_SLACK = 0.02;
/** Change dimensions that create reach the headroom reading never measured. */
const HEADROOM_EXEMPT: ReadonlySet<string> = new Set(['ACQUISITION', 'PARTNER', 'CAPACITY', 'TRANSACTION', 'CAPITAL']);
/** A deposit at signing collects this share of the price: an assumption until a buyer agrees to it. */
export const DEPOSIT_SHARE = { low: 0.3, high: 0.5 } as const;

export type Dimension = 'EVIDENCE' | 'CAPACITY' | 'ACQUISITION' | 'PARTNER' | 'TRANSACTION' | 'CASH_TIMING' | 'CAPITAL' | 'MARKET' | 'PRICE' | 'PORTFOLIO';
export type Basis = 'MEASURED' | 'ESTIMATE' | 'ASSUMPTION';

export interface StrategyChange {
  dimension: Dimension;
  label: string;
  detail: string;
  /** Money it commits before any opening pays (major units). */
  cost: number;
  basis: Basis;
  /** The day it takes effect: the order in which a reconstructed plan is executed. */
  startDay?: { low: number; high: number };
  /** The operator that wrote it, so a plan can be rebuilt move by move. */
  op?: string;
  /** The budget its operator was given (capacity and acquisition): the family keeps the larger. */
  budget?: number;
  /** Bought only after proof, in weekly tranches: its cost is paid only in worlds where proof arrives (§99 Q-7). */
  afterProof?: boolean;
  /** The gate it is bought through, when after proof. */
  gate?: string;
  /** The opening it added (a channel or partner clone). */
  clone?: string;
  /** Outreach a day it adds, averaged over the window. */
  contacts?: { low: number; high: number };
}

/** One plausibility finding on a reading (C-4). */
export interface PlausibilityFlag {
  kind: 'RETURN' | 'DEALS' | 'MARKET' | 'HEADROOM';
  detail: string;
}

export interface VariantReading {
  key: string;
  changes: StrategyChange[];
  reach: number;
  settledP10: number;
  settledP50: number;
  settledP90: number;
  basis: 'PROBABILITY' | 'COVERAGE';
  committed: number;
  feasible: boolean;
  why: string | null;
  members: string[];
  /** Worlds it was read over: the sample its reach's interval is read from. */
  worlds?: number;
  /** Median cash kept (settled less direct costs and what was committed). */
  keptP50?: number;
  /** Median deals closed. */
  dealsP50?: number;
  /** What the plausibility critic found; a flagged reading never becomes the plan (C-4). */
  implausible?: PlausibilityFlag[];
}

export type Factor = 'VOLUME' | 'REPLY' | 'CLOSE' | 'PRICE' | 'CASH_TIMING' | 'MARKET_SIZE' | 'CAPITAL';

export interface FactorTest {
  factor: Factor;
  /** What was moved, in words. */
  moved: string;
  reach: number;
  settledP50: number;
  liftReach: number;
  liftP50: number;
}

export interface AssumptionChallenge {
  assumption: string;
  status: Basis | 'UNTESTED';
  testedBy: Dimension;
  finding: string;
}

export interface Reconstruction {
  required: number;
  baseline: VariantReading;
  diagnosis: FactorTest[];
  /** Every factor at its favourable end at once: the most the openings held can do. */
  headroom: { reach: number; settledP50: number };
  structural: boolean;
  challenges: AssumptionChallenge[];
  /** Every variant evaluated, in the order it was evaluated, round by round. */
  rounds: Array<{ round: number; tried: VariantReading[]; kept: string | null }>;
  best: VariantReading;
  /** The strongest plan if the new implementation performs no better than the measured record (§99 as-is floor). */
  floor: VariantReading | null;
  /** The reply rate every outreach opening must reach for the strongest plan to meet the requirement; null if none does. */
  requiredReply: number | null;
  /** The question the user asked of capacity: what a daily volume would cost and whether it could run. */
  volumePlans: VolumePlan[];
  /** What still binds the strongest plan, and what would have to be true to reach the requirement. */
  limitation: string | null;
  /** Separates what is measured from what is assumed, and says what the reach is. */
  confidence: { basis: 'PROBABILITY' | 'COVERAGE'; measured: string[]; assumed: string[]; statement: string };
  /** What the next discovery round is asked for, from the binding constraint. */
  searchBrief: string;
  evaluations: number;
  /** The multidirectional exploration that ran over this plan (§101); null when it did not run. */
  exploration?: Exploration | null;
  /** Readings the plausibility critic flagged, by key: kept and shown, never the plan concluded with (C-4, Q-9). */
  flags: Array<{ key: string; reach: number; settledP50: number; flags: PlausibilityFlag[] }>;
}

export interface ReconstructionInput {
  openings: ModelledOpportunity[];
  portfolio: Omit<Parameters<typeof evaluateGoalPortfolio>[0], 'openings'>;
  baseline: GoalPortfolio;
  required: number;
  levers?: readonly AcquisitionLever[];
  /** Daily volumes to cost explicitly (the owner asked about 10,000 a day). */
  volumeQuestions?: number[];
  worlds?: number;
  /** Where evaluations run (§101): a pool of threads, or inline when omitted. */
  evaluator?: Evaluator;
  /** The multidirectional exploration's inputs (library, model, time); null turns it off. */
  explore?: (Pick<ExploreContext, 'library' | 'invent' | 'maxMs'> & { sweepMs?: number; maxVariations?: number }) | null;
}

/** A strategy state the operators transform. */
export interface StrategyState {
  openings: PlannedOpening[];
  contactsPerDay?: ModelInput;
  committed: number;
  changes: StrategyChange[];
  /** The moves that built it from the plan as held, in order: the as-is floor rebuilds it without the assumed ones. */
  program?: Transform[];
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function scale(input: ModelInput, k: number, cap = Infinity): ModelInput {
  const f = (x: number | null) => (x === null ? null : Math.min(cap, x * k));
  return { ...input, value: f(input.value), low: f(input.low), high: f(input.high), distribution: undefined, inferred: undefined };
}
function favourable(input: ModelInput, dir: 'HIGH' | 'LOW', k: number, cap = Infinity): ModelInput {
  // The favourable end of what is known; a fixed figure is multiplied, an assumption at most.
  const top = dir === 'HIGH' ? (input.high ?? input.inferred?.p90 ?? input.value) : (input.low ?? input.inferred?.p10 ?? input.value);
  if (top === null || top === undefined) return input;
  const v = input.value !== null && input.value === top ? (dir === 'HIGH' ? Math.min(cap, top * k) : top / k) : top;
  return { ...input, value: v, low: v, high: v, distribution: undefined, inferred: undefined };
}

function sellsThroughOutreach(one: ModelledOpportunity): boolean {
  return one.repeatable && one.agreedValue === 0 && !one.channel;
}

function knownMid(input: ModelInput): number | null {
  if (input.value !== null) return input.value;
  if (input.inferred) return input.inferred.p50;
  if (input.low !== null && input.high !== null) return (input.low + input.high) / 2;
  return input.low ?? input.high ?? null;
}

/**
 * The openings a reconstruction can move: every member of a combination the
 * engine ranked, and every repeatable opening it did not refuse. A one-off the
 * engine left out of every combination cannot be moved by capacity, reply rate,
 * channel or financing, so re-evaluating it on every variant is cost without
 * information (production test, 2026-11-09: 40 one-offs took a plan read from 5 s to 23 s).
 */
export function movableOpenings(openings: ModelledOpportunity[], baseline: GoalPortfolio): ModelledOpportunity[] {
  const ranked = new Set([...(baseline.best?.members ?? []), ...baseline.alternatives.flatMap((a) => a.members)].map((m) => m.opportunityId));
  const refused = new Set(baseline.demand.filter((d) => d.refused).map((d) => d.opportunityId));
  return openings.filter((o) => ranked.has(o.opportunity.id) || (o.repeatable && o.agreedValue === 0 && !refused.has(o.opportunity.id)));
}

/**
 * Reconstruct a plan. With no evaluator given it borrows the process's shared
 * pool (§109): the inline default ran every engine evaluation on the caller's
 * own loop, one unbroken slice each, which is the stall class the pool exists
 * to remove.
 */
export async function reconstructPlan(input: ReconstructionInput): Promise<Reconstruction> {
  if (input.evaluator) return reconstructPlanOn(input, input.evaluator);
  const evaluator = sharedEvaluator();
  try {
    return await reconstructPlanOn(input, evaluator);
  } finally {
    await evaluator.close();
  }
}

async function reconstructPlanOn(input: ReconstructionInput, evaluator: Evaluator): Promise<Reconstruction> {
  input = { ...input, openings: movableOpenings(input.openings, input.baseline) };
  const levers = input.levers ?? ACQUISITION_LEVERS;
  const worlds = input.worlds ?? Math.max(SCREEN_MIN_WORLDS, Math.min(SCREEN_WORLDS, Math.round(SCREEN_WORK / Math.max(1, input.openings.length))));
  const seen = new Map<string, VariantReading>();
  let evaluations = 0;
  const limits = input.portfolio;
  const daysLeft = limits.daysLeft;

  /** Set once the headroom is read: a reading above it is a contradiction (Q-9). */
  let headroomReach: number | null = null;
  const measuredDeals = limits.measuredRates ? Math.max(1, limits.measuredRates.opportunities) : null;
  const flagsOf = (state: StrategyState, p: GoalPortfolio): PlausibilityFlag[] => {
    const b = p.best;
    if (!b) return [];
    const out: PlausibilityFlag[] = [];
    const behind = Math.max(1, Math.max(0, state.committed) + (limits.capitalCeiling ?? 0));
    if (b.settledP50 / behind > RETURN_BOUND) out.push({ kind: 'RETURN', detail: `median settled ${money(b.settledP50)} is ${(b.settledP50 / behind).toFixed(0)}× the ${money(behind)} behind it (bound ×${RETURN_BOUND})` });
    const deals = b.dealsP50 ?? 0;
    if (measuredDeals !== null && deals > measuredDeals * DEAL_CAPACITY_MULTIPLE) out.push({ kind: 'DEALS', detail: `median ${Math.round(deals)} deals, over ${DEAL_CAPACITY_MULTIPLE}× the ${measuredDeals} opportunit${measuredDeals === 1 ? 'y' : 'ies'} Brain's measured record produced` });
    const ids = new Set(b.members.map((m) => m.opportunityId));
    const markets = new Map<string, number>();
    for (const o of state.openings) if (ids.has(o.opportunity.id) && o.repeatable && o.agreedValue === 0) markets.set(o.marketKey ?? o.opportunity.id, Math.max(markets.get(o.marketKey ?? o.opportunity.id) ?? 0, o.volume.high ?? o.volume.value ?? Infinity));
    const room = [...markets.values()].reduce((n, v) => n + v, 0);
    if (markets.size > 0 && ![...ids].some((id) => !state.openings.find((o) => o.opportunity.id === id)?.repeatable) && deals > room + 1e-9) out.push({ kind: 'MARKET', detail: `median ${Math.round(deals)} deals from markets that take at most ${Math.round(room)}` });
    // Headroom is the openings held at their favourable estimates. A plan that adds a channel, a partner,
    // bought capacity, a transaction shape or financing creates reach headroom never measured, so only a
    // plan made of the held openings alone contradicts it (review F3).
    const createsReach = state.changes.some((c) => HEADROOM_EXEMPT.has(c.dimension));
    if (headroomReach !== null && !createsReach && b.reach > headroomReach + HEADROOM_SLACK) out.push({ kind: 'HEADROOM', detail: `reaches ${pct(b.reach)}, above the ${pct(headroomReach)} every estimate at its favourable end reaches` });
    return out;
  };
  const evaluate = async (state: StrategyState, w = worlds, forceMeasured = false, tag = ''): Promise<VariantReading> => {
    const key = (state.changes.map((c) => `${c.dimension}:${c.label}`).sort().join(' + ') || 'as planned') + tag;
    // The cache also knows which openings the state holds: two orders of the same changes can hold different ones.
    const cacheKey = `${key}#${w}#${createHash('sha1').update(state.openings.map((o) => o.opportunity.id).sort().join(',')).digest('hex').slice(0, 12)}`;
    const cached = seen.get(cacheKey);
    if (cached) return cached;
    const allowed = budgetsAllowed(limits);
    const fits = state.committed <= allowed.ceiling + 1e-9;
    let reading: VariantReading;
    if (!fits) {
      reading = { key, changes: state.changes, reach: 0, settledP10: 0, settledP50: 0, settledP90: 0, basis: 'COVERAGE', committed: state.committed, feasible: false, why: `commits ${money(state.committed)}, more than the ${money(allowed.ceiling)} the goal allows in all`, members: [], worlds: w, implausible: [] };
    } else {
      evaluations++;
      // What is bought after proof is paid only in the worlds where proof arrives (Q-7); the rest is committed in every world.
      const gates = gatesOf(state, limits, input.baseline);
      const before = state.committed - state.changes.filter((c) => c.afterProof).reduce((n, c) => n + c.cost, 0);
      // On the pool's threads when one is open (§101), inline otherwise; inline yields first (§63).
      const p = await evaluator.evaluate({
        ...limits,
        openings: state.openings,
        ...(state.contactsPerDay ? { contactsPerDay: state.contactsPerDay } : {}),
        ...(gates.length ? { gates } : {}),
        committed: { capital: Math.min(before, allowed.beforeProof), spend: before },
        ...(forceMeasured ? { forceMeasured: true } : {}),
        ...(state.committed < 0 ? { capitalCeiling: (limits.capitalCeiling ?? 0) * 2, perWeek: (limits.perWeek ?? 0) * 2, beforeProof: (limits.beforeProof ?? 0) * 2, committed: null } : {}),
        worlds: w,
      });
      const b = p.best;
      reading = {
        key,
        changes: state.changes,
        reach: b?.reach ?? 0,
        settledP10: b?.settledP10 ?? 0,
        settledP50: b?.settledP50 ?? 0,
        settledP90: b?.settledP90 ?? 0,
        basis: p.basis,
        committed: state.committed,
        feasible: !!b,
        why: b ? null : 'no combination runs inside the limits',
        members: b?.members.map((m) => m.title.slice(0, 50)) ?? [],
        worlds: w,
        ...(b?.keptP50 !== undefined ? { keptP50: b.keptP50 } : {}),
        ...(b?.dealsP50 !== undefined ? { dealsP50: b.dealsP50 } : {}),
        implausible: flagsOf(state, p),
      };
    }
    seen.set(cacheKey, reading);
    return reading;
  };

  const base: StrategyState = { openings: input.openings, committed: 0, changes: [] };
  const baseline = await evaluate(base);

  // 1. Diagnose: one factor at a time to its favourable end.
  const outreachOpenings = input.openings.filter(sellsThroughOutreach);
  const factorStates: Array<{ factor: Factor; moved: string; state: StrategyState }> = [];
  const allOpen = (f: (o: ModelledOpportunity) => ModelledOpportunity): ModelledOpportunity[] => input.openings.map((o) => (o.agreedValue > 0 ? o : f(o)));
  factorStates.push({ factor: 'VOLUME', moved: 'outreach a day ×3', state: { ...base, contactsPerDay: scale(currentContacts(limits, input.baseline), 3) } });
  factorStates.push({ factor: 'REPLY', moved: 'reply rate at the top of its range (×3 if fixed)', state: { ...base, openings: allOpen((o) => (sellsThroughOutreach(o) ? { ...o, respond: favourable(o.respond, 'HIGH', 3, 1) } : o)) } });
  factorStates.push({ factor: 'CLOSE', moved: 'close rate at the top of its range (×2 if fixed)', state: { ...base, openings: allOpen((o) => ({ ...o, close: favourable(o.close, 'HIGH', 2, 1) })) } });
  // A price is never moved alone: the demand curve takes close rate and the deals the market takes down with it (Q-2).
  factorStates.push({ factor: 'PRICE', moved: `price ×2, close rate and market volume ×${Math.pow(2, -PRICE_ELASTICITY).toFixed(2)} (elasticity ${PRICE_ELASTICITY}, assumed)`, state: { ...base, openings: allOpen((o) => repriceOpening(o, 2).opening) } });
  factorStates.push({ factor: 'CASH_TIMING', moved: 'days to cash at the bottom of its range (÷2 if fixed)', state: { ...base, openings: allOpen((o) => ({ ...o, daysToCash: favourable(o.daysToCash, 'LOW', 2) })) } });
  factorStates.push({ factor: 'CAPITAL', moved: 'money limits ×2 (starting capital and spending ceiling)', state: { ...base, committed: -Math.max(allowedFor(limits).ceiling, 0) } });
  factorStates.push({ factor: 'MARKET_SIZE', moved: 'deals the market can take ×3', state: { ...base, openings: allOpen((o) => ({ ...o, volume: scale(o.volume, 3) })) } });
  const diagnosis: FactorTest[] = [];
  for (const { factor, moved, state } of factorStates) {
    const r = await evaluate({ ...state, changes: [{ dimension: 'EVIDENCE', label: `test:${factor}`, detail: moved, cost: 0, basis: 'ASSUMPTION' }] });
    diagnosis.push({ factor, moved, reach: r.reach, settledP50: r.settledP50, liftReach: r.reach - baseline.reach, liftP50: r.settledP50 - baseline.settledP50 });
  }
  diagnosis.sort((a, b) => b.liftReach - a.liftReach || b.liftP50 - a.liftP50);
  const all: StrategyState = {
    ...base,
    contactsPerDay: scale(currentContacts(limits, input.baseline), 3),
    openings: allOpen((o) => ({
      ...o,
      respond: sellsThroughOutreach(o) ? favourable(o.respond, 'HIGH', 3, 1) : o.respond,
      close: favourable(o.close, 'HIGH', 2, 1),
      // No price: under the demand curve a higher price takes as much from close and volume as it adds, so it is not a favourable end.
      daysToCash: favourable(o.daysToCash, 'LOW', 2),
      volume: scale(o.volume, 3),
    })),
    changes: [{ dimension: 'EVIDENCE', label: 'test:ALL', detail: 'every factor at its favourable end at once', cost: 0, basis: 'ASSUMPTION' }],
  };
  const headroomReading = await evaluate(all);
  const headroom = { reach: headroomReading.reach, settledP50: headroomReading.settledP50 };
  headroomReach = headroom.reach;
  const structural = headroom.reach < input.required;

  // 3. Construct: generic operators over the plan's own openings and the cost evidence.
  const operators = buildOperators({ input, levers, base });
  const allowed = budgetsAllowed(limits);

  // 4. Evaluate singles, then combine across dimensions while it improves materially.
  const rounds: Reconstruction['rounds'] = [];
  // Material: two points of reach, or a median at least 10% higher by at least 10% of what is still to raise ($0 → $50 is not material, Q-9).
  // A reading the critic flagged is never an improvement (C-4).
  const improves = (a: VariantReading, b: VariantReading) =>
    a.feasible &&
    !a.implausible?.length &&
    (a.reach - b.reach >= MATERIAL_REACH || (a.reach >= b.reach - 1e-9 && a.settledP50 > b.settledP50 * (1 + MATERIAL_P50) + 1e-9 && a.settledP50 - b.settledP50 >= MATERIAL_P50 * Math.max(0, limits.remaining)));
  const step = (op: StrategyOperator, s: StrategyState): StrategyState | null => {
    const next = op.apply(s);
    return next && next !== s ? { ...next, program: [...(s.program ?? []), { op: 'OPERATOR', key: op.key }] } : null;
  };
  const singles: Array<{ op: (typeof operators)[number]; reading: VariantReading }> = [];
  const firstTried: VariantReading[] = [];
  for (const op of operators) {
    const next = step(op, base);
    if (!next) continue;
    const r = await evaluate(next);
    firstTried.push(r);
    singles.push({ op, reading: r });
  }
  const useful = singles.filter((one) => improves(one.reading, baseline)).sort((a, b) => b.reading.reach - a.reading.reach || b.reading.settledP50 - a.reading.settledP50);
  let current: StrategyState = base;
  let currentReading = baseline;
  const path: StrategyState[] = [];
  if (useful[0]) {
    current = step(useful[0].op, base)!;
    currentReading = useful[0].reading;
    path.push(current);
  }
  rounds.push({ round: 1, tried: firstTried, kept: useful[0]?.reading.key ?? null });
  let used = new Set<Dimension>(current.changes.map((c) => c.dimension));
  for (let round = 2; ; round++) {
    const tried: VariantReading[] = [];
    let bestNext: { state: StrategyState; reading: VariantReading } | null = null;
    for (const one of useful) {
      if (used.has(one.op.dimension)) continue;
      const next = step(one.op, current);
      if (!next) continue;
      const r = await evaluate(next);
      tried.push(r);
      if (improves(r, currentReading) && (!bestNext || r.reach > bestNext.reading.reach || (r.reach === bestNext.reading.reach && r.settledP50 > bestNext.reading.settledP50))) bestNext = { state: next, reading: r };
    }
    if (tried.length === 0) break;
    rounds.push({ round, tried, kept: bestNext?.reading.key ?? null });
    if (!bestNext) break;
    current = bestNext.state;
    currentReading = bestNext.reading;
    path.push(current);
    used = new Set(current.changes.map((c) => c.dimension));
  }
  // 4b. Explore from many directions (§101): the greedy path is one line of reasoning among many.
  let exploration: Exploration | null = null;
  // The exploration reports its own evaluations; `evaluations` stays §99's own.
  const ownEvaluations = evaluations;
  const operatorsFor = (target: string) => buildOperators({ input, levers, base, target });
  if (input.explore !== null) {
    const screenWorlds = Math.max(100, Math.round(worlds / 3));
    // §102: before the engine reads a direction, ordinary code sweeps the variables — tens to hundreds of thousands of combinations.
    let sweep: VariableSweep | null = null;
    // A plan is only past exploring when it reaches its requirement as a probability on no assumed move (§95); 99% coverage on assumptions is not.
    const defensible = currentReading.reach >= input.required && currentReading.basis === 'PROBABILITY' && !currentReading.changes.some((c) => c.basis === 'ASSUMPTION');
    if (!defensible) {
      try {
        // On a pool thread, never the server's loop: a request that waits on many queries must not queue behind the sweep's slices.
        sweep = await evaluator.sweep({
          openings: input.openings,
          portfolio: limits,
          baseline: input.baseline,
          required: input.required,
          ...(input.levers ? { levers: input.levers } : {}),
          greedy: current,
          ...(input.explore?.sweepMs !== undefined ? { maxMs: input.explore.sweepMs } : {}),
          ...(input.explore?.maxVariations !== undefined ? { maxVariations: input.explore.maxVariations } : {}),
        });
      } catch (error) {
        console.warn(`variable sweep failed: ${String((error as Error)?.message ?? error)}`);
      }
    }
    exploration = await exploreDirections({
      base,
      greedy: current,
      greedyReading: currentReading,
      baselineReading: baseline,
      operators,
      operatorsFor,
      sweep,
      evaluate: (state, screen, tag = '') => evaluate(state, screen ? screenWorlds : worlds, false, tag),
      required: input.required,
      remaining: limits.remaining,
      daysLeft,
      binding: diagnosis.map((d) => ({ factor: d.factor, liftReach: d.liftReach })),
      structural,
      threads: evaluator.threads,
      ...(input.explore ?? {}),
    });
    if (exploration.winner) {
      const w = exploration.winner;
      if (w.state) current = w.state;
    }
    evaluations = ownEvaluations;
    if (exploration.winner) currentReading = await evaluate(current);
  }
  // The strongest plan, read again at the plan's own number of worlds. A plan the critic flags there is not concluded with:
  // the strongest plausible one on the path that led to it is, down to the plan as held (C-4).
  const fullWorlds = Math.max(worlds, Math.min(limits.worlds ?? 2000, Math.round((SCREEN_WORK * 3) / Math.max(1, input.openings.length))));
  let best = current === base ? baseline : await evaluate(current, fullWorlds);
  for (const fallback of [...path].reverse()) {
    if (!best.implausible?.length || current === base) break;
    if (fallback === current) continue;
    current = fallback;
    best = await evaluate(current, fullWorlds);
  }
  if (best.implausible?.length && current !== base) {
    current = base;
    best = baseline;
  }
  // Robustness: the strongest plan if the new campaign does no better than the old record — rebuilt with every
  // assumed move taken away, then read on the measured record (Q-5).
  const bare = applyProgram(base, programOf(current, operators), { operators, operatorsFor, remaining: limits.remaining }, true).state;
  const floor = limits.measuredRates ? await evaluate(bare, worlds, true, ' @as-is-record') : null;
  // The conversion it needs: the lowest reply rate (shared by every outreach opening) at which it reaches the requirement.
  const replyAt = (rate: number) =>
    evaluate({ ...current, openings: current.openings.map((o) => (sellsThroughOutreach(o) ? { ...o, respond: { ...o.respond, value: rate, low: rate, high: rate, distribution: undefined, inferred: undefined } } : o)) }, worlds, false, ` @reply=${rate.toFixed(4)}`);
  let requiredReply: number | null = null;
  if (current.openings.some(sellsThroughOutreach) && (await replyAt(0.15)).reach >= input.required) {
    let lo = 0.0005;
    let hi = 0.15;
    if ((await replyAt(lo)).reach >= input.required) requiredReply = lo;
    else {
      for (let i = 0; i < 9; i++) {
        const mid = Math.sqrt(lo * hi);
        if ((await replyAt(mid)).reach >= input.required) hi = mid;
        else lo = mid;
      }
      requiredReply = hi;
    }
  }

  // 2. Challenge the plan's own assumptions, with what the loop found.
  const lift = (f: Factor) => diagnosis.find((d) => d.factor === f);
  const triedDim = (d: Dimension) => firstTried.filter((r) => r.changes.some((c) => c.dimension === d));
  const bestOf = (d: Dimension) => triedDim(d).sort((a, b) => b.reach - a.reach)[0];
  const measuredRecord = input.baseline.measuredRates;
  const challenges: AssumptionChallenge[] = [
    {
      assumption: 'Historical outreach results describe the campaign this plan would run',
      status: measuredRecord ? (measuredRecord.applied === 'BINDS' ? 'MEASURED' : 'ASSUMPTION') : 'UNTESTED',
      testedBy: 'EVIDENCE',
      finding: measuredRecord
        ? `${measuredRecord.assessment.authority}: ${measuredRecord.assessment.sentence}${measuredRecord.asIs ? ` As-is floor: ${pct(measuredRecord.asIs.reach)} reach, p50 ${money(measuredRecord.asIs.settledP50)}.` : ''}`
        : 'no measured outreach record was read',
    },
    {
      assumption: 'Sending capacity is fixed at what the workspace has today',
      status: 'ESTIMATE',
      testedBy: 'CAPACITY',
      finding: bestOf('CAPACITY') ? `best capacity purchase: ${bestOf('CAPACITY')!.changes.map((c) => c.detail).join('; ')} → ${pct(bestOf('CAPACITY')!.reach)} (from ${pct(baseline.reach)})` : 'no capacity purchase fits the limits',
    },
    {
      assumption: 'Cold outreach is the only way to reach buyers',
      status: 'ASSUMPTION',
      testedBy: 'ACQUISITION',
      finding: bestOf('ACQUISITION') ? `best bought channel: ${bestOf('ACQUISITION')!.changes.map((c) => c.detail).join('; ')} → ${pct(bestOf('ACQUISITION')!.reach)}` : 'no priced opening to sell through another channel',
    },
    {
      assumption: 'Each opening sells one unit at its listed price',
      status: 'ASSUMPTION',
      testedBy: 'TRANSACTION',
      finding: bestOf('TRANSACTION') ? `best reshaping: ${bestOf('TRANSACTION')!.key} → ${pct(bestOf('TRANSACTION')!.reach)}, p50 ${money(bestOf('TRANSACTION')!.settledP50)} (close rate assumed)` : 'no priced repeatable opening',
    },
    {
      assumption: 'Cash arrives at each opening\'s listed timing',
      status: 'ASSUMPTION',
      testedBy: 'CASH_TIMING',
      finding: `deposits at signing: ${pct(bestOf('CASH_TIMING')?.reach ?? baseline.reach)}; cash-timing factor lift ${pct(lift('CASH_TIMING')?.liftReach ?? 0)}`,
    },
    {
      assumption: 'The openings held are the market',
      status: structural ? 'ASSUMPTION' : 'ESTIMATE',
      testedBy: 'MARKET',
      finding: structural
        ? `even with every input at its favourable end the openings held reach ${pct(headroom.reach)}: the pool must change, not the estimates`
        : `with every input at its favourable end the openings held could reach ${pct(headroom.reach)}`,
    },
  ];

  // The cost of daily volumes asked about.
  const capacityLever = levers.find((l) => l.kind === 'SENDING_CAPACITY');
  const volumePlans = capacityLever ? (input.volumeQuestions ?? volumeQuestionsFor(input.openings, input.portfolio.remaining, daysLeft)).map((perDay) => dailyVolumePlan(capacityLever, perDay, daysLeft, limits)) : [];

  // 5. Conclude.
  const binding = diagnosis[0];
  const assumed = [...new Set(best.changes.filter((c) => c.basis !== 'MEASURED').map((c) => `${c.label}: ${c.detail}`))];
  const unestablished = [...new Set((input.baseline.missing ?? []).filter((m) => /not established/.test(m)).map((m) => m.split(':').slice(1).join(':').trim()))];
  const measured: string[] = [];
  if (measuredRecord) measured.push(measuredRecord.assessment.answers);
  if (limits.measuredCapacity) measured.push(`sending capacity up to ${limits.measuredCapacity.perDay} a day on ${limits.measuredCapacity.accounts} healthy accounts`);
  // The interval is read over the worlds the reading actually used (C-14).
  const usedWorlds = best.worlds ?? worlds;
  const wilsonLow = wilsonLower(Math.round(best.reach * usedWorlds), usedWorlds);
  const confidenceStatement = { value: '' };
  const statement0 =
    best.basis === 'PROBABILITY' && assumed.length === 0
      ? `The strongest plan reaches the target in ${pct(best.reach)} of worlds, a probability (Wilson lower bound ${pct(wilsonLow)}) because every input is evidence.`
      : `The strongest plan reaches the target in ${pct(best.reach)} of the worlds tested. That is coverage of stated ranges and assumptions, not a probability: ${[...assumed.slice(0, 3), ...unestablished.slice(0, 3)].join('; ') || 'inputs are not all evidence'}.`;
  const robustness =
    (floor ? ` If the new campaign does no better than the measured record, it reaches ${pct(floor.reach)} (p50 ${money(floor.settledP50)}).` : '') +
    (requiredReply !== null ? ` It needs a reply rate of about ${pct(requiredReply)} to reach ${pct(input.required)}; the first sends measure that.` : ' No reply rate up to 15% reaches the requirement on its own.');
  confidenceStatement.value += robustness;
  const changedDims = [...new Set(best.changes.map((c) => c.dimension.toLowerCase().replace('_', ' ')))];
  const parts: string[] = [];
  if (structural) parts.push(`For the openings as held, even every estimate at its favourable end reaches ${pct(headroom.reach)}: better estimates or more capacity cannot close the gap.`);
  else if (binding) parts.push(`${binding.factor} binds (moving it alone lifts reach by ${pct(binding.liftReach)}).`);
  if (best !== baseline && best.reach > baseline.reach + MATERIAL_REACH) {
    parts.push(`Changing ${changedDims.join(', ')} reaches ${pct(best.reach)} of the worlds tested, resting on ${assumed.length} assumption(s) that only selling can measure.`);
  } else parts.push('No change tried improves the plan materially.');
  if (best.reach < input.required || best.basis !== 'PROBABILITY' || assumed.length > 0) {
    parts.push(structural ? 'A defensible plan needs openings with larger or faster demand, or a channel where buyers already ask, and the assumptions measured by selling.' : 'A defensible plan needs those assumptions measured by selling.');
  }
  const limitation = best.reach >= input.required && best.basis === 'PROBABILITY' && assumed.length === 0 ? null : parts.join(' ');
  const ticket = Math.max(250, Math.round(limits.remaining / 20 / 50) * 50);
  // Coverage that reaches the requirement is still not a plan anybody can rely on: keep asking the world.
  const searchBrief =
    best.reach >= input.required && best.basis === 'PROBABILITY' && assumed.length === 0
      ? ''
      : `Reconstruction (§99): ${binding ? `${binding.factor.toLowerCase().replace('_', ' ')} is what binds this goal` : 'no single factor binds'}${structural ? ', and the openings held cannot reach the target even at their best' : ''}. ` +
        `Look in any industry, including ones not searched before, for buyers who already ask for something that can be delivered within ${Math.max(1, daysLeft - 5)} days for ${money(ticket)} or more, ` +
        `reachable without cold email — a request posted, a marketplace category with open demand, a partner who already sells to them — with one dated example each, and what the buyer pays and when.`;
  return {
    required: input.required,
    baseline,
    diagnosis,
    headroom,
    structural,
    challenges,
    rounds,
    best,
    floor,
    requiredReply,
    volumePlans,
    limitation,
    confidence: { basis: best.basis, measured, assumed: [...assumed, ...unestablished], statement: statement0 + confidenceStatement.value },
    searchBrief: exploration?.asks.length ? `${searchBrief} Directions Brain explored need answers to: ${exploration.asks.slice(0, 3).join(' ')}`.trim() : searchBrief,
    evaluations,
    exploration,
    flags: flagged(seen.values(), exploration),
  };
}

/** Every flagged reading, strongest first: what the critic kept out of the conclusion. */
function flagged(readings: Iterable<VariantReading>, exploration: Exploration | null): Reconstruction['flags'] {
  const rows = new Map<string, Reconstruction['flags'][number]>();
  const add = (r: VariantReading | null | undefined) => {
    if (r?.implausible?.length && !r.key.startsWith('EVIDENCE:test:') && !rows.has(r.key)) rows.set(r.key, { key: r.key, reach: r.reach, settledP50: r.settledP50, flags: r.implausible });
  };
  for (const r of readings) add(r);
  for (const d of exploration?.all ?? []) add(d.reading);
  return [...rows.values()].sort((a, b) => b.settledP50 - a.settledP50).slice(0, 20);
}

/** The day spending past the before-proof limit may start: first cash has to have arrived. */
const PROOF_DAY = DAYS_TO_FIRST_PROOF.low;

/**
 * The purchases a state makes after proof, as the engine's gates: bought
 * sending capacity is one gate (its outreach a day replaces the shared figure
 * in worlds where it is bought), each bought channel its own.
 */
export function gatesOf(state: StrategyState, limits: ReconstructionInput['portfolio'], baseline: GoalPortfolio): GateInput[] {
  const allowed = budgetsAllowed(limits);
  const tranche = (cost: number) => Math.min(cost, Math.max(1, allowed.perWeek));
  const out: GateInput[] = [];
  const capacity = state.changes.filter((c) => c.afterProof && c.dimension === 'CAPACITY');
  if (capacity.length) {
    const now = state.contactsPerDay ?? currentContacts(limits, baseline);
    const add = capacity.reduce((a, c) => ({ low: a.low + (c.contacts?.low ?? 0), high: a.high + (c.contacts?.high ?? 0) }), { low: 0, high: 0 });
    const cost = capacity.reduce((n, c) => n + c.cost, 0);
    out.push({
      id: 'capacity',
      day: PROOF_DAY,
      tranche: tranche(cost),
      cost,
      contactsPerDay: { ...now, value: null, low: (now.low ?? now.value ?? 0) + add.low, high: (now.high ?? now.value ?? 0) + add.high, provenance: 'UNKNOWN', distribution: undefined, inferred: undefined, note: `${now.note}; plus capacity bought after proof` },
    });
  }
  for (const c of state.changes.filter((x) => x.afterProof && x.gate && x.dimension !== 'CAPACITY')) out.push({ id: c.gate!, day: PROOF_DAY, tranche: tranche(c.cost), cost: c.cost });
  return out;
}

/** The outreach a day a state's before-proof purchases give: the plan's own figure plus what each bought. */
function contactsFrom(changes: StrategyChange[], base: ModelInput): ModelInput | undefined {
  const bought = changes.filter((c) => c.dimension === 'CAPACITY' && !c.afterProof && c.contacts);
  if (bought.length === 0) return undefined;
  const add = bought.reduce((a, c) => ({ low: a.low + c.contacts!.low, high: a.high + c.contacts!.high }), { low: 0, high: 0 });
  return {
    ...base,
    value: null,
    low: (base.low ?? base.value ?? 0) + add.low,
    high: (base.high ?? base.value ?? 0) + add.high,
    provenance: 'UNKNOWN',
    distribution: undefined,
    inferred: undefined,
    note: `${base.note}; plus ${bought.map((c) => c.detail).join('; ')}`,
  };
}

/** What a variable sweep needs, as plain data a pool thread can receive (§102). */
export interface SweepJob {
  openings: ModelledOpportunity[];
  portfolio: ReconstructionInput['portfolio'];
  baseline: GoalPortfolio;
  required: number;
  levers?: readonly AcquisitionLever[];
  greedy: StrategyState;
  maxMs?: number;
  maxVariations?: number;
}

/** The variable sweep over a plan, with its operators rebuilt from data: runs inline or on a pool thread. */
export function sweepFor(job: SweepJob): Promise<VariableSweep> {
  const input: ReconstructionInput = { openings: job.openings, portfolio: job.portfolio, baseline: job.baseline, required: job.required, ...(job.levers ? { levers: job.levers } : {}) };
  const levers = job.levers ?? ACQUISITION_LEVERS;
  const base: StrategyState = { openings: job.openings, committed: 0, changes: [] };
  return sweepVariables({
    base,
    greedy: job.greedy,
    operators: buildOperators({ input, levers, base }),
    operatorsFor: (target) => buildOperators({ input, levers, base, target }),
    remaining: job.portfolio.remaining,
    daysLeft: job.portfolio.daysLeft,
    required: job.required,
    contactsPerDay: currentContacts(job.portfolio, job.baseline),
    limits: job.portfolio,
    ...(job.maxMs !== undefined ? { maxMs: job.maxMs } : {}),
    ...(job.maxVariations !== undefined ? { maxVariations: job.maxVariations } : {}),
  });
}

function allowedFor(limits: ReconstructionInput['portfolio']) {
  return budgetsAllowed(limits);
}

function valuePerInterested(o: ModelledOpportunity): number {
  return (knownMid(o.price) ?? 0) * (knownMid(o.close) ?? 0);
}

function currentContacts(limits: ReconstructionInput['portfolio'], baseline: GoalPortfolio): ModelInput {
  if (limits.contactsPerDay) return limits.contactsPerDay;
  const c = baseline.limits.contactsPerDay;
  return c.value !== null
    ? { value: c.value, low: c.value, high: c.value, provenance: 'EVIDENCE', source: null, note: c.source }
    : { value: null, low: c.low, high: c.high, provenance: 'UNKNOWN', source: null, note: c.source };
}

/** One-sided 95% Wilson lower bound, the test §95 applies. */
/** One generic change to a strategy: the §99 operators, reused by the multidirectional explorer (§101). */
export interface StrategyOperator {
  dimension: Dimension;
  /** A stable name, so a stored reasoning method can name the operator it uses. */
  key: string;
  apply: (s: StrategyState) => StrategyState | null;
}

/**
 * The generic operators over a plan's own openings and the cost evidence. A
 * `target` names the opening a channel operator sells (by default the one
 * that settles most per interested buyer), so another line of reasoning can
 * point the same operator at a different opening.
 */
export function buildOperators(ctx: { input: ReconstructionInput; levers?: readonly AcquisitionLever[]; base?: StrategyState; target?: string }): StrategyOperator[] {
  const { input } = ctx;
  const levers = ctx.levers ?? ACQUISITION_LEVERS;
  const limits = input.portfolio;
  const daysLeft = limits.daysLeft;
  const outreachOpenings = input.openings.filter(sellsThroughOutreach);
  const operators: StrategyOperator[] = [];
  const allowed = budgetsAllowed(limits);
  const budgets = [...new Set([allowed.beforeProof, allowed.perWeek, allowed.ceiling].filter((b) => b > 0))];
  const contactsBase = currentContacts(limits, input.baseline);
  /** A move of the same family already made: a larger one stands (null), a smaller one is taken back, its money with it. */
  const family = (s: StrategyState, match: (c: StrategyChange) => boolean, budget: number): { rest: StrategyState } | null => {
    const prev = s.changes.find(match);
    if (!prev) return { rest: s };
    if ((prev.budget ?? Infinity) >= budget) return null;
    return {
      rest: {
        ...s,
        committed: s.committed - prev.cost,
        changes: s.changes.filter((c) => c !== prev),
        openings: prev.clone ? s.openings.filter((o) => o.opportunity.id !== prev.clone) : s.openings,
      },
    };
  };
  for (const lever of levers.filter((l) => l.kind === 'SENDING_CAPACITY')) {
    for (const budget of budgets) {
      const key = `capacity:${lever.key}@${Math.round(budget)}`;
      operators.push({
        dimension: 'CAPACITY',
        key,
        apply: (s) => {
          if (outreachOpenings.length === 0) return null;
          // One purchase per lever: a larger budget replaces a smaller one, never stacks on it (Q-1).
          const f = family(s, (c) => c.dimension === 'CAPACITY' && (c.op ?? '').startsWith(`capacity:${lever.key}@`), budget);
          if (!f) return null;
          const r = f.rest;
          const afterProof = budget > allowed.beforeProof;
          const avail = budget - r.committed;
          // After proof it is paid in weekly tranches, so the whole purchase sends only once its last tranche is paid (Q-7).
          const delay = afterProof ? 7 * Math.max(0, Math.ceil(avail / Math.max(1, allowed.perWeek)) - 1) : 0;
          if (daysLeft - delay <= 0) return null;
          // The purchase rounds domains up: shrink it until what it costs fits what the budget allows.
          let buy = purchaseCapacity(lever, avail, daysLeft - delay, afterProof);
          for (let i = 0; i < 4 && buy && buy.cost > avail + 1e-9; i++) buy = purchaseCapacity(lever, avail - (buy.cost - avail) * (i + 1) - 1, daysLeft - delay, afterProof);
          if (!buy || buy.addedPerDay.high <= 0 || buy.cost > avail + 1e-9) return null;
          const within = (daysLeft - delay) / daysLeft;
          const change: StrategyChange = {
            dimension: 'CAPACITY',
            op: key,
            budget,
            label: `${lever.key}@${Math.round(budget)} ($${buy.cost} bought)`,
            detail: `${buy.sentence}${delay ? `; paid in ${Math.ceil(avail / Math.max(1, allowed.perWeek))} weekly tranche(s) of at most ${money(allowed.perWeek)}, so fully sending ${delay} days later` : ''}${afterProof ? '; bought only in worlds where cash has come back by day ' + PROOF_DAY : ''}`,
            cost: buy.cost,
            basis: afterProof ? 'ASSUMPTION' : 'ESTIMATE',
            startDay: { low: buy.startDay.low + delay, high: buy.startDay.high + delay },
            contacts: { low: buy.effectivePerDay.low * within, high: buy.effectivePerDay.high * within },
            ...(afterProof ? { afterProof: true, gate: 'capacity' } : {}),
          };
          const changes = [...r.changes, change];
          const contacts = contactsFrom(changes, contactsBase);
          const { contactsPerDay: _drop, ...rest } = r;
          void _drop;
          return { ...rest, ...(contacts ? { contactsPerDay: contacts } : {}), committed: r.committed + buy.cost, changes };
        },
      });
    }
  }
  const sellable = input.openings.filter((o) => sellsThroughOutreach(o) && knownMid(o.price) !== null && (knownMid(o.price) ?? 0) > 0);
  for (const lever of levers.filter((l) => l.kind === 'PAID_INBOUND' || l.kind === 'MARKETPLACE')) {
    for (const budget of budgets) {
      const key = `acquisition:${lever.key}@${Math.round(budget)}`;
      operators.push({
        dimension: 'ACQUISITION',
        key,
        apply: (s) => {
          // The opening the inbound channel sells: the one that settles most per interested buyer.
          const picked = pickTarget(sellable, ctx.target);
          if (!picked) return null;
          // The opening as this state holds it (its price and shape), not as the card listed it.
          const target = s.openings.find((o) => o.opportunity.id === picked.opportunity.id);
          if (!target) return null;
          const cloneId = `${target.opportunity.id}~${lever.key}`;
          // One purchase per lever and target: a larger budget replaces a smaller one (Q-1).
          const f = family(s, (c) => c.clone === cloneId, budget);
          if (!f) return null;
          const r = f.rest;
          const afterProof = budget > allowed.beforeProof;
          const buy = buyInbound(lever, budget - r.committed, daysLeft, afterProof);
          if (!buy) return null;
          const gate = afterProof ? `channel:${cloneId}` : undefined;
          const clone: PlannedOpening = {
            ...target,
            index: 900 + r.openings.length,
            opportunity: { ...target.opportunity, id: cloneId, title: `${target.opportunity.title.slice(0, 50)} via ${lever.label}` },
            respond: { value: null, low: buy.qualified.low, high: buy.qualified.high, provenance: 'UNKNOWN', source: { kind: 'OTHER', ref: `lever:${lever.key}` }, note: `share of ${lever.label} leads who are interested buyers` },
            channel: { label: `${lever.label} leads`, perDay: { value: null, low: buy.leadsPerDay.low, high: buy.leadsPerDay.high, provenance: 'UNKNOWN', source: { kind: 'OTHER', ref: `lever:${lever.key}` }, note: buy.sentence }, resource: `channel:${lever.key}`, riskGroup: `channel:${lever.key}` },
            // The same buyers, reached another way: one market, drawn once, shared with the original (Q-6).
            marketKey: target.marketKey ?? target.opportunity.id,
            ...(gate ? { gate } : {}),
          };
          return {
            ...r,
            openings: [...r.openings, clone],
            committed: r.committed + buy.cost,
            changes: [
              ...r.changes,
              {
                dimension: 'ACQUISITION',
                op: key,
                budget,
                clone: cloneId,
                label: `${lever.key}@${Math.round(budget)}${ctx.target ? `>${target.opportunity.id}` : ''}`,
                detail: `${buy.sentence}, selling ${target.opportunity.title.slice(0, 50)}${afterProof ? `; bought only in worlds where cash has come back by day ${PROOF_DAY}` : ''}`,
                cost: buy.cost,
                basis: afterProof ? 'ASSUMPTION' : 'ESTIMATE',
                startDay: { low: lever.setupDays.low + (afterProof ? DAYS_TO_FIRST_PROOF.low : 0), high: lever.setupDays.high + (afterProof ? DAYS_TO_FIRST_PROOF.high : 0) },
                ...(gate ? { afterProof: true, gate } : {}),
              },
            ],
          };
        },
      });
    }
  }
  // Suppliers and partners: sell through someone who already holds the buyers, for a commission.
  operators.push({
    dimension: 'PARTNER',
    key: 'partner:referral-partner',
    apply: (s) => {
      const picked = pickTarget(sellable, ctx.target);
      const target = picked ? s.openings.find((o) => o.opportunity.id === picked.opportunity.id) : undefined;
      if (!target) return null;
      const cloneId = `${target.opportunity.id}~partner`;
      // One partner per opening.
      if (s.openings.some((o) => o.opportunity.id === cloneId)) return null;
      const keep = 1 - (PARTNER_TERMS.commission.low + PARTNER_TERMS.commission.high) / 2;
      const clone: PlannedOpening = {
        ...target,
        index: 950 + s.openings.length,
        opportunity: { ...target.opportunity, id: cloneId, title: `${target.opportunity.title.slice(0, 50)} via a referral partner` },
        price: { ...scale(target.price, keep), note: `after a ${Math.round(PARTNER_TERMS.commission.low * 100)}–${Math.round(PARTNER_TERMS.commission.high * 100)}% partner commission` },
        // A referred buyer has already said they are interested; whether they buy is the opening's own close rate.
        respond: { value: 1, low: 1, high: 1, provenance: 'ASSUMPTION', source: null, note: 'a referral is an interested buyer' },
        channel: { label: 'partner referrals', perDay: { value: null, low: PARTNER_TERMS.referralsPerDay.low, high: PARTNER_TERMS.referralsPerDay.high, provenance: 'ASSUMPTION', source: null, note: PARTNER_TERMS.referralsPerDay.source }, resource: 'channel:partner', riskGroup: 'channel:partner' },
        // The partner's buyers are this opening's market, not a second one (Q-6).
        marketKey: target.marketKey ?? target.opportunity.id,
      };
      return {
        ...s,
        openings: [...s.openings, clone],
        changes: [...s.changes, { dimension: 'PARTNER', op: 'partner:referral-partner', clone: cloneId, label: `referral-partner${ctx.target ? `>${target.opportunity.id}` : ''}`, detail: `sell ${target.opportunity.title.slice(0, 50)} through a partner who already serves its buyers (a supplier or complementary vendor), paying ${Math.round(PARTNER_TERMS.commission.low * 100)}–${Math.round(PARTNER_TERMS.commission.high * 100)}% (${PARTNER_TERMS.commission.source}); ${PARTNER_TERMS.referralsPerDay.low}–${PARTNER_TERMS.referralsPerDay.high} referrals a day assumed until a partner is signed`, cost: 0, basis: 'ASSUMPTION', startDay: PARTNER_TERMS.setupDays }],
      };
    },
  });
  // Transaction shapes: sell more per buyer, at the cost of a lower and unmeasured close rate.
  // A retainer bills the months inside the window only (Q-8): a 14-day goal collects half a month.
  const months = Math.min(1, Math.max(0, daysLeft) / 30);
  for (const [shape, units, discount, closeFactor] of [
    ['bundle', SHAPE_MULTIPLES.bundle.units, SHAPE_MULTIPLES.bundle.discount, 0.5],
    ['retainer', SHAPE_MULTIPLES.retainer.unitsPerMonth * months, SHAPE_MULTIPLES.retainer.discount, 0.6],
  ] as const) {
    operators.push({
      dimension: 'TRANSACTION',
      key: `transaction:${shape}`,
      apply: (s) => {
        if (!(units > 0)) return null;
        // Only a ticket too small to carry a material share of the gap is worth reshaping (§95's ONE_TRANSACTION_SHAPE),
        // and an opening holds one shape: a bundle is not then sold as a retainer (Q-8).
        const touched = s.openings.filter((o) => o.repeatable && o.agreedValue === 0 && !o.terms?.shape && knownMid(o.price) !== null && (knownMid(o.price) ?? 0) < limits.remaining * MATERIAL_SHARE);
        if (touched.length === 0) return null;
        return {
          ...s,
          openings: s.openings.map((o) => {
            if (!touched.includes(o)) return o;
            // The discount is a unit-price move, held inside the opening's running ×0.25–×4 with every price move.
            const unit = repriceOpening(o, 1 - discount, shape).opening;
            const terms = { ...(unit.terms ?? { priceFactor: 1, shape: null, units: 1 }), shape, units };
            return {
              ...unit,
              price: scale(unit.price, units),
              close: { ...scale(unit.close, closeFactor, 1), provenance: 'ASSUMPTION' as ModelInput['provenance'], note: `${unit.close.note}; ${shape}: close assumed ×${closeFactor}, not measured` },
              volume: scale(unit.volume, 1 / units),
              // Every unit in the deal is fulfilled: a bundle of ten costs ten units' direct cost.
              directCost: scale(unit.directCost, units),
              terms,
            };
          }),
          changes: [...s.changes, { dimension: 'TRANSACTION', op: `transaction:${shape}`, label: shape, detail: `sell a ${shape} of ${units.toFixed(units % 1 ? 2 : 0)} unit(s) at ${Math.round(discount * 100)}% off (×${(units * (1 - discount)).toFixed(1)} the unit price, ×${units.toFixed(1)} its direct cost); close rate assumed ×${closeFactor} until measured`, cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
        };
      },
    });
  }
  // Financing: the buyer prepays, so a supplier's cost is paid from the buyer's money, not the owner's.
  operators.push({
    dimension: 'CAPITAL',
    key: 'capital:prepaid-fulfilment',
    apply: (s) => {
      const touched = s.openings.filter((o) => o.agreedValue === 0 && !o.fundedByBuyer && (o.directCost.high ?? o.directCost.value ?? 0) > 0);
      if (touched.length === 0) return null;
      return {
        ...s,
        openings: s.openings.map((o) => (touched.includes(o) ? { ...o, fundedByBuyer: true } : o)),
        changes: [...s.changes, { dimension: 'CAPITAL', op: 'capital:prepaid-fulfilment', label: 'prepaid-fulfilment', detail: `the buyer pays in full before the supplier is paid, so ${touched.length} opening(s)' direct costs come from the buyer's money, not the ${money(allowed.ceiling)} limit — they still leave the cash kept`, cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
      };
    },
  });
  // Cash timing: a deposit at signing. A share of the price arrives early; the balance keeps the opening's own timing (Q-4).
  operators.push({
    dimension: 'CASH_TIMING',
    key: 'timing:deposit',
    apply: (s) => {
      const touched = s.openings.filter((o) => o.agreedValue === 0 && o.repeatable && !o.deposit && (o.daysToCash.high ?? o.daysToCash.value ?? 0) > 3);
      if (touched.length === 0) return null;
      return {
        ...s,
        openings: s.openings.map((o) => (touched.includes(o) ? { ...o, deposit: { low: DEPOSIT_SHARE.low, high: DEPOSIT_SHARE.high, days: favourable(o.daysToCash, 'LOW', 2).value ?? 0 } } : o)),
        changes: [...s.changes, { dimension: 'CASH_TIMING', op: 'timing:deposit', label: 'deposit', detail: `ask for a deposit of ${Math.round(DEPOSIT_SHARE.low * 100)}–${Math.round(DEPOSIT_SHARE.high * 100)}% at signing (assumed accepted): that share arrives at the fast end of each opening's timing, the balance at its own`, cost: 0, basis: 'ASSUMPTION', startDay: { low: 0, high: 0 } }],
      };
    },
  });

  return operators;
}

function pickTarget(sellable: ModelledOpportunity[], id?: string): ModelledOpportunity | undefined {
  if (id) return sellable.find((o) => o.opportunity.id === id);
  return [...sellable].sort((a, b) => valuePerInterested(b) - valuePerInterested(a))[0];
}

export function wilsonLower(k: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = k / n;
  const d = 1 + (z * z) / n;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d);
}

/** The reconstruction, as lines for `goals plan`. */
export function renderReconstruction(r: Reconstruction, limit = 8): string[] {
  const lines: string[] = [];
  const v = (x: VariantReading) => `reach ${pct(x.reach)} · p10/p50/p90 ${money(x.settledP10)}/${money(x.settledP50)}/${money(x.settledP90)} · ${x.basis.toLowerCase()}${x.committed ? ` · commits ${money(x.committed)}` : ''}`;
  lines.push(`  reconstruct baseline ${v(r.baseline)} · ${r.evaluations} evaluation(s) of ${r.rounds.reduce((n, x) => n + x.tried.length, 0)} variant(s) in ${r.rounds.length} round(s)`);
  for (const d of r.diagnosis) lines.push(`    binding   ${d.factor.padEnd(11)} ${d.moved} → reach ${pct(d.reach)} (${d.liftReach >= 0 ? '+' : ''}${pct(d.liftReach)}), p50 ${money(d.settledP50)}`);
  lines.push(`    headroom  every factor favourable at once → reach ${pct(r.headroom.reach)}, p50 ${money(r.headroom.settledP50)}${r.structural ? ' · STRUCTURAL: the openings held cannot reach the requirement' : ''}`);
  for (const c of r.challenges) lines.push(`    challenge [${c.status}] ${c.assumption} — ${c.finding.slice(0, 300)}`);
  for (const round of r.rounds) {
    const sorted = [...round.tried].sort((a, b) => b.reach - a.reach || b.settledP50 - a.settledP50).slice(0, limit);
    for (const t of sorted) lines.push(`    round ${round.round}   ${t.key === round.kept ? '*' : ' '} ${t.key.slice(0, 70).padEnd(70)} ${t.feasible ? v(t) : `refused: ${t.why}`}`);
  }
  for (const p of r.volumePlans) lines.push(`    volume    ${p.sentence}`);
  lines.push(`    best      ${r.best.key} · ${v(r.best)}`);
  if (r.floor) lines.push(`    as-is     the same plan on the old campaigns' measured rates · ${v(r.floor)}`);
  lines.push(`    needs     ${r.requiredReply !== null ? `a reply rate of ${pct(r.requiredReply)} on every outreach opening for ${pct(r.required)}` : `no reply rate up to 15% reaches ${pct(r.required)}`}`);
  for (const c of [...r.best.changes].sort((a, b) => (a.startDay?.low ?? 0) - (b.startDay?.low ?? 0))) lines.push(`      day ${c.startDay ? `${c.startDay.low}–${c.startDay.high}` : '0'}`.padEnd(16) + `[${c.basis}] ${c.dimension}: ${c.detail}`);
  lines.push(`    confidence ${r.confidence.statement}`);
  for (const f of (r.flags ?? []).slice(0, 5)) lines.push(`    implausible ${f.key.slice(0, 70)} · reach ${pct(f.reach)}, p50 ${money(f.settledP50)} · ${f.flags.map((x) => `${x.kind}: ${x.detail}`).join('; ')}`);
  if (r.limitation) lines.push(`    limitation ${r.limitation}`);
  if (r.exploration) lines.push(...renderExploration(r.exploration));
  if (r.searchBrief) lines.push(`    brief     ${r.searchBrief}`);
  return lines;
}

/**
 * The daily volumes worth costing for this goal (planning recovery G-4): the
 * contacts a day its own remaining amount needs at the middle of the
 * conversion bounds and the openings' median price, beside the 10,000 a day the
 * owner asked about on the $10K goal. A fixed question only fits one goal.
 */
export function volumeQuestionsFor(openings: readonly ModelledOpportunity[], remaining: number, daysLeft: number): number[] {
  const prices = openings
    .map((o) => (o.price.low !== null && o.price.high !== null ? Math.sqrt(Math.max(1, o.price.low) * Math.max(1, o.price.high)) : o.price.value))
    .filter((p): p is number => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)]! : null;
  const middle = Math.sqrt(CONVERSION_BOUNDS.replyLow * CONVERSION_BOUNDS.replyHigh) * Math.sqrt(CONVERSION_BOUNDS.closeLow * CONVERSION_BOUNDS.closeHigh);
  const needed = median && daysLeft > 0 && remaining > 0 ? Math.ceil(remaining / daysLeft / (median * middle)) : null;
  const questions = needed && Number.isFinite(needed) && needed > 0 && needed !== 10_000 ? [needed, 10_000] : [10_000];
  return questions;
}
