/**
 * Brain's own engineering throughput, measured from what the forge already
 * recorded (§115). Pure: every number is a function of the workflow runs, jobs,
 * merged pull requests and improvement decisions passed in, so "why is TEST the
 * limiting stage" is answerable from the recorded inputs.
 *
 * One cycle is one pull request merged into the canonical branch, followed to
 * the Deploy run that shipped it. Its stages are sequential and do not overlap,
 * so they add up to the cycle and the share of each is its share of the
 * critical path:
 *
 *   DEVELOPMENT       first commit on the branch (author date) → pull request opened
 *   INTEGRATION_WAIT  pull request opened → merged
 *   RELEASE_QUEUE     merged → the Deploy that shipped it was dispatched (dispatch latency,
 *                     plus every failed or cancelled Deploy in between)
 *   TEST              that Deploy dispatched → its "Deploy to Fly" job started (the CI gates
 *                     on the released commit: Deploy's tests and the Postgres evidence)
 *   RELEASE           "Deploy to Fly" started → its "Deploy" step completed
 *   VERIFICATION      "Deploy" step completed → the job completed (the live proofs)
 *
 * RELEASE_QUEUE + TEST + RELEASE is "merge → Deploy success". A Deploy "carries"
 * a merge when it was dispatched after it: Deploy checks out the canonical tip
 * at dispatch, so that is the release the merge first reached.
 *
 * An improvement is counted only when a measurement moved — an evolution
 * experiment ADOPTed on its suite, or an improvement candidate KEPT on its
 * metric (§87, §111). Pull requests are never counted as improvements.
 */

export const CYCLE_STAGES = ['DEVELOPMENT', 'INTEGRATION_WAIT', 'RELEASE_QUEUE', 'TEST', 'RELEASE', 'VERIFICATION'] as const;
export type CycleStage = (typeof CYCLE_STAGES)[number];

/** A limiting stage holding at least this share of critical-path time is recorded as a deficiency. */
export const LIMITING_SHARE_THRESHOLD = 0.4;
/** Fewer verified cycles than this and the reading names no limiting stage. */
export const MIN_CYCLES = 5;

/** Repository paths that own each stage, so a deficiency names its owner. */
export const STAGE_OWNERS: Record<CycleStage, string[]> = {
  DEVELOPMENT: ['server/services/factory/planner.ts', 'server/services/factory/scheduler.ts'],
  INTEGRATION_WAIT: ['.github/workflows/factory-release.yml', 'server/services/factory/release'],
  RELEASE_QUEUE: ['.github/workflows/deploy.yml', '.github/workflows/factory-release.yml'],
  TEST: ['.github/workflows/deploy.yml', '.github/workflows/postgres-suite.yml'],
  RELEASE: ['.github/workflows/deploy.yml'],
  VERIFICATION: ['.github/workflows/deploy.yml', '.github/workflows/hosted-verify.sh'],
};

/**
 * Competing corrections per stage. The most any correction to a stage can save
 * is the stage itself (its mean per cycle, which is what its share of the
 * critical path is made of); `reduction` is the share of it the correction is
 * assumed to remove, so every estimate says what it assumed. A correction with
 * `measuredBy` is estimated on the measured part it removes instead, times
 * `reduction`: TEST_SETUP is the setup steps of the test job that finished last,
 * POSTGRES_WAIT is Deploy's wait for the canonical push's Postgres suite when
 * that wait is what finished last.
 */
export type MeasuredPart = 'TEST_SETUP' | 'POSTGRES_WAIT';
export const STAGE_CORRECTIONS: Record<CycleStage, { correction: string; reduction: number; measuredBy?: MeasuredPart }[]> = {
  DEVELOPMENT: [
    { correction: 'split objectives into smaller independent pull requests run in parallel sessions', reduction: 0.3 },
  ],
  INTEGRATION_WAIT: [
    { correction: 'merge a reviewed, green pull request automatically under the standing release grant', reduction: 0.6 },
  ],
  RELEASE_QUEUE: [
    { correction: 'dispatch Deploy on every canonical push and coalesce merges into the newest tip', reduction: 0.7 },
    { correction: 'stop releases that fail by retrying the same commit; fix the failing gate first', reduction: 0.3 },
  ],
  TEST: [
    { correction: "cache the test jobs' setup (tooling install, npm ci) instead of installing per shard", reduction: 0.8, measuredBy: 'TEST_SETUP' },
    {
      correction: "shorten the canonical push's Postgres suite that Deploy waits on (rebalance or add shards; its slowest shard sets the wait)",
      reduction: 0.5,
      measuredBy: 'POSTGRES_WAIT',
    },
  ],
  RELEASE: [{ correction: 'deploy a prebuilt image instead of building during the deploy step', reduction: 0.4 }],
  VERIFICATION: [{ correction: 'run the two live verification passes concurrently, keeping both', reduction: 0.4 }],
};

