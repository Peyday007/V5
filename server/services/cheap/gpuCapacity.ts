/**
 * What the RunPod GPU actually did, from Brain's own rows: the reading the
 * hourly `runpod-report` prints as `GPU CAPACITY` (§86, §98). Pure, so every
 * figure replays from the rows it was read from.
 *
 * Two facts the older lines could not separate:
 *
 * - **Who answered.** A `FREE_LANE_ITEM` row names its *slot* in `reason`; the
 *   GPU slot keeps that label while the free fallback answers it. Only
 *   `measures.servedBy` says the GPU itself answered (`servedByGpu`).
 * - **When the pod ran.** RunPod bills a running pod by the hour; the
 *   supervisor's `SAMPLE_RUNNING` rows are that time (`SAMPLE_MS` each). Jobs
 *   per running hour is the GPU's throughput; jobs per wall-clock hour is not.
 */
import { servedByGpu } from './runpod.ts';
import { SAMPLE_MS } from './runpodPod.ts';

export interface LaneJobRow {
  /** ISO time the item ended. */
  at: string;
  outcome: string;
  /** The slot label from `reason` ("model <slot>[: why]"). */
  slot: string;
  durationMs: number | null;
  measures: unknown;
}

export interface JobTally {
  submitted: number;
  notAccepted: number;
  /** Σ item durations, ms. */
  ms: number;
  /** Of these items, how many were attributed from the pod's serving state, not `servedBy` (`SERVED_BY_SINCE`). */
  inferred: number;
}

const tally = (): JobTally => ({ submitted: 0, notAccepted: 0, ms: 0, inferred: 0 });

/**
 * The first `FREE_LANE_ITEM` row production recorded `servedBy` on (#1191,
 * deployed 2026-11-20): before it, no row says who answered, so a missing
 * `servedBy` is no evidence the fallback answered. After it, a row without
 * one is an item no model answered at all.
 *
 * Production 2026-11-24 (dispatch-diagnose run 45348622625, reading
 * `gpu-answers`): of 19,500 GPU-slot rows since 11-08, none before
 * 2026-11-20T21:13:15Z carries `servedBy`, and the pod `eaboawshas41wq` ran
 * from 11-10 to 11-19 19:49Z — so every job the GPU answered predates the
 * record, and `runpod-report` 45346060299 read all 126.5 running hours as
 * "GPU answered: submitted 0".
 */
export const SERVED_BY_SINCE = '2026-11-20T21:13:15.213Z';

/**
 * Pure: whether the GPU was serving at an instant, from the supervisor's
 * `SAMPLE_*` rows — the latest sample at or before it says RUNNING with vLLM
 * ready, and is no older than two sample periods. While it serves, every call
 * on the GPU slot goes to the GPU first (`routeRunpod`); the fallback answers
 * only a call the GPU failed.
 */
