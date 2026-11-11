/**
 * The RunPod pod's power: stopped when no useful research is left, started
 * again when some arrives. A pod bills by the hour whether it is busy or not.
 *
 * Off unless the GPU is primary (`runpod.ts`) and `BRAIN_RUNPOD_API_KEY` (the
 * RunPod account key — not vLLM's `--api-key`) is set; `BRAIN_RUNPOD_AUTOSTOP=off`
 * turns it off again. The pod id is read from the pod's proxy address
 * (`https://<podId>-8000.proxy.runpod.net`) or `BRAIN_RUNPOD_POD_ID`.
 *
 * What counts as useful work is the free lane's own measure, `waitingNow()`:
 * research items queued in the queue the lane serves. Nothing here creates
 * work; it only decides whether the pod should be on for the work there is.
 *
 *   - RUNNING, nothing waiting and nothing in flight for `idleStopMs`
 *     (default 15 min) → stop.
 *   - EXITED and research waiting → start.
 *   - Until a started pod's vLLM answers `/models`, the GPU slot is paused:
 *     its calls go straight to the free fallback, so research never waits on a
 *     booting pod, and stopping one never interrupts a job.
 *
 * Every decision that changes the pod is a `RUNPOD_POD` event, and the pod's
 * status and RunPod's own `costPerHr` are sampled into one every
 * `SAMPLE_MS`, so its running time and spend are measured, not assumed.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent } from '../../repos/bins.ts';
import { runpodConfig, setRunpodPaused, type Fetch } from './runpod.ts';

const API = 'https://rest.runpod.io/v1';
export const DEFAULT_IDLE_STOP_MS = 15 * 60_000;
/** Never flip the pod twice within this, whatever the readings say. */
export const MIN_ACTION_GAP_MS = 3 * 60_000;
export const SUPERVISE_MS = 60_000;
export const SAMPLE_MS = 5 * 60_000;

export interface PodConfig {
  apiKey: string;
  podId: string;
  idleStopMs: number;
  /** vLLM's own address and key, to tell a loaded pod from a booting one. */
  vllm: { url: string; key: string | null };
}

export function podIdFromUrl(url: string): string | null {
  const match = /^https?:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i.exec(url.trim());
  return match ? match[1]!.toLowerCase() : null;
}

export function podConfig(env: NodeJS.ProcessEnv = process.env): PodConfig | null {
  const gpu = runpodConfig(env);
  const apiKey = env['BRAIN_RUNPOD_API_KEY']?.trim();
  if (!gpu || !apiKey || (env['BRAIN_RUNPOD_AUTOSTOP'] ?? '').trim().toLowerCase() === 'off') return null;
  const podId = env['BRAIN_RUNPOD_POD_ID']?.trim() || podIdFromUrl(env['BRAIN_RUNPOD_URL'] ?? '');
  if (!podId) return null;
  const minutes = Number(env['BRAIN_RUNPOD_IDLE_STOP_MINUTES']);
  return { apiKey, podId, idleStopMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_IDLE_STOP_MS, vllm: { url: gpu.url, key: gpu.key } };
}

export type PodStatus = 'RUNNING' | 'EXITED' | 'TERMINATED' | 'UNKNOWN';

export interface PodDecision {
  action: 'STOP' | 'START' | 'NONE';
  reason: string;
}

