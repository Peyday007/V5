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
 *
 * `maxObservedConcurrency` and `ceiling` answer different questions and must
 * never share a value by construction. The first is a peak overlap — evidence
 * that the fleet ran at least that many sessions at once, nothing more. The
 * second is a claim that the fleet could not run any *more* than that, which
 * only a provider refusal can establish: a peak nothing ever refused is a
 * fact about what happened, not a fact about a limit. So `ceiling` is
 * `UNKNOWN` with a null value unless a `RATE_LIMITED` session is on record for
 * the campaign, in which case it is the observed peak, labelled
 * `PROVIDER_ENFORCED` rather than `MEASURED` — the evidence for the *ceiling*
 * claim is the refusal, not the overlap sweep.
 */
import { getCampaign } from '../../repos/factory.ts';
import type { FactoryEvidenceClass } from '../../domain/factory.ts';
import { campaignBinFacts, campaignMetrics, FACTORY_EVENT_KINDS, maxOverlap, type BinFact, type CampaignMetrics } from './metrics.ts';
import { listFactoryEvents } from '../../repos/factoryFleet.ts';
import type { FactoryEvent } from '../../domain/factory.ts';
import type { Bin, BinDispatch } from '../../domain/types.ts';
import { listBins, listDispatchesForBin } from '../../repos/bins.ts';
import { fleetSnapshot, type FleetSnapshot } from '../dispatch/candidates.ts';
import { routeBin, type RoutingCandidate } from '../dispatch/router.ts';

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
  /**
   * Peak overlap of this entry's own sessions, swept by `computeMetrics`.
   *
   * Present on every entry because it is genuinely attributable: a session row
   * carries the worker, the role and the account it ran under, so the sweep has
   * everything it needs. A campaign-level peak alone cannot say whether four at
   * once was four lanes on one account or one lane on four.
   */
  maxObservedConcurrency: EvidenceNumber;
  /**
   * Always `UNKNOWN`, and present rather than absent on purpose.
   *
   * Queue time is a property of a *unit* — how long it waited between becoming
   * ready and being leased — and the worker that eventually took it did not
   * exist as far as that interval is concerned. `campaignMetrics` therefore
   * attributes queueing to the campaign and to nothing narrower, and the honest
   * report of a figure nobody measured is the figure with `UNKNOWN` on it and a
   * basis saying why, not a missing field a reader might mistake for zero.
   */
  queueTime: DurationBreakdown;
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
  /** Where the campaign's time went, stage by stage. Every figure is null when its rows do not exist. */
  stages: StageLatency;
}

export interface QueueDelay {
  average: EvidenceNumber;
  max: EvidenceNumber;
  samples: number;
}

export interface StageLatency {
  planDurationMs: EvidenceNumber;
  timeToFirstCodingMs: EvidenceNumber;
  /** Per bin kind: READY to first lease. */
  queueDelayByKind: Record<string, QueueDelay>;
  integrationDelayMs: EvidenceNumber;
  reviewDelayMs: EvidenceNumber;
  concurrentUnitBinsMax: EvidenceNumber;
  unitsPerHour: EvidenceNumber;
  completionMs: EvidenceNumber;
}

export interface StageInput {
  campaignId: string;
  campaignCreatedAt: string | null;
  /** The campaign's terminal instant, when it has one. */
  completedAt: string | null;
  bins: BinFact[];
  events: Pick<FactoryEvent, 'kind' | 'at'>[];
  integratedUnits: number;
  now: Date;
}

const NOT_MEASURED = 'not measured';
const missing = (why: string): EvidenceNumber => ({ value: null, evidence: 'UNKNOWN', basis: `${NOT_MEASURED}: ${why}` });
const gap = (from: string | null, to: string | null): number | null => {
  if (!from || !to) return null;
  const v = Date.parse(to) - Date.parse(from);
  return Number.isFinite(v) && v >= 0 ? v : null;
};
const measured = (v: number | null, basis: string, why: string, evidence: FactoryEvidenceClass = 'MEASURED'): EvidenceNumber =>
  v === null ? missing(why) : { value: v, evidence, basis };

