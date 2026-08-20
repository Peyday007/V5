/**
 * The Brain ↔ research-worker loop.
 *
 *   assignment
 *     -> decompose into bounded fragments
 *     -> research each fragment as its own job
 *     -> verify each fragment's claims against its own evidence gate
 *     -> repair, narrow or re-run the fragments that failed
 *     -> synthesize from the accepted ledgers only
 *     -> Brain's primary / adversarial / judge audit on the assembled packet
 *     -> file the artifact, or say exactly what is still missing
 *
 * Three properties this file exists to guarantee.
 *
 * Nothing is believed. Every reply is validated before it is stored, every claim
 * is checked against the gate before it is accepted, and a fragment that cannot
 * clear the gate contributes nothing — not a weakened version of its findings,
 * nothing. Breadth is the number of fragments, never a relaxed bar inside one.
 *
 * Nothing is lost. Each pass is written down before the call and completed after
 * it; each fragment attempt stays in the table with its verdict; a rejected claim
 * keeps its rejection reason so it cannot return through a later attempt. A
 * process that dies mid-pass leaves a record that says exactly that.
 *
 * Nothing hangs. Every provider call is bounded and cancellable, and cancelling
 * kills the work rather than orphaning it.
 */
import crypto from 'node:crypto';
import type {
  ClaimType,
  Layer,
  Project,
  ResearchJob,
  ResearchClaim,
  ResearchFragment,
  ResearchOrchestration,
  ResearchPassKey,
} from '../../domain/types.ts';
import type { AIProvider } from '../../providers/types.ts';
import { getProvider } from '../../providers/index.ts';
import { getLayer } from '../../repos/layers.ts';
import { getProject } from '../../repos/projects.ts';
import { getRun, createRun, updateRun } from '../../repos/runs.ts';
import { recordEvent } from '../../repos/events.ts';
import { listDocuments } from '../../repos/documents.ts';
import { listLayers } from '../../repos/layers.ts';
import {
  MAX_FRAGMENTS_TOTAL,
  persistPlan,
  planFragmentsFromGaps,
  reconcile,
} from '../reconcile/plan.ts';
import {
  acceptedClaims,
  beat,
  completedPass,
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  finishPass,
  getFragment,
  getOrchestration,
  insertClaims,
  listClaimsForFragment,
  listFragments,
  listPasses,
  markContradiction,
  startPass,
  updateClaimDerivedFrom,
  updateFragment,
  updateOrchestration,
} from '../../repos/research.ts';
import { runDynamicAudit, AuditFailure } from '../audit/pipeline.ts';
import { enqueueExtraction } from '../documents/queue.ts';
import { isAuditable } from '../documents/quality.ts';
import { registerRunArtifact, targetVersionForRun } from '../runArtifacts.ts';
import { selectRelevantSegments } from '../sources/ingest.ts';
import { applyGate, fragmentPasses, type GateResult } from './gate.ts';
import { bundleFragments, modelFor, type Bundle } from './bundling.ts';
import { executionOrder, quotaDecision, type QuotaDecision } from './quota.ts';
import { planContradictionFragments, reconcileAcceptedFragment } from './replan.ts';
import { buildRepairPlan, describeRepairPlan } from './repair.ts';
import { modelDefaults } from '../providers/connection.ts';
import {
  cancelQueuedJobs,
  createJob,
  getConnection,
  openQuotaPause,
  recordFragmentOutcome,
  recordQuotaPause,
  resolveQuotaPause,
  updateJob,
} from '../../repos/jobs.ts';
import { dependenciesSettled, planDependencies, shouldSplit, splitFragment } from './splitting.ts';
import {
  buildBundledResearchPrompt,
  buildFragmentResearchPrompt,
  type RepairContext,
  buildGoalPlanPrompt,
  buildSynthesisPrompt,
  buildVerificationPrompt,
} from './prompts.ts';
import {
  parseBundledResearchPass,
  parseGoalPlan,
  type ResearchPassOutput,
  parseSynthesisPass,
  parseVerificationPass,
  type ParseResult,
} from './schema.ts';
import { validateClaim } from './sources.ts';
import { independenceGroup } from './standards.ts';

/** How many times one fragment may be repaired before a person is needed. */
export const MAX_FRAGMENT_ATTEMPTS = 3;

/** Ceiling for one provider call. Deep research is slow; hanging is not research. */
export const DEFAULT_PASS_TIMEOUT_MS = 15 * 60 * 1000;

/** Raised when the orchestration cannot continue. The record explains where it stopped. */
export class ResearchFailure extends Error {
  readonly orchestrationId: string;
  readonly passKey: ResearchPassKey | 'CONTEXT';

  constructor(orchestrationId: string, passKey: ResearchPassKey | 'CONTEXT', message: string) {
    super(message);
    this.name = 'ResearchFailure';
    this.orchestrationId = orchestrationId;
    this.passKey = passKey;
  }
}

/** Cancellation is not a failure; it is a decision, and it reads differently. */
export class ResearchCancelled extends Error {
  readonly orchestrationId: string;

  constructor(orchestrationId: string, message: string) {
    super(message);
    this.name = 'ResearchCancelled';
    this.orchestrationId = orchestrationId;
  }
}

export interface ResearchProgress {
  orchestrationId: string;
  phase: 'PLANNING' | 'RESEARCHING' | 'SYNTHESIZING' | 'AUDITING' | 'DONE';
  passKey: ResearchPassKey | null;
  fragmentKey: string | null;
  /** Fragments settled so far, and how many there are. */
  index: number;
  total: number;
  message: string;
}

