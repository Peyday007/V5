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
 *
 * A dollar budget binds all of it (`podBudget`): `BRAIN_RUNPOD_BUDGET_USD` per
 * rolling `BRAIN_RUNPOD_BUDGET_WINDOW_HOURS` (default 24), measured from what
 * RunPod bills, not only from those samples (`windowSpendFromRows`): per pod,
 * the larger of the sampled spend and the time RunPod says it has been running
 * (its own start time or uptime, and the rows that started, moved and stopped
 * it) × its price. Samples exist only while Brain is up and connected; RunPod
 * bills from the moment the pod runs (production 2026-11-17: pod 6lsnbsnctavj2m
 * billed ~$5.80 while the samples counted $3.09, and a $4 budget never bound).
 * Spent ≥ budget → the pod is stopped whatever it is doing, and
 * no start or move happens until the window frees budget. A GPU in primary mode
 * with no budget set runs under `DEFAULT_PRIMARY_BUDGET_USD` ($10 per 24 h), so
 * continuous operation is never open-ended.
 *
 * A bounded run (`runpod-launch`) also sets `BRAIN_RUNPOD_BUDGET_FROM`: the
 * window is then fixed — `[from, from + window]` — rather than rolling, so the
 * dollars are a ceiling on the run, not a rate a clock keeps releasing
 * (invariant 38). With a rolling 12.5 h window a $66 run that reached its cap
 * at hour 12.5 had budget freed minute by minute from then on, and the pod was
 * started again and again for as long as the account had money. Once a fixed
 * window has ended the run is over: the pod is stopped and nothing starts it.
 */
import { getDb } from '../../db/database.ts';
import { recordBinEvent, type RecordBinEventInput } from '../../repos/bins.ts';
import { runpodConfig, runpodUrlOverride, setRunpodPaused, setRunpodUrlOverride, type Fetch } from './runpod.ts';
import { createPod, deletePod, DEFAULT_MAX_USD_PER_HOUR, graphql, POD_NAME, podUrl, RECIPES, recipeFor, type PodRecipe } from './runpodRestore.ts';

const API = 'https://rest.runpod.io/v1';
export const DEFAULT_IDLE_STOP_MS = 15 * 60_000;
/** Never flip the pod twice within this, whatever the readings say. */
export const MIN_ACTION_GAP_MS = 3 * 60_000;
export const SUPERVISE_MS = 60_000;
export const SAMPLE_MS = 5 * 60_000;

/**
 * The GPU's spend cap when the GPU is primary and `BRAIN_RUNPOD_BUDGET_USD` is
 * not set: $10 per rolling 24 h — about 40 h of the $0.24/h ceiling pod, so a
 * day of continuous research fits and nothing runs open-ended. Set
 * `BRAIN_RUNPOD_BUDGET_USD` to change it.
 */
export const DEFAULT_PRIMARY_BUDGET_USD = 10;
export const DEFAULT_BUDGET_WINDOW_HOURS = 24;

export interface PodBudget {
  usd: number;
  windowMs: number;
  /** True when `DEFAULT_PRIMARY_BUDGET_USD` applies because no budget was set. */
  defaulted: boolean;
  /** A bounded run's start (epoch ms, `BRAIN_RUNPOD_BUDGET_FROM`): the window is fixed at `[from, from + windowMs]`. Absent, it rolls. */
  from?: number;
}

/** The start of the window spend is measured over: a bounded run's own start, else `windowMs` before now. */
export function budgetWindowStart(budget: PodBudget, now: number): number {
  return budget.from !== undefined ? Math.min(budget.from, now) : now - budget.windowMs;
}

/** Pure: a bounded run's window has passed. A rolling window never ends. */
export function budgetWindowEnded(budget: PodBudget, now: number): boolean {
  return budget.from !== undefined && now >= budget.from + budget.windowMs;
}

/**
 * The dollar budget the pod runs under, or null for none. An explicit
 * `BRAIN_RUNPOD_BUDGET_USD` (≥ 0) always applies; unset, a primary GPU gets
 * `DEFAULT_PRIMARY_BUDGET_USD` and anything else gets none (nothing runs then).
 */
export function podBudget(env: NodeJS.ProcessEnv = process.env): PodBudget | null {
  const hours = Number(env['BRAIN_RUNPOD_BUDGET_WINDOW_HOURS']);
  const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_BUDGET_WINDOW_HOURS) * 3_600_000;
  const raw = env['BRAIN_RUNPOD_BUDGET_USD']?.trim();
  const usd = raw ? Number(raw) : Number.NaN;
  const fromRaw = env['BRAIN_RUNPOD_BUDGET_FROM']?.trim();
  const from = fromRaw ? Date.parse(fromRaw) : Number.NaN;
  if (Number.isFinite(usd) && usd >= 0) return { usd, windowMs, defaulted: false, ...(Number.isFinite(from) ? { from } : {}) };
  if ((env['BRAIN_RUNPOD_MODE'] ?? '').trim().toLowerCase() === 'primary') return { usd: DEFAULT_PRIMARY_BUDGET_USD, windowMs, defaulted: true };
  return null;
}

