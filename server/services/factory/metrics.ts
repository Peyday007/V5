/**
 * What the factory actually did, counted from rows.
 *
 * Every number here is derived from `factory_events`, `factory_sessions`,
 * `factory_integrations` and the units themselves. There is no metrics table,
 * deliberately: two tables that must agree about the same fires is a design
 * where the one nobody reads is the one that drifts, and §23 paid for that
 * lesson in production once already.
 *
 * The other rule this module exists to keep is the honesty requirement.
 * `maxObservedConcurrency` is the largest number of sessions that were genuinely
 * running at the same instant, computed by sweeping their start and end times —
 * never the sum of declared concurrency, which is a projection. Where something
 * has not been observed it is reported as unknown rather than as zero, because
 * zero is a measurement and unknown is not.
 */
import type {
  FactoryEvent,
  FactoryIntegration,
  FactorySession,
  FactoryWorkUnit,
} from '../../domain/factory.ts';
import {
  listFactoryEvents,
  listFindings,
  listIntegrations,
  listReviews,
  listSessions,
} from '../../repos/factoryFleet.ts';
import { listUnits } from '../../repos/factory.ts';

/** The event vocabulary. One constant, so a reader of the ledger is not guessing. */
export const FACTORY_EVENT_KINDS = {
  campaignState: 'CAMPAIGN_STATE',
  unitPlanned: 'UNIT_PLANNED',
  unitReady: 'UNIT_READY',
  unitClaimed: 'UNIT_CLAIMED',
  unitTakeover: 'UNIT_TAKEOVER',
  unitImplemented: 'UNIT_IMPLEMENTED',
  unitFailed: 'UNIT_FAILED',
  unitDeferred: 'UNIT_DEFERRED',
  unitRefused: 'UNIT_REFUSED',
  unitCancelled: 'UNIT_CANCELLED',
  sessionStarted: 'SESSION_STARTED',
  sessionFinished: 'SESSION_FINISHED',
  sessionRateLimited: 'SESSION_RATE_LIMITED',
  verificationRan: 'VERIFICATION_RAN',
  integrationMerged: 'INTEGRATION_MERGED',
  integrationRejected: 'INTEGRATION_REJECTED',
  integrationConflict: 'INTEGRATION_CONFLICT',
  reviewCompleted: 'REVIEW_COMPLETED',
  findingRecorded: 'FINDING_RECORDED',
  repairQueued: 'REPAIR_QUEUED',
  findingResolved: 'FINDING_RESOLVED',
  laneTargetChanged: 'LANE_TARGET_CHANGED',
  prAssembled: 'PR_ASSEMBLED',
  writeback: 'BRAIN_WRITEBACK',
  releaseRequested: 'RELEASE_REQUESTED',
  staleBase: 'STALE_BASE_DETECTED',
  rebased: 'CAMPAIGN_REBASED',
} as const;

export interface RoleMetrics {
  role: string;
  sessions: number;
  finished: number;
  failed: number;
  rateLimited: number;
  totalDurationMs: number;
}

export interface WorkerMetrics {
  workerId: string;
  accountRef: string;
  sessions: number;
  finished: number;
  failed: number;
  rateLimited: number;
  abandoned: number;
  totalDurationMs: number;
  /** Of the units this worker implemented, how many were merged on the first attempt. */
  firstPassMerged: number;
  attemptsSpent: number;
}

