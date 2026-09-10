/**
 * The factory's own state: a contract, a campaign, and the units underneath it.
 *
 * This file is the factory's answer to the one question every orchestrator has
 * to answer safely: **who owns this work right now?** The answer is the answer
 * `repos/workQueue.ts` already gives, for the same reasons and with the same
 * primitive — a claim is a compare-and-swap on `lease_generation`, and every
 * later operation by the owner presents the generation it was given.
 *
 * Two things are new here, and both are about software rather than about
 * queueing:
 *
 *   * **A unit owns a mutation surface**, declared before it runs. Two units
 *     whose surfaces intersect are never leased at the same time, so two live
 *     workers cannot unknowingly edit the same files. The check is in the claim
 *     loop, ahead of the swap, which makes a refusal cost nothing: no attempt,
 *     no lease, no generation — indistinguishable from losing the race.
 *
 *   * **A dependency is satisfied by integration, not by implementation.** A
 *     unit becomes claimable when everything it depends on has landed on the
 *     campaign's integration branch, so a worker's worktree is always pinned to
 *     the campaign base or an explicitly recorded integration descendant of it.
 *
 * Nothing in this file decides whether a *person* may do any of it. That is
 * `services/identity/policy.ts`, applied at the routes, exactly as every other
 * project-scoped resource in Brain.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { fromBool, newId, nowIso, parseJson, toBool, toJson } from './util.ts';
import type {
  FactoryAcceptanceCondition,
  FactoryAmendment,
  FactoryAmendmentRow,
  FactoryCampaign,
  FactoryCampaignRow,
  FactoryCampaignState,
  FactoryChangeRequest,
  FactoryChangeRequestRow,
  FactoryCheckpoint,
  FactoryCheckpointRow,
  FactoryDependency,
  FactoryDeploymentPolicy,
  FactoryEnvironment,
  FactoryFailureCategory,
  FactoryModelClass,
  FactoryRiskClass,
  FactoryRole,
  FactoryUnitKind,
  FactoryUnitState,
  FactoryWorkUnit,
  FactoryWorkUnitRow,
} from '../domain/factory.ts';

/* ------------------------------------------------------------------------- */
/* Time and bounds                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The factory's clock.
 *
 * One function, for the same reason `queueNow()` is one function: lease
 * decisions are made on Brain's clock and never on a worker's, and an argument
 * about that has exactly one place to look.
 */
export function factoryNow(): string {
  return nowIso();
}

export function plusMs(from: string, ms: number): string {
  return new Date(new Date(from).getTime() + ms).toISOString();
}

/**
 * How long a unit's lease lasts by default.
 *
 * Long, because a coding worker's useful unit of work is minutes rather than
 * seconds, and a lease that expires under a working worker produces a takeover
 * that throws away real progress. Bounded, because a lease that never expires
 * is a unit nothing can recover.
 */
export const DEFAULT_UNIT_LEASE_MS = 30 * 60 * 1000;
export const MIN_UNIT_LEASE_MS = 30 * 1000;
export const MAX_UNIT_LEASE_MS = 4 * 60 * 60 * 1000;

export function clampUnitLeaseMs(ms: number | undefined): number {
  if (!ms || !Number.isFinite(ms)) return DEFAULT_UNIT_LEASE_MS;
  return Math.min(MAX_UNIT_LEASE_MS, Math.max(MIN_UNIT_LEASE_MS, Math.floor(ms)));
}

/**
 * A campaign tick's lease, and how often a live dispatcher renews it.
 *
 * Short *and* renewed, which the first version was neither. It was a flat ten
 * minutes with no renewal, and that is wrong in both directions at once: an
 * execution tick waits for its lanes and can run far longer than ten minutes, so
 * the lease expired under a working dispatcher and let a second one in to
 * dispatch beyond the lane target and race it into the integration branch — and
 * a dispatcher that *died* held its campaign for the full ten minutes, which is
 * five times longer than the unit leases it was holding.
 *
 * Two minutes, renewed every fifteen seconds while the tick is actually running,
 * makes both cases right: a live dispatcher keeps the tick for as long as it
 * works, and a dead one loses it in about two minutes.
 */
export const CAMPAIGN_TICK_LEASE_MS = 2 * 60 * 1000;
export const CAMPAIGN_TICK_HEARTBEAT_MS = 15 * 1000;

export const MAX_SUMMARY_CHARS = 4000;
export const MAX_DETAIL_CHARS = 4000;