/** Pure: the stage block from recorded bins and events. */
export function computeStages(input: StageInput): StageLatency {
  const id = input.campaignId;
  const firstEvent = (kind: string) => input.events.filter((e) => e.kind === kind).map((e) => e.at).sort()[0] ?? null;
  const byKind = (kind: string) => input.bins.filter((b) => b.kind === kind);
  const earliest = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort()[0] ?? null;
  const latest = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

  const planBin = byKind('FACTORY_PLAN')[0] ?? null;
  const planDuration = gap(planBin?.createdAt ?? null, firstEvent(FACTORY_EVENT_KINDS.planInstalled));
  const firstCoding = gap(input.campaignCreatedAt, earliest(byKind('FACTORY_UNITS').map((b) => b.firstLeaseAt)));

  const queueDelayByKind: Record<string, QueueDelay> = {};
  for (const kind of [...new Set(input.bins.map((b) => b.kind))].sort()) {
    const delays = byKind(kind).map((b) => gap(b.readyAt, b.firstLeaseAt)).filter((d): d is number => d !== null);
    const basis = `bin_events BIN_READY to first BIN_ASSIGNED/BIN_TAKEOVER, ${kind} bins of campaign ${id}`;
    const why = `no ${kind} bin of campaign ${id} has both a BIN_READY and a lease event`;
    queueDelayByKind[kind] = {
      samples: delays.length,
      average: delays.length ? { value: Math.round(delays.reduce((a, b) => a + b, 0) / delays.length), evidence: 'DERIVED', basis } : missing(why),
      max: delays.length ? { value: Math.max(...delays), evidence: 'MEASURED', basis } : missing(why),
    };
  }

  const integrationDelay = gap(firstEvent(FACTORY_EVENT_KINDS.unitImplemented), earliest(byKind('FACTORY_INTEGRATE').map((b) => b.firstLeaseAt)));
  const reviewDelay = gap(latest(byKind('FACTORY_INTEGRATE').map((b) => b.lastEndAt)), earliest(byKind('FACTORY_REVIEW').map((b) => b.firstLeaseAt)));

  const now = input.now.getTime();
  const holds = byKind('FACTORY_UNITS').flatMap((b) => b.holds).map((h) => ({ start: Date.parse(h.start), end: h.end ? Date.parse(h.end) : now }));
  const span = gap(input.campaignCreatedAt, input.completedAt ?? input.now.toISOString());
  const rate = span !== null && span > 0 && input.integratedUnits > 0 ? Math.round((input.integratedUnits / (span / 3_600_000)) * 100) / 100 : null;

  return {
    planDurationMs: measured(planDuration, `plan bin created to first PLAN_INSTALLED event, campaign ${id}`, `campaign ${id} has no plan bin or no PLAN_INSTALLED event`),
    timeToFirstCodingMs: measured(firstCoding, `campaign created to the first FACTORY_UNITS bin's first lease, campaign ${id}`, `campaign ${id} has no FACTORY_UNITS bin that was ever leased`),
    queueDelayByKind,
    integrationDelayMs: measured(integrationDelay, `first UNIT_IMPLEMENTED to the first FACTORY_INTEGRATE lease, campaign ${id}`, `campaign ${id} has no UNIT_IMPLEMENTED event or no leased integrate bin`),
    reviewDelayMs: measured(reviewDelay, `last FACTORY_INTEGRATE hold end to the first FACTORY_REVIEW lease, campaign ${id}`, `campaign ${id} has no finished integrate bin or no leased review bin`),
    concurrentUnitBinsMax: holds.length ? { value: maxOverlap(holds), evidence: 'MEASURED', basis: `peak overlap of FACTORY_UNITS bin lease intervals in bin_events, campaign ${id}` } : missing(`no FACTORY_UNITS bin of campaign ${id} was ever leased`),
    unitsPerHour: rate === null ? missing(`campaign ${id} has no integrated unit or no elapsed time`) : { value: rate, evidence: 'DERIVED', basis: `${input.integratedUnits} integrated unit(s) over campaign ${id}'s creation-to-${input.completedAt ? 'completion' : 'now'} span` },
    completionMs: input.completedAt ? measured(gap(input.campaignCreatedAt, input.completedAt), `campaign ${id} created to completed`, 'no creation time') : missing(`campaign ${id} has not completed`),
  };
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

/**
 * The concurrency ceiling actually enforced, or the honest absence of one.
 *
 * A peak overlap is not a ceiling by itself — it is evidence of what ran, not
 * evidence of what was refused. The only rows that establish a provider
 * actually stopped the fleet from running more concurrently are the
 * `RATE_LIMITED` sessions counted in `metrics.sessions.rateLimited`. With none
 * on record, no ceiling has ever been reached, whatever the peak overlap was —
 * so this returns `UNKNOWN` with a null value even when `observed` is a real
 * number. With at least one, the peak overlap is reported as the ceiling, but
 * under `PROVIDER_ENFORCED`: the number is the same sweep, the evidence for
 * *this* claim is the refusal that makes the peak into a limit.
 */
function ceilingEvidence(metrics: CampaignMetrics, observed: EvidenceNumber): EvidenceNumber {
  // No session has ever run: `observed` is already UNKNOWN with a null value,
  // and there is no separate absence-of-a-ceiling to report — it is the same
  // absence of evidence, not a second one with its own wording.
  if (metrics.concurrencyEvidence === 'UNKNOWN') return observed;
  if (metrics.sessions.rateLimited <= 0) {
    return num(
      null,
      'UNKNOWN',
      `no factory_sessions row with state=RATE_LIMITED has ever been recorded for campaign ${metrics.campaignId}, so no concurrency ceiling has been reached — the peak overlap observed (${observed.value}) is not evidence of a limit`,
    );
  }
  return num(
    observed.value,
    'PROVIDER_ENFORCED',
    `campaign ${metrics.campaignId} has ${metrics.sessions.rateLimited} factory_sessions row(s) with state=RATE_LIMITED, so the peak overlap actually observed (metrics.maxOverlap) is evidence the fleet was stopped from running more concurrently`,
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

/**
 * Queue time for one entry: never measured, always said so.
 *
 * The shape matches the campaign-level breakdown exactly so a reader can put
 * the two side by side, and every field carries the same reason: queueing
 * happened to a unit before any of these subjects held it.
 */
function entryQueueTime(subject: string): DurationBreakdown {
  const basis =
    `campaignMetrics attributes queue time to a unit's wait between READY and LEASED, ` +
    `which is not a property of ${subject}; no row attributes it this narrowly`;
  return {
    total: num(null, 'UNKNOWN', basis),
    samples: num(null, 'UNKNOWN', basis),
    average: num(null, 'UNKNOWN', basis),
  };
}

/**
 * This entry's own peak overlap, from `computeMetrics`' sweep.
 *
 * `MEASURED` when the subject ran at all, because the number is the result of
 * sweeping real session intervals. A subject with no sessions reports `UNKNOWN`
 * with a null value rather than zero, for the reason the campaign-level figure
 * gives: the absence of a session is not a measurement of one.
 */
function entryConcurrency(peak: number, sessionCount: number, subject: string): EvidenceNumber {
  if (sessionCount <= 0) {
    return num(null, 'UNKNOWN', `no factory_sessions rows for ${subject} to sweep for overlap`);
  }
  return num(
    peak,
    'MEASURED',
    `peak overlap of the factory_sessions start/end intervals belonging to ${subject}`,
  );
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
      maxObservedConcurrency: entryConcurrency(worker.maxConcurrency, worker.sessions, subject),
      queueTime: entryQueueTime(subject),
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
      maxObservedConcurrency: entryConcurrency(role.maxConcurrency, role.sessions, subject),
      queueTime: entryQueueTime(subject),
    };
  });
}

