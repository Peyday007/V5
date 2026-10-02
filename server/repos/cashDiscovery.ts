/**
 * Which questions discovery has asked, and which idea asked each one.
 *
 * Read by key rather than scanned out of the activity feed, which is the whole
 * reason this table exists: `listCashEvents(projectId, 500)` is a display
 * window, and once ordinary sprint activity pushed the opening events out of it
 * the producer re-opened every bucket as a duplicate *and* the harvest stopped
 * recognising its own missions. A display window is not an index.
 *
 * It is also the durable classification `launchableUnderCashMode` needs. A
 * discovery bucket is discovery work because a row here says so — never because
 * some other table has no row about it, which is what made a wound-down sprint
 * keep launching buckets.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CashDiscoveryRound, CashDiscoveryRoundRow } from '../domain/types.ts';

function mapRound(row: CashDiscoveryRoundRow): CashDiscoveryRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    bucketId: row.bucket_id,
    mechanism: row.mechanism,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as CashDiscoveryRound['state'],
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open one round of one bucket, or find the one that is already open.
 *
 * `ON CONFLICT DO NOTHING` on `(project, bucket, round)` then read back, which
 * is the shape every idempotent write in this repository takes. A losing
 * insert here is never harmless on its own: the candidate this call's caller
 * created is `SHARED` with a project, and Russell's tick judges and can
 * launch any unjudged `SHARED` candidate, orphan or not, so a candidate left
 * with no round pointing at it is a research mission Brain pays for that
 * nothing will ever absorb the answer to. `openDiscovery` is what actually
 * makes a lost race harmless, by creating the candidate and calling this
 * function inside one transaction and rolling both back together when the
 * insert loses.
 */
export async function openRound(input: {
  projectId: string;
  cashModeId: string;
  bucketId: string;
  mechanism: string;
  round: number;
  candidateId: string;
}): Promise<{ round: CashDiscoveryRound; created: boolean }> {
  const id = newId('cdr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO cash_discovery_rounds
       (id, project_id, cash_mode_id, bucket_id, mechanism, round, candidate_id,
        state, opened_at, harvested_at, found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, 0, ?, ?)
     ON CONFLICT (project_id, bucket_id, round) DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.bucketId,
      input.mechanism,
      Math.max(1, Math.trunc(input.round)),
      input.candidateId,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CashDiscoveryRoundRow>(
    'SELECT * FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id = ? AND round = ?',
    [input.projectId, input.bucketId, Math.max(1, Math.trunc(input.round))],
  );
  if (!rows[0]) throw new Error('The discovery round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

export async function listRounds(projectId: string): Promise<CashDiscoveryRound[]> {
  const rows = await getDb().all<CashDiscoveryRoundRow>(
    `SELECT * FROM cash_discovery_rounds
      WHERE project_id = ?
      ORDER BY opened_at DESC, id DESC`,
    [projectId],
  );
  return rows.map(mapRound);
}

/** The round one Russell idea is asking, if it is asking one. */
export async function roundForCandidate(candidateId: string): Promise<CashDiscoveryRound | null> {
  const rows = await getDb().all<CashDiscoveryRoundRow>(
    'SELECT * FROM cash_discovery_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

/** The rounds still waiting for their research, by the candidate that asked. */
export async function openRoundsByCandidate(
  projectId: string,
): Promise<Map<string, CashDiscoveryRound>> {
  const rows = await getDb().all<CashDiscoveryRoundRow>(
    "SELECT * FROM cash_discovery_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

/**
 * This round's question has been answered and its findings filed.
 *
 * Guarded on `state = 'OPEN'`, so two ticks reading the same finished mission
 * settle it once. `found` is what it actually produced, which is what the next
 * round is decided against: a bucket that keeps returning nothing is a bucket
 * worth asking less often, and that is a reading rather than a rule here.
 */
export async function closeRound(input: {
  id: string;
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE cash_discovery_rounds
        SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  return result.changes === 1;
}

/** The highest round this bucket has reached, and 0 when it has never run. */
export async function latestRound(projectId: string, bucketId: string): Promise<number> {
  const rows = await getDb().all<{ highest: number | null }>(
    'SELECT MAX(round) AS highest FROM cash_discovery_rounds WHERE project_id = ? AND bucket_id = ?',
    [projectId, bucketId],
  );
  return Number(rows[0]?.highest ?? 0);
}
