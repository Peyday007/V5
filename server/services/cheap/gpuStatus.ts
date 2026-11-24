/**
 * The GPU's operating status as the Command Center shows it (§121, owner's
 * standing order 2026-11-24, item 10): pod status, card, $/h, spend today and
 * since authorization, the RunPod balance, jobs in flight / per running hour /
 * accepted, idle-versus-waiting, and every restriction active now.
 *
 * Read from Brain's own rows — the supervisor's `RUNPOD_POD` samples (which
 * carry RunPod's price, vLLM's readiness, the waiting work and, under the
 * authorization, the balance) and the lane's `FREE_LANE_ITEM` rows — plus the
 * lane controller's last reading for the slot's target. Nothing here calls
 * RunPod: the page polls, and RunPod is read by the supervisor once. A reading
 * is cached for `CACHE_MS`, so a page left open costs one query a minute.
 */
import { getDb } from '../../db/database.ts';
import { gpuThroughput, runningByDay, summarizeGpuJobs, type LaneJobRow, type PodSampleRow } from './gpuCapacity.ts';
import { runpodConfig, runpodPaused } from './runpod.ts';
import { balanceRestriction, gpuAuthorization, podBudget, rateRefusal, readPodRows, windowSpendFromRows, type GpuAuthorization } from './runpodPod.ts';
import { RECIPES } from './runpodRestore.ts';

export interface GpuStatus {
  /** The GPU is in the lane (`BRAIN_RUNPOD_MODE=primary`). */
  configured: boolean;
  authorization: GpuAuthorization | null;
  pod: {
    id: string | null;
    status: string;
    /** vLLM answered the supervisor's last probe. */
    ready: boolean;
    costPerHr: number | null;
    /** The cards the serving recipe runs on, and the recipe. */
    card: string | null;
    recipe: string | null;
    /** When the supervisor last read the pod. */
    observedAt: string | null;
  };
  spend: { todayUsd: number | null; sinceAuthorizationUsd: number | null };
  balanceUsd: number | null;
  work: {
    /** Claimable GPU-suitable lane work the supervisor last saw. */
    waiting: number | null;
    inFlight: number | null;
    /** The GPU slot's current concurrency target and what bounded it last. */
    slotTarget: number | null;
    slotReason: string | null;
    /** Last 24 h, from the rows. */
    runningHours24h: number;
    jobsPerRunningHour24h: number | null;
    accepted24h: number;
    acceptedLastHour: number;
    acceptedPerDollar24h: number | null;
    /** idle beside waiting work, busy, idle with nothing waiting, or stopped. */
    state: 'BUSY' | 'IDLE_WITH_WORK' | 'IDLE_NO_WORK' | 'STOPPED_NO_WORK' | 'STOPPED_WITH_WORK' | 'UNKNOWN';
  };
  /** What stops the GPU doing more useful work right now, each in one sentence. */
  restrictions: string[];
  readAt: string;
}

const CACHE_MS = 60_000;
let cached: { at: number; value: GpuStatus } | null = null;

export function resetGpuStatusCache(): void {
  cached = null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const parse = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '{}')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure: the work state from the latest sample. */
export function workState(status: string, waiting: number | null, inFlight: number | null): GpuStatus['work']['state'] {
  if (waiting === null) return 'UNKNOWN';
  if (status !== 'RUNNING') return waiting > 0 ? 'STOPPED_WITH_WORK' : 'STOPPED_NO_WORK';
  if ((inFlight ?? 0) > 0) return 'BUSY';
  return waiting > 0 ? 'IDLE_WITH_WORK' : 'IDLE_NO_WORK';
}