/* ---- forge records, in the forge's own field names ------------------------ */

export interface ForgeRun {
  id: number;
  name: string;
  event?: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  updated_at: string;
  run_attempt?: number;
}
export interface ForgeStep {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}
export interface ForgeJob {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: ForgeStep[];
}
export interface ForgePull {
  number: number;
  created_at: string;
  merged_at: string | null;
  base: { ref: string };
}
export interface ForgeCommit {
  commit: { author?: { date?: string } | null; committer?: { date?: string } | null };
}

export interface CycleSources {
  repository: string;
  canonicalBranch: string;
  runs: ForgeRun[];
  /** Jobs (with steps) of every Deploy run, by run id. */
  jobs: Record<string, ForgeJob[]>;
  pulls: ForgePull[];
  /** Commits of each merged pull request, by number. */
  commits: Record<string, ForgeCommit[]>;
}

/** A measurement that moved: an evolution adoption or an improvement kept on its metric. */
export interface ImprovementMark {
  ref: string;
  kind: 'EVOLUTION_ADOPT' | 'IMPROVEMENT_KEPT';
  at: string;
}

/* ---- the reading ---------------------------------------------------------- */

export interface StageSummary {
  samples: number;
  medianHours: number | null;
  p90Hours: number | null;
  totalHours: number;
  /** Share of all verified cycles' critical-path time. */
  share: number;
}

export interface CycleRecord {
  pr: number;
  mergedAt: string;
  verifiedAt: string;
  deployRunId: number;
  totalHours: number;
  stages: Record<CycleStage, number>;
  testSetupHours: number;
  postgresWaitHours: number;
}

export interface CorrectionEstimate {
  stage: CycleStage;
  correction: string;
  /** Hours per cycle the correction is estimated to save. */
  estimatedHoursSaved: number;
  /** The most any correction to this stage can save per cycle (the stage's mean). */
  boundHours: number;
  assumption: string;
}

export interface CycleReading {
  repository: string;
  from: string;
  to: string;
  windowHours: number;
  /** Pull requests merged into the canonical branch in the window. */
  merged: number;
  /** Of those, the ones a successful Deploy shipped and verified. */
  verified: number;
  stages: Record<CycleStage, StageSummary>;
  cycleMedianHours: number | null;
  limitingStage: CycleStage | null;
  limitingShare: number | null;
  releases: { dispatched: number; shipped: number; failed: number; cancelled: number; rerun: number };
  concurrency: {
    /** Mean cycles open at once (Little's law over the window). */
    cyclesInFlight: number;
    /** Mean Deploy jobs running while any was running. */
    deployJobs: number | null;
  };
  improvements: { count: number; perHour: number; refs: string[] };
  /** Competing corrections, best estimate first. */
  corrections: CorrectionEstimate[];
  cycles: CycleRecord[];
}

const HOUR = 3_600_000;
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const hours = (a: number, b: number): number => Math.max(0, (b - a) / HOUR);
const round = (n: number, places = 3): number => Number(n.toFixed(places));

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export interface DeployFacts {
  runId: number;
  dispatchedAt: number;
  shipped: boolean;
  /** "Deploy to Fly" started: the test gates are done. */
  gatesDoneAt: number | null;
  deployedAt: number | null;
  completedAt: number | null;
  /** Setup steps (job set-up, checkout, node, tooling install, npm ci) of the test job that finished last. */
  testSetupHours: number;
  /** The test job that finished last: the one the deploy job waited for. */
  criticalTestJob: string | null;
  /** Deploy's wait for the Postgres evidence, when that wait finished last; else 0. */
  postgresWaitHours: number;
}

export const POSTGRES_WAIT_STEP = 'Wait for completed Postgres evidence';