export function servingAt(samples: readonly PodSampleRow[]): (at: string) => boolean {
  const points = samples
    .filter((s) => s.outcome.startsWith('SAMPLE_'))
    .map((s) => ({ t: Date.parse(s.at), serving: s.outcome === 'SAMPLE_RUNNING' && s.ready === true, span: 2 * (s.durationMs ?? SAMPLE_MS) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  return (at) => {
    const t = Date.parse(at);
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]!.t <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const p = found >= 0 ? points[found]! : null;
    return !!p && p.serving && t - p.t <= p.span;
  };
}

/**
 * Pure: who answered one GPU-slot row. `servedBy` decides when the row carries
 * it; a row from before `SERVED_BY_SINCE` carries none, and is the GPU's when
 * the pod was serving as it ended (`inferred`), else the fallback's.
 */
export function gpuAnswered(row: LaneJobRow, serving: (at: string) => boolean): { gpu: boolean; inferred: boolean } {
  if (hasServedBy(row.measures) || row.at >= SERVED_BY_SINCE) return { gpu: servedByGpu(row.measures), inferred: false };
  if (!row.slot.startsWith('runpod/')) return { gpu: false, inferred: false };
  return { gpu: serving(row.at), inferred: true };
}

function hasServedBy(measures: unknown): boolean {
  let value: unknown = measures;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return !!value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['servedBy']);
}

export interface GpuJobSummary {
  /** Items at least one of whose calls the GPU itself answered (recorded, or inferred before `SERVED_BY_SINCE`). */
  gpu: JobTally;
  /** Items on the GPU slot answered only by its free fallback (the pod stopped, loading or failing). */
  slotFallback: JobTally;
  /** Per UTC day (`YYYY-MM-DD`), the same two tallies. */
  byDay: Map<string, { gpu: JobTally; slotFallback: JobTally }>;
}

/**
 * Pure: free-lane items split by who answered the GPU slot. Items on other
 * slots are not counted. `serving` (`servingAt`) attributes rows from before
 * `servedBy` was recorded; without it they are read as the fallback's.
 */
export function summarizeGpuJobs(rows: readonly LaneJobRow[], serving: (at: string) => boolean = () => false): GpuJobSummary {
  const out: GpuJobSummary = { gpu: tally(), slotFallback: tally(), byDay: new Map() };
  for (const row of rows) {
    const { gpu: served, inferred } = gpuAnswered(row, serving);
    if (!served && !row.slot.startsWith('runpod/')) continue;
    const day = row.at.slice(0, 10);
    const entry = out.byDay.get(day) ?? { gpu: tally(), slotFallback: tally() };
    out.byDay.set(day, entry);
    for (const t of served ? [out.gpu, entry.gpu] : [out.slotFallback, entry.slotFallback]) {
      if (row.outcome === 'SUBMITTED') t.submitted += 1;
      else t.notAccepted += 1;
      t.ms += Math.max(0, row.durationMs ?? 0);
      if (inferred) t.inferred += 1;
    }
  }
  return out;
}

export interface PodSampleRow {
  at: string;
  outcome: string;
  durationMs: number | null;
  costPerHr: number | null;
  /** The sample's `measures.ready`: vLLM answered the supervisor's probe. */
  ready?: boolean | null;
}

export interface RunningDay {
  day: string;
  runningHours: number;
  stoppedHours: number;
  dollars: number;
  /** The highest price a RUNNING sample carried that day. */
  costPerHr: number | null;
}

/** Pure: per UTC day, the hours the supervisor saw the pod RUNNING and stopped, and what the running time billed. */
export function runningByDay(rows: readonly PodSampleRow[]): RunningDay[] {
  const days = new Map<string, RunningDay>();
  for (const row of rows) {
    if (!row.outcome.startsWith('SAMPLE_')) continue;
    const day = row.at.slice(0, 10);
    const d = days.get(day) ?? { day, runningHours: 0, stoppedHours: 0, dollars: 0, costPerHr: null };
    days.set(day, d);
    const hours = (row.durationMs ?? SAMPLE_MS) / 3_600_000;
    if (row.outcome === 'SAMPLE_RUNNING') {
      d.runningHours += hours;
      if (row.costPerHr !== null && row.costPerHr >= 0) {
        d.dollars += row.costPerHr * hours;
        d.costPerHr = Math.max(d.costPerHr ?? 0, row.costPerHr);
      }
    } else d.stoppedHours += hours;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface GpuThroughput {
  runningHours: number;
  /** GPU-answered items per hour the pod ran; null when it never ran. */
  jobsPerRunningHour: number | null;
  acceptedPerRunningHour: number | null;
  /** Mean GPU items in flight while it ran (Σ item time ÷ running time); null when it never ran. */
  meanInFlight: number | null;
  /** Share of GPU-answered items Brain accepted; null with none. */
  acceptedShare: number | null;
  dollars: number;
  /** Dollars per accepted GPU item; null with none. */
  dollarsPerAccepted: number | null;
  /** Accepted GPU items per dollar the pod billed: the success per dollar the concurrency controller is judged on (§121); null with no spend. */
  acceptedPerDollar: number | null;
}

/** Pure: the GPU's measured throughput over the days given. */
export function gpuThroughput(jobs: GpuJobSummary, days: readonly RunningDay[]): GpuThroughput {
  const runningHours = days.reduce((t, d) => t + d.runningHours, 0);
  const dollars = days.reduce((t, d) => t + d.dollars, 0);
  const done = jobs.gpu.submitted + jobs.gpu.notAccepted;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    runningHours: r2(runningHours),
    jobsPerRunningHour: runningHours > 0 ? r2(done / runningHours) : null,
    acceptedPerRunningHour: runningHours > 0 ? r2(jobs.gpu.submitted / runningHours) : null,
    meanInFlight: runningHours > 0 ? r2(jobs.gpu.ms / (runningHours * 3_600_000)) : null,
    acceptedShare: done > 0 ? r2(jobs.gpu.submitted / done) : null,
    dollars: r2(dollars),
    dollarsPerAccepted: jobs.gpu.submitted > 0 ? r2(dollars / jobs.gpu.submitted) : null,
    acceptedPerDollar: dollars > 0 ? r2(jobs.gpu.submitted / dollars) : null,
  };
}

/**
 * Pure: hours to clear `items` lane jobs at `perHour` accepted per running
 * hour, or null when nothing was measured. A job that fails is tried again, so
 * the accepted rate is the one that clears a queue.
 */
export function hoursToClear(items: number, perHour: number | null): number | null {
  if (perHour === null || perHour <= 0) return null;
  return Math.round((items / perHour) * 10) / 10;
}

export interface CapacityDecisionRow {
  outcome: string;
  reason: string;
}

/**
 * Pure: why the GPU slot's target changed, by kind — the controller's own
 * reasons (`decideTarget`, the boot grace, the pool share) with the numbers
 * stripped so the same cause counts once.
 */
export function shrinkCauses(rows: readonly CapacityDecisionRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.outcome !== 'SHRINK' && row.outcome !== 'HOLD' && row.outcome !== 'GROW') continue;
    const why = row.reason.replace(/^\d+ -> \d+: /, '');
    const cause = /database pool/.test(why)
      ? 'held to its share of the database pool'
      : /starting up/.test(why)
        ? 'boot grace after a restart'
        : /Brain CPU/.test(why)
          ? 'Brain CPU over 85%'
          : /event loop lagging/.test(why)
            ? 'Brain event loop lagging'
            : /database saturated/.test(why)
              ? 'Brain database saturated'
              : /provider overloaded/.test(why)
                ? 'GPU calls failing (overloaded)'
                : /GPU answer time/.test(why)
                  ? 'held: GPU answer time over its baseline'
                  : /no research waiting/.test(why)
                  ? 'nothing waiting'
                  : /useful research waiting/.test(why)
                    ? 'grew: research waiting'
                    : why.replace(/\d+(\.\d+)?/g, 'N').slice(0, 80);
    const key = `${row.outcome} ${cause}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
