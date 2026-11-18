/**
 * Deadline intelligence: how long work will take, how many hands it needs, and
 * whether a deadline holds (§113, owner's permanent rule 2026-11-18).
 *
 * §112 made a deadline a delivery commitment an independent scheduler enforces.
 * What it could not do was *estimate*: every open item cost a session-typed
 * guess (30 minutes by default), the items were summed as if one person did
 * them one after another, and nothing ever compared a guess with what
 * happened. The GPU-readiness deadlines of 2026-11-17 were missed by exactly
 * those gaps — two-hour verification cycles forecast as thirty minutes, deploys
 * that replaced each other before verification, a fixed staff of two sessions
 * on work that fanned out, and the fourth hidden failure discovered by a paid
 * GPU window that a database query could have found.
 *
 * This module is the one place those answers are computed. It is pure and uses
 * only erasable TypeScript, so the server (the engineering connector, Factory)
 * and the finish-the-job hook (plain `node`) import the same code.
 *
 *   estimateKind   — a duration from measured history: the 80th percentile of
 *                    successful runs, multiplied by the expected number of
 *                    attempts the kind's own failure rate implies. An
 *                    unmeasured kind is flagged and costed pessimistically.
 *   schedule       — list scheduling over the dependency graph with W workers
 *                    and exclusive resources (one deploy pipeline, one GPU),
 *                    longest-remaining-path first. Gives work (sum) and
 *                    elapsed (makespan) separately, and the critical path.
 *   staffing       — the fewest workers that meet the window, and the point
 *                    past which another worker no longer shortens anything.
 *   assessDeadline — acceptance: FEASIBLE, NEEDS_RESOURCES (how many), or
 *                    INFEASIBLE (the limiting chain, the earliest completion,
 *                    and what descoping nonessential work would buy).
 *   reforecast     — during execution: actual durations so far, overruns,
 *                    stalls, the new forecast, and the action that protects
 *                    the deadline (add workers, reassign, descope, escalate).
 *   lintPlan       — the failure patterns of 2026-11-17 as plan hazards.
 *   outcomesOf     — estimate vs actual for each finished task, which the
 *                    caller persists and the next estimate reads.
 */

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/** One measured run of a kind of work. */
export interface DurationSample {
  kind: string;
  minutes: number;
  /** The run failed (or was rolled back) and had to be repeated. */
  failed: boolean;
  /** Where the measurement came from, e.g. "factory_sessions", "deploy.yml". */
  source: string;
}

export interface KindEstimate {
  kind: string;
  /** Median of successful runs. */
  p50Min: number;
  /** 80th percentile of successful runs. */
  p80Min: number;
  /** Share of runs that failed and had to be repeated. */
  failureRate: number;
  /** 1 / (1 − failureRate), capped: how many attempts a success costs on average. */
  attemptsExpected: number;
  /** What a schedule should budget: p80 × attemptsExpected. */
  plannedMin: number;
  /** Optimistic: p50 with no failure. */
  optimisticMin: number;
  samples: number;
  measured: boolean;
  basis: string;
}

export type TaskStatus = 'TODO' | 'RUNNING' | 'DONE' | 'BLOCKED';

export interface PlanTask {
  id: string;
  /** The kind whose history estimates it (CODE, REVIEW, CI, DEPLOY, GPU_VERIFY, DB_CHECK, …). */
  kind: string;
  deps?: string[];
  /** An exclusive resource only one task may hold at a time (DEPLOY_PIPELINE, GPU, a file scope). */
  resource?: string | null;
  /** An explicit estimate in minutes; overrides history when history has no samples. */
  estimateMin?: number | null;
  /** False marks it nonessential: it may be descoped to protect the deadline. */
  essential?: boolean;
  /** Part of the deadline's acceptance criteria: never descoped. */
  acceptance?: boolean;
  status?: TaskStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Who is on it (a session, a Factory lane, a worker id). */
  owner?: string | null;
}

export interface ScheduledTask {
  id: string;
  kind: string;
  startMin: number;
  endMin: number;
  durationMin: number;
  worker: number;
  onCriticalPath: boolean;
}

