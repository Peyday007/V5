/**
 * Turning a goal into a plan that respects what the project already knows.
 *
 *   goal -> boundary contract -> requirement graph -> existing claims
 *        -> coverage matrix -> gaps -> fragments for the real gaps only
 *
 * Two rules shape all of it.
 *
 * Nothing is researched because it appears in the report. A requirement becomes
 * a fragment only when the coverage matrix says the archive cannot answer it and
 * that the answer is the kind of thing desk research produces — a tuning
 * decision, an implementation detail or another layer's question is recorded and
 * left alone.
 *
 * The fragment count comes from the gaps. There is no floor and no ceiling: a
 * goal that is mostly already evidenced yields two fragments, and one that is
 * genuinely open yields thirty. What is capped is runaway growth — fragments per
 * requirement, and total fragments per assignment — because a plan that
 * fragments every sentence has stopped being a plan.
 */
import type {
  EvidenceLane,
  FragmentDependency,
  BoundaryContract,
  CoverageStatus,
  ExistingClaim,
  Layer,
  Project,
  Requirement,
  RequirementCoverage,
  ResearchFragment,
} from '../../domain/types.ts';
import { listDocuments } from '../../repos/documents.ts';
import { createFragments, currentFragments } from '../../repos/research.ts';
import { assignExecutionPriority } from '../research/quota.ts';
import {
  contractFor,
  createBoundaryContract,
  createRequirements,
  listCoverage,
  listRequirements,
  type CreateRequirementInput,
} from '../../repos/reconciliation.ts';
import { getCurrentExtractionRun } from '../../repos/extraction.ts';
import { claimsForDocument } from './claims.ts';
import { buildCoverageMatrix, type CoverageAssessment } from './coverage.ts';

/**
 * At most this many fragments for one requirement, and this many in total.
 *
 * Not a target — a backstop. The plan proposes what the gaps need; these numbers
 * only stop a pathological plan from spending a day's quota on one assignment.
 */
export const MAX_FRAGMENTS_PER_REQUIREMENT = 3;
export const MAX_FRAGMENTS_TOTAL = 60;

/** Coverage statuses that mean the archive cannot answer it yet. */
const OPEN_STATUSES: CoverageStatus[] = [
  'MISSING',
  'PARTIALLY_SATISFIED',
  'PRESENT_BUT_UNVERIFIED',
  'STALE',
  'CONTRADICTED',
  'DEFINITION_MISMATCH',
  'SUPERSEDED',
];

export interface PlanInput {
  orchestrationId: string;
  project: Project;
  layer: Layer;
  /** The parsed boundary contract, from the plan pass. */
  contract: Omit<Parameters<typeof createBoundaryContract>[0], 'orchestrationId' | 'projectId' | 'layerId'>;
  /** The parsed requirement graph, from the plan pass. */
  requirements: Omit<CreateRequirementInput, 'orchestrationId' | 'projectId' | 'layerId'>[];
}

/** Persist the boundary contract and the requirement graph. */
export async function persistPlan(input: PlanInput): Promise<{
  contract: BoundaryContract;
  requirements: Requirement[];
}> {
  const contract =
    await contractFor(input.orchestrationId) ??
    await createBoundaryContract({
      ...input.contract,
      orchestrationId: input.orchestrationId,
      projectId: input.project.id,
      layerId: input.layer.id,
    });

  const existing = await listRequirements(input.orchestrationId);
  if (existing.length > 0) return { contract, requirements: existing };

  const requirements = await createRequirements(
    input.requirements.map((requirement, index) => ({
      ...requirement,
      ordinal: index,
      orchestrationId: input.orchestrationId,
      projectId: input.project.id,
      layerId: input.layer.id,
    })),
  );
  return { contract, requirements };
}

/**
 * Read everything the project already has that could bear on this assignment.
 *
 * Only documents Brain has actually read are inventoried — an unread document is
 * not evidence, and pretending otherwise is the failure the extraction gate
 * exists to prevent.
 */
export async function inventoryProject(projectId: string): Promise<{
  claims: ExistingClaim[];
  documentsRead: number;
  documentsUnreadable: number;
}> {
  let read = 0;
  let unreadable = 0;
  const claims: ExistingClaim[] = [];

  for (const document of await listDocuments(projectId)) {
    if (!document.filesystemPath || document.fileMissing) continue;
    const run = await getCurrentExtractionRun(document.id);
    if (!run || (run.status !== 'READY' && run.status !== 'READY_WITH_WARNINGS')) {
      unreadable += 1;
      continue;
    }
    read += 1;
    claims.push(...await claimsForDocument(document.id));
  }

  return { claims, documentsRead: read, documentsUnreadable: unreadable };
}

