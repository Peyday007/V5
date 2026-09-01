/**
 * Data access for staged research.
 *
 * Passes and claims are append-only. A retried pass is a new row; a claim that a
 * later pass contradicts is updated in place only in its contradiction state,
 * never in its text or its source — the point of a ledger is that what was
 * claimed, and on what basis, cannot be quietly revised afterwards.
 */
import { parseLanes, serializeLanes } from '../domain/evidenceLanes.ts';
import type { EvidenceLane } from '../domain/types.ts';
import { getDb } from '../db/database.ts';
import {
  parseDependencies,
  serializeDependencies,
  toDependencies,
} from '../domain/dependencies.ts';
import type {
  FragmentDependency,
  RetrievalState,
  ClaimType,
  ClaimValidationState,
  ContradictionKind,
  ContradictionState,
  ReconciliationOutcome,
  FragmentStatus,
  IntegrityVerdict,
  OrchestrationStatus,
  ResearchFragment,
  ResearchFragmentRow,
  SufficiencyVerdict,
  ResearchClaim,
  ResearchClaimRow,
  ResearchOrchestration,
  ResearchOrchestrationRow,
  ResearchPass,
  ResearchPassKey,
  ResearchPassRow,
  ResearchPassStatus,
  RepairPlan,
} from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

function mapOrchestration(row: ResearchOrchestrationRow): ResearchOrchestration {
  return {
    unresolvedGapPolicy: row.unresolved_gap_policy === 'RECORD_GAPS' ? 'RECORD_GAPS' : null,
    unresolvedGapAuthorizedBy: row.unresolved_gap_authorized_by ?? null,
    unresolvedGapAuthorizedAt: row.unresolved_gap_authorized_at ?? null,
    approvalEnvelopeId: row.approval_envelope_id ?? null,
    approvalEnvelopeAuthorizedBy: row.approval_envelope_authorized_by ?? null,
    approvalEnvelopeAuthorizedAt: row.approval_envelope_authorized_at ?? null,
    id: row.id,
    projectId: row.project_id,
    layerId: row.layer_id,
    runId: row.run_id,
    title: row.title,
    assignment: row.assignment,
    targetVersion: row.target_version,
    provider: row.provider,
    model: row.model,
    status: row.status as OrchestrationStatus,
    currentPass: (row.current_pass as ResearchPassKey | null) ?? null,
    attempt: Number(row.attempt),
    parentOrchestrationId: row.parent_orchestration_id,
    repairReason: row.repair_reason,
    reportText: row.report_text,
    documentId: row.document_id,
    auditId: row.audit_id,
    verdict: row.verdict,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    heartbeatAt: row.heartbeat_at,
    autoApprove: toBool(row.auto_approve),
    fixture: toBool(row.fixture),
    approvedAt: row.approved_at,
    approvalNote: row.approval_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFragment(row: ResearchFragmentRow): ResearchFragment {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    layerId: row.layer_id,
    fragmentIndex: Number(row.fragment_index),
    fragmentKey: row.fragment_key,
    question: row.question,
    geography: row.geography,
    timeframe: row.timeframe,
    population: row.population,
    definitions: row.definitions,
    requiredEvidence: parseLanes(parseJson<unknown[]>(row.required_evidence, [])),
    acceptableSourceTypes: parseJson<string[]>(row.acceptable_source_types, []),
    excludedSourceTypes: parseJson<string[]>(row.excluded_source_types, []),
    completionCriteria: parseJson<string[]>(row.completion_criteria, []),
    dependsOn: parseDependencies(row.depends_on),
    nextRetryAt: row.next_retry_at ?? null,
    minIndependentSources: Number(row.min_independent_sources),
    status: row.status as FragmentStatus,
    attempt: Number(row.attempt),
    parentFragmentId: row.parent_fragment_id,
    requirementIds: parseJson<string[]>(row.requirement_ids, []),
    evidenceLane: row.evidence_lane,
    whyItMatters: row.why_it_matters,
    missingEvidence: row.missing_evidence,
    whyExistingInsufficient: row.why_existing_insufficient,
    existingClaimIds: parseJson<string[]>(row.existing_claim_ids, []),
    excludedScope: row.excluded_scope,
    expectedClaimTypes: parseJson<string[]>(row.expected_claim_types, []),
    preferredSourceTypes: parseJson<string[]>(row.preferred_source_types, []),
    prohibitedEvidence: parseJson<string[]>(row.prohibited_evidence, []),
    requiredComparisons: parseJson<string[]>(row.required_comparisons, []),
    requiredCalculations: parseJson<string[]>(row.required_calculations, []),
    contradictionTargets: parseJson<string[]>(row.contradiction_targets, []),
    failureConditions: parseJson<string[]>(row.failure_conditions, []),
    uncertaintyTolerance: row.uncertainty_tolerance,
    priority: Number(row.priority ?? 5),
    estimatedEffort: row.estimated_effort,
    maxRepairs: Number(row.max_repairs ?? 2),
    splitFromId: row.split_from_id,
    repairPlan: parseJson<RepairPlan | null>(row.repair_plan ?? null, null),
    cancelledReason: row.cancelled_reason ?? null,
    repairReason: row.repair_reason,
    repairStrategy: row.repair_strategy,
    integrityVerdict: (row.integrity_verdict as IntegrityVerdict | null) ?? null,
    sufficiencyVerdict: (row.sufficiency_verdict as SufficiencyVerdict | null) ?? null,
    verdictDetail: parseJson<unknown>(row.verdict_detail, null),
    blockedReason: row.blocked_reason,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPass(row: ResearchPassRow): ResearchPass {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    fragmentId: row.fragment_id,
    passKey: row.pass_key as ResearchPassKey,
    ordinal: Number(row.ordinal),
    attempt: Number(row.attempt),
    status: row.status as ResearchPassStatus,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    promptSha256: row.prompt_sha256,
    rawResponse: row.raw_response,
    parsed: parseJson<unknown>(row.parsed, null),
    error: row.error,
    jobId: row.job_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

function mapClaim(row: ResearchClaimRow): ResearchClaim {
  return {
    // A row written before the column existed reads RETRIEVED, which is what it
    // meant: it was fetched, and the gate's verdict on it stands.
    retrievalState: (row.retrieval_state ?? 'RETRIEVED') as RetrievalState,
    id: row.id,
    orchestrationId: row.orchestration_id,
    fragmentId: row.fragment_id,
    passId: row.pass_id,
    passKey: row.pass_key as ResearchPassKey,
    claim: row.claim,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourcePublisher: row.source_publisher,
    sourceDate: row.source_date,
    evidenceExcerpt: row.evidence_excerpt,
    evidenceLocator: row.evidence_locator,
    evidenceLane: row.evidence_lane,
    retrievedAt: row.retrieved_at,
    confidence: Number(row.confidence),
    contradictionState: row.contradiction_state as ContradictionState,
    contradictionNote: row.contradiction_note,
    validationState: row.validation_state as ClaimValidationState,
    validationDetail: row.validation_detail,
    sourced: toBool(row.sourced),
    claimType: (row.claim_type as ClaimType | undefined) ?? 'SOURCED_FACT',
    sourceGroup: row.source_group ?? null,
    primarySource: toBool(row.primary_source ?? 0),
    geography: row.geography ?? null,
    timeframe: row.timeframe ?? null,
    population: row.population ?? null,
    definition: row.definition ?? null,
    requirementIds: parseJson<string[]>(row.requirement_ids, []),
    jobId: row.job_id ?? null,
    reconciliation: (row.reconciliation as ReconciliationOutcome | null) ?? null,
    reconciledClaimId: row.reconciled_claim_id ?? null,
    contradictionKind: (row.contradiction_kind as ContradictionKind | null) ?? null,
    reconciliationDetail: row.reconciliation_detail ?? null,
    derived: toBool(row.derived),
    derivedFrom: parseJson<string[]>(row.derived_from, []),
    accepted: toBool(row.accepted),
    rejectionReason: row.rejection_reason,
    scopeMatch: parseJson<unknown>(row.scope_match, null),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Orchestrations
// ---------------------------------------------------------------------------

export interface CreateOrchestrationInput {
  projectId: string;
  layerId: string;
  runId: string;
  title: string;
  assignment: string;
  targetVersion?: string | null;
  provider: string;
  model?: string | null;
  attempt?: number;
  parentOrchestrationId?: string | null;
  repairReason?: string | null;
  /** False plans the run and then waits for a person to approve it. */
  autoApprove?: boolean;
  fixture?: boolean;
}

export async function createOrchestration(input: CreateOrchestrationInput): Promise<ResearchOrchestration> {
  const ts = nowIso();
  const id = newId('orc');
  await getDb().run(
    `INSERT INTO research_orchestrations (id, project_id, layer_id, run_id, title, assignment,
       target_version, provider, model, status, attempt, parent_orchestration_id, repair_reason,
       auto_approve, fixture, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.projectId, input.layerId, input.runId, input.title, input.assignment,
      input.targetVersion ?? null, input.provider, input.model ?? null, input.attempt ?? 1,
      input.parentOrchestrationId ?? null, input.repairReason ?? null,
      fromBool(input.autoApprove ?? true), fromBool(input.fixture ?? false), ts, ts, ts],
  );
  return (await getOrchestration(id))!;
}

export async function getOrchestration(id: string): Promise<ResearchOrchestration | null> {
  const row = await getDb().get<ResearchOrchestrationRow>(
    'SELECT * FROM research_orchestrations WHERE id = ?',
    [id],
  );
  return row ? mapOrchestration(row) : null;
}

export async function listOrchestrationsByLayer(layerId: string): Promise<ResearchOrchestration[]> {
  return (await getDb().all<ResearchOrchestrationRow>(
      'SELECT * FROM research_orchestrations WHERE layer_id = ? ORDER BY created_at DESC',
      [layerId],
    ))
    .map(mapOrchestration);
}

export async function listOrchestrationsByProject(projectId: string): Promise<ResearchOrchestration[]> {
  return (await getDb().all<ResearchOrchestrationRow>(
      'SELECT * FROM research_orchestrations WHERE project_id = ? ORDER BY created_at DESC',
      [projectId],
    ))
    .map(mapOrchestration);
}

/** Everything not yet finished, oldest first — the queue's own order. */
export async function listPendingOrchestrations(): Promise<ResearchOrchestration[]> {
  return (await getDb().all<ResearchOrchestrationRow>(
      `SELECT * FROM research_orchestrations
       -- NEEDS_HUMAN is included deliberately. A decision being outstanding is
       -- not the same as the packet being over, and a packet in that state can
       -- still hold approved fragments that have never been attempted. Leaving
       -- it out made the status absorbing: boot recovery skipped it, and
       -- advancePacket returned early, so the only way back was an operator
       -- pressing a recovery control. COMPLETE, FAILED and CANCELLED are the
       -- genuinely finished ones and stay out.
       WHERE status IN ('QUEUED','PLANNING','RESEARCHING','SYNTHESIZING','AUDITING','NEEDS_HUMAN')
       ORDER BY queued_at, rowid`,
    ))
    .map(mapOrchestration);
}

/** Every attempt in one repair lineage, oldest first. */
export async function getOrchestrationLineage(id: string): Promise<ResearchOrchestration[]> {
  const start = await getOrchestration(id);
  if (!start) return [];

  let root = start;
  const climbed = new Set<string>([root.id]);
  while (root.parentOrchestrationId) {
    const parent = await getOrchestration(root.parentOrchestrationId);
    if (!parent || climbed.has(parent.id)) break;
    climbed.add(parent.id);
    root = parent;
  }

  const db = getDb();
  const lineage: ResearchOrchestration[] = [root];
  const queue: string[] = [root.id];
  const seen = new Set<string>([root.id]);
  while (queue.length > 0 && lineage.length < 200) {
    const currentId = queue.shift()!;
    const children = await db.all<ResearchOrchestrationRow>(
      'SELECT * FROM research_orchestrations WHERE parent_orchestration_id = ? ORDER BY attempt, created_at',
      [currentId],
    );
    for (const row of children) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      lineage.push(mapOrchestration(row));
      queue.push(row.id);
    }
  }
  return lineage;
}

export interface UpdateOrchestrationInput {
  status?: OrchestrationStatus;
  currentPass?: ResearchPassKey | null;
  reportText?: string | null;
  documentId?: string | null;
  auditId?: string | null;
  verdict?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  failureReason?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  heartbeatAt?: string | null;
  autoApprove?: boolean;
  approvedAt?: string | null;
  approvalNote?: string | null;
  unresolvedGapPolicy?: 'RECORD_GAPS' | null;
  unresolvedGapAuthorizedBy?: string | null;
  unresolvedGapAuthorizedAt?: string | null;
  approvalEnvelopeId?: string | null;
  approvalEnvelopeAuthorizedBy?: string | null;
  approvalEnvelopeAuthorizedAt?: string | null;
}

export async function updateOrchestration(
  id: string,
  patch: UpdateOrchestrationInput,
): Promise<ResearchOrchestration | null> {
  const { clause, values } = buildUpdate({
    status: patch.status,
    current_pass: patch.currentPass,
    report_text: patch.reportText,
    document_id: patch.documentId,
    audit_id: patch.auditId,
    verdict: patch.verdict,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
    failed_at: patch.failedAt,
    failure_reason: patch.failureReason,
    cancelled_at: patch.cancelledAt,
    cancel_reason: patch.cancelReason,
    heartbeat_at: patch.heartbeatAt,
    auto_approve: patch.autoApprove === undefined ? undefined : fromBool(patch.autoApprove),
    approved_at: patch.approvedAt,
    approval_note: patch.approvalNote,
    unresolved_gap_policy: patch.unresolvedGapPolicy,
    unresolved_gap_authorized_by: patch.unresolvedGapAuthorizedBy,
    unresolved_gap_authorized_at: patch.unresolvedGapAuthorizedAt,
    approval_envelope_id: patch.approvalEnvelopeId,
    approval_envelope_authorized_by: patch.approvalEnvelopeAuthorizedBy,
    approval_envelope_authorized_at: patch.approvalEnvelopeAuthorizedAt,
  });
  if (!clause) return getOrchestration(id);
  await getDb().run(`UPDATE research_orchestrations SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getOrchestration(id);
}

/** Cheap liveness write, so a dead process is distinguishable from a slow one. */
export async function beat(id: string): Promise<void> {
  const ts = nowIso();
  await getDb().run('UPDATE research_orchestrations SET heartbeat_at = ?, updated_at = ? WHERE id = ?', [
    ts,
    ts,
    id,
  ]);
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

export interface CreateFragmentInput {
  orchestrationId: string;
  projectId: string;
  layerId: string;
  fragmentIndex: number;
  fragmentKey: string;
  question: string;
  geography?: string | null;
  timeframe?: string | null;
  population?: string | null;
  definitions?: string | null;
  requiredEvidence: EvidenceLane[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: (string | FragmentDependency)[];
  minIndependentSources: number;
  attempt?: number;
  parentFragmentId?: string | null;
  repairReason?: string | null;
  repairStrategy?: string | null;
  status?: FragmentStatus;
  requirementIds?: string[];
  evidenceLane?: string | null;
  whyItMatters?: string | null;
  missingEvidence?: string | null;
  whyExistingInsufficient?: string | null;
  existingClaimIds?: string[];
  excludedScope?: string | null;
  expectedClaimTypes?: string[];
  preferredSourceTypes?: string[];
  prohibitedEvidence?: string[];
  requiredComparisons?: string[];
  requiredCalculations?: string[];
  contradictionTargets?: string[];
  failureConditions?: string[];
  uncertaintyTolerance?: string | null;
  priority?: number;
  estimatedEffort?: string | null;
  maxRepairs?: number;
  splitFromId?: string | null;
  repairPlan?: RepairPlan | null;
}

export async function createFragments(inputs: CreateFragmentInput[]): Promise<ResearchFragment[]> {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  await db.transaction(async () => {
    for (const input of inputs) {
      const id = newId('frg');
      ids.push(id);
      await db.run(
        `INSERT INTO research_fragments (id, orchestration_id, project_id, layer_id,
           fragment_index, fragment_key, question, geography, timeframe, population, definitions,
           required_evidence, acceptable_source_types, excluded_source_types, completion_criteria,
           depends_on, min_independent_sources, status, attempt, parent_fragment_id,
           repair_reason, repair_strategy, requirement_ids, evidence_lane, why_it_matters,
           missing_evidence, why_existing_insufficient, existing_claim_ids, excluded_scope,
           expected_claim_types, preferred_source_types, prohibited_evidence, required_comparisons,
           required_calculations, contradiction_targets, failure_conditions, uncertainty_tolerance,
           priority, estimated_effort, max_repairs, split_from_id, repair_plan,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.orchestrationId, input.projectId, input.layerId, input.fragmentIndex,
          input.fragmentKey, input.question, input.geography ?? null, input.timeframe ?? null,
          input.population ?? null, input.definitions ?? null, toJson(serializeLanes(input.requiredEvidence)),
          toJson(input.acceptableSourceTypes), toJson(input.excludedSourceTypes),
          toJson(input.completionCriteria), serializeDependencies(toDependencies(input.dependsOn)), input.minIndependentSources,
          input.status ?? 'PLANNED', input.attempt ?? 1, input.parentFragmentId ?? null,
          input.repairReason ?? null, input.repairStrategy ?? null,
          toJson(input.requirementIds ?? []), input.evidenceLane ?? null,
          input.whyItMatters ?? null, input.missingEvidence ?? null,
          input.whyExistingInsufficient ?? null, toJson(input.existingClaimIds ?? []),
          input.excludedScope ?? null, toJson(input.expectedClaimTypes ?? []),
          toJson(input.preferredSourceTypes ?? []), toJson(input.prohibitedEvidence ?? []),
          toJson(input.requiredComparisons ?? []), toJson(input.requiredCalculations ?? []),
          toJson(input.contradictionTargets ?? []), toJson(input.failureConditions ?? []),
          input.uncertaintyTolerance ?? null, input.priority ?? 5, input.estimatedEffort ?? null,
          input.maxRepairs ?? 2, input.splitFromId ?? null,
          input.repairPlan ? toJson(input.repairPlan) : null, ts, ts],
      );
    }
  });
  const loaded = await Promise.all(ids.map((id) => getFragment(id)));
  return loaded.filter((f): f is ResearchFragment => f !== null);
}

export async function getFragment(id: string): Promise<ResearchFragment | null> {
  const row = await getDb().get<ResearchFragmentRow>('SELECT * FROM research_fragments WHERE id = ?', [id]);
  return row ? mapFragment(row) : null;
}

export async function listFragments(orchestrationId: string): Promise<ResearchFragment[]> {
  return (await getDb().all<ResearchFragmentRow>(
      'SELECT * FROM research_fragments WHERE orchestration_id = ? ORDER BY fragment_index, attempt, rowid',
      [orchestrationId],
    ))
    .map(mapFragment);
}

/**
 * The live fragment for each key: the newest attempt, which is the one whose
 * verdict counts. Earlier attempts stay in the table as failure history.
 */
export async function currentFragments(orchestrationId: string): Promise<ResearchFragment[]> {
  const byKey = new Map<string, ResearchFragment>();
  for (const fragment of await listFragments(orchestrationId)) {
    const existing = byKey.get(fragment.fragmentKey);
    if (!existing || fragment.attempt >= existing.attempt) byKey.set(fragment.fragmentKey, fragment);
  }
  return [...byKey.values()].sort((a, b) => a.fragmentIndex - b.fragmentIndex);
}

export interface UpdateFragmentInput {
  status?: FragmentStatus;
  integrityVerdict?: IntegrityVerdict | null;
  sufficiencyVerdict?: SufficiencyVerdict | null;
  verdictDetail?: unknown;
  blockedReason?: string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  acceptedAt?: string | null;
  cancelledReason?: string | null;
  /**
   * When a deferred repair is due back.
   *
   * The packet runner's empty-queue invariant accepts `AWAITING_REPAIR` on one
   * of two proofs: claimable repair work, or this — a durable record of when
   * the fragment returns. No production path sets it today, because every
   * repair the runner plans is minted immediately, so in practice an
   * `AWAITING_REPAIR` packet with an empty queue always becomes `NEEDS_HUMAN`.
   * It is writable so the second half of that contract is expressible and
   * provable rather than an unreachable branch that merely looks like a rule.
   */
  nextRetryAt?: string | null;
  /**
   * The repair ceiling, raised — never the attempt counter, which is history.
   *
   * Writable so `surfaceRecovery.ts` can authorise a further attempt at a
   * fragment whose budget was spent on an execution-surface failure rather than
   * on the research. §5: the failed attempts stay exactly where they are and the
   * new one is numbered after them.
   */
  maxRepairs?: number;
}

export async function updateFragment(id: string, patch: UpdateFragmentInput): Promise<ResearchFragment | null> {
  const { clause, values } = buildUpdate({
    status: patch.status,
    integrity_verdict: patch.integrityVerdict,
    sufficiency_verdict: patch.sufficiencyVerdict,
    verdict_detail: patch.verdictDetail === undefined ? undefined : toJson(patch.verdictDetail),
    blocked_reason: patch.blockedReason,
    queued_at: patch.queuedAt,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
    accepted_at: patch.acceptedAt,
    cancelled_reason: patch.cancelledReason,
    next_retry_at: patch.nextRetryAt,
    max_repairs: patch.maxRepairs,
  });
  if (!clause) return getFragment(id);
  await getDb().run(`UPDATE research_fragments SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getFragment(id);
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export interface StartPassInput {
  orchestrationId: string;
  fragmentId?: string | null;
  passKey: ResearchPassKey;
  ordinal: number;
  attempt?: number;
  provider: string;
  model?: string | null;
  prompt: string;
  promptSha256: string;
}

/** Written before the provider is called: an unanswered pass is still a fact. */
export async function startPass(input: StartPassInput): Promise<ResearchPass> {
  const id = newId('rps');
  await getDb().run(
    `INSERT INTO research_passes (id, orchestration_id, fragment_id, pass_key, ordinal, attempt,
       status, provider, model, prompt, prompt_sha256, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)`,
    [id, input.orchestrationId, input.fragmentId ?? null, input.passKey, input.ordinal,
      input.attempt ?? 1, input.provider, input.model ?? null, input.prompt, input.promptSha256,
      nowIso()],
  );
  return (await getPass(id))!;
}

export interface FinishPassInput {
  status: ResearchPassStatus;
  rawResponse?: string | null;
  parsed?: unknown;
  error?: string | null;
  jobId?: string | null;
  durationMs?: number | null;
}

export async function finishPass(id: string, input: FinishPassInput): Promise<ResearchPass | null> {
  await getDb().run(
    `UPDATE research_passes
        SET status = ?, raw_response = ?, parsed = ?, error = ?, job_id = ?,
            completed_at = ?, duration_ms = ?
      WHERE id = ?`,
    [input.status, input.rawResponse ?? null,
      input.parsed === undefined ? null : toJson(input.parsed), input.error ?? null,
      input.jobId ?? null, nowIso(), input.durationMs ?? null, id],
  );
  return getPass(id);
}

export async function getPass(id: string): Promise<ResearchPass | null> {
  const row = await getDb().get<ResearchPassRow>('SELECT * FROM research_passes WHERE id = ?', [id]);
  return row ? mapPass(row) : null;
}

export async function listPasses(orchestrationId: string): Promise<ResearchPass[]> {
  return (await getDb().all<ResearchPassRow>(
      'SELECT * FROM research_passes WHERE orchestration_id = ? ORDER BY ordinal, attempt, rowid',
      [orchestrationId],
    ))
    .map(mapPass);
}

/**
 * The successful result of one pass, if it has one.
 *
 * This is what makes resumption possible: a pass that already completed is never
 * asked again, on a resume or a repair.
 */
export async function completedPass(
  orchestrationId: string,
  passKey: ResearchPassKey,
  fragmentId: string | null = null,
): Promise<ResearchPass | null> {
  const row = await getDb().get<ResearchPassRow>(
    `SELECT * FROM research_passes
      WHERE orchestration_id = ? AND pass_key = ? AND status = 'COMPLETE'
        -- Null-safe equality: a pass with no fragment is matched by passing
        -- null, where a plain equality would silently never match it. Spelled
        -- the standard way rather than SQLite's IS, which Postgres rejects.
        AND fragment_id IS NOT DISTINCT FROM ?
      ORDER BY attempt DESC, rowid DESC LIMIT 1`,
    [orchestrationId, passKey, fragmentId],
  );
  return row ? mapPass(row) : null;
}

export async function listPassesForFragment(fragmentId: string): Promise<ResearchPass[]> {
  return (await getDb().all<ResearchPassRow>(
      'SELECT * FROM research_passes WHERE fragment_id = ? ORDER BY ordinal, attempt, rowid',
      [fragmentId],
    ))
    .map(mapPass);
}

/** Mark whatever was left running by a dead process, so nothing reads as in flight. */
export async function abandonRunningPasses(orchestrationId: string, error: string): Promise<number> {
  const running = await getDb().all<{ id: string }>(
    "SELECT id FROM research_passes WHERE orchestration_id = ? AND status = 'RUNNING'",
    [orchestrationId],
  );
  if (running.length === 0) return 0;
  await getDb().run(
    `UPDATE research_passes SET status = 'FAILED', error = ?, completed_at = ?
      WHERE orchestration_id = ? AND status = 'RUNNING'`,
    [error, nowIso(), orchestrationId],
  );
  return running.length;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface InsertClaimInput {
  /** Whether the worker could actually read the source. Defaults to RETRIEVED. */
  retrievalState?: RetrievalState;
  orchestrationId: string;
  fragmentId: string | null;
  passId: string | null;
  passKey: ResearchPassKey;
  claim: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  evidenceExcerpt: string | null;
  evidenceLocator: string | null;
  evidenceLane: string | null;
  retrievedAt: string | null;
  confidence: number;
  contradictionState?: ContradictionState;
  contradictionNote?: string | null;
  validationState: ClaimValidationState;
  validationDetail: string | null;
  sourced: boolean;
  derived?: boolean;
  derivedFrom?: string[];
  accepted?: boolean;
  rejectionReason?: string | null;
  scopeMatch?: unknown;
  claimType?: ClaimType;
  sourceGroup?: string | null;
  primarySource?: boolean;
  geography?: string | null;
  timeframe?: string | null;
  population?: string | null;
  definition?: string | null;
  requirementIds?: string[];
  jobId?: string | null;
  contentHash: string;
}

export async function insertClaims(inputs: InsertClaimInput[]): Promise<ResearchClaim[]> {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  await db.transaction(async () => {
    for (const input of inputs) {
      const id = newId('clm');
      ids.push(id);
      await db.run(
        `INSERT INTO research_claims (id, orchestration_id, fragment_id, pass_id, pass_key, claim,
           source_url, source_title, source_publisher, source_date, evidence_excerpt,
           evidence_locator, evidence_lane, retrieved_at, confidence, contradiction_state,
           contradiction_note, validation_state, validation_detail, sourced, derived, derived_from,
           accepted, rejection_reason, scope_match, claim_type, source_group, primary_source,
           geography, timeframe, population, definition, requirement_ids, job_id,
           content_hash, retrieval_state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.orchestrationId, input.fragmentId, input.passId, input.passKey, input.claim,
          input.sourceUrl, input.sourceTitle, input.sourcePublisher, input.sourceDate,
          input.evidenceExcerpt, input.evidenceLocator, input.evidenceLane, input.retrievedAt,
          input.confidence,
          input.contradictionState ?? 'UNCHALLENGED', input.contradictionNote ?? null,
          input.validationState, input.validationDetail, fromBool(input.sourced),
          fromBool(input.derived ?? false), toJson(input.derivedFrom ?? []),
          fromBool(input.accepted ?? false), input.rejectionReason ?? null,
          input.scopeMatch === undefined ? null : toJson(input.scopeMatch),
          input.claimType ?? 'SOURCED_FACT', input.sourceGroup ?? null,
          fromBool(input.primarySource ?? false), input.geography ?? null, input.timeframe ?? null,
          input.population ?? null, input.definition ?? null, toJson(input.requirementIds ?? []),
          input.jobId ?? null, input.contentHash, input.retrievalState ?? 'RETRIEVED', ts],
      );
    }
  });
  const loaded = await Promise.all(ids.map((id) => getClaim(id)));
  return loaded.filter((claim): claim is ResearchClaim => claim !== null);
}

export async function getClaim(id: string): Promise<ResearchClaim | null> {
  const row = await getDb().get<ResearchClaimRow>('SELECT * FROM research_claims WHERE id = ?', [id]);
  return row ? mapClaim(row) : null;
}

export async function listClaimsForFragment(fragmentId: string): Promise<ResearchClaim[]> {
  return (await getDb().all<ResearchClaimRow>(
      'SELECT * FROM research_claims WHERE fragment_id = ? ORDER BY created_at, rowid',
      [fragmentId],
    ))
    .map(mapClaim);
}

/**
 * The claims a synthesis is allowed to see.
 *
 * Accepted claims from accepted fragments, and nothing else. A rejected claim
 * cannot re-enter through a later pass, which is the whole point of deciding
 * acceptance at the fragment gate rather than at synthesis time.
 */
export async function acceptedClaims(orchestrationId: string): Promise<ResearchClaim[]> {
  return (await getDb().all<ResearchClaimRow>(
      `SELECT c.* FROM research_claims c
         JOIN research_fragments f ON f.id = c.fragment_id
        WHERE c.orchestration_id = ? AND c.accepted = 1 AND f.status = 'ACCEPTED'
        ORDER BY f.fragment_index, c.created_at, c.rowid`,
      [orchestrationId],
    ))
    .map(mapClaim);
}

/**
 * The claims a report may cite, and why that is a wider set than `acceptedClaims`.
 *
 * `acceptedClaims` answers "which claims belong to fragments that met their
 * bar", and three callers on the in-process path depend on exactly that. This
 * answers a different question: **which gated evidence does this packet
 * actually hold.**
 *
 * The difference cost the first live packet most of its research. Three
 * fragments recorded `integrity PASS` — their surviving claims had a canonical
 * URL, a verified supporting passage and matching scope — and fell short only
 * on coverage, which is a statement about the *question* being incompletely
 * answered, not about the claims being unsound. Because the report could only
 * cite claims from ACCEPTED fragments, every one of those verified statutory
 * facts was discarded, and a five-state question was answered for one state.
 *
 * So a BLOCKED fragment's accepted claims are citable. What does **not** change
 * is coverage: `assessPacket` still counts a requirement as answered only when
 * an ACCEPTED fragment carries it, so contributing evidence never becomes a
 * settled requirement. The ledger says which is which, per claim.
 *
 * REJECTED and CANCELLED stay out. A rejected fragment's findings were refused,
 * and a cancelled one was never researched.
 */
export async function citableClaims(orchestrationId: string): Promise<ResearchClaim[]> {
  return (await getDb().all<ResearchClaimRow>(
      `SELECT c.* FROM research_claims c
         JOIN research_fragments f ON f.id = c.fragment_id
        WHERE c.orchestration_id = ? AND c.accepted = 1
          AND f.status IN ('ACCEPTED', 'BLOCKED')
        ORDER BY f.fragment_index, c.created_at, c.rowid`,
      [orchestrationId],
    ))
    .map(mapClaim);
}

/**
 * Which fragment each citable claim came from, and whether that fragment met
 * its bar — so the ledger can say so beside the claim rather than leaving a
 * reader to assume every cited claim rests on a settled question.
 */
export async function citableClaimCoverage(
  orchestrationId: string,
): Promise<Map<string, { fragmentKey: string; status: string; reason: string | null }>> {
  const rows = await getDb().all<{
    id: string;
    fragment_key: string;
    status: string;
    blocked_reason: string | null;
  }>(
    `SELECT c.id, f.fragment_key, f.status, f.blocked_reason
       FROM research_claims c
       JOIN research_fragments f ON f.id = c.fragment_id
      WHERE c.orchestration_id = ? AND c.accepted = 1
        AND f.status IN ('ACCEPTED', 'BLOCKED')`,
    [orchestrationId],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { fragmentKey: row.fragment_key, status: row.status, reason: row.blocked_reason },
    ]),
  );
}

/**
 * Resolve a claim's derivation references to real claim ids.
 *
 * The worker names its inputs however it likes — an index, a restatement — and
 * those labels mean nothing to the gate. This is the one place they are turned
 * into ids, immediately after the claims are stored and before anything is
 * judged.
 */
export async function updateClaimDerivedFrom(id: string, ids: string[]): Promise<ResearchClaim | null> {
  await getDb().run('UPDATE research_claims SET derived_from = ? WHERE id = ?', [toJson(ids), id]);
  return getClaim(id);
}

/** The gate's decision on one claim. Written once, when the fragment is judged. */
export async function decideClaim(
  id: string,
  input: { accepted: boolean; rejectionReason?: string | null; scopeMatch?: unknown },
): Promise<ResearchClaim | null> {
  await getDb().run(
    'UPDATE research_claims SET accepted = ?, rejection_reason = ?, scope_match = ? WHERE id = ?',
    [fromBool(input.accepted), input.rejectionReason ?? null,
      input.scopeMatch === undefined ? null : toJson(input.scopeMatch), id],
  );
  return getClaim(id);
}

export async function listClaims(orchestrationId: string): Promise<ResearchClaim[]> {
  return (await getDb().all<ResearchClaimRow>(
      'SELECT * FROM research_claims WHERE orchestration_id = ? ORDER BY created_at, rowid',
      [orchestrationId],
    ))
    .map(mapClaim);
}

/**
 * Record what a finding did to the evidence the project already had.
 *
 * Only the classification is written. Neither claim is edited and neither is
 * deleted — new evidence never silently overwrites old evidence, so what
 * changes is what the project says about the two of them together.
 */
export async function recordClaimReconciliation(
  id: string,
  input: {
    outcome: ReconciliationOutcome;
    againstClaimId: string | null;
    contradictionKind?: ContradictionKind | null;
    detail: string;
  },
): Promise<ResearchClaim | null> {
  await getDb().run(
    `UPDATE research_claims SET reconciliation = ?, reconciled_claim_id = ?,
       contradiction_kind = ?, reconciliation_detail = ? WHERE id = ?`,
    [input.outcome, input.againstClaimId, input.contradictionKind ?? null, input.detail, id],
  );
  return getClaim(id);
}

/**
 * Record that a later pass challenged a claim.
 *
 * Only the contradiction state moves. The claim and its source stay exactly as
 * first recorded — a ledger that lets an entry be rewritten proves nothing.
 */
export async function markContradiction(
  id: string,
  state: ContradictionState,
  note: string | null,
): Promise<ResearchClaim | null> {
  await getDb().run(
    'UPDATE research_claims SET contradiction_state = ?, contradiction_note = ? WHERE id = ?',
    [state, note, id],
  );
  return getClaim(id);
}
