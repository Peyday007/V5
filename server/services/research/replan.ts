/**
 * What a finding does to the evidence the project already had.
 *
 * A research worker returning a sourced claim is not the end of the question.
 * The archive may already say it, say it better, say it about a different year,
 * or say the opposite — and each of those leads somewhere different. Confirming
 * an existing claim strengthens it; contradicting one opens a question that has
 * to be resolved before either can be relied on; filling a gap closes one.
 *
 * Two rules run through all of it. New evidence never silently overwrites old
 * evidence — both claims keep their rows and what changes is what the coverage
 * says about them together. And queued work that accepted evidence has made
 * unnecessary is cancelled with its reason recorded, because spending the
 * user's allowance researching something already established is the same waste
 * as researching what the archive already answered.
 */
import type {
  ExistingClaim,
  ReconciliationOutcome,
  Requirement,
  ResearchClaim,
  ResearchFragment,
} from '../../domain/types.ts';
import {
  createFragments,
  currentFragments,
  listClaimsForFragment,
  recordClaimReconciliation,
  updateFragment,
  type CreateFragmentInput,
} from '../../repos/research.ts';
import {
  listCoverage,
  listExistingClaims,
  listRequirements,
  upsertCoverage,
} from '../../repos/reconciliation.ts';
import { aboutTheSameThing, classifyAgainstExisting } from './contradictions.ts';
import type { ContradictionAssessment } from './contradictions.ts';
import { countIndependentSources } from './standards.ts';
import { assignExecutionPriority } from './quota.ts';

export interface FindingOutcome {
  claimId: string;
  claim: string;
  outcome: ReconciliationOutcome;
  againstClaimId: string | null;
  detail: string;
  contradiction: ContradictionAssessment | null;
}

/** A year mentioned anywhere in a claim or its source date. */
function yearOf(value: string | null): number | null {
  if (!value) return null;
  const match = /\b(19|20)\d{2}\b/.exec(value);
  return match ? Number(match[0]) : null;
}

function newest(claim: { timeframe: string | null; sourceDate: string | null }): number | null {
  return yearOf(claim.sourceDate) ?? yearOf(claim.timeframe);
}

/**
 * Same page, same figure: the finding is the existing claim, found again.
 *
 * The same publisher on a different page is not a duplicate — it is the
 * publisher confirming itself, which is a weaker thing than corroboration but a
 * different thing from finding nothing new.
 */
function isDuplicate(found: ResearchClaim, existing: ExistingClaim): boolean {
  if (found.sourceUrl && existing.sourceUrl) {
    return found.sourceUrl === existing.sourceUrl && aboutTheSameThing(found.claim, existing.claim);
  }
  return found.claim.trim().toLowerCase() === existing.claim.trim().toLowerCase();
}

/** Does the finding pin down something the existing claim left open? */
function narrows(found: ResearchClaim, existing: ExistingClaim): boolean {
  const added = (
    [
      [found.geography, existing.geography],
      [found.timeframe, existing.timeframe],
      [found.population, existing.population],
      [found.definition, existing.definition],
    ] as [string | null, string | null][]
  ).filter(([mine, theirs]) => Boolean(mine) && !theirs).length;
  return added > 0;
}

/**
 * Classify one accepted finding against the archive.
 *
 * The candidates are narrowed by content overlap first: running a contradiction
 * classification against every claim in a large archive would produce noise
 * rather than findings.
 */
