/**
 * Which goal gets capacity first, and exactly why.
 *
 * Pure over a recorded snapshot, for `services/dispatch/router.ts`' reason:
 * "why is this goal ahead of that one" must be answerable from an input rather
 * than from a re-run against a database that has since moved. Being pure also
 * makes it useless as a safety mechanism, which is correct — what it decides is
 * an ordering, and the exclusion that keeps two workers off one bin is still
 * the compare-and-swap on the bin.
 *
 * Lexicographic over facts, in a declared order, never a weighted score. The
 * first criterion two goals differ on is the whole reason one is above the
 * other, and nothing below it was consulted — which is what lets
 * `explainAgainst` say so in one sentence.
 *
 * **Ranked within an owner, never across owners.** Four people run four
 * private operations on one fleet (§30, §34), and a ranking that put one
 * person's customer commitment above another person's everything would let one
 * operation's priorities decide how much capacity another operation gets. So
 * each owner's first goal gets the same bin priority, their second the next,
 * and the fleet interleaves them — which is also the only arrangement in which
 * one person's goals cannot be seen to affect another's allocation.
 */
import type { WorkstreamPurpose } from '../../domain/register.ts';
import type { GoalCommitment, PriorityCriterion } from '../../domain/goals.ts';

export interface PriorityFacts {
  id: string;
  ownerKey: string;
  /**
   * Active, not paused, cancelled or complete, not waiting on another goal, and
   * not stopped at a person's decision with nothing else it can run.
   */
  workable: boolean;
  commitment: GoalCommitment;
  dueAt: string | null;
  purpose: WorkstreamPurpose;
  /** How many other live goals declare they depend on this one. */
  dependents: number;
  createdAt: string;
}

export interface RankedGoal {
  id: string;
  ownerKey: string;
  /** 0-based within the owner. */
  rank: number;
  /** Why it is above the next one down, or null when it is last. */
  aboveNext: { criterion: PriorityCriterion; reason: string } | null;
  /** Why it is below the one above, or null when it is first. */
  belowPrevious: { criterion: PriorityCriterion; reason: string } | null;
}

const COMMITMENT_ORDER: Record<GoalCommitment, number> = { CUSTOMER: 0, INTERNAL: 1, NONE: 2 };
const PURPOSE_ORDER: Record<WorkstreamPurpose, number> = {
  REVENUE_DIRECT: 0,
  REVENUE_ENABLING: 1,
  CAPABILITY: 2,
  LONG_TERM: 3,
};

/**
 * The first criterion `a` and `b` differ on, negative when `a` comes first.
 *
 * A missing deadline sorts *after* any deadline, because a goal nobody put a
 * date on has not been shown to be more urgent than one somebody did — an
 * unknown is never the favourable reading (invariant 39).
 */
export function compareGoals(
  a: PriorityFacts,
  b: PriorityFacts,
): { criterion: PriorityCriterion; order: number } {
  if (a.workable !== b.workable) return { criterion: 'WORKABLE', order: a.workable ? -1 : 1 };
  const commitment = COMMITMENT_ORDER[a.commitment] - COMMITMENT_ORDER[b.commitment];
  if (commitment !== 0) return { criterion: 'COMMITMENT', order: commitment };
  if (a.dueAt !== b.dueAt) {
    if (a.dueAt === null) return { criterion: 'DEADLINE', order: 1 };
    if (b.dueAt === null) return { criterion: 'DEADLINE', order: -1 };
    return { criterion: 'DEADLINE', order: a.dueAt < b.dueAt ? -1 : 1 };
  }
  const purpose = PURPOSE_ORDER[a.purpose] - PURPOSE_ORDER[b.purpose];
  if (purpose !== 0) return { criterion: 'PURPOSE', order: purpose };
  if (a.dependents !== b.dependents) {
    return { criterion: 'UNBLOCKS', order: b.dependents - a.dependents };
  }
  if (a.createdAt !== b.createdAt) return { criterion: 'AGE', order: a.createdAt < b.createdAt ? -1 : 1 };
  return { criterion: 'TIE', order: a.id < b.id ? -1 : a.id > b.id ? 1 : 0 };
}

