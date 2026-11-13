/**
 * The hourly operations report, read from rows Brain already keeps (owner, 2026-11-13).
 *
 * Nothing here schedules, tracks or stores anything new. It reads the operator's runs, its
 * decision and engineering events, Factory's units, campaigns and workers, the work queue and
 * bins, the plan readings, opportunities, research, scenario runs, model and cheap-lane calls,
 * money entries, spend and incidents — for the hour just ended, the hour before, and the last
 * day — and hands them to the pure renderer (`domain/operationsReport.ts`). The finished report
 * is an owner notice (`ownerNotices.ts`, kind REPORT, once per hour), which the scheduled task
 * bound to the owner's Claude Code conversation announces. Its bottlenecks are also the first
 * thing in the operator's next brief (`latestReportBrief`), so Hermes acts on them.
 */
import { getDb } from '../../db/database.ts';
import {
  renderReport,
  type OpsWindow,
  type PlanReadingFacts,
  type QueueReading,
} from '../../domain/operationsReport.ts';

/** The goal the owner's report is about: the $10K / 30-day cash goal. */
export const REPORT_GOAL_ID = 'wst_7b4fcbb5f2384f31b6c3';

const minutesSince = (iso: string, nowMs: number): number => Math.max(0, (nowMs - Date.parse(iso)) / 60_000);

async function safe<T>(fallback: T, read: () => Promise<T>, missing: string[], what: string): Promise<T> {
  try {
    return await read();
  } catch {
    missing.push(`${what} (could not be read)`);
    return fallback;
  }
}

function classifyFailure(error: string | null, toolsOk: number): string {
  const e = (error ?? '').toLowerCase();
  if (toolsOk > 0 && !e) return 'other';
  if (/rate.?limit|429|quota|overloaded|model|context|token|max_turns|max turns|length/.test(e)) return 'model';
  if (/timed out|timeout|brain|mcp|503|502|econn|socket|database/.test(e)) return 'brain';
  if (/restart|did not report back/.test(e)) return 'restart';
  return e ? 'other' : 'no reason recorded';
}

async function queueFromWorkItems(start: string, end: string, nowMs: number, where: string): Promise<QueueReading> {
  const db = getDb();
  const waiting = await db.all<{ created_at: string; state: string }>(
    `SELECT created_at, state FROM work_items WHERE state IN ('QUEUED','LEASED') AND ${where} LIMIT 5000`,
    [],
  );
  const queued = waiting.filter((w) => w.state === 'QUEUED');
  const ages = queued.map((w) => minutesSince(w.created_at, nowMs));
  const done = await db.get<{ ok: number; failed: number }>(
    `SELECT SUM(CASE WHEN state = 'SUCCEEDED' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed
       FROM work_items WHERE completed_at >= ? AND completed_at < ? AND ${where}`,
    [start, end],
  );
  return {
    queued: queued.length,
    running: waiting.length - queued.length,
    blocked: 0,
    completed: Number(done?.ok ?? 0),
    failed: Number(done?.failed ?? 0),
    oldestWaitMin: ages.length ? Math.max(...ages) : null,
    avgWaitMin: ages.length ? ages.reduce((s, x) => s + x, 0) / ages.length : null,
  };
}

async function queueFromBins(start: string, end: string, nowMs: number, coding: boolean): Promise<QueueReading> {
  const db = getDb();
  const filter = coding ? 'factory_campaign_id IS NOT NULL' : 'factory_campaign_id IS NULL';
  const open = await db.all<{ state: string; ready_at: string | null; created_at: string }>(
    `SELECT state, ready_at, created_at FROM bins WHERE state IN ('READY','LEASED','NEEDS_HUMAN','DRAFT') AND ${filter} LIMIT 5000`,
    [],
  );
  const ready = open.filter((b) => b.state === 'READY');
  const ages = ready.map((b) => minutesSince(b.ready_at ?? b.created_at, nowMs));
  const done = await db.get<{ ok: number; failed: number }>(
    `SELECT SUM(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed
       FROM bins WHERE completed_at >= ? AND completed_at < ? AND ${filter}`,
    [start, end],
  );
  return {
    queued: ready.length,
    running: open.filter((b) => b.state === 'LEASED').length,
    blocked: open.filter((b) => b.state === 'NEEDS_HUMAN').length,
    completed: Number(done?.ok ?? 0),
    failed: Number(done?.failed ?? 0),
    oldestWaitMin: ages.length ? Math.max(...ages) : null,
    avgWaitMin: ages.length ? ages.reduce((s, x) => s + x, 0) / ages.length : null,
  };
}

