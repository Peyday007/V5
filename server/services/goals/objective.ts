/**
 * A goal's optimization objective (GOAL-18-4, S-0199/S-0200; GOAL-13-6, S-0107).
 *
 * A monetary target is a MINIMUM threshold, never a stopping point: a plan that
 * reaches it does not end the search for more value. What a goal optimizes is
 * configurable per goal and read from the goal's own words through
 * `interpretObjective` — the confidence it requires, and any targets it states
 * for expected collections, upside, downside protection, capability growth and
 * reusable capital. What the words do not state is recorded as the default it
 * fell back to (`RECOMMENDATION_POLICY.requiredProbability` for confidence),
 * never as something the owner said.
 *
 * A confidence goal is represented as what it is: "X% chance of at least T"
 * means a modelled probability of finishing below T of at most 1 − X, if the
 * model is reliable. It is never a worst-case floor. A cash floor is reported
 * only from enforceable mechanisms the rows establish — committed receivables,
 * escrow, deposits, guarantees — with its correlated and systemic limits
 * named; otherwise it is null and downside protection is quantified as a cash
 * buffer and over-target margin instead of being manufactured.
 *
 * Pure: no database, no clock beyond the one passed. The plan reads it.
 */
import { interpretObjective } from './objectivePlan.ts';
import type { Workstream } from '../../domain/register.ts';

/**
 * Brain's recorded default confidence when a goal states none — the value of
 * `RECOMMENDATION_POLICY.requiredProbability` in `plan.ts`. It is repeated here
 * rather than imported so this pure module does not load the plan's whole
 * service graph; `tests/program-ea512f54-goals-d1-p1-objective.test.ts`
 * refuses the two drifting apart.
 */
export const DEFAULT_REQUIRED_CONFIDENCE = 0.9;
export const DEFAULT_CONFIDENCE_SOURCE = 'RECOMMENDATION_POLICY.requiredProbability';

export type ObjectiveSource = 'STATED' | 'DEFAULT' | 'UNSTATED';

export interface ObjectiveTarget {
  /** Dollars for money targets; null when the goal states the aim without a figure, or not at all. */
  value: number | null;
  source: ObjectiveSource;
  /** The goal's own words this target was read from, or why there is none. */
  statement: string;
}

export interface GoalObjective {
  /** The target the goal counts, in dollars: a minimum threshold, not a stopping point. */
  threshold: number | null;
  /** Reaching the threshold never ends the search (S-0199). Always true; recorded so a reader sees the rule. */
  continueBeyondThreshold: true;
  requiredConfidence: { value: number; source: Exclude<ObjectiveSource, 'UNSTATED'>; statement: string };
  /** What a confidence goal means, in words a person reads. */
  meaning: string;
  targets: {
    expectedCollections: ObjectiveTarget;
    upside: ObjectiveTarget;
    downsideProtection: ObjectiveTarget;
    capabilityGrowth: ObjectiveTarget;
    reusableCapital: ObjectiveTarget;
  };
  /** Deadline in days, when the goal or its due date states one. */
  horizonDays: number | null;
}

type GoalWords = Pick<Workstream, 'title' | 'intent' | 'outcome' | 'dueAt'> & { target?: { amountCents: number } | null };

const MONEY = String.raw`\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b`;

function dollars(raw: string, suffix: string | undefined): number {
  const n = Number(raw.replace(/,/g, ''));
  const s = suffix?.toLowerCase();
  return s === 'k' ? n * 1_000 : s === 'm' ? n * 1_000_000 : n;
}

function textOf(goal: GoalWords): string {
  return [goal.title, goal.intent, goal.outcome].filter((one): one is string => !!one && !!one.trim()).join('. ').replace(/\s+/g, ' ').trim();
}