const PURPOSE_WORDS: Record<WorkstreamPurpose, string> = {
  REVENUE_DIRECT: 'pursues money directly',
  REVENUE_ENABLING: 'clears the way for money',
  CAPABILITY: 'builds a general capability',
  LONG_TERM: 'serves a longer-term goal',
};

/** One sentence naming the deciding fact, from the winner's side. */
export function explainAgainst(
  winner: PriorityFacts,
  loser: PriorityFacts,
  criterion: PriorityCriterion,
): string {
  switch (criterion) {
    case 'WORKABLE':
      return 'it can be worked now, and the other is paused, cancelled, finished, or waiting on another goal or on a person';
    case 'COMMITMENT':
      return winner.commitment === 'CUSTOMER'
        ? 'it is owed to a customer and the other is not'
        : 'it is committed to somebody and the other is not';
    case 'DEADLINE':
      return winner.dueAt && loser.dueAt
        ? `it is due ${winner.dueAt.slice(0, 10)}, before the other's ${loser.dueAt.slice(0, 10)}`
        : `it is due ${winner.dueAt?.slice(0, 10) ?? '—'} and the other has no deadline`;
    case 'PURPOSE':
      return `it ${PURPOSE_WORDS[winner.purpose]}, and the other ${PURPOSE_WORDS[loser.purpose]}`;
    case 'UNBLOCKS':
      return `${winner.dependents} other goal(s) wait on it, against ${loser.dependents}`;
    case 'AGE':
      return 'nothing else separates them, and it was set first';
    case 'TIE':
      return 'nothing recorded separates them; the order between them is by id only';
  }
}

