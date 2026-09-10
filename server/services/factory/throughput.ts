/**
 * The factory's own throughput, with an evidence class on every number.
 *
 * `metrics.ts` sweeps `factory_events`, `factory_sessions` and
 * `factory_integrations` into `CampaignMetrics`. This module wraps that — it
 * never re-sweeps a row `computeMetrics` already swept — and attaches to every
 * figure the one thing a throughput report is for: whether Brain timed it,
 * derived it from timed numbers, watched a provider refuse it, or has never
 * observed it at all.
 *
 * The honesty requirement this module exists to keep: nothing here multiplies a
 * campaign's `laneTarget` or a worker's declared `maxConcurrency` into a
 * throughput or capacity figure. A declared number may be shown beside what was
 * actually observed, always labelled `UNKNOWN`, and never fed into an
 * arithmetic. And a ceiling nobody has observed is reported as `UNKNOWN` with a
 * null value — zero is a measurement, and the absence of any session is not.
 */
import { getCampaign } from '../../repos/factory.ts';
import type { FactoryEvidenceClass } from '../../domain/factory.ts';
import { campaignMetrics, type CampaignMetrics } from './metrics.ts';

export interface EvidenceNumber {
  value: number | null;
  evidence: FactoryEvidenceClass;
  /** The rows this number came from, or the reason it could not be measured. */
  basis: string;
}

export interface DurationBreakdown {
  total: EvidenceNumber;
  samples: EvidenceNumber;
  average: EvidenceNumber;
}

export interface ThroughputBreakdownEntry {
  id: string;
  /** The account this entry ran under, read from `factory_sessions.account_ref`. Null for a role. */
  accountRef: string | null;
  sessions: EvidenceNumber;
  sessionDurations: DurationBreakdown;
  /** Units attributed to this entry that merged on their first attempt. */
  unitsMerged: EvidenceNumber;
  unitsPerHour: EvidenceNumber;
}

export interface ThroughputReport {
  campaignId: string;
  unitsPerHour: EvidenceNumber;
  sessionDurations: DurationBreakdown;
  queueTime: DurationBreakdown;
  maxObservedConcurrency: EvidenceNumber;
  /** What was actually observed, beside what was only ever declared. */
  concurrency: {
    observed: EvidenceNumber;
    declared: EvidenceNumber;
  };
  /** UNKNOWN with a null value whenever no session has ever run for this campaign. */
  ceiling: EvidenceNumber;
  rateLimited: {
    sessions: EvidenceNumber;
    deferredMs: EvidenceNumber;
  };
  perWorker: ThroughputBreakdownEntry[];
  perRole: ThroughputBreakdownEntry[];
  perAccountRef: ThroughputBreakdownEntry[];
}

function num(value: number | null, evidence: FactoryEvidenceClass, basis: string): EvidenceNumber {
  return { value, evidence, basis };
}

/** Two decimal places. A rate is derived, not exact, and does not need to pretend otherwise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function msToHours(ms: number): number {
  return ms / 3_600_000;
}

/**
 * The peak overlap `metrics.ts` measured, or the honest absence of one.
 *
 * `concurrencyEvidence` is already `UNKNOWN` exactly when no session has ever
 * run for the campaign — `maxOverlap([])` would otherwise report `0`, which is
 * a measurement this campaign never took.
 */
function observedConcurrency(metrics: CampaignMetrics): EvidenceNumber {
  if (metrics.concurrencyEvidence === 'UNKNOWN') {
    return num(
      null,
      'UNKNOWN',
      `no factory_sessions rows have ever run for campaign ${metrics.campaignId}, so no concurrency peak has been observed`,
    );
  }
  return num(
    metrics.maxObservedConcurrency,
    'MEASURED',
    `peak overlap of factory_sessions start/end intervals for campaign ${metrics.campaignId} (metrics.maxOverlap)`,
  );
}

function topUnitsPerHour(metrics: CampaignMetrics): EvidenceNumber {
  if (metrics.wallClockMs <= 0) {
    return num(
      null,
      'UNKNOWN',
      `no measured wall-clock span for campaign ${metrics.campaignId} (the factory_events.at range is empty or zero-width)`,
    );
  }
  const rate = metrics.integration.merged / msToHours(metrics.wallClockMs);
  return num(
    round2(rate),
    'DERIVED',
    `factory_integrations rows with outcome MERGED (${metrics.integration.merged}) divided by wall-clock hours spanned by factory_events.at for campaign ${metrics.campaignId} (${metrics.wallClockMs}ms)`,
  );
}