/** The confidence the goal's words require, as a fraction, or null when they state none. */
export function statedConfidence(text: string): { value: number; statement: string } | null {
  const patterns = [
    /\b(\d{1,3}(?:\.\d+)?)\s?%\s*(?:chance|confidence|probability|likelihood|likely|certain(?:ty)?|sure)\b/i,
    /\b(?:confidence|probability|likelihood|chance)\s+(?:of\s+|at\s+)?(?:at\s+least\s+)?(\d{1,3}(?:\.\d+)?)\s?%/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (!m) continue;
    const v = Number(m[1]) / 100;
    if (v > 0 && v < 1) return { value: v, statement: m[0] };
  }
  return null;
}

function statedMoney(text: string, cue: RegExp): { value: number; statement: string } | null {
  const m = new RegExp(cue.source + String.raw`[^.$]{0,30}?` + MONEY, 'i').exec(text);
  if (!m) return null;
  const groups = m.slice(1).filter((one) => one !== undefined);
  const suffix = /^(k|m)$/i.test(groups[groups.length - 1] ?? '') ? groups.pop() : undefined;
  const raw = groups[groups.length - 1];
  if (!raw) return null;
  return { value: dollars(raw, suffix), statement: m[0] };
}

function target(text: string, money: RegExp | null, aim: RegExp | null, unstated: string): ObjectiveTarget {
  const figure = money ? statedMoney(text, money) : null;
  if (figure) return { value: figure.value, source: 'STATED', statement: figure.statement };
  const word = aim ? aim.exec(text) : null;
  if (word) return { value: null, source: 'STATED', statement: word[0] };
  return { value: null, source: 'UNSTATED', statement: unstated };
}

/**
 * The goal's objective, read from its own words. Two goals stating different
 * confidences get different required thresholds; a goal stating none gets the
 * recorded default and says so.
 */
export function goalObjective(goal: GoalWords, now: Date = new Date(), defaultConfidence: number = DEFAULT_REQUIRED_CONFIDENCE): GoalObjective {
  const interp = interpretObjective(goal, now);
  const text = textOf(goal);
  const stated = statedConfidence(text);
  const requiredConfidence = stated
    ? { value: stated.value, source: 'STATED' as const, statement: stated.statement }
    : { value: defaultConfidence, source: 'DEFAULT' as const, statement: `no confidence stated; Brain's recorded default ${DEFAULT_CONFIDENCE_SOURCE} = ${defaultConfidence}` };
  const threshold = goal.target ? goal.target.amountCents / 100 : null;
  const deadline = interp.constraints.find((c) => c.kind === 'DEADLINE');
  const pct = Math.round(requiredConfidence.value * 1000) / 10;
  const below = Math.round((1 - requiredConfidence.value) * 1000) / 10;
  const t = threshold === null ? 'the target' : `$${threshold.toLocaleString('en-US')}`;
  return {
    threshold,
    continueBeyondThreshold: true,
    requiredConfidence,
    meaning: `a ${pct}% chance of at least ${t}: at most a ${below}% modelled probability of finishing below ${t}, if the model is reliable — not a guarantee that the worst outcome reaches ${t}`,
    targets: {
      expectedCollections: target(text, /\b(?:expect(?:ed)?|collect(?:ions)?|aim(?:ing)? for)\b/, null, 'no expected-collections target stated; the threshold is the minimum'),
      upside: target(text, /\b(?:stretch|upside|up to|ideally|exceed)\b/, /\b(?:exceed|overperform\w*|as much as possible|more if possible)\b/i, 'no upside target stated; upper-range outcomes are still searched'),
      downsideProtection: target(text, /\b(?:buffer|reserve|worst case|floor|never (?:fall|drop) below|downside)\b/, /\b(?:protect(?:ed)? (?:the )?downside|low[- ]risk|safe)\b/i, 'no downside target stated; the buffer and over-target margin are quantified, not assumed'),
      capabilityGrowth: target(text, null, /\b(?:build|grow|develop|learn)\w*\s+(?:a\s+|our\s+|new\s+)?(?:capabilit\w+|skills?|system|repeatable\s+\w+)/i, 'no capability-growth aim stated'),
      reusableCapital: target(text, /\b(?:reinvest|reusable|keep)\b/, /\b(?:reinvest\w*|reusable capital|compound\w*|fund (?:the )?next)\b/i, 'no reusable-capital aim stated'),
    },
    horizonDays: deadline?.value ?? null,
  };
}

