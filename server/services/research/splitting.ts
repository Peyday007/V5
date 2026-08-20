/**
 * Dividing a fragment that turned out to be more than one question, and keeping
 * the dependency graph honest.
 *
 * Splitting is not tidiness. A fragment that mixes two populations, or two
 * jurisdictions, or evidence collection with a major inference, fails as a unit
 * even when most of it succeeded — and repairing it re-researches the parts that
 * were fine. Splitting is how the good half survives.
 *
 * The dependency graph matters for a different reason: quota. Researching a
 * fragment whose premise is still unsettled spends the user's allowance on an
 * answer that may have to be thrown away, so foundations go first and cycles are
 * surfaced rather than silently ordered around.
 */
import type { ResearchFragment } from '../../domain/types.ts';
import { createFragments, type CreateFragmentInput } from '../../repos/research.ts';
import type { GateResult } from './gate.ts';

/** Signals that a fragment is asking more than one thing. */
export interface SplitSignal {
  reason: string;
  /** The questions the split would produce, in order. */
  questions: string[];
}

const CONJUNCTIONS = /\s+(?:and also|as well as|in addition to|,\s*and)\s+/i;

/**
 * Would this fragment be better as several?
 *
 * Cheap, structural checks only. Guessing at semantic overlap would split
 * fragments that were fine and leave the ones that were not — and a wrong split
 * costs a whole extra research job.
 */
export function shouldSplit(
  fragment: ResearchFragment,
  gate: GateResult | null,
): SplitSignal | null {
  // Two questions in one. The plan is supposed to catch this; a fragment that
  // slipped through asks for an answer nobody can give in one place.
  const questionMarks = fragment.question.split('?').filter((part) => part.trim().length > 0);
  if (questionMarks.length > 1) {
    return {
      reason: 'The fragment asks more than one question, so no single answer can complete it.',
      questions: questionMarks.map((part) => `${part.trim()}?`),
    };
  }

  // Several evidence lanes where only some are filled: the covered ones are
  // finished, and repairing the fragment as a whole would re-research them.
  if (gate && fragment.requiredEvidence.length > 1) {
    const empty = gate.coverage.filter((lane) => !lane.meetsThreshold);
    const filled = gate.coverage.filter((lane) => lane.meetsThreshold);
    if (empty.length > 0 && filled.length > 0) {
      return {
        reason:
          `${filled.length} evidence lane(s) are complete and ${empty.length} are empty, so the ` +
          'complete ones should not be re-researched to fix the empty ones.',
        questions: empty.map(
          (lane) => `${fragment.question.replace(/\?$/, '')}, specifically the ${lane.lane}?`,
        ),
      };
    }
  }

  // A question joined by "and also" is usually two questions wearing one hat.
  if (CONJUNCTIONS.test(fragment.question) && fragment.question.length > 120) {
    const parts = fragment.question.split(CONJUNCTIONS).filter((part) => part.trim().length > 20);
    if (parts.length > 1) {
      return {
        reason: 'The question joins separate investigations that have different sources.',
        questions: parts.map((part) => (part.trim().endsWith('?') ? part.trim() : `${part.trim()}?`)),
      };
    }
  }

  return null;
}

/**
 * Create the children of a split, and retire the parent.
 *
 * Each child inherits the parent's boundaries and its requirement links — they
 * are answering the same requirement, in smaller pieces — and records which
 * fragment it came from, so the history reads as a division rather than as
 * fragments appearing from nowhere.
 */
