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
  'RESEARCH_CANCELLED',
  'RESEARCH_FAILED',
  'RESEARCH_COMPLETED',
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
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
  'NEEDS_HUMAN',
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

/** Does the evidence hold up? Separate from whether there is enough of it. */
export const INTEGRITY_VERDICTS = ['PASS', 'FAIL'] as const;
export type IntegrityVerdict = (typeof INTEGRITY_VERDICTS)[number];

/** Does it actually answer the fragment's question, to the declared coverage? */
export const SUFFICIENCY_VERDICTS = ['SUFFICIENT', 'INSUFFICIENT'] as const;
export type SufficiencyVerdict = (typeof SUFFICIENCY_VERDICTS)[number];

/** What later passes did to a claim. Silence is not agreement, so nothing defaults to SUPPORTED. */
export const CONTRADICTION_STATES = ['UNCHALLENGED', 'SUPPORTED', 'CONTESTED', 'REFUTED'] as const;
export type ContradictionState = (typeof CONTRADICTION_STATES)[number];

/** Structural verdict on a claim's source. Only SOURCED counts as evidence. */
export const CLAIM_VALIDATION_STATES = [
  'SOURCED',
  'NO_URL',
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'LOCAL_ADDRESS',
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
  created_at: string;
  updated_at: string;
}

export interface ResearchFragmentRow {
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
  createdAt: string;
  updatedAt: string;
}

/**
 * One bounded piece of an assignment, with the boundaries that make its answer
 * checkable and the bar it has to clear before any of it counts.
 */
export interface ResearchFragment {
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
