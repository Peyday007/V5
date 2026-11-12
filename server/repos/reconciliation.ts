/**
 * Data access for the reasoning that decides whether research happens at all.
 *
 * Boundary contracts, requirements, the claims recovered from documents the
 * project already had, and the coverage decision for each requirement. These
 * rows are what make "we already knew this" inspectable — and correctable,
 * because a user who disagrees with a coverage status can overrule it and the
 * override is recorded beside the reasoning it replaced.
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
  BoundaryContract,
  BoundaryContractRow,
  ClaimType,
  ContradictionState,
  CoverageStatus,
  ExistingClaim,
  ExistingClaimRow,
  GapType,
  Requirement,
  RequirementCoverage,
  RequirementCoverageRow,
  RequirementKind,
  RequirementNecessity,
  RequirementRow,
  VerificationState,
} from '../domain/types.ts';
import { buildUpdate, fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';

// ---------------------------------------------------------------------------
// Boundary contracts
// ---------------------------------------------------------------------------

function mapContract(row: BoundaryContractRow): BoundaryContract {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    layerId: row.layer_id,
    primaryQuestion: row.primary_question,
    decisionSupported: row.decision_supported,
    audience: row.audience,
    includedSubjects: parseJson<string[]>(row.included_subjects, []),
    excludedSubjects: parseJson<string[]>(row.excluded_subjects, []),
    geography: row.geography,
    timeframe: row.timeframe,
    population: row.population,
    definitions: parseJson<{ term: string; definition: string }[]>(row.definitions, []),
    requiredComparisons: parseJson<string[]>(row.required_comparisons, []),
    requiredCalculations: parseJson<string[]>(row.required_calculations, []),
    expectedOutput: row.expected_output,
    requiredConfidence: row.required_confidence,
    acceptableUncertainty: row.acceptable_uncertainty,
    prohibitedAssumptions: parseJson<string[]>(row.prohibited_assumptions, []),
    sourceConstraints: parseJson<string[]>(row.source_constraints, []),
    completionStandard: row.completion_standard,
    ambiguities: parseJson<{ question: string; why: string }[]>(row.ambiguities, []),
    status: (row.status as BoundaryContract['status']) ?? 'DRAFT',
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateBoundaryContractInput {
  orchestrationId: string;
  projectId: string;
  layerId: string;
  primaryQuestion: string;
  decisionSupported?: string | null;
  audience?: string | null;
  includedSubjects?: string[];
  excludedSubjects?: string[];
  geography?: string | null;
  timeframe?: string | null;
  population?: string | null;
  definitions?: { term: string; definition: string }[];
  requiredComparisons?: string[];
  requiredCalculations?: string[];
  expectedOutput?: string | null;
  requiredConfidence?: string | null;
  acceptableUncertainty?: string | null;
  prohibitedAssumptions?: string[];
  sourceConstraints?: string[];
  completionStandard?: string | null;
  ambiguities?: { question: string; why: string }[];
}

export async function createBoundaryContract(input: CreateBoundaryContractInput): Promise<BoundaryContract> {
  const ts = nowIso();
  const id = newId('bnd');
  await getDb().run(
    `INSERT INTO boundary_contracts (id, orchestration_id, project_id, layer_id, primary_question,
       decision_supported, audience, included_subjects, excluded_subjects, geography, timeframe,
       population, definitions, required_comparisons, required_calculations, expected_output,
       required_confidence, acceptable_uncertainty, prohibited_assumptions, source_constraints,
       completion_standard, ambiguities, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.orchestrationId, input.projectId, input.layerId, input.primaryQuestion,
      input.decisionSupported ?? null, input.audience ?? null,
      toJson(input.includedSubjects ?? []), toJson(input.excludedSubjects ?? []),
      input.geography ?? null, input.timeframe ?? null, input.population ?? null,
      toJson(input.definitions ?? []), toJson(input.requiredComparisons ?? []),
      toJson(input.requiredCalculations ?? []), input.expectedOutput ?? null,
      input.requiredConfidence ?? null, input.acceptableUncertainty ?? null,
      toJson(input.prohibitedAssumptions ?? []), toJson(input.sourceConstraints ?? []),
      input.completionStandard ?? null, toJson(input.ambiguities ?? []), ts, ts],
  );
  return (await getBoundaryContract(id))!;
}

export async function getBoundaryContract(id: string): Promise<BoundaryContract | null> {
  const row = await getDb().get<BoundaryContractRow>('SELECT * FROM boundary_contracts WHERE id = ?', [id]);
  return row ? mapContract(row) : null;
}

export async function contractFor(orchestrationId: string): Promise<BoundaryContract | null> {
  const row = await getDb().get<BoundaryContractRow>(
    `SELECT * FROM boundary_contracts WHERE orchestration_id = ? AND status != 'SUPERSEDED'
      ORDER BY created_at DESC LIMIT 1`,
    [orchestrationId],
  );
  return row ? mapContract(row) : null;
}

export async function updateBoundaryContract(
  id: string,
  patch: Partial<CreateBoundaryContractInput> & { status?: BoundaryContract['status']; approvedAt?: string | null },
): Promise<BoundaryContract | null> {
  const { clause, values } = buildUpdate({
    primary_question: patch.primaryQuestion,
    decision_supported: patch.decisionSupported,
    audience: patch.audience,
    included_subjects: patch.includedSubjects ? toJson(patch.includedSubjects) : undefined,
    excluded_subjects: patch.excludedSubjects ? toJson(patch.excludedSubjects) : undefined,
    geography: patch.geography,
    timeframe: patch.timeframe,
    population: patch.population,
    definitions: patch.definitions ? toJson(patch.definitions) : undefined,
    required_comparisons: patch.requiredComparisons ? toJson(patch.requiredComparisons) : undefined,
    required_calculations: patch.requiredCalculations ? toJson(patch.requiredCalculations) : undefined,
    expected_output: patch.expectedOutput,
    required_confidence: patch.requiredConfidence,
    acceptable_uncertainty: patch.acceptableUncertainty,
    prohibited_assumptions: patch.prohibitedAssumptions ? toJson(patch.prohibitedAssumptions) : undefined,
    source_constraints: patch.sourceConstraints ? toJson(patch.sourceConstraints) : undefined,
    completion_standard: patch.completionStandard,
    ambiguities: patch.ambiguities ? toJson(patch.ambiguities) : undefined,
    status: patch.status,
    approved_at: patch.approvedAt,
  });
  if (!clause) return getBoundaryContract(id);
  await getDb().run(`UPDATE boundary_contracts SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as never[]),
    nowIso(),
    id,
  ]);
  return getBoundaryContract(id);
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    projectId: row.project_id,
    layerId: row.layer_id,
    requirementKey: row.requirement_key,
    ordinal: Number(row.ordinal),
    statement: row.statement,
    necessity: row.necessity as RequirementNecessity,
    kind: row.kind as RequirementKind,
    rationale: row.rationale,
    requiredEvidence: parseLanes(parseJson<unknown[]>(row.required_evidence, [])),
    completionCriteria: parseJson<string[]>(row.completion_criteria, []),
    dependsOn: parseDependencies(row.depends_on),
    owningLayerId: row.owning_layer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRequirementInput {
  orchestrationId: string;
  projectId: string;
  layerId: string;
  requirementKey: string;
  ordinal: number;
  statement: string;
  necessity: RequirementNecessity;
  kind: RequirementKind;
  rationale?: string | null;
  requiredEvidence?: EvidenceLane[];
  completionCriteria?: string[];
  dependsOn?: (string | FragmentDependency)[];
  owningLayerId?: string | null;
}

export async function createRequirements(inputs: CreateRequirementInput[]): Promise<Requirement[]> {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  await db.transaction(async () => {
    for (const input of inputs) {
      const id = newId('req');
      ids.push(id);
      await db.run(
        `INSERT INTO requirements (id, orchestration_id, project_id, layer_id, requirement_key,
           ordinal, statement, necessity, kind, rationale, required_evidence, completion_criteria,
           depends_on, owning_layer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.orchestrationId, input.projectId, input.layerId, input.requirementKey,
          input.ordinal, input.statement, input.necessity, input.kind, input.rationale ?? null,
          toJson(serializeLanes(input.requiredEvidence ?? [])), toJson(input.completionCriteria ?? []),
          serializeDependencies(toDependencies(input.dependsOn)), input.owningLayerId ?? null, ts, ts],
      );
    }
  });
  const loaded = await Promise.all(ids.map((id) => getRequirement(id)));
  return loaded.filter((r): r is Requirement => r !== null);
}

export async function getRequirement(id: string): Promise<Requirement | null> {
  const row = await getDb().get<RequirementRow>('SELECT * FROM requirements WHERE id = ?', [id]);
  return row ? mapRequirement(row) : null;
}

export async function listRequirements(orchestrationId: string): Promise<Requirement[]> {
  return (await getDb().all<RequirementRow>(
      'SELECT * FROM requirements WHERE orchestration_id = ? ORDER BY ordinal, rowid',
      [orchestrationId],
    ))
    .map(mapRequirement);
}

// ---------------------------------------------------------------------------
// Existing claims
// ---------------------------------------------------------------------------

function mapExistingClaim(row: ExistingClaimRow): ExistingClaim {
  return {
    id: row.id,
    projectId: row.project_id,
    documentId: row.document_id,
    extractionRunId: row.extraction_run_id,
    layerId: row.layer_id,
    claim: row.claim,
    claimType: row.claim_type as ClaimType,
    page: row.page === null ? null : Number(row.page),
    blockIndex: row.block_index === null ? null : Number(row.block_index),
    charStart: row.char_start === null ? null : Number(row.char_start),
    charEnd: row.char_end === null ? null : Number(row.char_end),
    locator: row.locator,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourcePublisher: row.source_publisher,
    sourceDate: row.source_date,
    retrievedAt: row.retrieved_at,
    supportingPassage: row.supporting_passage,
    geography: row.geography,
    timeframe: row.timeframe,
    population: row.population,
    definition: row.definition,
    extractionConfidence: Number(row.extraction_confidence),
    evidenceConfidence: Number(row.evidence_confidence),
    contradictionState: row.contradiction_state as ContradictionState,
    verificationState: row.verification_state as VerificationState,
    verificationDetail: row.verification_detail,
    priorAuditId: row.prior_audit_id,
    documentVersion: row.document_version,
    superseded: toBool(row.superseded),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export interface InsertExistingClaimInput {
  projectId: string;
  documentId: string;
  extractionRunId: string | null;
  layerId: string | null;
  claim: string;
  claimType: ClaimType;
  page?: number | null;
  blockIndex?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  locator?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  sourcePublisher?: string | null;
  sourceDate?: string | null;
  retrievedAt?: string | null;
  supportingPassage?: string | null;
  geography?: string | null;
  timeframe?: string | null;
  population?: string | null;
  definition?: string | null;
  extractionConfidence: number;
  evidenceConfidence: number;
  verificationState?: VerificationState;
  verificationDetail?: string | null;
  priorAuditId?: string | null;
  documentVersion?: string | null;
  superseded?: boolean;
  contentHash: string;
}

export async function insertExistingClaims(inputs: InsertExistingClaimInput[]): Promise<ExistingClaim[]> {
  if (inputs.length === 0) return [];
  const db = getDb();
  const ts = nowIso();
  const ids: string[] = [];
  await db.transaction(async () => {
    for (const input of inputs) {
      const id = newId('exc');
      ids.push(id);
      await db.run(
        `INSERT INTO existing_claims (id, project_id, document_id, extraction_run_id, layer_id,
           claim, claim_type, page, block_index, char_start, char_end, locator, source_url,
           source_title, source_publisher, source_date, retrieved_at, supporting_passage,
           geography, timeframe, population, definition, extraction_confidence,
           evidence_confidence, verification_state, verification_detail, prior_audit_id,
           document_version, superseded, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.projectId, input.documentId, input.extractionRunId, input.layerId, input.claim,
          input.claimType, input.page ?? null, input.blockIndex ?? null, input.charStart ?? null,
          input.charEnd ?? null, input.locator ?? null, input.sourceUrl ?? null,
          input.sourceTitle ?? null, input.sourcePublisher ?? null, input.sourceDate ?? null,
          input.retrievedAt ?? null, input.supportingPassage ?? null, input.geography ?? null,
          input.timeframe ?? null, input.population ?? null, input.definition ?? null,
          input.extractionConfidence, input.evidenceConfidence,
          input.verificationState ?? 'UNVERIFIED', input.verificationDetail ?? null,
          input.priorAuditId ?? null, input.documentVersion ?? null,
          fromBool(input.superseded ?? false), input.contentHash, ts],
      );
    }
  });
  const loaded = await Promise.all(ids.map((id) => getExistingClaim(id)));
  return loaded.filter((c): c is ExistingClaim => c !== null);
}

export async function getExistingClaim(id: string): Promise<ExistingClaim | null> {
  const row = await getDb().get<ExistingClaimRow>('SELECT * FROM existing_claims WHERE id = ?', [id]);
  return row ? mapExistingClaim(row) : null;
}

export async function listExistingClaims(projectId: string): Promise<ExistingClaim[]> {
  return (await getDb().all<ExistingClaimRow>(
      'SELECT * FROM existing_claims WHERE project_id = ? ORDER BY created_at, rowid',
      [projectId],
    ))
    .map(mapExistingClaim);
}

export async function listExistingClaimsForDocument(documentId: string): Promise<ExistingClaim[]> {
  return (await getDb().all<ExistingClaimRow>(
      'SELECT * FROM existing_claims WHERE document_id = ? ORDER BY page, block_index, rowid',
      [documentId],
    ))
    .map(mapExistingClaim);
}

/** Re-reading a document replaces its claims; the document is the source of truth. */
export async function clearExistingClaims(documentId: string): Promise<void> {
  await getDb().run('DELETE FROM existing_claims WHERE document_id = ?', [documentId]);
}