export interface RunOrchestrationOptions {
  provider?: AIProvider;
  signal?: AbortSignal;
  onProgress?: (progress: ResearchProgress) => void;
  timeoutMs?: number;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireContext(orchestration: ResearchOrchestration): { project: Project; layer: Layer } {
  const project = getProject(orchestration.projectId);
  const layer = getLayer(orchestration.layerId);
  if (!project || !layer) {
    throw new ResearchFailure(orchestration.id, 'CONTEXT', 'The project or layer no longer exists.');
  }
  return { project, layer };
}

function checkCancelled(orchestrationId: string, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ResearchCancelled(orchestrationId, 'The research run was cancelled.');
  }
  const current = getOrchestration(orchestrationId);
  if (current?.status === 'CANCELLED') {
    throw new ResearchCancelled(orchestrationId, 'The research run was cancelled.');
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PassOptions {
  orchestration: ResearchOrchestration;
  fragmentId?: string | null;
  passKey: ResearchPassKey;
  ordinal: number;
  attempt?: number;
  prompt: string;
  provider: AIProvider;
  options: RunOrchestrationOptions;
  expectedTitle: string;
  expectedFilename: string;
}

/**
 * One provider call, recorded whichever way it goes.
 *
 * The pass row exists before the call, so a process killed mid-flight leaves a
 * RUNNING row that restart recovery can find and close honestly, rather than no
 * evidence that the work was ever attempted.
 */
async function callProvider<T>(
  input: PassOptions,
  parse: (text: string) => ParseResult<T>,
): Promise<{ value: T; raw: string; passId: string }> {
  const { orchestration, provider } = input;
  checkCancelled(orchestration.id, input.options.signal);

  // Resumption: a pass that already completed is never bought twice. After a
  // crash between the scan and its verification, the scan's claims are already
  // in the ledger and the job continues from there.
  const done = completedPass(orchestration.id, input.passKey, input.fragmentId ?? null);
  if (done && done.attempt === (input.attempt ?? 1) && done.rawResponse) {
    const reparsed = parse(done.rawResponse);
    if (reparsed.ok) {
      return { value: reparsed.value, raw: done.rawResponse, passId: done.id };
    }
  }

  const pass = startPass({
    orchestrationId: orchestration.id,
    fragmentId: input.fragmentId ?? null,
    passKey: input.passKey,
    ordinal: input.ordinal,
    attempt: input.attempt ?? 1,
    provider: provider.name,
    model: orchestration.model,
    prompt: input.prompt,
    promptSha256: sha256(input.prompt),
  });
  beat(orchestration.id);

  const startedAt = Date.now();
  let response: { text: string; externalResponseId: string | null };
  try {
    response = await withTimeout(
      provider.runResearch(
        {
          prompt: input.prompt,
          requiredAttachments: [],
          expectedConversationTitle: input.expectedTitle,
          expectedFilename: input.expectedFilename,
          model: orchestration.model,
        },
        {
          ...(input.options.signal ? { signal: input.options.signal } : {}),
          runId: orchestration.runId,
        },
      ),
      input.options.timeoutMs ?? DEFAULT_PASS_TIMEOUT_MS,
      `${input.passKey} pass`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = input.options.signal?.aborted === true;
    finishPass(pass.id, {
      status: cancelled ? 'CANCELLED' : 'FAILED',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    if (cancelled) throw new ResearchCancelled(orchestration.id, 'The research run was cancelled.');
    throw new ResearchFailure(orchestration.id, input.passKey, message);
  }

  const parsed = parse(response.text);
  if (!parsed.ok) {
    // The raw reply is kept: a result that cannot be validated is still the
    // evidence for why this pass failed.
    finishPass(pass.id, {
      status: 'FAILED',
      rawResponse: response.text,
      error: parsed.error,
      jobId: response.externalResponseId,
      durationMs: Date.now() - startedAt,
    });
    throw new ResearchFailure(
      orchestration.id,
      input.passKey,
      `The ${input.passKey} pass returned output the platform will not act on: ${parsed.error}`,
    );
  }

  finishPass(pass.id, {
    status: 'COMPLETE',
    rawResponse: response.text,
    parsed: parsed.value,
    jobId: response.externalResponseId,
    durationMs: Date.now() - startedAt,
  });
  beat(orchestration.id);
  return { value: parsed.value, raw: response.text, passId: pass.id };
}

// ---------------------------------------------------------------------------
// Starting an assignment
// ---------------------------------------------------------------------------

export interface StartResearchInput {
  layerId: string;
  title?: string | null;
  assignment: string;
  targetVersion?: string | null;
  providerName?: string | null;
  model?: string | null;
  /** Attach to an existing assignment run instead of creating one. */
  runId?: string | null;
}

/**
 * Create the assignment and its orchestration. Nothing runs yet.
 *
 * The run row is the assignment Brain issued, exactly as for a copy-the-prompt
 * workflow — so a staged research job and a hand-run one produce the same
 * lineage, the same dependencies and the same document in the end.
 */
export function startResearch(input: StartResearchInput): ResearchOrchestration {
  const layer = getLayer(input.layerId);
  if (!layer) throw new Error(`Unknown layer ${input.layerId}`);
  const project = getProject(layer.projectId);
  if (!project) throw new Error(`Unknown project ${layer.projectId}`);

  const assignment = input.assignment.trim();
  if (assignment.length === 0) throw new Error('An assignment needs a research question.');

  const providerName = (input.providerName ?? '').trim() || undefined;
  const provider = getProvider(providerName);
  const title = (input.title ?? '').trim() || `${layer.name} research`;

  const existing = input.runId ? getRun(input.runId) : null;
  const run =
    existing ??
    createRun({
      projectId: project.id,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'RUNNING',
      provider: provider.name,
      model: input.model ?? null,
      prompt: assignment,
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
    });
  if (existing) updateRun(run.id, { status: 'RUNNING', provider: provider.name });

  const orchestration = createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title,
    assignment,
    targetVersion: input.targetVersion ?? run.targetVersion ?? null,
    provider: provider.name,
    model: input.model ?? null,
  });

  recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: run.id,
    eventType: 'RESEARCH_QUEUED',
    payload: { orchestrationId: orchestration.id, provider: provider.name, title },
  });

  return orchestration;
}

// ---------------------------------------------------------------------------
// Pass 1 — fragmentation
// ---------------------------------------------------------------------------

/** Passages from the project's own sources that bear on this assignment. */
function relevantPassages(
  projectId: string,
  query: string,
): { title: string; text: string }[] {
  const sources = listDocuments(projectId).filter((document) => document.scope !== 'LAYER');
  const passages: { title: string; text: string }[] = [];
  for (const source of sources) {
    // Never the whole transcript: only the segments that bear on this question.
    const selected = selectRelevantSegments({
      documentId: source.id,
      query,
      budgetChars: 6_000,
      limit: 4,
    });
    for (const segment of selected) {
      passages.push({ title: `${source.canonicalName} — ${segment.title}`, text: segment.text });
    }
  }
  return passages.slice(0, 6);
}

/**
 * Pass 1: work out what the goal requires, then what the project already knows,
 * and create fragments only for what is genuinely missing.
 *
 * This is the governing rule of the whole build. Research is expensive and slow,
 * and the most expensive research is the kind that re-establishes something the
 * archive already contains — or worse, that quietly disagrees with it. So the
 * order is fixed: boundaries, requirements, existing claims, coverage, gaps, and
 * only then fragments.
 */
async function planFragments(
  orchestration: ResearchOrchestration,
  project: Project,
  layer: Layer,
  provider: AIProvider,
  options: RunOrchestrationOptions,
): Promise<ResearchFragment[]> {
  const existing = currentFragments(orchestration.id);
  if (existing.length > 0) return existing;

  updateOrchestration(orchestration.id, { status: 'PLANNING', currentPass: 'PLAN' });
  options.onProgress?.({
    orchestrationId: orchestration.id,
    phase: 'PLANNING',
    passKey: 'PLAN',
    fragmentKey: null,
    index: 0,
    total: 0,
    message: 'Working out what the goal requires',
  });

  const documents = listDocuments(project.id)
    .filter((document) => !document.fileMissing)
    .map((document) => `${document.canonicalName}${document.version ? ` (${document.version})` : ''}`);

  const prompt = buildGoalPlanPrompt({
    project,
    layer,
    title: orchestration.title,
    assignment: orchestration.assignment,
    passages: relevantPassages(project.id, `${orchestration.title} ${orchestration.assignment}`),
    existingDocuments: documents,
  });

  const { value } = await callProvider(
    {
      orchestration,
      passKey: 'PLAN',
      ordinal: 1,
      prompt,
      provider,
      options,
      expectedTitle: `${orchestration.title} — requirements`,
      expectedFilename: 'requirements.json',
    },
    parseGoalPlan,
  );

  const layers = listLayers(project.id);
  const { contract, requirements } = persistPlan({
    orchestrationId: orchestration.id,
    project,
    layer,
    contract: value.boundary,
    requirements: value.requirements.map((requirement) => ({
      requirementKey: requirement.key,
      ordinal: 0,
      statement: requirement.statement,
      necessity: requirement.necessity,
      kind: requirement.kind,
      rationale: requirement.rationale,
      requiredEvidence: requirement.requiredEvidence,
      completionCriteria: requirement.completionCriteria,
      dependsOn: requirement.dependsOn,
      owningLayerId:
        layers.find(
          (candidate) =>
            candidate.name.toLowerCase() === (requirement.owningLayerName ?? '').trim().toLowerCase(),
        )?.id ?? null,
    })),
  });

  options.onProgress?.({
    orchestrationId: orchestration.id,
    phase: 'PLANNING',
    passKey: 'PLAN',
    fragmentKey: null,
    index: 0,
    total: requirements.length,
    message: `Comparing ${requirements.length} requirement(s) against what the project already holds`,
  });

  // Read the archive, judge every requirement against it, and record why.
  const reconciliation = reconcile({
    orchestrationId: orchestration.id,
    projectId: project.id,
    requirements,
    contract,
  });

  const fragments = planFragmentsFromGaps({
    orchestrationId: orchestration.id,
    reconciliation,
  });

  recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_PLANNED',
    payload: {
      orchestrationId: orchestration.id,
      requirements: requirements.length,
      documentsRead: reconciliation.documentsRead,
      existingClaims: reconciliation.claims.length,
      satisfied: reconciliation.satisfied.length,
      notResearch: reconciliation.notResearch.length,
      gaps: reconciliation.researchable.length,
      fragments: fragments.length,
    },
  });

  options.onProgress?.({
    orchestrationId: orchestration.id,
    phase: 'PLANNING',
    passKey: 'PLAN',
    fragmentKey: null,
    index: 0,
    total: fragments.length,
    message:
      `${reconciliation.satisfied.length} requirement(s) already satisfied by the archive; ` +
      `${fragments.length} fragment(s) created for genuine gaps`,
  });

  return fragments;
}