export interface PodBudgetReading {
  /** Dollars the pod billed in the window, from its samples; null when they could not be read. */
  spent: number | null;
  budget: number;
  /** Budget left in the window; null when spend is unknown. */
  remaining: number | null;
  /** Spent ≥ budget, or a bounded run's window has ended. An unreadable spend is not exhausted, but it is not `known` either. */
  exhausted: boolean;
  /** A bounded run's fixed window has passed: the run is over whatever was spent. */
  ended: boolean;
  known: boolean;
  windowHours: number;
  /** The window's start (ISO). */
  since: string;
  defaulted: boolean;
}

/** Pure: the budget reading for a measured (or unreadable) spend. */
export function budgetReading(budget: PodBudget, spent: number | null, now: number): PodBudgetReading {
  const known = spent !== null && Number.isFinite(spent);
  const ended = budgetWindowEnded(budget, now);
  return {
    spent: known ? spent : null,
    budget: budget.usd,
    remaining: ended ? 0 : known ? Math.max(0, budget.usd - spent) : null,
    exhausted: ended || (known && spent >= budget.usd),
    ended,
    known,
    windowHours: budget.windowMs / 3_600_000,
    since: new Date(budgetWindowStart(budget, now)).toISOString(),
    defaulted: budget.defaulted,
  };
}