/**
 * Grouped from the session rows, by the account each one recorded.
 *
 * This used to be grouped from `byWorker`, whose account is whatever a worker's
 * *first* session recorded — so on fcp_189ea30c7ded4e7b9280 three sessions that
 * recorded UNKNOWN were counted under "Brain Research A", and the block said 13
 * sessions beside a peak overlap swept from the 10 that really were. Every
 * figure in one block now comes from one set of rows.
 *
 * A first-pass merge is credited to an account only when every session of the
 * worker that merged it recorded that account. A worker spanning two accounts
 * leaves the merge unattributable, which is `UNKNOWN` rather than a guess.
 */
function perAccountRefBreakdown(metrics: CampaignMetrics): ThroughputBreakdownEntry[] {
  const accountsOfWorker = new Map<string, Set<string>>();
  for (const [accountRef, entry] of Object.entries(metrics.sessionsByAccountRef)) {
    for (const workerId of entry.workerIds) {
      const set = accountsOfWorker.get(workerId) ?? new Set<string>();
      set.add(accountRef);
      accountsOfWorker.set(workerId, set);
    }
  }
  const byAccount = new Map<string, { sessions: number; totalDurationMs: number; firstPassMerged: number | null }>();
  for (const [accountRef, entry] of Object.entries(metrics.sessionsByAccountRef)) {
    let merged: number | null = 0;
    for (const workerId of entry.workerIds) {
      const worker = metrics.byWorker.find((candidate) => candidate.workerId === workerId);
      if (!worker || worker.firstPassMerged === 0) continue;
      if ((accountsOfWorker.get(workerId)?.size ?? 0) !== 1) {
        merged = null;
        break;
      }
      merged += worker.firstPassMerged;
    }
    byAccount.set(accountRef, {
      sessions: entry.sessions,
      totalDurationMs: entry.totalDurationMs,
      firstPassMerged: merged,
    });
  }

  return [...byAccount.entries()].map(([accountRef, agg]) => {
    const subject = `account ${accountRef} in campaign ${metrics.campaignId}`;
    return {
      id: accountRef,
      accountRef,
      sessions: num(
        agg.sessions,
        'MEASURED',
        `count of factory_sessions rows that recorded account_ref ${accountRef}`,
      ),
      sessionDurations: entryDurationBreakdown(agg.totalDurationMs, agg.sessions, subject),
      unitsMerged: entryUnitsMerged(agg.firstPassMerged, subject),
      unitsPerHour: entryUnitsPerHour(agg.firstPassMerged, agg.totalDurationMs, subject),
      // From the sweep's own per-account map, never from the maximum of this
      // account's workers' peaks: two workers each peaking at one, at the same
      // moment, is an account peak of two.
      maxObservedConcurrency: entryConcurrency(
        metrics.maxConcurrencyByAccountRef[accountRef] ?? 0,
        agg.sessions,
        subject,
      ),
      queueTime: entryQueueTime(subject),
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
export function computeThroughput(metrics: CampaignMetrics, stages?: StageLatency): ThroughputReport {
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
    ceiling: ceilingEvidence(metrics, observed),
    rateLimited: {
      sessions: num(
        metrics.sessions.rateLimited,
        'PROVIDER_ENFORCED',
        `count of factory_sessions rows with state=RATE_LIMITED in campaign ${metrics.campaignId}`,
      ),
      deferredMs: num(
        metrics.rateLimitedMs,
        'MEASURED',
        `ms between a UNIT_DEFERRED factory_event and the deferred unit's next UNIT_CLAIMED event, summed over campaign ${metrics.campaignId} — Brain's own clock over its own factory_events rows, not a provider-reported duration`,
      ),
    },
    perWorker: perWorkerBreakdown(metrics),
    perRole: perRoleBreakdown(metrics),
    perAccountRef: perAccountRefBreakdown(metrics),
    stages: stages ?? computeStages({ campaignId: metrics.campaignId, campaignCreatedAt: null, completedAt: null, bins: [], events: [], integratedUnits: 0, now: new Date(0) }),
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
  const campaign = await getCampaign(campaignId);
  const [bins, events] = await Promise.all([campaignBinFacts(campaignId), listFactoryEvents(campaignId, { limit: 5000 })]);
  const stages = computeStages({
    campaignId,
    campaignCreatedAt: campaign?.createdAt ?? null,
    completedAt: campaign?.state === 'COMPLETE' ? campaign.finishedAt : null,
    bins,
    events,
    integratedUnits: metrics.units.integrated,
    now: new Date(),
  });
  const report = computeThroughput(metrics, stages);
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

/* ---------------------------------------------------------------------------
 * Why is ready work not moving?
 *
 * A reading of the fleet that composes what already decides it — `fleetSnapshot`
 * for the surfaces and `routeBin` for the verdict on each waiting bin — and
 * re-derives no eligibility of its own. It decides nothing and writes nothing.
 * ------------------------------------------------------------------------- */

export type SurfaceStatus = 'QUARANTINED' | 'RATE_LIMITED' | 'IN_FLIGHT' | 'IDLE';

export interface IdleBin {
  binId: string;
  kind: string;
  campaignId: string | null;
  waitedMs: number | null;
  /** The newest dispatch row's refusal, as recorded when it was written. */
  dispatch: { state: string; lastErrorKind: string | null; lastError: string | null } | null;
  /** What `routeBin` says about this bin against the fleet now. */
  routing: { ok: true; routine: string } | { ok: false; refusal: string; reason: string; retryAt: string | null };
  fleet: { inFlight: number; target: number | null; factoryInFlight: number };
}

export interface IdleSurface {
  routineId: string;
  name: string;
  accountId: string;
  status: SurfaceStatus;
  inFlight: number;
  retryAt: string | null;
  stateReason: string | null;
}

export interface IdleReading {
  at: string;
  bins: IdleBin[];
  surfaces: IdleSurface[];
}

export interface IdleInput {
  now: Date;
  bins: { bin: Bin; dispatches: BinDispatch[] }[];
  snapshot: FleetSnapshot;
}

export function surfaceStatus(candidate: RoutingCandidate, nowIso: string): SurfaceStatus {
  const { routine, account, routineInFlight } = candidate;
  if (routine.state === 'QUARANTINED') return 'QUARANTINED';
  const until = [routine.retryAt, account.retryAt].filter((t): t is string => !!t && t > nowIso).sort().at(-1);
  if (until) return 'RATE_LIMITED';
  return routineInFlight > 0 ? 'IN_FLIGHT' : 'IDLE';
}

/** Pure: the reading from bins, their dispatches and a fleet snapshot. */
export function computeIdle(input: IdleInput): IdleReading {
  const nowIso = input.now.toISOString();
  const { snapshot } = input;
  const bins: IdleBin[] = input.bins.map(({ bin, dispatches }) => {
    const since = bin.readyAt ?? bin.createdAt;
    const waited = Date.parse(nowIso) - Date.parse(since);
    const newest = dispatches.at(-1) ?? null;
    const decision = routeBin({
      bin,
      candidates: snapshot.candidates,
      fleetPolicy: snapshot.fleetPolicy,
      fleetInFlight: snapshot.fleetInFlight,
      factoryInFlight: snapshot.factoryInFlight,
      now: nowIso,
    });
    return {
      binId: bin.id,
      kind: bin.kind,
      campaignId: bin.factoryCampaignId,
      waitedMs: Number.isFinite(waited) && waited >= 0 ? waited : null,
      dispatch: newest ? { state: newest.state, lastErrorKind: newest.lastErrorKind, lastError: newest.lastError } : null,
      routing: decision.ok
        ? { ok: true, routine: decision.routine.name }
        : { ok: false, refusal: decision.refusal, reason: decision.reason, retryAt: decision.retryAt },
      fleet: { inFlight: snapshot.fleetInFlight, target: snapshot.fleetPolicy?.target ?? null, factoryInFlight: snapshot.factoryInFlight },
    };
  });
  const surfaces: IdleSurface[] = snapshot.candidates.map((c) => {
    const status = surfaceStatus(c, nowIso);
    const retryAt = [c.routine.retryAt, c.account.retryAt].filter((t): t is string => !!t && t > nowIso).sort().at(-1) ?? null;
    return {
      routineId: c.routine.id,
      name: c.routine.name,
      accountId: c.account.id,
      status,
      inFlight: c.routineInFlight,
      retryAt: status === 'RATE_LIMITED' ? retryAt : null,
      stateReason: status === 'QUARANTINED' ? c.routine.stateReason : null,
    };
  });
  return { at: nowIso, bins: bins.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1)), surfaces };
}

/** Read every READY factory bin and the fleet now, and report why each is or is not moving. */
export async function idleReading(now = new Date()): Promise<IdleReading> {
  const ready = (await listBins({ states: ['READY'], limit: 500 })).filter((b) => b.kind.startsWith('FACTORY') || b.factoryCampaignId !== null);
  const bins = await Promise.all(ready.map(async (bin) => ({ bin, dispatches: await listDispatchesForBin(bin.id) })));
  return computeIdle({ now, bins, snapshot: await fleetSnapshot(now) });
}
