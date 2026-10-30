/** Reading the rows the yield join needs. Reads only. */
import { getDb } from '../../../db/database.ts';
import { readSourceMetrics } from '../../../repos/collectMetrics.ts';
import { openingSourceKey } from '../../cash/duplicates.ts';
import { joinSourceYield, type OpeningOutcome, type ShortlistedLead, type SourceYieldRow } from './yield.ts';

export async function shortlistedLeads(): Promise<ShortlistedLead[]> {
  const rows = await getDb().all<{ source: string; url: string }>(
    `SELECT source, url FROM feed_items WHERE shortlisted_round_id IS NOT NULL`,
  );
  return rows.map((r) => ({ source: r.source, urlKey: openingSourceKey(r.url) }));
}

/** Per-source yield for a project's openings; `openings` is supplied by the caller that already derived tiers. */
export async function sourceYield(openings: readonly OpeningOutcome[]): Promise<SourceYieldRow[]> {
  return joinSourceYield(await readSourceMetrics(), await shortlistedLeads(), openings);
}