export interface ReconciliationResult {
  contract: BoundaryContract;
  requirements: Requirement[];
  claims: ExistingClaim[];
  assessments: CoverageAssessment[];
  coverage: RequirementCoverage[];
  documentsRead: number;
  documentsUnreadable: number;
  /** Requirements the archive already answers, which will not be researched. */
  satisfied: CoverageAssessment[];
  /** Gaps that genuinely need somebody to go and look things up. */
  researchable: CoverageAssessment[];
  /** Gaps that are real but are somebody else's job. */
  notResearch: CoverageAssessment[];
}

/** Compare the goal against the archive and decide what is actually missing. */
export async function reconcile(input: {
  orchestrationId: string;
  projectId: string;
  requirements: Requirement[];
  contract: BoundaryContract | null;
}): Promise<ReconciliationResult> {
  const inventory = await inventoryProject(input.projectId);
  const { assessments, coverage } = await buildCoverageMatrix({
    orchestrationId: input.orchestrationId,
    requirements: input.requirements,
    claims: inventory.claims,
    contract: input.contract,
  });

  return {
    contract: input.contract!,
    requirements: input.requirements,
    claims: inventory.claims,
    assessments,
    coverage,
    documentsRead: inventory.documentsRead,
    documentsUnreadable: inventory.documentsUnreadable,
    satisfied: assessments.filter((entry) => entry.status === 'SATISFIED'),
    researchable: assessments.filter(
      (entry) => entry.needsResearch && OPEN_STATUSES.includes(entry.status),
    ),
    notResearch: assessments.filter(
      (entry) => !entry.needsResearch && entry.status !== 'SATISFIED',
    ),
  };
}


/**
 * Decide what each of a requirement's dependencies actually means.
 *
 * The rule is narrow and mechanical, because a planner cannot read intent:
 *
 * - A dependency on a **DEFINITION** is `HARD`. You cannot answer a question
 *   whose terms nobody has settled, and a conditional phrasing would just be
 *   restating the ambiguity.
 * - Every other dependency is `CONDITIONAL`. The dependent can be researched
 *   now and stated as a conditional, carrying what its dependency did and did
 *   not establish — which is what the assignment hands it.
 * - A dependency naming a requirement this plan does not contain stays `HARD`.
 *   Not knowing what something is, is not a reason to stop waiting for it.
 *
 * The default before this existed was that everything blocked, and it cost the
 * first live packet five fragments that were never attempted because a
 * neighbouring question failed. A penalty is researchable without the licence
 * trigger being settled, so long as it says so.
 */
export function typeDependencies(
  dependencies: FragmentDependency[],
  siblings: Requirement[],
): FragmentDependency[] {
  const byKey = new Map(siblings.map((requirement) => [requirement.requirementKey, requirement]));
  return dependencies.map((dependency) => {
    // A kind already decided is kept. A worker that declared SEQUENCING knows
    // something about its own question that this rule does not.
    if (dependency.kind !== 'HARD') return dependency;
    const target = byKey.get(dependency.key);
    if (!target) return dependency;
    return { key: dependency.key, kind: target.kind === 'DEFINITION' ? 'HARD' : 'CONDITIONAL' };
  });
}

/**
 * A fragment brief built from one gap.
 *
 * Everything a fragment needs to be answerable and checkable comes from
 * somewhere real: the question from the requirement, the boundaries from the
 * contract, the evidence lanes from what the requirement declared it needs, and
 * "why the existing evidence is insufficient" from the coverage decision that
 * put it here. A fragment that cannot say why it exists should not exist.
 */