export function classifyFinding(
  found: ResearchClaim,
  archive: ExistingClaim[],
): FindingOutcome {
  if (!found.accepted) {
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: 'FAILS_REQUIREMENT',
      againstClaimId: null,
      detail: found.rejectionReason ?? 'The claim did not clear the evidence gate.',
      contradiction: null,
    };
  }

  const related = archive.filter(
    (existing) => !existing.superseded && aboutTheSameThing(found.claim, existing.claim),
  );

  if (related.length === 0) {
    // Nothing in the archive speaks to this. Whether that closes a gap or opens
    // a question depends on whether it was asked for.
    const wasAsked = found.requirementIds.length > 0 || found.evidenceLane !== null;
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: wasAsked ? 'FILLS_GAP' : 'RAISES_NEW_QUESTION',
      againstClaimId: null,
      detail: wasAsked
        ? 'Nothing in the archive covered this, and the requirement asked for it.'
        : 'Nothing in the archive covered this and no requirement asked for it, so it is a new ' +
          'question rather than an answer.',
      contradiction: null,
    };
  }

  // The closest existing claim is the one worth reconciling against.
  const existing = related[0]!;

  if (isDuplicate(found, existing)) {
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: 'DUPLICATES',
      againstClaimId: existing.id,
      detail: 'The archive already holds this claim from the same source; nothing new was added.',
      contradiction: null,
    };
  }

  const contradiction = classifyAgainstExisting(found, existing);
  if (contradiction.material) {
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: 'CONTRADICTS',
      againstClaimId: existing.id,
      detail: contradiction.reason,
      contradiction,
    };
  }

  const foundYear = newest(found);
  const existingYear = newest({ timeframe: existing.timeframe, sourceDate: existing.sourceDate });
  if (foundYear !== null && existingYear !== null && foundYear > existingYear) {
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: 'UPDATES_STALE',
      againstClaimId: existing.id,
      detail:
        `The archive's evidence was from ${existingYear} and this is from ${foundYear}. ` +
        'Both are kept; the newer one is what the requirement now rests on.',
      contradiction: null,
    };
  }

  if (narrows(found, existing)) {
    return {
      claimId: found.id,
      claim: found.claim,
      outcome: 'NARROWS',
      againstClaimId: existing.id,
      detail: 'The finding states the scope the archive left open, so it is the more exact claim.',
      contradiction: null,
    };
  }

  // A different publisher saying the same thing is corroboration; the same
  // publisher saying it again is not.
  const independent =
    (found.sourcePublisher ?? '').trim().toLowerCase() !==
    (existing.sourcePublisher ?? '').trim().toLowerCase();
  return {
    claimId: found.id,
    claim: found.claim,
    outcome: independent ? 'STRENGTHENS' : 'CONFIRMS',
    againstClaimId: existing.id,
    detail: independent
      ? 'A publisher independent of the archive\'s source states the same thing.'
      : 'The archive already had this from the same publisher; the claim is confirmed, not corroborated.',
    contradiction: null,
  };
}

export interface ReplanResult {
  findings: FindingOutcome[];
  /** Requirements whose coverage changed because of this fragment. */
  requirementsUpdated: string[];
  /** Fragments cancelled because the evidence is now in. */
  cancelledFragments: { fragmentKey: string; reason: string }[];
  /** Material contradictions that need their own resolution fragment. */
  contradictionsToResolve: { claimId: string; againstClaimId: string; question: string }[];
}

/**
 * Reconcile one accepted fragment's findings, then replan around them.
 *
 * Runs after the fragment cleared its gate, because reconciling evidence that
 * was about to be rejected would move project state on the strength of claims
 * the platform does not accept.
 */
export async function reconcileAcceptedFragment(input: {
  orchestrationId: string;
  projectId: string;
  fragment: ResearchFragment;
}): Promise<ReplanResult> {
  const archive = await listExistingClaims(input.projectId);
  const claims = await listClaimsForFragment(input.fragment.id);
  const findings: FindingOutcome[] = [];
  const contradictionsToResolve: ReplanResult['contradictionsToResolve'] = [];

  for (const claim of claims) {
    const finding = classifyFinding(claim, archive);
    await recordClaimReconciliation(claim.id, {
      outcome: finding.outcome,
      againstClaimId: finding.againstClaimId,
      contradictionKind: finding.contradiction?.kind ?? null,
      detail: finding.detail,
    });
    findings.push(finding);
    if (
      finding.outcome === 'CONTRADICTS' &&
      finding.againstClaimId &&
      finding.contradiction?.resolutionQuestion
    ) {
      contradictionsToResolve.push({
        claimId: claim.id,
        againstClaimId: finding.againstClaimId,
        question: finding.contradiction.resolutionQuestion,
      });
    }
  }

  const requirements = await listRequirements(input.orchestrationId);
  const requirementsUpdated = await updateCoverageFromFragment({
    orchestrationId: input.orchestrationId,
    fragment: input.fragment,
    claims: claims.filter((claim) => claim.accepted),
    requirements,
    unresolvedContradictions: contradictionsToResolve.length,
  });

  const cancelledFragments = await cancelUnnecessaryWork({
    orchestrationId: input.orchestrationId,
    satisfied: requirementsUpdated,
    keepFragmentId: input.fragment.id,
  });

  return { findings, requirementsUpdated, cancelledFragments, contradictionsToResolve };
}

