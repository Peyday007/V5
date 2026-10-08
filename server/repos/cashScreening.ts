/**
 * The two reads cheap screening needs in one statement each, rather than one
 * per opening.
 *
 * Screening runs on every operating pass over every live opening, so a read per
 * opening per pass is exactly the cost it exists to stop Brain paying. Both are
 * read-only; the one write screening makes is an ordinary `cash_events` row,
 * through `recordCashEvent`.
 */
import { getDb } from '../db/database.ts';
import { parseJson } from './util.ts';

/** The URL each opening's own source claim cites, keyed by claim id. */
export async function sourceUrlsFor(claimIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(claimIds)];
  // Bounded chunks: a statement with an unbounded parameter list is refused by
  // SQLite past its variable limit, and that limit differs by build.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await getDb().all<{ id: string; source_url: string | null }>(
      `SELECT id, source_url FROM research_claims WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
    for (const row of rows) out.set(row.id, row.source_url);
  }
  return out;
}

/**
 * The newest screening reading recorded for each opening in a project.
 *
 * Read so a pass writes a row only when the reading *changed*: a reading that
 * is the same every tick is one fact, and a row per tick would make the history
 * say it was decided thousands of times.
 */
export async function latestScreens(
  projectId: string,
): Promise<Map<string, { fingerprint: string; at: string }>> {
  const rows = await getDb().all<{ opportunity_id: string; detail: string; created_at: string }>(
    `SELECT opportunity_id, detail, created_at FROM cash_events
      WHERE project_id = ? AND kind = 'CASH_OPPORTUNITY_SCREENED' AND opportunity_id IS NOT NULL
      ORDER BY created_at, id`,
    [projectId],
  );
  const out = new Map<string, { fingerprint: string; at: string }>();
  for (const row of rows) {
    const detail = parseJson<Record<string, unknown>>(row.detail, {});
    const fingerprint = typeof detail['fingerprint'] === 'string' ? detail['fingerprint'] : '';
    out.set(row.opportunity_id, { fingerprint, at: row.created_at });
  }
  return out;
}