export interface Schedule {
  workers: number;
  /** Sum of every task's duration: total worker-minutes. */
  workMin: number;
  /** Wall-clock minutes from start to the last task's end under this many workers. */
  elapsedMin: number;
  /** The longest dependency chain alone — no number of workers beats it. */
  pathMin: number;
  /** The chain of task ids that decides elapsedMin. */
  criticalPath: string[];
  tasks: ScheduledTask[];
}

export interface Staffing {
  /** Fewest workers whose schedule fits the window, or null if none up to the cap does. */
  minimumWorkers: number | null;
  /** Workers past which another one no longer shortens the schedule. */
  usefulWorkers: number;
  /** The elapsed minutes at each worker count tried, 1..cap. */
  curve: Array<{ workers: number; elapsedMin: number }>;
}

export type Verdict = 'FEASIBLE' | 'NEEDS_RESOURCES' | 'INFEASIBLE';

export interface Assessment {
  verdict: Verdict;
  now: string;
  deadline: string;
  windowMin: number;
  availableWorkers: number;
  maxWorkers: number;
  /** Workers to commit: enough to meet the window, more while more still shortens it. */
  commitWorkers: number;
  plan: Schedule;
  optimistic: Schedule;
  staffing: Staffing;
  /** Planned and optimistic completion at commitWorkers. */
  forecastAt: string;
  optimisticAt: string;
  /** Where the evidence supports one: LIKELY (≥ the planned p80 path fits), POSSIBLE, UNLIKELY, or UNKNOWN. */
  likelihood: 'LIKELY' | 'POSSIBLE' | 'UNLIKELY' | 'UNKNOWN';
  likelihoodBasis: string;
  /** The dependency that limits completion when the deadline cannot be met. */
  limiting: string | null;
  /** Earliest evidence-supported completion at the most workers authorized. */
  earliestAt: string;
  alternatives: string[];
  estimates: KindEstimate[];
  hazards: string[];
  actions: string[];
}

/* ------------------------------------------------------------------------- */
/* Estimates from measured history                                            */
/* ------------------------------------------------------------------------- */

/** No more than this many attempts are assumed, however bad a kind's record. */
const MAX_ATTEMPTS = 3;
/** Below this many samples a kind's history is not trusted alone: it is widened. */
const MIN_TRUSTED_SAMPLES = 5;
/** An unmeasured kind's explicit or default estimate is multiplied by this. */
const UNMEASURED_FACTOR = 1.5;

/**
 * Defaults for a kind with no history at all — flagged UNMEASURED wherever they
 * are used, never presented as a measurement. Reasonable orders of magnitude,
 * not promises: the first real outcome replaces them.
 */
export const UNMEASURED_DEFAULT_MIN: Readonly<Record<string, number>> = {
  DB_CHECK: 5,
  LOCAL_CHECK: 10,
  DIAGNOSE: 30,
  CODE: 45,
  REVIEW: 20,
  INTEGRATE: 20,
  CI: 30,
  DEPLOY: 35,
  MODEL_LOAD: 15,
  GPU_VERIFY: 60,
  REPORT: 10,
  REQUIREMENT: 30,
};