export interface CampaignMetrics {
  campaignId: string;
  /** Wall clock from the campaign's first event to its last, measured. */
  wallClockMs: number;
  units: {
    total: number;
    integrated: number;
    implemented: number;
    ready: number;
    blocked: number;
    leased: number;
    failed: number;
    cancelled: number;
  };
  /** READY to first claim, summed and averaged over units that were claimed. */
  queueMs: { total: number; samples: number; averageMs: number | null };
  /** Claim to implemented, over attempts that produced a branch. */
  executionMs: { total: number; samples: number; averageMs: number | null };
  /** Time units spent deferred by provider backpressure, not charged as failure. */
  rateLimitedMs: number;
  integration: {
    merged: number;
    rejected: number;
    conflicts: number;
    verificationFailed: number;
    totalMs: number;
  };
  verification: { ran: number; passed: number; failed: number };
  review: { rounds: number; findings: number; blockers: number; repairsQueued: number; repaired: number };
  attempts: { productive: number; wasted: number; refusalsNotCharged: number };
  firstPassSuccessRate: number | null;
  repairCycles: number;
  /**
   * The largest number of sessions genuinely running at one instant.
   *
   * MEASURED. Never the sum of declared concurrency — that is a projection, and
   * reporting it as throughput is how a fleet gets described by a number nobody
   * has seen.
   */
  maxObservedConcurrency: number;
  concurrencyEvidence: 'MEASURED' | 'UNKNOWN';
  sessions: { total: number; finished: number; failed: number; rateLimited: number; abandoned: number };
  byWorker: WorkerMetrics[];
  byRole: RoleMetrics[];
  /** Whether any execution reported using a paid model API. Counted, not assumed. */
  paidApiExecutions: number;
}

/**
 * Sweep session intervals and report the true maximum overlap.
 *
 * A session with no end is treated as running until now, which is the honest
 * reading while it is still going and the conservative one afterwards: a crashed
 * session that was never closed inflates nothing, because recovery closes it.
 */
export function maxOverlap(
  intervals: { start: number; end: number }[],
): number {
  const points: { at: number; delta: number }[] = [];
  for (const interval of intervals) {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end)) continue;
    points.push({ at: interval.start, delta: 1 });
    points.push({ at: Math.max(interval.end, interval.start), delta: -1 });
  }
  // Ends before starts at the same instant: two sessions that merely touched
  // were not concurrent, and counting them as concurrent would be the optimistic
  // reading this whole module refuses.
  points.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

