/**
 * PROBE 2 (claude/probe-idle-dispatch, never merged): the review lineage of
 * fcp_03a8a0adfdb943a29171 and who its refused reviewers were. SELECT-only.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const CAMPAIGN = 'fcp_03a8a0adfdb943a29171';
const BIN = 'bin_53bf8c50d59b4af2ab6a';

async function q(label: string, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params as never);
    console.log(`== ${label} (${rows.length})`);
    console.log(JSON.stringify(rows).slice(0, 12_000));
    return rows;
  } catch (error) {
    console.log(`== ${label} UNMEASURED: ${(error as Error).message}`);
    return [];
  }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const { implementingSessions } = await import('../server/services/factory/remote.ts');
    const r = await implementingSessions(CAMPAIGN);
    console.log('== implementingSessions');
    console.log(
      JSON.stringify({
        sessions: [...r.sessions],
        workers: [...r.workers],
        unknownWorker: r.unknownWorker,
        unknownSessionCredentials: [...r.unknownSessionCredentials],
        unknownSessionUnresolved: r.unknownSessionUnresolved,
      }),
    );
  } catch (error) {
    console.log(`implementingSessions failed: ${(error as Error).message}`);
  }
  const impl = await q(
    'implementing events',
    `SELECT id, kind, at, session_id, worker_id, detail FROM factory_events
      WHERE campaign_id = ? AND kind IN ('UNIT_IMPLEMENTED','INTEGRATION_MERGED') ORDER BY at`,
    [CAMPAIGN],
  );
  const binIds = new Set<string>();
  for (const row of impl) {
    try {
      const detail = typeof row['detail'] === 'string' ? JSON.parse(row['detail'] as string) : row['detail'];
      if (detail && typeof detail.binId === 'string') binIds.add(detail.binId);
    } catch {
      /* ignore */
    }
  }
  for (const id of binIds) {
    await q(`bin ${id}`, `SELECT id, kind, state, lease_generation, worker_id, lease_session_ref FROM bins WHERE id = ?`, [id]);
    await q(
      `assign events ${id}`,
      `SELECT event_type, at, lease_generation, worker_id, session_ref, measures FROM bin_events
        WHERE bin_id = ? AND event_type IN ('BIN_ASSIGNED','BIN_TAKEOVER') ORDER BY at`,
      [id],
    );
  }
  await q('campaign bins', `SELECT id, kind, state, lease_generation, attempt_count, max_attempts, created_at, completed_at FROM bins WHERE factory_campaign_id = ? ORDER BY created_at`, [CAMPAIGN]);
  await q(
    'refusals on the review bin',
    `SELECT at, worker_id, session_ref, outcome, measures FROM bin_events WHERE bin_id = ? AND event_type = 'BIN_ASSIGNMENT_REFUSED' ORDER BY at DESC LIMIT 25`,
    [BIN],
  );
  await q(
    'refusal stats',
    `SELECT worker_id, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM bin_events WHERE bin_id = ? AND event_type = 'BIN_ASSIGNMENT_REFUSED' GROUP BY worker_id`,
    [BIN],
  );
  await q('session refusal rows', `SELECT * FROM bin_session_refusals WHERE bin_id = ? ORDER BY last_at DESC LIMIT 10`, [BIN]);
  await q('reviews', `SELECT * FROM factory_reviews WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 10`, [CAMPAIGN]);
  await q(
    'dispatch events for review bin',
    `SELECT event_type, at, outcome, reason, routine_ref FROM bin_events WHERE bin_id = ? AND event_type LIKE 'DISPATCH%' ORDER BY at DESC LIMIT 30`,
    [BIN],
  );
  await q('routines by ref', `SELECT id, name, routine_ref, worker_id, state FROM fleet_routines`);
  await q('connectors', `SELECT c.id, c.account_id, c.worker_id, c.label, cc.client_id FROM connectors c LEFT JOIN connector_clients cc ON cc.connector_id = c.id`);
}

main()
  .then(() => console.log('GOALS: OK'))
  .catch((error) => console.log(`PROBE FAILED: ${(error as Error).stack}`))
  .finally(() => closeDatabase());
