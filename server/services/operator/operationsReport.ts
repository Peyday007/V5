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

/**
 * The report's read budget (owner, 2026-11-13: "enforce a report execution budget"). Every read
 * goes through `safe`, which refuses to start one after the deadline: the report is then
 * published PARTIAL, naming what it did not read, rather than holding a database connection
 * Brain's productive work needs. One generation runs at a time, so one deadline is enough.
 */
export const REPORT_READ_BUDGET_MS = 60_000;
let readDeadline = Number.POSITIVE_INFINITY;

async function safe<T>(fallback: T, read: () => Promise<T>, missing: string[], what: string): Promise<T> {
  if (Date.now() > readDeadline) {
    missing.push(`${what} (skipped: the report's read budget ran out)`);
    return fallback;
  }
  try {
    return await read();
  } catch {
    missing.push(`${what} (could not be read)`);
    return fallback;
  }
}

/** Whether a named read failed or was skipped, so its figures are reported as n/a, not zero. */
const unread = (missing: string[], what: string): boolean => missing.some((m) => m.startsWith(`${what} (`));

function classifyFailure(error: string | null, toolsOk: number): string {
  const e = (error ?? '').toLowerCase();
  if (toolsOk > 0 && !e) return 'other';
  if (/rate.?limit|429|quota|overloaded/.test(e)) return 'rate_limit';
  if (/context|token|max_turns|max turns|length/.test(e)) return 'context';
  if (/model|tool call|malformed|parse/.test(e)) return 'model';
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
export async function readWindow(start: string, end: string, nowMs: number, outerMissing: string[]): Promise<OpsWindow> {
  const db = getDb();
  const missing: string[] = [];
  const window = await readWindowInto(db, start, end, nowMs, missing);
  outerMissing.push(...missing);
  // A read that failed contributes n/a (NaN), never a zero that looks measured.
  const h = window.hermes;
  if (unread(missing, 'operator runs')) {
    for (const k of ['runsStarted', 'runsDone', 'runsFailed', 'toolCalls', 'toolCallsFailed', 'runMinutes', 'lostMinutes', 'actionsExecuted', 'goalsInspected', 'strategyChanges'] as const) h[k] = Number.NaN;
  }
  if (unread(missing, 'operator events')) {
    for (const k of ['decisions', 'challenged', 'commissioned', 'reprioritized', 'outcomesResolved', 'outcomesNotResolved', 'outcomesReceived', 'problemsIdentified'] as const) h[k] = Number.NaN;
  }
  if (unread(missing, 'plan readings')) {
    window.pipeline.planReadings = Number.NaN;
    window.pipeline.plansAccepted = Number.NaN;
  }
  if (unread(missing, 'research work items') || unread(missing, 'research bins')) window.queues.research = nanQueue();
  if (unread(missing, 'coding bins')) window.queues.coding = nanQueue();
  if (unread(missing, 'other work items')) window.queues.otherWork = nanQueue();
  if (unread(missing, 'factory units')) window.queues.factoryUnits = nanQueue();
  return window;
}

function nanQueue(): QueueReading {
  return { queued: Number.NaN, running: Number.NaN, blocked: Number.NaN, completed: Number.NaN, failed: Number.NaN, oldestWaitMin: null, avgWaitMin: null };
}

async function readWindowInto(db: ReturnType<typeof getDb>, start: string, end: string, nowMs: number, missing: string[]): Promise<OpsWindow> {
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
    `SELECT event_type, payload FROM project_events WHERE created_at >= ? AND created_at < ? AND event_type IN ('OPERATOR_DECISION','OPERATOR_ENGINEERING_COMMISSIONED','OPERATOR_ENGINEERING_OUTCOME','OPERATOR_ENGINEERING_PRIORITIZED','OPERATOR_DECISION_VERIFIED','OPERATOR_INTERVENTION_DECIDED')`,
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
  let interventionsDecided = 0;
  let outcomesReceived = 0;
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
    else if (e.event_type === 'OPERATOR_INTERVENTION_DECIDED') interventionsDecided += 1;
    else if (e.event_type === 'OPERATOR_ENGINEERING_OUTCOME') {
      if (p['status'] !== 'BUILDING') outcomesReceived += 1;
      if (p['status'] === 'RESOLVED') outcomesResolved += 1;
      if (p['status'] === 'NOT_RESOLVED') outcomesNotResolved += 1;
    }
  }
  const lessons = Number((await safe({ n: Number.NaN }, async () => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operator_learnings WHERE recorded_at >= ? AND recorded_at < ?', [start, end])) ?? { n: 0 }, missing, 'operator lessons')).n ?? 0);
  const actingTools = ['brain_operator_withdraw_moot_request', 'brain_operator_continue_idle', 'brain_operator_submit_fix', 'brain_operator_commission', 'brain_operator_set_goal_focus', 'brain_operator_prioritize_engineering'];
  // Pipeline ----------------------------------------------------------------
  const count = async (sql: string, what: string, params: unknown[] = [start, end]): Promise<number> =>
    Number((await safe({ n: Number.NaN }, async () => (await db.get<{ n: number }>(sql, params as never[])) ?? { n: 0 }, missing, what)).n ?? 0);
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
  const executionStarted = await count(`SELECT COUNT(*) AS n FROM cash_opportunities WHERE updated_at >= ? AND updated_at < ? AND state IN ('EXECUTING','DELIVERING')`, 'opportunities in execution');
  const leadsPrepared = await count('SELECT COUNT(*) AS n FROM sales_leads WHERE created_at >= ? AND created_at < ?', 'sales leads');
  const repliesReceived = await count('SELECT COUNT(*) AS n FROM sales_replies WHERE received_at >= ? AND received_at < ?', 'sales replies');
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
      goalsInspected: okCount(['brain_operator_goal', 'brain_operator_goal_plan']),
      problemsIdentified: okCount(['brain_operator_deficiencies']) + interventionsDecided,
      outcomesReceived,
      repeatedToolFailures: Object.fromEntries(Object.entries(toolsByName).filter(([, v]) => v.failed >= 2).map(([k, v]) => [k, v.failed])),
    },
    pipeline: { opportunitiesDiscovered, opportunitiesQualified, researchCompleted, researchFailed, strategiesConstructed, evaluationsCompleted, evaluationsFailed, evidenceValidated, planReadings: readings.length, plansAccepted, executionStarted, leadsPrepared, repliesReceived },
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

/** A report recorded earlier, as its payload stored it: the readings later reports reuse. */
interface StoredReport {
  hourEnding: string;
  window: OpsWindow | null;
  plan: { at: string | null; reach: number | null; basis: string | null; lowerBound: number | null; facts: PlanReadingFacts } | null;
  bottleneckKeys: string[];
}

/** JSON has no NaN: a figure stored as n/a comes back null, and is n/a again here. */
function revive(window: unknown): OpsWindow | null {
  if (!window || typeof window !== 'object') return null;
  return JSON.parse(JSON.stringify(window), (_k, v) => (v === null ? Number.NaN : v)) as OpsWindow;
}

/**
 * The reports recorded before `hourEnding`, newest hour first — one bounded read that supplies
 * the previous hour, the baseline, the plan history and the bottleneck persistence, instead of
 * re-reading those windows from the operational tables every hour.
 */
async function storedReports(hourEnding: string, missing: string[]): Promise<StoredReport[]> {
  const rows = await safe([], () => getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND entity_id < ? AND payload LIKE '%"status":"READY"%'
      ORDER BY entity_id DESC LIMIT 30`,
    [reportNoticeId(hourEnding)],
  ), missing, 'earlier reports');
  const out: StoredReport[] = [];
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload) as { hourEnding?: string; window?: unknown; plan?: StoredReport['plan']; bottleneckKeys?: string[] };
      if (!p.hourEnding) continue;
      out.push({ hourEnding: p.hourEnding, window: revive(p.window), plan: p.plan ?? null, bottleneckKeys: p.bottleneckKeys ?? [] });
    } catch {
      /* an unreadable payload is skipped, not guessed */
    }
  }
  return out;
}

const PIPELINE_KEYS = [
  'opportunitiesDiscovered', 'opportunitiesQualified', 'researchCompleted', 'researchFailed', 'strategiesConstructed', 'evaluationsCompleted',
  'evaluationsFailed', 'evidenceValidated', 'planReadings', 'plansAccepted', 'executionStarted', 'leadsPrepared', 'repliesReceived',
] as const;

/** Per-hour averages over the earlier reports in the last day; a figure no report measured stays n/a. */
function baselineFrom(stored: StoredReport[], end: string): { hours: number; pipeline: OpsWindow['pipeline'] } | null {
  const since = Date.parse(end) - 86_400_000;
  const windows = stored.filter((x) => x.window && Date.parse(x.hourEnding) > since).map((x) => x.window!);
  if (windows.length === 0) return null;
  const pipeline = {} as OpsWindow['pipeline'];
  for (const k of PIPELINE_KEYS) {
    const values = windows.map((w) => w.pipeline?.[k]).filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
    pipeline[k] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
  }
  return { hours: windows.length, pipeline };
}

export interface BuiltReport {
  hourEnding: string;
  subject: string;
  text: string;
  bottleneckKeys: string[];
  window: OpsWindow;
  plan: StoredReport['plan'];
  partial: string[];
}

/**
 * Build the report for one hour. The operational tables are read once, for that hour; the hour
 * before, the baseline, the plan history and the persistence of each bottleneck come from the
 * reports already recorded. Every read is bounded by the report's read budget.
 */
export async function buildOperationsReport(
  nowMs = Date.now(),
  goalId = REPORT_GOAL_ID,
  opts: { hourEnding?: string; budgetMs?: number; recovered?: boolean } = {},
): Promise<BuiltReport> {
  const missing: string[] = [];
  readDeadline = Date.now() + (opts.budgetMs ?? REPORT_READ_BUDGET_MS);
  try {
    const end = opts.hourEnding ?? reportHour(nowMs).end;
    const start = new Date(Date.parse(end) - 3_600_000).toISOString();
    const stored = await storedReports(end, missing);
    const now = await readWindow(start, end, nowMs, missing);
    const before = stored.find((x) => x.hourEnding === start) ?? null;
    // The hour before comes from its own report; read only when no report recorded it.
    const prev = before?.window ?? (Date.now() < readDeadline ? await readWindow(new Date(Date.parse(start) - 3_600_000).toISOString(), start, nowMs, []) : null);
    const planNow = await safe(null, () => readPlan(goalId, end), missing, 'plan reading');
    const planPrev = before?.plan?.facts ?? (await safe(null, () => readPlan(goalId, start), [], 'previous plan reading'))?.facts ?? null;
    const since = Date.parse(end) - 86_400_000;
    const history = stored
      .filter((x) => x.plan && Date.parse(x.hourEnding) > since)
      .map((x) => ({ at: x.plan!.at ?? x.hourEnding, reach: x.plan!.reach, basis: x.plan!.basis, lowerBound: x.plan!.lowerBound }))
      .reverse();
    if (planNow) history.push({ at: planNow.facts.readAt ?? end, reach: planNow.reach, basis: planNow.basis, lowerBound: planNow.lowerBound });
    const lastRun = await safe(null, () => getDb().get<{ summary: string | null }>('SELECT summary FROM operator_runs WHERE summary IS NOT NULL ORDER BY started_at DESC LIMIT 1', []), missing, 'last operator run');
    const openEngineering = await safe([], async () => {
      const { engineeringOutcomes } = await import('./director.ts');
      return (await engineeringOutcomes({ limit: 5, includeClosed: false })).map((o) => ({ title: o.title.slice(0, 80), status: o.status }));
    }, missing, 'open engineering');
    // How many consecutive earlier reports each bottleneck appeared in: the survival count.
    const persistence: Record<string, number> = {};
    const alive = new Set<string>();
    stored.slice(0, 12).forEach((x, i) => {
      for (const k of x.bottleneckKeys) if (i === 0 || alive.has(k)) persistence[k] = (persistence[k] ?? 0) + 1;
      alive.clear();
      for (const k of x.bottleneckKeys) alive.add(k);
    });
    const ownerOpportunities = (planNow?.facts.personBlockers ?? []).map((b) => `${b} — the plan's next test waits on you; cost: your time only.`);
    const partial = [...new Set(missing)];
    const r = renderReport({
      hourEnding: end,
      now,
      prev,
      baseline: baselineFrom(stored, end),
      partial,
      recoveredAt: opts.recovered ? new Date(nowMs).toISOString() : null,
      plan: planNow?.facts ?? null,
      planPrev,
      planHistory: history,
      hermesSummary: lastRun?.summary ?? null,
      openEngineering,
      persistence,
      lastKeys: stored[0]?.bottleneckKeys ?? [],
      ownerOpportunities,
      unmeasured: [
        'per-call token counts and inference cost (research jobs record bytes and duration only)',
        "Hermes' reasoning versus executing time within a run (only whole-run duration is recorded)",
      ],
    });
    return {
      hourEnding: end,
      ...r,
      window: now,
      plan: planNow ? { at: planNow.facts.readAt, reach: planNow.reach, basis: planNow.basis, lowerBound: planNow.lowerBound, facts: planNow.facts } : null,
      partial,
    };
  } finally {
    readDeadline = Number.POSITIVE_INFINITY;
  }
}

/**
 * Record the report for one hour, once. Idempotent by the hour's notice id: a report already
 * recorded is returned, never rebuilt or duplicated.
 */
export async function recordHourlyReport(
  nowMs = Date.now(),
  opts: { hourEnding?: string; budgetMs?: number; recovered?: boolean } = {},
): Promise<{ noticeId: string; created: boolean; partial: string[] } | null> {
  const end = opts.hourEnding ?? reportHour(nowMs).end;
  const noticeId = reportNoticeId(end);
  const { readOwnerNotice, recordOwnerNotice } = await import('../ownerNotices.ts');
  if (await readOwnerNotice(noticeId)) return { noticeId, created: false, partial: [] };
  const report = await buildOperationsReport(nowMs, REPORT_GOAL_ID, { ...opts, hourEnding: end });
  const goal = await getDb().get<{ project_id: string | null; target_project_id: string | null }>('SELECT project_id, target_project_id FROM workstreams WHERE id = ?', [REPORT_GOAL_ID]);
  const anchor = goal?.target_project_id ?? goal?.project_id ?? (await getDb().get<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1', []))?.id;
  if (!anchor) return null;
  const recorded = await recordOwnerNotice({
    kind: 'REPORT',
    projectId: anchor,
    noticeId,
    subject: report.subject,
    text: report.text,
    detail: { hourEnding: report.hourEnding, bottleneckKeys: report.bottleneckKeys, window: report.window, plan: report.plan, partial: report.partial, recovered: !!opts.recovered },
  });
  return { noticeId, created: recorded.created, partial: report.partial };
}

/** How far back a missed hour is recovered. Older gaps stay gaps: their snapshots are gone. */
export const REPORT_RECOVERY_HOURS = 6;
/** How long after a failed generation the next attempt may start. */
export const REPORT_RETRY_MS = 5 * 60_000;
/** After this long an unsettled generation is treated as hung, and a new one may start. */
export const REPORT_HUNG_MS = 10 * 60_000;
/** No report in the first minutes after a boot: the boot's own catch-up work comes first. */
export const REPORT_BOOT_GRACE_MS = 3 * 60_000;

const reportState = {
  inFlight: null as Promise<void> | null,
  inFlightSince: 0,
  doneHour: '',
  lastFailureMs: 0,
  bootMs: Date.now(),
};

/** For tests: forget this process's scheduling memory. */
export function resetReportScheduleForTests(bootMs = 0): void {
  reportState.inFlight = null;
  reportState.inFlightSince = 0;
  reportState.doneHour = '';
  reportState.lastFailureMs = 0;
  reportState.bootMs = bootMs;
}

/** The hours in the recovery window with no recorded report, newest first. */
async function missingHours(nowMs: number): Promise<string[]> {
  const ends: string[] = [];
  const latest = Date.parse(reportHour(nowMs).end);
  for (let i = 0; i < REPORT_RECOVERY_HOURS; i += 1) ends.push(new Date(latest - i * 3_600_000).toISOString());
  const ids = ends.map(reportNoticeId);
  const rows = await getDb().all<{ entity_id: string }>(
    `SELECT DISTINCT entity_id FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND entity_id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  const have = new Set(rows.map((x) => x.entity_id));
  return ends.filter((e) => !have.has(reportNoticeId(e)));
}

async function generateDue(nowMs: number, hour: string): Promise<void> {
  const started = Date.now();
  const missing = await missingHours(nowMs);
  // The hour just ended first, then at most one earlier missed hour per pass (newest first), so
  // a long outage is recovered over a few ticks without one tick reading six windows.
  for (const end of missing.slice(0, 2)) {
    const result = await recordHourlyReport(nowMs, { hourEnding: end, recovered: end !== hour });
    console.info(`operations report: ${result?.created ? 'recorded' : 'already present'} ${reportNoticeId(end)} in ${Date.now() - started} ms${result?.partial.length ? `, PARTIAL (${result.partial.length} read(s) unavailable)` : ''}`);
  }
  if (missing.length <= 2) reportState.doneHour = hour;
}

/**
 * The scheduler's hook (the Russell loop's `operations-report` pass): start the hour's report
 * in the background and return at once. It never awaits generation, so neither the tick nor
 * Hermes waits on it. One generation at a time; a failure is retried after REPORT_RETRY_MS; a
 * generation unsettled after REPORT_HUNG_MS no longer blocks the next. Idempotent by the hour's
 * notice id, so a retry or a restart never records an hour twice.
 */
export function operationsReportTick(nowMs = Date.now()): 'STARTED' | 'IN_FLIGHT' | 'NOT_DUE' {
  const hour = reportHour(nowMs).end;
  if (nowMs - reportState.bootMs < REPORT_BOOT_GRACE_MS) return 'NOT_DUE';
  if (reportState.inFlight && nowMs - reportState.inFlightSince < REPORT_HUNG_MS) return 'IN_FLIGHT';
  if (reportState.doneHour === hour) return 'NOT_DUE';
  if (nowMs - reportState.lastFailureMs < REPORT_RETRY_MS) return 'NOT_DUE';
  reportState.inFlightSince = nowMs;
  const run = generateDue(nowMs, hour).catch((error: unknown) => {
    reportState.lastFailureMs = nowMs; // the attempt's own clock, so the pause is measured on one clock
    console.warn(`operations report: generation failed, retrying in ${REPORT_RETRY_MS / 60_000} min: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
  });
  const mine = run.finally(() => {
    if (reportState.inFlight === mine) reportState.inFlight = null;
  });
  reportState.inFlight = mine;
  return 'STARTED';
}

/** The latest report's bottlenecks, for the operator's brief: what to act on first. */
export async function latestReportBrief(): Promise<string> {
  const row = await getDb().get<{ payload: string }>(
    `SELECT payload FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND payload LIKE '%"status":"READY"%' ORDER BY entity_id DESC LIMIT 1`,
    [],
  );
  if (!row) return '';
  const text = String((JSON.parse(row.payload) as { text?: string }).text ?? '');
  const section = text.split('TOP 3 BOTTLENECKS')[1]?.split('SCALING DECISIONS')[0]?.trim() ?? '';
  if (!section) return '';
  return `OPERATIONS REPORT — act first on what Brain may resolve itself (redirect work, reprioritize Factory, commission a fix, continue idle capacity, change strategy); a bottleneck that survived several reports needs a different diagnosis, not the same fix:\n${section.slice(0, 1500)}`;
}