// ---------------------------------------------------------------------------
// One fragment's job
// ---------------------------------------------------------------------------

/** Claims already accepted by the fragments this one depends on. */
function dependencyClaims(
  orchestrationId: string,
  fragment: ResearchFragment,
): { fragmentKey: string; claim: ResearchClaim }[] {
  if (fragment.dependsOn.length === 0) return [];
  const wanted = new Set(fragment.dependsOn);
  const out: { fragmentKey: string; claim: ResearchClaim }[] = [];
  for (const other of currentFragments(orchestrationId)) {
    if (!wanted.has(other.fragmentKey) || other.status !== 'ACCEPTED') continue;
    for (const claim of listClaimsForFragment(other.id)) {
      if (claim.accepted) out.push({ fragmentKey: other.fragmentKey, claim });
    }
  }
  return out.slice(0, 40);
}

/** Everything a repair must not repeat, from every earlier attempt at this fragment. */
function rejectedHistory(
  orchestrationId: string,
  fragmentKey: string,
): { claim: string; why: string }[] {
  const out: { claim: string; why: string }[] = [];
  for (const fragment of listAttempts(orchestrationId, fragmentKey)) {
    for (const claim of listClaimsForFragment(fragment.id)) {
      if (!claim.accepted && claim.rejectionReason) {
        out.push({ claim: claim.claim, why: claim.rejectionReason });
      }
    }
  }
  return out;
}

/**
 * Every attempt at one fragment, not just the newest.
 *
 * `currentFragments` collapses a key to its latest attempt, which is what the
 * queue and the synthesis want. Repairs want the opposite: the whole failure
 * history, so the next attempt knows what has already been tried and rejected.
 */
function listAttempts(orchestrationId: string, fragmentKey: string): ResearchFragment[] {
  return listFragments(orchestrationId).filter(
    (fragment) => fragment.fragmentKey === fragmentKey,
  );
}

/**
 * Run one job and judge every fragment in it separately.
 *
 * The execution is shared; nothing else is. Each fragment's claims are stored
 * against that fragment, verified against that fragment's brief, and gated by
 * that fragment's standard — so one fragment failing inside a successful job is
 * an ordinary outcome rather than a contamination.
 */
