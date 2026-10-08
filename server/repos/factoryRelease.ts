/**
 * Release grants and release runs.
 *
 * Every transition is one guarded UPDATE naming the state it moves from, so two
 * release workflows racing on one campaign produce one move and one ordinary
 * loser — the shape every queue in this codebase already has. A run is never
 * deleted and a grant is revoked rather than removed.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';
import {
  RELEASE_IN_FLIGHT,
  type LiveCheck,
  type ReleaseChannel,
  type ReleaseFailureStage,
  type ReleaseGrant,
  type ReleaseGrantRow,
  type ReleasePolicy,
  type ReleaseRun,
  type ReleaseRunRow,
  type ReleaseRunState,
} from '../domain/factoryRelease.ts';

function mapGrant(row: ReleaseGrantRow): ReleaseGrant {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    projectId: row.project_id,
    policy: row.policy as ReleasePolicy,
    liveChecks: parseJson<LiveCheck[]>(row.live_checks, []),
    pagePath: row.page_path,
    grantedByUserId: row.granted_by_user_id,
    authorityChannel: row.authority_channel as ReleaseChannel,
    executedByRef: row.executed_by_ref,
    reason: row.reason,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
    revokedReason: row.revoked_reason,
  };
}

function mapRun(row: ReleaseRunRow): ReleaseRun {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    changeRequestId: row.change_request_id,
    grantId: row.grant_id,
    headSha: row.head_sha,
    attempt: Number(row.attempt),
    state: row.state as ReleaseRunState,
    refusal: parseJson<string[]>(row.refusal, []),
    mergeSha: row.merge_sha,
    workflowRunId: row.workflow_run_id,
    deployRunId: row.deploy_run_id,
    failureStage: row.failure_stage as ReleaseFailureStage | null,
    failureDetail: row.failure_detail,
    verification: parseJson<Record<string, unknown>>(row.verification, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export interface GrantInput {
  changeRequestId: string;
  projectId: string;
  liveChecks: LiveCheck[];
  pagePath: string | null;
  grantedByUserId: string;
  authorityChannel: ReleaseChannel;
  executedByRef: string | null;
  reason: string;
}

/** Idempotent: a change request holds at most one live grant, by a partial unique index. */
export async function grantRelease(input: GrantInput): Promise<{ grant: ReleaseGrant; created: boolean }> {
  const id = newId('frg');
  const result = await getDb().run(
    `INSERT INTO factory_release_grants
       (id, change_request_id, project_id, policy, live_checks, page_path, granted_by_user_id,
        authority_channel, executed_by_ref, reason, created_at)
     VALUES (?, ?, ?, 'AUTO_LOW_RISK', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.changeRequestId,
      input.projectId,
      toJson(input.liveChecks),
      input.pagePath,
      input.grantedByUserId,
      input.authorityChannel,
      input.executedByRef,
      input.reason,
      nowIso(),
    ],
  );
  const grant = await liveGrantFor(input.changeRequestId);
  if (!grant) throw new Error(`release grant for ${input.changeRequestId} was not readable after insert`);
  return { grant, created: (result.changes ?? 0) > 0 };
}

export async function liveGrantFor(changeRequestId: string): Promise<ReleaseGrant | null> {
  const row = await getDb().get<ReleaseGrantRow>(
    'SELECT * FROM factory_release_grants WHERE change_request_id = ? AND revoked_at IS NULL',
    [changeRequestId],
  );
  return row ? mapGrant(row) : null;
}

export async function getGrant(id: string): Promise<ReleaseGrant | null> {
  const row = await getDb().get<ReleaseGrantRow>('SELECT * FROM factory_release_grants WHERE id = ?', [id]);
  return row ? mapGrant(row) : null;
}

export async function revokeGrant(id: string, byUserId: string, reason: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_release_grants
        SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = ?
      WHERE id = ? AND revoked_at IS NULL`,
    [nowIso(), byUserId, reason, id],
  );
  return (result.changes ?? 0) > 0;
}

