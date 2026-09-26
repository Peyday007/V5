/**
 * The factory's production line, as rows.
 *
 * Two tables and nothing derived. A queue entry records that a person approved
 * an objective and chose to have it started when a slot frees; the admission
 * policy records how many campaigns may be working at once. Whether the line is
 * idle, what is next and why, and how long each stage waited are all read from
 * these rows plus the campaigns and bins they point at, on every read. A stored
 * "the line is idle" column would be a status that goes stale the instant a
 * worker arrives.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { mapBin } from './bins.ts';
import type { Bin, BinRow } from '../domain/types.ts';

export type QueueEntryState = 'QUEUED' | 'STARTED' | 'WITHDRAWN';

export interface FactoryQueueEntry {
  id: string;
  changeRequestId: string;
  projectId: string;
  priority: number;
  state: QueueEntryState;
  queuedByUserId: string;
  queuedAt: string;
  campaignId: string | null;
  startedAt: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
}

interface QueueEntryRow {
  id: string;
  change_request_id: string;
  project_id: string;
  priority: number;
  state: string;
  queued_by_user_id: string;
  queued_at: string;
  campaign_id: string | null;
  started_at: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
}

function mapEntry(row: QueueEntryRow): FactoryQueueEntry {
  return {
    id: row.id,
    changeRequestId: row.change_request_id,
    projectId: row.project_id,
    priority: Number(row.priority),
    state: row.state as QueueEntryState,
    queuedByUserId: row.queued_by_user_id,
    queuedAt: row.queued_at,
    campaignId: row.campaign_id,
    startedAt: row.started_at,
    withdrawnAt: row.withdrawn_at,
    withdrawReason: row.withdraw_reason,
  };
}

/**
 * Queue an approved objective. Idempotent by change request: a second call
 * returns the entry the first one wrote, whatever its priority argument says,
 * because one objective is one place in the line.
 */
export async function enqueueChangeRequest(input: {
  changeRequestId: string;
  projectId: string;
  priority: number;
  queuedByUserId: string;
}): Promise<{ entry: FactoryQueueEntry; created: boolean }> {
  const db = getDb();
  const id = newId('fqe');
  const result = await db.run(
    `INSERT INTO factory_queue_entries
       (id, change_request_id, project_id, priority, state, queued_by_user_id, queued_at)
     VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)
     ON CONFLICT (change_request_id) DO NOTHING`,
    [id, input.changeRequestId, input.projectId, input.priority, input.queuedByUserId, nowIso()],
  );
  const row = await db.get<QueueEntryRow>(
    `SELECT * FROM factory_queue_entries WHERE change_request_id = ?`,
    [input.changeRequestId],
  );
  if (!row) throw new Error('factory line: queue entry vanished immediately after insert');
  return { entry: mapEntry(row), created: result.changes > 0 };
}

/** The line in the order it will be started: priority, then who queued first. */
export async function listQueueEntries(states?: QueueEntryState[]): Promise<FactoryQueueEntry[]> {
  const wanted = states && states.length > 0 ? states : ['QUEUED', 'STARTED', 'WITHDRAWN'];
  const rows = await getDb().all<QueueEntryRow>(
    `SELECT * FROM factory_queue_entries
      WHERE state IN (${wanted.map(() => '?').join(', ')})
      ORDER BY priority, queued_at, id`,
    wanted,
  );
  return rows.map(mapEntry);
}

/**
 * Take an entry for a campaign. One guarded statement: two ticks racing for the
 * same entry produce one start and one ordinary loser.
 */
export async function markQueueEntryStarted(input: {
  entryId: string;
  campaignId: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_queue_entries
        SET state = 'STARTED', campaign_id = ?, started_at = ?
      WHERE id = ? AND state = 'QUEUED'`,
    [input.campaignId, nowIso(), input.entryId],
  );
  return result.changes > 0;
}

/** Take an entry out of the line. Keeps the row and the reason. */
export async function withdrawQueueEntry(input: {
  changeRequestId: string;
  reason: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE factory_queue_entries
        SET state = 'WITHDRAWN', withdrawn_at = ?, withdraw_reason = ?
      WHERE change_request_id = ? AND state = 'QUEUED'`,
    [nowIso(), input.reason, input.changeRequestId],
  );
  return result.changes > 0;
}

export interface AdmissionPolicy {
  id: string | null;
  maxActive: number;
  actor: string;
  reason: string;
  createdAt: string | null;
}

/**
 * One campaign at a time until a person says otherwise. The serial loop is what
 * has to be proven first; a default that ran several at once would be a
 * concurrency decision nobody made.
 */
export const DEFAULT_MAX_ACTIVE = 1;

export async function currentAdmissionPolicy(): Promise<AdmissionPolicy> {
  const row = await getDb().get<{
    id: string;
    max_active: number;
    actor: string;
    reason: string;
    created_at: string;
  }>(`SELECT * FROM factory_admission_policy ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  if (!row) {
    return {
      id: null,
      maxActive: DEFAULT_MAX_ACTIVE,
      actor: 'default',
      reason: 'No admission policy has been recorded; one campaign works at a time.',
      createdAt: null,
    };
  }
  return {
    id: row.id,
    maxActive: Number(row.max_active),
    actor: row.actor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export async function setAdmissionPolicy(input: {
  maxActive: number;
  actor: string;
  reason: string;
}): Promise<AdmissionPolicy> {
  if (!Number.isInteger(input.maxActive) || input.maxActive < 0) {
    throw new Error('The admission limit is a whole number of campaigns, zero or more.');
  }
  if (!input.reason.trim()) throw new Error('An admission change needs a reason.');
  await getDb().run(
    `INSERT INTO factory_admission_policy (id, max_active, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId('fap'), input.maxActive, input.actor, input.reason, nowIso()],
  );
  return currentAdmissionPolicy();
}

/**
 * Every factory bin created since an instant, in the order they were created —
 * the raw material the burn-in reading derives its timelines from.
 */
export async function listFactoryBinsSince(sinceIso: string): Promise<Bin[]> {
  const rows = await getDb().all<BinRow>(
    `SELECT * FROM bins
      WHERE factory_campaign_id IS NOT NULL AND created_at >= ?
      ORDER BY created_at, rowid
      LIMIT 500`,
    [sinceIso],
  );
  return rows.map(mapBin);
}

/**
 * Whether a campaign's stage is parked on a person: it has no bin a worker could
 * be given (READY or LEASED), and its newest bin is NEEDS_HUMAN.
 *
 * A campaign in a working state whose only stage bin ran out of attempts reads
 * EXECUTING for as long as nobody answers the bin — and counting it as working
 * holds an admission slot while nothing moves, which is the idle line this
 * module exists to prevent. Read from rows, never stored.
 */
export async function parkedStageBin(campaignId: string): Promise<Bin | null> {
  const db = getDb();
  const live = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bins
      WHERE factory_campaign_id = ? AND state IN ('READY', 'LEASED')`,
    [campaignId],
  );
  if (Number(live?.n ?? 0) > 0) return null;
  const newest = await db.get<BinRow>(
    `SELECT * FROM bins WHERE factory_campaign_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [campaignId],
  );
  if (!newest || newest.state !== 'NEEDS_HUMAN') return null;
  return mapBin(newest);
}
