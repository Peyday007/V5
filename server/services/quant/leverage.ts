/**
 * Tracing commercial leverage (S-0103, COM-13-2).
 *
 * `composeArrangement` (mechanism.ts) composes any subset of seven levers onto
 * one arrangement and emits a node for each traced dimension. This module is
 * what reads them:
 *
 *   * `traceLeverage` enumerates every combination of the levers an
 *     arrangement carries, composes and resolves each, and reports the seven
 *     dimensions with the change each lever makes against the same
 *     combination without it;
 *   * `enforceConstraints` judges a combination against the limits that are
 *     real — cash exposure against cash available, the authority ceiling a
 *     person set, delivery capacity and contract terms — and names the one
 *     that binds. It has no revenue-ceiling input: a low owned balance limits
 *     a transaction only through the cash its exposure actually ties up;
 *   * `verifyPrepayment` says whether buyer willingness, refund obligations
 *     and the timing of usable funds against supplier payment are each
 *     established by evidence. What is not is UNKNOWN — a task, never an
 *     assumption (invariant 39);
 *   * `leverageOf` does all three for one arrangement; construction
 *     (`cash/construct.ts`) calls it on the arrangements it ranks best, with
 *     the evidence its parts hold and the limits the ledger and the live cash
 *     authority set, refuses one a real limit cannot fit, and asks research
 *     for what is not established;
 *   * `leverageHoldsOnRows` is the read-only probe reader: it reads what
 *     construction traced on production rows and reports it. It writes nothing.
 *
 * No store, scheduler or authority path of its own: it composes through the
 * existing composer and resolves through the existing `reconstruct`.
 */
import { composeArrangement, establishedEstimate, type Arrangement, type Levers, type TracedDimensions } from './mechanism.ts';
import { reconstruct } from './reconstruct.ts';
import type { Estimate, EvidenceTier } from '../../domain/quant.ts';

export const LEVER_KEYS = ['aiLabor', 'fulfilment', 'channel', 'marketing', 'prepayment', 'financing', 'sharedInfrastructure'] as const;
export type LeverKey = (typeof LEVER_KEYS)[number];