/**
 * Move the coverage matrix on, requirement by requirement.
 *
 * A requirement only becomes SATISFIED when the accepted claims actually meet
 * its bar — an unresolved contradiction keeps it open however many claims came
 * back, because a requirement answered two contradictory ways is not answered.
 */
async function updateCoverageFromFragment(input: {
  orchestrationId: string;
  fragment: ResearchFragment;
  claims: ResearchClaim[];
  requirements: Requirement[];
  unresolvedContradictions: number;
}): Promise<string[]> {
  const updated: string[] = [];
  const existingCoverage = new Map(
    (await listCoverage(input.orchestrationId)).map((entry) => [entry.requirementId, entry]),
  );

  for (const requirementId of input.fragment.requirementIds) {
    const requirement = input.requirements.find((entry) => entry.id === requirementId);
    if (!requirement) continue;

    const claimIds = input.claims.map((claim) => claim.id);
    const independent = countIndependentSources(input.claims);
    const previous = existingCoverage.get(requirementId);
    const carriedClaimIds = [...new Set([...(previous?.claimIds ?? []), ...claimIds])];

    if (input.unresolvedContradictions > 0) {
      await upsertCoverage({
        orchestrationId: input.orchestrationId,
        requirementId,
        status: 'CONTRADICTED',
        reasons: [
          'New research contradicts evidence the project already had, and the conflict is not resolved.',
        ],
        claimIds: carriedClaimIds,
        documentIds: previous?.documentIds ?? [],
        confidence: 0.3,
        gapType: 'UNRESOLVED_CONTRADICTION',
        gapDetail: 'The requirement has two incompatible answers on the same scope.',
        needsResearch: true,
      });
      updated.push(requirementId);
      continue;
    }

    if (claimIds.length === 0) continue;

    const enough = independent >= input.fragment.minIndependentSources;
    await upsertCoverage({
      orchestrationId: input.orchestrationId,
      requirementId,
      status: enough ? 'SATISFIED' : 'PARTIALLY_SATISFIED',
      reasons: enough
        ? [
            `Established by ${claimIds.length} accepted claim(s) from ${independent} independent ` +
              `source(s), each with a canonical source and the passage that supports it.`,
          ]
        : [
            `Accepted evidence rests on ${independent} independent source(s); this requirement ` +
              `needs ${input.fragment.minIndependentSources}.`,
          ],
      claimIds: carriedClaimIds,
      documentIds: previous?.documentIds ?? [],
      confidence: enough ? 0.85 : 0.5,
      gapType: enough ? null : 'INSUFFICIENT_INDEPENDENCE',
      gapDetail: enough ? null : 'Corroboration from a genuinely independent publisher is missing.',
      needsResearch: !enough,
    });
    updated.push(requirementId);
  }

  return updated;
}

/**
 * Cancel queued fragments the new evidence made pointless.
 *
 * Only queued ones, and only when every requirement they were planned for is
 * now satisfied. A fragment that is already running is left alone: killing work
 * mid-flight to save a slice of quota loses more than it saves.
 */