/** Pure, so every decision can be replayed from its inputs. */
export function decidePod(input: {
  status: PodStatus;
  waiting: number;
  inFlight: number;
  idleSince: number | null;
  lastActionAt: number;
  now: number;
  idleStopMs: number;
  /**
   * RunPod refused to start this pod recently. A stopped pod gives its GPU back
   * to RunPod, and when someone else takes it the pod cannot start again until
   * that GPU frees (production 2026-11-05 21:34Z: stopped by the test, every
   * start refused). Until a start succeeds again, an idle pod is left running:
   * idle time costs cents, a lost GPU costs the research.
   */
  startFailedRecently?: boolean;
}): PodDecision {
  const { status, waiting, inFlight, idleSince, lastActionAt, now, idleStopMs } = input;
  const settled = now - lastActionAt >= MIN_ACTION_GAP_MS;
  if (status === 'TERMINATED') return { action: 'NONE', reason: 'pod terminated; a new one must be created' };
  if (status === 'UNKNOWN') return { action: 'NONE', reason: 'pod status unknown; changing nothing' };
  if (status === 'EXITED') {
    if (waiting <= 0) return { action: 'NONE', reason: 'stopped, and no research waiting' };
    if (!settled) return { action: 'NONE', reason: 'research waiting; just changed the pod, holding' };
    return { action: 'START', reason: `${waiting} research item(s) waiting` };
  }
  if (waiting > 0 || inFlight > 0) return { action: 'NONE', reason: `busy: ${waiting} waiting, ${inFlight} in flight` };
  const idleFor = idleSince === null ? 0 : now - idleSince;
  if (idleFor < idleStopMs) return { action: 'NONE', reason: `no research for ${Math.round(idleFor / 60_000)} min of ${Math.round(idleStopMs / 60_000)}` };
  if (!settled) return { action: 'NONE', reason: 'idle; just changed the pod, holding' };
  if (input.startFailedRecently) return { action: 'NONE', reason: 'idle, but RunPod refused a recent start of this pod; not stopping it again' };
  return { action: 'STOP', reason: `no research waiting or in flight for ${Math.round(idleFor / 60_000)} min` };
}

/* ------------------------------------------------------------------------- */
/* RunPod's API                                                               */
/* ------------------------------------------------------------------------- */

