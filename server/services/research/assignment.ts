/**
 * What a worker is allowed to see about the work it has claimed.
 *
 * A research work item is a pointer. It names an orchestration and, for
 * fragment work, a fragment; it carries none of the assignment. This module is
 * how a worker turns that pointer into something it can actually research, and
 * the shape of what it returns is the whole of the design decision.
 *
 * Three rules about what is here.
 *
 * **The fragment's own declaration, verbatim.** Question, geography, timeframe,
 * population, definitions, evidence lanes, acceptable and excluded source
 * types, completion criteria and the independent-source minimum are handed over
 * exactly as stored, because they are exactly what `applyGate` will judge the
 * result against. Summarising them here would create a second version of the
 * bar, and the worker would be researching against the summary.
 *
 * **What its dependencies established, and nothing else.** A fragment that
 * depends on another gets that one's *accepted* claims, because a boundary
 * fragment's job is to settle definitions the later fragments then use. It does
 * not get rejected claims, other fragments' working, or the packet so far.
 * §12's breadth comes from many bounded questions, and a fragment handed the
 * whole assignment is no longer bounded.
 *
 * **Earlier attempts' checkpoints.** The queue is at-least-once, so this may be
 * the second worker to hold this item. What the first one wrote down is here
 * rather than lost.
 *
 * **And, on a verification item, the claims it exists to judge.** This one was
 * missing and it deadlocked the step. `brain_submit_verification` takes a
 * verdict per `claim_id` and refuses a partial answer, deliberately — a worker
 * must not get to choose which of its claims are gated. But nothing handed the
 * worker those ids, so a verification could only be completed by a session that
 * had submitted the claims itself and still had the ids in front of it. Any
 * redelivery, any reissue, any second session: uncompletable, forever.
 *
 * The hosted harness passed this every deploy because it submits and verifies
 * inside one script run, holding the ids in a local variable. It proved the
 * tool worked and never crossed the boundary the real path always crosses.
 *
 * This adds no capability. The worker already holds the item for that fragment
 * and may already write verdicts against exactly these claims; it simply could
 * not name them.
 *
 * And one rule about what is not: **no prompt.** Nothing in this module tells a
 * worker what to say. It says what is being asked and what would count as an
 * answer, which is the difference between an assignment and a script.
 */
import type {
  FragmentDependency,
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  WorkItem,
  WorkItemCheckpoint,
} from '../../domain/types.ts';
import {
  acceptedClaims,
  currentFragments,
  getFragment,
  getOrchestration,
  listClaimsForFragment,
} from '../../repos/research.ts';
import { getLayer } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { listCheckpoints } from '../../repos/workQueue.ts';

/** How much of a dependency's ledger travels with the assignment. */
export const MAX_DEPENDENCY_CLAIMS = 40;

export interface AssignmentView {
  orchestration: {
    id: string;
    title: string;
    assignment: string;
    status: string;
    attempt: number;
    projectId: string;
    layerId: string;
    layerName: string | null;
    projectName: string | null;
    targetVersion: string | null;
  };
  fragment: FragmentView | null;
  /** Every current fragment's key and status, so a worker knows the shape. */
  siblings: { key: string; question: string; status: string; index: number }[];
  dependencies: DependencyView[];
  checkpoints: { attemptNumber: number; leaseGeneration: number; note: string; createdAt: string }[];
  /**
   * The claims this item must return a verdict on, on a `RESEARCH_VERIFY` item;
   * null on every other kind, where they would be the fragment's own working
   * handed back to it.
   *
   * Never truncated. `brain_submit_verification` requires a verdict for every
   * stored claim, so a cap here would silently recreate the deadlock it exists
   * to fix — the worker would answer the ones it could see and be refused for
   * the ones it could not.
   */
  claimsToVerify: ClaimToVerifyView[] | null;
  /**
   * The ledger a synthesis is written from: every accepted claim in the packet,
   * with the id the report has to cite it by.
   *
   * Null on every other work type. Never truncated, for the same reason
   * `claimsToVerify` is not — a report may only cite claims the gate accepted,
   * so an omitted claim is evidence the packet gathered and then silently left
   * out of its own conclusion.
   */
  claimsToCite: ClaimToCiteView[] | null;
}