export function bound(text: string | null | undefined, max = MAX_DETAIL_CHARS): string | null {
  if (text === null || text === undefined) return null;
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/* ------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* ------------------------------------------------------------------------- */

export function mapChangeRequest(row: FactoryChangeRequestRow): FactoryChangeRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    submissionKey: row.submission_key,
    contractVersion: row.contract_version,
    objective: row.objective,
    expectedOutcome: row.expected_outcome,
    nonGoals: parseJson<string[]>(row.non_goals, []),
    acceptanceConditions: parseJson<FactoryAcceptanceCondition[]>(row.acceptance_conditions, []),
    repository: row.repository,
    baseBranch: row.base_branch,
    baseSha: row.base_sha,
    environment: row.environment as FactoryEnvironment,
    riskClass: row.risk_class as FactoryRiskClass,
    mutationScope: parseJson<string[]>(row.mutation_scope, []),
    deploymentPolicy: row.deployment_policy as FactoryDeploymentPolicy,
    externalSpendPolicy: 'PROHIBITED',
    rollbackRequirement: row.rollback_requirement,
    verificationCommands: parseJson<string[]>(row.verification_commands, []),
    approvedByUserId: row.approved_by_user_id,
    approvedVia: row.approved_via as FactoryChangeRequest['approvedVia'],
    authorityId: row.authority_id,
    approvedAt: row.approved_at,
    state: row.state as FactoryChangeRequest['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCampaign(row: FactoryCampaignRow): FactoryCampaign {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    projectId: row.project_id,
    state: row.state as FactoryCampaignState,
    stageDetail: row.stage_detail,
    baseSha: row.base_sha,
    integrationBranch: row.integration_branch,
    integrationSha: row.integration_sha,
    laneTarget: row.lane_target,
    laneTargetReason: row.lane_target_reason,
    blockerKind: row.blocker_kind as FactoryCampaign['blockerKind'],
    blockerDetail: row.blocker_detail,
    generation: row.generation,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    reviewRounds: row.review_rounds,
    prRef: row.pr_ref,
    prUrl: row.pr_url,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapWorkUnit(row: FactoryWorkUnitRow): FactoryWorkUnit {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitKey: row.unit_key,
    kind: row.kind as FactoryUnitKind,
    role: row.role as FactoryRole,
    title: row.title,
    objective: row.objective,
    acceptance: parseJson<string[]>(row.acceptance, []),
    ownedPaths: parseJson<string[]>(row.owned_paths, []),
    requiredContext: parseJson<string[]>(row.required_context, []),
    verification: parseJson<string[]>(row.verification, []),
    expectedArtifact: row.expected_artifact,
    risk: row.risk as FactoryRiskClass,
    criticalPath: toBool(row.critical_path),
    downstreamCount: row.downstream_count,
    priority: row.priority,
    modelClass: row.model_class as FactoryModelClass,
    state: row.state as FactoryUnitState,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseGeneration: row.lease_generation,
    leaseId: row.lease_id,
    leaseWorkerId: row.lease_worker_id,
    leaseSessionId: row.lease_session_id,
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    worktreePath: row.worktree_path,
    branch: row.branch,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    workerSummary: row.worker_summary,
    terminalResult: parseJson<unknown>(row.terminal_result, null),
    failureCategory: row.failure_category as FactoryFailureCategory | null,
    failureDetail: row.failure_detail,
    notBefore: row.not_before,
    repairsFindingId: row.repairs_finding_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCheckpoint(row: FactoryCheckpointRow): FactoryCheckpoint {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    unitId: row.unit_id,
    attempt: row.attempt,
    sessionId: row.session_id,
    workerId: row.worker_id,
    established: row.established,
    commits: parseJson<string[]>(row.commits, []),
    testsRun: parseJson<string[]>(row.tests_run, []),
    unresolved: row.unresolved,
    nextAction: row.next_action,
    createdAt: row.created_at,
  };
}

export function mapAmendment(row: FactoryAmendmentRow): FactoryAmendment {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    campaignId: row.campaign_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    reason: row.reason,
    actorType: row.actor_type as 'PERSON' | 'FACTORY',
    actorId: row.actor_id,
    affectedWork: parseJson<string[]>(row.affected_work, []),
    requiresReverification: toBool(row.requires_reverification),
    fromContractVersion: row.from_contract_version,
    toContractVersion: row.to_contract_version,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------------- */
/* Change requests                                                            */
/* ------------------------------------------------------------------------- */

export interface CreateChangeRequestInput {
  projectId: string;
  submissionKey: string;
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptanceConditions: FactoryAcceptanceCondition[];
  repository: string;
  baseBranch: string;
  baseSha: string;
  environment: FactoryEnvironment;
  riskClass: FactoryRiskClass;
  mutationScope: string[];
  deploymentPolicy: FactoryDeploymentPolicy;
  rollbackRequirement: string;
  verificationCommands: string[];
}

/**
 * Create the change request, or hand back the one that already exists.
 *
 * The INSERT is `ON CONFLICT DO NOTHING` against the submission key, so two
 * concurrent submissions of the same ask produce one row and both callers see
 * it. That is the same arbitration Step 6 uses for an effect: the database
 * decides, never a process-local check-then-insert.
 */
export async function ensureChangeRequest(
  input: CreateChangeRequestInput,
): Promise<{ changeRequest: FactoryChangeRequest; created: boolean }> {
  const db = getDb();
  const at = factoryNow();
  const id = newId('fcr');

  const result = await db.run(
    `INSERT INTO factory_change_requests (
       id, project_id, submission_key, contract_version, objective, expected_outcome,
       non_goals, acceptance_conditions, repository, base_branch, base_sha, environment,
       risk_class, mutation_scope, deployment_policy, external_spend_policy,
       rollback_requirement, verification_commands, approved_by_user_id, approved_via,
       authority_id, approved_at, state, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROHIBITED', ?, ?,
             NULL, NULL, NULL, NULL, 'DRAFT', ?, ?)
     ON CONFLICT (project_id, submission_key) DO NOTHING`,
    [
      id,
      input.projectId,
      input.submissionKey,
      input.objective,
      input.expectedOutcome,
      toJson(input.nonGoals),
      toJson(input.acceptanceConditions),
      input.repository,
      input.baseBranch,
      input.baseSha,
      input.environment,
      input.riskClass,
      toJson(input.mutationScope),
      input.deploymentPolicy,
      input.rollbackRequirement,
      toJson(input.verificationCommands),
      at,
      at,
    ],
  );

  const row = await db.get<FactoryChangeRequestRow>(
    `SELECT * FROM factory_change_requests WHERE project_id = ? AND submission_key = ?`,
    [input.projectId, input.submissionKey],
  );
  if (!row) throw new Error('factory: change request vanished immediately after insert');
  return { changeRequest: mapChangeRequest(row), created: result.changes === 1 };
}

export async function getChangeRequest(id: string): Promise<FactoryChangeRequest | null> {
  const row = await getDb().get<FactoryChangeRequestRow>(
    `SELECT * FROM factory_change_requests WHERE id = ?`,
    [id],
  );
  return row ? mapChangeRequest(row) : null;
}

export async function listChangeRequests(projectId: string): Promise<FactoryChangeRequest[]> {
  const rows = await getDb().all<FactoryChangeRequestRow>(
    `SELECT * FROM factory_change_requests WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
    [projectId],
  );
  return rows.map(mapChangeRequest);
}

export interface ApproveInput {
  changeRequestId: string;
  via: 'PERSON' | 'STANDING_AUTHORITY';
  userId: string | null;
  authorityId: string | null;
}

/**
 * Approve the objective — the first of the two actions a person performs.
 *
 * Guarded on `state = 'DRAFT'` so a second approval changes nothing and says
 * so, rather than re-stamping an approval time over a campaign already running.
 */
export async function approveChangeRequest(input: ApproveInput): Promise<boolean> {
  const at = factoryNow();
  const result = await getDb().run(
    `UPDATE factory_change_requests
        SET state = 'APPROVED', approved_via = ?, approved_by_user_id = ?,
            authority_id = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND state = 'DRAFT'`,
    [input.via, input.userId, input.authorityId, at, at, input.changeRequestId],
  );
  return result.changes === 1;
}

/**
 * Record an amendment to an approved contract and advance its version.
 *
 * Both values, the reason, the actor, the affected units and whether
 * re-verification is required, in one append-only row. Whether a *particular*
 * field may be amended at all is a service decision — `services/factory/
 * contract.ts` — because it is a rule about what success means rather than a
 * rule about rows.
 */
export interface AmendInput {
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
  /** The column to write, when the amendment changes a stored field. */
  column?: string;
  columnValue?: SqlParam;
}

export async function recordAmendment(input: AmendInput): Promise<FactoryAmendment> {
  const db = getDb();
  return await db.transaction(async () => {
    const current = await db.get<{ contract_version: number }>(
      `SELECT contract_version FROM factory_change_requests WHERE id = ?`,
      [input.changeRequestId],
    );
    if (!current) throw new Error('factory: amendment for an unknown change request');
    const from = current.contract_version;
    const to = from + 1;
    const at = factoryNow();
    const id = newId('fam');

    await db.run(
      `INSERT INTO factory_contract_amendments (
         id, change_request_id, campaign_id, field, old_value, new_value, reason,
         actor_type, actor_id, affected_work, requires_reverification,
         from_contract_version, to_contract_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.changeRequestId,
        input.campaignId,
        input.field,
        input.oldValue,
        input.newValue,
        input.reason,
        input.actorType,
        input.actorId,
        toJson(input.affectedWork),
        fromBool(input.requiresReverification),
        from,
        to,
        at,
      ],
    );

    if (input.column) {
      await db.run(
        `UPDATE factory_change_requests
            SET ${input.column} = ?, contract_version = ?, updated_at = ?
          WHERE id = ?`,
        [input.columnValue ?? null, to, at, input.changeRequestId],
      );
    } else {
      await db.run(
        `UPDATE factory_change_requests SET contract_version = ?, updated_at = ? WHERE id = ?`,
        [to, at, input.changeRequestId],
      );
    }

    const row = await db.get<FactoryAmendmentRow>(
      `SELECT * FROM factory_contract_amendments WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error('factory: amendment vanished immediately after insert');
    return mapAmendment(row);
  });
}

export async function listAmendments(changeRequestId: string): Promise<FactoryAmendment[]> {
  const rows = await getDb().all<FactoryAmendmentRow>(
    `SELECT * FROM factory_contract_amendments
      WHERE change_request_id = ? ORDER BY created_at, rowid`,
    [changeRequestId],
  );
  return rows.map(mapAmendment);
}

/* ------------------------------------------------------------------------- */
/* Campaigns                                                                  */
/* ------------------------------------------------------------------------- */

export interface EnsureCampaignInput {
  changeRequestId: string;
  projectId: string;
  baseSha: string;
  laneTarget: number;
  laneTargetReason: string;
}

/**
 * A campaign's integration branch, from the campaign's own id.
 *
 * Derived here rather than chosen by a caller, because a caller chose one and it
 * collided: the first version truncated the submission key to twelve characters,
 * so `factory-recovery-drill` and `factory-recovery-drill-2` both became
 * `factory/campaign/factory-reco` — and the second campaign's first tick failed
 * with git refusing to check out a branch another worktree already held. A name
 * that can collide is a name that will, and the id cannot.
 */
export function integrationBranchFor(campaignId: string): string {
  return `factory/campaign/${campaignId}`;
}

/**
 * One campaign per change request, decided by the database.
 *
 * `ON CONFLICT (change_request_id) DO NOTHING` is the whole of acceptance
 * condition 2: a duplicate submission, a retried request or a redelivered tick
 * all collide with the row that exists, and every caller is handed it.
 */
export async function ensureCampaign(
  input: EnsureCampaignInput,
): Promise<{ campaign: FactoryCampaign; created: boolean }> {
  const db = getDb();
  const at = factoryNow();
  const id = newId('fcp');

  const result = await db.run(
    `INSERT INTO factory_campaigns (
       id, change_request_id, project_id, state, stage_detail, base_sha,
       integration_branch, integration_sha, lane_target, lane_target_reason,
       blocker_kind, blocker_detail, generation, lease_owner, lease_expires_at,
       review_rounds, pr_ref, pr_url, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, 'PLANNING', NULL, ?, ?, NULL, ?, ?, NULL, NULL, 0, NULL, NULL,
             0, NULL, NULL, ?, NULL, ?, ?)
     ON CONFLICT (change_request_id) DO NOTHING`,
    [
      id,
      input.changeRequestId,
      input.projectId,
      input.baseSha,
      integrationBranchFor(id),
      input.laneTarget,
      input.laneTargetReason,
      at,
      at,
      at,
    ],
  );

  const row = await db.get<FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns WHERE change_request_id = ?`,
    [input.changeRequestId],
  );
  if (!row) throw new Error('factory: campaign vanished immediately after insert');
  return { campaign: mapCampaign(row), created: result.changes === 1 };
}

export async function getCampaign(id: string): Promise<FactoryCampaign | null> {
  const row = await getDb().get<FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns WHERE id = ?`,
    [id],
  );
  return row ? mapCampaign(row) : null;
}

export async function getCampaignByChangeRequest(
  changeRequestId: string,
): Promise<FactoryCampaign | null> {
  const row = await getDb().get<FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns WHERE change_request_id = ?`,
    [changeRequestId],
  );
  return row ? mapCampaign(row) : null;
}

export async function listCampaigns(projectId: string): Promise<FactoryCampaign[]> {
  const rows = await getDb().all<FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
    [projectId],
  );
  return rows.map(mapCampaign);
}

/** Campaigns a tick should look at: anything not finished. */
export async function listLiveCampaigns(): Promise<FactoryCampaign[]> {
  const rows = await getDb().all<FactoryCampaignRow>(
    `SELECT * FROM factory_campaigns
      WHERE state NOT IN ('COMPLETE','CANCELLED')
      ORDER BY created_at, rowid`,
  );
  return rows.map(mapCampaign);
}

export interface CampaignPatch {
  state?: FactoryCampaignState;
  stageDetail?: string | null;
  integrationSha?: string | null;
  laneTarget?: number;
  laneTargetReason?: string;
  blockerKind?: FactoryCampaign['blockerKind'];
  blockerDetail?: string | null;
  reviewRounds?: number;
  prRef?: string | null;
  prUrl?: string | null;
  finishedAt?: string | null;
}

const CAMPAIGN_COLUMNS: Record<keyof CampaignPatch, string> = {
  state: 'state',
  stageDetail: 'stage_detail',
  integrationSha: 'integration_sha',
  laneTarget: 'lane_target',
  laneTargetReason: 'lane_target_reason',
  blockerKind: 'blocker_kind',
  blockerDetail: 'blocker_detail',
  reviewRounds: 'review_rounds',
  prRef: 'pr_ref',
  prUrl: 'pr_url',
  finishedAt: 'finished_at',
};

export async function patchCampaign(id: string, patch: CampaignPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${CAMPAIGN_COLUMNS[k as keyof CampaignPatch]} = ?`);
  const values = entries.map(([, v]) => v as SqlParam);
  await getDb().run(
    `UPDATE factory_campaigns SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    [...values, factoryNow(), id],
  );
}