// ---------------------------------------------------------------------------
// Readings of a settled distribution
// ---------------------------------------------------------------------------

/** One mechanism that makes cash enforceable before it settles. Only a row establishes one. */
export const FLOOR_MECHANISMS = ['COMMITTED_RECEIVABLE', 'ESCROW', 'DEPOSIT', 'GUARANTEE'] as const;
export type FloorMechanism = (typeof FLOOR_MECHANISMS)[number];

export interface EnforceableCommitment {
  kind: FloorMechanism;
  /** Dollars. */
  amount: number;
  /** Who owes it — the concentration a floor is limited by. */
  counterparty: string;
  /** The row that establishes it. A commitment without one is not counted. */
  sourceRowId: string | null;
  /** Settles inside the goal's horizon. */
  settlesInHorizon: boolean;
}

export interface OutcomeReading {
  /** Mean of the settled worlds. */
  expected: number;
  /** Upper-range outcome: the 90th percentile. */
  upper: number;
  /** Adverse case: the quantile at 1 − required confidence. */
  adverse: number;
  /** The adverse quantile read. */
  adverseQuantile: number;
  /** Share of worlds below the threshold. */
  modelledBelowTarget: number | null;
  /** At most this share may fall below the threshold for the confidence goal to hold. */
  allowedBelowTarget: number;
  /** Whether the modelled reading satisfies the confidence goal; null when the model is not calibrated or there is no threshold. */
  meetsConfidence: boolean | null;
  /** CANDIDATE until a calibrated model meets the configured objective; ACCEPTED only then (S-0107). */
  status: 'CANDIDATE' | 'ACCEPTED';
  /** Why a published confidence is withheld, when it is. */
  confidenceWithheld: string | null;
  /** A true cash floor from enforceable commitments; null when no row establishes one. */
  floor: { amount: number; mechanisms: FloorMechanism[]; limits: string[] } | null;
  /** Downside protection quantified instead of a manufactured floor. */
  protection: {
    /** Cash held now against the adverse case (dollars), when stated. */
    cashBuffer: number | null;
    /** Expected less threshold. */
    overTargetMargin: number | null;
    /** Adverse less threshold: negative means the adverse case falls short. */
    adverseMargin: number | null;
  };
  /** Surplus over the threshold available to finance successors; never a reason to stop. */
  surplusForSuccessors: number;
  continueExploring: true;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i]!;
}

/**
 * The cash floor the enforceable commitments establish, or null. Commitments
 * without a source row, or settling outside the horizon, do not count. A floor
 * still names what limits it: concentration in one counterparty, and the
 * systemic risk no contract removes.
 */
export function cashFloor(commitments: readonly EnforceableCommitment[]): OutcomeReading['floor'] {
  const counted = commitments.filter((c) => c.sourceRowId && c.settlesInHorizon && c.amount > 0);
  if (counted.length === 0) return null;
  const amount = counted.reduce((a, c) => a + c.amount, 0);
  const by = new Map<string, number>();
  for (const c of counted) by.set(c.counterparty, (by.get(c.counterparty) ?? 0) + c.amount);
  const limits: string[] = [];
  for (const [who, sum] of by) {
    if (sum / amount > 0.5) limits.push(`correlated: ${Math.round((sum / amount) * 100)}% of the floor depends on ${who}`);
  }
  if (counted.some((c) => c.kind === 'COMMITTED_RECEIVABLE')) limits.push('a committed receivable can still default; it is enforceable, not collected');
  limits.push('systemic: a payment-rail, banking or market-wide failure can delay or void every commitment at once');
  return { amount, mechanisms: [...new Set(counted.map((c) => c.kind))], limits };
}