/** The kinds that cost real money or production time to run. */
export const EXPENSIVE_KINDS: ReadonlySet<string> = new Set(['GPU_VERIFY', 'MODEL_LOAD', 'PROD_VERIFY']);
/** The kinds that can establish a prerequisite cheaply. */
export const CHEAP_CHECK_KINDS: ReadonlySet<string> = new Set(['DB_CHECK', 'LOCAL_CHECK', 'REPORT', 'DIAGNOSE']);

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A kind's estimate from its samples; `fallbackMin` is used only when there are none. */
export function estimateKind(kind: string, samples: readonly DurationSample[], fallbackMin?: number | null): KindEstimate {
  const own = samples.filter((s) => s.kind === kind && Number.isFinite(s.minutes) && s.minutes >= 0);
  const ok = own.filter((s) => !s.failed).map((s) => s.minutes).sort((a, b) => a - b);
  const sources = [...new Set(own.map((s) => s.source))].join(', ');
  if (ok.length === 0) {
    const base = fallbackMin ?? UNMEASURED_DEFAULT_MIN[kind] ?? UNMEASURED_DEFAULT_MIN.REQUIREMENT!;
    const failureRate = own.length > 0 ? 1 : 0;
    return {
      kind, p50Min: base, p80Min: base, failureRate, attemptsExpected: 1,
      plannedMin: round1(base * UNMEASURED_FACTOR), optimisticMin: base,
      samples: own.length, measured: false,
      basis: `UNMEASURED: no successful ${kind} run on record${own.length ? ` (${own.length} failed)` : ''}; ${fallbackMin ? 'the stated' : 'a default'} ${base} min × ${UNMEASURED_FACTOR}`,
    };
  }
  const failureRate = own.length ? own.filter((s) => s.failed).length / own.length : 0;
  const attemptsExpected = Math.min(MAX_ATTEMPTS, 1 / Math.max(1 - failureRate, 1 / MAX_ATTEMPTS));
  const p50 = quantile(ok, 0.5);
  // Too few samples: the observed spread understates the real one.
  const p80 = ok.length < MIN_TRUSTED_SAMPLES ? Math.max(quantile(ok, 0.8), p50 * 1.5) : quantile(ok, 0.8);
  return {
    kind, p50Min: round1(p50), p80Min: round1(p80), failureRate: round1(failureRate * 100) / 100,
    attemptsExpected: round1(attemptsExpected), plannedMin: round1(p80 * attemptsExpected), optimisticMin: round1(p50),
    samples: own.length, measured: true,
    basis: `MEASURED: ${ok.length} successful of ${own.length} ${kind} run(s) (${sources}); p50 ${round1(p50)} · p80 ${round1(p80)} min · ${Math.round(failureRate * 100)}% repeated → ×${round1(attemptsExpected)}${ok.length < MIN_TRUSTED_SAMPLES ? ' · few samples, widened' : ''}`,
  };
}

/** Estimates for every kind the tasks use. */
export function estimatesFor(tasks: readonly PlanTask[], samples: readonly DurationSample[]): Map<string, KindEstimate> {
  const out = new Map<string, KindEstimate>();
  for (const t of tasks) {
    if (out.has(t.kind)) continue;
    const explicit = tasks.find((x) => x.kind === t.kind && x.estimateMin)?.estimateMin ?? null;
    out.set(t.kind, estimateKind(t.kind, samples, explicit));
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* ------------------------------------------------------------------------- */

/** The task ids in a dependency cycle, or null. Unknown deps are an error too. */
export function planErrors(tasks: readonly PlanTask[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const errors: string[] = [];
  if (ids.size !== tasks.length) errors.push('two tasks share an id');
  for (const t of tasks) for (const d of t.deps ?? []) if (!ids.has(d)) errors.push(`${t.id} depends on unknown task ${d}`);
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`dependency cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`);
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id)?.deps ?? []) if (byId.has(d)) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return [...new Set(errors)];
}

/**
 * List-schedule `tasks` on `workers` workers. `duration(task)` gives minutes; a
 * task already DONE costs 0 and a RUNNING one costs what `duration` says is
 * left. Priority is the longest remaining path to the end (critical first), so
 * the worker count is spent where it shortens completion.
 */