async function runBundle(input: {
  orchestration: ResearchOrchestration;
  project: Project;
  layer: Layer;
  bundle: Bundle;
  job: ResearchJob;
  provider: AIProvider;
  options: RunOrchestrationOptions;
}): Promise<Map<string, GateResult>> {
  const { orchestration, bundle, job, provider, options } = input;
  const results = new Map<string, GateResult>();
  const startedAt = Date.now();

  for (const fragment of bundle.fragments) {
    updateFragment(fragment.id, { status: 'RUNNING', startedAt: new Date().toISOString() });
  }
  updateJob(job.id, { status: 'RUNNING', startedAt: new Date().toISOString() });

  const bundled = bundle.fragments.length > 1;
  const passKey: ResearchPassKey = bundle.fragments[0]!.attempt > 1 ? 'TARGETED' : 'BROAD_SCAN';
  const dependencies = bundle.fragments.flatMap((fragment) =>
    dependencyClaims(orchestration.id, fragment),
  );

  // A repair carries its own failure history whether it runs alone or shares a
  // job — the whole point of a repair is that the worker is told what failed.
  const repairs = new Map<string, RepairContext>();
  for (const fragment of bundle.fragments) {
    if (fragment.attempt <= 1) continue;
    repairs.set(fragment.fragmentKey, {
      reason: fragment.repairReason ?? 'The previous attempt did not clear the evidence gate.',
      strategy: fragment.repairStrategy ?? 'Search differently and narrow the question.',
      rejected: rejectedHistory(orchestration.id, fragment.fragmentKey),
    });
  }

  const prompt = bundled
    ? buildBundledResearchPrompt({
        project: input.project,
        layer: input.layer,
        fragments: bundle.fragments,
        dependencyClaims: dependencies,
        rationale: bundle.rationale,
        repairs,
      })
    : buildFragmentResearchPrompt({
        project: input.project,
        layer: input.layer,
        fragment: bundle.fragments[0]!,
        dependencyClaims: dependencies,
        repair: repairs.get(bundle.fragments[0]!.fragmentKey) ?? null,
      });

  const keys = bundle.fragments.map((fragment) => fragment.fragmentKey);

  let research;
  try {
    research = await callProvider(
      {
        orchestration,
        fragmentId: bundled ? null : bundle.fragments[0]!.id,
        passKey,
        ordinal: 2,
        attempt: bundle.fragments[0]!.attempt,
        prompt,
        provider,
        options,
        expectedTitle: `${orchestration.title} — ${keys.join(', ')}`,
        expectedFilename: `${keys[0]}.json`,
      },
      (text) => parseBundledResearchPass(text, keys),
    );
  } catch (error) {
    if (error instanceof ResearchCancelled) {
      updateJob(job.id, { status: 'CANCELLED', failureReason: error.message });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateJob(job.id, {
      status: 'FAILED',
      failureReason: message,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });
    for (const fragment of bundle.fragments) {
      recordFragmentOutcome(job.id, fragment.id, 'FAILED', message);
      updateFragment(fragment.id, {
        status: 'BLOCKED',
        blockedReason: message,
        completedAt: new Date().toISOString(),
      });
      results.set(fragment.id, failedGate(message));
    }
    return results;
  }

  updateJob(job.id, {
    status: 'COMPLETE',
    externalJobId: research.passId,
    promptBytes: Buffer.byteLength(prompt),
    outputBytes: Buffer.byteLength(research.raw),
    durationMs: Date.now() - startedAt,
    completedAt: new Date().toISOString(),
  });

  for (const fragment of bundle.fragments) {
    const output = research.value.byFragment.get(fragment.fragmentKey) ?? {
      claims: [],
      searchQueries: [],
      unresolved: [],
      notes: '',
    };
    try {
      const gate = await judgeFragment({
        orchestration,
        fragment,
        job,
        output,
        passId: research.passId,
        passKey,
        provider,
        options,
      });
      results.set(fragment.id, gate);
      recordFragmentOutcome(
        job.id,
        fragment.id,
        fragmentPasses(gate) ? 'ACCEPTED' : 'BLOCKED',
        gate.reasons.join(' ') || null,
      );
    } catch (error) {
      if (error instanceof ResearchCancelled) throw error;
      // One fragment failing inside a shared job is that fragment's problem.
      const message = error instanceof Error ? error.message : String(error);
      updateFragment(fragment.id, {
        status: 'BLOCKED',
        blockedReason: message,
        completedAt: new Date().toISOString(),
      });
      recordFragmentOutcome(job.id, fragment.id, 'FAILED', message);
      results.set(fragment.id, failedGate(message));
    }
  }

  return results;
}

function failedGate(message: string): GateResult {
  return {
    integrity: 'FAIL',
    sufficiency: 'INSUFFICIENT',
    claims: [],
    acceptedClaims: 0,
    rejectedClaims: 0,
    independentSources: 0,
    coverage: [],
    duplicateSourceGroups: [],
    failedConditions: [],
    reasons: [message],
    unresolvedGaps: [],
  };
}

/**
 * Store one fragment's claims, verify them, and apply its gate.
 *
 * Verification is per fragment even inside a bundle: the verifier is shown one
 * fragment's brief and one fragment's ledger, because asking it to judge four
 * ledgers at once is how claims get attributed to the wrong question.
 */
async function judgeFragment(input: {
  orchestration: ResearchOrchestration;
  fragment: ResearchFragment;
  job: ResearchJob;
  output: ResearchPassOutput;
  passId: string;
  passKey: ResearchPassKey;
  provider: AIProvider;
  options: RunOrchestrationOptions;
}): Promise<GateResult> {
  const { orchestration, fragment, job, output, provider, options } = input;

  const stored = insertClaims(
    output.claims.map((claim) => {
      const validated = validateClaim(claim);
      const claimType = (claim.claimType ?? 'SOURCED_FACT') as ClaimType;
      return {
        orchestrationId: orchestration.id,
        fragmentId: fragment.id,
        passId: input.passId,
        passKey: input.passKey,
        claim: claim.claim,
        claimType,
        sourceGroup: independenceGroup({
          sourceUrl: validated.normalizedUrl ?? claim.sourceUrl ?? null,
          sourcePublisher: claim.sourcePublisher ?? null,
          evidenceExcerpt: claim.evidenceExcerpt ?? null,
        }),
        primarySource: claim.primarySource ?? false,
        geography: fragment.geography,
        timeframe: fragment.timeframe,
        population: fragment.population,
        definition: fragment.definitions,
        requirementIds: fragment.requirementIds,
        jobId: job.id,
        sourceUrl: validated.normalizedUrl ?? claim.sourceUrl ?? null,
        sourceTitle: claim.sourceTitle ?? null,
        sourcePublisher: claim.sourcePublisher ?? null,
        sourceDate: claim.sourceDate ?? null,
        evidenceExcerpt: claim.evidenceExcerpt ?? null,
        evidenceLocator: claim.evidenceLocator ?? null,
        evidenceLane: claim.evidenceLane ?? null,
        retrievedAt: claim.retrievedAt ?? null,
        confidence: claim.confidence,
        validationState: validated.validationState,
        validationDetail: validated.validationDetail,
        sourced: validated.sourced,
        derived: claim.derived,
        derivedFrom: claim.derivedFrom,
        contentHash: validated.contentHash,
      };
    }),
  );

  // Resolve derivation references from whatever the worker called them to real
  // claim ids, so the gate can check that a calculation's inputs were accepted.
  const byRef = new Map<string, string>();
  stored.forEach((claim, index) => {
    byRef.set(String(index), claim.id);
    byRef.set(claim.claim.trim().toLowerCase().slice(0, 80), claim.id);
  });
  for (const [index, claim] of stored.entries()) {
    const source = output.claims[index];
    if (!source || !source.derived || source.derivedFrom.length === 0) continue;
    const resolved = source.derivedFrom
      .map((ref) => byRef.get(ref.trim().toLowerCase().slice(0, 80)) ?? byRef.get(ref.trim()))
      .filter((id): id is string => Boolean(id));
    updateClaimDerivedFrom(claim.id, resolved);
  }

  updateFragment(fragment.id, { status: 'VALIDATING' });

  const claims = listClaimsForFragment(fragment.id);
  const verification = await callProvider(
    {
      orchestration,
      fragmentId: fragment.id,
      passKey: 'VERIFICATION',
      ordinal: 3,
      attempt: fragment.attempt,
      prompt: buildVerificationPrompt({ fragment, claims }),
      provider,
      options,
      expectedTitle: `${orchestration.title} — ${fragment.fragmentKey} verification`,
      expectedFilename: `${fragment.fragmentKey}-verification.json`,
    },
    parseVerificationPass,
  );

  const verdicts = new Map<
    string,
    { supportsClaim: boolean; scopeMatch: (typeof verification.value.claimVerdicts)[number]['scopeMatch']; note: string }
  >();
  for (const verdict of verification.value.claimVerdicts) {
    const claim = claims[verdict.claimIndex];
    if (!claim) continue;
    verdicts.set(claim.id, {
      supportsClaim: verdict.supportsClaim,
      scopeMatch: verdict.scopeMatch,
      note: verdict.note,
    });
    if (verdict.contradictionState !== 'UNCHALLENGED') {
      markContradiction(claim.id, verdict.contradictionState, verdict.note || null);
    }
  }

  const gate = applyGate({
    fragment,
    claims: listClaimsForFragment(fragment.id),
    verification: {
      verdicts,
      sufficiency: verification.value.sufficiency,
      missingLanes: verification.value.missingLanes,
      unresolvedGaps: verification.value.unresolvedGaps,
    },
  });

  for (const judgement of gate.claims) {
    decideClaim(judgement.claimId, {
      accepted: judgement.accepted,
      rejectionReason: judgement.reason,
      scopeMatch: verdicts.get(judgement.claimId)?.scopeMatch ?? null,
    });
  }

  const passed = fragmentPasses(gate);
  updateFragment(fragment.id, {
    status: passed ? 'ACCEPTED' : 'BLOCKED',
    integrityVerdict: gate.integrity,
    sufficiencyVerdict: gate.sufficiency,
    verdictDetail: gate,
    blockedReason: passed ? null : gate.reasons.join(' '),
    completedAt: new Date().toISOString(),
    acceptedAt: passed ? new Date().toISOString() : null,
  });

  return gate;
}

/**
 * Every fragment that could start now, in dependency then priority order.
 *
 * The queue takes a batch rather than one at a time so compatible fragments can
 * share a job. Order still comes from the dependency graph, so bundling never
 * moves a fragment ahead of its own premise.
 */
function runnableBatch(orchestrationId: string): ResearchFragment[] {
  const fragments = currentFragments(orchestrationId);
  const plan = planDependencies(fragments);
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));

  const ready: ResearchFragment[] = [];
  for (const key of plan.order) {
    const fragment = byKey.get(key);
    if (!fragment) continue;
    if (fragment.status !== 'QUEUED' && fragment.status !== 'PLANNED') continue;
    if (dependenciesSettled(fragment, fragments)) ready.push(fragment);
  }
  if (ready.length > 0) return ready;

  const single = nextRunnable(orchestrationId);
  return single ? [single] : [];
}