function mergeQueues(a: QueueReading, b: QueueReading): QueueReading {
  const oldest = [a.oldestWaitMin, b.oldestWaitMin].filter((x): x is number => x !== null);
  const avg = [a, b].filter((q) => q.avgWaitMin !== null && q.queued > 0);
  return {
    queued: a.queued + b.queued,
    running: a.running + b.running,
    blocked: a.blocked + b.blocked,
    completed: a.completed + b.completed,
    failed: a.failed + b.failed,
    oldestWaitMin: oldest.length ? Math.max(...oldest) : null,
    avgWaitMin: avg.length ? avg.reduce((s, q) => s + q.avgWaitMin! * q.queued, 0) / avg.reduce((s, q) => s + q.queued, 0) : null,
  };
}

/** One window's readings. Snapshot fields (queued, running, oldest wait) are as of `nowMs`. */
export async function readWindow(start: string, end: string, nowMs: number, missing: string[]): Promise<OpsWindow> {
  const db = getDb();
  // Hermes ------------------------------------------------------------------
  const runs = await safe([], () => db.all<{ id: string; state: string; model: string; started_at: string; finished_at: string | null; tool_calls: string; error: string | null }>(
    'SELECT id, state, model, started_at, finished_at, tool_calls, error FROM operator_runs WHERE started_at >= ? AND started_at < ?',
    [start, end],
  ), missing, 'operator runs');
  const toolsByName: Record<string, { ok: number; failed: number }> = {};
  const failureReasons: Record<string, number> = {};
  let toolCalls = 0;
  let toolCallsFailed = 0;
  let runMinutes = 0;
  let lostMinutes = 0;
  const models = new Set<string>();
  for (const run of runs) {
    for (const m of run.model.split('→').map((s) => s.trim()).filter(Boolean)) models.add(m);
    let calls: { tool: string; ok: boolean }[] = [];
    try {
      calls = JSON.parse(run.tool_calls) as { tool: string; ok: boolean }[];
    } catch {
      calls = [];
    }
    const ok = calls.filter((c) => c.ok).length;
    toolCalls += calls.length;
    toolCallsFailed += calls.length - ok;
    for (const c of calls) {
      const name = c.tool.replace(/^.*?(brain_[a-z_]+)$/, '$1');
      const slot = (toolsByName[name] ??= { ok: 0, failed: 0 });
      if (c.ok) slot.ok += 1;
      else slot.failed += 1;
    }
    const minutes = run.finished_at ? (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 60_000 : 0;
    runMinutes += minutes;
    if (run.state === 'FAILED') {
      const reason = classifyFailure(run.error, ok);
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      if (ok === 0) lostMinutes += minutes;
    }
  }
  const okCount = (names: string[]): number => names.reduce((s, n) => s + (toolsByName[n]?.ok ?? 0), 0);
  const events = await safe([], () => db.all<{ event_type: string; payload: string }>(
    `SELECT event_type, payload FROM project_events WHERE created_at >= ? AND created_at < ? AND event_type IN ('OPERATOR_DECISION','OPERATOR_ENGINEERING_COMMISSIONED','OPERATOR_ENGINEERING_OUTCOME','OPERATOR_ENGINEERING_PRIORITIZED','OPERATOR_DECISION_VERIFIED')`,
    [start, end],
  ), missing, 'operator events');
  const decisionsByKind: Record<string, number> = {};
  let decisions = 0;
  let challenged = 0;
  let commissioned = 0;
  let reprioritized = 0;
  let outcomesResolved = 0;
  let outcomesNotResolved = 0;
  let verifications = 0;
  for (const e of events) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      /* unreadable */
    }
    if (e.event_type === 'OPERATOR_DECISION') {
      decisions += 1;
      const kind = String((p['input'] as { kind?: string } | undefined)?.kind ?? 'OTHER');
      decisionsByKind[kind] = (decisionsByKind[kind] ?? 0) + 1;
      if (typeof p['challenge'] === 'object' && p['challenge'] !== null) challenged += 1;
    } else if (e.event_type === 'OPERATOR_ENGINEERING_COMMISSIONED') commissioned += 1;
    else if (e.event_type === 'OPERATOR_ENGINEERING_PRIORITIZED') reprioritized += 1;
    else if (e.event_type === 'OPERATOR_DECISION_VERIFIED') verifications += 1;
    else if (e.event_type === 'OPERATOR_ENGINEERING_OUTCOME') {
      if (p['status'] === 'RESOLVED') outcomesResolved += 1;
      if (p['status'] === 'NOT_RESOLVED') outcomesNotResolved += 1;
    }
  }
  const lessons = Number((await safe({ n: 0 }, async () => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operator_learnings WHERE recorded_at >= ? AND recorded_at < ?', [start, end])) ?? { n: 0 }, missing, 'operator lessons')).n ?? 0);
  const actingTools = ['brain_operator_withdraw_moot_request', 'brain_operator_continue_idle', 'brain_operator_submit_fix', 'brain_operator_commission', 'brain_operator_set_goal_focus', 'brain_operator_prioritize_engineering'];
  // Pipeline ----------------------------------------------------------------
  const count = async (sql: string, what: string, params: unknown[] = [start, end]): Promise<number> =>
    Number((await safe({ n: 0 }, async () => (await db.get<{ n: number }>(sql, params as never[])) ?? { n: 0 }, missing, what)).n ?? 0);
  const opportunitiesDiscovered = await count('SELECT COUNT(*) AS n FROM cash_opportunities WHERE created_at >= ? AND created_at < ?', 'opportunities');
  const opportunitiesQualified = await count(`SELECT COUNT(*) AS n FROM cash_opportunities WHERE updated_at >= ? AND updated_at < ? AND state IN ('READY','EXECUTING','DELIVERING','COLLECTED')`, 'qualified opportunities');
  const researchCompleted = await count(`SELECT COUNT(*) AS n FROM research_fragments WHERE completed_at >= ? AND completed_at < ? AND status = 'ACCEPTED'`, 'research fragments');
  const researchFailed = await count(`SELECT COUNT(*) AS n FROM research_fragments WHERE updated_at >= ? AND updated_at < ? AND status IN ('REJECTED','BLOCKED')`, 'failed research');
  const evidenceValidated = await count('SELECT COUNT(*) AS n FROM research_fragments WHERE accepted_at >= ? AND accepted_at < ?', 'validated evidence');
  const evaluationsCompleted = await count(`SELECT COUNT(*) AS n FROM scenario_runs WHERE finished_at >= ? AND finished_at < ? AND state = 'SUCCEEDED'`, 'scenario runs');
  const evaluationsFailed = await count(`SELECT COUNT(*) AS n FROM scenario_runs WHERE finished_at >= ? AND finished_at < ? AND state = 'FAILED'`, 'failed scenario runs');
  const strategiesConstructed = await count(`SELECT COUNT(*) AS n FROM project_events WHERE created_at >= ? AND created_at < ? AND event_type LIKE '%CONSTRUCT%'`, 'constructions');
  const readings = await safe([], () => db.all<{ forecast: string | null }>('SELECT forecast FROM goal_plan_readings WHERE created_at >= ? AND created_at < ?', [start, end]), missing, 'plan readings');
  const plansAccepted = readings.filter((r) => (r.forecast ?? '').includes('"status":"ACCEPTED"')).length;
  // Queues ------------------------------------------------------------------
  const research = mergeQueues(
    await safe(emptyQueue(), () => queueFromWorkItems(start, end, nowMs, "work_type LIKE '%RESEARCH%'"), missing, 'research work items'),
    await safe(emptyQueue(), () => queueFromBins(start, end, nowMs, false), missing, 'research bins'),
  );
  const coding = await safe(emptyQueue(), () => queueFromBins(start, end, nowMs, true), missing, 'coding bins');
  const otherWork = await safe(emptyQueue(), () => queueFromWorkItems(start, end, nowMs, "work_type NOT LIKE '%RESEARCH%'"), missing, 'other work items');
  const units = await safe([], () => db.all<{ state: string; model_class: string | null; updated_at: string; created_at: string }>(
    `SELECT state, model_class, updated_at, created_at FROM factory_work_units WHERE state IN ('READY','LEASED','BLOCKED') OR (updated_at >= ? AND updated_at < ?) LIMIT 5000`,
    [start, end],
  ), missing, 'factory units');
  const readyUnits = units.filter((u) => u.state === 'READY');
  const unitAges = readyUnits.map((u) => minutesSince(u.updated_at ?? u.created_at, nowMs));
  const waitingByClass: Record<string, number> = {};
  for (const u of readyUnits) waitingByClass[u.model_class ?? 'ANY'] = (waitingByClass[u.model_class ?? 'ANY'] ?? 0) + 1;
  const factoryUnits: QueueReading = {
    queued: readyUnits.length,
    running: units.filter((u) => u.state === 'LEASED').length,
    blocked: units.filter((u) => u.state === 'BLOCKED').length,
    completed: units.filter((u) => ['IMPLEMENTED', 'INTEGRATED'].includes(u.state) && u.updated_at >= start && u.updated_at < end).length,
    failed: units.filter((u) => u.state === 'FAILED' && u.updated_at >= start && u.updated_at < end).length,
    oldestWaitMin: unitAges.length ? Math.max(...unitAges) : null,
    avgWaitMin: unitAges.length ? unitAges.reduce((s, x) => s + x, 0) / unitAges.length : null,
  };
  const campaigns = await safe([], () => db.all<{ state: string; finished_at: string | null }>(`SELECT state, finished_at FROM factory_campaigns WHERE state NOT IN ('COMPLETE','CANCELLED') OR (finished_at >= ? AND finished_at < ?)`, [start, end]), missing, 'factory campaigns');
  const workersRows = await safe([], () => db.all<{ id: string; name: string; model_class: string | null; availability: string; max_concurrency: number; rate_limited_until: string | null }>(
    'SELECT id, name, model_class, availability, max_concurrency, rate_limited_until FROM factory_workers',
    [],
  ), missing, 'factory workers');
  const leasedByWorker = await safe([], () => db.all<{ lease_worker_id: string; n: number }>(`SELECT lease_worker_id, COUNT(*) AS n FROM factory_work_units WHERE state = 'LEASED' GROUP BY lease_worker_id`, []), missing, 'worker leases');
  const leasedMap = new Map(leasedByWorker.map((r) => [r.lease_worker_id, Number(r.n)]));
  // Models ------------------------------------------------------------------
  const jobs = await safe([], () => db.all<{ model: string | null; provider: string; status: string; duration_ms: number | null }>(
    'SELECT model, provider, status, duration_ms FROM research_jobs WHERE completed_at >= ? AND completed_at < ?',
    [start, end],
  ), missing, 'research jobs');
  const researchJobsByModel: OpsWindow['models']['researchJobsByModel'] = {};
  for (const j of jobs) {
    const key = j.model ?? j.provider;
    const slot = (researchJobsByModel[key] ??= { done: 0, failed: 0, avgSeconds: null });
    if (/FAIL|ERROR/i.test(j.status)) slot.failed += 1;
    else slot.done += 1;
    if (j.duration_ms !== null) slot.avgSeconds = ((slot.avgSeconds ?? 0) * (slot.done + slot.failed - 1) + j.duration_ms / 1000) / (slot.done + slot.failed);
  }
  const cheap = await safe([], () => db.all<{ model: string; ok: number; n: number }>(
    'SELECT model, ok, COUNT(*) AS n FROM cheap_results WHERE created_at >= ? AND created_at < ? GROUP BY model, ok',
    [start, end],
  ), missing, 'cheap-lane calls');
  const cheapCallsByModel: OpsWindow['models']['cheapCallsByModel'] = {};
  for (const c of cheap) {
    const slot = (cheapCallsByModel[c.model] ??= { ok: 0, failed: 0 });
    if (Number(c.ok)) slot.ok += Number(c.n);
    else slot.failed += Number(c.n);
  }
  // Money, spend, incidents -------------------------------------------------
  const collectedCents = await count(`SELECT COALESCE(SUM(amount_cents),0) AS n FROM cash_money_entries WHERE created_at >= ? AND created_at < ? AND kind IN ('CUSTOMER_PAYMENT','SETTLEMENT')`, 'collected money');
  const spentCents = await count(`SELECT COALESCE(SUM(amount_cents),0) AS n FROM cash_money_entries WHERE created_at >= ? AND created_at < ? AND kind IN ('COST','CAPITAL_OUT','COMMITMENT_PAID')`, 'spent money');
  const spend = await safe(null, () => db.get<{ held: number; ceiling: number }>('SELECT SUM(held_micros + settled_micros) AS held, SUM(ceiling_micros) AS ceiling FROM spend_ledger WHERE updated_at >= ?', [new Date(nowMs - 31 * 86_400_000).toISOString()]), missing, 'spend ledger');
  const incidents = await safe([], () => db.all<{ kind: string; n: number }>('SELECT kind, SUM(occurrences) AS n FROM infra_incidents WHERE started_at >= ? AND started_at < ? GROUP BY kind', [start, end]), missing, 'infrastructure incidents');
  const integrationFailures = await safe([], () => db.all<{ integration_id: string; n: number }>(
    `SELECT integration_id, COUNT(*) AS n FROM integration_events WHERE recorded_at >= ? AND recorded_at < ? AND state IN ('FAILED','ERROR','DOWN','UNREACHABLE') GROUP BY integration_id`,
    [start, end],
  ), missing, 'integration events');
  return {
    start,
    end,
    hermes: {
      runsStarted: runs.length,
      runsDone: runs.filter((r) => r.state === 'DONE').length,
      runsFailed: runs.filter((r) => r.state === 'FAILED').length,
      models: [...models],
      toolCalls,
      toolCallsFailed,
      toolsByName,
      runMinutes,
      lostMinutes,
      failureReasons,
      decisions,
      decisionsByKind,
      challenged,
      actionsExecuted: okCount(actingTools),
      commissioned,
      reprioritized,
      strategyChanges: okCount(['brain_operator_set_goal_focus']) + (decisionsByKind['CHANGE_STRATEGY'] ?? 0),
      outcomesResolved,
      outcomesNotResolved,
      verifications: verifications + okCount(['brain_operator_verify']),
      lessons,
    },
    pipeline: { opportunitiesDiscovered, opportunitiesQualified, researchCompleted, researchFailed, strategiesConstructed, evaluationsCompleted, evaluationsFailed, evidenceValidated, planReadings: readings.length, plansAccepted },
    queues: { research, coding, factoryUnits, otherWork },
    factory: {
      campaignsActive: campaigns.filter((c) => !['COMPLETE', 'CANCELLED', 'BLOCKED'].includes(c.state)).length,
      campaignsBlocked: campaigns.filter((c) => c.state === 'BLOCKED').length,
      campaignsCompleted: campaigns.filter((c) => c.state === 'COMPLETE').length,
      workers: workersRows.map((w) => ({
        name: w.name,
        modelClass: w.model_class ?? 'ANY',
        availability: w.availability,
        maxConcurrency: Number(w.max_concurrency),
        leased: leasedMap.get(w.id) ?? 0,
        rateLimited: !!w.rate_limited_until && Date.parse(w.rate_limited_until) > nowMs,
      })),
      waitingByClass,
    },
    models: { researchJobsByModel, cheapCallsByModel },
    money: { collectedCents, spentCents, spendHeldMicros: spend?.held ?? null, spendCeilingMicros: spend?.ceiling ?? null },
    incidents: incidents.map((i) => ({ kind: i.kind, count: Number(i.n) })),
    integrationFailures: integrationFailures.map((i) => ({ integration: i.integration_id, count: Number(i.n) })),
  };
}

function emptyQueue(): QueueReading {
  return { queued: 0, running: 0, blocked: 0, completed: 0, failed: 0, oldestWaitMin: null, avgWaitMin: null };
}

/** The goal's plan as of a moment: the last stored reading at or before it. */
export async function readPlan(goalId: string, at: string): Promise<{ facts: PlanReadingFacts; reach: number | null; basis: string | null; lowerBound: number | null } | null> {
  const db = getDb();
  const row = await db.get<{ verdict: string; forecast: string | null; next_test: string | null; created_at: string }>(
    'SELECT verdict, forecast, next_test, created_at FROM goal_plan_readings WHERE workstream_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [goalId, at],
  );
  const goal = await db.get<{ title: string; target_amount_cents: number | null; capital_ceiling_cents: number | null; due_at: string | null }>(
    'SELECT title, target_amount_cents, capital_ceiling_cents, due_at FROM workstreams WHERE id = ?',
    [goalId],
  );
  if (!goal) return null;
  let f: Record<string, unknown> = {};
  try {
    f = JSON.parse(row?.forecast ?? '{}') as Record<string, unknown>;
  } catch {
    f = {};
  }
  const a = (f['acceptance'] ?? {}) as {
    status?: string;
    required?: number;
    probability?: { value?: number; lowerBound?: number } | null;
    candidate?: { label?: string; reach?: number | null; reachBasis?: string | null; settledP50?: number | null } | null;
    accepted?: { label?: string } | null;
    shortfalls?: string[];
  };
  const recon = (f['reconstruction'] ?? {}) as { binding?: string | null };
  type NextTest = { test?: string; by?: string; blocker?: string | null };
  let next: NextTest | null = null;
  try {
    next = row?.next_test ? (JSON.parse(row.next_test) as NextTest) : null;
  } catch {
    next = null;
  }
  const remainingCents = typeof f['remainingCents'] === 'number' ? (f['remainingCents'] as number) : null;
  const target = goal.target_amount_cents !== null ? Number(goal.target_amount_cents) : null;
  const reach = a.probability?.value ?? a.candidate?.reach ?? null;
  const basis = a.probability ? 'PROBABILITY' : (a.candidate?.reachBasis ?? null);
  const lowerBound = a.probability?.lowerBound ?? null;
  return {
    reach,
    basis,
    lowerBound,
    facts: {
      goalId,
      goalTitle: goal.title,
      readAt: row?.created_at ?? null,
      verdict: row?.verdict ?? null,
      acceptance: a.status ?? null,
      candidate: a.accepted?.label ?? a.candidate?.label ?? null,
      reach,
      reachBasis: basis,
      lowerBound,
      required: a.required ?? null,
      settledP50: a.candidate?.settledP50 ?? null,
      shortfalls: a.shortfalls ?? [],
      binding: recon.binding ?? null,
      targetCents: target,
      remainingCents,
      collectedCents: target !== null && remainingCents !== null ? target - remainingCents : null,
      daysLeft: typeof f['daysLeft'] === 'number' ? (f['daysLeft'] as number) : null,
      capitalCeilingCents: goal.capital_ceiling_cents !== null ? Number(goal.capital_ceiling_cents) : null,
      nextTest: next?.test ? { test: next.test, by: next.by ?? 'BRAIN', blocker: next.blocker ?? null } : null,
      personBlockers: next?.by === 'PERSON' && next.blocker ? [next.blocker] : [],
    },
  };
}

/** The hour a report covers: the last full hour before `nowMs`. */
export function reportHour(nowMs: number): { start: string; end: string } {
  const end = new Date(Math.floor(nowMs / 3_600_000) * 3_600_000);
  return { start: new Date(end.getTime() - 3_600_000).toISOString(), end: end.toISOString() };
}

export function reportNoticeId(hourEnding: string): string {
  return `ops-report.${hourEnding.slice(0, 13).replace(/[^0-9T]/g, '')}`;
}

/** Build the report for the hour that just ended. */
export async function buildOperationsReport(nowMs = Date.now(), goalId = REPORT_GOAL_ID): Promise<{ hourEnding: string; subject: string; text: string; bottleneckKeys: string[] }> {
  const missing: string[] = [];
  const { start, end } = reportHour(nowMs);
  const prevStart = new Date(Date.parse(start) - 3_600_000).toISOString();
  const dayStart = new Date(Date.parse(end) - 86_400_000).toISOString();
  const now = await readWindow(start, end, nowMs, missing);
  const prev = await readWindow(prevStart, start, nowMs, missing);
  const day = await readWindow(dayStart, end, nowMs, missing);
  const plan = await safe(null, () => readPlan(goalId, end), missing, 'plan reading');
  const planPrev = await safe(null, () => readPlan(goalId, start), missing, 'previous plan reading');
  const history = await safe([], async () => {
    const rows = await getDb().all<{ created_at: string }>('SELECT created_at FROM goal_plan_readings WHERE workstream_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 48', [goalId, dayStart, end]);
    const out: { at: string; reach: number | null; basis: string | null; lowerBound: number | null }[] = [];
    for (const r of rows) {
      const p = await readPlan(goalId, r.created_at);
      if (p) out.push({ at: r.created_at, reach: p.reach, basis: p.basis, lowerBound: p.lowerBound });
    }
    return out;
  }, missing, 'plan history');
  const lastRun = await safe(null, () => getDb().get<{ summary: string | null }>('SELECT summary FROM operator_runs WHERE summary IS NOT NULL ORDER BY started_at DESC LIMIT 1', []), missing, 'last operator run');
  const openEngineering = await safe([], async () => {
    const { engineeringOutcomes } = await import('./director.ts');
    return (await engineeringOutcomes({ limit: 5, includeClosed: false })).map((o) => ({ title: o.title.slice(0, 80), status: o.status }));
  }, missing, 'open engineering');
  // How many earlier reports each bottleneck appeared in, consecutively: the survival count.
  const persistence = await safe({} as Record<string, number>, async () => {
    const rows = await getDb().all<{ payload: string }>(
      `SELECT payload FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND payload LIKE '%"status":"READY"%' ORDER BY created_at DESC LIMIT 12`,
      [],
    );
    const counts: Record<string, number> = {};
    const alive = new Set<string>();
    rows.forEach((row, i) => {
      const keys = ((JSON.parse(row.payload) as { bottleneckKeys?: string[] }).bottleneckKeys ?? []);
      for (const k of keys) if (i === 0 || alive.has(k)) counts[k] = (counts[k] ?? 0) + 1;
      alive.clear();
      for (const k of keys) alive.add(k);
    });
    return counts;
  }, missing, 'earlier reports');
  const ownerOpportunities = (plan?.facts.personBlockers ?? []).map((b) => `${b} — the plan's next test waits on you; cost: your time only.`);
  const unmeasured = [
    ...new Set(missing),
    'per-call token counts and inference cost (research jobs record bytes and duration only)',
    "Hermes' reasoning versus executing time within a run (only whole-run duration is recorded)",
  ];
  const r = renderReport({
    hourEnding: end,
    now,
    prev,
    day,
    plan: plan?.facts ?? null,
    planPrev: planPrev?.facts ?? null,
    planHistory: history,
    hermesSummary: lastRun?.summary ?? null,
    openEngineering,
    persistence,
    ownerOpportunities,
    unmeasured,
  });
  return { hourEnding: end, ...r };
}

/**
 * Record the report for the hour that just ended, once: an owner notice the conversation's
 * hourly task announces. Returns null when this hour's report already exists.
 */
export async function recordHourlyReport(nowMs = Date.now()): Promise<{ noticeId: string; created: boolean } | null> {
  const { end } = reportHour(nowMs);
  const noticeId = reportNoticeId(end);
  const { readOwnerNotice, recordOwnerNotice } = await import('../ownerNotices.ts');
  if (await readOwnerNotice(noticeId)) return { noticeId, created: false };
  const report = await buildOperationsReport(nowMs);
  const projectId = (await getDb().get<{ project_id: string | null; target_project_id: string | null }>('SELECT project_id, target_project_id FROM workstreams WHERE id = ?', [REPORT_GOAL_ID]));
  const anchor = projectId?.target_project_id ?? projectId?.project_id ?? (await getDb().get<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1', []))?.id;
  if (!anchor) return null;
  const recorded = await recordOwnerNotice({
    kind: 'REPORT',
    projectId: anchor,
    noticeId,
    subject: report.subject,
    text: report.text,
    detail: { hourEnding: report.hourEnding, bottleneckKeys: report.bottleneckKeys },
  });
  return { noticeId, created: recorded.created };
}

/** The latest report's bottlenecks, for the operator's brief: what to act on first. */
export async function latestReportBrief(): Promise<string> {
  const row = await getDb().get<{ payload: string }>(
    `SELECT payload FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND payload LIKE '%"status":"READY"%' ORDER BY created_at DESC LIMIT 1`,
    [],
  );
  if (!row) return '';
  const text = String((JSON.parse(row.payload) as { text?: string }).text ?? '');
  const section = text.split('TOP 3 BOTTLENECKS')[1]?.split('SCALING DECISIONS')[0]?.trim() ?? '';
  if (!section) return '';
  return `OPERATIONS REPORT — act first on what Brain may resolve itself (redirect work, reprioritize Factory, commission a fix, continue idle capacity, change strategy); a bottleneck that survived several reports needs a different diagnosis, not the same fix:\n${section.slice(0, 1500)}`;
}