export async function listRuns(campaignId: string): Promise<ReleaseRun[]> {
  const rows = await getDb().all<ReleaseRunRow>(
    'SELECT * FROM factory_release_runs WHERE campaign_id = ? ORDER BY created_at ASC, attempt ASC, id ASC',
    [campaignId],
  );
  return rows.map(mapRun);
}

export async function latestRun(campaignId: string): Promise<ReleaseRun | null> {
  const runs = await listRuns(campaignId);
  return runs[runs.length - 1] ?? null;
}

export async function getRun(id: string): Promise<ReleaseRun | null> {
  const row = await getDb().get<ReleaseRunRow>('SELECT * FROM factory_release_runs WHERE id = ?', [id]);
  return row ? mapRun(row) : null;
}

export async function listInFlightRuns(): Promise<ReleaseRun[]> {
  const placeholders = RELEASE_IN_FLIGHT.map(() => '?').join(', ');
  const rows = await getDb().all<ReleaseRunRow>(
    `SELECT * FROM factory_release_runs WHERE state IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    [...RELEASE_IN_FLIGHT],
  );
  return rows.map(mapRun);
}

export interface OpenRunInput {
  campaignId: string;
  changeRequestId: string;
  grantId: string;
  headSha: string;
  attempt: number;
  state: 'GATING' | 'REFUSED';
  refusal: string[];
  workflowRunId: string | null;
}

/**
 * Open an attempt. The two unique indexes are the arbiters: one row per
 * (campaign, head, attempt), and at most one in flight per campaign. A caller
 * that loses either reads back what is there.
 */
export async function openRun(input: OpenRunInput): Promise<{ run: ReleaseRun | null; created: boolean }> {
  const id = newId('frr');
  const at = nowIso();
  const result = await getDb().run(
    `INSERT INTO factory_release_runs
       (id, campaign_id, change_request_id, grant_id, head_sha, attempt, state, refusal,
        workflow_run_id, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.campaignId,
      input.changeRequestId,
      input.grantId,
      input.headSha,
      input.attempt,
      input.state,
      toJson(input.refusal),
      input.workflowRunId,
      at,
      at,
      input.state === 'REFUSED' ? at : null,
    ],
  );
  const created = (result.changes ?? 0) > 0;
  if (created) return { run: await getRun(id), created };
  return { run: await latestRun(input.campaignId), created: false };
}

const TERMINAL: readonly ReleaseRunState[] = ['LIVE', 'FAILED', 'ROLLED_BACK', 'REFUSED'];

export interface AdvanceInput {
  from: readonly ReleaseRunState[];
  to: ReleaseRunState;
  mergeSha?: string | null;
  deployRunId?: string | null;
  failureStage?: ReleaseFailureStage | null;
  failureDetail?: string | null;
  verification?: Record<string, unknown>;
}

/** One guarded move. False means another caller moved it first, or it was never in `from`. */
export async function advanceRun(id: string, input: AdvanceInput): Promise<boolean> {
  const sets = ['state = ?', 'updated_at = ?'];
  const at = nowIso();
  const params: (string | number | null)[] = [input.to, at];
  if (input.mergeSha !== undefined) {
    sets.push('merge_sha = COALESCE(merge_sha, ?)');
    params.push(input.mergeSha);
  }
  if (input.deployRunId !== undefined) {
    sets.push('deploy_run_id = ?');
    params.push(input.deployRunId);
  }
  if (input.failureStage !== undefined) {
    sets.push('failure_stage = ?');
    params.push(input.failureStage);
  }
  if (input.failureDetail !== undefined) {
    sets.push('failure_detail = ?');
    params.push(input.failureDetail);
  }
  if (input.verification !== undefined) {
    sets.push('verification = ?');
    params.push(toJson(input.verification));
  }
  if (TERMINAL.includes(input.to)) {
    sets.push('finished_at = ?');
    params.push(at);
  }
  const placeholders = input.from.map(() => '?').join(', ');
  const result = await getDb().run(
    `UPDATE factory_release_runs SET ${sets.join(', ')} WHERE id = ? AND state IN (${placeholders})`,
    [...params, id, ...input.from],
  );
  return (result.changes ?? 0) > 0;
}
