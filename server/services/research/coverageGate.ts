/**
 * Checking the archive before a proposal becomes research.
 *
 * §13 is the rule that "the default is not to research", and until now it was
 * true of exactly one of the two paths into this engine. The in-process
 * orchestrator decomposes a goal, reconciles it against everything the project
 * already holds, and creates fragments only for the gaps. A worker proposing
 * fragments over MCP went straight to `createFragments`, so a packet run by a
 * worker could spend the allowance re-establishing something the archive
 * already answered — the exact waste §13 exists to prevent, arriving through
 * the newer door.
 *
 * Nothing new decides anything here. The decider is `services/reconcile/`,
 * unchanged: this module's whole job is to put a worker's proposal into the
 * shape that decider already reads, run it, and hand back what it said. A
 * second coverage implementation would be a second answer to the same
 * question, and the second one is always the one nobody checks.
 *
 * It is mechanical throughout — no provider, no model, nothing spent — so the
 * check itself can never be the reason a packet costs anything.
 */
import type {
  BoundaryContract,
  CoverageStatus,
  ResearchOrchestration,
} from '../../domain/types.ts';
import {
  contractFor,
  createBoundaryContract,
  createRequirements,
  listRequirements,
} from '../../repos/reconciliation.ts';
import { reconcile } from '../reconcile/plan.ts';

/**
 * The part of a proposed fragment the coverage decision can read.
 *
 * Deliberately the fragment's own declarations and nothing else. §12 says
 * those declarations are what the gate is applied against, so they are also
 * what a decision about whether the fragment is needed must be applied
 * against — anything inferred here would be a boundary the worker never
 * agreed to be judged by.
 */
export interface ProposedScope {
  key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: string[];
  completionCriteria: string[];
  whyItMatters: string | null;
}

export interface CoverageDecision {
  fragmentKey: string;
  requirementId: string;
  status: CoverageStatus;
  needsResearch: boolean;
  reasons: string[];
  /** The archive claims the decision rests on, so it can be checked. */
  claimIds: string[];
  documentIds: string[];
  confidence: number;
}

export interface ProposalCoverage {
  decisions: CoverageDecision[];
  /** Fragments the archive already answers. These are not researched. */
  alreadyAnswered: CoverageDecision[];
  /** Fragments that are a genuine external-research gap. */
  researchable: CoverageDecision[];
  documentsRead: number;
  documentsUnreadable: number;
  existingClaims: number;
  /** True when the scope checks abstained for want of a stated boundary. */
  boundaryFromProposal: boolean;
}

/**
 * The single value every fragment declared, or null if they disagree.
 *
 * A packet whose fragments all say "United States" has a geography, and using
 * it is not inference — it is reading what was written down. A packet whose
 * fragments disagree has no single scope, and asserting one would make the
 * staleness and geography checks answer a question nobody asked.
 */
function unanimous(values: (string | null)[]): string | null {
  const stated = values.map((value) => value?.trim()).filter((value): value is string => !!value);
  if (stated.length === 0 || stated.length !== values.length) return null;
  const first = stated[0]!;
  return stated.every((value) => value.toLowerCase() === first.toLowerCase()) ? first : null;
}

/**
 * A boundary contract for a packet whose plan came from a worker.
 *
 * The push path gets one from the planning pass, which reads the assignment
 * and states the scope explicitly. A worker's proposal has no such object, and
 * the coverage checks that need one — is this evidence stale, is it about the
 * right place — abstain without it. Abstaining is not neutral: a well-sourced
 * claim from 2019 can reach SATISFIED with no timeframe to fail against, and
 * SATISFIED is the one status that stops research happening.
 *
 * So the contract is assembled from what the fragments themselves declared,
 * and only from what they agree on. It is not a substitute for the planning
 * pass's contract; it is the difference between the date check being able to
 * run and not.
 */
