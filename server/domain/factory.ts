/**
 * The Software Factory's contract: what a change request is, what a work unit
 * is, and what the rows underneath them look like.
 *
 * Kept in its own file and re-exported from `types.ts` rather than appended to
 * it. The reason is the factory's own rule about ownership: a module several
 * workers may need to change at once is a module two of them will collide in,
 * and `types.ts` is already the widest file in the repository.
 *
 * Every `*Row` type here is the shape the database holds — booleans as 0/1,
 * JSON as text — and every view type is the shape everything above the
 * repository sees. The repository is the only place the two meet.
 */

/* ------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* ------------------------------------------------------------------------- */

export const FACTORY_CR_STATES = ['DRAFT', 'APPROVED', 'WITHDRAWN'] as const;
export type FactoryChangeRequestState = (typeof FACTORY_CR_STATES)[number];

export const FACTORY_ENVIRONMENTS = ['LOCAL', 'STAGING', 'PRODUCTION'] as const;
export type FactoryEnvironment = (typeof FACTORY_ENVIRONMENTS)[number];

export const FACTORY_RISK_CLASSES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type FactoryRiskClass = (typeof FACTORY_RISK_CLASSES)[number];

export const FACTORY_DEPLOYMENT_POLICIES = [
  'NONE',
  'STAGING_ONLY',
  'CONTROL_PLANE_AFTER_VERIFICATION',
] as const;
export type FactoryDeploymentPolicy = (typeof FACTORY_DEPLOYMENT_POLICIES)[number];

export const FACTORY_APPROVAL_ROUTES = ['PERSON', 'STANDING_AUTHORITY'] as const;
export type FactoryApprovalRoute = (typeof FACTORY_APPROVAL_ROUTES)[number];

export const FACTORY_CAMPAIGN_STATES = [
  'PLANNING',
  'EXECUTING',
  'INTEGRATING',
  'REVIEWING',
  'REPAIRING',
  'VERIFYING',
  'ASSEMBLING',
  'AWAITING_RELEASE',
  'COMPLETE',
  'BLOCKED',
  'CANCELLED',
] as const;
export type FactoryCampaignState = (typeof FACTORY_CAMPAIGN_STATES)[number];

/** A campaign that has stopped moving, and why, from a closed vocabulary. */
export const FACTORY_BLOCKER_KINDS = [
  'NO_HEALTHY_EXECUTION_SURFACE',
  'NO_ELIGIBLE_REVIEWER',
  'DEPENDENCY_CYCLE',
  'STALE_BASE',
  'UNIT_EXHAUSTED_ATTEMPTS',
  'CONTRADICTORY_CONTRACT',
  'AWAITING_HUMAN_RELEASE',
  'EXTERNAL_CREDENTIAL_REQUIRED',
] as const;
export type FactoryBlockerKind = (typeof FACTORY_BLOCKER_KINDS)[number];

export const FACTORY_UNIT_STATES = [
  'BLOCKED',
  'READY',
  'LEASED',
  'IMPLEMENTED',
  'INTEGRATED',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
] as const;
export type FactoryUnitState = (typeof FACTORY_UNIT_STATES)[number];

export const FACTORY_UNIT_KINDS = [
  'INTERFACE',
  'IMPLEMENTATION',
  'TEST',
  'MIGRATION',
  'REPAIR',
  'REVIEW',
  'INTEGRATION',
  'VERIFICATION',
  'DOCS',
] as const;
export type FactoryUnitKind = (typeof FACTORY_UNIT_KINDS)[number];

/**
 * A role is a job on one campaign, never a permanent agent.
 *
 * One worker may hold different roles across campaigns. What it may never do is
 * review its own implementation — and that is enforced from recorded execution
 * lineage rather than from the role label, because a label is something a
 * caller could choose.
 */
export const FACTORY_ROLES = [
  'ARCHITECT',
  'IMPLEMENTER',
  'REVIEWER',
  'INTEGRATOR',
  'VERIFIER',
] as const;
export type FactoryRole = (typeof FACTORY_ROLES)[number];