async function api(config: PodConfig, method: 'GET' | 'POST', path: string, fetchImpl: Fetch): Promise<Response> {
  return fetchImpl(`${API}/pods/${encodeURIComponent(config.podId)}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
}

export async function readPod(config: PodConfig, fetchImpl: Fetch = fetch): Promise<{ status: PodStatus; costPerHr: number | null }> {
  try {
    const response = await api(config, 'GET', '', fetchImpl);
    if (!response.ok) return { status: 'UNKNOWN', costPerHr: null };
    const body = (await response.json()) as { desiredStatus?: string; costPerHr?: number | string; adjustedCostPerHr?: number | string };
    const status = (['RUNNING', 'EXITED', 'TERMINATED'] as const).find((s) => s === body.desiredStatus) ?? 'UNKNOWN';
    const cost = Number(body.adjustedCostPerHr ?? body.costPerHr);
    return { status, costPerHr: Number.isFinite(cost) ? cost : null };
  } catch {
    return { status: 'UNKNOWN', costPerHr: null };
  }
}

/** Stop or start the pod: the same call the supervisor makes. True when RunPod accepted it. */
export async function powerPod(config: PodConfig, action: 'stop' | 'start', fetchImpl: Fetch = fetch): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await api(config, 'POST', `/${action}`, fetchImpl);
  const body = response.ok ? '' : (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ok: response.ok, status: response.status, body };
}

/** Whether the pod's vLLM answers, with its key. */
export async function vllmReady(config: PodConfig, fetchImpl: Fetch): Promise<boolean> {
  const gpu = config.vllm;
  try {
    const response = await fetchImpl(`${gpu.url}/models`, {
      headers: gpu.key ? { authorization: `Bearer ${gpu.key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* The supervisor                                                             */
/* ------------------------------------------------------------------------- */

/** How long a refused start keeps the pod from being stopped again, unless a start has succeeded since. */
export const START_FAILURE_MEMORY_MS = 7 * 24 * 3_600_000;

/** Whether RunPod's most recent answer to a start, in the memory window, was a refusal. */
async function lastStartFailed(now: number): Promise<boolean> {
  try {
    const row = await getDb().get<{ outcome: string }>(
      `SELECT outcome FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome IN ('STARTED', 'START_FAILED') AND at >= ?
        ORDER BY at DESC LIMIT 1`,
      [new Date(now - START_FAILURE_MEMORY_MS).toISOString()],
    );
    return row?.outcome === 'START_FAILED';
  } catch {
    // Unreadable: stopping is the step that can lose the GPU, so do not.
    return true;
  }
}

const state = { idleSince: null as number | null, lastActionAt: 0, lastRun: 0, lastSample: 0, running: false };

export function resetPodSupervisor(): void {
  state.idleSince = null;
  state.lastActionAt = 0;
  state.lastRun = 0;
  state.lastSample = 0;
  state.running = false;
  setRunpodPaused(null);
}

export interface SuperviseResult {
  status: PodStatus;
  ready: boolean;
  decision: PodDecision;
  acted: boolean;
}

/**
 * One supervision step, from the capacity controller's own reading. Throttled
 * to `SUPERVISE_MS`; never throws.
 */
export async function superviseRunpodPod(
  input: { waiting: number; inFlight: number },
  deps: { fetchImpl?: Fetch; now?: () => number; config?: PodConfig | null; force?: boolean; lastStartFailed?: (now: number) => Promise<boolean> } = {},
): Promise<SuperviseResult | null> {
  const config = deps.config === undefined ? podConfig() : deps.config;
  if (!config) return null;
  const now = (deps.now ?? Date.now)();
  if (state.running || (!deps.force && now - state.lastRun < SUPERVISE_MS)) return null;
  state.running = true;
  state.lastRun = now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const pod = await readPod(config, fetchImpl);
    const busy = input.waiting > 0 || input.inFlight > 0;
    if (busy || pod.status !== 'RUNNING') state.idleSince = null;
    else if (state.idleSince === null) state.idleSince = now;

    const ready = pod.status === 'RUNNING' && (await vllmReady(config, fetchImpl));
    setRunpodPaused(pod.status === 'RUNNING' ? (ready ? null : 'vLLM still loading') : pod.status === 'UNKNOWN' ? null : `pod ${pod.status.toLowerCase()}`);

    const startFailedRecently = pod.status === 'RUNNING' && (await (deps.lastStartFailed ?? lastStartFailed)(now));
    const decision = decidePod({ status: pod.status, waiting: input.waiting, inFlight: input.inFlight, idleSince: state.idleSince, lastActionAt: state.lastActionAt, now, idleStopMs: config.idleStopMs, startFailedRecently });
    let acted = false;
    if (decision.action !== 'NONE') {
      const path = decision.action === 'STOP' ? '/stop' : '/start';
      let outcome: string;
      let detail = '';
      try {
        const response = await api(config, 'POST', path, fetchImpl);
        acted = response.ok;
        outcome = response.ok ? (decision.action === 'STOP' ? 'STOPPED' : 'STARTED') : `${decision.action}_FAILED`;
        if (!response.ok) {
          // RunPod's own words say why (a GPU taken by someone else reads differently from a bad id).
          const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
          detail = ` (RunPod answered HTTP ${response.status}${body ? `: ${body}` : ''})`;
        }
      } catch (error) {
        outcome = `${decision.action}_FAILED`;
        detail = ` (${(error as Error).name})`;
      }
      // A failed start (no GPU free on the host, say) still waits the gap before retrying.
      state.lastActionAt = now;
      if (acted && decision.action === 'STOP') {
        state.idleSince = null;
        setRunpodPaused('pod stopped');
      }
      if (acted && decision.action === 'START') setRunpodPaused('pod starting');
      await recordBinEvent({
        eventType: 'RUNPOD_POD',
        provider: 'runpod',
        outcome,
        reason: `${decision.reason}${detail}`.slice(0, 400),
        measures: { podId: config.podId, waiting: input.waiting, inFlight: input.inFlight, status: pod.status, costPerHr: pod.costPerHr },
        evidenceClass: 'MEASURED',
      }).catch(() => undefined);
    }
    if (now - state.lastSample >= SAMPLE_MS) {
      state.lastSample = now;
      await recordBinEvent({
        eventType: 'RUNPOD_POD',
        provider: 'runpod',
        outcome: `SAMPLE_${pod.status}`,
        reason: decision.reason.slice(0, 400),
        durationMs: SAMPLE_MS,
        measures: { podId: config.podId, waiting: input.waiting, inFlight: input.inFlight, ready, costPerHr: pod.costPerHr },
        evidenceClass: 'MEASURED',
      }).catch(() => undefined);
    }
    return { status: pod.status, ready, decision, acted };
  } catch (error) {
    console.warn('[runpod] pod supervision failed:', (error as Error).message);
    return null;
  } finally {
    state.running = false;
  }
}

/* ------------------------------------------------------------------------- */
/* Spend, from the supervisor's own samples                                   */
/* ------------------------------------------------------------------------- */

/** One `RUNPOD_POD` row, as far as spend is concerned. */
export interface PodSpendRow {
  outcome: string;
  durationMs: number | null;
  measures: Record<string, unknown>;
}

export interface PodSpend {
  /** Dollars the pod billed over the sampled time: Σ costPerHr × hours, for samples that saw it RUNNING. */
  dollars: number;
  /** Hours of RUNNING samples that carried a price. */
  runningHours: number;
  /** RUNNING samples RunPod returned no price for: their time is not in `dollars`. */
  unpricedRunningSamples: number;
  samples: number;
}

/**
 * The pod's GPU spend in a window, derived from the `SAMPLE_*` rows the
 * supervisor writes every `SAMPLE_MS` with RunPod's own `costPerHr` (CAP-16-3:
 * a gain is weighed against dollars spent, and the dollars are measured, not
 * assumed). A sample covers its `durationMs`; only a RUNNING pod bills compute,
 * so EXITED / TERMINATED / UNKNOWN samples add no dollars. Pure, so the figure
 * can be replayed from the rows.
 */
export function podSpendFromRows(rows: readonly PodSpendRow[]): PodSpend {
  let dollars = 0;
  let runningHours = 0;
  let unpricedRunningSamples = 0;
  let samples = 0;
  for (const row of rows) {
    if (!row.outcome.startsWith('SAMPLE_')) continue;
    samples += 1;
    if (row.outcome !== 'SAMPLE_RUNNING') continue;
    const hours = (row.durationMs ?? SAMPLE_MS) / 3_600_000;
    const cost = Number(row.measures['costPerHr']);
    if (row.measures['costPerHr'] === null || row.measures['costPerHr'] === undefined || !Number.isFinite(cost) || cost < 0) {
      unpricedRunningSamples += 1;
      continue;
    }
    dollars += cost * hours;
    runningHours += hours;
  }
  return { dollars, runningHours, unpricedRunningSamples, samples };
}

/** The pod's spend since `since` (ISO), read from `bin_events`. The free providers cost $0, so this is the lane's model spend. */
export async function readPodSpend(since: string): Promise<PodSpend> {
  const rows = await getDb().all<{ outcome: string | null; duration_ms: number | string | null; measures: string | null }>(
    `SELECT outcome, duration_ms, measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' AND at >= ? ORDER BY at`,
    [since],
  );
  return podSpendFromRows(
    rows.map((r) => {
      let measures: Record<string, unknown> = {};
      try {
        const parsed: unknown = r.measures ? JSON.parse(r.measures) : {};
        if (parsed && typeof parsed === 'object') measures = parsed as Record<string, unknown>;
      } catch {
        measures = {};
      }
      const duration = r.duration_ms === null ? null : Number(r.duration_ms);
      return { outcome: r.outcome ?? '', durationMs: duration !== null && Number.isFinite(duration) ? duration : null, measures };
    }),
  );
}
