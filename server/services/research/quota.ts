/**
 * What to run next, and what to do when the allowance runs out.
 *
 * Quota is a real constraint on a local research worker: the user has a finite
 * number of jobs per day, and spending them in the order the fragments happened
 * to be planned wastes them. So execution is ordered by what the assignment
 * actually depends on — settle the boundary before researching inside it,
 * establish a premise before the fragment that rests on it, resolve a
 * contradiction before synthesizing around it.
 *
 * The one thing that never moves is the evidence bar. Running low on quota is a
 * reason to do less work, never a reason to accept weaker work: a fragment that
 * cannot clear its gate stays blocked whether the allowance is full or empty.
 * And spending the user's money is never a default — a paid overage happens only
 * when they have turned it on, and the pause says so plainly when they have not.
 */
import type { ProviderQuota, ResearchFragment } from '../../domain/types.ts';
import type { AIProvider } from '../../providers/types.ts';

/**
 * The order the spec asks for, most urgent first.
 *
 * It is a dependency order more than a preference: everything below a tier is
 * cheaper to get right once the tier above it is settled.
 */
export const PRIORITY_TIERS = [
  'BOUNDARY_AND_DEFINITION',
  'FOUNDATIONAL_EVIDENCE',
  'CALCULATION_INPUT',
  'CONTRADICTION_RESOLUTION',
  'MANDATORY_SYNTHESIS_INPUT',
  'SUPPORTING_CONTEXT',
  'OPTIONAL_ENRICHMENT',
] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export interface TierAssignment {
  tier: PriorityTier;
  /** 1-based, and stored as the fragment's priority so the queue can sort on it. */
  rank: number;
  reason: string;
}

function assign(tier: PriorityTier, reason: string): TierAssignment {
  return { tier, rank: PRIORITY_TIERS.indexOf(tier) + 1, reason };
}

/**
 * What a tier decision is made from.
 *
 * Written against the planned brief as well as the stored fragment, because the
 * tier has to be known before the row exists — that is what decides the order
 * the fragments are stored with in the first place.
 */
export interface TierInput {
  fragmentKey: string;
  dependsOn?: string[];
  requirementIds?: string[];
  expectedClaimTypes?: string[];
  requiredCalculations?: string[];
  contradictionTargets?: string[];
  evidenceLane?: string | null;
  priority?: number;
}

/** Everything that names this fragment as a premise. */
function dependents(fragment: TierInput, all: TierInput[]): number {
  return all.filter((entry) => (entry.dependsOn ?? []).includes(fragment.fragmentKey)).length;
}

/**
 * Which tier a fragment belongs to.
 *
 * Deliberately reads the fragment rather than a stored label: a fragment that
 * was split, repaired or re-planned can change tier, and a stale label would
 * quietly spend quota in the wrong order.
 */
export function tierOf(fragment: TierInput, all: TierInput[]): TierAssignment {
  // A boundary question is planned with no requirement behind it, because it is
  // what decides which requirements are even in scope.
  if ((fragment.requirementIds ?? []).length === 0) {
    return assign('BOUNDARY_AND_DEFINITION', 'The assignment cannot be scoped until this is settled.');
  }
  if ((fragment.evidenceLane ?? '').toLowerCase().includes('definition')) {
    return assign(
      'BOUNDARY_AND_DEFINITION',
      'Everything measured on this term depends on which definition is meant.',
    );
  }
  if ((fragment.contradictionTargets ?? []).length > 0) {
    return assign(
      'CONTRADICTION_RESOLUTION',
      'The archive already disagrees with itself here, so further evidence built on it is unsafe.',
    );
  }
  if (
    (fragment.requiredCalculations ?? []).length > 0 ||
    (fragment.expectedClaimTypes ?? []).includes('CALCULATION')
  ) {
    return assign('CALCULATION_INPUT', 'A calculation cannot be checked until its inputs are evidenced.');
  }
  if (dependents(fragment, all) > 0) {
    return assign('FOUNDATIONAL_EVIDENCE', 'Other fragments rest on this one and would be researched blind.');
  }
  // Necessity comes through as the planner's priority: 1 mandatory, 5
  // supporting, 8 optional.
  const necessity = fragment.priority ?? 5;
  if (necessity <= 1) {
    return assign('MANDATORY_SYNTHESIS_INPUT', 'The synthesis cannot be written without it.');
  }
  if (necessity <= 5) {
    return assign('SUPPORTING_CONTEXT', 'It strengthens the report without being load-bearing.');
  }
  return assign('OPTIONAL_ENRICHMENT', 'Worth having if the allowance stretches to it.');
}

