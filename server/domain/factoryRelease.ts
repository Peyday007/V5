/**
 * Automatic release of a Factory campaign: the owner's grant, each attempt, and
 * the one status a person reads about an approved objective.
 *
 * Kept beside `factory.ts` rather than inside it for that file's own reason: a
 * module several workers change at once is a module they collide in.
 */

export const RELEASE_POLICIES = ['AUTO_LOW_RISK'] as const;
export type ReleasePolicy = (typeof RELEASE_POLICIES)[number];

export const RELEASE_CHANNELS = ['BROWSER', 'SHELL'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const RELEASE_RUN_STATES = [
  'REFUSED',
  'GATING',
  'MERGED',
  'DEPLOYING',
  'VERIFYING',
  'LIVE',
  'FAILED',
  'ROLLED_BACK',
] as const;
export type ReleaseRunState = (typeof RELEASE_RUN_STATES)[number];

/** States a release is still moving through. At most one per campaign. */
export const RELEASE_IN_FLIGHT: readonly ReleaseRunState[] = ['GATING', 'MERGED', 'DEPLOYING', 'VERIFYING'];

/**
 * Where an attempt failed. `INFRA` and `DISPATCH` are facts about the runner or
 * the network rather than the change, so they are the only stages a later pass
 * may try again on the same head; everything else is a verdict about the work.
 */
export const RELEASE_FAILURE_STAGES = ['GATE', 'MERGE', 'DISPATCH', 'DEPLOY', 'VERIFY', 'INFRA'] as const;
export type ReleaseFailureStage = (typeof RELEASE_FAILURE_STAGES)[number];
export const RETRYABLE_FAILURE_STAGES: readonly ReleaseFailureStage[] = ['INFRA', 'DISPATCH'];
export const MAX_RELEASE_ATTEMPTS = 3;

/**
 * One thing that must be true of the released Brain before it is called LIVE.
 *
 * `HTTP` asks the running Brain a path and expects a status and, optionally,
 * text in the body. `BUNDLE_TEXT` asks whether the client bundle the Brain is
 * actually serving contains a string — which is what proves a UI change is the
 * one a browser receives, since the single-page app answers 200 to any path.
 * Every check is unauthenticated and read-only, by construction.
 */
export type LiveCheck =
  | { kind: 'HTTP'; path: string; expectStatus: number; expectText?: string }
  | { kind: 'BUNDLE_TEXT'; text: string };

export interface ReleaseGrant {
  id: string;
  changeRequestId: string;
  projectId: string;
  policy: ReleasePolicy;
  liveChecks: LiveCheck[];
  pagePath: string | null;
  grantedByUserId: string;
  authorityChannel: ReleaseChannel;
  executedByRef: string | null;
  reason: string;
  createdAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedReason: string | null;
}

export interface ReleaseGrantRow {
  id: string;
  change_request_id: string;
  project_id: string;
  policy: string;
  live_checks: string;
  page_path: string | null;
  granted_by_user_id: string;
  authority_channel: string;
  executed_by_ref: string | null;
  reason: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoked_reason: string | null;
}

export interface ReleaseRun {
  id: string;
  campaignId: string;
  changeRequestId: string;
  grantId: string;
  headSha: string;
  attempt: number;
  state: ReleaseRunState;
  refusal: string[];
  mergeSha: string | null;
  workflowRunId: string | null;
  deployRunId: string | null;
  failureStage: ReleaseFailureStage | null;
  failureDetail: string | null;
  verification: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ReleaseRunRow {
  id: string;
  campaign_id: string;
  change_request_id: string;
  grant_id: string;
  head_sha: string;
  attempt: number;
  state: string;
  refusal: string;
  merge_sha: string | null;
  workflow_run_id: string | null;
  deploy_run_id: string | null;
  failure_stage: string | null;
  failure_detail: string | null;
  verification: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** The one status a person reads about an approved objective. */
export const OBJECTIVE_STATUSES = ['BUILDING', 'VERIFYING', 'RELEASING', 'LIVE', 'BLOCKED', 'CANCELLED'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

export interface ObjectiveOutcome {
  status: ObjectiveStatus;
  /** One sentence about where it is, in words. */
  detail: string;
  /** Only for BLOCKED: the exact blocker. */
  blocker: string | null;
  /** True only when nothing will move until a person acts. */
  needsPerson: boolean;
  /** What that person does, when `needsPerson`. */
  personAction: string | null;
  prUrl: string | null;
  /** The Brain page the finished feature lives on, once it is LIVE. */
  pageUrl: string | null;
  release: {
    runId: string;
    state: ReleaseRunState;
    mergeSha: string | null;
    deployRunId: string | null;
    attempt: number;
  } | null;
  autoRelease: boolean;
}

/**
 * Paths an automatic release never carries, whatever the grant says.
 *
 * These are the change classes the owner reserved: new financial authority,
 * secrets and deployment configuration, identity and authorization policy,
 * schema changes (a destructive migration cannot be reviewed for destructiveness
 * by a glob, so every migration waits for a person), and dependency changes. A
 * campaign touching any of them finishes at a pull request exactly as before.
 */
export const RELEASE_EXCLUDED_PATHS: readonly string[] = [
  '.github/**',
  '.claude/**',
  'fly.toml',
  'Dockerfile',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'server/config.ts',
  'server/env.ts',
  'server/index.ts',
  'server/bootRetry.ts',
  'server/db/**',
  'server/services/identity/**',
  'server/routes/auth.ts',
  'server/routes/oauth.ts',
  'server/routes/guard.ts',
  'server/routes/passkeys.ts',
  'server/routes/admin.ts',
  'server/routes/access.ts',
  'server/mcp/endpoint.ts',
  'server/services/bins/routing.ts',
  'server/services/effects/**',
  'server/services/cash/authority.ts',
  'server/services/cash/discoveryAuthority.ts',
  'server/services/cash/providers/**',
  'server/services/cash/perform.ts',
  'server/services/cash/effects.ts',
  'server/repos/cashAuthority.ts',
  'server/repos/cashLedger.ts',
  'server/repos/factoryRelease.ts',
  'server/domain/factoryRelease.ts',
  'server/services/factory/release/**',
  'server/services/factory/repositoryEnvelope.ts',
  'server/services/factory/projectScope.ts',
  'server/services/factory/forbidden.ts',
  'server/services/research/approvalEnvelope.ts',
  'server/services/russell/probeEnvelope.ts',
  'server/services/russell/authority.ts',
  'scripts/factory.ts',
  'scripts/factory-release.ts',
  'scripts/release-scan.ts',
  'scripts/test-postgres.sh',
];

/** Patterns that look like a credential in an added line of a diff. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bre_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
  /\bFlyV1 [A-Za-z0-9_+/=,-]{20,}/,
  /\bbrn[wc]_[A-Za-z0-9_-]{16,}\b/,
];