function topSessionDurations(metrics: CampaignMetrics): DurationBreakdown {
  return {
    total: num(
      metrics.executionMs.total,
      'MEASURED',
      `sum of factory_sessions.duration_ms over sessions with a recorded duration in campaign ${metrics.campaignId}`,
    ),
    samples: num(
      metrics.executionMs.samples,
      'MEASURED',
      `count of factory_sessions rows with a recorded duration_ms in campaign ${metrics.campaignId}`,
    ),
    average:
      metrics.executionMs.averageMs !== null
        ? num(
            metrics.executionMs.averageMs,
            'DERIVED',
            `total measured session duration divided by sample count in campaign ${metrics.campaignId}`,
          )
        : num(
            null,
            'UNKNOWN',
            `no factory_sessions row in campaign ${metrics.campaignId} has a recorded duration_ms`,
          ),
  };
}

function topQueueTime(metrics: CampaignMetrics): DurationBreakdown {
  return {
    total: num(
      metrics.queueMs.total,
      'MEASURED',
      `sum of ms between each unit's UNIT_READY and its first UNIT_CLAIMED factory_events row in campaign ${metrics.campaignId}`,
    ),
    samples: num(
      metrics.queueMs.samples,
      'MEASURED',
      `count of units in campaign ${metrics.campaignId} with both a UNIT_READY and a UNIT_CLAIMED event`,
    ),
    average:
      metrics.queueMs.averageMs !== null
        ? num(
            metrics.queueMs.averageMs,
            'DERIVED',
            `total queue time divided by sample count in campaign ${metrics.campaignId}`,
          )
        : num(
            null,
            'UNKNOWN',
            `no unit in campaign ${metrics.campaignId} has both a UNIT_READY and a UNIT_CLAIMED event`,
          ),
  };
}

/**
 * Duration stats for one worker, role or account.
 *
 * `metrics.ts`'s `byWorker`/`byRole` sum every session's duration (treating an
 * unfinished session's null as 0) and count every session attributed to the
 * group, rather than only the subset with a measured duration the way the
 * campaign-level `executionMs` does. That is the finest grain available without
 * re-sweeping rows this module must not recompute, so the total is still a
 * direct sum of real column values — never invented — and the basis says so.
 */
function entryDurationBreakdown(totalDurationMs: number, sessionCount: number, subject: string): DurationBreakdown {
  return {
    total: num(
      totalDurationMs,
      'MEASURED',
      `sum of factory_sessions.duration_ms for ${subject} (a session with no recorded duration contributes 0)`,
    ),
    samples: num(sessionCount, 'MEASURED', `count of factory_sessions rows for ${subject}`),
    average:
      sessionCount > 0
        ? num(
            Math.round(totalDurationMs / sessionCount),
            'DERIVED',
            `total duration divided by session count for ${subject}`,
          )
        : num(null, 'UNKNOWN', `no factory_sessions rows for ${subject}`),
  };
}

function entryUnitsMerged(mergedCount: number | null, subject: string): EvidenceNumber {
  if (mergedCount === null) {
    return num(
      null,
      'UNKNOWN',
      `campaignMetrics does not attribute first-pass merges to ${subject}`,
    );
  }
  return num(
    mergedCount,
    'DERIVED',
    `units attributed to ${subject} that merged on their first attempt (byWorker[].firstPassMerged, matching factory_integrations to factory_work_units)`,
  );
}

function entryUnitsPerHour(
  mergedCount: number | null,
  totalDurationMs: number,
  subject: string,
): EvidenceNumber {
  if (mergedCount === null || totalDurationMs <= 0) {
    return num(
      null,
      'UNKNOWN',
      `no measured session time or first-pass-merge attribution for ${subject} to derive a rate from`,
    );
  }
  return num(
    round2(mergedCount / msToHours(totalDurationMs)),
    'DERIVED',
    `first-pass merges attributed to ${subject} divided by that subject's measured session hours`,
  );
}

function perWorkerBreakdown(metrics: CampaignMetrics): ThroughputBreakdownEntry[] {
  return metrics.byWorker.map((worker) => {
    const subject = `worker ${worker.workerId} in campaign ${metrics.campaignId}`;
    return {
      id: worker.workerId,
      accountRef: worker.accountRef,
      sessions: num(worker.sessions, 'MEASURED', `count of factory_sessions rows for ${subject}`),
      sessionDurations: entryDurationBreakdown(worker.totalDurationMs, worker.sessions, subject),
      unitsMerged: entryUnitsMerged(worker.firstPassMerged, subject),
      unitsPerHour: entryUnitsPerHour(worker.firstPassMerged, worker.totalDurationMs, subject),
    };
  });
}