export function schedule(tasks: readonly PlanTask[], workers: number, duration: (t: PlanTask) => number): Schedule {
  const w = Math.max(1, Math.floor(workers));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dur = new Map(tasks.map((t) => [t.id, t.status === 'DONE' ? 0 : Math.max(0, duration(t))]));
  const children = new Map<string, string[]>(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.deps ?? []) children.get(d)?.push(t.id);
  // Longest path from each task to any end (its own duration included).
  const tail = new Map<string, number>();
  const tailOf = (id: string): number => {
    const known = tail.get(id);
    if (known !== undefined) return known;
    const v = (dur.get(id) ?? 0) + Math.max(0, ...(children.get(id) ?? []).map(tailOf));
    tail.set(id, v);
    return v;
  };
  for (const t of tasks) tailOf(t.id);

  const finish = new Map<string, number>();
  const workerFree = Array.from({ length: w }, () => 0);
  const resourceFree = new Map<string, number>();
  const placed: ScheduledTask[] = [];
  const pending = new Set(tasks.map((t) => t.id));
  // A RUNNING task already holds a worker from t=0; place those first.
  const running = tasks.filter((t) => t.status === 'RUNNING');
  while (pending.size > 0) {
    const ready = [...pending].filter((id) => (byId.get(id)!.deps ?? []).every((d) => finish.has(d)));
    if (ready.length === 0) break; // a cycle: planErrors reports it
    ready.sort((a, b) => {
      const ra = running.some((t) => t.id === a) ? 1 : 0;
      const rb = running.some((t) => t.id === b) ? 1 : 0;
      return rb - ra || tail.get(b)! - tail.get(a)! || a.localeCompare(b);
    });
    const id = ready[0]!;
    const t = byId.get(id)!;
    const depsDone = Math.max(0, ...(t.deps ?? []).map((d) => finish.get(d)!));
    const d = dur.get(id)!;
    let start: number;
    let worker = -1;
    if (d === 0) {
      start = depsDone;
    } else {
      worker = workerFree.indexOf(Math.min(...workerFree));
      start = Math.max(depsDone, workerFree[worker]!, t.resource ? resourceFree.get(t.resource) ?? 0 : 0);
      workerFree[worker] = start + d;
      if (t.resource) resourceFree.set(t.resource, start + d);
    }
    finish.set(id, start + d);
    placed.push({ id, kind: t.kind, startMin: round1(start), endMin: round1(start + d), durationMin: round1(d), worker, onCriticalPath: false });
    pending.delete(id);
  }

  const elapsed = Math.max(0, ...placed.map((p) => p.endMin));
  // Walk back from the last finisher through whatever made each task wait.
  const critical: string[] = [];
  let cursor = placed.filter((p) => p.endMin === elapsed && p.durationMin > 0).sort((a, b) => a.id.localeCompare(b.id))[0];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    critical.unshift(cursor.id);
    const t = byId.get(cursor.id)!;
    const startAt: number = cursor.startMin;
    const blocker: ScheduledTask | undefined =
      placed.find((p) => (t.deps ?? []).includes(p.id) && Math.abs(p.endMin - startAt) < 0.05) ??
      placed.find((p) => p.durationMin > 0 && p.id !== cursor!.id && Math.abs(p.endMin - startAt) < 0.05 &&
        ((t.resource && byId.get(p.id)?.resource === t.resource) || p.worker === cursor!.worker));
    cursor = startAt > 0 ? blocker : undefined;
  }
  for (const p of placed) p.onCriticalPath = critical.includes(p.id);
  return {
    workers: w,
    workMin: round1([...dur.values()].reduce((s, v) => s + v, 0)),
    elapsedMin: round1(elapsed),
    pathMin: round1(Math.max(0, ...tasks.map((t) => tail.get(t.id) ?? 0))),
    criticalPath: critical,
    tasks: placed,
  };
}

/** Elapsed time at 1..cap workers; the fewest that fit, and where more stops helping. */
export function staffing(tasks: readonly PlanTask[], windowMin: number, cap: number, duration: (t: PlanTask) => number): Staffing {
  const top = Math.max(1, Math.floor(cap));
  const curve = Array.from({ length: top }, (_, i) => ({ workers: i + 1, elapsedMin: schedule(tasks, i + 1, duration).elapsedMin }));
  const best = Math.min(...curve.map((c) => c.elapsedMin));
  const fit = curve.find((c) => c.elapsedMin <= windowMin);
  const useful = curve.find((c) => c.elapsedMin <= best + 0.05)!.workers;
  return { minimumWorkers: fit ? fit.workers : null, usefulWorkers: useful, curve };
}

/* ------------------------------------------------------------------------- */
/* Hazards: the failure patterns of 2026-11-17                                 */
/* ------------------------------------------------------------------------- */