function nextRunnable(orchestrationId: string): ResearchFragment | null {
  const fragments = currentFragments(orchestrationId);
  const plan = planDependencies(fragments);
  const byKey = new Map(fragments.map((fragment) => [fragment.fragmentKey, fragment]));

  // Dependency order first, so foundations are answered before the fragments
  // that rest on them and quota is not spent on a premise that may not hold.
  for (const key of plan.order) {
    const fragment = byKey.get(key);
    if (!fragment) continue;
    if (fragment.status !== 'QUEUED' && fragment.status !== 'PLANNED') continue;
    if (dependenciesSettled(fragment, fragments)) return fragment;
  }

  // A cycle would otherwise stall the queue forever. It is reported on the
  // fragments involved and then broken by priority, because refusing to run
  // anything would be worse than running the most foundational one first.
  for (const cycle of plan.cycles) {
    for (const key of cycle) {
      const fragment = byKey.get(key);
      if (!fragment) continue;
      if (fragment.status !== 'QUEUED' && fragment.status !== 'PLANNED') continue;
      updateFragment(fragment.id, {
        blockedReason:
          `This fragment is in a dependency cycle (${cycle.join(' -> ')}), so its premise cannot ` +
          'be settled first. It was run in priority order and the cycle is recorded.',
      });
      return fragment;
    }
  }

  return null;
}

/**
 * Plan the repair of a failed fragment.
 *
 * The strategy is chosen from what actually failed, because "try again" against
 * the same question with the same approach is how a loop burns a user's quota
 * without learning anything.
 */
/**
 * Plan the next attempt at a fragment that failed.
 *
 * Two things make this a repair rather than a retry: the plan is built from
 * what actually failed, and it is filtered against what earlier attempts
 * already tried. Everything else about the fragment is carried forward
 * unchanged — its requirements, its scope, its evidence bar — because a repair
 * answers the same question, not an easier one.
 */
function planRepair(
  orchestration: ResearchOrchestration,
  fragment: ResearchFragment,
  gate: GateResult,
): ResearchFragment | null {
  const history = listAttempts(orchestration.id, fragment.fragmentKey);
  const attempts = history.length;
  // The fragment's own budget, never more than the platform-wide cap.
  const cap = Math.min(MAX_FRAGMENT_ATTEMPTS, 1 + Math.max(0, fragment.maxRepairs));

  if (attempts >= cap) {
    updateFragment(fragment.id, {
      status: 'REJECTED',
      blockedReason:
        `${gate.reasons.join(' ')} After ${attempts} attempt(s) this fragment still cannot meet its ` +
        'evidence bar, so nothing from it enters the synthesis and the gap is reported as unresolved.',
    });
    return null;
  }

  const plan = buildRepairPlan({
    fragment,
    gate,
    history,
    claims: listClaimsForFragment(fragment.id),
    splitRequired: false,
    remainingBudget: cap - attempts,
  });

  const [repaired] = createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: fragment.projectId,
      layerId: fragment.layerId,
      fragmentIndex: fragment.fragmentIndex,
      fragmentKey: fragment.fragmentKey,
      question: plan.narrowerQuestion ?? fragment.question,
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
      attempt: fragment.attempt + 1,
      parentFragmentId: fragment.id,
      repairReason: gate.reasons.join(' '),
      repairStrategy: describeRepairPlan(plan),
      repairPlan: plan,
      status: 'QUEUED',
      // Everything that says what this fragment is for. A repair that lost its
      // requirements would be re-ranked as a boundary question and would never
      // move the coverage matrix when it finally succeeded.
      requirementIds: fragment.requirementIds,
      evidenceLane: fragment.evidenceLane,
      whyItMatters: fragment.whyItMatters,
      missingEvidence: fragment.missingEvidence,
      whyExistingInsufficient: fragment.whyExistingInsufficient,
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
      estimatedEffort: fragment.estimatedEffort,
      maxRepairs: fragment.maxRepairs,
      splitFromId: fragment.splitFromId,
    },
  ]);
  return repaired ?? null;
}

// ---------------------------------------------------------------------------
// The whole loop
// ---------------------------------------------------------------------------

export interface OrchestrationOutcome {
  orchestration: ResearchOrchestration;
  fragments: ResearchFragment[];
  acceptedFragments: number;
  rejectedFragments: number;
  acceptedClaims: number;
  documentId: string | null;
  auditId: string | null;
  verdict: string | null;
}

