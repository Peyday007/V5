/**
 * Which fallbacks to prepare first (FALL-37-6).
 *
 * A pure ranking over the dependencies and substitutes `fallbacks.ts`
 * exports. It decides the order in which fallbacks are prepared, and nothing
 * else:
 *
 *  - **Consequence sets the priority.** A fallback whose dependency's failure
 *    could cause financial loss, an unauthorized external action, a broken
 *    customer commitment, lost data, a corrupted economic decision or a
 *    blocked revenue objective ranks above one whose failure causes none of
 *    these. Each entry states the class that decided it. The six classes are
 *    the ones the specification names; a caller may name another, which ranks
 *    as a consequence too (no list here is a whitelist, R01-A1).
 *  - **Cheap reversible backups are prepared early.** Among equal
 *    consequence, a substitute whose switching cost is known and within the
 *    caller's low-cost ceiling, and whose switch is on record as reversible,
 *    ranks first and is marked for early preparation. An unknown cost or an
 *    unstated reversibility is not read as cheap or reversible (invariant 39).
 *  - **A live dependency promotes its safeguard.** When the caller states
 *    that a live dependency makes a safeguard necessary now, that safeguard
 *    moves ahead of nominal priority and the reason is recorded on the entry.
 *    A promotion without a stated reason is refused rather than guessed.
 *  - **Ongoing work is never paused.** The ranking orders preparation of
 *    fallbacks; it emits no action, and nothing in it pauses or reorders
 *    commercial discovery or execution (invariant 40).
 *
 * It owns nothing: no table, schedule, queue or control plane (§10.3, §20.4).
 * Figures are `graph.ts` figures, eligibility is `fallbacks.ts` `ineligibility`,
 * and the authorization, research-recovery, Factory-repair and ledger owners
 * named in `REUSED_OWNERS` remain the owners of everything this ranking
 * informs.
 */
import type { Figure } from './graph.ts';
import { changesMechanism, ineligibility, type Dependency, type Substitute } from './fallbacks.ts';

/* ------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* ------------------------------------------------------------------------- */

/** The consequence classes the specification names, in the order it names them. */
export const CONSEQUENCE_CLASSES = [
  'FINANCIAL_LOSS',
  'UNAUTHORIZED_EXTERNAL_ACTION',
  'BROKEN_CUSTOMER_COMMITMENT',
  'LOST_DATA',
  'CORRUPTED_ECONOMIC_DECISION',
  'BLOCKED_REVENUE_OBJECTIVE',
] as const;

export type ConsequenceClass = (typeof CONSEQUENCE_CLASSES)[number] | (string & {});

/** The existing owners this ranking reuses by reference. It writes to none of them. */
export const REUSED_OWNERS = {
  authorization: 'server/services/cash/authority.ts',
  researchRecovery: 'server/services/research/repair.ts',
  factoryRepair: 'server/services/factory/repair.ts',
  ledger: 'server/services/quant/ledger.ts',
  fallbackStructure: 'server/services/quant/fallbacks.ts',
} as const;

/** One dependency handed to the ranking, with what the caller knows about its consequences. */
export interface PriorityInput {
  dependency: Dependency;
  /** The consequence classes a failure of this dependency could cause, each with what it rests on. Empty when none. */
  consequences: Array<{ class: ConsequenceClass; basis: string }>;
  /** The order the caller would otherwise prepare it in; lower is earlier. */
  nominalPriority: number;
  /** Present when a live dependency makes its safeguards necessary now. */
  live?: { necessary: boolean; reason: string };
  /** Per substitute key: true only when switching to it is on record as reversible. */
  reversible?: Record<string, boolean>;
  /** Switching costs at or under this, in its unit, count as low cost. Unknown when not given. */
  lowCostCeiling?: Figure;
}

export type DecidedBy = 'LIVE_DEPENDENCY' | ConsequenceClass | 'NO_CONSEQUENCE';

export interface RankedFallback {
  rank: number;
  dependency: string;
  substitute: string;
  /** What decided its place. */
  decidedBy: DecidedBy;
  /** Every consequence class the dependency carries. */
  consequenceClasses: ConsequenceClass[];
  nominalPriority: number;
  /** True when a live dependency moved it ahead of nominal priority. */
  promoted: boolean;
  /** Why it was promoted, when it was. */
  promotedBecause: string | null;
  lowCost: boolean | null;
  reversible: boolean | null;
  /** Low cost and reversible: prepare it early. */
  prepareEarly: boolean;
  /** Whether it is eligible under `fallbacks.ts`, and why not. Ranking does not make an ineligible substitute eligible. */
  eligible: boolean;
  ineligibleBecause: string[];
  changesMechanism: boolean;
  /** Plain statement of why it sits where it does. */
  reason: string;
}

export interface FallbackRanking {
  ranked: RankedFallback[];
  /** Always true: the ranking orders preparation only and emits no action on discovery or execution. */
  preservesOngoingWork: true;
  owners: typeof REUSED_OWNERS;
}

/* ------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* ------------------------------------------------------------------------- */

