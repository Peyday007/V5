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
import type { MarketplaceDeliverableRow, MarketplaceJobRow, MarketplaceJobState } from '../domain/types.ts';

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
  /** What Brain would deliver: 'RESEARCH_REPORT' or deliverable kinds. */
  categories: string[];
  /** The figures the bid was priced on (`freelancer/economics.ts`), or null for a rejected job. */
  economics: Record<string, unknown> | null;
  needsClientFiles: boolean;
  deliverableBinId: string | null;
  revisions: number;
  /** What Brain read from the client's files, as a summary list. */
  clientFiles: { name: string; chars: number; readable: boolean; note: string; storageKey?: string; sha256?: string }[] | null;
}

function json<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
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
    categories: json<string[]>(row.categories, []),
    economics: json<Record<string, unknown> | null>(row.economics, null),
    needsClientFiles: Number(row.needs_client_files ?? 0) === 1,
    deliverableBinId: row.deliverable_bin_id ?? null,
    revisions: Number(row.revisions ?? 0),
    clientFiles: json<MarketplaceJob['clientFiles']>(row.client_files, null),
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
  categories?: string[];
  economics?: Record<string, unknown> | null;
  needsClientFiles?: boolean;
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
        created_at, updated_at, categories, economics, needs_client_files)
     VALUES (?, ?, 'FREELANCER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
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
      JSON.stringify(input.categories ?? []),
      input.economics ? JSON.stringify(input.economics) : null,
      input.needsClientFiles ? 1 : 0,
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
  deliverableBinId?: string | null;
  revisions?: number;
  clientFiles?: string | null;
  screenReasons?: string | null;
  proposalText?: string | null;
  bidAmountCents?: number | null;
  bidPeriodDays?: number | null;
  categories?: string | null;
  economics?: string | null;
  needsClientFiles?: number | null;
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
    deliverableBinId: 'deliverable_bin_id',
    revisions: 'revisions',
    clientFiles: 'client_files',
    screenReasons: 'screen_reasons',
    proposalText: 'proposal_text',
    bidAmountCents: 'bid_amount_cents',
    bidPeriodDays: 'bid_period_days',
    categories: 'categories',
    economics: 'economics',
    needsClientFiles: 'needs_client_files',
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

/* =========================================================================
 * Deliverables: one row per version Brain rendered
 * ====================================================================== */

export interface DeliveredFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
}

export interface MarketplaceDeliverable {
  id: string;
  projectId: string;
  jobId: string;
  version: number;
  binId: string;
  kinds: string[];
  spec: unknown;
  message: string | null;
  files: DeliveredFile[];
  verification: { passed: boolean; checks: { name: string; ok: boolean; detail: string }[]; problems?: string[] };
  state: 'VERIFIED' | 'REFUSED' | 'DELIVERED';
  createdAt: string;
  deliveredAt: string | null;
}

function mapDeliverable(row: MarketplaceDeliverableRow): MarketplaceDeliverable {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    version: row.version,
    binId: row.bin_id,
    kinds: json<string[]>(row.kinds, []),
    spec: json<unknown>(row.spec, null),
    message: row.message,
    files: json<DeliveredFile[]>(row.files, []),
    verification: json(row.verification, { passed: false, checks: [] }),
    state: row.state as MarketplaceDeliverable['state'],
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Record one rendered version, once per bin. A second call for the same bin
 * returns the row the first wrote, so a tick that died after writing replays
 * rather than rendering a second version of the same work.
 */
export async function recordDeliverable(input: {
  projectId: string;
  jobId: string;
  binId: string;
  kinds: string[];
  spec: unknown;
  message: string | null;
  files: DeliveredFile[];
  verification: MarketplaceDeliverable['verification'];
  state: 'VERIFIED' | 'REFUSED';
}): Promise<MarketplaceDeliverable> {
  const db = getDb();
  const existing = await db.get<MarketplaceDeliverableRow>('SELECT * FROM marketplace_deliverables WHERE bin_id = ?', [input.binId]);
  if (existing) return mapDeliverable(existing);
  const last = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM marketplace_deliverables WHERE job_id = ?', [input.jobId]);
  await db.run(
    `INSERT INTO marketplace_deliverables
       (id, project_id, job_id, version, bin_id, kinds, spec, message, files, verification, state, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (bin_id) DO NOTHING`,
    [
      newId('mkd'),
      input.projectId,
      input.jobId,
      Number(last?.v ?? 0) + 1,
      input.binId,
      JSON.stringify(input.kinds),
      JSON.stringify(input.spec),
      input.message,
      JSON.stringify(input.files),
      JSON.stringify(input.verification),
      input.state,
      nowIso(),
    ],
  );
  const row = await db.get<MarketplaceDeliverableRow>('SELECT * FROM marketplace_deliverables WHERE bin_id = ?', [input.binId]);
  if (!row) throw new Error('A deliverable disappeared immediately after being written.');
  return mapDeliverable(row);
}

export async function markDeliverableDelivered(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE marketplace_deliverables SET state = 'DELIVERED', delivered_at = ? WHERE id = ? AND state = 'VERIFIED'`,
    [nowIso(), id],
  );
  return Number(result.changes ?? 0) === 1;
}

export async function deliverablesFor(jobId: string): Promise<MarketplaceDeliverable[]> {
  const rows = await getDb().all<MarketplaceDeliverableRow>(
    'SELECT * FROM marketplace_deliverables WHERE job_id = ? ORDER BY version',
    [jobId],
  );
  return rows.map(mapDeliverable);
}

export async function allDeliverables(projectId: string): Promise<MarketplaceDeliverable[]> {
  const rows = await getDb().all<MarketplaceDeliverableRow>(
    'SELECT * FROM marketplace_deliverables WHERE project_id = ? ORDER BY created_at, version',
    [projectId],
  );
  return rows.map(mapDeliverable);
}