/**
 * Read expected, upper-range and adverse outcomes from a settled distribution
 * (dollars per world) against the goal's objective. `calibrated` says whether
 * the model's inputs rest on evidence; without it the confidence is withheld
 * and the plan stays a CANDIDATE.
 */
export function readOutcome(
  objective: GoalObjective,
  settled: readonly number[],
  options: { calibrated: boolean; commitments?: readonly EnforceableCommitment[]; cashOnHand?: number | null; uncalibratedReason?: string } = { calibrated: false },
): OutcomeReading {
  const sorted = [...settled].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const expected = sorted.length ? sorted.reduce((a, v) => a + v, 0) / sorted.length : 0;
  const allowedBelowTarget = Math.round((1 - objective.requiredConfidence.value) * 1e9) / 1e9;
  const adverseQuantile = allowedBelowTarget;
  const threshold = objective.threshold;
  const modelledBelowTarget = threshold === null || sorted.length === 0 ? null : sorted.filter((v) => v < threshold).length / sorted.length;
  const calibrated = options.calibrated && sorted.length > 0;
  const meetsConfidence = !calibrated || modelledBelowTarget === null ? null : modelledBelowTarget <= allowedBelowTarget;
  const adverse = quantile(sorted, adverseQuantile);
  return {
    expected,
    upper: quantile(sorted, 0.9),
    adverse,
    adverseQuantile,
    modelledBelowTarget,
    allowedBelowTarget,
    meetsConfidence,
    status: meetsConfidence === true ? 'ACCEPTED' : 'CANDIDATE',
    confidenceWithheld: calibrated
      ? null
      : options.uncalibratedReason ?? 'the model is not calibrated: its inputs do not all rest on evidence, so no probability is published and the plan stays a candidate',
    floor: cashFloor(options.commitments ?? []),
    protection: {
      cashBuffer: options.cashOnHand ?? null,
      overTargetMargin: threshold === null ? null : expected - threshold,
      adverseMargin: threshold === null ? null : adverse - threshold,
    },
    surplusForSuccessors: threshold === null ? 0 : Math.max(0, expected - threshold),
    continueExploring: true,
  };
}

// ---------------------------------------------------------------------------
// Explicit trade-offs between plans
// ---------------------------------------------------------------------------

export interface PlanTradeOffInput {
  key: string;
  reading: OutcomeReading;
  /** Median days to the threshold's cash, when modelled. */
  daysToCash: number | null;
  /** Channels, suppliers or buyers this plan shares with others in the set. */
  sharedDependencies: readonly string[];
  /** Expected value of the best alternative the same capacity forgoes (dollars), when known. */
  forgoneAlternative: number | null;
}

export interface PlanTradeOff {
  key: string;
  /** Dollars per day of the expected outcome; null when no time to cash is modelled. */
  cashVelocity: number | null;
  /** Spread between upper and adverse readings, relative to expected. */
  uncertainty: number | null;
  sharedDependencies: string[];
  /** Expected less the forgone alternative; null when the alternative is unknown. */
  opportunityCost: number | null;
  /** Upper-range outcome above the threshold. */
  upside: number | null;
  status: OutcomeReading['status'];
}

export function tradeOffs(objective: GoalObjective, plans: readonly PlanTradeOffInput[]): PlanTradeOff[] {
  return plans.map((p) => ({
    key: p.key,
    cashVelocity: p.daysToCash && p.daysToCash > 0 ? p.reading.expected / p.daysToCash : null,
    uncertainty: p.reading.expected > 0 ? (p.reading.upper - p.reading.adverse) / p.reading.expected : null,
    sharedDependencies: [...p.sharedDependencies],
    opportunityCost: p.forgoneAlternative === null ? null : p.reading.expected - p.forgoneAlternative,
    upside: objective.threshold === null ? null : p.reading.upper - objective.threshold,
    status: p.reading.status,
  }));
}