function ms(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const value = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function campaignMetrics(campaignId: string): Promise<CampaignMetrics> {
  const [units, sessions, integrations, events, reviews, findings] = await Promise.all([
    listUnits(campaignId),
    listSessions(campaignId),
    listIntegrations(campaignId),
    listFactoryEvents(campaignId, { limit: 5000 }),
    listReviews(campaignId),
    listFindings(campaignId),
  ]);

  return computeMetrics({ campaignId, units, sessions, integrations, events, reviews, findings });
}

export interface MetricsInput {
  campaignId: string;
  units: FactoryWorkUnit[];
  sessions: FactorySession[];
  integrations: FactoryIntegration[];
  events: FactoryEvent[];
  reviews: { round: number; verdict: string }[];
  findings: { severity: string; state: string }[];
}

/**
 * The computation, separated from the reads.
 *
 * Pure, so a test can hand it a recorded snapshot and assert the numbers
 * without a database — and so "why does this campaign report that throughput" is
 * answerable from an input somebody kept rather than from a re-run against rows
 * that have since moved.
 */
export function computeMetrics(input: MetricsInput): CampaignMetrics {
  const { units, sessions, integrations, events } = input;
  const now = Date.now();

  const counts = {
    total: units.length,
    integrated: units.filter((u) => u.state === 'INTEGRATED').length,
    implemented: units.filter((u) => u.state === 'IMPLEMENTED').length,
    ready: units.filter((u) => u.state === 'READY').length,
    blocked: units.filter((u) => u.state === 'BLOCKED').length,
    leased: units.filter((u) => u.state === 'LEASED').length,
    failed: units.filter((u) => u.state === 'FAILED').length,
    cancelled: units.filter((u) => u.state === 'CANCELLED').length,
  };

  // Queue time: the gap between a unit being announced ready and first claimed.
  const readyAt = new Map<string, string>();
  const claimAt = new Map<string, string>();
  let rateLimitedMs = 0;
  let deferredFrom: Map<string, string> = new Map();
  let verificationRan = 0;
  let verificationPassed = 0;
  let repairCycles = 0;
  let refusalsNotCharged = 0;
  let integrationMs = 0;

  for (const event of events) {
    switch (event.kind) {
      case FACTORY_EVENT_KINDS.unitReady:
        if (event.unitId && !readyAt.has(event.unitId)) readyAt.set(event.unitId, event.at);
        break;
      case FACTORY_EVENT_KINDS.unitClaimed:
        if (event.unitId && !claimAt.has(event.unitId)) claimAt.set(event.unitId, event.at);
        break;
      case FACTORY_EVENT_KINDS.unitDeferred:
        if (event.unitId) deferredFrom.set(event.unitId, event.at);
        break;
      case FACTORY_EVENT_KINDS.verificationRan: {
        verificationRan += 1;
        if (event.detail['exitCode'] === 0) verificationPassed += 1;
        break;
      }
      case FACTORY_EVENT_KINDS.repairQueued:
        repairCycles += 1;
        break;
      case FACTORY_EVENT_KINDS.unitRefused:
        refusalsNotCharged += 1;
        break;
      case FACTORY_EVENT_KINDS.integrationMerged:
      case FACTORY_EVENT_KINDS.integrationRejected:
      case FACTORY_EVENT_KINDS.integrationConflict:
        integrationMs += event.durationMs ?? 0;
        break;
      default:
        break;
    }
    // A deferral ends at the next claim of the same unit.
    if (event.kind === FACTORY_EVENT_KINDS.unitClaimed && event.unitId) {
      const from = deferredFrom.get(event.unitId);
      if (from) {
        rateLimitedMs += ms(from, event.at);
        deferredFrom.delete(event.unitId);
      }
    }
  }
  // Still deferred: the clock is running.
  for (const [, from] of deferredFrom) {
    rateLimitedMs += Math.max(0, now - new Date(from).getTime());
  }

  let queueTotal = 0;
  let queueSamples = 0;
  for (const [unitId, ready] of readyAt) {
    const claimed = claimAt.get(unitId);
    if (!claimed) continue;
    queueTotal += ms(ready, claimed);
    queueSamples += 1;
  }

  let executionTotal = 0;
  let executionSamples = 0;
  for (const session of sessions) {
    if (session.durationMs === null) continue;
    executionTotal += session.durationMs;
    executionSamples += 1;
  }

  const byWorker = new Map<string, WorkerMetrics>();
  const byRole = new Map<string, RoleMetrics>();
  for (const session of sessions) {
    const worker =
      byWorker.get(session.workerId) ??
      ({
        workerId: session.workerId,
        accountRef: session.accountRef,
        sessions: 0,
        finished: 0,
        failed: 0,
        rateLimited: 0,
        abandoned: 0,
        totalDurationMs: 0,
        firstPassMerged: 0,
        attemptsSpent: 0,
      } satisfies WorkerMetrics);
    worker.sessions += 1;
    worker.totalDurationMs += session.durationMs ?? 0;
    worker.attemptsSpent += 1;
    if (session.state === 'FINISHED') worker.finished += 1;
    if (session.state === 'FAILED') worker.failed += 1;
    if (session.state === 'RATE_LIMITED') worker.rateLimited += 1;
    if (session.state === 'ABANDONED') worker.abandoned += 1;
    byWorker.set(session.workerId, worker);

    const role =
      byRole.get(session.role) ??
      ({
        role: session.role,
        sessions: 0,
        finished: 0,
        failed: 0,
        rateLimited: 0,
        totalDurationMs: 0,
      } satisfies RoleMetrics);
    role.sessions += 1;
    role.totalDurationMs += session.durationMs ?? 0;
    if (session.state === 'FINISHED') role.finished += 1;
    if (session.state === 'FAILED') role.failed += 1;
    if (session.state === 'RATE_LIMITED') role.rateLimited += 1;
    byRole.set(session.role, role);
  }

  // First-pass success: a unit merged on attempt 1 without a repair in between.
  const mergedByUnit = new Map<string, FactoryIntegration[]>();
  for (const integration of integrations) {
    const list = mergedByUnit.get(integration.unitId) ?? [];
    list.push(integration);
    mergedByUnit.set(integration.unitId, list);
  }
  let firstPass = 0;
  let merged = 0;
  for (const unit of units) {
    const attemptsForUnit = mergedByUnit.get(unit.id) ?? [];
    const mergedOnce = attemptsForUnit.find((i) => i.outcome === 'MERGED');
    if (!mergedOnce) continue;
    merged += 1;
    if (mergedOnce.attempt <= 1) {
      firstPass += 1;
      const session = sessions.find((s) => s.unitId === unit.id && s.attempt <= 1);
      if (session) {
        const worker = byWorker.get(session.workerId);
        if (worker) worker.firstPassMerged += 1;
      }
    }
  }

  const intervals = sessions.map((session) => ({
    start: new Date(session.startedAt).getTime(),
    end: session.endedAt ? new Date(session.endedAt).getTime() : now,
  }));

  const firstEvent = events[0]?.at ?? sessions[0]?.startedAt ?? null;
  const lastEvent = events[events.length - 1]?.at ?? null;

  const integrationCounts = {
    merged: integrations.filter((i) => i.outcome === 'MERGED').length,
    rejected: integrations.filter((i) => i.outcome === 'REJECTED').length,
    conflicts: integrations.filter((i) => i.outcome === 'CONFLICT').length,
    verificationFailed: integrations.filter((i) => i.outcome === 'VERIFICATION_FAILED').length,
    totalMs: integrationMs,
  };

  const attemptsSpent = units.reduce((sum, unit) => sum + unit.attempt, 0);
  const productive = integrationCounts.merged;

  return {
    campaignId: input.campaignId,
    wallClockMs: ms(firstEvent, lastEvent),
    units: counts,
    queueMs: {
      total: queueTotal,
      samples: queueSamples,
      averageMs: queueSamples > 0 ? Math.round(queueTotal / queueSamples) : null,
    },
    executionMs: {
      total: executionTotal,
      samples: executionSamples,
      averageMs: executionSamples > 0 ? Math.round(executionTotal / executionSamples) : null,
    },
    rateLimitedMs,
    integration: integrationCounts,
    verification: {
      ran: verificationRan,
      passed: verificationPassed,
      failed: verificationRan - verificationPassed,
    },
    review: {
      rounds: input.reviews.length,
      findings: input.findings.length,
      blockers: input.findings.filter((f) => f.severity === 'BLOCKER').length,
      repairsQueued: input.findings.filter((f) => f.state === 'REPAIR_QUEUED').length,
      repaired: input.findings.filter((f) => f.state === 'REPAIRED').length,
    },
    attempts: {
      productive,
      wasted: Math.max(0, attemptsSpent - productive),
      refusalsNotCharged,
    },
    firstPassSuccessRate: merged > 0 ? firstPass / merged : null,
    repairCycles,
    maxObservedConcurrency: maxOverlap(intervals),
    concurrencyEvidence: sessions.length > 0 ? 'MEASURED' : 'UNKNOWN',
    sessions: {
      total: sessions.length,
      finished: sessions.filter((s) => s.state === 'FINISHED').length,
      failed: sessions.filter((s) => s.state === 'FAILED').length,
      rateLimited: sessions.filter((s) => s.state === 'RATE_LIMITED').length,
      abandoned: sessions.filter((s) => s.state === 'ABANDONED').length,
    },
    byWorker: [...byWorker.values()],
    byRole: [...byRole.values()],
    paidApiExecutions: events.filter(
      (e) => e.kind === FACTORY_EVENT_KINDS.sessionFinished && e.detail['paidApi'] === true,
    ).length,
  };
}