export async function runOrchestration(
  orchestrationId: string,
  options: RunOrchestrationOptions = {},
): Promise<OrchestrationOutcome> {
  const loaded = getOrchestration(orchestrationId);
  if (!loaded) throw new Error(`Unknown research run ${orchestrationId}`);
  const { project, layer } = requireContext(loaded);
  const provider = options.provider ?? getProvider(loaded.provider);

  updateOrchestration(loaded.id, {
    startedAt: loaded.startedAt ?? new Date().toISOString(),
    failedAt: null,
    failureReason: null,
  });

  try {
    const planned = await planFragments(loaded, project, layer, provider, options);

    updateOrchestration(loaded.id, { status: 'RESEARCHING' });
    let guard = 0;
    // Recomputed each round: replanning may add a contradiction fragment, and a
    // guard fixed at planning time would read that as a runaway loop.
    const ceilingNow = (): number => {
      const total = Math.max(planned.length, currentFragments(loaded.id).length);
      return total * MAX_FRAGMENT_ATTEMPTS + total + 5;
    };

    for (;;) {
      checkCancelled(loaded.id, options.signal);
      const ready = runnableBatch(loaded.id);
      if (ready.length === 0) break;
      guard += 1;
      if (guard > ceilingNow()) {
        throw new ResearchFailure(
          loaded.id,
          'TARGETED',
          'The fragment queue stopped making progress; stopping rather than looping.',
        );
      }

      // What the allowance can pay for comes before what the queue would like to
      // run. A pause here keeps every accepted fragment and every queued one.
      const decision = quotaDecision({
        provider,
        paidOverageEnabled: getConnection(provider.name)?.paidOverageEnabled ?? false,
      });
      if (!decision.canRun) {
        return pauseForQuota(loaded.id, project, layer, decision, options);
      }

      // Most urgent first: the boundary before the evidence inside it, a premise
      // before the fragment resting on it, a contradiction before anything built
      // on top of it.
      const ordered = executionOrder(ready, currentFragments(loaded.id));

      // Compatible fragments ride in one job: same scope, same source types, no
      // dependency between them. Their claims still come back separately.
      const [bundle] = bundleFragments(ordered);
      if (!bundle) break;

      const job = createJob({
        orchestrationId: loaded.id,
        projectId: project.id,
        rationale: bundle.rationale,
        provider: provider.name,
        // Which model this job deserves, from the user's own settings. The
        // evidence bar does not move with it.
        model: modelFor(bundle.jobKind, {
          light: modelDefaults(provider.name).light,
          strong: loaded.model ?? modelDefaults(provider.name).strong,
        }),
        jobKind: bundle.jobKind,
        priority: bundle.priority,
        fragmentIds: bundle.fragments.map((fragment) => fragment.id),
      });

      const settledCount = currentFragments(loaded.id).filter((entry) =>
        ['ACCEPTED', 'REJECTED', 'NEEDS_HUMAN'].includes(entry.status),
      ).length;
      options.onProgress?.({
        orchestrationId: loaded.id,
        phase: 'RESEARCHING',
        passKey: bundle.fragments[0]!.attempt > 1 ? 'TARGETED' : 'BROAD_SCAN',
        fragmentKey: bundle.fragments.map((fragment) => fragment.fragmentKey).join(', '),
        index: settledCount,
        total: currentFragments(loaded.id).length,
        message:
          bundle.fragments.length > 1
            ? `Researching ${bundle.fragments.length} fragments together: ${bundle.fragments
                .map((fragment) => fragment.fragmentKey)
                .join(', ')}`
            : bundle.fragments[0]!.attempt > 1
              ? `Repairing ${bundle.fragments[0]!.fragmentKey} (attempt ${bundle.fragments[0]!.attempt})`
              : `Researching ${bundle.fragments[0]!.fragmentKey}`,
      });

      const gates = await runBundle({
        orchestration: loaded,
        project,
        layer,
        bundle,
        job,
        provider,
        options,
      });

      for (const [fragmentId, gate] of gates) {
        const current = getFragment(fragmentId);
        if (!current) continue;

        if (fragmentPasses(gate)) {
          // Accepted evidence changes what the rest of the run still needs to
          // do: what it confirms, updates or contradicts, which requirements
          // are now covered, and which queued work has become pointless.
          const replan = reconcileAcceptedFragment({
            orchestrationId: loaded.id,
            projectId: project.id,
            fragment: current,
          });
          planContradictionFragments({
            orchestrationId: loaded.id,
            parent: current,
            contradictions: replan.contradictionsToResolve,
            maxFragments: MAX_FRAGMENTS_TOTAL,
          });
          if (replan.cancelledFragments.length > 0 || replan.contradictionsToResolve.length > 0) {
            recordEvent({
              projectId: project.id,
              layerId: layer.id,
              entityType: 'RUN',
              entityId: loaded.runId,
              eventType: 'RESEARCH_REPLANNED',
              payload: {
                orchestrationId: loaded.id,
                fragmentKey: current.fragmentKey,
                requirementsUpdated: replan.requirementsUpdated.length,
                cancelled: replan.cancelledFragments,
                contradictions: replan.contradictionsToResolve.length,
              },
            });
          }
          continue;
        }

        // Splitting comes before repair: a fragment that is really two questions
        // would otherwise be repaired as a whole, re-researching the half that
        // already worked.
        const signal = shouldSplit(current, gate);
        if (signal && current.splitFromId === null) {
          updateFragment(current.id, {
            status: 'REJECTED',
            blockedReason: `Split into ${signal.questions.length} fragments: ${signal.reason}`,
          });
          splitFragment({
            fragment: current,
            signal,
            startIndex: currentFragments(loaded.id).length,
          });
        } else {
          planRepair(loaded, current, gate);
        }
      }
    }

    return await synthesizeAndAudit(loaded.id, project, layer, provider, options);
  } catch (error) {
    if (error instanceof ResearchCancelled) {
      // Whoever cancelled already said why. Overwriting that with the generic
      // "it was cancelled" would throw away the only useful part.
      const current = getOrchestration(loaded.id);
      updateOrchestration(loaded.id, {
        status: 'CANCELLED',
        cancelledAt: current?.cancelledAt ?? new Date().toISOString(),
        cancelReason: current?.cancelReason ?? error.message,
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateOrchestration(loaded.id, {
      status: 'FAILED',
      failedAt: new Date().toISOString(),
      failureReason: message,
    });
    recordEvent({
      projectId: loaded.projectId,
      layerId: loaded.layerId,
      entityType: 'RUN',
      entityId: loaded.runId,
      eventType: 'RESEARCH_FAILED',
      payload: { orchestrationId: loaded.id, reason: message },
    });
    throw error;
  }
}

/**
 * Stop because the allowance ran out, keeping everything.
 *
 * Running out of quota is an ordinary event, not a failure: nothing is
 * discarded, nothing is downgraded, and no fragment is accepted on weaker
 * evidence to squeeze the run in under the limit. What the user gets is a
 * sentence saying which allowance is gone, what has been done so far, and what
 * is still waiting.
 */
function pauseForQuota(
  orchestrationId: string,
  project: Project,
  layer: Layer,
  decision: QuotaDecision,
  options: RunOrchestrationOptions,
): OrchestrationOutcome {
  const orchestration = getOrchestration(orchestrationId)!;
  const fragments = currentFragments(orchestrationId);
  const settled = fragments.filter((fragment) =>
    ['ACCEPTED', 'REJECTED', 'NEEDS_HUMAN'].includes(fragment.status),
  );
  const pending = fragments.length - settled.length;

  recordQuotaPause({
    orchestrationId,
    provider: orchestration.provider,
    quotaState: decision.quota.state,
    detail: decision.detail,
    jobsCompleted: settled.length,
    jobsPending: pending,
  });

  updateOrchestration(orchestrationId, {
    status: 'PAUSED_QUOTA',
    failureReason: decision.detail,
  });
  recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_PAUSED_QUOTA',
    payload: {
      orchestrationId,
      quotaState: decision.quota.state,
      quotaScope: decision.quota.scope,
      resetsAt: decision.quota.resetsAt,
      fragmentsSettled: settled.length,
      fragmentsPending: pending,
      paidOverageOffered: decision.overageWouldHelp,
    },
  });
  options.onProgress?.({
    orchestrationId,
    phase: 'RESEARCHING',
    passKey: 'TARGETED',
    fragmentKey: null,
    index: settled.length,
    total: fragments.length,
    message: decision.detail,
  });

  return {
    orchestration: getOrchestration(orchestrationId)!,
    fragments,
    acceptedFragments: fragments.filter((fragment) => fragment.status === 'ACCEPTED').length,
    rejectedFragments: fragments.filter((fragment) =>
      fragment.status === 'REJECTED' || fragment.status === 'BLOCKED',
    ).length,
    acceptedClaims: acceptedClaims(orchestrationId).length,
    documentId: null,
    auditId: null,
    verdict: null,
  };
}

/**
 * Pick a quota-paused run back up.
 *
 * The run resumes exactly where it stopped, because nothing was thrown away
 * when it paused: the fragments that were queued are still queued and the ones
 * that were accepted are still accepted.
 */
export async function resumeAfterQuota(
  orchestrationId: string,
  options: RunOrchestrationOptions = {},
): Promise<OrchestrationOutcome> {
  const orchestration = getOrchestration(orchestrationId);
  if (!orchestration) throw new Error(`Unknown research run ${orchestrationId}`);
  if (orchestration.status !== 'PAUSED_QUOTA') {
    throw new Error(
      `This run is ${orchestration.status.toLowerCase().replace(/_/g, ' ')}, not paused for quota.`,
    );
  }

  const provider = options.provider ?? getProvider(orchestration.provider);
  const decision = quotaDecision({
    provider,
    paidOverageEnabled: getConnection(provider.name)?.paidOverageEnabled ?? false,
  });
  if (!decision.canRun) {
    // Resuming into the same wall would only churn. The pause stands, and it
    // says the same thing it said before.
    const { project, layer } = requireContext(orchestration);
    return pauseForQuota(orchestrationId, project, layer, decision, options);
  }

  const open = openQuotaPause(orchestrationId);
  if (open) resolveQuotaPause(open.id);
  updateOrchestration(orchestrationId, { status: 'RESEARCHING', failureReason: null });
  return await runOrchestration(orchestrationId, options);
}

async function synthesizeAndAudit(
  orchestrationId: string,
  project: Project,
  layer: Layer,
  provider: AIProvider,
  options: RunOrchestrationOptions,
): Promise<OrchestrationOutcome> {
  const orchestration = getOrchestration(orchestrationId)!;
  const fragments = currentFragments(orchestrationId);
  const accepted = fragments.filter((fragment) => fragment.status === 'ACCEPTED');
  const rejected = fragments.filter(
    (fragment) => fragment.status === 'REJECTED' || fragment.status === 'BLOCKED',
  );
  const claims = acceptedClaims(orchestrationId);

  if (accepted.length === 0 || claims.length === 0) {
    // Nothing survived. Writing a report anyway would be the exact failure this
    // whole pipeline exists to prevent.
    const reason =
      `No fragment cleared its evidence gate, so there is nothing to synthesize. ` +
      rejected
        .slice(0, 5)
        .map((fragment) => `${fragment.fragmentKey}: ${fragment.blockedReason ?? 'blocked'}`)
        .join(' | ');
    updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      currentPass: 'SYNTHESIS',
      failureReason: reason,
    });
    updateRun(orchestration.runId, { status: 'BLOCKED', failureReason: reason });
    recordEvent({
      projectId: project.id,
      layerId: layer.id,
      entityType: 'RUN',
      entityId: orchestration.runId,
      eventType: 'RESEARCH_BLOCKED',
      payload: { orchestrationId, fragments: fragments.length, rejected: rejected.length },
    });
    return {
      orchestration: getOrchestration(orchestrationId)!,
      fragments,
      acceptedFragments: 0,
      rejectedFragments: rejected.length,
      acceptedClaims: 0,
      documentId: null,
      auditId: null,
      verdict: null,
    };
  }

  updateOrchestration(orchestrationId, { status: 'SYNTHESIZING', currentPass: 'SYNTHESIS' });
  options.onProgress?.({
    orchestrationId,
    phase: 'SYNTHESIZING',
    passKey: 'SYNTHESIS',
    fragmentKey: null,
    index: accepted.length,
    total: fragments.length,
    message: `Writing the report from ${claims.length} accepted claim(s)`,
  });

  const unresolved = new Set<string>();
  for (const fragment of fragments) {
    const detail = fragment.verdictDetail as GateResult | null;
    for (const gap of detail?.unresolvedGaps ?? []) unresolved.add(gap);
  }

  const synthesis = await callProvider(
    {
      orchestration,
      passKey: 'SYNTHESIS',
      ordinal: 4,
      prompt: buildSynthesisPrompt({
        project,
        layer,
        title: orchestration.title,
        assignment: orchestration.assignment,
        targetVersion: orchestration.targetVersion,
        fragments: accepted.map((fragment) => ({
          fragment,
          claims: claims.filter((claim) => claim.fragmentId === fragment.id),
        })),
        rejectedFragments: rejected.map((fragment) => ({
          fragment,
          reason: fragment.blockedReason ?? 'did not clear its evidence gate',
        })),
        unresolvedGaps: [...unresolved],
      }),
      provider,
      options,
      expectedTitle: `${orchestration.title} — synthesis`,
      expectedFilename: 'synthesis.json',
    },
    parseSynthesisPass,
  );

  updateOrchestration(orchestrationId, { reportText: synthesis.value.report });

  // File it exactly as a hand-uploaded report would be filed.
  const run = getRun(orchestration.runId)!;
  const version = targetVersionForRun(run, layer.id, project.id);
  const filed = registerRunArtifact({
    run,
    layer,
    project,
    originalFilename: `${layer.name} ${version}.md`,
    contents: Buffer.from(appendLedger(synthesis.value.report, claims), 'utf8'),
    notes: `Staged research ${orchestrationId}: ${claims.length} accepted claims from ${accepted.length} fragment(s).`,
  });

  if (!filed.imported.documentId) {
    const reason = `The report could not be filed: ${filed.imported.message}`;
    updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      failureReason: reason,
    });
    return {
      orchestration: getOrchestration(orchestrationId)!,
      fragments,
      acceptedFragments: accepted.length,
      rejectedFragments: rejected.length,
      acceptedClaims: claims.length,
      documentId: null,
      auditId: null,
      verdict: null,
    };
  }

  updateOrchestration(orchestrationId, { documentId: filed.imported.documentId });

  // The audit reads extracted evidence, never raw bytes (invariant 9), and
  // importing only queues the extraction. Waiting for it here is what makes the
  // handoff real: without it the audit would judge a document Brain had not yet
  // read, and correctly refuse.
  const extraction = await enqueueExtraction(filed.imported.documentId);
  if (!isAuditable(extraction.run.status)) {
    const reason =
      `The report was filed but could not be read back for audit: ` +
      `${extraction.quality?.blockedReason ?? extraction.run.status}.`;
    updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      failureReason: reason,
      completedAt: new Date().toISOString(),
    });
    return {
      orchestration: getOrchestration(orchestrationId)!,
      fragments,
      acceptedFragments: accepted.length,
      rejectedFragments: rejected.length,
      acceptedClaims: claims.length,
      documentId: filed.imported.documentId,
      auditId: null,
      verdict: null,
    };
  }

  // Pass 6: Brain's own audit, unchanged, on the assembled packet.
  updateOrchestration(orchestrationId, { status: 'AUDITING', currentPass: 'AUDIT' });
  options.onProgress?.({
    orchestrationId,
    phase: 'AUDITING',
    passKey: 'AUDIT',
    fragmentKey: null,
    index: fragments.length,
    total: fragments.length,
    message: 'Auditing the assembled packet',
  });

  let auditId: string | null = null;
  let verdict: string | null = null;
  try {
    // Which provider audits is a real decision, not a detail. The one that did
    // the research is used when it can return structured output; when it cannot
    // — Antigravity has no audit mode — the configured default takes over, and
    // the audit record says which provider produced the verdict either way.
    const auditProvider = options.provider ?? auditCapable(provider);
    const outcome = await runDynamicAudit({
      mode: 'SINGLE_DOCUMENT',
      layerId: layer.id,
      documentId: filed.imported.documentId,
      runId: orchestration.runId,
      ...(auditProvider ? { provider: auditProvider } : {}),
      model: orchestration.model,
    });
    auditId = outcome.audit.id;
    verdict = outcome.audit.verdict;
  } catch (error) {
    const message =
      error instanceof AuditFailure
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    // The report exists and is registered; only the verdict is missing. That is
    // a state a person can act on, so it is not a failed orchestration.
    updateOrchestration(orchestrationId, {
      status: 'NEEDS_HUMAN',
      failureReason: `The report was filed but the audit could not complete: ${message}`,
      completedAt: new Date().toISOString(),
    });
    return {
      orchestration: getOrchestration(orchestrationId)!,
      fragments,
      acceptedFragments: accepted.length,
      rejectedFragments: rejected.length,
      acceptedClaims: claims.length,
      documentId: filed.imported.documentId,
      auditId: null,
      verdict: null,
    };
  }

  const needsRepair = verdict !== 'PASS' && verdict !== 'READY_FOR_SYNTHESIS' && verdict !== 'READY_TO_FREEZE';
  updateOrchestration(orchestrationId, {
    status: needsRepair ? 'AWAITING_REPAIR' : 'COMPLETE',
    auditId,
    verdict,
    completedAt: new Date().toISOString(),
    currentPass: 'AUDIT',
  });

  recordEvent({
    projectId: project.id,
    layerId: layer.id,
    entityType: 'RUN',
    entityId: orchestration.runId,
    eventType: 'RESEARCH_COMPLETED',
    payload: {
      orchestrationId,
      fragments: fragments.length,
      acceptedFragments: accepted.length,
      rejectedFragments: rejected.length,
      acceptedClaims: claims.length,
      documentId: filed.imported.documentId,
      verdict,
    },
  });

  options.onProgress?.({
    orchestrationId,
    phase: 'DONE',
    passKey: 'AUDIT',
    fragmentKey: null,
    index: fragments.length,
    total: fragments.length,
    message: `Audit verdict: ${verdict ?? 'none'}`,
  });

  return {
    orchestration: getOrchestration(orchestrationId)!,
    fragments: currentFragments(orchestrationId),
    acceptedFragments: accepted.length,
    rejectedFragments: rejected.length,
    acceptedClaims: claims.length,
    documentId: filed.imported.documentId,
    auditId,
    verdict,
  };
}

