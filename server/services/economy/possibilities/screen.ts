/**
 * The cheap, deterministic screen for a kept possibility, and the pure graph
 * reads over its edges (chains, reach, what to research next).
 *
 * Numeric facts live in the open requirement lists as `name:value` entries
 * (`ownerCapitalCents:700000`, `paidAfterDays:45`), so the store keeps its open
 * shape. A fact nobody stated is absent, and an absent fact HOLDs: an unknown
 * is never a favourable assumption.
 */
import type {
  Possibility, PossibilityEdge, PossibilityRequirements,
} from '../../../domain/economy.ts';

export interface GoalLimits {
  /** The most owner capital the goal permits at risk. Null: no limit stated. */
  capitalLimitCents: number | null;
  /** Days until cash is needed. Null: no cash deadline stated. */
  cashDeadlineDays: number | null;
}

export type ScreenVerdict = 'REJECT' | 'HOLD' | 'ADVANCE';

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Every reason, naming the limit or the missing fact. */
  reasons: string[];
  /** Condition keys that would make this worth reconsidering. */
  watch: string[];
  /** A deep job is launched only for ADVANCE; the screen itself never launches one. */
  launchDeep: boolean;
}

export const CAPITAL_FACT = 'ownerCapitalCents';
export const PAID_AFTER_FACT = 'paidAfterDays';
export const CAPITAL_LIMIT_KEY = 'CAPITAL_LIMIT';
export const CASH_DEADLINE_KEY = 'CASH_DEADLINE';
export const factKey = (name: string): string => `FACT:${name}`;

export function numericFact(requirements: PossibilityRequirements, name: string): number | null {
  for (const list of Object.values(requirements)) {
    for (const entry of list ?? []) {
      const at = entry.indexOf(':');
      if (at < 0 || entry.slice(0, at).trim() !== name) continue;
      const value = Number(entry.slice(at + 1).trim());
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

export function screenPossibility(requirements: PossibilityRequirements, limits: GoalLimits): ScreenResult {
  const reasons: string[] = [];
  const watch: string[] = [];
  let rejected = false;
  const checks: { fact: string; limit: number | null; over: (v: number, l: number) => string; key: string }[] = [
    {
      fact: CAPITAL_FACT, limit: limits.capitalLimitCents, key: CAPITAL_LIMIT_KEY,
      over: (v, l) => `Owner capital ${v} cents exceeds the goal's limit of ${l} cents.`,
    },
    {
      fact: PAID_AFTER_FACT, limit: limits.cashDeadlineDays, key: CASH_DEADLINE_KEY,
      over: (v, l) => `Paid after ${v} days, past the cash deadline of ${l} days.`,
    },
  ];
  const missing: string[] = [];
  for (const check of checks) {
    if (check.limit === null) continue;
    const value = numericFact(requirements, check.fact);
    if (value === null) {
      missing.push(check.fact);
    } else if (value > check.limit) {
      rejected = true;
      reasons.push(check.over(value, check.limit));
      watch.push(check.key);
    }
  }
  if (rejected) return { verdict: 'REJECT', reasons, watch, launchDeep: false };
  if (missing.length > 0) {
    return {
      verdict: 'HOLD',
      reasons: missing.map((name) => `${name} is not stated, so the limit cannot be checked.`),
      watch: missing.map(factKey),
      launchDeep: false,
    };
  }
  return { verdict: 'ADVANCE', reasons: [], watch: [], launchDeep: true };
}

/* ------------------------------------------------------------------------ */
/* Graph reads                                                               */
/* ------------------------------------------------------------------------ */

/** Relations along which one possibility opens another. */
const FORWARD = new Set(['ENABLES', 'UNLOCKS_AFTER', 'SUPPLIES']);

function forwardMap(edges: PossibilityEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!FORWARD.has(e.relation)) continue;
    out.set(e.fromId, [...(out.get(e.fromId) ?? []), e.toId]);
  }
  return out;
}

/** How many other possibilities this one leads to, directly or through others. */
export function reachOf(id: string, edges: PossibilityEdge[]): number {
  const out = forwardMap(edges);
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    for (const next of out.get(stack.pop()!) ?? []) {
      if (next === id || seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen.size;
}

/** Every path from `fromId` along forward edges, longest chains of opportunity first. */
export function chainsFrom(fromId: string, edges: PossibilityEdge[]): string[][] {
  const out = forwardMap(edges);
  const chains: string[][] = [];
  const walk = (path: string[]): void => {
    const nexts = (out.get(path[path.length - 1]!) ?? []).filter((n) => !path.includes(n));
    if (nexts.length === 0) {
      if (path.length > 1) chains.push(path);
      return;
    }
    for (const n of nexts) walk([...path, n]);
  };
  walk([fromId]);
  return chains.sort((a, b) => b.length - a.length || a.join().localeCompare(b.join()));
}

/**
 * Every candidate in the order research should take them: positive reach
 * first, strongest first, then the zero-reach ones. Ties keep the caller's own
 * order, so reach refines a ranking rather than replacing it. A consumer that
 * walks this list and stops when its budget is spent therefore reaches a
 * zero-reach candidate only after every stronger one was taken or passed over.
 */
export function researchOrder<T extends Pick<Possibility, 'id'>>(
  candidates: T[], edges: PossibilityEdge[],
): { candidate: T; reach: number }[] {
  const scored = candidates.map((candidate, index) => ({ candidate, index, reach: reachOf(candidate.id, edges) }));
  scored.sort((a, b) => b.reach - a.reach || a.index - b.index);
  return scored.map(({ candidate, reach }) => ({ candidate, reach }));
}

/**
 * What may be researched next. A zero-reach candidate is passed over while any
 * stronger (higher-reach) unexplored candidate remains; it becomes eligible
 * only when nothing stronger is left. `goals/pathResearch.ts` is the production
 * consumer: it walks `researchOrder`, which applies this same rule one opening
 * at a time.
 */
export function researchNext(
  candidates: Pick<Possibility, 'id'>[], edges: PossibilityEdge[], explored: ReadonlySet<string>,
): string[] {
  const open = researchOrder(candidates.filter((c) => !explored.has(c.id)), edges);
  const strong = open.filter((c) => c.reach > 0);
  return (strong.length > 0 ? strong : open).map((c) => c.candidate.id);
}
