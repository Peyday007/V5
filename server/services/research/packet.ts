/**
 * Is this packet actually an answer to the question that was asked?
 *
 * The evidence gate judges one fragment at a time and cannot see the shape of
 * the whole: every fragment can pass while the packet still measures two
 * different populations, rests a conclusion on a calculation whose inputs were
 * never established, or answers everything except the mandatory requirement the
 * assignment was really about.
 *
 * So the packet is checked before a word of it is written. What comes back is
 * not a score but a list of specific failures, each naming the requirements
 * behind it — because the response to a coverage failure is targeted research
 * into what is missing, never a re-run of work that already succeeded.
 */
import type {
  ExistingClaim,
  Requirement,
  RequirementCoverage,
  ResearchClaim,
  ResearchFragment,
} from '../../domain/types.ts';
import {
  acceptedClaims,
  createFragments,
  currentFragments,
  listClaims,
  type CreateFragmentInput,
} from '../../repos/research.ts';
import {
  contractFor,
  listCoverage,
  listExistingClaims,
  listRequirements,
} from '../../repos/reconciliation.ts';
import { countIndependentSources } from './standards.ts';
import { assignExecutionPriority } from './quota.ts';

export interface PacketCheck {
  check: string;
  passed: boolean;
  detail: string;
  /** The requirements this failure is about, and nothing else. */
  requirementIds: string[];
}

export interface PacketCoverage {
  ok: boolean;
  checks: PacketCheck[];
  /** What would have to be researched to fix it — targeted, never everything. */
  targetedRequirementIds: string[];
  summary: string;
}

/** The evidence a synthesis is allowed to draw on, old and new. */
export interface PacketEvidence {
  requirements: Requirement[];
  coverage: RequirementCoverage[];
  /** Claims from this run that cleared their gate. */
  newClaims: ResearchClaim[];
  /** Claims from the archive that a coverage decision actually relies on. */
  existingClaims: ExistingClaim[];
  acceptedFragments: ResearchFragment[];
  rejectedFragments: ResearchFragment[];
}

/**
 * Gather everything the synthesis may use.
 *
 * Two sources, one standard: a claim from the archive earns its place the same
 * way a new one does — by being cited by a coverage decision, by not being
 * superseded, and by having survived verification. A claim nobody relied on and
 * a claim that failed are equally absent.
 */
export async function packetEvidence(input: {
  orchestrationId: string;
  projectId: string;
}): Promise<PacketEvidence> {
  const requirements = await listRequirements(input.orchestrationId);
  const coverage = await listCoverage(input.orchestrationId);
  const fragments = await currentFragments(input.orchestrationId);

  const relied = new Set(
    coverage
      .filter((entry) => entry.status === 'SATISFIED' || entry.status === 'PARTIALLY_SATISFIED')
      .flatMap((entry) => entry.claimIds),
  );
  const existingClaims = (await listExistingClaims(input.projectId)).filter(
    (claim) =>
      relied.has(claim.id) &&
      !claim.superseded &&
      claim.verificationState !== 'REJECTED' &&
      claim.verificationState !== 'SUPERSEDED',
  );

  return {
    requirements,
    coverage,
    newClaims: await acceptedClaims(input.orchestrationId),
    existingClaims,
    acceptedFragments: fragments.filter((fragment) => fragment.status === 'ACCEPTED'),
    rejectedFragments: fragments.filter((fragment) =>
      ['REJECTED', 'BLOCKED', 'NEEDS_HUMAN'].includes(fragment.status),
    ),
  };
}