export function lintPlan(tasks: readonly PlanTask[], estimates: ReadonlyMap<string, KindEstimate>): string[] {
  const hazards: string[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ancestors = (id: string, acc = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)?.deps ?? []) if (!acc.has(d)) { acc.add(d); ancestors(d, acc); }
    return acc;
  };
  for (const t of tasks) {
    if (!EXPENSIVE_KINDS.has(t.kind) || t.status === 'DONE') continue;
    // A paid test of a deployed version needs a cheap check *of that version*:
    // one that itself comes after the deploy. With no deploy upstream, any cheap ancestor will do.
    const ups = ancestors(t.id);
    const deploysUp = [...ups].filter((a) => byId.get(a)?.kind === 'DEPLOY');
    const cheap = [...ups].some((a) => CHEAP_CHECK_KINDS.has(byId.get(a)?.kind ?? '') && deploysUp.every((dep) => ancestors(a).has(dep)));
    if (!cheap) hazards.push(`${t.id} (${t.kind}) runs before any cheap check (DB_CHECK, LOCAL_CHECK, REPORT, DIAGNOSE)${deploysUp.length ? ' of the deployed version' : ''} established its prerequisites: add one${deploysUp.length ? ' after the deploy' : ''} and make ${t.id} depend on it`);
    if (!t.resource) hazards.push(`${t.id} (${t.kind}) names no exclusive resource: two verifications could overlap on one pod`);
  }
  const deploys = tasks.filter((t) => t.kind === 'DEPLOY' && t.status !== 'DONE');
  if (deploys.some((t) => t.resource !== 'DEPLOY_PIPELINE')) {
    hazards.push(`deploy task(s) ${deploys.filter((t) => t.resource !== 'DEPLOY_PIPELINE').map((t) => t.id).join(', ')} are not on the DEPLOY_PIPELINE resource: overlapping releases replace each other before verification`);
  }
  for (const t of tasks) {
    if (!EXPENSIVE_KINDS.has(t.kind) && t.kind !== 'DEPLOY') continue;
    const later = tasks.filter((x) => x.kind === 'DEPLOY' && x.id !== t.id && x.status !== 'DONE' && !ancestors(x.id).has(t.id) && !ancestors(t.id).has(x.id));
    if (EXPENSIVE_KINDS.has(t.kind) && later.length && t.status !== 'DONE') {
      hazards.push(`${t.id} measures a deployed version, but deploy(s) ${later.map((x) => x.id).join(', ')} are unordered with it: hold a stable release candidate — order them, or the measurement is of a version that no longer runs`);
    }
  }
  const diag = tasks.filter((t) => t.kind === 'DIAGNOSE');
  const chained = diag.filter((t) => (t.deps ?? []).some((d) => byId.get(d)?.kind === 'DIAGNOSE'));
  if (chained.length) hazards.push(`diagnosis is serialized (${chained.map((t) => t.id).join(', ')} wait on another diagnosis): independent components are diagnosed concurrently, before the long cycle starts`);
  const unmeasured = [...estimates.values()].filter((e) => !e.measured);
  if (unmeasured.length) hazards.push(`unmeasured kind(s) ${unmeasured.map((e) => e.kind).join(', ')}: their durations are defaults ×${UNMEASURED_FACTOR}, not history — record outcomes so the next estimate is measured`);
  return hazards;
}

/* ------------------------------------------------------------------------- */
/* Acceptance                                                                 */
/* ------------------------------------------------------------------------- */

export interface AssessInput {
  tasks: readonly PlanTask[];
  samples: readonly DurationSample[];
  now: string;
  deadline: string;
  /** Workers committed now. */
  availableWorkers: number;
  /** The most workers the existing spending authority allows. */
  maxWorkers: number;
}

const iso = (now: string, plusMin: number): string => new Date(Date.parse(now) + plusMin * 60_000).toISOString();