/**
 * Stamp the execution tier onto a set of planned fragment briefs.
 *
 * Priority is the tier, so every later decision — which job runs next, which
 * bundle inherits which urgency — sorts on the same number.
 */
export function assignExecutionPriority<T extends TierInput>(briefs: T[]): T[] {
  for (const brief of briefs) {
    brief.priority = tierOf(brief, briefs).rank;
  }
  return briefs;
}

const EFFORT_ORDER: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Order the fragments that are ready to run right now.
 *
 * Every fragment here already has its dependencies settled, so reordering is
 * safe — what it decides is only which of several runnable things is worth the
 * next slice of the allowance.
 */
export function executionOrder(ready: ResearchFragment[], all: ResearchFragment[]): ResearchFragment[] {
  const ranked = ready.map((fragment) => ({
    fragment,
    rank: tierOf(fragment, all).rank,
    unblocks: dependents(fragment, all),
    effort: EFFORT_ORDER[fragment.estimatedEffort ?? 'MEDIUM'] ?? 1,
  }));
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Whatever unblocks the most work next is worth the slot.
    if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks;
    // A repair is work already half paid for; finish it before opening new work.
    if (a.fragment.attempt !== b.fragment.attempt) return b.fragment.attempt - a.fragment.attempt;
    if (a.effort !== b.effort) return a.effort - b.effort;
    return a.fragment.fragmentIndex - b.fragment.fragmentIndex;
  });
  return ranked.map((entry) => entry.fragment);
}

// ---------------------------------------------------------------------------
// The allowance itself
// ---------------------------------------------------------------------------

export interface QuotaDecision {
  /** False means: stop launching jobs, keep everything, and say why. */
  canRun: boolean;
  quota: ProviderQuota;
  /** A sentence for the user, never a provider error string. */
  detail: string;
  /** True when the only thing standing between the run and the work is money. */
  overageWouldHelp: boolean;
}

const UNKNOWN_QUOTA: ProviderQuota = {
  state: 'UNKNOWN',
  scope: 'UNKNOWN',
  detail: 'This provider does not report a quota.',
  resetsAt: null,
};

/** What a provider says about its allowance, or an honest "it does not say". */
export function quotaOf(provider: AIProvider): ProviderQuota {
  const status = provider.getStatus();
  return status.quota ?? UNKNOWN_QUOTA;
}

/**
 * May the run launch another job?
 *
 * A provider that says nothing about quota is not treated as exhausted — the
 * work goes ahead and fails honestly if the allowance really is gone, which is
 * better than refusing to research because a tool is quiet about its limits.
 */
export function quotaDecision(input: {
  provider: AIProvider;
  paidOverageEnabled: boolean;
}): QuotaDecision {
  const quota = quotaOf(input.provider);

  if (quota.state !== 'EXHAUSTED') {
    return {
      canRun: true,
      quota,
      detail: quota.detail,
      overageWouldHelp: false,
    };
  }

  const scope =
    quota.scope === 'GEMINI'
      ? "the provider's own model allowance"
      : quota.scope === 'THIRD_PARTY'
        ? 'the third-party model allowance'
        : 'the model allowance';

  if (input.paidOverageEnabled) {
    // Authorized in advance, explicitly, and recorded when it was turned on.
    return {
      canRun: true,
      quota,
      detail: `${quota.detail} Continuing on paid overage, which you enabled for this provider.`,
      overageWouldHelp: false,
    };
  }

  return {
    canRun: false,
    quota,
    detail:
      `Research is paused because ${scope} is exhausted. ${quota.detail} ` +
      `Everything already accepted is kept, and the queued jobs stay queued — the run resumes ` +
      `when the allowance refreshes${quota.resetsAt ? ` (expected ${quota.resetsAt})` : ''}. ` +
      `Paid overages are off, and Brain will not spend money without you turning them on.`,
    overageWouldHelp: true,
  };
}