export function briefFromGap(input: {
  assessment: CoverageAssessment;
  contract: BoundaryContract | null;
  index: number;
  /**
   * The requirements this plan is being built from, so a dependency can be
   * typed rather than assumed to block.
   *
   * Omitted only by callers that have no graph to consult — and then every
   * dependency stays HARD, which is what it meant before kinds existed.
   */
  siblings?: Requirement[];
}): Parameters<typeof createFragments>[0][number] {
  const { assessment, contract } = input;
  const requirement = assessment.requirement;
  const key = slug(requirement.requirementKey || requirement.statement, `gap-${input.index + 1}`);

  /**
   * The lane a fragment falls back to when its requirement declared none.
   *
   * A stable id with the prose beside it, never prose used as the id — that
   * conflation is what made a fragment's evidence uncountable.
   */
  const lane: EvidenceLane =
    requirement.requiredEvidence[0] ??
    (assessment.gapType === 'UNRESOLVED_CONTRADICTION'
      ? {
          id: 'contradiction_resolution',
          description: 'The source that settles which of the conflicting accounts is right.',
          necessity: 'REQUIRED',
        }
      : {
          id: 'primary_source',
          description: 'A primary source that states the answer directly.',
          necessity: 'REQUIRED',
        });

  /**
   * What "enough" means depends on why the gap is open — and where the archive
   * gives no reason to think otherwise, it is not the planner's to decide.
   *
   * A requirement the archive found *contradictory*, or resting on sources that
   * turned out to be one source, needs corroboration and says so: 3. A
   * definition mismatch needs one source that measures the right thing: 1.
   *
   * Everything else — an ordinary MISSING requirement — declares 1, and used to
   * declare 2. That 2 was a guess made before anyone could know what kind of
   * claim would answer the question, and for a statutory question the answer is
   * a quoted statute, which is conclusive on its own (§14). The gate raises the
   * bar per claim from `standards.ts` once there is evidence to type, so a
   * question that really is contested is still held to a higher standard —
   * decided by the claims that answer it rather than by a number chosen in
   * advance of them.
   */
  const minSources =
    assessment.status === 'CONTRADICTED' || assessment.gapType === 'INSUFFICIENT_INDEPENDENCE'
      ? 3
      : 1;

  return {
    orchestrationId: '',
    projectId: requirement.projectId,
    layerId: requirement.layerId,
    fragmentIndex: input.index,
    fragmentKey: key,
    question: questionFor(assessment),
    geography: contract?.geography ?? null,
    timeframe: contract?.timeframe ?? null,
    population: contract?.population ?? null,
    definitions:
      contract && contract.definitions.length > 0
        ? contract.definitions.map((entry) => `${entry.term}: ${entry.definition}`).join(' | ')
        : null,
    requiredEvidence: requirement.requiredEvidence.length > 0 ? requirement.requiredEvidence : [lane],
    acceptableSourceTypes: acceptableSources(assessment),
    excludedSourceTypes: ['vendor marketing pages', 'unattributed summaries', 'search result snippets'],
    completionCriteria:
      requirement.completionCriteria.length > 0
        ? requirement.completionCriteria
        : ['a claim with a canonical source URL and the exact supporting passage'],
    dependsOn: typeDependencies(requirement.dependsOn, input.siblings ?? []),
    minIndependentSources: minSources,
    status: 'QUEUED' as const,
    requirementIds: [requirement.id],
    evidenceLane: lane.id,
    whyItMatters: requirement.rationale ?? requirement.statement,
    missingEvidence: assessment.gapDetail ?? requirement.statement,
    whyExistingInsufficient: assessment.reasons.join(' '),
    existingClaimIds: assessment.claimIds,
    excludedScope: contract?.excludedSubjects.join('; ') ?? null,
    expectedClaimTypes: expectedClaimTypes(requirement),
    preferredSourceTypes: ['official statistics', 'regulatory filings', 'primary legislation'],
    prohibitedEvidence: contract?.prohibitedAssumptions ?? [],
    requiredComparisons: contract?.requiredComparisons ?? [],
    requiredCalculations: contract?.requiredCalculations ?? [],
    contradictionTargets:
      assessment.status === 'CONTRADICTED' ? assessment.claimIds : [],
    failureConditions: [
      'No public source measures this on the terms this fragment requires.',
      'Every candidate source is a restatement of one upstream estimate.',
    ],
    uncertaintyTolerance: contract?.acceptableUncertainty ?? null,
    priority: requirement.necessity === 'MANDATORY' ? 1 : requirement.necessity === 'SUPPORTING' ? 5 : 8,
    estimatedEffort: assessment.status === 'MISSING' ? 'HIGH' : 'MEDIUM',
    maxRepairs: 2,
  };
}

/** The question a fragment asks, phrased by what is wrong with the current answer. */
function questionFor(assessment: CoverageAssessment): string {
  const statement = assessment.requirement.statement.replace(/\.$/, '');
  switch (assessment.status) {
    case 'PRESENT_BUT_UNVERIFIED':
      return `Which primary source establishes that ${lowerFirst(statement)}, and what exactly does it say?`;
    case 'STALE':
      return `What does the most recent published evidence show about ${lowerFirst(statement)}?`;
    case 'CONTRADICTED':
      return `Which source resolves the disagreement about ${lowerFirst(statement)}, and on what basis?`;
    case 'DEFINITION_MISMATCH':
      return `What evidence measures ${lowerFirst(statement)} on exactly the terms this assignment defines?`;
    case 'SUPERSEDED':
      return `What is the current evidence for ${lowerFirst(statement)}?`;
    case 'PARTIALLY_SATISFIED':
      return `What independent source corroborates ${lowerFirst(statement)}?`;
    default:
      return statement.endsWith('?') ? statement : `${statement}?`;
  }
}

function acceptableSources(assessment: CoverageAssessment): string[] {
  if (assessment.requirement.kind === 'DEFINITION') {
    return ['standards bodies', 'statutory definitions', 'official classification systems'];
  }
  if (assessment.requirement.kind === 'CALCULATION') {
    return ['official datasets', 'regulatory filings', 'published methodologies'];
  }
  return ['government statistics', 'regulatory filings', 'peer-reviewed research', 'official registries'];
}