/** Planned minutes for a task: its kind's plannedMin, or what is left of it if running. */
function plannedDuration(estimates: ReadonlyMap<string, KindEstimate>, now: number, pick: 'plannedMin' | 'optimisticMin') {
  return (t: PlanTask): number => {
    const e = estimates.get(t.kind);
    const full = e ? e[pick] : t.estimateMin ?? UNMEASURED_DEFAULT_MIN.REQUIREMENT!;
    if (t.status === 'RUNNING' && t.startedAt) {
      const spent = (now - Date.parse(t.startedAt)) / 60_000;
      // Overrun: assume at least a quarter of the estimate is still to go.
      return Math.max(full - spent, full * 0.25);
    }
    return full;
  };
}

export function assessDeadline(input: AssessInput): Assessment {
  const errors = planErrors(input.tasks);
  if (errors.length) throw new Error(`invalid plan: ${errors.join('; ')}`);
  const now = Date.parse(input.now);
  const windowMin = Math.round((Date.parse(input.deadline) - now) / 60_000);
  const estimates = estimatesFor(input.tasks, input.samples);
  const planned = plannedDuration(estimates, now, 'plannedMin');
  const optimistic = plannedDuration(estimates, now, 'optimisticMin');
  const maxWorkers = Math.max(1, input.maxWorkers, input.availableWorkers);
  const available = Math.max(1, input.availableWorkers);
  const staff = staffing(input.tasks, windowMin, maxWorkers, planned);
  const fitsAvailable = staff.minimumWorkers !== null && staff.minimumWorkers <= available;
  const verdict: Verdict = fitsAvailable ? 'FEASIBLE' : staff.minimumWorkers !== null ? 'NEEDS_RESOURCES' : 'INFEASIBLE';
  // Commit enough to fit, and more while more still shortens the path (owner: "if four finish sooner, consider four").
  const commitWorkers = verdict === 'INFEASIBLE' ? staff.usefulWorkers : Math.max(staff.minimumWorkers!, Math.min(staff.usefulWorkers, maxWorkers));
  const plan = schedule(input.tasks, commitWorkers, planned);
  const opt = schedule(input.tasks, commitWorkers, optimistic);
  const best = schedule(input.tasks, staff.usefulWorkers, planned);
  const allMeasured = [...estimates.values()].every((e) => e.measured);
  const likelihood: Assessment['likelihood'] = !allMeasured
    ? 'UNKNOWN'
    : plan.elapsedMin <= windowMin ? 'LIKELY' : opt.elapsedMin <= windowMin ? 'POSSIBLE' : 'UNLIKELY';
  const likelihoodBasis = !allMeasured
    ? `not stated: ${[...estimates.values()].filter((e) => !e.measured).map((e) => e.kind).join(', ')} unmeasured`
    : `planned path (p80 × expected attempts) ${plan.elapsedMin} min, optimistic (p50, no failure) ${opt.elapsedMin} min, window ${windowMin} min`;

  const limiting = plan.elapsedMin > windowMin
    ? `${plan.criticalPath.map((id) => `${id} (${input.tasks.find((t) => t.id === id)?.kind}, ${plan.tasks.find((p) => p.id === id)?.durationMin} min)`).join(' → ')}`
    : null;
  const alternatives: string[] = [];
  const nonessential = input.tasks.filter((t) => t.essential === false && !t.acceptance && t.status !== 'DONE');
  if (verdict !== 'FEASIBLE' && nonessential.length) {
    const drop = new Set(nonessential.map((t) => t.id));
    const kept = input.tasks.filter((t) => !drop.has(t.id)).map((t) => ({ ...t, deps: (t.deps ?? []).filter((d) => !drop.has(d)) }));
    const trimmed = schedule(kept, commitWorkers, planned);
    alternatives.push(`descope nonessential ${[...drop].join(', ')}: planned ${trimmed.elapsedMin} min (${trimmed.elapsedMin <= windowMin ? 'meets' : 'still misses'} the ${windowMin}-min window)`);
  }
  if (verdict === 'INFEASIBLE') {
    alternatives.push(`move the deadline to the earliest evidence-supported completion ${iso(input.now, best.elapsedMin)} (owner's decision; the session never extends it)`);
    alternatives.push(`shorten the limiting chain itself — a cheaper check in place of a production test where one can answer, or a faster resource on the longest task`);
  }
  const actions: string[] = [];
  if (verdict === 'FEASIBLE') actions.push(`commit ${commitWorkers} worker(s) and start the ${plan.tasks.filter((t) => t.startMin === 0 && t.durationMin > 0).length} task(s) with no open dependency now`);
  if (verdict === 'NEEDS_RESOURCES') actions.push(`add ${staff.minimumWorkers! - available} worker(s) (to ${staff.minimumWorkers}) within the spending authority — fewer cannot meet the window`);
  if (verdict === 'INFEASIBLE') actions.push(`escalate now, before work starts: ${limiting} needs ${best.elapsedMin} min even at ${staff.usefulWorkers} worker(s); the window is ${windowMin} min`);
  if (commitWorkers < staff.usefulWorkers) actions.push(`${staff.usefulWorkers} worker(s) would finish at ${best.elapsedMin} min instead of ${plan.elapsedMin}; more than ${staff.usefulWorkers} shortens nothing`);
  return {
    verdict, now: input.now, deadline: input.deadline, windowMin, availableWorkers: available, maxWorkers, commitWorkers,
    plan, optimistic: opt, staffing: staff,
    forecastAt: iso(input.now, plan.elapsedMin), optimisticAt: iso(input.now, opt.elapsedMin),
    likelihood, likelihoodBasis, limiting, earliestAt: iso(input.now, best.elapsedMin), alternatives,
    estimates: [...estimates.values()], hazards: lintPlan(input.tasks, estimates), actions,
  };
}

