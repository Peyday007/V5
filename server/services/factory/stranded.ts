/**
 * Stranded Factory work, resolved rather than reported for ever.
 *
 * Production, 2026-11-24: the Factory pool read "1 executable item, 2 free
 * surfaces, nothing running — a fault" for days. The item was the review bin of
 * campaign `fcp_03a8a0ad` (opened 2026-09-26). Part of that campaign was
 * implemented by a session Brain could not record, so `reviewLineage` keys the
 * implementer to the connectors that held its leases — and every
 * repository-capable surface Brain has is on those connectors. Every reviewer
 * that arrived was refused at admission (correctly: it could have been the
 * implementing session), the dispatcher re-armed the intent on the clock
 * (`reviveAbandonedNoShowDispatches`, `rearmStrandedIntents`), each re-arm was
 * refused the same way, and at the re-arm ceiling nothing fired again. The line
 * (`factory/line.ts strandedIntent`) said so on every pass and nothing acted on
 * it — which is why every earlier "repair" (more re-arms, a revival path, a
 * reader that named the stall) did not stop the recurrence: each answered the
 * symptom "the intent gave up", none the cause "no surface can ever take this".
 *
 * The rule now: a Factory bin whose only intent is stranded is resolved by the
 * reason it is stranded, from its own rows.
 *
 *   - **Unreviewable.** Its arrivals were refused at admission for review
 *     independence and no routable repository surface is on a connector the
 *     implementer did not use. No re-arm can change that, so the review bin is
 *     cancelled with the reason (row kept, §5) and the campaign is BLOCKED with
 *     `NO_ELIGIBLE_REVIEWER`, the exact blocker, instead of standing as
 *     executable work beside capacity it can never use. A new review needs a
 *     surface on another connector or a re-implementation, both explicit.
 *   - **Anything else** (fires nobody answered, a surface that went away): the
 *     intent is renewed with one more round of fires, at most once a day per
 *     bin, so the router — which already skips quarantined and unroutable
 *     surfaces — places it on a surface that is healthy now. Bounded: five fires
 *     a day for a bin that keeps failing, never a loop.
 *
 * Every action is a bin event (`DISPATCH_REARMED` / `BIN_TERMINAL`) and a
 * Factory event, so the Command Center and the watchdog read what was done.
 */
import { getDb } from '../../db/database.ts';
import { binNow, getBin, listDispatchesForBin, recordBinEvent, retireBin } from '../../repos/bins.ts';
import { STRANDED_REARM_CEILING, STRANDED_REARM_STEP } from '../dispatch/rearm.ts';

/** The admission refusal `reviewLineage` gives when the implementer may be the reviewer. */
export const INDEPENDENCE_REFUSAL = /could be that very session|implemented part of this campaign, so its verdict/;

/** How often one bin's stranded intent may be renewed. */
export const RENEW_EVERY_MS = 24 * 3_600_000;

export interface StrandedResolution {
  binId: string;
  campaignId: string | null;
  action: 'BLOCKED_NO_ELIGIBLE_REVIEWER' | 'RENEWED' | 'WAITING_RENEWAL';
  reason: string;
}

interface Candidate {
  id: string;
  project_id: string;
  kind: string;
  factory_campaign_id: string | null;
  lease_generation: number;
}

/** READY Factory bins whose current intent is ABANDONED at the ceiling or SUPERSEDED. */
async function strandedFactoryBins(): Promise<Candidate[]> {
  return await getDb().all<Candidate>(
    `SELECT b.id, b.project_id, b.kind, b.factory_campaign_id, b.lease_generation
       FROM bins b
      WHERE b.state = 'READY' AND b.factory_campaign_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM bin_dispatch d
                     WHERE d.bin_id = b.id AND d.lease_generation = b.lease_generation
                       AND (d.state = 'SUPERSEDED' OR (d.state = 'ABANDONED' AND d.max_attempts >= ?)))
      ORDER BY b.priority DESC, b.created_at
      LIMIT 20`,
    [STRANDED_REARM_CEILING],
  );
}

/** Did every recent arrival get refused for review independence? Needs at least three. */
async function refusedForIndependence(binId: string): Promise<{ refused: boolean; last: string | null }> {
  const rows = await getDb().all<{ outcome: string | null; reason: string | null }>(
    `SELECT outcome, reason FROM bin_events
      WHERE bin_id = ? AND event_type = 'BIN_ASSIGNMENT_REFUSED'
      ORDER BY at DESC LIMIT 20`,
    [binId],
  );
  if (rows.length < 3) return { refused: false, last: rows[0]?.reason ?? null };
  const independence = rows.filter((r) => r.outcome === 'REFUSED_BY_ADMISSION' && INDEPENDENCE_REFUSAL.test(r.reason ?? ''));
  return { refused: independence.length === rows.length, last: rows[0]?.reason ?? null };
}

async function lastRenewal(binId: string): Promise<string | null> {
  const row = await getDb().get<{ at: string }>(
    `SELECT at FROM bin_events WHERE bin_id = ? AND event_type = 'DISPATCH_REARMED' AND reason LIKE 'Daily renewal%'
      ORDER BY at DESC LIMIT 1`,
    [binId],
  );
  return row?.at ?? null;
}