function expectedClaimTypes(requirement: Requirement): string[] {
  switch (requirement.kind) {
    case 'CALCULATION':
      return ['SOURCED_FACT', 'CALCULATION'];
    case 'DEFINITION':
      return ['SOURCED_FACT', 'QUOTATION'];
    case 'COMPARISON':
      return ['SOURCED_FACT'];
    default:
      return ['SOURCED_FACT'];
  }
}

function lowerFirst(value: string): string {
  return value.length > 0 ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function slug(value: string, fallback: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return out.length > 0 ? out : fallback;
}

/**
 * Create fragments for the gaps that need research, and nothing else.
 *
 * The count is whatever the gaps produce. Existing fragments are left alone, so
 * this is safe to call again after new evidence lands: it adds what the new
 * coverage says is still open and never duplicates a key.
 */
export async function planFragmentsFromGaps(input: {
  orchestrationId: string;
  reconciliation: ReconciliationResult;
}): Promise<ResearchFragment[]> {
  const existing = await currentFragments(input.orchestrationId);
  const taken = new Set(existing.map((fragment) => fragment.fragmentKey));
  const perRequirement = new Map<string, number>();
  for (const fragment of existing) {
    for (const requirementId of fragment.requirementIds) {
      perRequirement.set(requirementId, (perRequirement.get(requirementId) ?? 0) + 1);
    }
  }

  const briefs: Parameters<typeof createFragments>[0] = [];
  let index = existing.length;

  for (const assessment of input.reconciliation.researchable) {
    if (existing.length + briefs.length >= MAX_FRAGMENTS_TOTAL) break;
    const already = perRequirement.get(assessment.requirement.id) ?? 0;
    if (already >= MAX_FRAGMENTS_PER_REQUIREMENT) continue;

    const brief = briefFromGap({
      assessment,
      contract: input.reconciliation.contract,
      index,
      siblings: input.reconciliation.requirements,
    });
    if (taken.has(brief.fragmentKey)) continue;

    taken.add(brief.fragmentKey);
    perRequirement.set(assessment.requirement.id, already + 1);
    briefs.push({ ...brief, orchestrationId: input.orchestrationId });
    index += 1;
  }

  // A boundary nobody could settle is itself a research question, and answering
  // it first is cheaper than researching the wrong thing.
  for (const ambiguity of input.reconciliation.contract?.ambiguities ?? []) {
    if (existing.length + briefs.length >= MAX_FRAGMENTS_TOTAL) break;
    const key = slug(`boundary-${ambiguity.question}`, `boundary-${index + 1}`);
    if (taken.has(key)) continue;
    taken.add(key);
    briefs.push({
      orchestrationId: input.orchestrationId,
      projectId: input.reconciliation.requirements[0]?.projectId ?? '',
      layerId: input.reconciliation.requirements[0]?.layerId ?? '',
      fragmentIndex: index,
      fragmentKey: key,
      question: ambiguity.question,
      geography: input.reconciliation.contract?.geography ?? null,
      timeframe: input.reconciliation.contract?.timeframe ?? null,
      population: input.reconciliation.contract?.population ?? null,
      definitions: null,
      requiredEvidence: [
        {
          id: 'authoritative_definition',
          description: 'An authoritative definition of the term, quoted, with its source.',
          necessity: 'REQUIRED',
        },
      ],
      acceptableSourceTypes: ['standards bodies', 'statutory definitions', 'official classifications'],
      excludedSourceTypes: ['vendor marketing pages'],
      completionCriteria: ['one authoritative definition, quoted, with its source'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED' as const,
      requirementIds: [],
      evidenceLane: 'authoritative definition',
      whyItMatters: ambiguity.why,
      missingEvidence: ambiguity.question,
      whyExistingInsufficient:
        'The assignment cannot be scoped until this is settled, and guessing it would put every ' +
        'downstream fragment at risk of answering the wrong question.',
      existingClaimIds: [],
      excludedScope: null,
      expectedClaimTypes: ['SOURCED_FACT', 'QUOTATION'],
      preferredSourceTypes: ['standards bodies', 'statutory definitions'],
      prohibitedEvidence: [],
      requiredComparisons: [],
      requiredCalculations: [],
      contradictionTargets: [],
      failureConditions: ['No authority defines this term for the assignment\'s scope.'],
      uncertaintyTolerance: null,
      priority: 0,
      estimatedEffort: 'LOW',
      maxRepairs: 2,
    });
    index += 1;
  }

  // Urgency is decided across the whole set, not per requirement: which tier a
  // fragment belongs to depends on what else was planned and what depends on it.
  return createFragments(assignExecutionPriority(briefs));
}

export type { CoverageAssessment };