/* ------------------------------------------------------------------------- */
/* During execution                                                           */
/* ------------------------------------------------------------------------- */

export interface Slip {
  id: string;
  kind: string;
  plannedMin: number;
  spentMin: number;
  /** OVERRUN: past its planned duration. STALLED: past twice it. */
  state: 'OVERRUN' | 'STALLED';
  onCriticalPath: boolean;
}

export interface Reforecast {
  now: string;
  deadline: string;
  remainingMin: number;
  forecastAt: string;
  onTrack: boolean;
  /** Minutes the forecast lands after the deadline (0 when on track). */
  lateByMin: number;
  remainingTasks: number;
  blocked: string[];
  slips: Slip[];
  workers: number;
  utilization: number;
  /** Elapsed minutes at the most useful worker count, from now. */
  bestElapsedMin: number;
  actions: string[];
  /** The actual cause when off track: the chain that decides the forecast. */
  cause: string | null;
}

/**
 * A material event happened (a task finished, slipped or was added): recompute
 * from now. Each recommendation is one the caller can execute, in the owner's
 * order — find the cause, add parallelism, stronger resources, stop waiting,
 * reorder, then descope — and only then escalate.
 */
export function reforecast(input: AssessInput): Reforecast {
  const now = Date.parse(input.now);
  const remainingMin = Math.round((Date.parse(input.deadline) - now) / 60_000);
  const estimates = estimatesFor(input.tasks, input.samples);
  const planned = plannedDuration(estimates, now, 'plannedMin');
  const open = input.tasks.filter((t) => t.status !== 'DONE');
  const workers = Math.max(1, input.availableWorkers);
  const plan = schedule(input.tasks, workers, planned);
  const staff = staffing(input.tasks, remainingMin, Math.max(workers, input.maxWorkers), planned);
  const best = schedule(input.tasks, staff.usefulWorkers, planned);
  const slips: Slip[] = [];
  for (const t of input.tasks) {
    if (t.status !== 'RUNNING' || !t.startedAt) continue;
    const e = estimates.get(t.kind)!;
    const spent = (now - Date.parse(t.startedAt)) / 60_000;
    if (spent > e.plannedMin) {
      slips.push({ id: t.id, kind: t.kind, plannedMin: e.plannedMin, spentMin: round1(spent), state: spent > 2 * e.plannedMin ? 'STALLED' : 'OVERRUN', onCriticalPath: plan.criticalPath.includes(t.id) });
    }
  }
  const blocked = input.tasks.filter((t) => t.status === 'BLOCKED').map((t) => t.id);
  const lateBy = Math.max(0, Math.round(plan.elapsedMin - remainingMin));
  const onTrack = lateBy === 0;
  const busy = plan.tasks.reduce((s, p) => s + p.durationMin, 0);
  const utilization = plan.elapsedMin > 0 ? round1((busy / (plan.elapsedMin * workers)) * 100) / 100 : 0;
  const cause = onTrack ? null : plan.criticalPath.map((id) => {
    const s = slips.find((x) => x.id === id);
    return `${id}${s ? ` (${s.state}: ${s.spentMin}/${s.plannedMin} min)` : ''}`;
  }).join(' → ');
  const actions: string[] = [];
  for (const s of slips.filter((x) => x.state === 'STALLED')) actions.push(`reassign ${s.id}: ${s.spentMin} min on a ${s.plannedMin}-min task — stalled; give it to another worker or a stronger model`);
  if (!onTrack) {
    if (staff.usefulWorkers > workers) actions.push(`add ${staff.usefulWorkers - workers} worker(s) (to ${staff.usefulWorkers}): forecast falls from ${plan.elapsedMin} to ${best.elapsedMin} min`);
    for (const s of slips.filter((x) => x.state === 'OVERRUN' && x.onCriticalPath)) actions.push(`${s.id} is on the critical path and over its estimate: put the strongest available model on it`);
    const idleStarts = plan.tasks.filter((p) => p.durationMin > 0 && p.startMin > 0 && !(input.tasks.find((t) => t.id === p.id)?.deps ?? []).length);
    if (idleStarts.length) actions.push(`start ${idleStarts.map((p) => p.id).join(', ')} now: no dependency holds them, only a busy worker`);
    if (blocked.length) actions.push(`clear blocked ${blocked.join(', ')} or route around them`);
    const nonessential = open.filter((t) => t.essential === false && !t.acceptance);
    if (nonessential.length) actions.push(`descope nonessential ${nonessential.map((t) => t.id).join(', ')} (reported unfinished, never dropped silently)`);
    if (best.elapsedMin > remainingMin) actions.push(`escalate: even at ${staff.usefulWorkers} worker(s) the forecast is ${iso(input.now, best.elapsedMin)}, after the deadline ${input.deadline}; the deadline report is still delivered at the deadline`);
  }
  return {
    now: input.now, deadline: input.deadline, remainingMin, forecastAt: iso(input.now, plan.elapsedMin), onTrack, lateByMin: lateBy,
    remainingTasks: open.length, blocked, slips, workers, utilization, bestElapsedMin: best.elapsedMin, actions, cause,
  };
}