export async function resolveStrandedFactoryBins(nowMs = Date.parse(binNow())): Promise<StrandedResolution[]> {
  const out: StrandedResolution[] = [];
  for (const candidate of await strandedFactoryBins()) {
    const independence = candidate.kind === 'FACTORY_REVIEW' ? await refusedForIndependence(candidate.id) : { refused: false, last: null };
    if (independence.refused) {
      const reason =
        'No eligible reviewer: every reviewer that arrived was refused for review independence (the implementer ' +
        'could not be recorded and every repository surface is on its connector), and re-arming cannot change that. ' +
        'The review needs a surface on another Claude connector, or the campaign re-implemented.';
      const retired = await retireBin({ binId: candidate.id, leaseGeneration: candidate.lease_generation, operator: 'BRAIN', reason });
      if (!retired.ok) continue;
      if (candidate.factory_campaign_id) {
        const { patchCampaign } = await import('../../repos/factory.ts');
        await patchCampaign(candidate.factory_campaign_id, {
          state: 'BLOCKED',
          blockerKind: 'NO_ELIGIBLE_REVIEWER',
          blockerDetail: reason,
          stageDetail: 'review stranded: no eligible reviewer on any connector',
        });
        const { recordFactoryEvent } = await import('../../repos/factoryFleet.ts');
        const { FACTORY_EVENT_KINDS } = await import('./metrics.ts');
        await recordFactoryEvent({
          campaignId: candidate.factory_campaign_id,
          kind: FACTORY_EVENT_KINDS.campaignState,
          evidenceClass: 'MEASURED',
          detail: { binId: candidate.id, resolved: 'NO_ELIGIBLE_REVIEWER', lastRefusal: independence.last },
        }).catch(() => undefined);
      }
      out.push({ binId: candidate.id, campaignId: candidate.factory_campaign_id, action: 'BLOCKED_NO_ELIGIBLE_REVIEWER', reason });
      continue;
    }

    const renewedAt = await lastRenewal(candidate.id);
    if (renewedAt && nowMs - Date.parse(renewedAt) < RENEW_EVERY_MS) {
      out.push({ binId: candidate.id, campaignId: candidate.factory_campaign_id, action: 'WAITING_RENEWAL', reason: `renewed at ${renewedAt}; next renewal a day later` });
      continue;
    }
    const intent = (await listDispatchesForBin(candidate.id)).filter((d) => d.leaseGeneration === candidate.lease_generation).at(-1);
    if (!intent) continue;
    const now = new Date(nowMs).toISOString();
    const changed = await getDb().run(
      `UPDATE bin_dispatch
          SET state = 'PENDING', max_attempts = max_attempts + ?, next_attempt_at = ?, updated_at = ?,
              last_error = 'Renewed: the bin is still executable and its intent was stranded; the router places it on a surface that is healthy now.'
        WHERE id = ? AND state IN ('ABANDONED', 'SUPERSEDED')`,
      [STRANDED_REARM_STEP, now, now, intent.id],
    );
    if (changed.changes !== 1) continue;
    const bin = await getBin(candidate.id);
    const reason = `Daily renewal of a stranded Factory intent (was ${intent.state}, ${intent.lastErrorKind ?? 'no error kind'}).`;
    await recordBinEvent({
      eventType: 'DISPATCH_REARMED',
      binId: candidate.id,
      projectId: candidate.project_id,
      leaseGeneration: bin?.leaseGeneration ?? candidate.lease_generation,
      outcome: 'PENDING',
      reason,
      evidenceClass: 'MEASURED',
    });
    out.push({ binId: candidate.id, campaignId: candidate.factory_campaign_id, action: 'RENEWED', reason });
  }
  return out;
}

/**
 * What the Command Center shows about the Factory, read from rows: the line
 * (`readLine`, the same reading the loop and the watchdog use), the automatic
 * corrections the dispatcher made in the last week, and the campaigns that
 * finished. Nothing is computed that another reader does not already compute.
 */
export async function readFactoryOperations(now: Date = new Date()): Promise<{
  line: Awaited<ReturnType<typeof import('./line.ts').readLine>>;
  corrections: { at: string; binId: string; kind: string; reason: string | null }[];
  completed: { campaignId: string; objective: string; state: string; stageDetail: string | null; prUrl: string | null; finishedAt: string | null }[];
}> {
  const { readLine } = await import('./line.ts');
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [line, corrections, completed] = await Promise.all([
    readLine(now),
    getDb().all<{ at: string; bin_id: string; event_type: string; reason: string | null }>(
      `SELECT e.at, e.bin_id, e.event_type, e.reason FROM bin_events e
         JOIN bins b ON b.id = e.bin_id
        WHERE b.factory_campaign_id IS NOT NULL AND e.at > ?
          AND (e.event_type IN ('DISPATCH_REARMED', 'DISPATCH_REVIVED')
               OR (e.event_type = 'BIN_TERMINAL' AND e.reason LIKE 'No eligible reviewer%'))
        ORDER BY e.at DESC LIMIT 25`,
      [since],
    ),
    getDb().all<{ id: string; objective: string; state: string; stage_detail: string | null; pr_url: string | null; finished_at: string | null }>(
      `SELECT c.id, r.objective, c.state, c.stage_detail, c.pr_url, c.finished_at FROM factory_campaigns c
         JOIN factory_change_requests r ON r.id = c.change_request_id
        WHERE c.state = 'COMPLETE' AND c.finished_at IS NOT NULL
        ORDER BY c.finished_at DESC LIMIT 12`,
      [],
    ),
  ]);
  return {
    line,
    corrections: corrections.map((c) => ({ at: c.at, binId: c.bin_id, kind: c.event_type, reason: c.reason })),
    completed: completed.map((c) => ({
      campaignId: c.id,
      objective: c.objective,
      state: c.state,
      stageDetail: c.stage_detail,
      prUrl: c.pr_url,
      finishedAt: c.finished_at,
    })),
  };
}