function contractFromProposal(
  orchestration: ResearchOrchestration,
  proposed: ProposedScope[],
): Parameters<typeof createBoundaryContract>[0] {
  return {
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    primaryQuestion: orchestration.title,
    geography: unanimous(proposed.map((fragment) => fragment.geography)),
    timeframe: unanimous(proposed.map((fragment) => fragment.timeframe)),
    population: unanimous(proposed.map((fragment) => fragment.population)),
    includedSubjects: proposed.map((fragment) => fragment.question),
    completionStandard: null,
  };
}

/**
 * Judge a worker's proposed decomposition against what the project holds.
 *
 * Call this inside the same idempotent operation that creates the fragments.
 * It writes requirement and coverage rows, and a replay that re-ran it would
 * either duplicate those rows or overwrite a decision with one taken against a
 * different archive.
 */
export async function coverProposal(input: {
  orchestration: ResearchOrchestration;
  proposed: ProposedScope[];
}): Promise<ProposalCoverage> {
  const { orchestration, proposed } = input;

  let contract: BoundaryContract | null = await contractFor(orchestration.id);
  const boundaryFromProposal = contract === null;
  if (!contract && proposed.length > 0) {
    contract = await createBoundaryContract(contractFromProposal(orchestration, proposed));
  }

  // One requirement per proposed fragment, keyed by the fragment's own key so
  // the decision can be handed back to the fragment it is about.
  const existing = await listRequirements(orchestration.id);
  const known = new Set(existing.map((requirement) => requirement.requirementKey));
  const created = await createRequirements(
    proposed
      .filter((fragment) => !known.has(fragment.key))
      .map((fragment, index) => ({
        orchestrationId: orchestration.id,
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        requirementKey: fragment.key,
        ordinal: existing.length + index,
        statement: fragment.question,
        // A fragment is part of the decomposition of this goal, so answering
        // the goal requires answering it. The same default the human review
        // screen applies when a person adds a requirement by hand.
        necessity: 'MANDATORY' as const,
        // The worker proposed it as research, which is the only kind of thing
        // it may propose. The classifications that mean "not research" belong
        // to a pass that read the goal, and inventing one here would let a
        // proposal silently reclassify itself out of being checked.
        kind: 'RESEARCH' as const,
        rationale: fragment.whyItMatters,
        requiredEvidence: fragment.requiredEvidence,
        completionCriteria: fragment.completionCriteria,
        dependsOn: [],
      })),
  );

  const requirements = [...existing, ...created];
  const result = await reconcile({
    orchestrationId: orchestration.id,
    projectId: orchestration.projectId,
    requirements,
    contract,
  });

  const byKey = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const decisions: CoverageDecision[] = [];
  for (const assessment of result.assessments) {
    const requirement = byKey.get(assessment.requirement.id);
    if (!requirement) continue;
    if (!proposed.some((fragment) => fragment.key === requirement.requirementKey)) continue;
    decisions.push({
      fragmentKey: requirement.requirementKey,
      requirementId: requirement.id,
      status: assessment.status,
      needsResearch: assessment.needsResearch,
      reasons: assessment.reasons,
      claimIds: assessment.claimIds,
      documentIds: assessment.documentIds,
      confidence: assessment.confidence,
    });
  }

  return {
    decisions,
    alreadyAnswered: decisions.filter((decision) => !decision.needsResearch),
    researchable: decisions.filter((decision) => decision.needsResearch),
    documentsRead: result.documentsRead,
    documentsUnreadable: result.documentsUnreadable,
    existingClaims: result.claims.length,
    boundaryFromProposal,
  };
}

/** The sentence a suppressed fragment is recorded with. */
export function whyNotResearched(decision: CoverageDecision): string {
  return (
    `The archive already answers this (${decision.status}): ` +
    (decision.reasons[0] ?? 'existing evidence covers it') +
    ` Researching it again would spend the allowance to learn something the project knows.`
  );
}