/**
 * One claim awaiting a verdict.
 *
 * The scope fields travel with it because two of the gate's seven conditions —
 * does the source support this, does its scope match — are judgements only a
 * reader can make, and the reader cannot make them against the claim text
 * alone.
 */
export interface ClaimToVerifyView {
  claimId: string;
  claim: string;
  claimType: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  evidenceLane: string | null;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  primarySource: boolean;
}

/**
 * One accepted claim, as the report has to refer to it.
 *
 * Narrower than `ClaimToVerifyView` on purpose: verification needs the scope
 * fields because judging scope is its whole job, and synthesis needs the id,
 * the sentence, where it came from and which fragment established it. The
 * scope questions were answered at the gate and are not reopened here.
 */
export interface ClaimToCiteView {
  claimId: string;
  fragmentKey: string | null;
  claim: string;
  claimType: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
}

export interface FragmentView {
  id: string;
  key: string;
  index: number;
  question: string;
  attempt: number;
  status: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: string[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: FragmentDependency[];
  minIndependentSources: number;
  expectedClaimTypes: string[];
  prohibitedEvidence: string[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  contradictionTargets: string[];
  failureConditions: string[];
  excludedScope: string | null;
  whyItMatters: string | null;
  /** Set when this attempt exists because an earlier one failed. */
  repairReason: string | null;
  repairStrategy: string | null;
}

export interface DependencyView {
  key: string;
  question: string;
  status: string;
  established: {
    claimId: string;
    claim: string;
    sourceUrl: string | null;
    evidenceLocator: string | null;
    evidenceLane: string | null;
  }[];
}

function viewFragment(fragment: ResearchFragment): FragmentView {
  return {
    id: fragment.id,
    key: fragment.fragmentKey,
    index: fragment.fragmentIndex,
    question: fragment.question,
    attempt: fragment.attempt,
    status: fragment.status,
    geography: fragment.geography,
    timeframe: fragment.timeframe,
    population: fragment.population,
    definitions: fragment.definitions,
    requiredEvidence: fragment.requiredEvidence,
    acceptableSourceTypes: fragment.acceptableSourceTypes,
    excludedSourceTypes: fragment.excludedSourceTypes,
    completionCriteria: fragment.completionCriteria,
    dependsOn: fragment.dependsOn,
    minIndependentSources: fragment.minIndependentSources,
    expectedClaimTypes: fragment.expectedClaimTypes,
    prohibitedEvidence: fragment.prohibitedEvidence,
    requiredComparisons: fragment.requiredComparisons,
    requiredCalculations: fragment.requiredCalculations,
    contradictionTargets: fragment.contradictionTargets,
    failureConditions: fragment.failureConditions,
    excludedScope: fragment.excludedScope,
    whyItMatters: fragment.whyItMatters,
    repairReason: fragment.repairReason,
    repairStrategy: fragment.repairStrategy,
  };
}

/** Everything a reader needs to judge whether the source bears out the claim. */
function toVerify(claims: ResearchClaim[]): ClaimToVerifyView[] {
  return claims.map((claim) => ({
    claimId: claim.id,
    claim: claim.claim,
    claimType: claim.claimType,
    sourceUrl: claim.sourceUrl,
    sourceTitle: claim.sourceTitle,
    sourcePublisher: claim.sourcePublisher,
    sourceDate: claim.sourceDate,
    evidenceExcerpt: claim.evidenceExcerpt,
    evidenceLocator: claim.evidenceLocator,
    evidenceLane: claim.evidenceLane,
    geography: claim.geography,
    timeframe: claim.timeframe,
    population: claim.population,
    definition: claim.definition,
    primarySource: claim.primarySource,
  }));
}

function toCite(
  claims: ResearchClaim[],
  fragmentKeys: Map<string, string>,
): ClaimToCiteView[] {
  return claims.map((claim) => ({
    claimId: claim.id,
    fragmentKey: claim.fragmentId ? (fragmentKeys.get(claim.fragmentId) ?? null) : null,
    claim: claim.claim,
    claimType: claim.claimType,
    sourceUrl: claim.sourceUrl,
    sourceTitle: claim.sourceTitle,
    evidenceExcerpt: claim.evidenceExcerpt,
    evidenceLocator: claim.evidenceLocator,
  }));
}

/** Accepted claims only. A dependency's rejected working is not evidence. */
function established(claims: ResearchClaim[]): DependencyView['established'] {
  return claims
    .filter((claim) => claim.accepted)
    .slice(0, MAX_DEPENDENCY_CLAIMS)
    .map((claim) => ({
      claimId: claim.id,
      claim: claim.claim,
      sourceUrl: claim.sourceUrl,
      evidenceLocator: claim.evidenceLocator,
      evidenceLane: claim.evidenceLane,
    }));
}

/**
 * Build the view for one claimed work item.
 *
 * Returns null when the item names an orchestration that is gone, which is the
 * same answer the caller gives for an item it may not have — the tool turns
 * both into one refusal, because a research assignment that no longer exists
 * and one belonging to somebody else must not be distinguishable.
 */
export async function assignmentFor(item: WorkItem): Promise<AssignmentView | null> {
  if (!item.orchestrationId) return null;
  const orchestration = await getOrchestration(item.orchestrationId);
  if (!orchestration) return null;

  // The project on the orchestration is checked against the item's own rather
  // than trusted: a work item pointing at another project's orchestration would
  // be a way to read across a boundary the item's authorization already
  // decided, and it should be impossible rather than merely unlikely.
  if (orchestration.projectId !== item.projectId) return null;

  const fragment = item.fragmentId ? await getFragment(item.fragmentId) : null;
  if (item.fragmentId && (!fragment || fragment.orchestrationId !== orchestration.id)) return null;

  const current = await currentFragments(orchestration.id);

  const dependencies: DependencyView[] = [];
  if (fragment) {
    for (const declared of fragment.dependsOn) {
      const key = declared.key;
      const dependency = current.find((candidate) => candidate.fragmentKey === key);
      if (!dependency) continue;
      dependencies.push({
        key: dependency.fragmentKey,
        question: dependency.question,
        status: dependency.status,
        established: established(await listClaimsForFragment(dependency.id)),
      });
    }
  }

  const layer = await getLayer(orchestration.layerId);
  const project = await getProject(orchestration.projectId);
  const checkpoints = await listCheckpoints(item.id);

  return {
    orchestration: {
      id: orchestration.id,
      title: orchestration.title,
      assignment: orchestration.assignment,
      status: orchestration.status,
      attempt: orchestration.attempt,
      projectId: orchestration.projectId,
      layerId: orchestration.layerId,
      layerName: layer?.name ?? null,
      projectName: project?.name ?? null,
      targetVersion: orchestration.targetVersion,
    },
    fragment: fragment ? viewFragment(fragment) : null,
    siblings: current.map((candidate) => ({
      key: candidate.fragmentKey,
      question: candidate.question,
      status: candidate.status,
      index: candidate.fragmentIndex,
    })),
    dependencies,
    claimsToVerify:
      item.workType === 'RESEARCH_VERIFY' && fragment
        ? toVerify(await listClaimsForFragment(fragment.id))
        : null,
    /**
     * The deadlock this closes is the one `claimsToVerify` closed a stage
     * earlier, and it is the same mistake made twice.
     *
     * `brain_submit_synthesis` refuses a report whose citations do not resolve
     * to accepted claims — the whole report, not the sentence. Nothing handed a
     * worker those ids: a synthesis item has no fragment, so the assignment
     * carried the orchestration, the sibling keys and nothing else. The report
     * was therefore writable only by a session that had submitted the claims
     * itself and still had the ids in front of it.
     *
     * Which is exactly what every test and the hosted harness were: they read
     * ids from `listClaimsForFragment` or kept them in a local variable, so the
     * gap could not show. It is the third time that blind spot has cost a live
     * packet a stop, and the shape of the test that catches it is the one that
     * reads *only* what the assignment carries.
     */
    claimsToCite:
      item.workType === 'RESEARCH_SYNTHESIZE'
        ? toCite(
            await acceptedClaims(orchestration.id),
            new Map(current.map((candidate) => [candidate.id, candidate.fragmentKey])),
          )
        : null,
    checkpoints: checkpoints.map((checkpoint: WorkItemCheckpoint) => ({
      attemptNumber: checkpoint.attemptNumber,
      leaseGeneration: checkpoint.leaseGeneration,
      note: checkpoint.note,
      createdAt: checkpoint.createdAt,
    })),
  };
}

export type { ResearchOrchestration };