/** Rank every goal within its owner. Deterministic, total, and explained. */
export function rankGoals(goals: PriorityFacts[]): RankedGoal[] {
  const byOwner = new Map<string, PriorityFacts[]>();
  for (const goal of goals) {
    const list = byOwner.get(goal.ownerKey);
    if (list) list.push(goal);
    else byOwner.set(goal.ownerKey, [goal]);
  }

  const out: RankedGoal[] = [];
  for (const [ownerKey, list] of [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...list].sort((a, b) => compareGoals(a, b).order);
    sorted.forEach((goal, index) => {
      const next = sorted[index + 1];
      const previous = sorted[index - 1];
      const aboveNext = next
        ? (() => {
            const { criterion } = compareGoals(goal, next);
            return { criterion, reason: explainAgainst(goal, next, criterion) };
          })()
        : null;
      const belowPrevious = previous
        ? (() => {
            const { criterion } = compareGoals(previous, goal);
            return { criterion, reason: explainAgainst(previous, goal, criterion) };
          })()
        : null;
      out.push({ id: goal.id, ownerKey, rank: index, aboveNext, belowPrevious });
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Capabilities: readiness kept apart from urgency, promoted by measured need */
/* ------------------------------------------------------------------------- */

/**
 * Where a proposed capability stands. Readiness answers "may it be worked on
 * now"; it says nothing about how pressing it is, and urgency says nothing about
 * whether it may start. Neither field is derived from the other.
 */
export const CAPABILITY_READINESS = [
  'SPECIFIED',
  'PREPOSITIONED',
  'NEEDED_NOW',
  'BUILDING',
  'VERIFIED',
  'SUSPENDED',
] as const;
export type CapabilityReadiness = (typeof CAPABILITY_READINESS)[number];

/** One transaction a missing capability is holding up, read from goal/cash rows. */
export interface BlockedTransaction {
  id: string;
  /** Null when no row states the value. An unknown value counts for nothing. */
  valueCents: number | null;
  /** The business the transaction belongs to, or null when unstated. */
  businessKey: string | null;
}

export interface CapabilityFacts {
  id: string;
  readiness: CapabilityReadiness;
  /** True only when every prerequisite is recorded as met; null is unknown. */
  prerequisitesMet: boolean | null;
  /** False when the need disappeared; null is unknown and never demotes or promotes. */
  needStillExists: boolean | null;
  dueAt: string | null;
  /** Measured from goal and cash rows. */
  blocked: BlockedTransaction[];
  /** What the current workaround costs over its horizon, or null if unmeasured. */
  workaroundCostCents: number | null;
  /** What building the reusable capability costs, or null if unestimated. */
  buildCostCents: number | null;
  /** A source, partner or interface changed so the old implementation fails. */
  interfaceChanged: boolean;
  /** Planned businesses, beyond those with blocked transactions, that would reuse it. */
  otherBeneficiaries: number | null;
  /** 0..1 chance the estimate is wrong; null is unknown and read as 1. */
  uncertainty: number | null;
  opportunityCostCents: number | null;
}

export type PromotionReason =
  | 'SEVERAL_BLOCKED_TRANSACTIONS'
  | 'WORKAROUND_COSTS_MORE'
  | 'SHARED_BY_BUSINESSES'
  | 'INTERFACE_CHANGED';

export interface PromotionDecision {
  /** Move SPECIFIED/PREPOSITIONED to NEEDED_NOW. */
  promote: boolean;
  reasons: PromotionReason[];
  /** The measured figures behind each reason, for the record. Never free text from a caller. */
  evidence: string[];
}

const PROMOTABLE: readonly CapabilityReadiness[] = ['SPECIFIED', 'PREPOSITIONED'];
const FINISHED_OR_SUSPENDED: readonly CapabilityReadiness[] = ['VERIFIED', 'SUSPENDED', 'BUILDING'];

function valuedBlocked(facts: CapabilityFacts): BlockedTransaction[] {
  return facts.blocked.filter((t) => typeof t.valueCents === 'number' && Number.isFinite(t.valueCents) && t.valueCents > 0);
}

function distinctBusinesses(facts: CapabilityFacts): number {
  const keys = new Set(facts.blocked.map((t) => t.businessKey).filter((k): k is string => !!k));
  const others = typeof facts.otherBeneficiaries === 'number' && facts.otherBeneficiaries > 0 ? facts.otherBeneficiaries : 0;
  return keys.size + others;
}

/**
 * Whether a prepared capability should be promoted, from what the rows measure.
 * A declared dependency edge is not required and is not consulted here. Unknown
 * inputs never produce a reason, and unmet or unknown prerequisites never promote.
 */
export function promotionFromBlockers(facts: CapabilityFacts): PromotionDecision {
  const none: PromotionDecision = { promote: false, reasons: [], evidence: [] };
  if (!PROMOTABLE.includes(facts.readiness)) return none;
  if (facts.needStillExists === false) return none;
  if (facts.prerequisitesMet !== true) return none;

  const reasons: PromotionReason[] = [];
  const evidence: string[] = [];

  const valued = valuedBlocked(facts);
  if (valued.length >= 2) {
    const total = valued.reduce((sum, t) => sum + (t.valueCents ?? 0), 0);
    reasons.push('SEVERAL_BLOCKED_TRANSACTIONS');
    evidence.push(`${valued.length} valued transactions blocked, ${total} cents in all`);
  }
  if (
    typeof facts.workaroundCostCents === 'number' &&
    typeof facts.buildCostCents === 'number' &&
    facts.workaroundCostCents > facts.buildCostCents
  ) {
    reasons.push('WORKAROUND_COSTS_MORE');
    evidence.push(`workaround ${facts.workaroundCostCents} cents against ${facts.buildCostCents} to build`);
  }
  const businesses = distinctBusinesses(facts);
  if (businesses >= 2) {
    reasons.push('SHARED_BY_BUSINESSES');
    evidence.push(`${businesses} businesses would use it`);
  }
  if (facts.interfaceChanged) {
    reasons.push('INTERFACE_CHANGED');
    evidence.push('an interface it depends on changed');
  }
  return { promote: reasons.length > 0, reasons, evidence };
}

/**
 * Work whose need disappeared is put down to SUSPENDED. The requirement is
 * never removed from the specification: `requirementRetained` is always true.
 * Only an explicit false demotes; an unknown need leaves the state alone.
 */
export function demotionForVanishedNeed(facts: CapabilityFacts): {
  demote: boolean;
  to: CapabilityReadiness;
  requirementRetained: true;
} {
  const demote = facts.needStillExists === false && !FINISHED_OR_SUSPENDED.includes(facts.readiness);
  return { demote, to: demote ? 'SUSPENDED' : facts.readiness, requirementRetained: true };
}

export interface RankedCapability {
  id: string;
  readiness: CapabilityReadiness;
  /** Separate from readiness: how pressing, from what the rows say. */
  urgency: { dueAt: string | null; blockedTransactions: number };
  rank: number;
  /** Net expected value after cost, opportunity cost and uncertainty. Unknowns add nothing. */
  netValueCents: number;
  reuse: number;
  /** Within the available parallel workers, in rank order. Unknown workers fit none. */
  startable: boolean;
  promotion: PromotionDecision;
}

/**
 * Rank capabilities that may be worked now, most worth doing first. Compares
 * urgency, then net value (expected value less cost and opportunity cost,
 * discounted by uncertainty), then reuse, then known cost. An unknown value or
 * reuse counts as zero, an unknown cost sorts after a known one and an unknown
 * uncertainty is the worst case, so no gap in the data raises a rank.
 * Capabilities that are not promoted and not already NEEDED_NOW sort last and
 * are never startable. Only the promoted capability is ranked, not its program.
 */
export function rankCapabilities(
  capabilities: CapabilityFacts[],
  options: { parallelWorkers: number | null },
): RankedCapability[] {
  const rows = capabilities.map((c) => {
    const promotion = promotionFromBlockers(c);
    const valued = valuedBlocked(c);
    const gross = valued.reduce((sum, t) => sum + (t.valueCents ?? 0), 0);
    const uncertainty = typeof c.uncertainty === 'number' && c.uncertainty >= 0 && c.uncertainty <= 1 ? c.uncertainty : 1;
    const cost = typeof c.buildCostCents === 'number' ? c.buildCostCents : null;
    const opportunity = typeof c.opportunityCostCents === 'number' ? c.opportunityCostCents : 0;
    const net = Math.round(gross * (1 - uncertainty)) - (cost ?? 0) - opportunity;
    const eligible =
      c.needStillExists !== false &&
      c.prerequisitesMet === true &&
      (c.readiness === 'NEEDED_NOW' || promotion.promote);
    return {
      c,
      promotion,
      eligible,
      net,
      cost,
      reuse: distinctBusinesses(c),
      blocked: c.blocked.length,
    };
  });

  rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.c.dueAt !== b.c.dueAt) {
      if (a.c.dueAt === null) return 1;
      if (b.c.dueAt === null) return -1;
      return a.c.dueAt < b.c.dueAt ? -1 : 1;
    }
    if (a.net !== b.net) return b.net - a.net;
    if (a.reuse !== b.reuse) return b.reuse - a.reuse;
    if (a.cost !== b.cost) {
      if (a.cost === null) return 1;
      if (b.cost === null) return -1;
      return a.cost - b.cost;
    }
    return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0;
  });

  const workers = typeof options.parallelWorkers === 'number' && options.parallelWorkers > 0 ? Math.floor(options.parallelWorkers) : 0;
  let slots = workers;
  return rows.map((r, index) => {
    const startable = r.eligible && slots > 0;
    if (startable) slots -= 1;
    return {
      id: r.c.id,
      readiness: r.c.readiness,
      urgency: { dueAt: r.c.dueAt, blockedTransactions: r.blocked },
      rank: index,
      netValueCents: r.net,
      reuse: r.reuse,
      startable,
      promotion: r.promotion,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* The consumer: facts built from goal and cash rows, then decided           */
/* ------------------------------------------------------------------------- */

/** A goal-side row that says a capability is holding a transaction up. */
export interface BlockedTransactionRow {
  transactionId: string;
  capabilityId: string;
  /** Cents from the cash row; null when no cash row states a value. */
  valueCents: number | null;
  businessKey: string | null;
}

/** What is recorded about a capability itself. Every figure is nullable: unknown stays unknown. */
export interface CapabilityRecordRow {
  id: string;
  readiness: CapabilityReadiness;
  prerequisitesMet: boolean | null;
  needStillExists: boolean | null;
  dueAt: string | null;
  workaroundCostCents: number | null;
  buildCostCents: number | null;
  interfaceChanged: boolean | null;
  otherBeneficiaries: number | null;
  uncertainty: number | null;
  opportunityCostCents: number | null;
}

/**
 * Build `CapabilityFacts` from rows. A blocked-transaction row naming a
 * capability that has no record is dropped rather than inventing a capability,
 * and a duplicate transaction id counts once. An unrecorded `interfaceChanged`
 * is false, never true: an unknown is not a reason to promote.
 */
export function capabilityFactsFromRows(
  capabilities: CapabilityRecordRow[],
  blocked: BlockedTransactionRow[],
): CapabilityFacts[] {
  const byCapability = new Map<string, Map<string, BlockedTransaction>>();
  for (const row of blocked) {
    let txs = byCapability.get(row.capabilityId);
    if (!txs) {
      txs = new Map();
      byCapability.set(row.capabilityId, txs);
    }
    if (!txs.has(row.transactionId)) {
      txs.set(row.transactionId, {
        id: row.transactionId,
        valueCents: row.valueCents,
        businessKey: row.businessKey,
      });
    }
  }
  return capabilities.map((c) => ({
    id: c.id,
    readiness: c.readiness,
    prerequisitesMet: c.prerequisitesMet,
    needStillExists: c.needStillExists,
    dueAt: c.dueAt,
    blocked: [...(byCapability.get(c.id)?.values() ?? [])],
    workaroundCostCents: c.workaroundCostCents,
    buildCostCents: c.buildCostCents,
    interfaceChanged: c.interfaceChanged === true,
    otherBeneficiaries: c.otherBeneficiaries,
    uncertainty: c.uncertainty,
    opportunityCostCents: c.opportunityCostCents,
  }));
}

export interface CapabilityReconciliation {
  ranked: RankedCapability[];
  /** Capabilities to move to NEEDED_NOW, with the measured reasons. */
  promotions: { id: string; decision: PromotionDecision }[];
  /** Capabilities to move to SUSPENDED because their need disappeared; never deleted. */
  demotions: { id: string; to: CapabilityReadiness; requirementRetained: true }[];
}

/**
 * One pass from rows to decisions: promote from measured blockers, demote
 * vanished needs, and rank what may be worked within the parallel workers.
 * Pure; the caller applies the transitions and records the events.
 */
export function reconcileCapabilities(
  capabilities: CapabilityRecordRow[],
  blocked: BlockedTransactionRow[],
  options: { parallelWorkers: number | null },
): CapabilityReconciliation {
  const facts = capabilityFactsFromRows(capabilities, blocked);
  const ranked = rankCapabilities(facts, options);
  const promotions = ranked.filter((r) => r.promotion.promote).map((r) => ({ id: r.id, decision: r.promotion }));
  const demotions = facts
    .map((f) => ({ id: f.id, ...demotionForVanishedNeed(f) }))
    .filter((d) => d.demote)
    .map(({ id, to, requirementRetained }) => ({ id, to, requirementRetained }));
  return { ranked, promotions, demotions };
}