/** Pure: every restriction active now, from the readings. */
export function gpuRestrictions(input: {
  configured: boolean;
  authorization: GpuAuthorization | null;
  status: string;
  ready: boolean;
  costPerHr: number | null;
  balance: number | null;
  waiting: number | null;
  paused: string | null;
  lastReason: string | null;
  slotReason: string | null;
  budgeted: boolean;
}): string[] {
  const out: string[] = [];
  if (!input.configured) out.push('GPU not in the lane (BRAIN_RUNPOD_MODE is not primary): research runs on the free models only');
  if (!input.authorization) out.push(input.budgeted ? 'no standing authorization: the GPU runs under a dollar budget window (cheap-lane runpod-authorize sets it)' : 'no standing authorization');
  const refused = rateRefusal(input.authorization, input.costPerHr);
  if (refused) out.push(refused);
  const balance = balanceRestriction(input.authorization, input.balance);
  if (balance) out.push(balance.reason);
  if (input.status !== 'RUNNING' && (input.waiting ?? 0) <= 0) out.push('stopped: no waiting work (starts again by itself when GPU work is queued)');
  if (input.status === 'RUNNING' && !input.ready) out.push('vLLM not serving yet: GPU calls go to the free fallback until it answers');
  if (input.status === 'TERMINATED') out.push('pod deleted: recreated from the authorized recipe when work waits');
  if (input.paused && input.status === 'RUNNING' && input.ready) out.push(`GPU slot paused: ${input.paused}`);
  if (input.lastReason && /refused|not starting|failed|exhausted|over:/i.test(input.lastReason) && !out.some((r) => input.lastReason!.includes(r))) out.push(`supervisor: ${input.lastReason}`);
  if (input.slotReason && /held|holding|lagging|CPU|saturated|overloaded|contended/i.test(input.slotReason)) out.push(`concurrency: ${input.slotReason}`);
  return [...new Set(out)];
}