/** The pod's budget now, from its sample rows: what an operator or report reads. Null when no budget applies. */
export async function readPodBudget(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<PodBudgetReading | null> {
  const budget = podBudget(env);
  if (!budget) return null;
  return readBudget(budget, now);
}

async function readBudget(budget: PodBudget, now: number, live: LivePod | null = null, rows: (since: string) => Promise<PodRow[]> = readPodRows): Promise<PodBudgetReading & { spend: WindowSpend | null }> {
  const since = budgetWindowStart(budget, now);
  try {
    // Rows from a window earlier too, so a pod started before the window and running into it is seen.
    const spend = windowSpendFromRows(await rows(new Date(since - budget.windowMs).toISOString()), { since, now, live });
    return { ...budgetReading(budget, spend.dollars, now), spend };
  } catch {
    // The rows are unreadable; RunPod's own word on the running pod still binds when it alone exhausts the budget.
    const own = windowSpendFromRows([], { since, now, live });
    return { ...budgetReading(budget, own.dollars >= budget.usd ? own.dollars : null, now), spend: own.dollars >= budget.usd ? own : null };
  }
}

export type BudgetMark = 'BUDGET_EXHAUSTED' | 'BUDGET_AVAILABLE';

/**
 * Pure: which budget event, if any, this reading adds after `lastMark` (the
 * newest budget row). One `BUDGET_EXHAUSTED` per exhaustion, not one per tick,
 * and one `BUDGET_AVAILABLE` when the window frees budget again.
 */
export function budgetEvent(reading: PodBudgetReading | null, lastMark: BudgetMark | null): BudgetMark | null {
  if (!reading || (!reading.known && !reading.ended)) return null;
  if (reading.exhausted) return lastMark === 'BUDGET_EXHAUSTED' ? null : 'BUDGET_EXHAUSTED';
  return lastMark === 'BUDGET_EXHAUSTED' ? 'BUDGET_AVAILABLE' : null;
}

async function lastBudgetMark(): Promise<BudgetMark | null> {
  try {
    const row = await getDb().get<{ outcome: string }>(
      `SELECT outcome FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome IN ('BUDGET_EXHAUSTED', 'BUDGET_AVAILABLE')
        ORDER BY at DESC LIMIT 1`,
    );
    return row?.outcome === 'BUDGET_EXHAUSTED' || row?.outcome === 'BUDGET_AVAILABLE' ? row.outcome : null;
  } catch {
    return null;
  }
}

export interface PodConfig {
  apiKey: string;
  podId: string;
  idleStopMs: number;
  /** The dollar cap the supervisor enforces; absent or null, none. */
  budget?: PodBudget | null;
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
  const moved = runpodUrlOverride();
  const podId = (moved ? podIdFromUrl(moved) : null) || env['BRAIN_RUNPOD_POD_ID']?.trim() || podIdFromUrl(env['BRAIN_RUNPOD_URL'] ?? '');
  if (!podId) return null;
  const minutes = Number(env['BRAIN_RUNPOD_IDLE_STOP_MINUTES']);
  return { apiKey, podId, idleStopMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_IDLE_STOP_MS, budget: podBudget(env), vllm: { url: gpu.url, key: gpu.key } };
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
  /**
   * The dollar budget's reading. Exhausted → a running pod is stopped whatever
   * it is doing and nothing starts. Unreadable spend under a budget → nothing
   * starts (a cap that cannot be read is not a cap), but nothing is stopped on it.
   */
  budget?: PodBudgetReading | null;
}): PodDecision {
  const { status, waiting, inFlight, idleSince, lastActionAt, now, idleStopMs, budget } = input;
  const settled = now - lastActionAt >= MIN_ACTION_GAP_MS;
  const overBudget = budget?.ended
    ? `GPU run over: its fixed ${budget.windowHours} h budget window from ${budget.since} has ended ($${(budget.spent ?? 0).toFixed(2)} of $${budget.budget.toFixed(2)} spent)`
    : budget?.exhausted
    ? `GPU budget exhausted: $${(budget.spent ?? 0).toFixed(2)} of $${budget.budget.toFixed(2)} spent in ${budget.windowHours} h`
    : null;
  if (status === 'TERMINATED') return { action: 'NONE', reason: 'pod terminated; a new one must be created' };
  if (status === 'UNKNOWN') return { action: 'NONE', reason: 'pod status unknown; changing nothing' };
  if (status === 'EXITED') {
    if (waiting <= 0) return { action: 'NONE', reason: overBudget ? `stopped; ${overBudget}` : 'stopped, and no research waiting' };
    if (overBudget) return { action: 'NONE', reason: `${waiting} research item(s) waiting, not starting: ${overBudget}` };
    if (budget && !budget.known) return { action: 'NONE', reason: `${waiting} research item(s) waiting, not starting: GPU spend unreadable under a $${budget.budget} budget` };
    if (!settled) return { action: 'NONE', reason: 'research waiting; just changed the pod, holding' };
    return { action: 'START', reason: `${waiting} research item(s) waiting` };
  }
  if (overBudget) {
    // The cap outranks the work and a refused start alike: the money is the hard edge.
    if (!settled) return { action: 'NONE', reason: `${overBudget}; just changed the pod, holding` };
    return { action: 'STOP', reason: overBudget };
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
  try {
    return await fetchImpl(`${API}/pods/${encodeURIComponent(config.podId)}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // RunPod's REST host unreachable (production 2026-11-16 23:36Z: "fetch failed" from every
    // client while GraphQL answered). Reading, stopping and starting the pod — the budget's and the
    // idle timer's only way to stop spend — must not depend on one API, so the same request goes to
    // GraphQL. Only a thrown request falls back; an HTTP answer from REST is RunPod's own word.
    const answered = await viaGraphql(config, method, path, fetchImpl).catch(() => null);
    if (answered) return answered;
    throw error;
  }
}

/** The pod request `api` makes, through RunPod's GraphQL API, shaped as the REST answer it replaces. */
export async function viaGraphql(config: Pick<PodConfig, 'apiKey' | 'podId'>, method: 'GET' | 'POST', path: string, fetchImpl: Fetch): Promise<Response | null> {
  const id = JSON.stringify(config.podId);
  const query =
    method === 'GET' && path === ''
      ? `query { pod(input: { podId: ${id} }) { desiredStatus costPerHr runtime { uptimeInSeconds } } }`
      : method === 'POST' && path === '/stop'
        ? `mutation { podStop(input: { podId: ${id} }) { desiredStatus } }`
        : method === 'POST' && path === '/start'
          ? `mutation { podResume(input: { podId: ${id}, gpuCount: 1 }) { desiredStatus } }`
          : null;
  if (!query) return null;
  const response = await fetchImpl('https://api.runpod.io/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as { data?: Record<string, unknown>; errors?: { message: string }[] } | null;
  const value = body?.data ? Object.values(body.data)[0] : null;
  if (!response.ok || !value || body?.errors?.length) {
    return new Response(JSON.stringify({ error: body?.errors?.map((e) => e.message).join('; ') ?? `GraphQL HTTP ${response.status}` }), { status: 502 });
  }
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

export interface PodReading {
  status: PodStatus;
  costPerHr: number | null;
  /** When RunPod started billing the running pod (epoch ms): its `lastStartedAt`, or now − its uptime. Null when not running or not said. */
  startedAt: number | null;
}

/** RunPod's answer about one pod, REST- or GraphQL-shaped, as far as billing goes. */
interface PodBody {
  desiredStatus?: string;
  costPerHr?: number | string;
  adjustedCostPerHr?: number | string;
  lastStartedAt?: string | null;
  runtime?: { uptimeInSeconds?: number | null } | null;
}

/** Pure: when RunPod started billing a running pod, from its `lastStartedAt` or its runtime uptime. */
export function billingStartOf(body: PodBody | null | undefined, now: number): number | null {
  if (!body) return null;
  const started = typeof body.lastStartedAt === 'string' ? Date.parse(body.lastStartedAt) : Number.NaN;
  if (Number.isFinite(started) && started <= now) return started;
  const uptime = Number(body.runtime?.uptimeInSeconds);
  if (body.runtime && Number.isFinite(uptime) && uptime >= 0) return now - uptime * 1000;
  return null;
}

/** The running pod's uptime from RunPod's GraphQL API: REST's pod answer carries no runtime. */
async function billingStartViaGraphql(config: Pick<PodConfig, 'apiKey' | 'podId'>, fetchImpl: Fetch, now: number): Promise<number | null> {
  const r = await graphql(config.apiKey, `query { pod(input: { podId: ${JSON.stringify(config.podId)} }) { runtime { uptimeInSeconds } } }`, fetchImpl);
  const pod = r.ok ? (r.data?.['pod'] as PodBody | null | undefined) : null;
  return billingStartOf(pod, now);
}

export async function readPod(config: PodConfig, fetchImpl: Fetch = fetch, now: number = Date.now()): Promise<PodReading> {
  try {
    const response = await api(config, 'GET', '', fetchImpl);
    if (!response.ok) return { status: 'UNKNOWN', costPerHr: null, startedAt: null };
    const body = (await response.json()) as PodBody;
    const status = (['RUNNING', 'EXITED', 'TERMINATED'] as const).find((s) => s === body.desiredStatus) ?? 'UNKNOWN';
    const cost = Number(body.adjustedCostPerHr ?? body.costPerHr);
    let startedAt: number | null = null;
    if (status === 'RUNNING') {
      startedAt = billingStartOf(body, now);
      if (startedAt === null) startedAt = await billingStartViaGraphql(config, fetchImpl, now).catch(() => null);
    }
    return { status, costPerHr: Number.isFinite(cost) ? cost : null, startedAt };
  } catch {
    return { status: 'UNKNOWN', costPerHr: null, startedAt: null };
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

/* ------------------------------------------------------------------------- */
/* Moving a pod whose host has no GPU left                                    */
/* ------------------------------------------------------------------------- */

/**
 * RunPod's refusal when the pod's own host has no free GPU. A stopped pod is
 * pinned to that host, so retrying the same start cannot succeed until someone
 * else lets the card go — 109 refusals over eight hours on 2026-11-15, and the
 * same on 2026-11-05/06 until it happened to free. That is not a reason to keep
 * the GPU on forever; it is a reason to move.
 */
export const HOST_FULL = /not enough free GPUs|no (?:free|available) GPUs?|host machine/i;
/** Consecutive host refusals, with research waiting, after which the pod is moved rather than retried. */
export const MIGRATE_AFTER_REFUSALS = 3;

/** Pure: move the pod now? */
export function shouldMigrate(input: { status: PodStatus; waiting: number; hostRefusals: number }): boolean {
  return input.status === 'EXITED' && input.waiting > 0 && input.hostRefusals >= MIGRATE_AFTER_REFUSALS;
}

/** The recipe the pod serves: the active one when it serves this model, else the first that does. */
export function recipeServing(model: string | null | undefined): PodRecipe {
  const active = recipeFor(null);
  if (!model || active.served === model) return active;
  return Object.values(RECIPES).find((r) => r.served === model) ?? active;
}

const eventMeasures = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Pure: consecutive host refusals of THIS pod since it last stopped, started or moved,
 * newest first. Scoped to the pod: on 2026-11-15 a pod moved by hand inherited another
 * pod's 20 refusals, and the first stop of the new pod (a production test, 23:06Z) moved
 * it at once — deleting a pod that would have started.
 */
export function hostRefusalsOf(podId: string, rows: readonly { outcome: string; reason: string | null; podId: string | null }[]): number {
  let n = 0;
  for (const row of rows) {
    if (row.podId !== podId) continue;
    if (row.outcome !== 'START_FAILED') break;
    if (!HOST_FULL.test(row.reason ?? '')) break;
    n++;
  }
  return n;
}

/** Consecutive host refusals of the pod, read from the rows. */
async function hostRefusalsSinceStart(podId: string): Promise<number> {
  try {
    const rows = await getDb().all<{ outcome: string; reason: string | null; measures: unknown }>(
      `SELECT outcome, reason, measures FROM bin_events WHERE event_type = 'RUNPOD_POD'
          AND outcome IN ('STARTED', 'START_FAILED', 'STOPPED', 'MIGRATED')
        ORDER BY at DESC LIMIT 40`,
    );
    return hostRefusalsOf(
      podId,
      rows.map((r) => {
        const m = eventMeasures(r.measures);
        // A MIGRATED row belongs to the pod it moved from.
        const id = r.outcome === 'MIGRATED' ? m['from'] : m['podId'];
        return { outcome: r.outcome, reason: r.reason, podId: typeof id === 'string' ? id : null };
      }),
    );
  } catch {
    return 0;
  }
}

/**
 * Pure: where the configured pod was moved to, following the `MIGRATED` rows
 * (oldest first) from that pod. Null when no row moved it: a pod connected
 * after the last move is not moved by that move. Production 2026-11-16:
 * `runpod-upgrade` connected gpt-oss-120b on a new pod at 11:43Z and deleted
 * the Qwen pod, but the 00:33Z row that had moved the lane to the Qwen pod
 * still won, so every GPU call went to the deleted pod (HTTP 404), the route
 * was held as a broken GPU, and research waited beside the idle H100.
 */
export function movedPodUrl(configuredPodId: string | null, rows: readonly { from: unknown; podId: unknown; url: unknown }[]): string | null {
  if (!configuredPodId) return null;
  let pod = configuredPodId.toLowerCase();
  let url: string | null = null;
  for (const row of rows) {
    if (typeof row.from !== 'string' || row.from.toLowerCase() !== pod) continue;
    if (typeof row.podId !== 'string' || typeof row.url !== 'string' || !row.url) continue;
    pod = row.podId.toLowerCase();
    url = row.url;
  }
  return url;
}

/** Point the lane at the pod the `MIGRATED` rows moved the configured pod to. Survives restarts because it is rows. */
export async function loadMovedPod(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const rows = await getDb().all<{ measures: unknown }>(
      `SELECT measures FROM bin_events WHERE event_type = 'RUNPOD_POD' AND outcome = 'MIGRATED' ORDER BY at ASC`,
    );
    const configured = env['BRAIN_RUNPOD_POD_ID']?.trim() || podIdFromUrl(env['BRAIN_RUNPOD_URL'] ?? '');
    const url = movedPodUrl(configured, rows.map((r) => eventMeasures(r.measures)).map((m) => ({ from: m['from'], podId: m['podId'], url: m['url'] })));
    if (url && url !== runpodUrlOverride()) setRunpodUrlOverride(url);
    return url;
  } catch {
    return null;
  }
}

export interface MigrateDeps {
  fetchImpl?: Fetch;
  create?: typeof createPod;
  remove?: typeof deletePod;
  env?: NodeJS.ProcessEnv;
}

/**
 * Create the same recipe on another host, point the lane at it, and delete the
 * stranded pod (stopped, unstartable, holding nothing a new pod does not load
 * again). Every step is a `RUNPOD_POD` row.
 */
export async function migratePod(config: PodConfig, why: string, deps: MigrateDeps = {}): Promise<{ ok: boolean; url: string | null; podId: string | null; detail: string }> {
  const env = deps.env ?? process.env;
  const served = runpodConfig(env)?.model ?? null;
  const recipe = recipeServing(served);
  const ceiling = Number(env['BRAIN_RUNPOD_MAX_USD_PER_HOUR']) > 0 ? Number(env['BRAIN_RUNPOD_MAX_USD_PER_HOUR']) : DEFAULT_MAX_USD_PER_HOUR;
  const from = config.podId;
  if (!config.vllm.key) {
    const detail = 'no vLLM key (BRAIN_RUNPOD_KEY) to start a replacement with';
    await recordBinEvent({ eventType: 'RUNPOD_POD', provider: 'runpod', outcome: 'MIGRATE_FAILED', reason: `${why}; ${detail}`.slice(0, 400), measures: { from }, evidenceClass: 'MEASURED' }).catch(() => undefined);
    return { ok: false, url: null, podId: null, detail };
  }
  try {
    const made = await (deps.create ?? createPod)({
      apiKey: config.apiKey,
      vllmKey: config.vllm.key,
      recipe,
      name: POD_NAME,
      maxUsdPerHour: ceiling,
      ...(served ? { model: served } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const url = podUrl(made.podId);
    setRunpodUrlOverride(url);
    setRunpodPaused('pod starting');
    await recordBinEvent({
      eventType: 'RUNPOD_POD',
      provider: 'runpod',
      outcome: 'MIGRATED',
      reason: `${why}; moved to ${made.podId} (${recipe.key}) at $${made.costPerHr ?? '?'}/h`.slice(0, 400),
      measures: { from, podId: made.podId, url, recipe: recipe.key, costPerHr: made.costPerHr },
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
    const gone = await (deps.remove ?? deletePod)(config.apiKey, from, deps.fetchImpl).catch(() => 0);
    await recordBinEvent({
      eventType: 'RUNPOD_POD',
      provider: 'runpod',
      outcome: gone >= 200 && gone < 300 ? 'OLD_POD_DELETED' : 'OLD_POD_DELETE_FAILED',
      reason: `stranded pod ${from} (HTTP ${gone})`,
      measures: { podId: from },
      evidenceClass: 'MEASURED',
    }).catch(() => undefined);
    return { ok: true, url, podId: made.podId, detail: made.log.join(' | ') };
  } catch (error) {
    const detail = (error as Error).message.replace(/\s+/g, ' ').slice(0, 300);
    await recordBinEvent({ eventType: 'RUNPOD_POD', provider: 'runpod', outcome: 'MIGRATE_FAILED', reason: `${why}; ${detail}`.slice(0, 400), measures: { from, recipe: recipe.key, ceiling }, evidenceClass: 'MEASURED' }).catch(() => undefined);
    return { ok: false, url: null, podId: null, detail };
  }
}

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

const state = { idleSince: null as number | null, lastActionAt: 0, lastRun: 0, lastSample: 0, running: false, budgetMark: undefined as BudgetMark | null | undefined };

export function resetPodSupervisor(): void {
  state.idleSince = null;
  state.lastActionAt = 0;
  state.lastRun = 0;
  state.lastSample = 0;
  state.running = false;
  state.budgetMark = undefined;
  setRunpodPaused(null);
}

export interface SuperviseResult {
  status: PodStatus;
  ready: boolean;
  decision: PodDecision;
  acted: boolean;
  /** The dollar budget's reading this step; null when none applies. */
  budget: PodBudgetReading | null;
}

/**
 * One supervision step, from the capacity controller's own reading. Throttled
 * to `SUPERVISE_MS`; never throws.
 */
export async function superviseRunpodPod(
  input: { waiting: number; inFlight: number },
  deps: {
    fetchImpl?: Fetch;
    now?: () => number;
    config?: PodConfig | null;
    force?: boolean;
    lastStartFailed?: (now: number) => Promise<boolean>;
    hostRefusals?: (podId: string) => Promise<number>;
    migrate?: MigrateDeps;
    /**
     * The window's spend in dollars as the rows measure it; null when unreadable. RunPod's own
     * billing of the running pod still counts beside it (the larger of the two binds).
     */
    spend?: (since: string) => Promise<number | null>;
    /** The `RUNPOD_POD` rows since an instant (default: `readPodRows`), when `spend` is not given. */
    rows?: (since: string) => Promise<PodRow[]>;
    /**
     * Enforce the budget only: stop a pod that has exhausted it and change nothing else. Boot runs
     * this at once, so a pod RUNNING when Brain starts is counted before the free lane's first step.
     */
    budgetOnly?: boolean;
    /** Where the supervisor's own events go (default: `recordBinEvent`). */
    record?: (event: RecordBinEventInput) => Promise<void>;
  } = {},
): Promise<SuperviseResult | null> {
  if (deps.config === undefined) await loadMovedPod();
  const config = deps.config === undefined ? podConfig() : deps.config;
  if (!config) return null;
  const now = (deps.now ?? Date.now)();
  if (state.running || (!deps.force && now - state.lastRun < SUPERVISE_MS)) return null;
  state.running = true;
  state.lastRun = now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const record = deps.record ?? recordBinEvent;
  try {
    const pod = await readPod(config, fetchImpl, now);
    const live: LivePod = { podId: config.podId, status: pod.status, costPerHr: pod.costPerHr, startedAt: pod.startedAt };
    // Every row written while the pod runs carries when RunPod started billing it, so a stopped
    // pod's unsampled time (the model load, a Brain restart) is still in the window afterwards.
    const billedFrom = pod.status === 'RUNNING' && pod.startedAt !== null ? { startedAt: new Date(pod.startedAt).toISOString() } : {};
    let budget: PodBudgetReading | null = null;
    let spend: WindowSpend | null = null;
    if (config.budget) {
      if (deps.spend) {
        const since = budgetWindowStart(config.budget, now);
        const sampled = await deps.spend(new Date(since).toISOString()).catch(() => null);
        spend = windowSpendFromRows([], { since, now, live });
        const spent = sampled === null ? (spend.dollars >= config.budget.usd ? spend.dollars : null) : Math.max(sampled, spend.dollars);
        budget = budgetReading(config.budget, spent, now);
      } else {
        const read = await readBudget(config.budget, now, live, deps.rows);
        spend = read.spend;
        budget = budgetReading(config.budget, read.spent, now);
      }
      if (state.budgetMark === undefined) state.budgetMark = await lastBudgetMark();
      const mark = budgetEvent(budget, state.budgetMark);
      if (mark) {
        state.budgetMark = mark;
        await record({
          eventType: 'RUNPOD_POD',
          provider: 'runpod',
          outcome: mark,
          reason: `${budget.ended ? `bounded run's ${budget.windowHours} h window ended; ` : ''}GPU spend $${(budget.spent ?? 0).toFixed(2)} of $${budget.budget.toFixed(2)} in the last ${budget.windowHours} h${budget.defaulted ? ' (default budget: BRAIN_RUNPOD_BUDGET_USD unset)' : ''}`,
          measures: {
            podId: config.podId,
            spent: budget.spent,
            budget: budget.budget,
            windowHours: budget.windowHours,
            since: budget.since,
            ...(budget.ended ? { ended: true } : {}),
            status: pod.status,
            ...billedFrom,
            ...(spend ? { sampled: round(spend.sampled), billed: round(spend.billed), pods: spend.pods } : {}),
          },
          evidenceClass: 'MEASURED',
        }).catch(() => undefined);
      }
    }
    const busy = input.waiting > 0 || input.inFlight > 0;
    if (deps.budgetOnly) {
      // No reading of the work here: the idle timer is the free lane's.
    } else if (busy || pod.status !== 'RUNNING') state.idleSince = null;
    else if (state.idleSince === null) state.idleSince = now;

    const ready = pod.status === 'RUNNING' && (await vllmReady(config, fetchImpl));
    setRunpodPaused(pod.status === 'RUNNING' ? (ready ? null : 'vLLM still loading') : pod.status === 'UNKNOWN' ? null : `pod ${pod.status.toLowerCase()}`);

    const startFailedRecently = pod.status === 'RUNNING' && (await (deps.lastStartFailed ?? lastStartFailed)(now));
    const decided = decidePod({ status: pod.status, waiting: input.waiting, inFlight: input.inFlight, idleSince: state.idleSince, lastActionAt: state.lastActionAt, now, idleStopMs: config.idleStopMs, startFailedRecently, budget });
    const decision: PodDecision =
      deps.budgetOnly && !(decided.action === 'STOP' && budget?.exhausted) ? { action: 'NONE', reason: `budget check only: ${decided.reason}` } : decided;
    let acted = false;
    const refusals = decision.action === 'START' ? await (deps.hostRefusals ?? hostRefusalsSinceStart)(config.podId) : 0;
    if (decision.action === 'START' && shouldMigrate({ status: pod.status, waiting: input.waiting, hostRefusals: refusals })) {
      const moved = await migratePod(config, `${refusals} start(s) refused for a full host with ${input.waiting} research item(s) waiting`, {
        ...(deps.migrate ?? {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      state.lastActionAt = now;
      state.idleSince = null;
      return { status: pod.status, ready: false, decision: { action: 'START', reason: moved.ok ? `moved to ${moved.podId}` : `move failed: ${moved.detail}` }, acted: moved.ok, budget };
    }
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
      await record({
        eventType: 'RUNPOD_POD',
        provider: 'runpod',
        outcome,
        reason: `${decision.reason}${detail}`.slice(0, 400),
        measures: { podId: config.podId, waiting: input.waiting, inFlight: input.inFlight, status: pod.status, costPerHr: pod.costPerHr, ...billedFrom },
        evidenceClass: 'MEASURED',
      }).catch(() => undefined);
    }
    if (now - state.lastSample >= SAMPLE_MS) {
      state.lastSample = now;
      await record({
        eventType: 'RUNPOD_POD',
        provider: 'runpod',
        outcome: `SAMPLE_${pod.status}`,
        reason: decision.reason.slice(0, 400),
        durationMs: SAMPLE_MS,
        measures: { podId: config.podId, waiting: input.waiting, inFlight: input.inFlight, ready, costPerHr: pod.costPerHr, ...billedFrom },
        evidenceClass: 'MEASURED',
      }).catch(() => undefined);
    }
    return { status: pod.status, ready, decision, acted, budget };
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
  /** Dollars the pod billed over the sampled time: Σ costPerHr × hours, over samples that saw it RUNNING. */
  dollars: number;
  /** Hours of RUNNING samples that carried a price. */
  runningHours: number;
  /** RUNNING samples RunPod returned no price for: their time is not in `dollars`. */
  unpricedRunningSamples: number;
  /** Every `SAMPLE_*` row read, whatever the pod's status. */
  samples: number;
}

/**
 * The pod's GPU spend, derived from the `SAMPLE_*` rows the supervisor writes
 * every `SAMPLE_MS` with RunPod's own `costPerHr` (CAP-16-3: a gain is weighed
 * against dollars spent, and the dollars are measured, not assumed). A sample
 * covers its `durationMs`; only a RUNNING pod bills compute, so EXITED,
 * TERMINATED and UNKNOWN samples add nothing. Pure, so the figure replays from
 * the rows.
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
    const raw = row.measures['costPerHr'];
    const cost = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(cost) || cost < 0) {
      unpricedRunningSamples += 1;
      continue;
    }
    dollars += cost * hours;
    runningHours += hours;
  }
  return { dollars, runningHours, unpricedRunningSamples, samples };
}

/** The pod's spend since `since` (ISO), read from its `RUNPOD_POD` sample rows. */
export async function readPodSpend(since: string): Promise<PodSpend> {
  const rows = await getDb().all<{ outcome: string | null; duration_ms: number | string | null; measures: string | null }>(
    `SELECT outcome, duration_ms, measures FROM bin_events
      WHERE event_type = 'RUNPOD_POD' AND outcome LIKE 'SAMPLE_%' AND at >= ? ORDER BY at`,
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

/* ------------------------------------------------------------------------- */
/* Spend, as RunPod bills it                                                  */
/* ------------------------------------------------------------------------- */

/** One `RUNPOD_POD` row with its time, as far as billing is concerned. */
export interface PodRow extends PodSpendRow {
  /** Epoch ms. */
  at: number;
}

/** RunPod's own reading of the pod the supervisor serves. */
export interface LivePod {
  podId: string;
  status: PodStatus;
  costPerHr: number | null;
  /** When RunPod started billing it (epoch ms); null when not running or not said. */
  startedAt: number | null;
}

export interface PodWindowSpend {
  podId: string;
  /** Dollars from this pod's own samples in the window. */
  sampled: number;
  /** Dollars from the time RunPod billed it in the window × its price. */
  billed: number;
  billedHours: number;
  costPerHr: number | null;
}

export interface WindowSpend {
  /** Σ over pods of the larger of sampled and billed: what the budget binds on. */
  dollars: number;
  sampled: number;
  billed: number;
  pods: PodWindowSpend[];
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;
const podOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null);
const priceOf = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Rows that start a pod's billing, and rows that end it. */
const BILLING_STARTS = new Set(['STARTED', 'SAMPLE_RUNNING']);
const BILLING_ENDS = new Set(['STOPPED', 'OLD_POD_DELETED', 'SAMPLE_EXITED', 'SAMPLE_TERMINATED']);

/**
 * Pure: the GPU spend in the window `[since, now]`, per pod the larger of what
 * Brain's samples counted and what RunPod billed. Billed time is reconstructed
 * from the rows — a pod bills from `STARTED`, from the `MIGRATED` row that
 * created it, from the `startedAt` RunPod reported on any row, or from its first
 * RUNNING sample, until `STOPPED`, `OLD_POD_DELETED`, the `MIGRATED` row that
 * moved off it, or a sample that saw it stopped — and, for the pod being
 * served, from RunPod's own start time or uptime through now, so a RUNNING pod
 * with no samples at all counts from when RunPod started billing it. A pod whose
 * end nobody saw is closed one sample period after it was last seen running.
 */
export function windowSpendFromRows(rows: readonly PodRow[], input: { since: number; now: number; live?: LivePod | null }): WindowSpend {
  const { since, now } = input;
  const live = input.live ? { ...input.live, podId: input.live.podId.toLowerCase() } : null;
  const intervals = new Map<string, [number, number][]>();
  const open = new Map<string, number>();
  const lastRunning = new Map<string, number>();
  const price = new Map<string, number>();
  const sampleRows = new Map<string, PodSpendRow[]>();
  const add = (pod: string, from: number, to: number): void => {
    if (to > from) intervals.set(pod, [...(intervals.get(pod) ?? []), [from, to]]);
  };
  const start = (pod: string | null, at: number): void => {
    if (pod && (!open.has(pod) || open.get(pod)! > at)) open.set(pod, at);
  };
  const end = (pod: string | null, at: number): void => {
    if (!pod || !open.has(pod)) return;
    add(pod, open.get(pod)!, at);
    open.delete(pod);
  };
  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    const pod = podOf(row.measures['podId']);
    const cost = priceOf(row.measures['costPerHr']);
    if (pod && cost !== null) price.set(pod, cost);
    if (row.outcome.startsWith('SAMPLE_') && row.at >= since) sampleRows.set(pod ?? '', [...(sampleRows.get(pod ?? '') ?? []), row]);
    const reported = typeof row.measures['startedAt'] === 'string' ? Date.parse(row.measures['startedAt']) : Number.NaN;
    if (pod && Number.isFinite(reported) && reported <= row.at) add(pod, reported, row.at);
    if (row.outcome === 'MIGRATED') {
      end(podOf(row.measures['from']), row.at);
      start(pod, row.at);
    } else if (BILLING_STARTS.has(row.outcome)) {
      start(pod, row.outcome === 'SAMPLE_RUNNING' ? row.at - (row.durationMs ?? SAMPLE_MS) : row.at);
      if (pod && row.outcome === 'SAMPLE_RUNNING') lastRunning.set(pod, row.at);
    } else if (BILLING_ENDS.has(row.outcome)) end(pod, row.at);
  }
  for (const [pod, from] of open) {
    if (live && live.podId === pod && live.status === 'RUNNING') add(pod, from, now);
    else add(pod, from, Math.min(now, Math.max(from, lastRunning.get(pod) ?? from) + SAMPLE_MS));
  }
  if (live && live.status === 'RUNNING' && live.startedAt !== null) add(live.podId, live.startedAt, now);
  if (live && live.costPerHr !== null) price.set(live.podId, live.costPerHr);

  const pods = new Set<string>([...intervals.keys(), ...sampleRows.keys()]);
  const out: PodWindowSpend[] = [];
  let dollars = 0;
  let sampledTotal = 0;
  let billedTotal = 0;
  for (const pod of pods) {
    const merged = [...(intervals.get(pod) ?? [])]
      .map(([a, b]): [number, number] => [Math.max(a, since), Math.min(b, now)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0]);
    let ms = 0;
    let cursor = -Infinity;
    for (const [a, b] of merged) {
      const from = Math.max(a, cursor);
      if (b > from) ms += b - from;
      cursor = Math.max(cursor, b);
    }
    const cost = price.get(pod) ?? null;
    const billedHours = ms / 3_600_000;
    const billed = cost === null ? 0 : billedHours * cost;
    const sampled = podSpendFromRows(sampleRows.get(pod) ?? []).dollars;
    dollars += Math.max(sampled, billed);
    sampledTotal += sampled;
    billedTotal += billed;
    out.push({ podId: pod, sampled: round(sampled), billed: round(billed), billedHours: round(billedHours), costPerHr: cost });
  }
  return { dollars, sampled: sampledTotal, billed: billedTotal, pods: out };
}

/** The `RUNPOD_POD` rows that bear on billing since `since` (ISO). */
export async function readPodRows(since: string): Promise<PodRow[]> {
  const rows = await getDb().all<{ at: string | Date; outcome: string | null; duration_ms: number | string | null; measures: unknown }>(
    `SELECT at, outcome, duration_ms, measures FROM bin_events
      WHERE event_type = 'RUNPOD_POD' AND at >= ?
        AND (outcome LIKE 'SAMPLE_%' OR outcome IN ('STARTED', 'STOPPED', 'MIGRATED', 'OLD_POD_DELETED', 'BUDGET_EXHAUSTED', 'BUDGET_AVAILABLE'))
      ORDER BY at`,
    [since],
  );
  return rows.map((r) => {
    const duration = r.duration_ms === null ? null : Number(r.duration_ms);
    return { at: r.at instanceof Date ? r.at.getTime() : Date.parse(String(r.at)), outcome: r.outcome ?? '', durationMs: duration !== null && Number.isFinite(duration) ? duration : null, measures: eventMeasures(r.measures) };
  });
}