function perRoleBreakdown(metrics: CampaignMetrics): ThroughputBreakdownEntry[] {
  return metrics.byRole.map((role) => {
    const subject = `role ${role.role} in campaign ${metrics.campaignId}`;
    return {
      id: role.role,
      accountRef: null,
      sessions: num(role.sessions, 'MEASURED', `count of factory_sessions rows for ${subject}`),
      sessionDurations: entryDurationBreakdown(role.totalDurationMs, role.sessions, subject),
      // RoleMetrics carries no unit-merge attribution: a role is not a worker,
      // and campaignMetrics never invents the mapping from a role to the units
      // its sessions happened to touch.
      unitsMerged: entryUnitsMerged(null, subject),
      unitsPerHour: entryUnitsPerHour(null, role.totalDurationMs, subject),
    };
  });
}

/**
 * Grouped from `byWorker`, never from a worker's own declared account.
 *
 * `metrics.ts` populates `WorkerMetrics.accountRef` from `factory_sessions.account_ref`
 * — the value recorded on the session row at the moment it was opened — so
 * grouping by it here still traces back to session rows rather than to
 * whatever a worker currently claims about itself.
 */
function perAccountRefBreakdown(metrics: CampaignMetrics): ThroughputBreakdownEntry[] {
  const byAccount = new Map<string, { sessions: number; totalDurationMs: number; firstPassMerged: number }>();
  for (const worker of metrics.byWorker) {
    const existing = byAccount.get(worker.accountRef) ?? {
      sessions: 0,
      totalDurationMs: 0,
      firstPassMerged: 0,
    };
    existing.sessions += worker.sessions;
    existing.totalDurationMs += worker.totalDurationMs;
    existing.firstPassMerged += worker.firstPassMerged;
    byAccount.set(worker.accountRef, existing);
  }

  return [...byAccount.entries()].map(([accountRef, agg]) => {
    const subject = `account ${accountRef} in campaign ${metrics.campaignId}`;
    return {
      id: accountRef,
      accountRef,
      sessions: num(
        agg.sessions,
        'MEASURED',
        `sum of factory_sessions rows across workers whose account_ref is ${accountRef}`,
      ),
      sessionDurations: entryDurationBreakdown(agg.totalDurationMs, agg.sessions, subject),
      unitsMerged: entryUnitsMerged(agg.firstPassMerged, subject),
      unitsPerHour: entryUnitsPerHour(agg.firstPassMerged, agg.totalDurationMs, subject),
    };
  });
}

/**
 * The computation, separated from the read — so a test can hand it a recorded
 * `CampaignMetrics` and assert the evidence classes without a database.
 *
 * Contains no arithmetic involving a declared concurrency number: the
 * `concurrency.declared` field this function produces is always `UNKNOWN` with
 * no value, because a pure computation over swept rows has no campaign row to
 * read a declared target from. `throughputReport` fills it in afterward, purely
 * for display — never for a calculation.
 */
export function computeThroughput(metrics: CampaignMetrics): ThroughputReport {
  const observed = observedConcurrency(metrics);
  return {
    campaignId: metrics.campaignId,
    unitsPerHour: topUnitsPerHour(metrics),
    sessionDurations: topSessionDurations(metrics),
    queueTime: topQueueTime(metrics),
    maxObservedConcurrency: observed,
    concurrency: {
      observed,
      declared: num(
        null,
        'UNKNOWN',
        'no factory_campaigns row was supplied to this pure computation; throughputReport fills this in from lane_target',
      ),
    },
    ceiling: observed,
    rateLimited: {
      sessions: num(
        metrics.sessions.rateLimited,
        'PROVIDER_ENFORCED',
        `count of factory_sessions rows with state=RATE_LIMITED in campaign ${metrics.campaignId}`,
      ),
      deferredMs: num(
        metrics.rateLimitedMs,
        'PROVIDER_ENFORCED',
        `ms between a UNIT_DEFERRED factory_event and the deferred unit's next UNIT_CLAIMED event, summed over campaign ${metrics.campaignId}`,
      ),
    },
    perWorker: perWorkerBreakdown(metrics),
    perRole: perRoleBreakdown(metrics),
    perAccountRef: perAccountRefBreakdown(metrics),
  };
}

/**
 * Read the campaign's rows and report its throughput.
 *
 * An unknown campaign id sweeps zero rows from every repository `campaignMetrics`
 * reads, which `computeThroughput` already renders as an all-`UNKNOWN` shape —
 * so this never throws for one, and there is no special case to maintain here.
 */
export async function throughputReport(campaignId: string): Promise<ThroughputReport> {
  const metrics = await campaignMetrics(campaignId);
  const report = computeThroughput(metrics);
  const campaign = await getCampaign(campaignId);
  if (!campaign) return report;
  return {
    ...report,
    concurrency: {
      ...report.concurrency,
      declared: num(
        campaign.laneTarget,
        'UNKNOWN',
        `factory_campaigns.lane_target for campaign ${campaignId} — a declared target, never evidence of what actually ran concurrently`,
      ),
    },
  };
}