/**
 * Take the campaign's tick, or lose.
 *
 * The same compare-and-swap the units use, one level up. Two dispatchers both
 * reading generation 7 cannot both advance a campaign: exactly one swap
 * matches, and the loser is refused rather than retried. An expired tick lease
 * is claimable, so a dispatcher that died mid-tick strands nothing.
 */
export async function claimCampaignTick(
  campaignId: string,
  owner: string,
  leaseMs = CAMPAIGN_TICK_LEASE_MS,
): Promise<{ ok: true; generation: number } | { ok: false; reason: string }> {
  const db = getDb();
  const row = await db.get<FactoryCampaignRow>(`SELECT * FROM factory_campaigns WHERE id = ?`, [
    campaignId,
  ]);
  if (!row) return { ok: false, reason: 'no such campaign' };
  const at = factoryNow();
  const result = await db.run(
    `UPDATE factory_campaigns
        SET generation = generation + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND generation = ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
    [owner, plusMs(at, leaseMs), at, campaignId, row.generation, at],
  );
  if (result.changes !== 1) return { ok: false, reason: 'another dispatcher holds the tick' };
  return { ok: true, generation: row.generation + 1 };
}

/**
 * Push the tick lease out while the tick is still running.
 *
 * Guarded on the owner and the generation it was given, so a dispatcher that has
 * already lost the tick cannot extend somebody else's. Returns false when the
 * tick is no longer this dispatcher's — which is the signal that its work is now
 * somebody else's problem.
 */
export async function extendCampaignTick(
  campaignId: string,
  owner: string,
  generation: number,
  leaseMs = CAMPAIGN_TICK_LEASE_MS,
): Promise<boolean> {
  const at = factoryNow();
  const result = await getDb().run(
    `UPDATE factory_campaigns
        SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ?`,
    [plusMs(at, leaseMs), at, campaignId, generation, owner],
  );
  return result.changes === 1;
}

/** Hand the tick back. Guarded, so a lost dispatcher cannot release the new owner's. */
export async function releaseCampaignTick(
  campaignId: string,
  owner: string,
  generation: number,
): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_campaigns
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ?`,
    [factoryNow(), campaignId, generation, owner],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Work units                                                                 */
/* ------------------------------------------------------------------------- */

export interface CreateUnitInput {
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
  risk?: FactoryRiskClass;
  criticalPath?: boolean;
  priority?: number;
  modelClass?: FactoryModelClass;
  maxAttempts?: number;
  repairsFindingId?: string | null;
  /** Unit keys inside the same campaign. Resolved to ids here. */
  dependsOn?: string[];
  state?: FactoryUnitState;
}

/**
 * Create a unit, or hand back the one whose key already exists.
 *
 * Idempotent by `(campaign_id, unit_key)`, which is what makes a re-planned
 * campaign, a redelivered tick and a repair loop that re-derives the same
 * repair all converge on one row instead of forking the work.
 */
export async function ensureUnit(
  input: CreateUnitInput,
): Promise<{ unit: FactoryWorkUnit; created: boolean }> {
  const db = getDb();
  const at = factoryNow();
  const id = newId('fwu');

  const result = await db.run(
    `INSERT INTO factory_work_units (
       id, campaign_id, unit_key, kind, role, title, objective, acceptance,
       owned_paths, required_context, verification, expected_artifact, risk,
       critical_path, downstream_count, priority, model_class, state, attempt,
       max_attempts, lease_generation, repairs_finding_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 0, ?, ?, ?)
     ON CONFLICT (campaign_id, unit_key) DO NOTHING`,
    [
      id,
      input.campaignId,
      input.unitKey,
      input.kind,
      input.role,
      input.title,
      input.objective,
      toJson(input.acceptance),
      toJson(input.ownedPaths),
      toJson(input.requiredContext),
      toJson(input.verification),
      input.expectedArtifact,
      input.risk ?? 'MEDIUM',
      fromBool(input.criticalPath),
      input.priority ?? 5,
      input.modelClass ?? 'FAST',
      input.state ?? 'BLOCKED',
      input.maxAttempts ?? 3,
      input.repairsFindingId ?? null,
      at,
      at,
    ],
  );

  const row = await db.get<FactoryWorkUnitRow>(
    `SELECT * FROM factory_work_units WHERE campaign_id = ? AND unit_key = ?`,
    [input.campaignId, input.unitKey],
  );
  if (!row) throw new Error('factory: work unit vanished immediately after insert');
  return { unit: mapWorkUnit(row), created: result.changes === 1 };
}

export async function addDependency(
  campaignId: string,
  unitId: string,
  dependsOnUnitId: string,
  reason = '',
): Promise<void> {
  if (unitId === dependsOnUnitId) {
    throw new Error('factory: a unit cannot depend on itself');
  }
  await getDb().run(
    `INSERT INTO factory_unit_dependencies (campaign_id, unit_id, depends_on_unit_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (unit_id, depends_on_unit_id) DO NOTHING`,
    [campaignId, unitId, dependsOnUnitId, reason, factoryNow()],
  );
}

export async function listDependencies(campaignId: string): Promise<FactoryDependency[]> {
  const rows = await getDb().all<{
    campaign_id: string;
    unit_id: string;
    depends_on_unit_id: string;
    reason: string;
    created_at: string;
  }>(`SELECT * FROM factory_unit_dependencies WHERE campaign_id = ?`, [campaignId]);
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    unitId: r.unit_id,
    dependsOnUnitId: r.depends_on_unit_id,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

/**
 * How many units depend on this one, transitively — the number the scheduler
 * prioritises by, because an interface several lanes are waiting on is worth
 * more than a leaf however urgent the leaf looks.
 */
export async function refreshDownstreamCounts(campaignId: string): Promise<void> {
  const db = getDb();
  const units = await listUnits(campaignId);
  const deps = await listDependencies(campaignId);
  const dependents = new Map<string, string[]>();
  for (const edge of deps) {
    const list = dependents.get(edge.dependsOnUnitId) ?? [];
    list.push(edge.unitId);
    dependents.set(edge.dependsOnUnitId, list);
  }

  for (const unit of units) {
    const seen = new Set<string>();
    const stack = [...(dependents.get(unit.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      stack.push(...(dependents.get(next) ?? []));
    }
    if (seen.size !== unit.downstreamCount) {
      await db.run(
        `UPDATE factory_work_units SET downstream_count = ?, updated_at = ? WHERE id = ?`,
        [seen.size, factoryNow(), unit.id],
      );
    }
  }
}

export async function getUnit(id: string): Promise<FactoryWorkUnit | null> {
  const row = await getDb().get<FactoryWorkUnitRow>(
    `SELECT * FROM factory_work_units WHERE id = ?`,
    [id],
  );
  return row ? mapWorkUnit(row) : null;
}

export async function getUnitByKey(
  campaignId: string,
  unitKey: string,
): Promise<FactoryWorkUnit | null> {
  const row = await getDb().get<FactoryWorkUnitRow>(
    `SELECT * FROM factory_work_units WHERE campaign_id = ? AND unit_key = ?`,
    [campaignId, unitKey],
  );
  return row ? mapWorkUnit(row) : null;
}

export async function listUnits(campaignId: string): Promise<FactoryWorkUnit[]> {
  const rows = await getDb().all<FactoryWorkUnitRow>(
    `SELECT * FROM factory_work_units WHERE campaign_id = ? ORDER BY priority DESC, created_at, rowid`,
    [campaignId],
  );
  return rows.map(mapWorkUnit);
}

/**
 * Promote units whose dependencies have all landed.
 *
 * A dependency is satisfied by **integration**, not by implementation: a unit
 * starts from the campaign base or an integration descendant of it, never from
 * a sibling's unmerged branch. Uncommitted or unintegrated work is not a
 * channel between workers.
 *
 * Returns the units it promoted, so the caller can record why each one moved.
 */
export async function promoteReadyUnits(campaignId: string): Promise<FactoryWorkUnit[]> {
  const db = getDb();
  const units = await listUnits(campaignId);
  const byId = new Map(units.map((u) => [u.id, u]));
  const deps = await listDependencies(campaignId);
  const blockers = new Map<string, string[]>();
  for (const edge of deps) {
    const list = blockers.get(edge.unitId) ?? [];
    list.push(edge.dependsOnUnitId);
    blockers.set(edge.unitId, list);
  }

  const promoted: FactoryWorkUnit[] = [];
  for (const unit of units) {
    if (unit.state !== 'BLOCKED') continue;
    const required = blockers.get(unit.id) ?? [];
    const satisfied = required.every((id) => byId.get(id)?.state === 'INTEGRATED');
    if (!satisfied) continue;
    const result = await db.run(
      `UPDATE factory_work_units SET state = 'READY', updated_at = ? WHERE id = ? AND state = 'BLOCKED'`,
      [factoryNow(), unit.id],
    );
    if (result.changes === 1) promoted.push({ ...unit, state: 'READY' });
  }
  return promoted;
}

/**
 * Which units can never run, because the graph they are in has a cycle.
 *
 * A cycle is a planning defect and the honest answer to it is to say so and
 * stop: a scheduler that kept ticking would report "waiting on dependencies"
 * forever, which is the state §24 calls stuck rather than waiting.
 */
export async function findDependencyCycle(campaignId: string): Promise<string[] | null> {
  const units = await listUnits(campaignId);
  const deps = await listDependencies(campaignId);
  const out = new Map<string, string[]>();
  for (const edge of deps) {
    const list = out.get(edge.unitId) ?? [];
    list.push(edge.dependsOnUnitId);
    out.set(edge.unitId, list);
  }

  const state = new Map<string, 'VISITING' | 'DONE'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const mark = state.get(id);
    if (mark === 'DONE') return null;
    if (mark === 'VISITING') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'VISITING');
    stack.push(id);
    for (const next of out.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'DONE');
    return null;
  };

  for (const unit of units) {
    const cycle = visit(unit.id);
    if (cycle) return cycle;
  }
  return null;
}

/* ------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Do these two mutation surfaces overlap?
 *
 * Globs are compared as prefixes after the first wildcard, which is coarse on
 * purpose: the question is "could two workers touch the same file", and the
 * expensive mistake is answering no when the truthful answer is "possibly".
 * `server/services/factory/**` and `server/services/factory/loop.ts` overlap;
 * `server/services/factory/loop.ts` and `server/repos/factory.ts` do not.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  const stems = (globs: string[]): string[] =>
    globs.map((glob) => {
      const star = glob.indexOf('*');
      return star === -1 ? glob : glob.slice(0, star);
    });
  const left = stems(a);
  const right = stems(b);
  return left.some((l) => right.some((r) => l.startsWith(r) || r.startsWith(l)));
}

export interface UnitClaimInput {
  campaignId: string;
  workerId: string;
  sessionId?: string | null;
  /** What this worker is able to do. A unit whose role it cannot hold is skipped. */
  roles?: FactoryRole[];
  /**
   * Narrow the claim to units the caller already decided about.
   *
   * The scheduler chose a pairing; this is how the claim is attempted for *that*
   * unit rather than for whatever happens to sort first. It is a filter over rows
   * the caller could already see, so naming a unit is not a way to reach one.
   */
  unitIds?: string[];
  limit?: number;
  leaseMs?: number;
  /**
   * The caller's extra eligibility question, asked *before* the swap.
   *
   * Injected so this repository keeps knowing nothing about reviewer
   * independence or provider health, and asked early so a refusal costs the
   * unit nothing: no attempt, no lease, no generation. A guard applied after
   * the claim would spend one of a unit's attempts every time an ineligible
   * worker glanced at it — §23's own correction, at a new altitude.
   */
  admit?: (unit: FactoryWorkUnitRow) => Promise<{ ok: boolean; reason?: string }>;
  onSkip?: (unit: FactoryWorkUnitRow, reason: string) => void;
}

export interface ClaimedUnit {
  unit: FactoryWorkUnit;
  leaseId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  attempt: number;
  /** Set when a previous owner's lease had expired and this claim took it over. */
  takeoverFrom: string | null;
}

/**
 * Take up to `limit` claimable units in this campaign.
 *
 * Claimable means: READY, or LEASED with an expired lease — because an expired
 * lease is claimable work, and that is what makes recovery independent of any
 * process staying alive. A deferred unit (`not_before` in the future) is not
 * claimable and is not a failure; provider backpressure defers rather than
 * fails, so its attempt count is untouched.
 */
export async function claimUnits(input: UnitClaimInput): Promise<ClaimedUnit[]> {
  const db = getDb();
  const limit = Math.max(1, Math.min(25, input.limit ?? 1));
  const leaseMs = clampUnitLeaseMs(input.leaseMs);
  const claimed: ClaimedUnit[] = [];

  for (let round = 0; round < 3 && claimed.length < limit; round += 1) {
    const now = factoryNow();
    const params: SqlParam[] = [input.campaignId, now, now, now];
    let roleClause = '';
    if (input.roles && input.roles.length > 0) {
      roleClause = ` AND role IN (${input.roles.map(() => '?').join(', ')})`;
      params.push(...input.roles);
    }
    if (input.unitIds && input.unitIds.length > 0) {
      roleClause += ` AND id IN (${input.unitIds.map(() => '?').join(', ')})`;
      params.push(...input.unitIds);
    }

    const candidates = await db.all<FactoryWorkUnitRow>(
      `SELECT * FROM factory_work_units
        WHERE campaign_id = ?
          AND (not_before IS NULL OR not_before <= ?)
          AND ( state = 'READY'
             OR (state = 'LEASED' AND lease_expires_at <= ?) )
          AND attempt < max_attempts
          AND (lease_worker_id IS NULL OR lease_expires_at <= ?)${roleClause}
        ORDER BY critical_path DESC, downstream_count DESC, priority DESC, created_at, rowid
        LIMIT 50`,
      params,
    );
    if (candidates.length === 0) break;

    // Every surface a live lease already owns. Read once per round, because a
    // claim inside this loop adds to it and the next candidate must see that.
    const busy = await db.all<{ owned_paths: string; id: string }>(
      `SELECT id, owned_paths FROM factory_work_units
        WHERE campaign_id = ? AND state = 'LEASED' AND lease_expires_at > ?`,
      [input.campaignId, now],
    );
    const held: { id: string; paths: string[] }[] = busy.map((b) => ({
      id: b.id,
      paths: parseJson<string[]>(b.owned_paths, []),
    }));

    let wonThisRound = 0;
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const paths = parseJson<string[]>(candidate.owned_paths, []);

      // Two live workers must never own an overlapping mutation surface. When
      // overlap is unavoidable the planner establishes the shared interface
      // first and makes the implementations depend on it; here, the later unit
      // simply waits.
      const conflict = held.find((h) => h.id !== candidate.id && pathsOverlap(h.paths, paths));
      if (conflict) {
        input.onSkip?.(candidate, `mutation surface overlaps unit ${conflict.id}`);
        continue;
      }

      if (input.admit) {
        const admitted = await input.admit(candidate);
        if (!admitted.ok) {
          input.onSkip?.(candidate, admitted.reason ?? 'not admitted');
          continue;
        }
      }

      const swapAt = factoryNow();
      const leaseId = newId('ful');
      const expiresAt = plusMs(swapAt, leaseMs);

      // The compare-and-swap. Ownership, the attempt count and the fencing
      // generation all move in this one statement, so there is no window for a
      // second claimant to live in.
      const result = await db.run(
        `UPDATE factory_work_units
            SET state = 'LEASED',
                lease_id = ?, lease_worker_id = ?, lease_session_id = ?,
                lease_generation = lease_generation + 1,
                attempt = attempt + 1,
                leased_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND lease_generation = ?
            AND attempt < max_attempts
            AND (not_before IS NULL OR not_before <= ?)
            AND ( state = 'READY'
               OR (state = 'LEASED' AND lease_expires_at <= ?) )`,
        [
          leaseId,
          input.workerId,
          input.sessionId ?? null,
          swapAt,
          expiresAt,
          swapAt,
          candidate.id,
          candidate.lease_generation,
          swapAt,
          swapAt,
        ],
      );
      if (result.changes !== 1) continue; // somebody else won it; an ordinary outcome

      const fresh = await db.get<FactoryWorkUnitRow>(
        `SELECT * FROM factory_work_units WHERE id = ?`,
        [candidate.id],
      );
      if (!fresh) continue;
      claimed.push({
        unit: mapWorkUnit(fresh),
        leaseId,
        leaseGeneration: candidate.lease_generation + 1,
        leaseExpiresAt: expiresAt,
        attempt: candidate.attempt + 1,
        takeoverFrom: candidate.state === 'LEASED' ? candidate.lease_worker_id : null,
      });
      held.push({ id: candidate.id, paths });
      wonThisRound += 1;
    }
    if (wonThisRound === 0) break;
  }

  return claimed;
}

/* ------------------------------------------------------------------------- */
/* Proving ownership                                                          */
/* ------------------------------------------------------------------------- */

export interface UnitOwnership {
  unitId: string;
  workerId: string;
  leaseId: string;
  leaseGeneration: number;
}

export type UnitLeaseResult =
  | { ok: true; unit: FactoryWorkUnit }
  | { ok: false; reason: 'NOT_OWNER' | 'LEASE_EXPIRED' | 'NO_SUCH_UNIT' | 'WRONG_STATE' };

/**
 * Every guarded write carries the whole proof in its own WHERE clause.
 *
 * The unit, the lease, the generation, the worker id — which comes from the
 * authenticated principal at the route and never from a body field — and a
 * lease that has not yet expired. There is no read-then-write, so a worker
 * whose lease was reclaimed matches nothing and cannot overwrite the new
 * owner's result.
 */
async function guarded(
  proof: UnitOwnership,
  sql: string,
  params: SqlParam[],
): Promise<UnitLeaseResult> {
  const db = getDb();
  const result = await db.run(sql, params);
  if (result.changes === 1) {
    const unit = await getUnit(proof.unitId);
    if (!unit) return { ok: false, reason: 'NO_SUCH_UNIT' };
    return { ok: true, unit };
  }
  const row = await db.get<FactoryWorkUnitRow>(`SELECT * FROM factory_work_units WHERE id = ?`, [
    proof.unitId,
  ]);
  if (!row) return { ok: false, reason: 'NO_SUCH_UNIT' };
  if (row.lease_id !== proof.leaseId || row.lease_generation !== proof.leaseGeneration) {
    return { ok: false, reason: 'NOT_OWNER' };
  }
  if (row.lease_expires_at && row.lease_expires_at <= factoryNow()) {
    return { ok: false, reason: 'LEASE_EXPIRED' };
  }
  return { ok: false, reason: 'WRONG_STATE' };
}

export async function heartbeatUnit(
  proof: UnitOwnership,
  leaseMs = DEFAULT_UNIT_LEASE_MS,
): Promise<UnitLeaseResult> {
  const at = factoryNow();
  return await guarded(
    proof,
    `UPDATE factory_work_units
        SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_id = ? AND lease_generation = ? AND lease_worker_id = ?
        AND state = 'LEASED' AND lease_expires_at > ?`,
    [
      plusMs(at, clampUnitLeaseMs(leaseMs)),
      at,
      proof.unitId,
      proof.leaseId,
      proof.leaseGeneration,
      proof.workerId,
      at,
    ],
  );
}

export interface ImplementedInput {
  branch: string;
  headSha: string;
  baseSha: string;
  worktreePath: string | null;
  workerSummary: string | null;
  terminalResult: unknown;
}

/**
 * The worker says it is done, and the lease closes.
 *
 * What it does *not* do is decide that the work is correct. `IMPLEMENTED` means
 * a branch exists with a head the factory can inspect; the integrator holds
 * that diff against the unit's declared ownership and runs its verification,
 * and only then does the unit become `INTEGRATED`.
 */
export async function markImplemented(
  proof: UnitOwnership,
  input: ImplementedInput,
): Promise<UnitLeaseResult> {
  const at = factoryNow();
  return await guarded(
    proof,
    `UPDATE factory_work_units
        SET state = 'IMPLEMENTED',
            lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
            branch = ?, head_sha = ?, base_sha = ?, worktree_path = ?,
            worker_summary = ?, terminal_result = ?, updated_at = ?
      WHERE id = ? AND lease_id = ? AND lease_generation = ? AND lease_worker_id = ?
        AND state = 'LEASED' AND lease_expires_at > ?`,
    [
      input.branch,
      input.headSha,
      input.baseSha,
      input.worktreePath,
      bound(input.workerSummary, MAX_SUMMARY_CHARS),
      toJson(input.terminalResult),
      at,
      proof.unitId,
      proof.leaseId,
      proof.leaseGeneration,
      proof.workerId,
      at,
    ],
  );
}

export interface UnitFailureInput {
  category: FactoryFailureCategory;
  detail: string;
  /** Leave the unit retryable, or retire it. */
  retryable: boolean;
}

/**
 * The attempt failed.
 *
 * A retryable failure puts the unit back to READY with its attempt spent, so
 * the next claim is a genuinely new attempt with the previous one's checkpoint
 * available to it. An exhausted unit is FAILED and keeps every reason it
 * collected: failure history is not deleted by a later success.
 */
export async function failUnit(
  proof: UnitOwnership,
  input: UnitFailureInput,
): Promise<UnitLeaseResult> {
  const db = getDb();
  const row = await db.get<FactoryWorkUnitRow>(`SELECT * FROM factory_work_units WHERE id = ?`, [
    proof.unitId,
  ]);
  if (!row) return { ok: false, reason: 'NO_SUCH_UNIT' };
  const exhausted = !input.retryable || row.attempt >= row.max_attempts;
  const at = factoryNow();
  return await guarded(
    proof,
    `UPDATE factory_work_units
        SET state = ?,
            lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
            failure_category = ?, failure_detail = ?, updated_at = ?
      WHERE id = ? AND lease_id = ? AND lease_generation = ? AND lease_worker_id = ?
        AND state = 'LEASED' AND lease_expires_at > ?`,
    [
      exhausted ? 'FAILED' : 'READY',
      input.category,
      bound(input.detail),
      at,
      proof.unitId,
      proof.leaseId,
      proof.leaseGeneration,
      proof.workerId,
      at,
    ],
  );
}

/**
 * Hand the unit back without spending anything further, and defer it.
 *
 * This is the path provider backpressure takes. A rate-limited worker has not
 * failed and neither has the unit: the lease closes, `not_before` moves, and the
 * attempt already spent stays spent while nothing new is charged. The
 * distinction matters because a refusal recorded as a failure walks a healthy
 * unit toward exhaustion against a condition that was never about the work.
 */
export async function deferUnit(
  proof: UnitOwnership,
  untilIso: string,
  reason: string,
): Promise<UnitLeaseResult> {
  const at = factoryNow();
  return await guarded(
    proof,
    `UPDATE factory_work_units
        SET state = 'READY',
            lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
            not_before = ?, failure_detail = ?, updated_at = ?
      WHERE id = ? AND lease_id = ? AND lease_generation = ? AND lease_worker_id = ?
        AND state = 'LEASED' AND lease_expires_at > ?`,
    [
      untilIso,
      bound(reason),
      at,
      proof.unitId,
      proof.leaseId,
      proof.leaseGeneration,
      proof.workerId,
      at,
    ],
  );
}

/**
 * Give a unit back one attempt, because the attempt it spent was not its fault.
 *
 * The case this exists for is §23's correction: a worker the factory itself
 * refused, or an attempt lost to provider backpressure before any work started,
 * must not walk the unit toward exhaustion. Guarded on the attempt count it was
 * told about, so two callers cannot both refund the same attempt.
 */
export async function refundAttempt(unitId: string, attempt: number): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_work_units
        SET attempt = attempt - 1, updated_at = ?
      WHERE id = ? AND attempt = ? AND attempt > 0 AND state <> 'LEASED'`,
    [factoryNow(), unitId, attempt],
  );
  return result.changes === 1;
}

/** The integrator's verdict, written by the integrator and nobody else. */
export async function markIntegrated(unitId: string, integrationSha: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_work_units
        SET state = 'INTEGRATED', head_sha = ?, updated_at = ?
      WHERE id = ? AND state = 'IMPLEMENTED'`,
    [integrationSha, factoryNow(), unitId],
  );
  return result.changes === 1;
}

