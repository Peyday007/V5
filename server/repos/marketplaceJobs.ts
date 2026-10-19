/**
 * Marketplace jobs Brain found and is working.
 *
 * One row per external job per project. `state` moves only through `move`,
 * a guarded UPDATE naming the state it leaves, so two ticks reading one job
 * produce one transition and an ordinary loser. What happened is written to
 * `cash_events` by the caller; this table says where the job has got to.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { newId, nowIso } from './util.ts';
import type { MarketplaceJobRow, MarketplaceJobState } from '../domain/types.ts';

export interface MarketplaceJob {
  id: string;
  projectId: string;
  platform: 'FREELANCER';
  externalId: string;
  title: string;
  url: string;
  employerExternalId: string | null;
  currency: string;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  postedAt: string | null;
  description: string;
  screenReasons: string[];
  proposalText: string | null;
  bidAmountCents: number | null;
  bidPeriodDays: number | null;
  state: MarketplaceJobState;
  stateReason: string | null;
  bidExternalId: string | null;
  threadExternalId: string | null;
  goalId: string | null;
  documentId: string | null;
  milestoneExternalId: string | null;
  createdAt: string;
  updatedAt: string;
}

function reasons(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

function mapRow(row: MarketplaceJobRow): MarketplaceJob {
  return {
    id: row.id,
    projectId: row.project_id,
    platform: 'FREELANCER',
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    employerExternalId: row.employer_external_id,
    currency: row.currency,
    budgetMinCents: row.budget_min_cents,
    budgetMaxCents: row.budget_max_cents,
    postedAt: row.posted_at,
    description: row.description,
    screenReasons: reasons(row.screen_reasons),
    proposalText: row.proposal_text,
    bidAmountCents: row.bid_amount_cents,
    bidPeriodDays: row.bid_period_days,
    state: row.state as MarketplaceJobState,
    stateReason: row.state_reason,
    bidExternalId: row.bid_external_id,
    threadExternalId: row.thread_external_id,
    goalId: row.goal_id,
    documentId: row.document_id,
    milestoneExternalId: row.milestone_external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewMarketplaceJob {
  projectId: string;
  externalId: string;
  title: string;
  url: string;
  employerExternalId: string | null;
  currency: string;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  postedAt: string | null;
  description: string;
  screenReasons: string[];
  proposalText: string | null;
  bidAmountCents: number | null;
  bidPeriodDays: number | null;
  state: 'REJECTED' | 'PREPARED';
}

/** Insert once; a job already recorded is returned as it is. */
export async function recordJob(input: NewMarketplaceJob): Promise<{ job: MarketplaceJob; created: boolean }> {
  const at = nowIso();
  const id = newId('mkj');
  await getDb().run(
    `INSERT INTO marketplace_jobs
       (id, project_id, platform, external_id, title, url, employer_external_id, currency,
        budget_min_cents, budget_max_cents, posted_at, description, screen_reasons,
        proposal_text, bid_amount_cents, bid_period_days, state, state_reason,
        created_at, updated_at)
     VALUES (?, ?, 'FREELANCER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT (project_id, platform, external_id) DO NOTHING`,
    [
      id,
      input.projectId,
      input.externalId,
      input.title,
      input.url,
      input.employerExternalId,
      input.currency,
      input.budgetMinCents,
      input.budgetMaxCents,
      input.postedAt,
      input.description,
      JSON.stringify(input.screenReasons),
      input.proposalText,
      input.bidAmountCents,
      input.bidPeriodDays,
      input.state,
      at,
      at,
    ],
  );
  const job = await jobByExternalId(input.projectId, input.externalId);
  if (!job) throw new Error('A marketplace job disappeared immediately after being written.');
  return { job, created: job.id === id };
}

export async function jobByExternalId(projectId: string, externalId: string): Promise<MarketplaceJob | null> {
  const row = await getDb().get<MarketplaceJobRow>(
    `SELECT * FROM marketplace_jobs WHERE project_id = ? AND platform = 'FREELANCER' AND external_id = ?`,
    [projectId, externalId],
  );
  return row ? mapRow(row) : null;
}

export async function getJob(id: string): Promise<MarketplaceJob | null> {
  const row = await getDb().get<MarketplaceJobRow>('SELECT * FROM marketplace_jobs WHERE id = ?', [id]);
  return row ? mapRow(row) : null;
}

export async function jobsInStates(
  projectId: string,
  states: readonly MarketplaceJobState[],
): Promise<MarketplaceJob[]> {
  if (states.length === 0) return [];
  const rows = await getDb().all<MarketplaceJobRow>(
    `SELECT * FROM marketplace_jobs WHERE project_id = ? AND state IN (${states.map(() => '?').join(', ')})
      ORDER BY created_at, id`,
    [projectId, ...states],
  );
  return rows.map(mapRow);
}

export async function allJobs(projectId: string): Promise<MarketplaceJob[]> {
  const rows = await getDb().all<MarketplaceJobRow>(
    'SELECT * FROM marketplace_jobs WHERE project_id = ? ORDER BY created_at, id',
    [projectId],
  );
  return rows.map(mapRow);
}

/** Count of bids sent since an instant, for the per-day ceiling. */
export async function bidsSentSince(projectId: string, since: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cash_events
      WHERE project_id = ? AND kind = 'MARKETPLACE_BID_SENT' AND created_at >= ?`,
    [projectId, since],
  );
  return Number(row?.n ?? 0);
}

export interface JobPatch {
  stateReason?: string | null;
  bidExternalId?: string | null;
  threadExternalId?: string | null;
  goalId?: string | null;
  documentId?: string | null;
  milestoneExternalId?: string | null;
}

/**
 * Move a job from one state to another, guarded on the state it leaves.
 * Returns false when another caller moved it first, which is an ordinary
 * outcome rather than an error.
 */
export async function move(
  id: string,
  from: MarketplaceJobState,
  to: MarketplaceJobState,
  patch: JobPatch = {},
): Promise<boolean> {
  const sets = ['state = ?', 'updated_at = ?'];
  const values: SqlParam[] = [to, nowIso()];
  const columns: Record<keyof JobPatch, string> = {
    stateReason: 'state_reason',
    bidExternalId: 'bid_external_id',
    threadExternalId: 'thread_external_id',
    goalId: 'goal_id',
    documentId: 'document_id',
    milestoneExternalId: 'milestone_external_id',
  };
  for (const [key, column] of Object.entries(columns) as [keyof JobPatch, string][]) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  const result = await getDb().run(
    `UPDATE marketplace_jobs SET ${sets.join(', ')} WHERE id = ? AND state = ?`,
    [...values, id, from],
  );
  return Number(result.changes ?? 0) === 1;
}