export function splitFragment(input: {
  fragment: ResearchFragment;
  signal: SplitSignal;
  startIndex: number;
}): ResearchFragment[] {
  const { fragment, signal } = input;
  const briefs: CreateFragmentInput[] = signal.questions.slice(0, 4).map((question, offset) => ({
    orchestrationId: fragment.orchestrationId,
    projectId: fragment.projectId,
    layerId: fragment.layerId,
    fragmentIndex: input.startIndex + offset,
    fragmentKey: `${fragment.fragmentKey}-part-${offset + 1}`,
    question,
    geography: fragment.geography,
    timeframe: fragment.timeframe,
    population: fragment.population,
    definitions: fragment.definitions,
    // Each part carries the lane it exists to fill, where the split was by lane.
    requiredEvidence:
      signal.questions.length === fragment.requiredEvidence.length
        ? [fragment.requiredEvidence[offset] ?? fragment.requiredEvidence[0]!]
        : fragment.requiredEvidence,
    acceptableSourceTypes: fragment.acceptableSourceTypes,
    excludedSourceTypes: fragment.excludedSourceTypes,
    completionCriteria: fragment.completionCriteria,
    dependsOn: fragment.dependsOn,
    minIndependentSources: fragment.minIndependentSources,
    status: 'QUEUED',
    attempt: 1,
    splitFromId: fragment.id,
    requirementIds: fragment.requirementIds,
    evidenceLane:
      signal.questions.length === fragment.requiredEvidence.length
        ? (fragment.requiredEvidence[offset] ?? fragment.evidenceLane)
        : fragment.evidenceLane,
    whyItMatters: fragment.whyItMatters,
    missingEvidence: fragment.missingEvidence,
    whyExistingInsufficient: signal.reason,
    existingClaimIds: fragment.existingClaimIds,
    excludedScope: fragment.excludedScope,
    expectedClaimTypes: fragment.expectedClaimTypes,
    preferredSourceTypes: fragment.preferredSourceTypes,
    prohibitedEvidence: fragment.prohibitedEvidence,
    requiredComparisons: fragment.requiredComparisons,
    requiredCalculations: fragment.requiredCalculations,
    contradictionTargets: fragment.contradictionTargets,
    failureConditions: fragment.failureConditions,
    uncertaintyTolerance: fragment.uncertaintyTolerance,
    priority: fragment.priority,
    estimatedEffort: 'MEDIUM',
    maxRepairs: fragment.maxRepairs,
  }));

  return createFragments(briefs);
}

// ---------------------------------------------------------------------------
// The dependency graph
// ---------------------------------------------------------------------------

export interface DependencyReport {
  /** Fragment keys in the order they can safely run. */
  order: string[];
  /** Keys involved in a cycle. Surfaced, never quietly broken. */
  cycles: string[][];
  /** Keys that depend on something that was never planned. */
  danglingDependencies: { key: string; missing: string[] }[];
}

/**
 * Topologically order the fragments, and report what cannot be ordered.
 *
 * Priority breaks ties, so foundational work runs before the fragments that rest
 * on it even when nothing formally depends on it. A cycle is reported rather
 * than resolved: two fragments that each need the other's answer is a planning
 * mistake, and picking one arbitrarily hides it.
 */
export function planDependencies(fragments: ResearchFragment[]): DependencyReport {
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));
  const dangling: { key: string; missing: string[] }[] = [];

  const edges = new Map<string, string[]>();
  for (const fragment of fragments) {
    const missing = fragment.dependsOn.filter((key) => !byKey.has(key));
    if (missing.length > 0) dangling.push({ key: fragment.fragmentKey, missing });
    edges.set(
      fragment.fragmentKey,
      fragment.dependsOn.filter((key) => byKey.has(key)),
    );
  }

  const order: string[] = [];
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const cycles: string[][] = [];

  const visit = (key: string, trail: string[]): void => {
    const current = state.get(key);
    if (current === 'DONE') return;
    if (current === 'VISITING') {
      // The trail from where this key first appeared is the cycle itself.
      const start = trail.indexOf(key);
      cycles.push(trail.slice(start >= 0 ? start : 0).concat(key));
      return;
    }
    state.set(key, 'VISITING');
    const dependencies = [...(edges.get(key) ?? [])].sort(
      (a, b) => (byKey.get(a)?.priority ?? 5) - (byKey.get(b)?.priority ?? 5),
    );
    for (const dependency of dependencies) visit(dependency, [...trail, key]);
    state.set(key, 'DONE');
    order.push(key);
  };

  const roots = [...fragments].sort((a, b) => a.priority - b.priority || a.fragmentIndex - b.fragmentIndex);
  for (const fragment of roots) visit(fragment.fragmentKey, []);

  return { order, cycles, danglingDependencies: dangling };
}

/** True when every fragment this one waits on has settled. */
export function dependenciesSettled(
  fragment: ResearchFragment,
  fragments: ResearchFragment[],
): boolean {
  const settled = new Set(['ACCEPTED', 'REJECTED', 'NEEDS_HUMAN', 'CANCELLED']);
  const byKey = new Map(fragments.map((entry) => [entry.fragmentKey, entry]));
  return fragment.dependsOn.every((key) => {
    const dependency = byKey.get(key);
    return dependency === undefined || settled.has(dependency.status);
  });
}
