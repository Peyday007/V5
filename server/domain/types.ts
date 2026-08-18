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
] as const;
export type AuditFindingType = (typeof AUDIT_FINDING_TYPES)[number];

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
  'RUN_CREATED',
  'RUN_STARTED',
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_PROMPT_COMPILED',
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