export const FACTORY_MODEL_CLASSES = ['STRONGEST', 'FAST'] as const;
export type FactoryModelClass = (typeof FACTORY_MODEL_CLASSES)[number];

export const FACTORY_WORKER_KINDS = ['LOCAL_CLI', 'COWORK_ROUTINE', 'REMOTE_SESSION'] as const;
export type FactoryWorkerKind = (typeof FACTORY_WORKER_KINDS)[number];

export const FACTORY_WORKER_AVAILABILITY = ['AVAILABLE', 'PAUSED', 'QUARANTINED'] as const;
export type FactoryWorkerAvailability = (typeof FACTORY_WORKER_AVAILABILITY)[number];

export const FACTORY_CAPABILITIES = [
  'ARCHITECT',
  'IMPLEMENT',
  'REVIEW',
  'INTEGRATE',
  'VERIFY',
] as const;
export type FactoryCapability = (typeof FACTORY_CAPABILITIES)[number];

export const FACTORY_SESSION_STATES = [
  'RUNNING',
  'FINISHED',
  'FAILED',
  'RATE_LIMITED',
  'ABANDONED',
] as const;
export type FactorySessionState = (typeof FACTORY_SESSION_STATES)[number];

export const FACTORY_REVIEW_VERDICTS = ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'] as const;
export type FactoryReviewVerdict = (typeof FACTORY_REVIEW_VERDICTS)[number];

/**
 * What separation a review actually achieved.
 *
 * §23's ladder, at this altitude. A same-worker result is never described as
 * worker-separated, and UNKNOWN is a real answer rather than an optimistic one.
 */
export const FACTORY_INDEPENDENCE_TIERS = [
  'UNKNOWN',
  'SESSION_SEPARATED',
  'WORKER_SEPARATED',
  'ACCOUNT_SEPARATED',
] as const;
export type FactoryIndependenceTier = (typeof FACTORY_INDEPENDENCE_TIERS)[number];

export const FACTORY_FINDING_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const;
export type FactoryFindingSeverity = (typeof FACTORY_FINDING_SEVERITIES)[number];

export const FACTORY_FINDING_STATES = [
  'OPEN',
  'REPAIR_QUEUED',
  'REPAIRED',
  'REJECTED',
  'ACCEPTED_LIMITATION',
] as const;
export type FactoryFindingState = (typeof FACTORY_FINDING_STATES)[number];

export const FACTORY_INTEGRATION_OUTCOMES = [
  'MERGED',
  'REJECTED',
  'CONFLICT',
  'DEFERRED',
  'VERIFICATION_FAILED',
] as const;
export type FactoryIntegrationOutcome = (typeof FACTORY_INTEGRATION_OUTCOMES)[number];

/**
 * Why a unit's attempt ended badly.
 *
 * `RATE_LIMITED` is deliberately absent: provider backpressure is not a
 * failure, it defers the unit and leaves its attempt count alone.
 */
export const FACTORY_FAILURE_CATEGORIES = [
  'NO_CHANGE_PRODUCED',
  'VERIFICATION_FAILED',
  'OUT_OF_SCOPE_MUTATION',
  'WORKER_ERROR',
  'WORKER_LOST',
  'CONTEXT_EXHAUSTED',
  'INTEGRATION_CONFLICT',
  'REPEATED_IDENTICAL_FAILURE',
] as const;
export type FactoryFailureCategory = (typeof FACTORY_FAILURE_CATEGORIES)[number];

export const FACTORY_EVIDENCE_CLASSES = [
  'MEASURED',
  'PROVIDER_ENFORCED',
  'DERIVED',
  'UNKNOWN',
] as const;
export type FactoryEvidenceClass = (typeof FACTORY_EVIDENCE_CLASSES)[number];

export const FACTORY_ARTIFACT_KINDS = [
  'WORKER_LOG',
  'PATCH',
  'TEST_OUTPUT',
  'BUILD_OUTPUT',
  'REVIEW_INPUT',
  'PR_BODY',
] as const;
export type FactoryArtifactKind = (typeof FACTORY_ARTIFACT_KINDS)[number];

