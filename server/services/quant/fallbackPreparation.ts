/**
 * Which backups to prepare first, ranked from a project's real dependencies on
 * every cash-ledger refresh and recorded on the ledger (FALL-37-6).
 *
 * `fallbackPriority.ts` owns the order — consequence class first, a live
 * dependency promoted ahead of nominal priority with its reason, cheap and
 * reversible backups marked for early preparation — and until now nothing in
 * production ever handed it a dependency. This hands it the one every cash
 * project has (`fallbackPlanReading.ts`: the acquisition dependency built from
 * the outcome rows the funnel reads) with what the records say about it:
 *
 *  - its consequence: a blocked revenue objective, stated only when the
 *    project runs a cash sprint (`cash_modes`) — a revenue objective that is
 *    reached only by reaching buyers. No sprint, no consequence claimed;
 *  - live: a failure of this dependency on the ledger (`ledger.ts`
 *    `readFailureRecoveries`) that has not been shown recovered makes its
 *    safeguards necessary now, with that failure as the reason;
 *  - cost and reversibility of each switch: no row states them, so they are
 *    left unknown and nothing is read as cheap or reversible.
 *
 * The order is recorded on the ledger (`bin_events`,
 * FALLBACK_PREPARATION_RANKED) whenever it changes: the state/ledger owner
 * `REUSED_OWNERS` names, not a second store. It schedules, switches and pauses
 * nothing; discovery and execution go on exactly as before.
 */
import { recordBinEvent } from '../../repos/bins.ts';
import { getDb } from '../../db/database.ts';
import { getCashMode } from '../../repos/cashMode.ts';
import { rankFallbacks, type FallbackRanking, type PriorityInput, type RankedFallback } from './fallbackPriority.ts';
import { acquisitionFallbackStructure, readMeasuredPaths, sprintDaysLeft, type MeasuredPath } from './fallbackPlanReading.ts';
import { readFailureRecoveries, type FailureRecoveryRecord } from './ledger.ts';
import type { Dependency } from './fallbacks.ts';

export const FALLBACK_PREPARATION_EVENT = 'FALLBACK_PREPARATION_RANKED';

export interface FallbackPreparationRecord {
  /** Stable for one order: a refresh that ranks the same way writes nothing. */
  signature: string;
  ranked: RankedFallback[];
  owners: FallbackRanking['owners'];
  at: string;
}

/**
 * The priority input for one real dependency: its consequence when the
 * records state one, and live when an unrecovered failure of it is on the
 * ledger. Pure.
 */
export function priorityInputFor(
  dependency: Dependency,
  sprint: { id: string; horizonDays: number } | null,
  failures: readonly FailureRecoveryRecord[],
): PriorityInput {
  const open = failures.filter((f) => f.dependency === dependency.key && f.recovered !== true);
  const last = open[open.length - 1];
  return {
    dependency,
    consequences: sprint
      ? [{ class: 'BLOCKED_REVENUE_OBJECTIVE', basis: `cash sprint ${sprint.id} (${sprint.horizonDays} days) reaches its revenue objective only through ${dependency.label}` }]
      : [],
    nominalPriority: 0,
    ...(last
      ? { live: { necessary: true, reason: `failure ${last.occurrence} (${last.failureMode}) is on the ledger and recovery ${last.recovered === false ? 'did not work' : 'is not yet known'}` } }
      : {}),
  };
}

/** The last preparation order recorded for a project, or null. */
export async function readFallbackPreparation(projectId: string): Promise<FallbackPreparationRecord | null> {
  const row = await getDb().get<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type = ? AND project_id = ? ORDER BY at DESC, id DESC LIMIT 1`,
    [FALLBACK_PREPARATION_EVENT, projectId],
  );
  try {
    const value = (JSON.parse(row?.measures ?? '{}') as { preparation?: FallbackPreparationRecord }).preparation;
    return value && typeof value.signature === 'string' ? value : null;
  } catch {
    return null;
  }
}

function signatureOf(ranked: readonly RankedFallback[]): string {
  return JSON.stringify(ranked.map((r) => [r.rank, r.dependency, r.substitute, r.decidedBy, r.promoted, r.prepareEarly, r.eligible]));
}

/**
 * The production path: rank the project's real dependencies' substitutes for
 * preparation and record the order when it changes. With no dependency on
 * record there is nothing to rank and nothing is written.
 */
export async function prepareProjectFallbacks(
  projectId: string,
  deps: {
    paths?: () => Promise<MeasuredPath[]>;
    authority?: () => Promise<{ ok: boolean | null; reason: string }>;
    sprint?: () => Promise<{ id: string; horizonDays: number } | null>;
    failures?: () => Promise<FailureRecoveryRecord[]>;
    last?: () => Promise<FallbackPreparationRecord | null>;
    record?: typeof recordBinEvent;
    now?: () => Date;
  } = {},
): Promise<{ ranking: FallbackRanking | null; written: boolean }> {
  const paths = await (deps.paths ?? (() => readMeasuredPaths(projectId)))();
  if (!paths.some((p) => p.contacts > 0)) return { ranking: null, written: false };
  const now = deps.now?.() ?? new Date();
  const authority = await (deps.authority ?? (async () => {
    const { authorityForSwitch } = await import('./fallbackSwitch.ts');
    return authorityForSwitch(projectId, 'CONTACT_BUYER');
  }))();
  const built = acquisitionFallbackStructure(projectId, paths, authority, await sprintDaysLeft(projectId, now.getTime()));
  if (!built) return { ranking: null, written: false };
  const sprint = await (deps.sprint ?? (async () => {
    const mode = await getCashMode(projectId);
    return mode && mode.horizonDays > 0 ? { id: mode.id, horizonDays: mode.horizonDays } : null;
  }))();
  // The dependency's own failures are recorded under its own key, from its primary path's ordered
  // contact results, before the ledger is read: the forecast watch records forecast-claim failures
  // under a claim id, never this dependency's, so without this a live failure could never promote.
  const failures = await (deps.failures ?? (async () => {
    const { recordAcquisitionFailures } = await import('./fallbackPlanReading.ts');
    await recordAcquisitionFailures(projectId, built.dependency.key, built.primary);
    return readFailureRecoveries(projectId);
  }))();
  const ranking = rankFallbacks([priorityInputFor(built.dependency, sprint, failures)]);
  if (ranking.ranked.length === 0) return { ranking, written: false };
  const signature = signatureOf(ranking.ranked);
  const last = await (deps.last ?? (() => readFallbackPreparation(projectId)))();
  if (last?.signature === signature) return { ranking, written: false };
  const record: FallbackPreparationRecord = { signature, ranked: ranking.ranked, owners: ranking.owners, at: now.toISOString() };
  const first = ranking.ranked[0]!;
  await (deps.record ?? recordBinEvent)({
    eventType: FALLBACK_PREPARATION_EVENT,
    projectId,
    workloadClass: 'fallback-preparation',
    outcome: 'RANKED',
    reason: `${ranking.ranked.length} fallback(s) ranked for preparation; first: ${first.dependency} → ${first.substitute} (${first.decidedBy}); ${ranking.ranked.filter((r) => r.prepareEarly).length} to prepare early`.slice(0, 480),
    evidenceClass: 'MEASURED',
    measures: { preparation: record },
  });
  return { ranking, written: true };
}
