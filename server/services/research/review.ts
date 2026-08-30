/**
 * What Brain proposes to do, before it spends anything doing it.
 *
 * The most expensive mistake in research is not a bad search. It is answering
 * the wrong question carefully: a boundary Brain read differently from the way
 * the user meant it, a requirement nobody noticed was missing, a fragment
 * chasing evidence the archive already holds. Every one of those is cheap to
 * fix here and expensive to fix after twenty jobs have run.
 *
 * So this module assembles the whole plan into something a person can read in a
 * couple of minutes — the goal as understood, what the archive already answers,
 * what is stale or contradicted or unsupported, the genuine gaps, the fragments
 * proposed for them, and exactly which jobs they would be bundled into — and
 * then applies whatever the user changes about it.
 *
 * The review is stored either way. Turning on automatic execution is a decision
 * about approval, not about visibility: the reasoning stays inspectable
 * afterwards, because a plan nobody can check is not a plan.
 */
import type {
  FragmentDependency,
  BoundaryContract,
  CoverageStatus,
  ExistingClaim,
  Requirement,
  RequirementCoverage,
  ResearchFragment,
  ResearchOrchestration,
} from '../../domain/types.ts';
import {
  contractFor,
  createRequirements,
  listCoverage,
  listExistingClaims,
  listRequirements,
  updateBoundaryContract,
  updateExistingClaim,
  upsertCoverage,
} from '../../repos/reconciliation.ts';
import {
  currentFragments,
  getOrchestration,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { recordEvent } from '../../repos/events.ts';
import { bundleFragments } from './bundling.ts';
import { planDependencies } from './splitting.ts';
import { PRIORITY_TIERS, executionOrder, tierOf } from './quota.ts';
import { planFragmentsFromGaps, reconcile } from '../reconcile/plan.ts';

/** One requirement, with what the archive says about it and why. */
export interface ReviewRequirement {
  requirement: Requirement;
  status: CoverageStatus | 'NOT_ASSESSED';
  reasons: string[];
  gapType: string | null;
  gapDetail: string | null;
  needsResearch: boolean;
  /** The archive's own claims behind that judgement, so it can be checked. */
  evidence: ExistingClaim[];
}

/** One fragment, with why it exists and what it would ride with. */
export interface ReviewFragment {
  fragment: ResearchFragment;
  tier: string;
  tierReason: string;
  jobIndex: number;
  dependsOn: FragmentDependency[];
}

export interface ReviewJob {
  index: number;
  rationale: string;
  jobKind: string;
  priority: number;
  fragmentKeys: string[];
}

export interface ResearchPlanReview {
  orchestration: ResearchOrchestration;
  /** Brain's reading of the goal, in the user's own terms. */
  interpretation: {
    assignment: string;
    primaryQuestion: string | null;
    decisionSupported: string | null;
    audience: string | null;
    included: string[];
    excluded: string[];
    geography: string | null;
    timeframe: string | null;
    population: string | null;
    definitions: { term: string; definition: string }[];
    expectedOutput: string | null;
    completionStandard: string | null;
    /** What Brain could not settle from the assignment alone. */
    ambiguities: { question: string; why: string }[];
  };
  boundary: BoundaryContract | null;
  requirements: ReviewRequirement[];
  /** Grouped by what the user would want to do about them. */
  alreadyAnswered: ReviewRequirement[];
  partial: ReviewRequirement[];
  stale: ReviewRequirement[];
  contradicted: ReviewRequirement[];
  unsupported: ReviewRequirement[];
  gaps: ReviewRequirement[];
  ownedElsewhere: ReviewRequirement[];
  fragments: ReviewFragment[];
  jobs: ReviewJob[];
  /** Fragments whose dependencies form a cycle, surfaced rather than hidden. */
  dependencyCycles: string[][];
  documentsRead: number;
  documentsUnreadable: number;
  approvalRequired: boolean;
  approvedAt: string | null;
}

const GROUPS: Record<string, keyof Pick<
  ResearchPlanReview,
  'alreadyAnswered' | 'partial' | 'stale' | 'contradicted' | 'unsupported' | 'gaps' | 'ownedElsewhere'
>> = {
  SATISFIED: 'alreadyAnswered',
  PARTIALLY_SATISFIED: 'partial',
  STALE: 'stale',
  SUPERSEDED: 'stale',
  CONTRADICTED: 'contradicted',
  PRESENT_BUT_UNVERIFIED: 'unsupported',
  DEFINITION_MISMATCH: 'unsupported',
  MISSING: 'gaps',
  OWNED_ELSEWHERE: 'ownedElsewhere',
  NOT_REQUIRED: 'ownedElsewhere',
};

/**
 * Assemble the review from persisted state.
 *
 * Nothing is recomputed for display: the coverage matrix, the fragments and the
 * bundles are the ones the run will actually use, so the plan a person approves
 * is the plan that executes.
 */
export async function buildReview(orchestrationId: string): Promise<ResearchPlanReview> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Unknown research run ${orchestrationId}`);

  const contract = await contractFor(orchestrationId);
  const requirements = await listRequirements(orchestrationId);
  const coverage = new Map((await listCoverage(orchestrationId)).map((entry) => [entry.requirementId, entry]));
  const archive = await listExistingClaims(orchestration.projectId);
  const byClaimId = new Map(archive.map((claim) => [claim.id, claim]));

  const review: ResearchPlanReview = {
    orchestration,
    interpretation: {
      assignment: orchestration.assignment,
      primaryQuestion: contract?.primaryQuestion ?? null,
      decisionSupported: contract?.decisionSupported ?? null,
      audience: contract?.audience ?? null,
      included: contract?.includedSubjects ?? [],
      excluded: contract?.excludedSubjects ?? [],
      geography: contract?.geography ?? null,
      timeframe: contract?.timeframe ?? null,
      population: contract?.population ?? null,
      definitions: contract?.definitions ?? [],
      expectedOutput: contract?.expectedOutput ?? null,
      completionStandard: contract?.completionStandard ?? null,
      ambiguities: contract?.ambiguities ?? [],
    },
    boundary: contract,
    requirements: [],
    alreadyAnswered: [],
    partial: [],
    stale: [],
    contradicted: [],
    unsupported: [],
    gaps: [],
    ownedElsewhere: [],
    fragments: [],
    jobs: [],
    dependencyCycles: [],
    documentsRead: 0,
    documentsUnreadable: 0,
    approvalRequired: !orchestration.autoApprove && orchestration.approvedAt === null,
    approvedAt: orchestration.approvedAt,
  };

  for (const requirement of requirements) {
    const entry = coverage.get(requirement.id);
    const item: ReviewRequirement = {
      requirement,
      status: entry?.status ?? 'NOT_ASSESSED',
      reasons: entry?.reasons ?? [],
      gapType: entry?.gapType ?? null,
      gapDetail: entry?.gapDetail ?? null,
      needsResearch: entry?.needsResearch ?? true,
      evidence: (entry?.claimIds ?? [])
        .map((id) => byClaimId.get(id))
        .filter((claim): claim is ExistingClaim => claim !== undefined),
    };
    review.requirements.push(item);
    const group = GROUPS[item.status];
    if (group) review[group].push(item);
  }

  // The fragments and the bundles the run would actually execute.
  const fragments = await currentFragments(orchestrationId);
  const runnable = fragments.filter((fragment) => ['PLANNED', 'QUEUED'].includes(fragment.status));
  const bundles = bundleFragments(executionOrder(runnable, fragments));
  const jobOf = new Map<string, number>();
  review.jobs = bundles.map((bundle, index) => {
    for (const fragment of bundle.fragments) jobOf.set(fragment.fragmentKey, index);
    return {
      index,
      rationale: bundle.rationale,
      jobKind: bundle.jobKind,
      priority: bundle.priority,
      fragmentKeys: bundle.fragments.map((fragment) => fragment.fragmentKey),
    };
  });

  review.fragments = fragments.map((fragment) => {
    const tier = tierOf(fragment, fragments);
    return {
      fragment,
      tier: tier.tier,
      tierReason: tier.reason,
      jobIndex: jobOf.get(fragment.fragmentKey) ?? -1,
      dependsOn: fragment.dependsOn,
    };
  });

  review.dependencyCycles = planDependencies(fragments).cycles;
  return review;
}

// ---------------------------------------------------------------------------
// What the user may change about it
// ---------------------------------------------------------------------------

export interface ReviewDecisions {
  /** Corrections to the boundary Brain inferred. */
  boundary?: {
    primaryQuestion?: string;
    geography?: string;
    timeframe?: string;
    population?: string;
    includedSubjects?: string[];
    excludedSubjects?: string[];
    definitions?: { term: string; definition: string }[];
    completionStandard?: string;
  };
  /** Requirements Brain missed. Each becomes a gap, and then a fragment. */
  addRequirements?: {
    statement: string;
    necessity?: 'MANDATORY' | 'SUPPORTING' | 'OPTIONAL';
    kind?: Requirement['kind'];
    requiredEvidence?: string[];
    completionCriteria?: string[];
  }[];
  /** Fragment keys the user does not want researched. */
  removeFragments?: string[];
  /** Archive claims the user knows are out of date. */
  supersedeClaims?: string[];
  /** Requirements the user does not believe the archive really settles. */
  forceReverify?: string[];
  /** Approve this run, and optionally every future step of it. */
  approve?: boolean;
  autoApprove?: boolean;
  note?: string;
}

export interface ReviewDecisionOutcome {
  review: ResearchPlanReview;
  applied: string[];
}

/**
 * Apply the user's corrections and replan around them.
 *
 * Everything here is an ordinary state change with a record behind it: a
 * superseded claim keeps its row, a removed fragment keeps its reason, and an
 * added requirement goes through the same coverage assessment as the ones Brain
 * found — so a requirement the archive already answers does not become a job
 * just because a person typed it.
 */
export async function applyReviewDecisions(
  orchestrationId: string,
  decisions: ReviewDecisions,
): Promise<ReviewDecisionOutcome> {
  const orchestration = await getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Unknown research run ${orchestrationId}`);
  const applied: string[] = [];
  const contract = await contractFor(orchestrationId);

  if (decisions.boundary && contract) {
    await updateBoundaryContract(contract.id, { ...decisions.boundary, status: 'APPROVED' });
    applied.push('The boundary was corrected, and the scope now says what you meant.');
  }

  if (decisions.supersedeClaims && decisions.supersedeClaims.length > 0) {
    for (const claimId of decisions.supersedeClaims) {
      await updateExistingClaim(claimId, {
        superseded: true,
        verificationState: 'SUPERSEDED',
        verificationDetail: 'Marked out of date during review, before research began.',
      });
    }
    applied.push(
      `${decisions.supersedeClaims.length} archive claim(s) were marked superseded. They keep ` +
        'their rows and their provenance; they simply stop counting as current evidence.',
    );
  }

  if (decisions.forceReverify && decisions.forceReverify.length > 0) {
    for (const requirementId of decisions.forceReverify) {
      await upsertCoverage({
        orchestrationId,
        requirementId,
        status: 'PRESENT_BUT_UNVERIFIED',
        reasons: ['You asked for this to be verified rather than taken from the archive.'],
        claimIds: [],
        documentIds: [],
        confidence: 0.2,
        gapType: 'UNVERIFIABLE_CITATION',
        gapDetail: 'Re-verification was requested during review.',
        needsResearch: true,
      });
    }
    applied.push(
      `${decisions.forceReverify.length} requirement(s) will be verified against primary sources ` +
        'rather than accepted from the archive.',
    );
  }

  if (decisions.addRequirements && decisions.addRequirements.length > 0) {
    const existing = await listRequirements(orchestrationId);
    await createRequirements(
      decisions.addRequirements.map((entry, index) => ({
        orchestrationId,
        projectId: orchestration.projectId,
        layerId: orchestration.layerId,
        requirementKey: `user-${existing.length + index + 1}`,
        ordinal: existing.length + index,
        statement: entry.statement,
        necessity: entry.necessity ?? 'MANDATORY',
        kind: entry.kind ?? 'RESEARCH',
        rationale: 'Added during review: you said the goal needs it.',
        requiredEvidence: entry.requiredEvidence ?? ['a primary source that states it'],
        completionCriteria: entry.completionCriteria ?? [
          'a claim with a canonical source URL and the exact supporting passage',
        ],
        dependsOn: [],
      })),
    );
    applied.push(`${decisions.addRequirements.length} requirement(s) you added were included.`);
  }

  // Re-assess everything against the corrected boundary and the archive as it
  // now stands, then plan fragments for whatever is still a gap.
  if (decisions.boundary || decisions.addRequirements || decisions.supersedeClaims || decisions.forceReverify) {
    const result = await reconcile({
      orchestrationId,
      projectId: orchestration.projectId,
      requirements: await listRequirements(orchestrationId),
      contract: await contractFor(orchestrationId),
    });
    const planned = await planFragmentsFromGaps({ orchestrationId, reconciliation: result });
    if (planned.length > 0) {
      applied.push(`${planned.length} new fragment(s) were planned for the gaps that remain.`);
    }
  }

  if (decisions.removeFragments && decisions.removeFragments.length > 0) {
    const keys = new Set(decisions.removeFragments);
    let removed = 0;
    for (const fragment of await currentFragments(orchestrationId)) {
      if (!keys.has(fragment.fragmentKey)) continue;
      if (!['PLANNED', 'QUEUED'].includes(fragment.status)) continue;
      const reason = 'Removed during review: you decided this does not need researching.';
      await updateFragment(fragment.id, {
        status: 'CANCELLED',
        cancelledReason: reason,
        blockedReason: reason,
        completedAt: new Date().toISOString(),
      });
      removed += 1;
    }
    if (removed > 0) applied.push(`${removed} fragment(s) will not be researched.`);
  }

  if (decisions.approve || decisions.autoApprove) {
    await updateOrchestration(orchestrationId, {
      approvedAt: new Date().toISOString(),
      approvalNote: decisions.note ?? null,
      ...(decisions.autoApprove === undefined ? {} : { autoApprove: decisions.autoApprove }),
    });
    applied.push(
      decisions.autoApprove
        ? 'Approved, and later steps of this run will proceed without asking again. The plan stays ' +
          'on this page either way.'
        : 'Approved. Research starts now.',
    );
  }

  await recordEvent({
    projectId: orchestration.projectId,
    layerId: orchestration.layerId,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_PLAN_REVIEWED',
    payload: {
      orchestrationId,
      applied,
      approved: Boolean(decisions.approve || decisions.autoApprove),
      autoApprove: decisions.autoApprove ?? orchestration.autoApprove,
    },
  });

  return { review: await buildReview(orchestrationId), applied };
}

/** The tier names, so the review page can order and label them itself. */
export const REVIEW_TIERS = PRIORITY_TIERS;