/** Steps that prepare a job rather than test anything. */
export const SETUP_STEP = /^(Set up job|Run actions\/checkout|Run actions\/setup-node|Install |Run npm ci)/;

export const DEPLOY_JOB = 'Deploy to Fly';
export const DEPLOY_STEP = 'Deploy';

/** What one Deploy run's jobs say about it. A run ships when its deploy job and the run succeeded. */
export function deployFacts(run: ForgeRun, jobs: ForgeJob[]): DeployFacts {
  const job = jobs.find((one) => one.name === DEPLOY_JOB);
  const step = job?.steps?.find((one) => one.name === DEPLOY_STEP);
  const started = ms(job?.started_at);
  const completed = ms(job?.completed_at);
  const deployed = ms(step?.completed_at) ?? null;
  const critical = jobs
    .filter((one) => one.name !== DEPLOY_JOB && one.conclusion === 'success' && ms(one.completed_at) !== null)
    .filter((one) => started === null || ms(one.completed_at)! <= started)
    .sort((a, b) => ms(b.completed_at)! - ms(a.completed_at)!)[0];
  let setup = 0;
  let wait = 0;
  for (const one of critical?.steps ?? []) {
    const a = ms(one.started_at);
    const b = ms(one.completed_at);
    if (a === null || b === null) continue;
    if (SETUP_STEP.test(one.name)) setup += hours(a, b);
    if (one.name === POSTGRES_WAIT_STEP) wait += hours(a, b);
  }
  return {
    runId: run.id,
    dispatchedAt: ms(run.created_at)!,
    shipped: run.conclusion === 'success' && job?.conclusion === 'success',
    gatesDoneAt: started,
    deployedAt: deployed ?? completed,
    completedAt: completed,
    testSetupHours: setup,
    criticalTestJob: critical?.name ?? null,
    postgresWaitHours: wait,
  };
}

/** Every merged pull request in the window followed to the Deploy that shipped it. */
export function measureCycles(
  sources: CycleSources,
  window: { from: string; to: string },
): { cycles: CycleRecord[]; merged: number } {
  const from = ms(window.from)!;
  const to = ms(window.to)!;
  const deploys = sources.runs
    .filter((run) => run.name === 'Deploy' && run.head_branch === sources.canonicalBranch && run.status === 'completed')
    .map((run) => deployFacts(run, sources.jobs[String(run.id)] ?? []))
    .filter((d) => d.shipped && d.gatesDoneAt !== null && d.completedAt !== null)
    .sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  const merged = sources.pulls.filter((pr) => {
    const at = ms(pr.merged_at);
    return at !== null && pr.base.ref === sources.canonicalBranch && at >= from && at <= to;
  });
  const cycles: CycleRecord[] = [];
  for (const pr of merged) {
    const mergedAt = ms(pr.merged_at)!;
    const opened = ms(pr.created_at)!;
    const ship = deploys.find((d) => d.dispatchedAt >= mergedAt);
    if (!ship) continue;
    const authored = (sources.commits[String(pr.number)] ?? [])
      .map((c) => ms(c.commit.author?.date ?? c.commit.committer?.date))
      .filter((t): t is number => t !== null);
    const started = authored.length ? Math.min(opened, ...authored) : opened;
    const deployed = ship.deployedAt ?? ship.completedAt!;
    const stages: Record<CycleStage, number> = {
      DEVELOPMENT: round(hours(started, opened)),
      INTEGRATION_WAIT: round(hours(opened, mergedAt)),
      RELEASE_QUEUE: round(hours(mergedAt, ship.dispatchedAt)),
      TEST: round(hours(ship.dispatchedAt, ship.gatesDoneAt!)),
      RELEASE: round(hours(ship.gatesDoneAt!, deployed)),
      VERIFICATION: round(hours(deployed, ship.completedAt!)),
    };
    cycles.push({
      pr: pr.number,
      mergedAt: new Date(mergedAt).toISOString(),
      verifiedAt: new Date(ship.completedAt!).toISOString(),
      deployRunId: ship.runId,
      totalHours: round(CYCLE_STAGES.reduce((sum, s) => sum + stages[s], 0)),
      stages,
      testSetupHours: round(ship.testSetupHours),
      postgresWaitHours: round(ship.postgresWaitHours),
    });
  }
  return { cycles, merged: merged.length };
}