/**
 * Send an implemented unit back for another attempt.
 *
 * Used when the integrator rejected the diff, when verification failed, or when
 * a review finding is the same unit's to fix. The attempt already spent stays
 * spent — that is what makes "do not repeat an identical failed attempt
 * indefinitely" enforceable — and the reason travels with it.
 */
export async function reopenUnit(
  unitId: string,
  category: FactoryFailureCategory,
  detail: string,
): Promise<boolean> {
  const db = getDb();
  const row = await db.get<FactoryWorkUnitRow>(`SELECT * FROM factory_work_units WHERE id = ?`, [
    unitId,
  ]);
  if (!row) return false;
  const exhausted = row.attempt >= row.max_attempts;
  const result = await db.run(
    `UPDATE factory_work_units
        SET state = ?, failure_category = ?, failure_detail = ?, updated_at = ?
      WHERE id = ? AND state IN ('IMPLEMENTED','READY')`,
    [exhausted ? 'FAILED' : 'READY', category, bound(detail), factoryNow(), unitId],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------------- */
/* Checkpoints                                                                */
/* ------------------------------------------------------------------------- */

export interface CheckpointInput {
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
}

/**
 * A worker's handover, append-only.
 *
 * The point is that a *different* worker can resume from it without
 * reconstructing the investigation from a chat transcript. So it records what
 * was established, what was committed, what was run, what is still wrong and
 * the next executable action — and never a narrative.
 */
export async function recordCheckpoint(input: CheckpointInput): Promise<FactoryCheckpoint> {
  const db = getDb();
  const id = newId('fck');
  await db.run(
    `INSERT INTO factory_checkpoints (
       id, campaign_id, unit_id, attempt, session_id, worker_id, established,
       commits, tests_run, unresolved, next_action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.campaignId,
      input.unitId,
      input.attempt,
      input.sessionId,
      input.workerId,
      bound(input.established) ?? '',
      toJson(input.commits),
      toJson(input.testsRun),
      bound(input.unresolved) ?? '',
      bound(input.nextAction) ?? '',
      factoryNow(),
    ],
  );
  const row = await db.get<FactoryCheckpointRow>(`SELECT * FROM factory_checkpoints WHERE id = ?`, [
    id,
  ]);
  if (!row) throw new Error('factory: checkpoint vanished immediately after insert');
  return mapCheckpoint(row);
}

/** The newest checkpoint for a unit — the one a resuming assignment carries. */
export async function latestCheckpoint(unitId: string): Promise<FactoryCheckpoint | null> {
  const row = await getDb().get<FactoryCheckpointRow>(
    `SELECT * FROM factory_checkpoints WHERE unit_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [unitId],
  );
  return row ? mapCheckpoint(row) : null;
}

export async function listCheckpoints(unitId: string): Promise<FactoryCheckpoint[]> {
  const rows = await getDb().all<FactoryCheckpointRow>(
    `SELECT * FROM factory_checkpoints WHERE unit_id = ? ORDER BY created_at, rowid`,
    [unitId],
  );
  return rows.map(mapCheckpoint);
}

/**
 * Close leases that have run out.
 *
 * Deliberately not load-bearing. An expired lease is already claimable by the
 * claim query, so this exists to make the state readable and the metrics
 * honest; delete it and nothing breaks. Exactly what `sweepExpiredLeases` is
 * for in the work queue, and for the same reason.
 */
export async function sweepExpiredUnitLeases(): Promise<number> {
  const at = factoryNow();
  const result = await getDb().run(
    `UPDATE factory_work_units
        SET state = 'READY', lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
            failure_category = COALESCE(failure_category, 'WORKER_LOST'),
            failure_detail = COALESCE(failure_detail, 'The lease expired and the unit was reclaimed.'),
            updated_at = ?
      WHERE state = 'LEASED' AND lease_expires_at <= ? AND attempt < max_attempts`,
    [at, at],
  );
  return result.changes;
}