/** The provider itself when it can audit, otherwise nothing — the caller falls back. */
function auditCapable(provider: AIProvider): AIProvider | null {
  try {
    return provider.getStatus().capabilities.audit ? provider : null;
  } catch {
    return null;
  }
}

/**
 * The evidence ledger, appended to the filed report.
 *
 * The document is what gets audited, frozen and read months from now, so the
 * claims it rests on travel inside it rather than only in the database. Every
 * citation in the report resolves here, and every entry here resolves to a URL.
 */
function appendLedger(report: string, claims: ResearchClaim[]): string {
  const lines = [
    report.trim(),
    '',
    '---',
    '',
    '## Evidence ledger',
    '',
    'Every claim below passed the fragment evidence gate: it has a canonical source URL, the',
    'source was verified to support it, the exact passage is preserved, and its scope matches',
    'the fragment that produced it.',
    '',
  ];
  for (const claim of claims) {
    lines.push(
      `- **[${claim.id}]** ${claim.claim}`,
      `  - Source: ${claim.sourcePublisher ?? 'unknown publisher'} — ${claim.sourceTitle ?? 'untitled'}` +
        `${claim.sourceDate ? ` (${claim.sourceDate})` : ''}`,
      `  - URL: ${claim.sourceUrl}`,
      `  - Passage: "${(claim.evidenceExcerpt ?? '').replace(/\s+/g, ' ').slice(0, 400)}"` +
        `${claim.evidenceLocator ? ` — ${claim.evidenceLocator}` : ''}`,
      claim.retrievedAt ? `  - Retrieved: ${claim.retrievedAt}` : '',
      claim.contradictionState !== 'UNCHALLENGED'
        ? `  - Contradiction state: ${claim.contradictionState}${claim.contradictionNote ? ` — ${claim.contradictionNote}` : ''}`
        : '',
    );
  }
  return lines.filter((line) => line !== '').join('\n');
}

export { listPasses };
