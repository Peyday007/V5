/**
 * Domain contract for Brain.
 *
 * Row types mirror the SQLite schema exactly (snake_case, 0/1 booleans, TEXT
 * JSON). View types are the shapes the API and UI speak (camelCase, real
 * booleans, parsed JSON). Repositories are the only place the two meet.
 */

// ---------------------------------------------------------------------------
// Enums (kept as const objects + union types so they survive JSON round-trips)
// ---------------------------------------------------------------------------

export const LAYER_STATUSES = [
  'NOT_STARTED',
  'RESEARCHING',
  'INCOMPLETE',
  'BLOCKED',
  'AUDIT_READY',
  'AUDITING',
  'MORE_RESEARCH_REQUIRED',
  'SYNTHESIS_READY',
  'SYNTHESIS_RUNNING',
  'FROZEN',
  'REOPENED',
  'PARKED',
] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export const DOCUMENT_TYPES = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'CANONICAL',
  'REFERENCE',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = [
  'EXPECTED',
  'MISSING',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'SUPERSEDED',
  'FROZEN',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const RUN_TYPES = [
  'FOUNDATION',
  'EXPANSION',
  'PATCH',
  'AUDIT',
  'SYNTHESIS',
  'REDO',
  'CROSS_LAYER_AUDIT',
] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = [
  'PLANNED',
  'READY',
  'BLOCKED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'AUDIT_REQUIRED',
  'REDO_REQUIRED',
  'APPROVED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const AUDIT_VERDICTS = [
  'PASS',
  'KEEP',
  'PATCH',
  'REDO',
  'MISSING_DEPENDENCY',
  'MORE_RESEARCH',
  'READY_FOR_SYNTHESIS',
  'READY_TO_FREEZE',
  'BLOCKED',
] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export const AUDIT_FINDING_TYPES = [
  'FAILURE',
  'MISSING_DOCUMENT',
  'REQUIRED_RESEARCH_RUN',
  'REQUIRED_PATCH',
  'NEXT_ACTION',
  /** A real issue this layer does not own; recorded instead of researched here. */
  'OTHER_LAYER_HANDOFF',
  /** An attack the adversarial pass raised, kept whether or not it was upheld. */
  'ADVERSARIAL_FINDING',
] as const;
export type AuditFindingType = (typeof AUDIT_FINDING_TYPES)[number];

/**
 * Every issue an audit raises is classified, because "more could be researched"
 * and "more research is required" are different answers and only the second may
 * hold a layer open.
 */
export const GAP_CLASSIFICATIONS = [
  /** Missing concept that would materially weaken the layer. May justify research. */
  'FOUNDATIONAL_GAP',
  /** Architecture is sound but one bounded unknown needs a focused run first. */
  'TARGETED_RESEARCH_GAP',
  /** Evidence already suffices; correct it in synthesis, no new research. */
  'PATCH',
  /** Real, but another layer owns it. Record the handoff; do not research here. */
  'OTHER_LAYER',
  /** Matters when coding, not for the conceptual foundation. */
  'IMPLEMENTATION_DETAIL',
  /** Needs real-world data or calibration later; never holds research open. */
  'EMPIRICAL_TUNING',
  /** Global architecture is complete; specific domains get plug-ins later. */
  'DOMAIN_PLUGIN',
  /** Would improve quality but is not required for correctness. */
  'OPTIONAL_IMPROVEMENT',
  /** The criticism does not materially require action. */
  'NO_GAP',
] as const;
export type GapClassification = (typeof GAP_CLASSIFICATIONS)[number];

/** Classifications that may legitimately keep a layer open for more research. */
export const RESEARCH_JUSTIFYING_GAPS: readonly GapClassification[] = [
  'FOUNDATIONAL_GAP',
  'TARGETED_RESEARCH_GAP',
];

export const AUDIT_MODES = ['SINGLE_DOCUMENT', 'LAYER_PACKET'] as const;
export type AuditMode = (typeof AUDIT_MODES)[number];

/** One model call in the pipeline. Separation of roles is the point. */
export const AUDIT_PASS_KEYS = ['EXTRACTION', 'PRIMARY', 'ADVERSARIAL', 'JUDGE'] as const;
export type AuditPassKey = (typeof AUDIT_PASS_KEYS)[number];

/** How the requirement pass answers "did this do its assigned job?". */
export const ASSIGNMENT_VERDICTS = ['YES', 'PARTIAL', 'NO'] as const;
export type AssignmentVerdict = (typeof ASSIGNMENT_VERDICTS)[number];

/** How a dependency-pass observation relates two artifacts. */
export const CONSISTENCY_RELATIONS = [
  'CONTRADICTION',
  'REFINEMENT',
  'SUPERSESSION',
  'PARALLEL_DETAIL',
  'FALSE_CONFLICT',
] as const;
export type ConsistencyRelation = (typeof CONSISTENCY_RELATIONS)[number];

export const DEPENDENCY_TYPES = [
  'SOURCE_PACKET',
  'AUDIT_INPUT',
  'CROSS_LAYER',
  'PARENT',
  'REFERENCE',
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM', 'TOOL'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const EVENT_TYPES = [
  'PROJECT_CREATED',
  'DOCUMENT_CREATED',
  'DOCUMENT_IMPORTED',
  'DOCUMENT_COMPLETED',
  'DOCUMENT_SUPERSEDED',
  'DOCUMENT_DELETED',
  'DOCUMENT_FILE_MISSING',
  'DOCUMENT_FILE_RESTORED',
  'DOCUMENT_EXTRACTED',
  'DOCUMENT_EXTRACTION_FAILED',
  'DOCUMENT_REPROCESSED',
  'DOCUMENT_INDEXED',
  'RUN_CREATED',
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_PROMPT_COMPILED',
  'RESEARCH_QUEUED',
  'RESEARCH_PLANNED',
  'RESEARCH_FRAGMENT_ACCEPTED',
  'RESEARCH_FRAGMENT_REJECTED',
  'RESEARCH_BLOCKED',
  'RESEARCH_PAUSED_QUOTA',
  'RESEARCH_REPLANNED',
  'RESEARCH_PLAN_REVIEWED',
  'RESEARCH_AWAITING_APPROVAL',
  'RESEARCH_COVERAGE_GAP',
  'RESEARCH_CANCELLED',
  'RESEARCH_FAILED',
  'RESEARCH_COMPLETED',
  'ARCHIVE_IMPORT_STARTED',
  'ARCHIVE_IMPORT_COMPLETED',
  'AUDIT_COMPLETED',
  'LAYER_STATUS_CHANGED',
  'LAYER_EXPECTATIONS_CHANGED',
  'SYNTHESIS_READY',
  'SYNTHESIS_CREATED',
  'LAYER_FROZEN',
  'LAYER_REOPENED',
  'DEPENDENCY_MISSING',
  'DEPENDENCY_RESOLVED',
  'DEPENDENCY_OVERRIDDEN',
  'USER_CORRECTION',
  'AUTO_REDO_CREATED',
  'RECONCILE_COMPLETED',
  'CHAT_ACTION',
  // Who was let into this project, and who was removed. The authoritative
  // identity record is `identity_events`; these two exist so that a project's
  // own history answers "who could see this, and since when" without anybody
  // having to know there is a second log.
  'ACCESS_GRANTED',
  'ACCESS_REVOKED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type StatusSource = 'DERIVED' | 'MANUAL';

// ---------------------------------------------------------------------------
// Document understanding
// ---------------------------------------------------------------------------

/** What the bytes actually are, decided by magic number rather than extension. */
export const DOCUMENT_FORMATS = [
  'PDF',
  'DOCX',
  'TEXT',
  'MARKDOWN',
  'PASTED',
  'UNSUPPORTED',
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const EXTRACTION_STATUSES = [
  'QUEUED',
  'EXTRACTING',
  'OCR',
  'INDEXING',
  'READY',
  'READY_WITH_WARNINGS',
  'BLOCKED',
  'FAILED',
  /** A run that was interrupted mid-flight; recoverable, never mistaken for ready. */
  'INTERRUPTED',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** Statuses a document may be audited from. Everything else is not evidence. */
export const AUDITABLE_EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  'READY',
  'READY_WITH_WARNINGS',
];

export const EXTRACTION_METHODS = ['NATIVE', 'OCR', 'DOCX', 'TEXT', 'PASTED'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const BLOCK_TYPES = [
  'HEADING',
  'PARAGRAPH',
  'LIST_ITEM',
  'TABLE',
  'CAPTION',
  'FOOTNOTE',
  'CODE',
  'PAGE_HEADER',
  'PAGE_FOOTER',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const DOCUMENT_FINDING_TYPES = [
  'CLAIM',
  'DEFINITION',
  'COMPONENT',
  'ACTOR',
  'RELATIONSHIP',
  'ASSUMPTION',
  'EXCLUSION',
  'REQUIREMENT_ANSWERED',
  'OPEN_QUESTION',
  'CONTRADICTION',
] as const;
export type DocumentFindingType = (typeof DOCUMENT_FINDING_TYPES)[number];

export const DOCUMENT_ORIGINS = ['UPLOAD', 'FILESYSTEM', 'PASTED', 'RUN_RESULT'] as const;
export type DocumentOrigin = (typeof DOCUMENT_ORIGINS)[number];

/**
 * What a document is to the project.
 *
 * Almost everything is a LAYER document: one report, about one layer. A master
 * transcript is not — it spans layers, assignments, decisions and artifacts, and
 * filing it under one layer would put most of its content under the wrong
 * heading.
 */
export const DOCUMENT_SCOPES = ['LAYER', 'PROJECT_MASTER_TRANSCRIPT', 'PROJECT_SOURCE'] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

export const IMPORT_JOB_STATUSES = [
  'DISCOVERING',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'CANCELLED',
  'COMPLETE',
  'FAILED',
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Where one discovered file got to. Every file ends in exactly one of these. */
export const IMPORT_FILE_STATUSES = [
  'DISCOVERED',
  'QUEUED',
  'EXTRACTING',
  'OCR',
  'REGISTERED',
  'DUPLICATE',
  'UNSUPPORTED',
  'UNREADABLE',
  'FAILED',
  'NEEDS_REVIEW',
  'SKIPPED',
] as const;
export type ImportFileStatus = (typeof IMPORT_FILE_STATUSES)[number];

/** How a document's layer was decided. A filename is a hint; content is understanding. */
export const CLASSIFICATION_SOURCES = ['FILENAME', 'FOLDER', 'CONTENT', 'MANUAL'] as const;
export type ClassificationSource = (typeof CLASSIFICATION_SOURCES)[number];

export const SEGMENT_TYPES = [
  'CONVERSATION',
  'RESEARCH_ASSIGNMENT',
  'RETURNED_RESEARCH',
  'AUDIT',
  'DECISION',
  'REVISION',
  'SUPERSEDED',
  'OPEN_GAP',
  'ATTACHMENT_REF',
  'OTHER',
] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

export const LINK_TYPES = ['REFERENCE', 'RESEARCH_INPUT', 'COMPLETED_ARTIFACT'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = ['PROPOSED', 'ACCEPTED', 'EXCLUDED'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

// ---------------------------------------------------------------------------
// Staged research
// ---------------------------------------------------------------------------

/**
 * The six passes of one research assignment.
 *
 * They are separate because they ask different things and fail differently. A
 * plan that is wrong is cheap to correct; a synthesis built on an unchallenged
 * broad scan is not. AUDIT is Brain's own three-role engine, not another
 * provider call in disguise.
 */
export const RESEARCH_PASS_KEYS = [
  'PLAN',
  'BROAD_SCAN',
  'TARGETED',
  'ADVERSARIAL',
  'VERIFICATION',
  'SYNTHESIS',
  'AUDIT',
] as const;
export type ResearchPassKey = (typeof RESEARCH_PASS_KEYS)[number];

export const RESEARCH_PASS_STATUSES = ['RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED'] as const;
export type ResearchPassStatus = (typeof RESEARCH_PASS_STATUSES)[number];

export const ORCHESTRATION_STATUSES = [
  'QUEUED',
  'PLANNING',
  'RESEARCHING',
  'SYNTHESIZING',
  'AUDITING',
  'AWAITING_REPAIR',
  // Planned, and waiting for a person to say the plan is right before any of
  // the user's allowance is spent on it.
  'AWAITING_APPROVAL',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'NEEDS_HUMAN',
  // Out of allowance, not out of work: everything completed is kept and
  // everything queued stays queued until the quota refreshes.
  'PAUSED_QUOTA',
] as const;
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

/**
 * Where one fragment's own job has got to.
 *
 * ACCEPTED means it passed its evidence gate and its claims may be synthesized.
 * BLOCKED is recoverable — a repair, a narrower question or a different search
 * strategy may still land it. REJECTED is the end of that fragment's line, and
 * its claims never enter a synthesis.
 */
export const FRAGMENT_STATUSES = [
  'PLANNED',
  'QUEUED',
  'RUNNING',
  'VALIDATING',
  'ACCEPTED',
  'BLOCKED',
  'REJECTED',
  'CANCELLED',
  'NEEDS_HUMAN',
] as const;
export type FragmentStatus = (typeof FRAGMENT_STATUSES)[number];

/** What a claim is, which decides what would count as evidence for it. */
export const CLAIM_TYPES = [
  'SOURCED_FACT',
  'SELF_REPORT',
  'UNSUPPORTED_ASSERTION',
  'QUOTATION',
  'INFERENCE',
  'CALCULATION',
  'FORECAST',
  'NEGATIVE_EXISTENCE',
  'RECOMMENDATION',
  'DECISION',
  'INSTRUCTION',
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** What a requirement is for; not all of them are research. */
export const REQUIREMENT_KINDS = [
  'RESEARCH',
  'DEFINITION',
  'COMPARISON',
  'CALCULATION',
  'OTHER_LAYER',
  'IMPLEMENTATION',
  'EMPIRICAL_VALIDATION',
  'TUNING',
  'OPTIONAL_ENRICHMENT',
  'IRRELEVANT',
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_NECESSITIES = ['MANDATORY', 'SUPPORTING', 'OPTIONAL'] as const;
export type RequirementNecessity = (typeof REQUIREMENT_NECESSITIES)[number];

/**
 * How well the archive already answers one requirement.
 *
 * The distinctions carry weight: SATISFIED stops research happening at all,
 * PRESENT_BUT_UNVERIFIED means somebody wrote the answer down but nothing
 * supports it, and DEFINITION_MISMATCH is the one that quietly ruins a packet —
 * a real number about a slightly different thing.
 */
export const COVERAGE_STATUSES = [
  'SATISFIED',
  'PARTIALLY_SATISFIED',
  'PRESENT_BUT_UNVERIFIED',
  'STALE',
  'CONTRADICTED',
  'DEFINITION_MISMATCH',
  'SUPERSEDED',
  'OWNED_ELSEWHERE',
  'NOT_REQUIRED',
  'MISSING',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** Why a requirement is not covered, which decides whether research is the answer. */
export const GAP_TYPES = [
  'MISSING_FOUNDATIONAL',
  'MISSING_SUPPORTING',
  'MISSING_CALCULATION_INPUT',
  'MISSING_COMPARISON',
  'MISSING_GEOGRAPHY',
  'MISSING_TIMEFRAME',
  'MISSING_POPULATION',
  'MISSING_DEFINITION',
  'STALE_EVIDENCE',
  'UNVERIFIABLE_CITATION',
  'SOURCE_QUALITY',
  'UNRESOLVED_CONTRADICTION',
  'INSUFFICIENT_INDEPENDENCE',
  'MISSING_COUNTEREVIDENCE',
  'AMBIGUOUS_EVIDENCE',
  'SYNTHESIS_GAP',
  'OTHER_LAYER_OWNERSHIP',
  'IMPLEMENTATION_DETAIL',
  'EMPIRICAL_VALIDATION',
  'TUNING',
  'OPTIONAL_ENRICHMENT',
] as const;
export type GapType = (typeof GAP_TYPES)[number];

/** Whether an existing claim's own source stands up. */
export const VERIFICATION_STATES = [
  'UNVERIFIED',
  'VERIFIED',
  'UNVERIFIABLE',
  'SUPERSEDED',
  'REJECTED',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** What a new finding does to what the project already had. */
export const RECONCILIATION_OUTCOMES = [
  'CONFIRMS',
  'STRENGTHENS',
  'UPDATES_STALE',
  'FILLS_GAP',
  'NARROWS',
  'CONTRADICTS',
  'DUPLICATES',
  'FAILS_REQUIREMENT',
  'RAISES_NEW_QUESTION',
] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

/** What a bundled job is for, which decides how much model it deserves. */
export const JOB_KINDS = ['DISCOVERY', 'INVESTIGATION', 'VERIFICATION', 'SYNTHESIS'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * What a provider says about the allowance it is running on.
 *
 * UNKNOWN is a real answer and the common one: most tools do not report a
 * quota, and treating silence as exhaustion would stop research that would have
 * worked. Scope matters because a provider's own model allowance and a
 * third-party model's allowance run out separately.
 */
export const QUOTA_STATES = ['AVAILABLE', 'LIMITED', 'EXHAUSTED', 'UNKNOWN'] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

export const QUOTA_SCOPES = ['GEMINI', 'THIRD_PARTY', 'UNKNOWN'] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export interface ProviderQuota {
  state: QuotaState;
  scope: QuotaScope;
  /** Phrased for the user; never a raw CLI line. */
  detail: string;
  resetsAt: string | null;
}

export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'PAUSED_QUOTA',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Does the evidence hold up? Separate from whether there is enough of it. */
export const INTEGRITY_VERDICTS = ['PASS', 'FAIL'] as const;
export type IntegrityVerdict = (typeof INTEGRITY_VERDICTS)[number];

/** Does it actually answer the fragment's question, to the declared coverage? */
export const SUFFICIENCY_VERDICTS = ['SUFFICIENT', 'INSUFFICIENT'] as const;
export type SufficiencyVerdict = (typeof SUFFICIENCY_VERDICTS)[number];

/** What later passes did to a claim. Silence is not agreement, so nothing defaults to SUPPORTED. */
export const CONTRADICTION_STATES = ['UNCHALLENGED', 'SUPPORTED', 'CONTESTED', 'REFUTED'] as const;
export type ContradictionState = (typeof CONTRADICTION_STATES)[number];

/**
 * What kind of disagreement two claims are actually in.
 *
 * Most "contradictions" are not factual conflicts at all: two figures measured
 * on different populations, in different years, or under different definitions
 * disagree because they are answering different questions. Saying which kind it
 * is decides what to do — a definition mismatch is settled by choosing the
 * definition, a factual conflict needs a source that resolves it, and neither
 * is ever settled by averaging the two numbers.
 */
export const CONTRADICTION_KINDS = [
  'DIRECT_FACTUAL_CONFLICT',
  'DEFINITION_MISMATCH',
  'TIMEFRAME_MISMATCH',
  'GEOGRAPHY_MISMATCH',
  'POPULATION_MISMATCH',
  'METHODOLOGICAL_DIFFERENCE',
  'MEASUREMENT_UNCERTAINTY',
  'FORECAST_DISAGREEMENT',
  'RESOLVED_BY_CONTEXT',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** Structural verdict on a claim's source. Only SOURCED counts as evidence. */
export const CLAIM_VALIDATION_STATES = [
  'SOURCED',
  'NO_URL',
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'LOCAL_ADDRESS',
  // A search results page is where you look for a source, not a source.
  'SEARCH_RESULT',
  // A grounding or caching redirect stands between the reader and the source,
  // and stops resolving the moment the tool's session expires.
  'GROUNDING_REDIRECT',
  'NO_EVIDENCE',
] as const;
export type ClaimValidationState = (typeof CLAIM_VALIDATION_STATES)[number];

export interface DocumentSegmentRow {
  id: string;
  document_id: string;
  extraction_run_id: string;
  segment_index: number;
  segment_type: string;
  title: string;
  speaker: string | null;
  timestamp_text: string | null;
  block_start: number;
  block_end: number;
  char_start: number;
  char_end: number;
  text: string;
  content_hash: string;
  confidence: number;
  rationale: string;
  warnings: string;
  created_at: string;
}

export interface DocumentSegment {
  id: string;
  documentId: string;
  extractionRunId: string;
  segmentIndex: number;
  segmentType: SegmentType;
  title: string;
  speaker: string | null;
  timestampText: string | null;
  blockStart: number;
  blockEnd: number;
  charStart: number;
  charEnd: number;
  text: string;
  contentHash: string;
  /** How sure the classifier is, 0..1. Never presented as certainty. */
  confidence: number;
  rationale: string;
  warnings: string[];
  createdAt: string;
}

export interface SegmentLayerLinkRow {
  id: string;
  document_id: string;
  segment_id: string | null;
  layer_id: string;
  version: string | null;
  link_type: string;
  confidence: number;
  rationale: string;
  status: string;
  decided_at: string | null;
  created_at: string;
}

export interface SegmentLayerLink {
  id: string;
  documentId: string;
  /** Null for a whole-document link, as an ordinary imported file produces. */
  segmentId: string | null;
  layerId: string;
  version: string | null;
  linkType: LinkType;
  confidence: number;
  rationale: string;
  status: LinkStatus;
  decidedAt: string | null;
  createdAt: string;
}

export interface IngestionReportRow {
  id: string;
  document_id: string;
  extraction_run_id: string;
  scope: string;
  report: string;
  created_at: string;
}

export interface ImportJobRow {
  id: string;
  project_id: string;
  source_label: string;
  root_path: string;
  status: string;
  scope: string;
  discovered: number;
  processed: number;
  registered: number;
  duplicates: number;
  unsupported: number;
  unreadable: number;
  failed: number;
  needs_review: number;
  message: string | null;
  cancel_reason: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportFileRow {
  id: string;
  job_id: string;
  project_id: string;
  absolute_path: string;
  relative_path: string;
  filename: string;
  file_size: number | null;
  file_hash: string | null;
  detected_format: string | null;
  source_modified_at: string | null;
  status: string;
  document_id: string | null;
  duplicate_of_id: string | null;
  extraction_status: string | null;
  extraction_method: string | null;
  pages: number | null;
  ocr_pages: number | null;
  detail: string | null;
  warnings: string;
  classification: string | null;
  needs_confirmation: number;
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoundaryContractRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  primary_question: string;
  decision_supported: string | null;
  audience: string | null;
  included_subjects: string;
  excluded_subjects: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string;
  required_comparisons: string;
  required_calculations: string;
  expected_output: string | null;
  required_confidence: string | null;
  acceptable_uncertainty: string | null;
  prohibited_assumptions: string;
  source_constraints: string;
  completion_standard: string | null;
  ambiguities: string;
  status: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequirementRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  requirement_key: string;
  ordinal: number;
  statement: string;
  necessity: string;
  kind: string;
  rationale: string | null;
  required_evidence: string;
  completion_criteria: string;
  depends_on: string;
  owning_layer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExistingClaimRow {
  id: string;
  project_id: string;
  document_id: string;
  extraction_run_id: string | null;
  layer_id: string | null;
  claim: string;
  claim_type: string;
  page: number | null;
  block_index: number | null;
  char_start: number | null;
  char_end: number | null;
  locator: string | null;
  source_url: string | null;
  source_title: string | null;
  source_publisher: string | null;
  source_date: string | null;
  retrieved_at: string | null;
  supporting_passage: string | null;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  extraction_confidence: number;
  evidence_confidence: number;
  contradiction_state: string;
  verification_state: string;
  verification_detail: string | null;
  prior_audit_id: string | null;
  document_version: string | null;
  superseded: number;
  content_hash: string;
  created_at: string;
}

export interface RequirementCoverageRow {
  id: string;
  orchestration_id: string;
  requirement_id: string;
  status: string;
  reasons: string;
  claim_ids: string;
  document_ids: string;
  confidence: number;
  gap_type: string | null;
  gap_detail: string | null;
  needs_research: number;
  user_override: string | null;
  overridden_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchJobRow {
  id: string;
  orchestration_id: string;
  project_id: string;
  rationale: string;
  provider: string;
  model: string | null;
  job_kind: string;
  status: string;
  priority: number;
  external_job_id: string | null;
  prompt_sha256: string | null;
  prompt_bytes: number | null;
  output_bytes: number | null;
  duration_ms: number | null;
  failure_reason: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderConnectionRow {
  provider: string;
  installed: number;
  authenticated: number;
  automation_ready: number;
  executable_path: string | null;
  version: string | null;
  model: string | null;
  quota_state: string | null;
  message: string | null;
  diagnostics: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_reason: string | null;
  paid_overage_enabled: number;
  paid_overage_note: string | null;
  paid_overage_set_at: string | null;
  light_model: string | null;
  verified_run_at: string | null;
  verified_run_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchOrchestrationRow {
  id: string;
  project_id: string;
  layer_id: string;
  run_id: string;
  title: string;
  assignment: string;
  target_version: string | null;
  provider: string;
  model: string | null;
  status: string;
  current_pass: string | null;
  attempt: number;
  parent_orchestration_id: string | null;
  repair_reason: string | null;
  report_text: string | null;
  document_id: string | null;
  audit_id: string | null;
  verdict: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  heartbeat_at: string | null;
  auto_approve: number;
  approved_at: string | null;
  approval_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchFragmentRow {
  requirement_ids: string;
  evidence_lane: string | null;
  why_it_matters: string | null;
  missing_evidence: string | null;
  why_existing_insufficient: string | null;
  existing_claim_ids: string;
  excluded_scope: string | null;
  expected_claim_types: string;
  preferred_source_types: string;
  prohibited_evidence: string;
  required_comparisons: string;
  required_calculations: string;
  contradiction_targets: string;
  failure_conditions: string;
  uncertainty_tolerance: string | null;
  priority: number;
  estimated_effort: string | null;
  max_repairs: number;
  split_from_id: string | null;
  repair_plan: string | null;
  cancelled_reason: string | null;
  id: string;
  orchestration_id: string;
  project_id: string;
  layer_id: string;
  fragment_index: number;
  fragment_key: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  required_evidence: string;
  acceptable_source_types: string;
  excluded_source_types: string;
  completion_criteria: string;
  depends_on: string;
  min_independent_sources: number;
  status: string;
  attempt: number;
  parent_fragment_id: string | null;
  repair_reason: string | null;
  repair_strategy: string | null;
  integrity_verdict: string | null;
  sufficiency_verdict: string | null;
  verdict_detail: string | null;
  blocked_reason: string | null;
  queued_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchPassRow {
  id: string;
  orchestration_id: string;
  fragment_id: string | null;
  pass_key: string;
  ordinal: number;
  attempt: number;
  status: string;
  provider: string;
  model: string | null;
  prompt: string;
  prompt_sha256: string;
  raw_response: string | null;
  parsed: string | null;
  error: string | null;
  job_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface ResearchClaimRow {
  claim_type: string;
  source_group: string | null;
  primary_source: number;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  requirement_ids: string;
  job_id: string | null;
  reconciliation: string | null;
  reconciled_claim_id: string | null;
  contradiction_kind: string | null;
  reconciliation_detail: string | null;
  id: string;
  orchestration_id: string;
  fragment_id: string | null;
  pass_id: string | null;
  pass_key: string;
  claim: string;
  source_url: string | null;
  source_title: string | null;
  source_publisher: string | null;
  source_date: string | null;
  evidence_excerpt: string | null;
  evidence_locator: string | null;
  evidence_lane: string | null;
  retrieved_at: string | null;
  confidence: number;
  contradiction_state: string;
  contradiction_note: string | null;
  validation_state: string;
  validation_detail: string | null;
  sourced: number;
  derived: number;
  derived_from: string;
  accepted: number;
  rejection_reason: string | null;
  scope_match: string | null;
  content_hash: string;
  created_at: string;
}

/** The machine-readable verdict every extraction run ends with (section 10). */
export interface ExtractionQuality {
  status: ExtractionStatus;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  pagesFailed: number[];
  characterCount: number;
  warnings: string[];
  coverageRatio: number;
  pipelineVersion: string;
  blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** A parsed version such as `v3.1A` → { major: 3, minor: 1, branch: 'A' }. */
export interface ParsedVersion {
  raw: string;
  /** Normalised canonical rendering, e.g. `v3.1A`. */
  normalized: string;
  major: number;
  minor: number;
  branch: string;
  /** 0 when there is no branch suffix; 1 = A, 2 = B … 27 = AA. */
  branchIndex: number;
  /** Lexicographically sortable key. Never sort on `raw`. */
  sortKey: string;
  valid: boolean;
}

export interface VersionPolicy {
  /** Version issued for the wave-1 foundation document. */
  foundationVersion: string;
  /** First branch suffix used for sibling expansions (Deal Dispatch starts at B). */
  expansionStartBranch: string;
  /** Version issued for the canonical synthesis. Never auto-incremented. */
  synthesisVersion: string;
  /** Wave in which synthesis happens. */
  synthesisWave: number;
  /** Cap on automatic conceptual redo loops before a human is required. */
  maxAutoRedos: number;
}

export const DEFAULT_VERSION_POLICY: VersionPolicy = {
  foundationVersion: 'v1',
  expansionStartBranch: 'B',
  synthesisVersion: 'v3.1',
  synthesisWave: 3,
  maxAutoRedos: 2,
};

// ---------------------------------------------------------------------------
// Rows (exact database shapes)
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  north_star: string | null;
  current_wave: number;
  status: string;
  version_policy: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface LayerRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  order_index: number;
  status: string;
  status_source: string;
  manual_status: string | null;
  manual_status_reason: string | null;
  current_version: string | null;
  current_wave: number;
  canonical_document_id: string | null;
  expected_versions: string;
  parked: number;
  parked_note: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  canonical_name: string;
  version: string;
  version_sort: string;
  wave: number | null;
  document_type: string;
  status: string;
  filename: string | null;
  filesystem_path: string | null;
  storage_key: string | null;
  storage_provider: string | null;
  file_size: number | null;
  file_hash: string | null;
  file_missing: number;
  conversation_title: string | null;
  source_run_id: string | null;
  parent_document_id: string | null;
  superseded_by_document_id: string | null;
  is_canonical: number;
  frozen: number;
  notes: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
  mime_type: string | null;
  detected_format: string | null;
  page_count: number | null;
  extraction_status: string;
  extraction_run_id: string | null;
  pipeline_version: string | null;
  origin: string;
  scope: string;
  classification_source: string | null;
  classification_confidence: number | null;
  import_job_id: string | null;
  source_path: string | null;
  source_modified_at: string | null;
}

export interface ResearchRunRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  target_document_id: string | null;
  target_version: string | null;
  run_type: string;
  attempt_number: number;
  status: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  prompt_sections: string;
  required_attachments: string;
  expected_conversation_title: string | null;
  expected_filename: string | null;
  result_text: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  parent_run_id: string | null;
  redo_reason: string | null;
  dependency_override: number;
  dependency_override_reason: string | null;
  external_response_id: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DependencyRow {
  id: string;
  project_id: string;
  dependent_document_id: string | null;
  dependent_run_id: string | null;
  required_document_id: string | null;
  required_canonical_name: string;
  required_layer_id: string | null;
  dependency_type: string;
  required: number;
  notes: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  run_id: string | null;
  audited_document_id: string | null;
  verdict: string;
  summary: string;
  confidence: number | null;
  synthesis_required: number;
  freeze_eligible: number;
  next_version: string | null;
  next_action: string | null;
  source: string;
  raw: string;
  created_at: string;
  mode: string;
  profile_id: string | null;
  foundational_gap_count: number;
  targeted_research_runs_required: number;
  audited_document_ids: string;
  provider: string | null;
  model: string | null;
  evidence_manifest: string;
}

export interface AuditFindingRow {
  id: string;
  audit_id: string;
  finding_type: string;
  ordinal: number;
  content: string;
  payload: string;
  created_at: string;
}

export interface AuditGapRow {
  id: string;
  audit_id: string;
  ordinal: number;
  classification: string;
  title: string;
  detail: string;
  owning_layer_id: string | null;
  owning_layer_name: string | null;
  justification: string;
  research_question: string | null;
  expected_contribution: string | null;
  source_pass: string;
  created_at: string;
}

export interface AuditPassRow {
  id: string;
  audit_id: string | null;
  pipeline_id: string;
  project_id: string;
  layer_id: string | null;
  pass_key: string;
  ordinal: number;
  provider: string | null;
  model: string | null;
  prompt: string;
  raw_response: string | null;
  parsed: string;
  ok: number;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ExtractionRunRow {
  id: string;
  document_id: string;
  project_id: string;
  status: string;
  pipeline_version: string;
  detected_format: string | null;
  source_hash: string | null;
  pages_expected: number;
  pages_readable: number;
  pages_ocr: number;
  pages_failed: string;
  character_count: number;
  coverage_ratio: number;
  warnings: string;
  blocked_reason: string | null;
  error: string | null;
  superseded_by_run_id: string | null;
  ocr_engine: string | null;
  ocr_engine_version: string | null;
  ocr_renderer_version: string | null;
  ocr_pages: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentBlockRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  page_number: number;
  block_index: number;
  block_type: string;
  raw_text: string;
  normalized_text: string;
  char_start: number;
  char_end: number;
  extraction_method: string;
  confidence: number | null;
  warnings: string;
  content_hash: string;
  bbox: string | null;
  created_at: string;
}

export interface DocumentChunkRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  block_start: number;
  block_end: number;
  heading_path: string;
  text: string;
  char_count: number;
  char_start: number;
  char_end: number;
  overlap_prev: number;
  has_ocr: number;
  content_hash: string;
  created_at: string;
}

export interface DocumentFindingRow {
  id: string;
  extraction_run_id: string;
  document_id: string;
  chunk_id: string | null;
  finding_type: string;
  ordinal: number;
  content: string;
  evidence_page: number | null;
  evidence_quote: string;
  confidence: number | null;
  source: string;
  created_at: string;
}

export interface AuditEvidenceRow {
  id: string;
  audit_id: string;
  gap_id: string | null;
  document_id: string | null;
  extraction_run_id: string | null;
  chunk_id: string | null;
  document_label: string;
  page_number: number | null;
  quote: string;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  run_id: string | null;
  title: string;
  provider_conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: string;
  created_at: string;
}

export interface ProjectEventRow {
  id: string;
  project_id: string;
  layer_id: string | null;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  payload: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Views (API/UI shapes)
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  northStar: string | null;
  currentWave: number;
  status: ProjectStatus;
  versionPolicy: VersionPolicy;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Layer {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  orderIndex: number;
  status: LayerStatus;
  statusSource: StatusSource;
  manualStatus: LayerStatus | null;
  manualStatusReason: string | null;
  currentVersion: string | null;
  currentWave: number;
  canonicalDocumentId: string | null;
  expectedVersions: string[];
  parked: boolean;
  parkedNote: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  projectId: string;
  layerId: string | null;
  canonicalName: string;
  version: string;
  versionSort: string;
  wave: number | null;
  documentType: DocumentType;
  status: DocumentStatus;
  filename: string | null;
  filesystemPath: string | null;
  /**
   * Where the bytes are, in the document store's own terms.
   *
   * The same string as `filesystemPath` for anything stored locally — a
   * data-root-relative path is a perfectly good key — and an identity-based key
   * for anything stored in the cloud.
   */
  storageKey: string | null;
  /** Which store holds them: LOCAL or SUPABASE. */
  storageProvider: string | null;
  fileSize: number | null;
  fileHash: string | null;
  fileMissing: boolean;
  conversationTitle: string | null;
  sourceRunId: string | null;
  parentDocumentId: string | null;
  supersededByDocumentId: string | null;
  isCanonical: boolean;
  frozen: boolean;
  notes: string | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
  mimeType: string | null;
  detectedFormat: DocumentFormat | null;
  pageCount: number | null;
  extractionStatus: ExtractionStatus;
  extractionRunId: string | null;
  pipelineVersion: string | null;
  origin: DocumentOrigin;
  /** LAYER for an ordinary report; a project scope for a source spanning layers. */
  scope: DocumentScope;
  /** How the layer was decided. A filename is a hint, never understanding. */
  classificationSource: ClassificationSource | null;
  classificationConfidence: number | null;
  /** The folder import this came from, and where it sat in that folder. */
  importJobId: string | null;
  sourcePath: string | null;
  sourceModifiedAt: string | null;
}

export interface ExtractionRun {
  id: string;
  documentId: string;
  projectId: string;
  status: ExtractionStatus;
  pipelineVersion: string;
  detectedFormat: DocumentFormat | null;
  sourceHash: string | null;
  pagesExpected: number;
  pagesReadable: number;
  pagesOcr: number;
  pagesFailed: number[];
  characterCount: number;
  coverageRatio: number;
  warnings: string[];
  blockedReason: string | null;
  error: string | null;
  supersededByRunId: string | null;
  /** Which OCR engine read this document's scanned pages, if any. */
  ocrEngine: string | null;
  ocrEngineVersion: string | null;
  ocrRendererVersion: string | null;
  /** Per-page OCR provenance: what was rendered, read, and how certainly. */
  ocrPages: OcrPageRecord[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What OCR did to one page.
 *
 * `imageHash` is the identity of the picture that was actually read, which is
 * what makes an OCR reading reproducible rather than merely plausible.
 */
export interface OcrPageRecord {
  page: number;
  ok: boolean;
  imageHash: string | null;
  width: number | null;
  height: number | null;
  dpi: number | null;
  confidence: number | null;
  durationMs: number | null;
  blocks: number;
  characters: number;
  warnings: string[];
}

export interface DocumentBlock {
  id: string;
  extractionRunId: string;
  documentId: string;
  pageNumber: number;
  blockIndex: number;
  blockType: BlockType;
  rawText: string;
  normalizedText: string;
  charStart: number;
  charEnd: number;
  extractionMethod: ExtractionMethod;
  confidence: number | null;
  warnings: string[];
  contentHash: string;
  bbox: [number, number, number, number] | null;
  createdAt: string;
}

export interface DocumentChunk {
  id: string;
  extractionRunId: string;
  documentId: string;
  chunkIndex: number;
  pageStart: number;
  pageEnd: number;
  blockStart: number;
  blockEnd: number;
  headingPath: string[];
  text: string;
  charCount: number;
  charStart: number;
  charEnd: number;
  overlapPrev: number;
  hasOcr: boolean;
  contentHash: string;
  createdAt: string;
}

export interface DocumentFinding {
  id: string;
  extractionRunId: string;
  documentId: string;
  chunkId: string | null;
  findingType: DocumentFindingType;
  ordinal: number;
  content: string;
  evidencePage: number | null;
  evidenceQuote: string;
  confidence: number | null;
  source: string;
  createdAt: string;
}

export interface AuditEvidence {
  id: string;
  auditId: string;
  gapId: string | null;
  documentId: string | null;
  extractionRunId: string | null;
  chunkId: string | null;
  documentLabel: string;
  pageNumber: number | null;
  quote: string;
  createdAt: string;
}

export interface ResearchRun {
  id: string;
  projectId: string;
  layerId: string | null;
  targetDocumentId: string | null;
  targetVersion: string | null;
  runType: RunType;
  attemptNumber: number;
  status: RunStatus;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  promptSections: PromptSection[];
  requiredAttachments: string[];
  expectedConversationTitle: string | null;
  expectedFilename: string | null;
  resultText: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  parentRunId: string | null;
  redoReason: string | null;
  dependencyOverride: boolean;
  dependencyOverrideReason: string | null;
  externalResponseId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One folder import, and the counted state of everything inside it. */
export interface ImportJob {
  id: string;
  projectId: string;
  sourceLabel: string;
  rootPath: string;
  status: ImportJobStatus;
  scope: DocumentScope;
  discovered: number;
  processed: number;
  registered: number;
  duplicates: number;
  unsupported: number;
  unreadable: number;
  failed: number;
  needsReview: number;
  message: string | null;
  cancelReason: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportFile {
  id: string;
  jobId: string;
  projectId: string;
  absolutePath: string;
  relativePath: string;
  filename: string;
  fileSize: number | null;
  fileHash: string | null;
  detectedFormat: DocumentFormat | null;
  sourceModifiedAt: string | null;
  status: ImportFileStatus;
  documentId: string | null;
  duplicateOfId: string | null;
  extractionStatus: ExtractionStatus | null;
  extractionMethod: string | null;
  pages: number | null;
  ocrPages: number | null;
  detail: string | null;
  warnings: string[];
  classification: unknown;
  needsConfirmation: boolean;
  attempts: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What this assignment is, and is not, about. Settled before any research. */
export interface BoundaryContract {
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  primaryQuestion: string;
  decisionSupported: string | null;
  audience: string | null;
  includedSubjects: string[];
  excludedSubjects: string[];
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: { term: string; definition: string }[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  expectedOutput: string | null;
  requiredConfidence: string | null;
  acceptableUncertainty: string | null;
  prohibitedAssumptions: string[];
  sourceConstraints: string[];
  completionStandard: string | null;
  /** Boundaries the plan could not settle; each is a candidate fragment. */
  ambiguities: { question: string; why: string }[];
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  requirementKey: string;
  ordinal: number;
  statement: string;
  necessity: RequirementNecessity;
  kind: RequirementKind;
  rationale: string | null;
  requiredEvidence: string[];
  completionCriteria: string[];
  dependsOn: string[];
  owningLayerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A claim recovered from a document the project already had. */
export interface ExistingClaim {
  id: string;
  projectId: string;
  documentId: string;
  extractionRunId: string | null;
  layerId: string | null;
  claim: string;
  claimType: ClaimType;
  page: number | null;
  blockIndex: number | null;
  charStart: number | null;
  charEnd: number | null;
  locator: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublisher: string | null;
  sourceDate: string | null;
  retrievedAt: string | null;
  supportingPassage: string | null;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  extractionConfidence: number;
  evidenceConfidence: number;
  contradictionState: ContradictionState;
  verificationState: VerificationState;
  verificationDetail: string | null;
  priorAuditId: string | null;
  documentVersion: string | null;
  superseded: boolean;
  contentHash: string;
  createdAt: string;
}

/** How well the archive already answers one requirement, and why. */
export interface RequirementCoverage {
  id: string;
  orchestrationId: string;
  requirementId: string;
  status: CoverageStatus;
  reasons: string[];
  claimIds: string[];
  documentIds: string[];
  confidence: number;
  gapType: GapType | null;
  gapDetail: string | null;
  needsResearch: boolean;
  userOverride: string | null;
  overriddenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One execution container, carrying one or more compatible fragments. */
export interface ResearchJob {
  id: string;
  orchestrationId: string;
  projectId: string;
  rationale: string;
  provider: string;
  model: string | null;
  jobKind: JobKind;
  status: JobStatus;
  priority: number;
  externalJobId: string | null;
  promptSha256: string | null;
  promptBytes: number | null;
  outputBytes: number | null;
  durationMs: number | null;
  failureReason: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The fragments this job carries, each still independently judged. */
  fragmentIds: string[];
}

/**
 * What the last connection test found, and when the worker last really worked.
 *
 * "Connected" means a job ran, not that an executable exists — so the last
 * success is tracked separately from the last check.
 */
export interface ProviderConnection {
  provider: string;
  installed: boolean;
  authenticated: boolean;
  automationReady: boolean;
  executablePath: string | null;
  version: string | null;
  model: string | null;
  quotaState: string | null;
  message: string | null;
  diagnostics: unknown;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  /** Off unless the user turned it on. Spending money is never a default. */
  paidOverageEnabled: boolean;
  paidOverageNote: string | null;
  paidOverageSetAt: string | null;
  /** The lighter model for broad discovery; `model` is the strong one. */
  lightModel: string | null;
  /** When a real job last ran here — not when a probe last answered. */
  verifiedRunAt: string | null;
  verifiedRunDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One assignment being worked through, pass by pass.
 *
 * `status` is where the work is; `verdict` is what Brain's audit made of it.
 * They are separate on purpose: a COMPLETE orchestration whose verdict was
 * MORE_RESEARCH_REQUIRED did its job correctly and produced a report that did
 * not pass, which is a different thing from a job that failed.
 */
export interface ResearchOrchestration {
  id: string;
  projectId: string;
  layerId: string;
  runId: string;
  title: string;
  assignment: string;
  targetVersion: string | null;
  provider: string;
  model: string | null;
  status: OrchestrationStatus;
  currentPass: ResearchPassKey | null;
  attempt: number;
  parentOrchestrationId: string | null;
  repairReason: string | null;
  reportText: string | null;
  documentId: string | null;
  auditId: string | null;
  verdict: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  heartbeatAt: string | null;
  /** False means: plan it, show the plan, and wait for a person. */
  autoApprove: boolean;
  approvedAt: string | null;
  approvalNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One bounded piece of an assignment, with the boundaries that make its answer
 * checkable and the bar it has to clear before any of it counts.
 */
/**
 * Why an attempt failed and what the next one must do differently.
 *
 * The point of writing this down is that a repair which is the same prompt with
 * a different adjective is not a repair — it burns an attempt and the user's
 * allowance to produce the same failure. Every field here is something the next
 * attempt can act on, and the ecosystems already tried are recorded so they are
 * not tried again.
 */
export interface RepairPlan {
  /** The requirement that is still not established. */
  failedRequirement: string;
  /** Claims from the failed attempt that were rejected, and why. */
  affectedClaims: { claim: string; why: string }[];
  missingEvidence: string;
  rejectedEvidence: string[];
  unresolvedContradiction: string | null;
  /** Source ecosystems this fragment has already been searched in. */
  ecosystemsAttempted: string[];
  alternativeEcosystems: string[];
  alternativeTerminology: string[];
  alternativeClassifications: string[];
  /** A narrower question, when narrowing is the honest response to the failure. */
  narrowerQuestion: string | null;
  splitRequired: boolean;
  /** Attempts left before this fragment is reported unresolved. */
  remainingBudget: number;
  /** The named strategies this attempt should use, in order. */
  strategies: RepairStrategy[];
}

/**
 * The things that can actually be done differently.
 *
 * A named ladder rather than free text, so a repair cannot repeat the previous
 * attempt's approach and so the reason a fragment was finally abandoned is
 * checkable: every rung was tried.
 */
export const REPAIR_STRATEGIES = [
  'RESOLVE_CANONICAL_LINK',
  'FIND_PRIMARY_DATA',
  'TRY_DIFFERENT_REPOSITORIES',
  'USE_REGULATORY_RECORDS',
  'USE_PROCUREMENT_RECORDS',
  'USE_OFFICIAL_FILINGS',
  'INSPECT_ARCHIVED_SOURCES',
  'FIND_METHODOLOGY_DOCUMENTATION',
  'CHANGE_TERMINOLOGY',
  'USE_CLASSIFICATION_CODES',
  'NARROW_THE_CLAIM',
  'REPLACE_ESTIMATE_WITH_RANGE',
  'MARK_UNRESOLVED',
] as const;
export type RepairStrategy = (typeof REPAIR_STRATEGIES)[number];

export interface ResearchFragment {
  /** The requirements this fragment exists to answer. */
  requirementIds: string[];
  evidenceLane: string | null;
  whyItMatters: string | null;
  missingEvidence: string | null;
  /** Why the archive's own evidence could not answer it. */
  whyExistingInsufficient: string | null;
  existingClaimIds: string[];
  excludedScope: string | null;
  expectedClaimTypes: string[];
  preferredSourceTypes: string[];
  prohibitedEvidence: string[];
  requiredComparisons: string[];
  requiredCalculations: string[];
  contradictionTargets: string[];
  failureConditions: string[];
  uncertaintyTolerance: string | null;
  priority: number;
  estimatedEffort: string | null;
  maxRepairs: number;
  splitFromId: string | null;
  /** The structured plan behind a repair attempt; null on a first attempt. */
  repairPlan: RepairPlan | null;
  /** Set when accepted evidence made this fragment unnecessary. */
  cancelledReason: string | null;
  id: string;
  orchestrationId: string;
  projectId: string;
  layerId: string;
  fragmentIndex: number;
  fragmentKey: string;
  question: string;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definitions: string | null;
  requiredEvidence: string[];
  acceptableSourceTypes: string[];
  excludedSourceTypes: string[];
  completionCriteria: string[];
  dependsOn: string[];
  minIndependentSources: number;
  status: FragmentStatus;
  attempt: number;
  parentFragmentId: string | null;
  repairReason: string | null;
  repairStrategy: string | null;
  integrityVerdict: IntegrityVerdict | null;
  sufficiencyVerdict: SufficiencyVerdict | null;
  verdictDetail: unknown;
  blockedReason: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchPass {
  id: string;
  orchestrationId: string;
  fragmentId: string | null;
  passKey: ResearchPassKey;
  ordinal: number;
  attempt: number;
  status: ResearchPassStatus;
  provider: string;
  model: string | null;
  prompt: string;
  promptSha256: string;
  rawResponse: string | null;
  parsed: unknown;
  error: string | null;
  jobId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface ResearchClaim {
  claimType: ClaimType;
  /** Sources that are really one source share a group; copies do not corroborate. */
  sourceGroup: string | null;
  primarySource: boolean;
  geography: string | null;
  timeframe: string | null;
  population: string | null;
  definition: string | null;
  requirementIds: string[];
  jobId: string | null;
  /** What this finding does to the evidence the project already had. */
  reconciliation: ReconciliationOutcome | null;
  reconciledClaimId: string | null;
  /** How it disagrees with the claim it was reconciled against, when it does. */
  contradictionKind: ContradictionKind | null;
  reconciliationDetail: string | null;
  id: string;
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
  /** The fragment evidence lane it fills, if any. Coverage is counted per lane. */
  evidenceLane: string | null;
  retrievedAt: string | null;
  confidence: number;
  contradictionState: ContradictionState;
  contradictionNote: string | null;
  validationState: ClaimValidationState;
  validationDetail: string | null;
  /** False whenever the claim may not be cited as evidence. */
  sourced: boolean;
  /** A calculation or inference rather than something a source states. */
  derived: boolean;
  /** The claims it was derived from; all of them must themselves be accepted. */
  derivedFrom: string[];
  /** Only an accepted claim may enter a synthesis. */
  accepted: boolean;
  rejectionReason: string | null;
  scopeMatch: unknown;
  contentHash: string;
  createdAt: string;
}

export interface Dependency {
  id: string;
  projectId: string;
  dependentDocumentId: string | null;
  dependentRunId: string | null;
  requiredDocumentId: string | null;
  requiredCanonicalName: string;
  requiredLayerId: string | null;
  dependencyType: DependencyType;
  required: boolean;
  notes: string | null;
  createdAt: string;
}

export interface AuditFinding {
  id: string;
  auditId: string;
  findingType: AuditFindingType;
  ordinal: number;
  content: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditGap {
  id: string;
  auditId: string;
  ordinal: number;
  classification: GapClassification;
  title: string;
  detail: string;
  owningLayerId: string | null;
  owningLayerName: string | null;
  justification: string;
  researchQuestion: string | null;
  expectedContribution: string | null;
  sourcePass: AuditPassKey;
  createdAt: string;
}

export interface AuditPass {
  id: string;
  auditId: string | null;
  pipelineId: string;
  projectId: string;
  layerId: string | null;
  passKey: AuditPassKey;
  ordinal: number;
  provider: string | null;
  model: string | null;
  prompt: string;
  rawResponse: string | null;
  parsed: unknown;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface Audit {
  id: string;
  projectId: string;
  layerId: string | null;
  runId: string | null;
  auditedDocumentId: string | null;
  verdict: AuditVerdict;
  summary: string;
  confidence: number | null;
  synthesisRequired: boolean;
  freezeEligible: boolean;
  nextVersion: string | null;
  nextAction: string | null;
  source: string;
  raw: Record<string, unknown>;
  createdAt: string;
  findings: AuditFinding[];
  mode: AuditMode;
  profileId: string | null;
  foundationalGapCount: number;
  targetedResearchRunsRequired: number;
  auditedDocumentIds: string[];
  provider: string | null;
  model: string | null;
  gaps: AuditGap[];
  /** Proof of exactly which documents, pages and extraction runs were read. */
  evidenceManifest: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  projectId: string;
  layerId: string | null;
  runId: string | null;
  title: string;
  providerConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  layerId: string | null;
  entityType: string;
  entityId: string | null;
  eventType: EventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Structured audit payload (section 12)
// ---------------------------------------------------------------------------

export interface StructuredAuditResult {
  verdict: AuditVerdict;
  summary: string;
  failures: string[];
  missingDocuments: string[];
  requiredResearchRuns: string[];
  requiredPatches: string[];
  synthesisRequired: boolean;
  freezeEligible: boolean;
  nextVersion: string | null;
  nextAction: string;
  confidence?: number | null;
}

// ---------------------------------------------------------------------------
// Prompt compiler (section 9)
// ---------------------------------------------------------------------------

export type PromptSectionKey =
  | 'PROJECT_CONTEXT'
  | 'LAYER_CONTEXT'
  | 'RUN_TYPE'
  | 'OBJECTIVE'
  | 'SOURCE_PACKET'
  | 'REQUIRED_ATTACHMENTS'
  | 'SCOPE'
  | 'RESEARCH_QUESTIONS'
  | 'PROHIBITED_DUPLICATION'
  | 'CROSS_LAYER_BOUNDARIES'
  | 'AUDIT_FINDINGS'
  | 'PREVIOUS_ATTEMPT'
  | 'OUTPUT_REQUIREMENTS'
  | 'NAMING_RULES'
  | 'FINAL_NAMING_CHECK';

export interface PromptSection {
  key: PromptSectionKey;
  heading: string;
  body: string;
}

export interface CompiledPrompt {
  prompt: string;
  sections: PromptSection[];
  requiredAttachments: string[];
  expectedConversationTitle: string;
  expectedFilename: string;
  targetCanonicalName: string;
  targetVersion: string;
}

// ---------------------------------------------------------------------------
// Dependency checker (section 11)
// ---------------------------------------------------------------------------

export interface DependencyCheckItem {
  canonicalName: string;
  documentId: string | null;
  required: boolean;
  dependencyType: DependencyType;
  present: boolean;
  /** Registered in the DB but the physical file is gone. */
  fileMissing: boolean;
  status: DocumentStatus | null;
}

export interface DependencyCheckResult {
  items: DependencyCheckItem[];
  requiredCount: number;
  presentCount: number;
  missing: string[];
  /** Registered dependencies whose file vanished from disk. */
  inconsistent: string[];
  ready: boolean;
  blocked: boolean;
  /** `6 / 7 READY` */
  summary: string;
}

// ---------------------------------------------------------------------------
// State engine + planner (sections 4 and 5)
// ---------------------------------------------------------------------------

export interface LayerStateSnapshot {
  layerId: string;
  layerName: string;
  status: LayerStatus;
  statusSource: StatusSource;
  reason: string;
  currentVersion: string | null;
  canonicalName: string | null;
  expectedVersions: string[];
  presentVersions: string[];
  missingVersions: string[];
  documentsComplete: number;
  documentsExpected: number;
  activeRunIds: string[];
  missingDependencies: string[];
  inconsistentDocuments: string[];
  /** Documents that are registered and present, but could not be read. */
  unreadableDocuments: string[];
  latestAuditVerdict: AuditVerdict | null;
  frozen: boolean;
  parked: boolean;
  nextAction: string;
  nextVersion: string | null;
}

export type PlannerBucket = 'NOW' | 'NEXT' | 'LATER' | 'BLOCKED';

export interface PlannerItem {
  bucket: PlannerBucket;
  layerId: string;
  layerName: string;
  status: LayerStatus;
  title: string;
  detail: string;
  /** Lower sorts first. Deterministic; never derived from chat memory. */
  priority: number;
  actionType:
    | 'IMPORT_DOCUMENT'
    | 'RUN_FOUNDATION'
    | 'RUN_EXPANSION'
    | 'RUN_AUDIT'
    | 'RUN_REDO'
    | 'RUN_SYNTHESIS'
    | 'FREEZE_LAYER'
    | 'RESOLVE_DEPENDENCY'
    | 'RECONCILE'
    | 'WAIT'
    | 'NONE';
  targetVersion: string | null;
  missing: string[];
}

export interface PlannerResult {
  projectId: string;
  projectName: string;
  wave: number;
  now: PlannerItem[];
  next: PlannerItem[];
  later: PlannerItem[];
  blocked: PlannerItem[];
  nextBestAction: PlannerItem | null;
  nextBestActionText: string;
  layers: LayerStateSnapshot[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Import + reconciliation (sections 7 and 21)
// ---------------------------------------------------------------------------

export interface InferenceResult {
  layerId: string | null;
  layerName: string | null;
  version: string | null;
  documentType: DocumentType | null;
  canonicalName: string | null;
  wave: number | null;
  confidence: number;
  /** Human-readable explanation of every inference decision. */
  reasons: string[];
  ambiguous: boolean;
}

export interface ImportResult {
  filename: string;
  storedPath: string | null;
  inference: InferenceResult;
  documentId: string | null;
  registered: boolean;
  requiresConfirmation: boolean;
  message: string;
  duplicateOfDocumentId?: string | null;
}

export interface ReconcileIssue {
  kind:
    | 'UNREGISTERED_FILE'
    | 'MISSING_PHYSICAL_FILE'
    | 'CHECKSUM_CHANGED'
    | 'ORPHANED_DOCUMENT';
  path: string | null;
  documentId: string | null;
  canonicalName: string | null;
  detail: string;
  inference?: InferenceResult;
  /** True when a one-click fix is available. */
  fixable: boolean;
  suggestedFix: string;
}

export interface ReconcileReport {
  projectId: string;
  scannedFiles: number;
  registeredDocuments: number;
  issues: ReconcileIssue[];
  healthy: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Identity, credentials and authorization (Step 4)
//
// Two kinds of principal, kept apart on purpose. A person signs in and holds a
// session; a worker is issued a credential and presents it. Everything below
// exists so that "who is asking, and may they" is answerable from server-held
// state alone — never from anything the caller supplied about itself.
// ---------------------------------------------------------------------------

/** What kind of thing is making a request. */
export const PRINCIPAL_TYPES = ['HUMAN', 'WORKER'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * What a person may do inside one project.
 *
 * Ordered, and the order is the authority ordering: every role can do what the
 * ones after it can. `roleAtLeast` in the policy module is the only place that
 * ordering is interpreted, so adding a role means editing one array.
 */
export const PROJECT_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/**
 * What a worker may do inside one project.
 *
 * Deliberately finer-grained than a role: a worker is given exactly the verbs
 * its job needs, and a worker that only files findings has no way to reopen a
 * layer even by accident.
 *
 * There is no queue-claiming scope and no MCP scope. Those belong to Steps 5
 * and 7, and a scope that grants nothing is worse than an absent one — code
 * starts checking for it, and the check reads as protection.
 */
export const WORKER_SCOPES = [
  'project:read',
  'documents:read',
  'research:read',
  'research:write',
  'research:propose',
  'claims:write',
  'sources:write',
  'contradictions:write',
  'checkpoints:write',
  'blockers:report',
  'work:complete',

  // Step 5 — the distributed queue. Each of these permits an operation that
  // exists and is enforced today; none is reserved for a later step.
  //
  // Administering the queue — enqueueing, cancelling — is deliberately absent.
  // That is a human authority derived from the project roles Step 4 already
  // defines, and giving a worker a scope for it would let a leaked worker
  // credential create work for the fleet rather than only perform it.
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
] as const;
export type WorkerScope = (typeof WORKER_SCOPES)[number];

/**
 * What a remote worker gets, decided here rather than by a person ticking boxes.
 *
 * Scopes are real — they bound what a stolen credential reaches, and they will
 * matter more once research tools land and "reads evidence" stops being the
 * same thing as "writes findings". But composing them by hand was a job with no
 * judgement in it and two ways to get it wrong, and both happened within ten
 * minutes of the screen existing: a worker was granted the wrong project, and
 * `work:complete` was ticked in place of `queue:heartbeat` because the names sit
 * next to each other and one of them is used by no remote tool at all.
 *
 * So the Brain composes the set and a person chooses the project. This is
 * exactly what every tool in the remote surface requires and nothing else — not
 * a convenient superset, and not a subset that would make some tool fail
 * confusingly at the worst moment.
 *
 * The administration API still accepts an explicit list, for the case that has
 * not come up yet. The console does not ask, because asking produced errors
 * rather than decisions.
 */
export const CONNECTOR_SCOPES: readonly WorkerScope[] = [
  'project:read',
  'documents:read',
  'queue:read',
  'queue:claim',
  'queue:heartbeat',
  'queue:complete',
];

/** How a request proved who it was. */
/**
 * `OAUTH_BEARER` is a token this Brain minted for a worker after a human
 * approved the connection. It is a third *way in*, not a third kind of
 * principal: it resolves to the same WORKER principal a `brnw_` credential
 * would, so nothing downstream has to know which door was used.
 */
export const AUTH_METHODS = ['SESSION_COOKIE', 'WORKER_BEARER', 'OAUTH_BEARER'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * ACTIVE, DISABLED, or gone.
 *
 * `ARCHIVED` is terminal. A disabled worker is paused and can be brought back;
 * an archived one is retired, revoked and hidden, and there is deliberately no
 * way to reverse it. Re-enabling would resurrect an identity somebody chose to
 * remove, and the audit rows naming it read better when its name cannot be
 * taken by something new.
 */
export const WORKER_STATUSES = ['ACTIVE', 'DISABLED', 'ARCHIVED'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** Who or what performed an audited action. */
export const ACTOR_TYPES = ['HUMAN', 'WORKER', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const IDENTITY_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type IdentityResult = (typeof IDENTITY_RESULTS)[number];

/**
 * Why something was refused — a category, never a sentence containing evidence.
 *
 * The audit is readable by administrators, and a denial reason that
 * distinguished "no such user" from "wrong password" would turn the log into
 * an oracle for exactly the question an attacker is asking.
 */
export const DENIAL_REASONS = [
  'NO_CREDENTIALS',
  'INVALID_CREDENTIALS',
  'EXPIRED',
  'REVOKED',
  'PRINCIPAL_DISABLED',
  'NOT_A_MEMBER',
  'INSUFFICIENT_ROLE',
  'MISSING_SCOPE',
  'NOT_BRAIN_ADMIN',
  'UNSAFE_TRANSPORT',
  'LAST_ADMIN',
  'PASSWORD_CHANGE_REQUIRED',
  'INTERNAL_ERROR',
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

// --- rows -------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_algorithm: string;
  password_verifier: string;
  password_updated_at: string;
  must_change_password: number;
  is_brain_admin: number;
  disabled_at: string | null;
  created_by_type: string | null;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserSessionRow {
  id: string;
  user_id: string;
  token_verifier: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  created_ip: string | null;
}

export interface WorkerRow {
  id: string;
  name: string;
  display_name: string;
  worker_type: string;
  description: string | null;
  status: string;
  disabled_at: string | null;
  archived_at: string | null;
  created_by_type: string;
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface WorkerInvitationRow {
  id: string;
  worker_id: string;
  token_prefix: string;
  token_digest: string;
  created_by_user_id: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  note: string | null;
}

/** An administrator's approval of one worker, made in advance and sent. */
export interface WorkerInvitation {
  id: string;
  workerId: string;
  tokenPrefix: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  note: string | null;
}

export interface WorkerCredentialRow {
  id: string;
  worker_id: string;
  prefix: string;
  verifier: string;
  issued_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  last_used_at: string | null;
  issued_by_type: string;
  issued_by_id: string;
  rotated_from: string | null;
}

export interface ProjectMembershipRow {
  id: string;
  project_id: string;
  principal_type: string;
  principal_id: string;
  role: string | null;
  scopes: string;
  granted_by_type: string;
  granted_by_id: string;
  granted_at: string;
  revoked_at: string | null;
  updated_at: string;
}

export interface IdentityEventRow {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  credential_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  project_id: string | null;
  result: string;
  reason: string | null;
  request_id: string | null;
  metadata: string;
  user_agent: string | null;
  remote_addr: string | null;
}

// --- views ------------------------------------------------------------------

/**
 * A person, as everything above the repository sees them.
 *
 * There is no password field and no verifier field, deliberately: the only code
 * that may see either lives in the repository and in the hashing module, and a
 * view type without them is what keeps a verifier from being accidentally
 * serialized into an API response.
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
  disabled: boolean;
  disabledAt: string | null;
  passwordUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Worker {
  id: string;
  name: string;
  displayName: string;
  workerType: string;
  description: string | null;
  status: WorkerStatus;
  /** True for DISABLED and ARCHIVED alike — every refusal path reads this. */
  disabled: boolean;
  disabledAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdByType: ActorType;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an administrator may see about a credential.
 *
 * The prefix is here because it is how a person tells two credentials apart in
 * a list and how they recognise one in the audit. The verifier is not, and no
 * shape anywhere in the application carries it out of the repository.
 */
export interface WorkerCredentialSummary {
  id: string;
  workerId: string;
  prefix: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  issuedByType: ActorType;
  issuedById: string;
  rotatedFrom: string | null;
  /** Derived, so a caller never has to re-implement the three conditions. */
  active: boolean;
}

export interface ProjectMembership {
  id: string;
  projectId: string;
  principalType: PrincipalType;
  principalId: string;
  role: ProjectRole | null;
  scopes: WorkerScope[];
  grantedByType: ActorType;
  grantedById: string;
  grantedAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface IdentityEvent {
  id: string;
  createdAt: string;
  actorType: ActorType;
  actorId: string | null;
  credentialId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  projectId: string | null;
  result: IdentityResult;
  reason: DenialReason | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  userAgent: string | null;
  remoteAddr: string | null;
}

/**
 * Everything an authorization decision is allowed to consider.
 *
 * Assembled by the authentication step from server-held rows only. Nothing a
 * caller sent contributes to it — not a header naming a user, not a body field
 * naming a project, not an id in a path. That is what makes acting as somebody
 * else impossible rather than merely discouraged.
 */
export interface Principal {
  type: PrincipalType;
  id: string;
  /** For a person their email, for a worker its canonical name. */
  handle: string;
  displayName: string;
  /** Brain-wide administration. Always false for a worker. */
  isBrainAdmin: boolean;
  mustChangePassword: boolean;
  /** The session id or worker-credential id this request authenticated with. */
  credentialId: string;
  authMethod: AuthMethod;
  /** Live memberships only; a revoked one is not in here at all. */
  memberships: ProjectMembership[];
  /** Correlates every audit row written while serving this request. */
  requestId: string;
}

// ---------------------------------------------------------------------------
// THE DISTRIBUTED WORK QUEUE (Step 5)
//
// A work item is a unit of dispatchable work. A lease is one period of one
// worker owning it. Ownership is proven by a lease id and a fencing generation
// together — never by a worker saying which item it holds.
// ---------------------------------------------------------------------------

export const WORK_ITEM_STATES = ['QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** The states nothing may move out of. */
export const TERMINAL_WORK_STATES: readonly WorkItemState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export const LEASE_OUTCOMES = [
  'SUCCEEDED',
  'FAILED',
  /** The lease ran out before the worker finished, and the item was reclaimed. */
  'EXPIRED',
  'CANCELLED',
  /** The worker gave it back deliberately. */
  'RELEASED',
] as const;
export type LeaseOutcome = (typeof LEASE_OUTCOMES)[number];

/**
 * Why an attempt failed, as a closed set.
 *
 * A category rather than a message, because this is the field the planner and
 * the metrics read. The free-text detail is stored beside it, bounded and
 * sanitized, and nothing branches on it.
 */
export const WORK_FAILURE_CATEGORIES = [
  'WORKER_ERROR',
  'INVALID_INPUT',
  'DEPENDENCY_UNAVAILABLE',
  'TIMEOUT',
  'LEASE_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type WorkFailureCategory = (typeof WORK_FAILURE_CATEGORIES)[number];

export interface WorkItemRow {
  id: string;
  project_id: string;
  work_type: string;
  state: string;
  priority: number;
  available_at: string;
  payload: string;
  required_scopes: string;
  target_worker_id: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_generation: number;
  lease_id: string | null;
  worker_id: string | null;
  lease_credential_id: string | null;
  leased_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  result_ref: string | null;
  result_summary: string | null;
  failure_category: string | null;
  cancelled_reason: string | null;
  correlation_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WorkLeaseRow {
  id: string;
  work_item_id: string;
  project_id: string;
  attempt_number: number;
  lease_generation: number;
  worker_id: string;
  credential_id: string | null;
  claimed_at: string;
  expires_at: string;
  last_heartbeat_at: string | null;
  heartbeat_count: number;
  ended_at: string | null;
  outcome: string | null;
  detail: string | null;
  request_id: string | null;
}

export interface WorkItem {
  id: string;
  projectId: string;
  workType: string;
  state: WorkItemState;
  priority: number;
  availableAt: string;
  payload: Record<string, unknown>;
  requiredScopes: WorkerScope[];
  targetWorkerId: string | null;
  attemptCount: number;
  maxAttempts: number;
  /** The fencing token. Advances on every claim and every cancellation. */
  leaseGeneration: number;
  leaseId: string | null;
  workerId: string | null;
  leaseCredentialId: string | null;
  leasedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  resultRef: string | null;
  resultSummary: string | null;
  failureCategory: WorkFailureCategory | null;
  cancelledReason: string | null;
  correlationId: string | null;
  createdByType: ActorType;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkLease {
  id: string;
  workItemId: string;
  projectId: string;
  attemptNumber: number;
  leaseGeneration: number;
  workerId: string;
  credentialId: string | null;
  claimedAt: string;
  expiresAt: string;
  lastHeartbeatAt: string | null;
  heartbeatCount: number;
  endedAt: string | null;
  outcome: LeaseOutcome | null;
  detail: string | null;
  requestId: string | null;
}

/**
 * What a worker is handed when it wins a claim.
 *
 * The lease id and generation are in here because every subsequent operation
 * has to present them back. They are not secrets — they prove nothing on their
 * own, because the server also checks that the authenticated worker is the one
 * the lease was issued to.
 */
export interface ClaimedWork {
  workItemId: string;
  projectId: string;
  workType: string;
  payload: Record<string, unknown>;
  priority: number;
  attemptNumber: number;
  maxAttempts: number;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  correlationId: string | null;
}

/** Why an ownership-proving operation was refused. */
export const LEASE_REJECTIONS = [
  'NOT_FOUND',
  'NOT_LEASED',
  'NOT_THE_OWNER',
  'STALE_GENERATION',
  'LEASE_EXPIRED',
  'ALREADY_TERMINAL',
  'CANCELLED',
] as const;
export type LeaseRejection = (typeof LEASE_REJECTIONS)[number];

// ---------------------------------------------------------------------------
// IDEMPOTENCY AND EFFECT CONTROL (Step 6)
//
// Step 5's queue is at-least-once. These types are how an effect performed
// under it stops being repeatable. The guarantee is per effect class rather
// than universal, and `EffectClass` is what records which one was claimed.
// ---------------------------------------------------------------------------

export const OPERATION_STATES = ['RESERVED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_OPERATION_STATES: readonly OperationState[] = ['SUCCEEDED', 'FAILED'];

/**
 * What kind of guarantee an effect can honestly be given.
 *
 * These are not interchangeable, and flattening them into one "idempotent"
 * label is the misleading thing this enum exists to prevent.
 */
export const EFFECT_CLASSES = [
  /** Wholly inside the Brain's database. Commits exactly once, transactionally. */
  'SAME_DATABASE',
  /** Database plus the private object store. Digest-keyed, recoverable. */
  'DATABASE_AND_STORAGE',
  /** External, with native idempotency: one stable provider key across retries. */
  'EXTERNAL_IDEMPOTENT',
  /** External, no native key, but authoritative state can be queried. */
  'EXTERNAL_RECONCILABLE',
  /** External, neither. One attempt, then a person decides. */
  'EXTERNAL_OPAQUE',
] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export const EFFECT_PHASES = ['INTENT', 'SENT', 'CONFIRMED', 'FAILED', 'UNCERTAIN'] as const;
export type EffectPhase = (typeof EFFECT_PHASES)[number];

export const EFFECT_OUTCOMES = ['SUCCEEDED', 'FAILED', 'UNCERTAIN', 'ABANDONED'] as const;
export type EffectOutcome = (typeof EFFECT_OUTCOMES)[number];

/**
 * Why an operation is refused, as a closed set.
 *
 * `FINGERPRINT_CONFLICT` is the interesting one: the same key arriving with
 * materially different input. It is never executed and the previous payload is
 * never disclosed — the caller learns that the key is taken, and nothing else.
 */
export const OPERATION_REJECTIONS = [
  'FINGERPRINT_CONFLICT',
  'IN_PROGRESS',
  'NOT_THE_OWNER',
  'LEASE_LOST',
  'CANCELLED',
  'ALREADY_TERMINAL',
  'RECONCILIATION_REQUIRED',
] as const;
export type OperationRejection = (typeof OPERATION_REJECTIONS)[number];

/** Why an operation failed, or why its outcome is unknown. */
export const EFFECT_FAILURE_CATEGORIES = [
  'INVALID_INPUT',
  'NOT_AUTHORIZED',
  'DEPENDENCY_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'TIMEOUT',
  'INTERNAL_ERROR',
  'ABANDONED',
] as const;
export type EffectFailureCategory = (typeof EFFECT_FAILURE_CATEGORIES)[number];

/**
 * How long a record must outlive the effect it describes.
 *
 * `PERMANENT` is for effects whose identity must never expire while the same
 * effect could still be attempted somewhere — deleting one of those would make
 * a completed external effect silently repeatable, which is the exact failure
 * this table exists to prevent.
 */
export const RETENTION_CLASSES = ['STANDARD', 'EXTENDED', 'PERMANENT'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export interface IdempotencyOperationRow {
  id: string;
  scope_hash: string;
  key_fingerprint: string;
  namespace: string;
  namespace_version: number;
  project_id: string;
  created_by_type: string;
  created_by_id: string | null;
  correlation_id: string | null;
  work_item_id: string | null;
  lease_generation: number | null;
  request_fingerprint: string;
  fingerprint_version: number;
  state: string;
  attempt_count: number;
  failure_category: string | null;
  uncertainty_reason: string | null;
  recover_after: string | null;
  result_ref: string | null;
  result_status: number | null;
  result_summary: string | null;
  retention_class: string;
  reserved_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EffectAttemptRow {
  id: string;
  operation_id: string;
  attempt_number: number;
  executor_type: string;
  executor_id: string | null;
  work_item_id: string | null;
  lease_id: string | null;
  lease_generation: number | null;
  adapter: string | null;
  provider_key: string | null;
  phase: string;
  receipt_ref: string | null;
  receipt_meta: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  detail: string | null;
  request_id: string | null;
}

export interface IdempotencyOperation {
  id: string;
  scopeHash: string;
  keyFingerprint: string;
  namespace: string;
  namespaceVersion: number;
  projectId: string;
  createdByType: ActorType;
  createdById: string | null;
  correlationId: string | null;
  workItemId: string | null;
  leaseGeneration: number | null;
  requestFingerprint: string;
  fingerprintVersion: number;
  state: OperationState;
  attemptCount: number;
  failureCategory: EffectFailureCategory | null;
  uncertaintyReason: string | null;
  recoverAfter: string | null;
  resultRef: string | null;
  resultStatus: number | null;
  resultSummary: string | null;
  retentionClass: RetentionClass;
  reservedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectAttempt {
  id: string;
  operationId: string;
  attemptNumber: number;
  executorType: ActorType;
  executorId: string | null;
  workItemId: string | null;
  leaseId: string | null;
  leaseGeneration: number | null;
  adapter: string | null;
  providerKey: string | null;
  phase: EffectPhase;
  receiptRef: string | null;
  receiptMeta: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  outcome: EffectOutcome | null;
  detail: string | null;
  requestId: string | null;
}

/* ------------------------------------------------------------------------- */
/* OAuth (Step 8)                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The contract for connecting a worker through Claude's custom connector.
 *
 * Claude offers no way to send a static Authorization header, so the Step 7
 * bearer design cannot be used from it. OAuth is the only affordance, and it
 * turns out to be the better one: connecting a worker sends the operator to a
 * Brain-hosted screen where they authenticate as themselves and approve a named
 * worker, rather than carrying a long-lived secret into a configuration box.
 *
 * The invariant every type below exists to preserve: **a token resolves to the
 * worker, never to the human who approved it.**
 */

export const OAUTH_TOKEN_KINDS = ['ACCESS', 'REFRESH'] as const;
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

export interface OAuthClientRow {
  id: string;
  client_id: string;
  secret_digest: string | null;
  client_name: string;
  redirect_uris: string;
  token_auth_method: string;
  created_at: string;
  disabled_at: string | null;
}

export interface OAuthClient {
  id: string;
  clientId: string;
  /** True when the client registered a secret. The secret itself never leaves the database. */
  confidential: boolean;
  clientName: string;
  redirectUris: string[];
  tokenAuthMethod: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface OAuthAuthorizationCodeRow {
  id: string;
  code_digest: string;
  client_id: string;
  worker_id: string;
  approved_by_user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  scope: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
}

export interface OAuthAuthorizationCode {
  id: string;
  clientId: string;
  /** The identity the token will carry. Chosen by the human, never by the client. */
  workerId: string;
  /** Who approved it. For the audit only — this never becomes the principal. */
  approvedByUserId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  scope: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

export interface OAuthTokenRow {
  id: string;
  token_digest: string;
  token_prefix: string;
  kind: OAuthTokenKind;
  client_id: string;
  worker_id: string;
  scope: string;
  resource: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  parent_token_id: string | null;
}

export interface OAuthToken {
  id: string;
  kind: OAuthTokenKind;
  clientId: string;
  /** The principal. There is no user id here, deliberately. */
  workerId: string;
  scope: string;
  resource: string | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  parentTokenId: string | null;
}