async function cancelUnnecessaryWork(input: {
  orchestrationId: string;
  satisfied: string[];
  keepFragmentId: string;
}): Promise<{ fragmentKey: string; reason: string }[]> {
  if (input.satisfied.length === 0) return [];
  const satisfiedNow = new Set(
    (await listCoverage(input.orchestrationId))
      .filter((entry) => entry.status === 'SATISFIED' && !entry.needsResearch)
      .map((entry) => entry.requirementId),
  );
  if (satisfiedNow.size === 0) return [];

  const cancelled: { fragmentKey: string; reason: string }[] = [];
  for (const fragment of await currentFragments(input.orchestrationId)) {
    if (fragment.id === input.keepFragmentId) continue;
    if (fragment.status !== 'QUEUED' && fragment.status !== 'PLANNED') continue;
    if (fragment.requirementIds.length === 0) continue;
    if (!fragment.requirementIds.every((id) => satisfiedNow.has(id))) continue;

    const reason =
      'Cancelled before it ran: the requirements it was planned for are now established by ' +
      'accepted evidence, so researching them again would spend the allowance on a question ' +
      'that already has an answer.';
    await updateFragment(fragment.id, {
      status: 'CANCELLED',
      cancelledReason: reason,
      blockedReason: reason,
      completedAt: new Date().toISOString(),
    });
    cancelled.push({ fragmentKey: fragment.fragmentKey, reason });
  }
  return cancelled;
}

/**
 * Turn material contradictions into fragments that could settle them.
 *
 * Only material ones: a timeframe or definition mismatch is settled by choosing
 * the scope the assignment asked for, not by more research, and spending a job
 * on it would waste the allowance. And only when nothing is already asking the
 * same question, because a contradiction that regenerates its own fragment
 * every round is how a run stops terminating.
 */
export async function planContradictionFragments(input: {
  orchestrationId: string;
  parent: ResearchFragment;
  contradictions: ReplanResult['contradictionsToResolve'];
  /** Ceiling on the whole run's fragments, so this cannot run away. */
  maxFragments: number;
}): Promise<ResearchFragment[]> {
  if (input.contradictions.length === 0) return [];
  const existing = await currentFragments(input.orchestrationId);
  const alreadyTargeted = new Set(
    existing.flatMap((fragment) => fragment.contradictionTargets),
  );

  const briefs: CreateFragmentInput[] = [];
  let index = existing.length;
  for (const contradiction of input.contradictions) {
    if (index >= input.maxFragments) break;
    if (alreadyTargeted.has(contradiction.claimId)) continue;

    briefs.push({
      orchestrationId: input.orchestrationId,
      projectId: input.parent.projectId,
      layerId: input.parent.layerId,
      fragmentIndex: index,
      fragmentKey: `${input.parent.fragmentKey}-conflict-${briefs.length + 1}`,
      question: contradiction.question,
      geography: input.parent.geography,
      timeframe: input.parent.timeframe,
      population: input.parent.population,
      definitions: input.parent.definitions,
      requiredEvidence: [
        {
          id: 'resolving_source',
          description: 'The source that resolves the disagreement between the two accounts.',
          necessity: 'REQUIRED',
        },
      ],
      acceptableSourceTypes: input.parent.acceptableSourceTypes,
      excludedSourceTypes: input.parent.excludedSourceTypes,
      completionCriteria: [
        'the resolving source, quoted at the passage that resolves it',
        'or a plain statement that the sources genuinely disagree, with both positions recorded',
      ],
      dependsOn: [],
      // A contradiction is exactly where one confident source is not enough.
      minIndependentSources: 3,
      status: 'QUEUED',
      requirementIds: input.parent.requirementIds,
      evidenceLane: 'contradiction resolution',
      whyItMatters:
        'Two claims on the same scope cannot both be right, and everything built on either of ' +
        'them is unsafe until it is settled.',
      missingEvidence: 'A source that establishes which of the two conflicting claims holds.',
      whyExistingInsufficient:
        'The project already holds both claims. What it does not hold is anything that decides ' +
        'between them.',
      existingClaimIds: [contradiction.againstClaimId],
      expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION'],
      preferredSourceTypes: input.parent.preferredSourceTypes,
      contradictionTargets: [contradiction.claimId, contradiction.againstClaimId],
      failureConditions: [
        'No source addresses the disagreement, in which case both positions are reported and the ' +
          'confidence in this requirement stays reduced.',
      ],
      estimatedEffort: 'HIGH',
      maxRepairs: 1,
    });
    index += 1;
  }

  if (briefs.length === 0) return [];
  return createFragments(assignExecutionPriority(briefs));
}