/** Mean number of intervals open at once over [from, to]. */
function meanOverlap(intervals: [number, number][], from: number, to: number): number {
  const span = to - from;
  if (span <= 0) return 0;
  let covered = 0;
  for (const [a, b] of intervals) covered += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return covered / span;
}

/** Mean jobs running while at least one was running. */
function busyConcurrency(intervals: [number, number][]): number | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  let busy = 0;
  let total = 0;
  let [start, end] = sorted[0]!;
  for (const [a, b] of sorted) {
    total += b - a;
    if (a > end) {
      busy += end - start;
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  busy += end - start;
  return busy > 0 ? total / busy : null;
}

const MEASURED_PART: Record<MeasuredPart, { label: string; pick: (c: Pick<CycleRecord, 'testSetupHours' | 'postgresWaitHours'>) => number }> = {
  TEST_SETUP: { label: 'setup in the last-finishing test job', pick: (c) => c.testSetupHours },
  POSTGRES_WAIT: { label: "Deploy's wait for the Postgres suite", pick: (c) => c.postgresWaitHours },
};

export function rankCorrections(
  stages: Record<CycleStage, StageSummary>,
  cycles: Pick<CycleRecord, 'testSetupHours' | 'postgresWaitHours'>[] = [],
): CorrectionEstimate[] {
  const out: CorrectionEstimate[] = [];
  const measured = (part: MeasuredPart): number =>
    cycles.length ? cycles.reduce((sum, c) => sum + MEASURED_PART[part].pick(c), 0) / cycles.length : 0;
  for (const stage of CYCLE_STAGES) {
    const summary = stages[stage];
    const mean = summary.samples > 0 ? summary.totalHours / summary.samples : 0;
    if (mean <= 0) continue;
    for (const one of STAGE_CORRECTIONS[stage]) {
      const part = one.measuredBy ? Math.min(measured(one.measuredBy), mean) : mean;
      out.push({
        stage,
        correction: one.correction,
        estimatedHoursSaved: round(part * one.reduction),
        boundHours: round(mean),
        assumption: one.measuredBy
          ? `removes ${Math.round(one.reduction * 100)}% of the measured ${round(part * 60, 1)} min per cycle of ${MEASURED_PART[one.measuredBy].label}`
          : `removes ${Math.round(one.reduction * 100)}% of the stage's mean ${round(mean * 60, 1)} min per cycle`,
      });
    }
  }
  return out.sort((a, b) => b.estimatedHoursSaved - a.estimatedHoursSaved);
}

/** The whole reading for one window. */
export function measureThroughput(
  sources: CycleSources,
  window: { from: string; to: string },
  improvements: ImprovementMark[] = [],
): CycleReading {
  const from = ms(window.from)!;
  const to = ms(window.to)!;
  const windowHours = hours(from, to);
  const { cycles, merged } = measureCycles(sources, window);
  const grand = cycles.reduce((sum, c) => sum + c.totalHours, 0);
  const stages = Object.fromEntries(
    CYCLE_STAGES.map((stage) => {
      const values = cycles.map((c) => c.stages[stage]);
      const total = values.reduce((a, b) => a + b, 0);
      const median = quantile(values, 0.5);
      const p90 = quantile(values, 0.9);
      return [
        stage,
        {
          samples: values.length,
          medianHours: median === null ? null : round(median),
          p90Hours: p90 === null ? null : round(p90),
          totalHours: round(total),
          share: grand > 0 ? round(total / grand) : 0,
        },
      ];
    }),
  ) as Record<CycleStage, StageSummary>;
  let limitingStage: CycleStage | null = null;
  if (cycles.length >= MIN_CYCLES) {
    for (const stage of CYCLE_STAGES) {
      if (!limitingStage || stages[stage].share > stages[limitingStage].share) limitingStage = stage;
    }
  }
  const deployRuns = sources.runs.filter((run) => {
    const at = ms(run.created_at)!;
    return run.name === 'Deploy' && run.head_branch === sources.canonicalBranch && at >= from && at <= to;
  });
  const facts = deployRuns.filter((r) => r.status === 'completed').map((r) => deployFacts(r, sources.jobs[String(r.id)] ?? []));
  const deployJobIntervals: [number, number][] = [];
  for (const run of deployRuns) {
    for (const job of sources.jobs[String(run.id)] ?? []) {
      const a = ms(job.started_at);
      const b = ms(job.completed_at);
      if (a !== null && b !== null && b > a && job.conclusion !== 'skipped') deployJobIntervals.push([a, b]);
    }
  }
  const cycleIntervals: [number, number][] = cycles.map((c) => [
    ms(c.verifiedAt)! - c.totalHours * HOUR,
    ms(c.verifiedAt)!,
  ]);
  const counted = improvements.filter((m) => {
    const at = ms(m.at);
    return at !== null && at >= from && at <= to;
  });
  const cycleMedian = quantile(cycles.map((c) => c.totalHours), 0.5);
  const deployConcurrency = busyConcurrency(deployJobIntervals);
  return {
    repository: sources.repository,
    from: window.from,
    to: window.to,
    windowHours: round(windowHours, 2),
    merged,
    verified: cycles.length,
    stages,
    cycleMedianHours: cycleMedian === null ? null : round(cycleMedian),
    limitingStage,
    limitingShare: limitingStage ? stages[limitingStage].share : null,
    releases: {
      dispatched: deployRuns.length,
      shipped: facts.filter((f) => f.shipped).length,
      failed: deployRuns.filter((r) => r.conclusion === 'failure').length,
      cancelled: deployRuns.filter((r) => r.conclusion === 'cancelled').length,
      rerun: deployRuns.filter((r) => (r.run_attempt ?? 1) > 1).length,
    },
    concurrency: {
      cyclesInFlight: round(meanOverlap(cycleIntervals, from, to), 2),
      deployJobs: deployConcurrency === null ? null : round(deployConcurrency, 2),
    },
    improvements: {
      count: counted.length,
      perHour: windowHours > 0 ? round(counted.length / windowHours, 4) : 0,
      refs: counted.map((m) => `${m.kind}:${m.ref}`),
    },
    corrections: rankCorrections(stages, cycles),
    cycles,
  };
}

export interface BottleneckChange {
  /** The limiting stage moved since the previous reading. */
  shifted: boolean;
  /** The limiting stage holds at least LIMITING_SHARE_THRESHOLD of the critical path. */
  overThreshold: boolean;
  from: CycleStage | null;
  to: CycleStage | null;
  /** Record it: a shift, or a limiting stage over the threshold. */
  record: boolean;
  reason: string;
}

/** Compare a reading with the one before it. */
export function bottleneckChange(previous: Pick<CycleReading, 'limitingStage'> | null, current: Pick<CycleReading, 'limitingStage' | 'limitingShare'>): BottleneckChange {
  const from = previous?.limitingStage ?? null;
  const to = current.limitingStage;
  const shifted = to !== null && from !== null && from !== to;
  const overThreshold = to !== null && (current.limitingShare ?? 0) >= LIMITING_SHARE_THRESHOLD;
  const share = current.limitingShare === null ? '' : ` (${Math.round(current.limitingShare * 100)}% of critical-path time)`;
  const reason =
    to === null
      ? `fewer than ${MIN_CYCLES} verified cycles: no limiting stage is named`
      : shifted
        ? `the limiting stage moved ${from} → ${to}${share}`
        : overThreshold
          ? `${to} limits the cycle${share}, at or over the ${LIMITING_SHARE_THRESHOLD * 100}% threshold`
          : `${to} limits the cycle${share}, under the threshold and unmoved`;
  return { shifted, overThreshold, from, to, record: shifted || overThreshold, reason };
}

/**
 * Median verified-cycle hours for cycles verified in [from, to), across stored
 * readings (newest reading wins for a pull request seen twice). The metric the
 * improvement loop judges a throughput correction on.
 */
export function cycleHoursIn(readings: Pick<CycleReading, 'cycles'>[], from: string, to: string): { median: number | null; samples: number } {
  const a = ms(from)!;
  const b = ms(to)!;
  const byPr = new Map<number, CycleRecord>();
  for (const reading of readings) for (const c of reading.cycles) byPr.set(c.pr, c);
  const inWindow = [...byPr.values()].filter((c) => {
    const at = ms(c.verifiedAt)!;
    return at >= a && at < b;
  });
  const median = quantile(inWindow.map((c) => c.totalHours), 0.5);
  return { median: median === null ? null : round(median), samples: inWindow.length };
}