/* ------------------------------------------------------------------------- */
/* Learning                                                                   */
/* ------------------------------------------------------------------------- */

export interface TaskOutcome {
  id: string;
  kind: string;
  estimateMin: number;
  actualMin: number;
  /** actual / estimate: above 1 means the estimate was short. */
  ratio: number;
  failed: boolean;
}

/** Estimate vs actual for every task that finished, ready to persist as samples. */
export function outcomesOf(tasks: readonly PlanTask[], samples: readonly DurationSample[], failedIds: ReadonlySet<string> = new Set()): TaskOutcome[] {
  const estimates = estimatesFor(tasks, samples);
  return tasks
    .filter((t) => t.status === 'DONE' && t.startedAt && t.finishedAt)
    .map((t) => {
      const actual = (Date.parse(t.finishedAt!) - Date.parse(t.startedAt!)) / 60_000;
      const est = estimates.get(t.kind)!.plannedMin;
      return { id: t.id, kind: t.kind, estimateMin: est, actualMin: round1(actual), ratio: est > 0 ? round1((actual / est) * 100) / 100 : 0, failed: failedIds.has(t.id) };
    });
}

/** The same outcomes as samples the next estimate reads. */
export function samplesFromOutcomes(outcomes: readonly TaskOutcome[], source: string): DurationSample[] {
  return outcomes.map((o) => ({ kind: o.kind, minutes: o.actualMin, failed: o.failed, source }));
}