export const DIMENSIONS = ['cashConversion', 'margin', 'supplierRisk', 'deliveryCapacity', 'liability', 'acquisitionSpeed', 'repeatability'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** One traced quantity as read. `established` only when every leaf under it is evidence. */
export interface Reading {
  key: string;
  tier: EvidenceTier;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  established: boolean;
}

export const CONSTRAINT_KINDS = ['CASH_EXPOSURE', 'AUTHORITY', 'CAPACITY', 'CONTRACT'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/**
 * The real limits a combination is judged against, in the arrangement's
 * currency and transactions. Null is unknown, never unlimited. There is
 * deliberately no field for a revenue ceiling or for owned capital.
 */
export interface LeverageConstraints {
  cashAvailable?: number | null;
  authorityCeiling?: number | null;
  contractMax?: number | null;
}

export interface ConstraintVerdict {
  /** The constraint that allows the fewest transactions, among those that could be read. */
  binding: ConstraintKind | null;
  /** Transactions each constraint allows; null when it could not be read. */
  allows: Record<ConstraintKind, number | null>;
  allowed: number | null;
  /** Constraints that could not be read: questions, not permissions. */
  unknown: ConstraintKind[];
  detail: string;
}

export interface CombinationTrace {
  levers: LeverKey[];
  dimensions: Record<Dimension, Reading>;
  cashExposure: Reading;
  transactions: Reading;
  /** For each lever in the combination: p50 here minus p50 of the same combination without it; null when either side is not resolved. */
  deltas: Partial<Record<LeverKey, Record<Dimension, number | null>>>;
  constraint: ConstraintVerdict;
  prepaymentCredited: boolean;
}

export interface LeverageTrace {
  arrangement: string;
  levers: LeverKey[];
  combinations: CombinationTrace[];
  /** Combinations not traced because the arrangement carried more than the limit allows. */
  truncated: number;
}

/** The levers an arrangement carries, in a fixed order. */
export function leversOf(a: Arrangement): LeverKey[] {
  return LEVER_KEYS.filter((key) => a.levers?.[key] !== undefined);
}

/** Every subset of the given levers, the empty one first, smallest first. */
export function combinationsOf(levers: readonly LeverKey[]): LeverKey[][] {
  const out: LeverKey[][] = [];
  for (let mask = 0; mask < 1 << levers.length; mask++) out.push(levers.filter((_, i) => mask & (1 << i)));
  return out.sort((a, b) => a.length - b.length);
}

/** The arrangement with only the given levers; settlement terms and real limits are kept on every combination. */
function withLevers(a: Arrangement, keep: readonly LeverKey[]): Arrangement {
  const all = a.levers ?? {};
  const levers: Levers = {};
  for (const key of keep) (levers as Record<string, unknown>)[key] = all[key];
  if (all.settlementDays) levers.settlementDays = all.settlementDays;
  if (all.limits) levers.limits = all.limits;
  return { ...a, levers };
}

const finite = (x: number) => (Number.isFinite(x) ? x : null);

function read(estimates: Record<string, Estimate>, key: string): Reading {
  const est = estimates[key];
  if (!est || est.samples.length === 0) return { key, tier: est?.tier ?? 'UNKNOWN', p10: null, p50: null, p90: null, established: false };
  return { key, tier: est.tier, p10: finite(est.p10), p50: finite(est.p50), p90: finite(est.p90), established: est.distributionJustified };
}

/**
 * Resolve every traced dimension in one pass: a root that reads them all is
 * added to a copy of the graph, so `reconstruct` resolves each child once
 * and shares the memo. The root itself is never read.
 */
function resolveTraced(a: Arrangement, now: Date): { traced: TracedDimensions; transactions: string; estimates: Record<string, Estimate>; credited: boolean; formulas: Record<string, string> } {
  const composed = composeArrangement(a, { now });
  const traced = composed.traced!;
  const targets = [...DIMENSIONS.map((d) => traced[d]), traced.cashExposure, composed.transactions];
  const root = `${a.key}_trace_root`;
  const graph = { ...composed.graph, nodes: [...composed.graph.nodes, { key: root, label: 'Every traced dimension', unit: 'n/a', kind: 'REAL' as const, formula: targets.join(' + ') }] };
  const estimates = reconstruct(graph, root, now).estimates;
  // A target a short-circuited root left unvisited is resolved on its own.
  let all = estimates;
  for (const key of targets) if (!all[key]) all = { ...reconstruct(composed.graph, key, now).estimates, ...all };
  return { traced, transactions: composed.transactions, estimates: all, credited: composed.prepayment?.credited ?? false, formulas: composed.formulas };
}

/**
 * Judge a combination against the real limits and name the one that binds.
 * Capacity is the delivery capacity's median; exposure is read at its p90, so
 * a cash or authority limit is judged on the worst plausible tie-up.
 */
export function enforceConstraints(reading: { deliveryCapacity: Reading; cashExposure: Reading }, constraints: LeverageConstraints): ConstraintVerdict {
  const exposure = reading.cashExposure.p90;
  const perExposure = (money: number | null | undefined): number | null => {
    if (money === null || money === undefined || exposure === null) return null;
    return exposure > 0 ? money / exposure : Number.POSITIVE_INFINITY;
  };
  const allows: Record<ConstraintKind, number | null> = {
    CASH_EXPOSURE: perExposure(constraints.cashAvailable),
    AUTHORITY: perExposure(constraints.authorityCeiling),
    CAPACITY: reading.deliveryCapacity.p50,
    CONTRACT: constraints.contractMax ?? null,
  };
  const unknown = CONSTRAINT_KINDS.filter((kind) => allows[kind] === null);
  let binding: ConstraintKind | null = null;
  for (const kind of CONSTRAINT_KINDS) {
    const v = allows[kind];
    if (v === null) continue;
    if (binding === null || v < allows[binding]!) binding = kind;
  }
  const allowed = binding ? allows[binding] : null;
  const fmt = (x: number | null) => (x === null ? 'unknown' : Number.isFinite(x) ? x.toFixed(1) : 'unbounded');
  const detail =
    (binding ? `${binding} binds at ${fmt(allowed)} transaction(s)` : 'no constraint could be read') +
    `; ${CONSTRAINT_KINDS.map((k) => `${k}=${fmt(allows[k])}`).join(', ')}` +
    (unknown.length ? `; unknown: ${unknown.join(', ')}` : '');
  return { binding, allows, allowed, unknown, detail };
}

export interface TraceOptions {
  now?: Date;
  /** At most this many combinations are traced (2^7 = 128 covers every lever). */
  maxCombinations?: number;
}

/** Trace every combination of the levers an arrangement carries through the seven dimensions. */
export function traceLeverage(a: Arrangement, constraints: LeverageConstraints = {}, options: TraceOptions = {}): LeverageTrace {
  const now = options.now ?? new Date();
  const levers = leversOf(a);
  const all = combinationsOf(levers);
  const max = options.maxCombinations ?? 128;
  const chosen = all.slice(0, max);
  const byName = new Map<string, Omit<CombinationTrace, 'deltas'>>();
  const name = (set: readonly LeverKey[]) => set.join('+');
  for (const set of chosen) {
    const r = resolveTraced(withLevers(a, set), now);
    const dimensions = Object.fromEntries(DIMENSIONS.map((d) => [d, read(r.estimates, r.traced[d])])) as Record<Dimension, Reading>;
    const cashExposure = read(r.estimates, r.traced.cashExposure);
    byName.set(name(set), {
      levers: set,
      dimensions,
      cashExposure,
      transactions: read(r.estimates, r.transactions),
      constraint: enforceConstraints({ deliveryCapacity: dimensions.deliveryCapacity, cashExposure }, constraints),
      prepaymentCredited: r.credited,
    });
  }
  const combinations: CombinationTrace[] = chosen.map((set) => {
    const here = byName.get(name(set))!;
    const deltas: CombinationTrace['deltas'] = {};
    for (const lever of set) {
      const without = byName.get(name(set.filter((one) => one !== lever)));
      deltas[lever] = Object.fromEntries(
        DIMENSIONS.map((d) => {
          const x = here.dimensions[d].p50;
          const y = without?.dimensions[d].p50 ?? null;
          return [d, x === null || y === null ? null : x - y];
        }),
      ) as Record<Dimension, number | null>;
    }
    return { ...here, deltas };
  });
  return { arrangement: a.key, levers, combinations, truncated: all.length - chosen.length };
}

/* ------------------------------------------------------------- prepayment */

export type Establishment = 'ESTABLISHED' | 'UNKNOWN';

export interface PrepaymentVerification {
  arrangement: string;
  willingness: Establishment;
  refundObligations: Establishment;
  /** Both the days until prepaid money is usable and the days until the supplier must be paid. */
  timing: Establishment;
  /** Whether prepaid money is usable before the supplier is paid; null unless timing is established. */
  usableBeforeSupplierPayment: boolean | null;
  /** Whether the composer took the exposure credit (it never does on an unstated part). */
  credited: boolean;
  /** What remains to be established: research tasks. */
  tasks: string[];
}

const establishes = (est: Estimate | undefined): Establishment => (establishedEstimate(est) ? 'ESTABLISHED' : 'UNKNOWN');

/**
 * Per prepayment lever (an arrangement carries at most one): whether each
 * condition the credit rests on is established by evidence. A person's
 * assumed range, bounds or nothing at all is UNKNOWN.
 */
export function verifyPrepayment(a: Arrangement, now: Date = new Date()): PrepaymentVerification[] {
  if (!a.levers?.prepayment) return [];
  const composed = composeArrangement(withLevers(a, leversOf(a)), { now });
  const k = (n: string) => `${a.key}_${n}`;
  const resolveOne = (key: string) => (composed.graph.nodes.some((n) => n.key === key) ? reconstruct(composed.graph, key, now).estimates[key] : undefined);
  const willing = resolveOne(k('prepay_willingness'));
  const refund = resolveOne(k('prepay_refund_share'));
  const usable = resolveOne(k('prepay_usable_days'));
  // No supplier node means no supplier: the composer pays its own outlay on delivery, day 0.
  const hasSupplierDays = composed.graph.nodes.some((n) => n.key === k('supplier_payment_days'));
  const supplier = hasSupplierDays ? resolveOne(k('supplier_payment_days')) : undefined;
  const supplierEstablished = !hasSupplierDays || establishes(supplier) === 'ESTABLISHED';
  const supplierP10 = supplier?.p10 ?? 0;
  const supplierP90 = supplier?.p90 ?? 0;
  const willingness = establishes(willing);
  const refundObligations = establishes(refund);
  const timing: Establishment = establishes(usable) === 'ESTABLISHED' && supplierEstablished ? 'ESTABLISHED' : 'UNKNOWN';
  const usableBeforeSupplierPayment = timing === 'ESTABLISHED' ? usable!.p90 <= supplierP10 ? true : usable!.p10 > supplierP90 ? false : null : null;
  const tasks = [
    willingness === 'UNKNOWN' ? 'establish what share of these buyers will prepay, from a source' : null,
    refundObligations === 'UNKNOWN' ? 'establish the refund obligations on prepaid money (terms, law, observed refund share)' : null,
    timing === 'UNKNOWN' ? 'establish when prepaid funds become usable and when the supplier must be paid' : null,
    timing === 'ESTABLISHED' && usableBeforeSupplierPayment === null ? 'the usable-funds and supplier-payment ranges overlap: narrow them' : null,
  ].filter((one): one is string => !!one);
  return [{ arrangement: a.key, willingness, refundObligations, timing, usableBeforeSupplierPayment, credited: composed.prepayment?.credited ?? false, tasks }];
}

/* ------------------------------------------------------- the probe reader */

export interface LeverageRowsReport {
  ok: boolean;
  detail: string;
  projects: number;
  arrangements: number;
  combinations: number;
  /** Per dimension, how many traced combinations had it established vs not. */
  established: Record<Dimension, number>;
  unknown: Record<Dimension, number>;
  prepayment: { levers: number; credited: number; established: number };
  /** How many traced arrangements had each real limit readable, and how many a real limit refused. */
  limits: { cashAvailable: number; authorityCeiling: number; contractMax: number; refused: number };
  /** Arrangements whose transactions rest on a revenue ceiling or owned capital: each is a violation. */
  revenueCeilingViolations: string[];
}

export interface LeverageRowsDeps {
  projects?: () => Promise<Array<{ id: string }>>;
  /** Arrangements to trace for one project instead of reading what Brain's own construction traced. */
  arrangementsFor?: (projectId: string) => Promise<Arrangement[]>;
  /** At most this many arrangements per project. */
  perProject?: number;
  now?: Date;
}

const CEILING = /capital|revenue_ceiling|revenue_cap|owned_cash|owned_balance/;

/** Node keys the transactions node rests on, transitively. */
function ancestorsOf(graph: { nodes: Array<{ key: string; formula?: string }> }, start: string): Set<string> {
  const byKey = new Map(graph.nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const formula = byKey.get(key)?.formula;
    if (!formula) continue;
    for (const id of formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (byKey.has(id)) stack.push(id);
  }
  return seen;
}

/** Whether the arrangement's transactions are capped by a revenue ceiling or owned capital anywhere beneath them. */
export function revenueCeilingIn(a: Arrangement): boolean {
  const composed = composeArrangement(a);
  const byKey = new Map(composed.graph.nodes.map((n) => [n.key, n]));
  for (const key of ancestorsOf(composed.graph, composed.transactions)) {
    if (CEILING.test(key) || CEILING.test(byKey.get(key)?.label?.toLowerCase().replace(/\s+/g, '_') ?? '')) return true;
  }
  return false;
}

/**
 * What construction attaches to an arrangement it ranks highly: every lever
 * combination traced through the seven dimensions, judged against the real
 * limits it was given, and the prepayment conditions verified. Plain data, so
 * it crosses the evaluator pool's thread boundary and the construction memo.
 */
export interface ArrangementLeverage {
  levers: LeverKey[];
  combinations: CombinationTrace[];
  truncated: number;
  /** The real limits the combinations were judged against; null is unknown. */
  constraints: { cashAvailable: number | null; authorityCeiling: number | null; contractMax: number | null };
  prepayment: PrepaymentVerification[];
  /**
   * Set when, on the combination with every lever, an exposure established by
   * evidence lets a real limit allow less than one transaction: the
   * arrangement cannot run inside the cash, authority or contract it has.
   * Null otherwise — an exposure nobody established refuses nothing and
   * permits nothing (invariant 39).
   */
  refused: string | null;
  /** Whether its transactions rest on a revenue ceiling or owned capital anywhere beneath them: a violation. */
  revenueCeiling: boolean;
  /** What remains to be established before the leverage can be relied on: research tasks. */
  tasks: string[];
}

/** Trace, enforce and verify one arrangement's leverage, in one pass. */
export function leverageOf(a: Arrangement, constraints: LeverageConstraints, options: TraceOptions = {}): ArrangementLeverage {
  const now = options.now ?? new Date();
  const trace = traceLeverage(a, constraints, { now, maxCombinations: options.maxCombinations ?? 16 });
  const prepayment = verifyPrepayment(a, now);
  const full = trace.combinations.find((c) => c.levers.length === trace.levers.length) ?? null;
  let refused: string | null = null;
  if (full && full.cashExposure.established && full.constraint.allowed !== null && full.constraint.allowed < 1) refused = `${full.constraint.binding} allows ${full.constraint.allowed.toFixed(2)} transaction(s): ${full.constraint.detail}`;
  const unknownDims = full ? DIMENSIONS.filter((d) => !full.dimensions[d].established) : [];
  const tasks = [
    ...prepayment.flatMap((v) => v.tasks),
    ...(full && full.constraint.unknown.length ? [`establish the real limits not yet readable: ${full.constraint.unknown.join(', ')}`] : []),
    ...(unknownDims.length ? [`establish from a source what drives ${unknownDims.join(', ')}`] : []),
  ];
  return {
    levers: trace.levers,
    combinations: trace.combinations,
    truncated: trace.truncated,
    constraints: { cashAvailable: constraints.cashAvailable ?? null, authorityCeiling: constraints.authorityCeiling ?? null, contractMax: constraints.contractMax ?? null },
    prepayment,
    refused,
    revenueCeiling: revenueCeilingIn(a),
    tasks,
  };
}

/** One project's constructed arrangements as construction ranked and traced them. */
async function constructedFor(projectId: string): Promise<Array<{ key: string; leverage?: ArrangementLeverage; refusedByLeverage?: boolean }>> {
  const { constructArrangements } = await import('../cash/construct.ts');
  return constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 });
}

/**
 * The probe reader for r01.com-13-2: for each production project, trace the
 * arrangements Brain constructs and report how many combinations were traced,
 * which dimensions are established and which unknown, the prepayment
 * verification, and any arrangement limited by a revenue ceiling. Reads
 * through the existing construction entry point and repositories; writes
 * nothing. Holds when combinations were traced and no ceiling was found.
 */
export async function leverageHoldsOnRows(deps: LeverageRowsDeps = {}): Promise<LeverageRowsReport> {
  const now = deps.now ?? new Date();
  const perProject = deps.perProject ?? 10;
  const projects = deps.projects ? await deps.projects() : await (await import('../../repos/projects.ts')).listProjects();
  const zero = () => Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<Dimension, number>;
  const established = zero();
  const unknown = zero();
  const prepayment = { levers: 0, credited: 0, established: 0 };
  const limits = { cashAvailable: 0, authorityCeiling: 0, contractMax: 0, refused: 0 };
  const violations: string[] = [];
  let arrangements = 0;
  let combinations = 0;
  const count = (leverage: ArrangementLeverage) => {
    for (const c of leverage.combinations) {
      combinations += 1;
      for (const d of DIMENSIONS) (c.dimensions[d].established ? established : unknown)[d] += 1;
    }
    for (const v of leverage.prepayment) {
      prepayment.levers += 1;
      if (v.credited) prepayment.credited += 1;
      if (v.willingness === 'ESTABLISHED' && v.refundObligations === 'ESTABLISHED' && v.timing === 'ESTABLISHED') prepayment.established += 1;
    }
    if (leverage.constraints.cashAvailable !== null) limits.cashAvailable += 1;
    if (leverage.constraints.authorityCeiling !== null) limits.authorityCeiling += 1;
    if (leverage.constraints.contractMax !== null) limits.contractMax += 1;
    if (leverage.refused) limits.refused += 1;
  };
  for (const p of projects) {
    if (deps.arrangementsFor) {
      // An injected arrangement set is traced here, against no limits.
      for (const a of (await deps.arrangementsFor(p.id)).slice(0, perProject)) {
        arrangements += 1;
        const leverage = leverageOf(a, {}, { now });
        if (leverage.revenueCeiling) violations.push(`${p.id}:${a.key}`);
        count(leverage);
      }
      continue;
    }
    // The running Brain's own reading: what construction traced, with the evidence and limits it holds.
    for (const one of (await constructedFor(p.id)).filter((x) => x.leverage).slice(0, perProject)) {
      arrangements += 1;
      if (one.leverage!.revenueCeiling) violations.push(`${p.id}:${one.key}`);
      count(one.leverage!);
    }
  }
  const detail =
    arrangements === 0
      ? `no arrangement is constructed on production rows yet (${projects.length} project(s))`
      : `${combinations} lever combination(s) traced over ${arrangements} arrangement(s) in ${projects.length} project(s); established: ` +
        DIMENSIONS.map((d) => `${d}=${established[d]}/${established[d] + unknown[d]}`).join(', ') +
        `; prepayment levers ${prepayment.levers}, verified ${prepayment.established}, credited ${prepayment.credited}` +
        `; limits read: cash ${limits.cashAvailable}, authority ${limits.authorityCeiling}, contract ${limits.contractMax}; refused by a real limit ${limits.refused}` +
        (violations.length ? `; REVENUE CEILING on ${violations.join(', ')}` : '; no transaction limited by a revenue ceiling');
  return { ok: combinations > 0 && violations.length === 0, detail, projects: projects.length, arrangements, combinations, established, unknown, prepayment, limits, revenueCeilingViolations: violations };
}