const known = (figure: Figure | null | undefined): figure is Figure & { value: number } =>
  !!figure && figure.status !== 'UNKNOWN' && figure.value !== null && Number.isFinite(figure.value);

function classOrder(one: ConsequenceClass): number {
  const at = (CONSEQUENCE_CLASSES as readonly string[]).indexOf(one);
  return at === -1 ? CONSEQUENCE_CLASSES.length : at;
}

/** The class that decides: the first, in the specification's order, of those the dependency carries. */
export function decidingClass(consequences: PriorityInput['consequences']): ConsequenceClass | null {
  const sorted = [...consequences].sort((a, b) => classOrder(a.class) - classOrder(b.class) || String(a.class).localeCompare(String(b.class)));
  return sorted[0]?.class ?? null;
}

/** Whether a substitute's switch is low cost: true, false, or null when its cost or the ceiling is unknown. */
export function isLowCost(substitute: Substitute, ceiling: Figure | undefined): boolean | null {
  if (!known(substitute.switchingCost) || !known(ceiling)) return null;
  if (substitute.switchingCost.unit !== ceiling.unit) return null;
  return substitute.switchingCost.value <= ceiling.value;
}

interface Scored {
  entry: Omit<RankedFallback, 'rank' | 'reason'>;
  consequenceCount: number;
  cashAtRisk: number;
}

function score(input: PriorityInput, substitute: Substitute): Scored {
  if (input.live?.necessary && input.live.reason.trim() === '') {
    throw new Error(`A live promotion of ${input.dependency.key} needs a stated reason.`);
  }
  const promoted = input.live?.necessary === true;
  const deciding = decidingClass(input.consequences);
  const lowCost = isLowCost(substitute, input.lowCostCeiling);
  const reversible = input.reversible && substitute.key in input.reversible ? input.reversible[substitute.key]! : null;
  const why = ineligibility(substitute);
  const cash = input.dependency.consequence.cashAtRisk;
  return {
    entry: {
      dependency: input.dependency.key,
      substitute: substitute.key,
      decidedBy: promoted ? 'LIVE_DEPENDENCY' : (deciding ?? 'NO_CONSEQUENCE'),
      consequenceClasses: input.consequences.map((one) => one.class),
      nominalPriority: input.nominalPriority,
      promoted,
      promotedBecause: promoted ? input.live!.reason : null,
      lowCost,
      reversible,
      prepareEarly: lowCost === true && reversible === true,
      eligible: why.length === 0,
      ineligibleBecause: why,
      changesMechanism: changesMechanism(substitute),
    },
    consequenceCount: input.consequences.length,
    cashAtRisk: known(cash) ? cash.value : -Infinity,
  };
}

function compare(a: Scored, b: Scored): number {
  const x = a.entry;
  const y = b.entry;
  if (x.promoted !== y.promoted) return x.promoted ? -1 : 1;
  const hasX = x.consequenceClasses.length > 0;
  const hasY = y.consequenceClasses.length > 0;
  if (hasX !== hasY) return hasX ? -1 : 1;
  if (a.consequenceCount !== b.consequenceCount) return b.consequenceCount - a.consequenceCount;
  if (a.cashAtRisk !== b.cashAtRisk) return b.cashAtRisk - a.cashAtRisk;
  if (x.prepareEarly !== y.prepareEarly) return x.prepareEarly ? -1 : 1;
  if (x.nominalPriority !== y.nominalPriority) return x.nominalPriority - y.nominalPriority;
  return x.dependency.localeCompare(y.dependency) || x.substitute.localeCompare(y.substitute);
}

function explain(entry: Omit<RankedFallback, 'rank' | 'reason'>): string {
  const parts: string[] = [];
  if (entry.promoted) parts.push(`promoted ahead of nominal priority ${entry.nominalPriority}: ${entry.promotedBecause}`);
  if (entry.decidedBy === 'NO_CONSEQUENCE') parts.push('its dependency carries no named consequence class');
  else if (entry.decidedBy !== 'LIVE_DEPENDENCY') parts.push(`decided by ${entry.decidedBy}`);
  else if (entry.consequenceClasses.length > 0) parts.push(`consequences: ${entry.consequenceClasses.join(', ')}`);
  if (entry.prepareEarly) parts.push('low cost and reversible: prepare early');
  else if (entry.lowCost === null) parts.push('switching cost or low-cost ceiling unknown: not read as cheap');
  else if (entry.reversible === null) parts.push('reversibility not on record: not read as reversible');
  if (!entry.eligible) parts.push(`not yet eligible to switch to: ${entry.ineligibleBecause.join('; ')}`);
  return parts.join('; ');
}

/**
 * Rank every substitute of every dependency for preparation. Pure: the same
 * inputs give the same order, and nothing is written, scheduled or paused.
 */
export function rankFallbacks(inputs: readonly PriorityInput[]): FallbackRanking {
  const scored = inputs.flatMap((input) => input.dependency.substitutes.map((one) => score(input, one)));
  scored.sort(compare);
  return {
    ranked: scored.map((one, i) => ({ ...one.entry, rank: i + 1, reason: explain(one.entry) })),
    preservesOngoingWork: true,
    owners: REUSED_OWNERS,
  };
}