export async function updateExistingClaim(
  id: string,
  patch: {
    verificationState?: VerificationState;
    verificationDetail?: string | null;
    contradictionState?: ContradictionState;
    evidenceConfidence?: number;
    superseded?: boolean;
  },
): Promise<ExistingClaim | null> {
  const { clause, values } = buildUpdate({
    verification_state: patch.verificationState,
    verification_detail: patch.verificationDetail,
    contradiction_state: patch.contradictionState,
    evidence_confidence: patch.evidenceConfidence,
    superseded: patch.superseded === undefined ? undefined : fromBool(patch.superseded),
  });
  if (!clause) return getExistingClaim(id);
  await getDb().run(`UPDATE existing_claims SET ${clause} WHERE id = ?`, [...(values as never[]), id]);
  return getExistingClaim(id);
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function mapCoverage(row: RequirementCoverageRow): RequirementCoverage {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    requirementId: row.requirement_id,
    status: row.status as CoverageStatus,
    reasons: parseJson<string[]>(row.reasons, []),
    claimIds: parseJson<string[]>(row.claim_ids, []),
    documentIds: parseJson<string[]>(row.document_ids, []),
    confidence: Number(row.confidence),
    gapType: (row.gap_type as GapType | null) ?? null,
    gapDetail: row.gap_detail,
    needsResearch: toBool(row.needs_research),
    userOverride: row.user_override,
    overriddenAt: row.overridden_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertCoverageInput {
  orchestrationId: string;
  requirementId: string;
  status: CoverageStatus;
  reasons: string[];
  claimIds: string[];
  documentIds: string[];
  confidence: number;
  gapType?: GapType | null;
  gapDetail?: string | null;
  needsResearch: boolean;
}

/**
 * Record a coverage decision, replacing any earlier one for that requirement.
 *
 * Replaced rather than appended because coverage is a current judgement about
 * current evidence: after new research lands, the old status is not history
 * worth keeping — the claims and the reasons behind it are, and those live in
 * their own tables.
 */
export async function upsertCoverage(input: UpsertCoverageInput): Promise<RequirementCoverage> {
  const db = getDb();
  const ts = nowIso();
  const existing = await db.get<RequirementCoverageRow>(
    'SELECT * FROM requirement_coverage WHERE orchestration_id = ? AND requirement_id = ?',
    [input.orchestrationId, input.requirementId],
  );

  if (existing) {
    await db.run(
      `UPDATE requirement_coverage SET status = ?, reasons = ?, claim_ids = ?, document_ids = ?,
         confidence = ?, gap_type = ?, gap_detail = ?, needs_research = ?, updated_at = ?
       WHERE id = ?`,
      [input.status, toJson(input.reasons), toJson(input.claimIds), toJson(input.documentIds),
        input.confidence, input.gapType ?? null, input.gapDetail ?? null,
        fromBool(input.needsResearch), ts, existing.id],
    );
    return mapCoverage(
      await (await db.get<RequirementCoverageRow>('SELECT * FROM requirement_coverage WHERE id = ?', [existing.id]))!,
    );
  }

  const id = newId('cov');
  await db.run(
    `INSERT INTO requirement_coverage (id, orchestration_id, requirement_id, status, reasons,
       claim_ids, document_ids, confidence, gap_type, gap_detail, needs_research,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.orchestrationId, input.requirementId, input.status, toJson(input.reasons),
      toJson(input.claimIds), toJson(input.documentIds), input.confidence, input.gapType ?? null,
      input.gapDetail ?? null, fromBool(input.needsResearch), ts, ts],
  );
  return mapCoverage(
    await (await db.get<RequirementCoverageRow>('SELECT * FROM requirement_coverage WHERE id = ?', [id]))!,
  );
}

export async function listCoverage(orchestrationId: string): Promise<RequirementCoverage[]> {
  return (await getDb().all<RequirementCoverageRow>(
      'SELECT * FROM requirement_coverage WHERE orchestration_id = ? ORDER BY created_at, rowid',
      [orchestrationId],
    ))
    .map(mapCoverage);
}

/** A person overruling Brain's reading of the evidence. Recorded, never silent. */
export async function overrideCoverage(
  id: string,
  input: { status: CoverageStatus; note: string; needsResearch: boolean },
): Promise<RequirementCoverage | null> {
  await getDb().run(
    `UPDATE requirement_coverage SET status = ?, user_override = ?, needs_research = ?,
       overridden_at = ?, updated_at = ? WHERE id = ?`,
    [input.status, input.note, fromBool(input.needsResearch), nowIso(), nowIso(), id],
  );
  const row = await getDb().get<RequirementCoverageRow>(
    'SELECT * FROM requirement_coverage WHERE id = ?',
    [id],
  );
  return row ? mapCoverage(row) : null;
}