function normalize(value: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The distinct non-empty values of one scope field across the accepted claims. */
function distinct(claims: ResearchClaim[], field: 'geography' | 'timeframe' | 'population' | 'definition'): string[] {
  const values = new Set<string>();
  for (const claim of claims) {
    const value = normalize(claim[field]);
    if (value.length > 0) values.add(value);
  }
  return [...values];
}

/**
 * Check the packet against the whole goal.
 *
 * Each check names the requirements it is about, so a failure produces targeted
 * fragments rather than a second run of everything that already worked.
 */
/**
 * The one check that is a refusal rather than a report.
 *
 * Invariant 20 is narrow and deliberate: no synthesis over a packet that does
 * not cover the goal's **mandatory** part. The other checks here — consistent
 * scope, verified calculation inputs, nothing resting on a single source — are
 * things a reader must be told about, and the push path duly synthesizes with
 * them unresolved once it has run out of repairs, carrying the coverage report
 * into the document. Treating all seven as blocking would stop packets the
 * invariant does not stop.
 *
 * Named once so the runner and the check cannot drift apart on a string.
 */
export const MANDATORY_COVERAGE_CHECK = 'Mandatory requirements are covered';

export async function assessPacket(input: {
  orchestrationId: string;
  projectId: string;
}): Promise<PacketCoverage> {
  const evidence = await packetEvidence(input);
  const contract = await contractFor(input.orchestrationId);
  const fragments = await currentFragments(input.orchestrationId);
  const checks: PacketCheck[] = [];

  const byRequirement = new Map(evidence.coverage.map((entry) => [entry.requirementId, entry]));

  // 1. Every mandatory requirement is covered.
  const mandatoryOpen = evidence.requirements.filter((requirement) => {
    if (requirement.necessity !== 'MANDATORY') return false;
    if (requirement.kind === 'OTHER_LAYER' || requirement.kind === 'IRRELEVANT') return false;
    const entry = byRequirement.get(requirement.id);
    return !entry || (entry.status !== 'SATISFIED' && entry.status !== 'PARTIALLY_SATISFIED');
  });
  checks.push({
    check: MANDATORY_COVERAGE_CHECK,
    passed: mandatoryOpen.length === 0,
    detail:
      mandatoryOpen.length === 0
        ? 'Every mandatory requirement has accepted evidence behind it.'
        : `${mandatoryOpen.length} mandatory requirement(s) have no accepted evidence: ` +
          mandatoryOpen.map((requirement) => requirement.statement).join(' | '),
    requirementIds: mandatoryOpen.map((requirement) => requirement.id),
  });

  // 2. Foundational fragments are resolved, or blocked on purpose and in view.
  const foundationalOpen = fragments.filter(
    (fragment) =>
      fragments.some((other) => other.dependsOn.includes(fragment.fragmentKey)) &&
      !['ACCEPTED', 'REJECTED', 'CANCELLED', 'NEEDS_HUMAN'].includes(fragment.status),
  );
  checks.push({
    check: 'Foundational fragments are settled',
    passed: foundationalOpen.length === 0,
    detail:
      foundationalOpen.length === 0
        ? 'Nothing else is waiting on a fragment that has not finished.'
        : `${foundationalOpen.length} fragment(s) that others depend on are still open: ` +
          foundationalOpen.map((fragment) => fragment.fragmentKey).join(', '),
    requirementIds: foundationalOpen.flatMap((fragment) => fragment.requirementIds),
  });

  // 3-4. One definition, one geography, one timeframe, one population.
  for (const [field, label, contractValue] of [
    ['definition', 'Definitions are consistent', contract?.definitions?.[0]?.definition ?? null],
    ['geography', 'Geography is consistent', contract?.geography ?? null],
    ['timeframe', 'Timeframe is consistent', contract?.timeframe ?? null],
    ['population', 'Population is consistent', contract?.population ?? null],
  ] as ['definition' | 'geography' | 'timeframe' | 'population', string, string | null][]) {
    const values = distinct(evidence.newClaims, field);
    const consistent = values.length <= 1;
    checks.push({
      check: label,
      passed: consistent,
      detail: consistent
        ? values.length === 0
          ? `The accepted claims do not state a ${field}; the assignment's own ${field} stands` +
            `${contractValue ? ` (${contractValue})` : ''}.`
          : `Everything is measured on ${values[0]}.`
        : `The accepted claims are measured on ${values.length} different values of ${field} ` +
          `(${values.join(' | ')}). They cannot be combined into one statement.`,
      requirementIds: consistent
        ? []
        : [...new Set(evidence.newClaims.flatMap((claim) => claim.requirementIds))],
    });
  }

  // 5. Every calculation rests on inputs that were themselves accepted.
  const allClaims = await listClaims(input.orchestrationId);
  const acceptedIds = new Set(evidence.newClaims.map((claim) => claim.id));
  const brokenDerivations = evidence.newClaims.filter(
    (claim) => claim.derived && !claim.derivedFrom.every((id) => acceptedIds.has(id)),
  );
  checks.push({
    check: 'Calculation inputs are verified',
    passed: brokenDerivations.length === 0,
    detail:
      brokenDerivations.length === 0
        ? 'Every calculation names inputs that are accepted claims in their own right.'
        : `${brokenDerivations.length} calculation(s) rest on inputs that were not accepted.`,
    requirementIds: [...new Set(brokenDerivations.flatMap((claim) => claim.requirementIds))],
  });

  // 6. A contradiction that nobody investigated is not a resolved contradiction.
  const openContradictions = allClaims.filter(
    (claim) =>
      (claim.contradictionState === 'CONTESTED' || claim.contradictionState === 'REFUTED') &&
      !(claim.contradictionNote ?? '').trim(),
  );
  const contradictionFragmentsOpen = fragments.filter(
    (fragment) =>
      fragment.contradictionTargets.length > 0 &&
      !['ACCEPTED', 'REJECTED', 'NEEDS_HUMAN'].includes(fragment.status),
  );
  const counterOk = openContradictions.length === 0 && contradictionFragmentsOpen.length === 0;
  checks.push({
    check: 'Credible counterarguments were investigated',
    passed: counterOk,
    detail: counterOk
      ? 'Every challenged claim carries what was done about the challenge.'
      : `${openContradictions.length} challenged claim(s) and ${contradictionFragmentsOpen.length} ` +
        'conflict fragment(s) are still open.',
    requirementIds: [
      ...new Set([
        ...openContradictions.flatMap((claim) => claim.requirementIds),
        ...contradictionFragmentsOpen.flatMap((fragment) => fragment.requirementIds),
      ]),
    ],
  });

  // 7. Every accepted claim answers something the goal actually asked for.
  const untethered = evidence.newClaims.filter((claim) => claim.requirementIds.length === 0);
  checks.push({
    check: 'Every claim answers a requirement',
    passed: untethered.length === 0,
    detail:
      untethered.length === 0
        ? 'Each accepted claim traces to a requirement of the goal.'
        : `${untethered.length} accepted claim(s) answer no stated requirement, so a report built ` +
          'on them would be answering a question nobody asked.',
    requirementIds: [],
  });

  // 8. The packet answers the goal rather than its edges.
  const answered = evidence.requirements.filter((requirement) => {
    const entry = byRequirement.get(requirement.id);
    return entry?.status === 'SATISFIED' || entry?.status === 'PARTIALLY_SATISFIED';
  });
  const answersGoal = evidence.requirements.length > 0 && answered.length > 0;
  checks.push({
    check: 'The packet answers the goal it was given',
    passed: answersGoal,
    detail: answersGoal
      ? `${answered.length} of ${evidence.requirements.length} requirement(s) have accepted evidence.`
      : 'Nothing the assignment asked for has accepted evidence behind it.',
    requirementIds: answersGoal ? [] : evidence.requirements.map((requirement) => requirement.id),
  });

  // 9. What is still unknown is visible rather than quietly dropped.
  const unresolved = fragments.filter((fragment) =>
    ['REJECTED', 'NEEDS_HUMAN'].includes(fragment.status),
  );
  checks.push({
    check: 'Important unknowns stay visible',
    passed: unresolved.every((fragment) => Boolean(fragment.blockedReason)),
    detail:
      unresolved.length === 0
        ? 'Nothing was abandoned.'
        : `${unresolved.length} fragment(s) could not be established, and each says why. The report ` +
          'must state them rather than write around them.',
    requirementIds: [],
  });

  // 10. Does anything load-bearing rest on the thinnest evidence that passed?
  const weak = evidence.acceptedFragments.filter((fragment) => {
    const claims = evidence.newClaims.filter((claim) => claim.fragmentId === fragment.id);
    if (claims.length === 0) return false;
    const mandatory = fragment.requirementIds.some((id) => {
      const requirement = evidence.requirements.find((entry) => entry.id === id);
      return requirement?.necessity === 'MANDATORY';
    });
    return mandatory && countIndependentSources(claims) <= 1;
  });
  checks.push({
    check: 'No mandatory conclusion rests on one source',
    passed: weak.length === 0,
    detail:
      weak.length === 0
        ? 'Every mandatory conclusion rests on more than one independent publisher.'
        : `${weak.length} mandatory fragment(s) passed on a single independent source: ` +
          weak.map((fragment) => fragment.fragmentKey).join(', '),
    requirementIds: weak.flatMap((fragment) => fragment.requirementIds),
  });

  const failed = checks.filter((check) => !check.passed);
  return {
    ok: failed.length === 0,
    checks,
    targetedRequirementIds: [...new Set(failed.flatMap((check) => check.requirementIds))],
    summary:
      failed.length === 0
        ? 'The packet covers the goal: every mandatory requirement is evidenced, the scope is ' +
          'consistent, and nothing load-bearing rests on a single source.'
        : `${failed.length} coverage check(s) failed: ${failed.map((check) => check.check).join('; ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Targeted repair of a coverage failure
// ---------------------------------------------------------------------------

/** Never let a coverage failure regenerate the whole packet. */
export const MAX_COVERAGE_ROUNDS = 2;

/**
 * Plan fragments for what the packet is missing, and nothing else.
 *
 * A coverage failure is not a reason to research the assignment again: most of
 * it worked. What it is a reason to do is go and get the specific thing that is
 * missing — which is why each fragment here is built from one failed check and
 * one requirement, and carries that check as its reason for existing.
 */
export async function planCoverageFragments(input: {
  orchestrationId: string;
  coverage: PacketCoverage;
  maxFragments: number;
}): Promise<ResearchFragment[]> {
  const existing = await currentFragments(input.orchestrationId);
  const requirements = await listRequirements(input.orchestrationId);
  const contract = await contractFor(input.orchestrationId);

  // A requirement that has already been attempted repeatedly does not get
  // another fragment because a later check noticed the same hole.
  const attemptsPerRequirement = new Map<string, number>();
  for (const fragment of existing) {
    for (const id of fragment.requirementIds) {
      attemptsPerRequirement.set(id, (attemptsPerRequirement.get(id) ?? 0) + 1);
    }
  }

  const taken = new Set(existing.map((fragment) => fragment.fragmentKey));
  const briefs: CreateFragmentInput[] = [];
  let index = existing.length;

  for (const check of input.coverage.checks) {
    if (check.passed) continue;
    for (const requirementId of check.requirementIds) {
      if (existing.length + briefs.length >= input.maxFragments) break;
      if ((attemptsPerRequirement.get(requirementId) ?? 0) >= 3) continue;

      const requirement = requirements.find((entry) => entry.id === requirementId);
      if (!requirement) continue;

      const key = `coverage-${briefs.length + 1}-${requirement.requirementKey}`.slice(0, 60);
      if (taken.has(key)) continue;
      taken.add(key);
      attemptsPerRequirement.set(requirementId, (attemptsPerRequirement.get(requirementId) ?? 0) + 1);

      briefs.push({
        orchestrationId: input.orchestrationId,
        projectId: requirement.projectId,
        layerId: requirement.layerId,
        fragmentIndex: index,
        fragmentKey: key,
        question: `${requirement.statement.replace(/\?$/, '')}? Answer only the part the packet is missing.`,
        geography: contract?.geography ?? null,
        timeframe: contract?.timeframe ?? null,
        population: contract?.population ?? null,
        definitions:
          contract && contract.definitions.length > 0
            ? contract.definitions.map((entry) => `${entry.term}: ${entry.definition}`).join(' | ')
            : null,
        requiredEvidence:
          requirement.requiredEvidence.length > 0
            ? requirement.requiredEvidence
            : ['a primary source that states it'],
        acceptableSourceTypes: ['government statistics', 'regulatory filings', 'official registries'],
        excludedSourceTypes: ['vendor marketing pages', 'unattributed summaries'],
        completionCriteria:
          requirement.completionCriteria.length > 0
            ? requirement.completionCriteria
            : ['a claim with a canonical source URL and the exact supporting passage'],
        dependsOn: [],
        minIndependentSources: 2,
        status: 'QUEUED',
        requirementIds: [requirement.id],
        evidenceLane: requirement.requiredEvidence[0] ?? 'primary source',
        whyItMatters: requirement.rationale ?? requirement.statement,
        missingEvidence: check.detail,
        whyExistingInsufficient: `The packet failed this check before synthesis: ${check.check}.`,
        expectedClaimTypes: ['SOURCED_FACT'],
        preferredSourceTypes: ['official statistics', 'regulatory filings'],
        failureConditions: ['No source addresses this on the terms the assignment requires.'],
        estimatedEffort: 'MEDIUM',
        maxRepairs: 1,
      });
      index += 1;
    }
  }

  if (briefs.length === 0) return [];
  return createFragments(assignExecutionPriority(briefs));
}