export const FACTORY_RELEASE_KINDS = ['CONTROL_PLANE', 'PRODUCT_CHANGE'] as const;
export type FactoryReleaseKind = (typeof FACTORY_RELEASE_KINDS)[number];

export const FACTORY_RELEASE_DECISIONS = ['REQUESTED', 'APPROVED', 'REFUSED'] as const;
export type FactoryReleaseDecision = (typeof FACTORY_RELEASE_DECISIONS)[number];

/* ------------------------------------------------------------------------- */
/* The contract                                                               */
/* ------------------------------------------------------------------------- */

/**
 * One testable condition that decides whether the objective happened.
 *
 * `verification` is how a reader could check it — a command, a route, a
 * behaviour. A condition nobody could check is not an acceptance condition, and
 * the contract service refuses one.
 */
export interface FactoryAcceptanceCondition {
  id: string;
  statement: string;
  verification: string;
  /** Mandatory conditions gate completion. Optional ones are reported, not gating. */
  mandatory: boolean;
}

export interface FactoryChangeRequest {
  id: string;
  projectId: string;
  submissionKey: string;
  contractVersion: number;
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptanceConditions: FactoryAcceptanceCondition[];
  repository: string;
  /**
   * The checkout this campaign's work happens in, when it is not the default.
   *
   * `repository` is what the remote calls itself and is what belongs in a pull
   * request; this is a path on the machine a worker runs on. Null means the
   * factory's own default root, which is what every campaign before this column
   * existed was submitted against.
   */
  repositoryRoot: string | null;
  baseBranch: string;
  baseSha: string;
  environment: FactoryEnvironment;
  riskClass: FactoryRiskClass;
  mutationScope: string[];
  deploymentPolicy: FactoryDeploymentPolicy;
  externalSpendPolicy: 'PROHIBITED';
  rollbackRequirement: string;
  verificationCommands: string[];
  approvedByUserId: string | null;
  approvedVia: FactoryApprovalRoute | null;
  authorityId: string | null;
  approvedAt: string | null;
  state: FactoryChangeRequestState;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryChangeRequestRow {
  id: string;
  project_id: string;
  submission_key: string;
  contract_version: number;
  objective: string;
  expected_outcome: string;
  non_goals: string;
  acceptance_conditions: string;
  repository: string;
  repository_root: string | null;
  base_branch: string;
  base_sha: string;
  environment: string;
  risk_class: string;
  mutation_scope: string;
  deployment_policy: string;
  external_spend_policy: string;
  rollback_requirement: string;
  verification_commands: string;
  approved_by_user_id: string | null;
  approved_via: string | null;
  authority_id: string | null;
  approved_at: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface FactoryAmendment {
  id: string;
  changeRequestId: string;
  campaignId: string | null;
  field: string;
  oldValue: string;
  newValue: string;
  reason: string;
  actorType: 'PERSON' | 'FACTORY';
  actorId: string | null;
  affectedWork: string[];
  requiresReverification: boolean;
  fromContractVersion: number;
  toContractVersion: number;
  createdAt: string;
}

export interface FactoryAmendmentRow {
  id: string;
  change_request_id: string;
  campaign_id: string | null;
  field: string;
  old_value: string;
  new_value: string;
  reason: string;
  actor_type: string;
  actor_id: string | null;
  affected_work: string;
  requires_reverification: number;
  from_contract_version: number;
  to_contract_version: number;
  created_at: string;
}

/* ------------------------------------------------------------------------- */
/* The campaign                                                               */
/* ------------------------------------------------------------------------- */

export interface FactoryCampaign {
  id: string;
  changeRequestId: string;
  projectId: string;
  state: FactoryCampaignState;
  stageDetail: string | null;
  baseSha: string;
  integrationBranch: string;
  integrationSha: string | null;
  laneTarget: number;
  laneTargetReason: string;
  blockerKind: FactoryBlockerKind | null;
  blockerDetail: string | null;
  generation: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  reviewRounds: number;
  prRef: string | null;
  prUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryCampaignRow {
  id: string;
  change_request_id: string;
  project_id: string;
  state: string;
  stage_detail: string | null;
  base_sha: string;
  integration_branch: string;
  integration_sha: string | null;
  lane_target: number;
  lane_target_reason: string;
  blocker_kind: string | null;
  blocker_detail: string | null;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  review_rounds: number;
  pr_ref: string | null;
  pr_url: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------------- */
/* The work                                                                   */
/* ------------------------------------------------------------------------- */

export interface FactoryWorkUnit {
  id: string;
  campaignId: string;
  unitKey: string;
  kind: FactoryUnitKind;
  role: FactoryRole;
  title: string;
  objective: string;
  acceptance: string[];
  ownedPaths: string[];
  requiredContext: string[];
  verification: string[];
  expectedArtifact: string;
  risk: FactoryRiskClass;
  criticalPath: boolean;
  downstreamCount: number;
  priority: number;
  modelClass: FactoryModelClass;
  state: FactoryUnitState;
  attempt: number;
  maxAttempts: number;
  leaseGeneration: number;
  leaseId: string | null;
  leaseWorkerId: string | null;
  leaseSessionId: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  worktreePath: string | null;
  branch: string | null;
  headSha: string | null;
  baseSha: string | null;
  workerSummary: string | null;
  terminalResult: unknown;
  failureCategory: FactoryFailureCategory | null;
  failureDetail: string | null;
  notBefore: string | null;
  repairsFindingId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryWorkUnitRow {
  id: string;
  campaign_id: string;
  unit_key: string;
  kind: string;
  role: string;
  title: string;
  objective: string;
  acceptance: string;
  owned_paths: string;
  required_context: string;
  verification: string;
  expected_artifact: string;
  risk: string;
  critical_path: number;
  downstream_count: number;
  priority: number;
  model_class: string;
  state: string;
  attempt: number;
  max_attempts: number;
  lease_generation: number;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_session_id: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  worktree_path: string | null;
  branch: string | null;
  head_sha: string | null;
  base_sha: string | null;
  worker_summary: string | null;
  terminal_result: string | null;
  failure_category: string | null;
  failure_detail: string | null;
  not_before: string | null;
  repairs_finding_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactoryDependency {
  campaignId: string;
  unitId: string;
  dependsOnUnitId: string;
  reason: string;
  createdAt: string;
}

export interface FactoryCheckpoint {
  id: string;
  campaignId: string;
  unitId: string;
  attempt: number;
  sessionId: string | null;
  workerId: string | null;
  established: string;
  commits: string[];
  testsRun: string[];
  unresolved: string;
  nextAction: string;
  createdAt: string;
}

export interface FactoryCheckpointRow {
  id: string;
  campaign_id: string;
  unit_id: string;
  attempt: number;
  session_id: string | null;
  worker_id: string | null;
  established: string;
  commits: string;
  tests_run: string;
  unresolved: string;
  next_action: string;
  created_at: string;
}

/* ------------------------------------------------------------------------- */
/* The fleet                                                                  */
/* ------------------------------------------------------------------------- */

export interface FactoryWorker {
  id: string;
  name: string;
  kind: FactoryWorkerKind;
  accountRef: string;
  model: string;
  modelClass: FactoryModelClass | 'EITHER';
  capabilities: FactoryCapability[];
  repositories: string[];
  maxConcurrency: number;
  availability: FactoryWorkerAvailability;
  credentialRef: string | null;
  /** A digest taken once at registration. The value is never stored. */
  credentialDigest: string | null;
  brainWorkerId: string | null;
  rateLimitedUntil: string | null;
  consecutiveFailures: number;
  registeredByUserId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryWorkerRow {
  id: string;
  name: string;
  kind: string;
  account_ref: string;
  model: string;
  model_class: string;
  capabilities: string;
  repositories: string;
  max_concurrency: number;
  availability: string;
  credential_ref: string | null;
  credential_digest: string | null;
  brain_worker_id: string | null;
  rate_limited_until: string | null;
  consecutive_failures: number;
  registered_by_user_id: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactoryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface FactorySession {
  id: string;
  campaignId: string;
  unitId: string | null;
  workerId: string;
  accountRef: string;
  attempt: number;
  role: FactoryRole;
  externalSessionId: string | null;
  model: string;
  state: FactorySessionState;
  exitReason: string | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: FactoryUsage | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactorySessionRow {
  id: string;
  campaign_id: string;
  unit_id: string | null;
  worker_id: string;
  account_ref: string;
  attempt: number;
  role: string;
  external_session_id: string | null;
  model: string;
  state: string;
  exit_reason: string | null;
  duration_ms: number | null;
  num_turns: number | null;
  usage: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------------- */
/* Judgement                                                                  */
/* ------------------------------------------------------------------------- */

export interface FactoryReview {
  id: string;
  campaignId: string;
  round: number;
  scope: 'CAMPAIGN' | 'UNIT';
  unitId: string | null;
  reviewerSessionId: string | null;
  reviewedSha: string;
  verdict: FactoryReviewVerdict;
  summary: string;
  independence: FactoryIndependenceTier;
  createdAt: string;
}

export interface FactoryReviewRow {
  id: string;
  campaign_id: string;
  round: number;
  scope: string;
  unit_id: string | null;
  reviewer_session_id: string | null;
  reviewed_sha: string;
  verdict: string;
  summary: string;
  independence: string;
  created_at: string;
}

export interface FactoryFinding {
  id: string;
  reviewId: string;
  campaignId: string;
  findingKey: string;
  severity: FactoryFindingSeverity;
  category: string;
  statement: string;
  evidence: string;
  acceptanceConditionId: string | null;
  state: FactoryFindingState;
  repairUnitId: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryFindingRow {
  id: string;
  review_id: string;
  campaign_id: string;
  finding_key: string;
  severity: string;
  category: string;
  statement: string;
  evidence: string;
  acceptance_condition_id: string | null;
  state: string;
  repair_unit_id: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactoryVerificationResult {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Bounded, and never a credential. */
  tail: string;
}

export interface FactoryIntegration {
  id: string;
  campaignId: string;
  unitId: string;
  attempt: number;
  outcome: FactoryIntegrationOutcome;
  reason: string;
  rejectedPaths: string[];
  beforeSha: string;
  afterSha: string | null;
  verification: FactoryVerificationResult[];
  integratorSessionId: string | null;
  createdAt: string;
}

export interface FactoryIntegrationRow {
  id: string;
  campaign_id: string;
  unit_id: string;
  attempt: number;
  outcome: string;
  reason: string;
  rejected_paths: string;
  before_sha: string;
  after_sha: string | null;
  verification: string;
  integrator_session_id: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* ------------------------------------------------------------------------- */

export interface FactoryEvent {
  id: string;
  campaignId: string | null;
  unitId: string | null;
  workerId: string | null;
  sessionId: string | null;
  accountRef: string | null;
  kind: string;
  phase: string | null;
  durationMs: number | null;
  evidenceClass: FactoryEvidenceClass;
  detail: Record<string, unknown>;
  at: string;
}

export interface FactoryEventRow {
  id: string;
  campaign_id: string | null;
  unit_id: string | null;
  worker_id: string | null;
  session_id: string | null;
  account_ref: string | null;
  kind: string;
  phase: string | null;
  duration_ms: number | null;
  evidence_class: string;
  detail: string;
  at: string;
}

export interface FactoryArtifact {
  id: string;
  campaignId: string;
  unitId: string | null;
  sessionId: string | null;
  kind: FactoryArtifactKind;
  sha256: string;
  byteSize: number;
  storageKey: string | null;
  inlineText: string | null;
  createdAt: string;
}

export interface FactoryArtifactRow {
  id: string;
  campaign_id: string;
  unit_id: string | null;
  session_id: string | null;
  kind: string;
  sha256: string;
  byte_size: number;
  storage_key: string | null;
  inline_text: string | null;
  created_at: string;
}

export interface FactoryRelease {
  id: string;
  campaignId: string;
  kind: FactoryReleaseKind;
  decision: FactoryReleaseDecision;
  evidence: Record<string, unknown>;
  decidedByUserId: string | null;
  decidedReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryReleaseRow {
  id: string;
  campaign_id: string;
  kind: string;
  decision: string;
  evidence: string;
  decided_by_user_id: string | null;
  decided_reason: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}