/** The GPU's status now (cached for a minute). Never throws: an unreadable part is null. */
export async function readGpuStatus(now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<GpuStatus> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const db = getDb();
  const authorization = gpuAuthorization(env);
  const gpu = runpodConfig(env);
  const dayStart = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const since24 = now - 24 * 3_600_000;

  let sample: { at: string; outcome: string; reason: string | null; measures: Record<string, unknown> } | null = null;
  try {
    const row = await db.get<{ at: unknown; outcome: string; reason: string | null; measures: unknown }>(
      `SELECT at, outcome, reason, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' ORDER BY at DESC LIMIT 1`,
    );
    if (row) sample = { at: iso(row.at), outcome: row.outcome, reason: row.reason, measures: parse(row.measures) };
  } catch {
    sample = null;
  }
  let lastAction: { outcome: string; reason: string | null; measures: Record<string, unknown> } | null = null;
  try {
    const row = await db.get<{ outcome: string; reason: string | null; measures: unknown }>(
      `SELECT outcome, reason, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome NOT LIKE 'SAMPLE_%' ORDER BY at DESC LIMIT 1`,
    );
    if (row) lastAction = { outcome: row.outcome, reason: row.reason, measures: parse(row.measures) };
  } catch {
    lastAction = null;
  }

  // Spend: today, and since the authorization (bounded to 60 days of rows).
  let todayUsd: number | null = null;
  let sinceAuthorizationUsd: number | null = null;
  try {
    const authAt = authorization?.since ? Math.max(Date.parse(authorization.since), now - 60 * 86_400_000) : null;
    const from = Math.min(dayStart, authAt ?? dayStart);
    const rows = await readPodRows(new Date(from - 86_400_000).toISOString());
    todayUsd = r2(windowSpendFromRows(rows, { since: dayStart, now }).dollars);
    if (authAt !== null) sinceAuthorizationUsd = r2(windowSpendFromRows(rows, { since: authAt, now }).dollars);
  } catch {
    /* unreadable: null */
  }

  // Jobs: the last 24 h of the GPU slot's rows, and the running time the samples saw.
  let runningHours24h = 0;
  let jobsPerRunningHour24h: number | null = null;
  let accepted24h = 0;
  let acceptedLastHour = 0;
  let acceptedPerDollar24h: number | null = null;
  try {
    const since = new Date(since24).toISOString();
    const jobRows = await db.all<{ at: unknown; outcome: string; reason: string | null; duration_ms: number | string | null; measures: unknown }>(
      `SELECT at, outcome, reason, duration_ms, measures FROM bin_events
        WHERE event_type = 'FREE_LANE_ITEM' AND at >= ? AND (reason LIKE 'model runpod/%' OR measures LIKE '%runpod/%')`,
      [since],
    );
    const lane: LaneJobRow[] = jobRows.map((r) => ({
      at: iso(r.at),
      outcome: r.outcome,
      slot: String(r.reason ?? '').replace(/^model /, '').split(':')[0] ?? '',
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      measures: r.measures,
    }));
    const samples = await db.all<{ at: unknown; outcome: string; duration_ms: number | string | null; measures: unknown }>(
      `SELECT at, outcome, duration_ms, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' AND at >= ?`,
      [since],
    );
    const podSamples: PodSampleRow[] = samples.map((s) => {
      const m = parse(s.measures);
      return { at: iso(s.at), outcome: s.outcome, durationMs: s.duration_ms === null ? null : Number(s.duration_ms), costPerHr: numOrNull(m['costPerHr']), ready: m['ready'] === true };
    });
    const jobs = summarizeGpuJobs(lane);
    const t = gpuThroughput(jobs, runningByDay(podSamples));
    runningHours24h = t.runningHours;
    jobsPerRunningHour24h = t.jobsPerRunningHour;
    accepted24h = jobs.gpu.submitted;
    acceptedPerDollar24h = t.acceptedPerDollar;
    const hourAgo = new Date(now - 3_600_000).toISOString();
    acceptedLastHour = summarizeGpuJobs(lane.filter((r) => r.at >= hourAgo)).gpu.submitted;
  } catch {
    /* unreadable: zeros */
  }

  // The GPU slot's concurrency, from the controller's last reading in this process.
  let slotTarget: number | null = null;
  let slotReason: string | null = null;
  try {
    const { lastControlReading } = await import('../freeLane/capacity.ts');
    const slot = lastControlReading()?.models.find((m) => m.model.startsWith('runpod/'));
    if (slot) {
      slotTarget = slot.target;
      slotReason = slot.reason;
    }
  } catch {
    /* no lane in this process */
  }

  const m = sample?.measures ?? {};
  const status = sample ? sample.outcome.replace(/^SAMPLE_/, '') : 'UNKNOWN';
  const ready = m['ready'] === true;
  const costPerHr = numOrNull(m['costPerHr']);
  const waiting = numOrNull(m['waiting']);
  const inFlight = numOrNull(m['inFlight']);
  const balance = numOrNull(m['balance']);
  const recipeKey = typeof m['recipe'] === 'string' ? m['recipe'] : (authorization?.recipe ?? null);
  const recipe = recipeKey ? RECIPES[recipeKey] : undefined;
  const value: GpuStatus = {
    configured: !!gpu,
    authorization,
    pod: {
      id: typeof m['podId'] === 'string' ? m['podId'] : null,
      status,
      ready,
      costPerHr,
      card: recipe ? recipe.gpus.map((g) => g.replace(/^NVIDIA /, '')).join(' or ') : null,
      recipe: recipeKey,
      observedAt: sample?.at ?? null,
    },
    spend: { todayUsd, sinceAuthorizationUsd },
    balanceUsd: balance,
    work: {
      waiting,
      inFlight,
      slotTarget,
      slotReason,
      runningHours24h,
      jobsPerRunningHour24h,
      accepted24h,
      acceptedLastHour,
      acceptedPerDollar24h,
      state: workState(status, waiting, inFlight),
    },
    restrictions: gpuRestrictions({
      configured: !!gpu,
      authorization,
      status,
      ready,
      costPerHr,
      balance,
      waiting,
      paused: runpodPaused(),
      lastReason: lastAction?.reason ?? sample?.reason ?? null,
      slotReason,
      budgeted: !!podBudget(env),
    }),
    readAt: new Date(now).toISOString(),
  };
  cached = { at: now, value };
  return value;
}
