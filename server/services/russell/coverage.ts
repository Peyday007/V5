/**
 * What the archive already answers, decided before any work is created.
 *
 * §13's rule is that the default is *not* to research. Researching something
 * the project already knows spends the user's allowance to learn what it had,
 * and is the same waste as never reading the archive at all. So this runs
 * before a mission is proposed, before capacity is reserved and before a packet
 * exists.
 *
 * It is deliberately thin. `assessRequirement` in `services/reconcile/` is
 * already the classifier — it decides SATISFIED, PARTIALLY_SATISFIED,
 * PRESENT_BUT_UNVERIFIED, STALE, CONTRADICTED, SUPERSEDED, MISSING and the rest
 * against the project's own claims — and it is a pure function. Reimplementing
 * that judgment here would create a second opinion about the same question, and
 * the second one is always the one that drifts.
 *
 * The one rule this module adds is the one the assignment insists on:
 * **only accepted, current, authorized evidence may close a requirement.** An
 * `UNVERIFIED` claim, a stale one, a contradicted one and a superseded one all
 * look like text that matches, and none of them is an answer. `CLOSING_STATUSES`
 * below is that rule in one place, and inverting it is what the test does.
 */
import { assessRequirement, projectClaims } from '../reconcile/coverage.ts';
import type {
  BoundaryContract,
  CoverageStatus,
  ExistingClaim,
  Requirement,
} from '../../domain/types.ts';

/**
 * The statuses that mean "the archive settles this, do not research it".
 *
 * Exactly one. `PRESENT_BUT_UNVERIFIED` is the interesting exclusion: somebody
 * wrote the answer down and nothing supports it, which reads like coverage and
 * is the opposite — it is precisely the case where research is most needed and
 * a naive text match is most likely to suppress it.
 */
export const CLOSING_STATUSES: readonly CoverageStatus[] = ['SATISFIED'];

/** Statuses that mean the requirement exists but is not research's job. */
const NOT_RESEARCH: readonly CoverageStatus[] = ['NOT_REQUIRED', 'OWNED_ELSEWHERE'];

export interface CoverageVerdict {
  requirementKey: string;
  status: CoverageStatus;
  /** True only when accepted current evidence closes it. */
  closed: boolean;
  needsResearch: boolean;
  reasons: string[];
  claimIds: string[];
  documentIds: string[];
}

export interface PreMissionCoverage {
  verdicts: CoverageVerdict[];
  /** Requirements the archive genuinely settles. */
  answered: CoverageVerdict[];
  /** Requirements that are a real external-research gap. */
  gaps: CoverageVerdict[];
  /** Requirements that are real but are somebody else's job, not research's. */
  notResearch: CoverageVerdict[];
  /** How many claims the decision was taken against. */
  claimsConsidered: number;
  /** True when nothing is left to research, so no mission should be created. */
  fullyAnswered: boolean;
}

export interface ProposedRequirement {
  key: string;
  statement: string;
  necessity?: Requirement['necessity'];
  kind?: Requirement['kind'];
  requiredEvidence?: Requirement['requiredEvidence'];
  completionCriteria?: string[];
}

/**
 * Judge a proposed piece of work against what the project already holds.
 *
 * The requirements are built in memory rather than persisted: nothing exists
 * yet to attach them to, and creating an orchestration in order to find out
 * whether one is needed is the waste this check exists to prevent. They are
 * given synthetic ids because `assessRequirement` reads the statement and the
 * declarations, not the identity.
 */
export async function coverBeforeWork(input: {
  projectId: string;
  layerId: string;
  requirements: ProposedRequirement[];
  contract?: BoundaryContract | null;
  /** Supplied by a test or a caller that already read them; otherwise loaded. */
  claims?: ExistingClaim[];
}): Promise<PreMissionCoverage> {
  const claims = input.claims ?? (await projectClaims(input.projectId));
  const contract = input.contract ?? null;

  const verdicts = input.requirements.map((proposed, index) => {
    const requirement: Requirement = {
      id: `pending:${proposed.key}`,
      orchestrationId: 'pending',
      projectId: input.projectId,
      layerId: input.layerId,
      requirementKey: proposed.key,
      ordinal: index,
      statement: proposed.statement,
      necessity: proposed.necessity ?? 'MANDATORY',
      kind: proposed.kind ?? 'RESEARCH',
      rationale: null,
      requiredEvidence: proposed.requiredEvidence ?? [],
      completionCriteria: proposed.completionCriteria ?? [],
      dependsOn: [],
      owningLayerId: null,
      createdAt: '',
      updatedAt: '',
    };
    const assessment = assessRequirement(requirement, claims, contract);
    const closed = CLOSING_STATUSES.includes(assessment.status);
    return {
      requirementKey: proposed.key,
      status: assessment.status,
      closed,
      // Trust the classifier's own answer about whether research is the remedy,
      // and then insist that only a closing status may suppress it. Both halves
      // are needed: the first knows about NOT_REQUIRED and OWNED_ELSEWHERE, the
      // second stops PRESENT_BUT_UNVERIFIED from reading as coverage.
      needsResearch: assessment.needsResearch && !closed,
      reasons: assessment.reasons,
      claimIds: assessment.claimIds,
      documentIds: assessment.documentIds,
    };
  });

  const answered = verdicts.filter((verdict) => verdict.closed);
  const notResearch = verdicts.filter(
    (verdict) => !verdict.closed && NOT_RESEARCH.includes(verdict.status),
  );
  const gaps = verdicts.filter((verdict) => verdict.needsResearch);

  return {
    verdicts,
    answered,
    gaps,
    notResearch,
    claimsConsidered: claims.length,
    fullyAnswered: gaps.length === 0,
  };
}

/**
 * What to tell a person when Russell declines to research something.
 *
 * Plain, and it names the evidence rather than the status enum — "snake case is
 * never product copy", and "SATISFIED" tells somebody nothing about why their
 * question was already answered.
 */
export function explainCoverage(coverage: PreMissionCoverage): string {
  if (coverage.fullyAnswered) {
    const cited = coverage.answered.flatMap((verdict) => verdict.claimIds).length;
    return cited > 0
      ? `The project already answers this, from ${cited} accepted ${cited === 1 ? 'finding' : 'findings'}.`
      : 'The project already answers this.';
  }
  if (coverage.answered.length > 0) {
    return `Part of this is already answered; ${coverage.gaps.length} ${
      coverage.gaps.length === 1 ? 'question needs' : 'questions need'
    } new research.`;
  }
  return `This is not answered yet: ${coverage.gaps.length} ${
    coverage.gaps.length === 1 ? 'question' : 'questions'
  } to research.`;
}
