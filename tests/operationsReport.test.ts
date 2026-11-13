/**
 * The owner's hourly operations report (owner, 2026-11-13): built from real rows, honest about
 * what is unmeasured, ranking real bottlenecks, and delivered in the owner's conversation through
 * the existing owner-notice path — once per hour, newest only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { finishOperatorRun, startOperatorRun } from '../server/repos/operator.ts';
import { recordEvent } from '../server/repos/events.ts';
import { bottlenecks, renderReport, scalingDecisions, timeToPlan, type OpsWindow, type PlanReadingFacts, type QueueReading } from '../server/domain/operationsReport.ts';

const q = (over: Partial<QueueReading> = {}): QueueReading => ({ queued: 0, running: 0, blocked: 0, completed: 0, failed: 0, oldestWaitMin: null, avgWaitMin: null, ...over });

function win(over: Partial<OpsWindow> = {}): OpsWindow {
  return {
    start: '2026-11-13T10:00:00.000Z',
    end: '2026-11-13T11:00:00.000Z',
    hermes: {
      runsStarted: 2, runsDone: 1, runsFailed: 1, models: ['free-router'], toolCalls: 12, toolCallsFailed: 2,
      toolsByName: { brain_operator_goal: { ok: 3, failed: 0 } }, runMinutes: 30, lostMinutes: 10, failureReasons: { model: 1 },
      decisions: 1, decisionsByKind: { RESEARCH: 1 }, challenged: 1, actionsExecuted: 1, commissioned: 0, reprioritized: 0,
      strategyChanges: 0, outcomesResolved: 0, outcomesNotResolved: 0, verifications: 0, lessons: 1,
      goalsInspected: 3, problemsIdentified: 1, outcomesReceived: 0, repeatedToolFailures: { brain_operator_goal_plan: 2 },
    },
    pipeline: { opportunitiesDiscovered: 4, opportunitiesQualified: 1, researchCompleted: 3, researchFailed: 1, strategiesConstructed: 2, evaluationsCompleted: 1, evaluationsFailed: 0, evidenceValidated: 3, planReadings: 1, plansAccepted: 0, executionStarted: 0, leadsPrepared: 5, repliesReceived: 1 },
    queues: { research: q({ queued: 5, running: 2, completed: 3, failed: 1, oldestWaitMin: 90, avgWaitMin: 40 }), coding: q(), factoryUnits: q(), otherWork: q() },
    factory: { campaignsActive: 1, campaignsBlocked: 0, campaignsCompleted: 0, workers: [{ name: 'claude-1', modelClass: 'STRONGEST', availability: 'AVAILABLE', maxConcurrency: 2, leased: 2, rateLimited: false }], waitingByClass: {} },
    models: { researchJobsByModel: { opus: { done: 3, failed: 1, avgSeconds: 120 } }, cheapCallsByModel: { qwen: { ok: 40, failed: 2 } } },
    money: { collectedCents: 0, spentCents: 0, spendHeldMicros: null, spendCeilingMicros: null },
    incidents: [],
    integrationFailures: [],
    ...over,
  };
}

function plan(over: Partial<PlanReadingFacts> = {}): PlanReadingFacts {
  return {
    goalId: 'wst_x', goalTitle: '$10K in 30 days', readAt: '2026-11-13T10:30:00.000Z', verdict: 'NEEDS_EVIDENCE', acceptance: 'CANDIDATE_ONLY',
    candidate: 'Dental audits + referrals', reach: 0.009, reachBasis: 'COVERAGE', lowerBound: null, required: 0.9, settledP50: 2400,
    shortfalls: ['the reach is coverage of assumed inputs, not a probability', 'reply rate measured at 0.37%'], binding: 'reply rate',
    targetCents: 1_000_000, remainingCents: 1_000_000, collectedCents: 0, daysLeft: 26, capitalCeilingCents: 300_000,
    nextTest: { test: 'Send 200 offers and measure replies', by: 'BRAIN', blocker: null }, personBlockers: [],
    ...over,
  };
}

describe('the bottlenecks are real and ranked: the plan first, then what holds the work that would move it', () => {
  it('leads with the plan shortfall and its binding factor, then failing Hermes runs', () => {
    const b = bottlenecks(win({ hermes: { ...win().hermes, runsStarted: 4, runsFailed: 3, failureReasons: { model: 3 } } }), plan());
    expect(b[0]!.key).toBe('plan:reply rate');
    expect(b[0]!.cause).toContain('reply rate');
    expect(b[1]!.key).toBe('hermes:failing:model');
    expect(b[1]!.evidence).toContain('model ×3');
  });

  it('tells a scheduling fault (work waits beside free workers) from a capacity fault', () => {
    const waiting = { factoryUnits: q({ queued: 4, oldestWaitMin: 120 }) };
    const healthy = { ...win().hermes, runsFailed: 0, failureReasons: {} };
    const scheduling = bottlenecks(win({ hermes: healthy, queues: { ...win().queues, ...waiting }, factory: { ...win().factory, workers: [{ name: 'w', modelClass: 'FAST', availability: 'AVAILABLE', maxConcurrency: 2, leased: 0, rateLimited: false }] } }), null);
    expect(scheduling[0]!.key).toBe('factory:scheduling');
    const capacity = bottlenecks(win({ hermes: healthy, queues: { ...win().queues, ...waiting } }), null);
    expect(capacity[0]!.key).toBe('factory:capacity');
  });

  it('flags a bottleneck that survived three reports for a new diagnosis, not the same fix', () => {
    const b = bottlenecks(win(), plan(), { 'plan:reply rate': 3 });
    expect(b[0]!.intervention).toMatch(/^Survived 3 reports unchanged — reconsider the diagnosis/);
  });
});

describe('scaling calls are made only as far as the rows support them', () => {
  it('says NO to more agents when work waits beside free workers, YES only when every capable worker is saturated for an hour', () => {
    const waiting = { ...win().queues, factoryUnits: q({ queued: 3, oldestWaitMin: 90 }) };
    expect(scalingDecisions(win({ queues: waiting, factory: { ...win().factory, workers: [{ name: 'w', modelClass: 'FAST', availability: 'AVAILABLE', maxConcurrency: 2, leased: 1, rateLimited: false }] } }), null).agents.call).toBe('NO');
    expect(scalingDecisions(win({ queues: waiting, factory: { ...win().factory, waitingByClass: { STRONGEST: 3 } } }), null).agents.call).toBe('YES');
    expect(scalingDecisions(win(), null).agents.call).toBe('NO');
  });

  it('never calls for a stronger model, GPU or capital the rows do not show is the limit', () => {
    const calls = scalingDecisions(win({ hermes: { ...win().hermes, runsFailed: 1, failureReasons: { brain: 1 } } }), plan());
    expect(calls.model.call).toBe('NO');
    expect(calls.gpu.call).toBe('NO');
    expect(calls.capital.call).toBe('NO');
    expect(scalingDecisions(win({ hermes: { ...win().hermes, runsStarted: 4, runsFailed: 3, failureReasons: { model: 3 } } }), plan()).model.call).toBe('YES');
  });
});

describe('the time to a qualifying plan is never invented', () => {
  it('is unknown, with the reason and what would resolve it, while the reach is coverage', () => {
    const t = timeToPlan([{ at: '2026-11-13T09:00:00Z', reach: 0.009, basis: 'COVERAGE', lowerBound: null }], 0.9);
    expect(t.eta).toBeNull();
    expect(t.why).toMatch(/Cannot be estimated.*coverage.*What would resolve it/);
  });

  it('is a stated rate only when a probability lower bound rises across readings', () => {
    const t = timeToPlan([
      { at: '2026-11-13T00:00:00Z', reach: 0.5, basis: 'PROBABILITY', lowerBound: 0.4 },
      { at: '2026-11-13T10:00:00Z', reach: 0.6, basis: 'PROBABILITY', lowerBound: 0.5 },
    ], 0.9);
    expect(t.eta).toBe('~40 h at the last 10 h\'s rate');
    expect(timeToPlan([
      { at: '2026-11-13T00:00:00Z', reach: 0.5, basis: 'PROBABILITY', lowerBound: 0.5 },
      { at: '2026-11-13T10:00:00Z', reach: 0.5, basis: 'PROBABILITY', lowerBound: 0.5 },
    ], 0.9).eta).toBeNull();
  });
});

describe('the report', () => {
  it('opens with the executive summary and carries every section the owner listed, explaining why nothing moved', () => {
    const r = renderReport({
      hourEnding: '2026-11-13T11:00:00.000Z', now: win(), prev: win({ pipeline: { ...win().pipeline, researchCompleted: 1 } }), baseline: { hours: 5, pipeline: win().pipeline }, partial: [],
      plan: plan(), planPrev: plan(), planHistory: [], hermesSummary: 'Inspected the goal; recorded a lesson.', openEngineering: [], persistence: {}, lastKeys: ['hermes:inactive'],
      ownerOpportunities: [], unmeasured: ['per-call token counts'],
    });
    expect(r.text.startsWith('BRAIN — $10K PLAN OPERATIONS REPORT\nHour ending: 2026-11-13T11:00:00.000Z\n\n$10K PLAN — ACTIVE BOTTLENECK ELIMINATION')).toBe(true);
    for (const s of ['Plan readiness:', 'Main remaining constraint:', 'Constraints eliminated this hour: hermes:inactive', 'Work being performed right now:', 'Independent fixes running simultaneously:', 'Resource or intelligence bottlenecks:', 'Initiated by Hermes without being asked:', 'What actually improved:', 'Would agents, compute or capital accelerate it:', 'Remaining time to a qualifying plan:', '$10K PLAN DEVELOPMENT', 'Pipeline (this hour', 'HERMES PERFORMANCE', 'Runs / actions / real outcomes:', 'A thought:', 'B decided:', 'C executed:', 'D improved:', 'PIPELINE PERFORMANCE', 'RESOURCE UTILIZATION', 'TOP 3 BOTTLENECKS', 'SCALING DECISIONS', 'MORE AGENTS:', 'STRONGER MODEL:', 'MORE GPU CAPACITY:', 'MORE RESEARCH CAPACITY:', 'MORE FINANCIAL CAPITAL:', "HERMES' NEXT ACTIONS", 'OWNER OPPORTUNITIES', 'NONE.', 'MODEL ADEQUACY', 'ENGINEERING CAPACITY', 'INTERVENTION TRACKING', 'resolved hermes:inactive', 'Goals inspected 3', 'brain_operator_goal_plan ×2', 'Customer acquisition:', 'Goal-advancing this hour:', 'Estimated improvement:', 'Stronger model?', 'Scarce capabilities:', 'Not instrumented (stated, not estimated): per-call token counts']) {
      expect(r.text).toContain(s);
    }
    expect(r.text).toContain('Plan reach did not move because its binding factor (reply rate) received no new evidence');
    expect(r.text).toContain('expected revenue is not collected revenue');
    expect(r.text).toContain('coverage of assumed inputs, not a probability');
    expect(r.text).not.toContain('Nothing to announce');
    expect(r.text).toContain('research done 3 (+2)');
    expect(r.text).not.toContain('PARTIAL REPORT');
  });

  it('publishes a partial report that names what it could not read and shows those figures as n/a, never as zero', () => {
    const now = win();
    now.hermes.runsStarted = Number.NaN;
    now.pipeline.researchCompleted = Number.NaN;
    const r = renderReport({
      hourEnding: '2026-11-13T11:00:00.000Z', now, prev: null, baseline: null, partial: ['operator runs (could not be read)', 'research fragments (skipped: the report\'s read budget ran out)'],
      plan: plan(), planPrev: null, planHistory: [], hermesSummary: null, openEngineering: [], persistence: {}, lastKeys: [], ownerOpportunities: [], unmeasured: [],
    });
    expect(r.text.split('\n')[2]).toBe("PARTIAL REPORT — not readable this hour: operator runs (could not be read); research fragments (skipped: the report's read budget ran out). Those figures show as n/a, never as zero.");
    expect(r.text).toContain('research done n/a');
    expect(r.text).toContain('Runs / actions / real outcomes: n/a started');
    expect(r.text).toContain('no previous hour measured');
    expect(r.text).toContain('no earlier reports yet');
    expect(r.text).not.toContain('NaN');
  });
});

/* ------------------------------------------------------------------------- */
/* On real rows                                                               */
/* ------------------------------------------------------------------------- */

describe('built from production rows, recorded once an hour, and read by the owner\'s conversation', () => {
  let projectId = '';
  let goalId = '';
  const reader = () => ({
    type: 'WORKER', id: 'wkr_c', handle: 'worker-05', displayName: 'worker-05', isBrainAdmin: false, mustChangePassword: false,
    credentialId: 'cred_x', authMethod: 'OAUTH_BEARER', requestId: 'req_x',
    memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_c', role: null, scopes: ['project:read', 'checkpoints:write'], active: true }],
  }) as unknown as import('../server/domain/types.ts').Principal;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const { findTool } = await import('../server/mcp/tools.ts');
    return (await findTool(name)!.run(args, { principal: reader() } as never)).value as Record<string, unknown>;
  };

  beforeEach(async () => {
    ({ project: { id: projectId } } = await freshProject());
    goalId = (await createWorkstream({ projectId, title: 'Collect $10,000 in 30 days', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
    await getDb().run('UPDATE workstreams SET target_metric = ?, target_amount_cents = ?, capital_ceiling_cents = ?, target_project_id = ? WHERE id = ?', ['SETTLED_CASH', 1_000_000, 300_000, projectId, goalId]);
  });

  it('counts what actually happened: Hermes runs, failures and their reason, decisions, and the plan reading', async () => {
    const ok = await startOperatorRun('free-router');
    await finishOperatorRun({ id: ok.id, state: 'DONE', summary: 'Inspected the goal.', toolCalls: [{ tool: 'brain_operator_goal', ok: true }, { tool: 'brain_operator_continue_idle', ok: true }], error: null });
    const bad = await startOperatorRun('free-router → runpod');
    await finishOperatorRun({ id: bad.id, state: 'FAILED', summary: null, toolCalls: [], error: '429 rate limit from the free router' });
    await recordEvent({ projectId, entityType: 'PROJECT', entityId: 'opd_1', eventType: 'OPERATOR_DECISION', payload: { input: { kind: 'RESEARCH' }, challenge: { verdict: 'PROCEED' } } });
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, '[]', ?, ?, ?)`,
      ['gpr_1', goalId, 'd1', 'NEEDS_EVIDENCE', JSON.stringify({ test: 'Send 200 offers', by: 'BRAIN', blocker: null }),
        JSON.stringify({ acceptance: { status: 'CANDIDATE_ONLY', required: 0.9, probability: null, candidate: { label: 'Dental audits', reach: 0.009, reachBasis: 'COVERAGE', settledP50: 2400 }, shortfalls: ['the reach is coverage, not a probability'] }, remainingCents: 1_000_000, daysLeft: 26, reconstruction: { binding: 'reply rate' } }),
        new Date().toISOString()],
    );
    const { buildOperationsReport } = await import('../server/services/operator/operationsReport.ts');
    const report = await buildOperationsReport(Date.now() + 3_600_000, goalId);
    expect(report.text).toContain('Runs / actions / real outcomes: 2 started, 1 done, 1 failed / 1 executed / 0 improved');
    expect(report.text).toContain('rate_limit ×1');
    expect(report.text).toContain('Decisions by kind: RESEARCH 1');
    expect(report.text).toContain('Best evidence-backed candidate: Dental audits');
    expect(report.text).toContain('Failed acceptance conditions: the reach is coverage, not a probability');
    expect(report.text).toContain('Next action for acceptance: Send 200 offers (BRAIN)');
    expect(report.bottleneckKeys[0]).toBe('plan:reply rate');
  });

  it('records one report per hour as an owner notice, offers only the newest, and the conversation marks it delivered', async () => {
    const { recordHourlyReport, reportNoticeId } = await import('../server/services/operator/operationsReport.ts');
    const t0 = Date.now();
    const first = await recordHourlyReport(t0);
    expect(first?.created).toBe(true);
    expect((await recordHourlyReport(t0 + 60_000))?.created).toBe(false); // same hour: never twice
    const second = await recordHourlyReport(t0 + 3_600_000);
    expect(second?.created).toBe(true);
    const notices = (await tool('brain_list_projects', {}))['ownerNotices'] as { noticeId: string; kind: string; text: string }[];
    const reports = notices.filter((n) => n.kind === 'REPORT');
    expect(reports.map((n) => n.noticeId)).toEqual([second!.noticeId]); // the missed hour is superseded, not queued
    expect(reports[0]!.text.startsWith('BRAIN — $10K PLAN OPERATIONS REPORT')).toBe(true);
    expect(second!.noticeId).toBe(reportNoticeId(new Date(Math.floor((t0 + 3_600_000) / 3_600_000) * 3_600_000).toISOString()));
    await tool('brain_owner_notice_delivered', { project_id: projectId, notice_id: second!.noticeId, where: 'session_test' });
    expect(((await tool('brain_list_projects', {}))['ownerNotices'] as unknown[]).filter((n) => (n as { kind: string }).kind === 'REPORT')).toEqual([]);
  });

  it('reads the operational tables once per hour: the hour before, the baseline and the history come from recorded reports', async () => {
    const mod = await import('../server/services/operator/operationsReport.ts');
    const db = getDb() as unknown as { all: (...a: unknown[]) => Promise<unknown>; get: (...a: unknown[]) => Promise<unknown> };
    const counted = async (fn: () => Promise<unknown>): Promise<number> => {
      const all = db.all.bind(db);
      const get = db.get.bind(db);
      let n = 0;
      db.all = (...a: unknown[]) => { n += 1; return all(...a); };
      db.get = (...a: unknown[]) => { n += 1; return get(...a); };
      try { await fn(); } finally { db.all = all; db.get = get; }
      return n;
    };
    const t0 = Date.parse('2026-11-13T09:30:00.000Z');
    const cold = await counted(() => mod.recordHourlyReport(t0)); // no earlier report: the hour before is read from the tables
    const warm = await counted(() => mod.recordHourlyReport(t0 + 3_600_000)); // the hour before is the report just recorded
    expect(warm).toBeLessThan(cold);
    expect(warm).toBeLessThan(60);
    const later = await mod.buildOperationsReport(t0 + 2 * 3_600_000);
    expect(later.text).toContain('per-hour baseline over 2 earlier report(s)');
  });

  it('stops reading at its budget and publishes the report partial, naming every skipped read', async () => {
    const { recordHourlyReport } = await import('../server/services/operator/operationsReport.ts');
    const t0 = Date.parse('2026-11-13T05:30:00.000Z');
    const r = await recordHourlyReport(t0, { budgetMs: -1 });
    expect(r?.created).toBe(true);
    expect(r!.partial.length).toBeGreaterThan(10);
    expect(r!.partial.every((m) => m.endsWith("(skipped: the report's read budget ran out)"))).toBe(true);
    const row = await getDb().get<{ payload: string }>(`SELECT payload FROM project_events WHERE entity_id = ? AND payload LIKE '%"status":"READY"%'`, [r!.noticeId]);
    const text = String((JSON.parse(row!.payload) as { text: string }).text);
    expect(text).toContain("PARTIAL REPORT — not readable this hour: earlier reports (skipped: the report's read budget ran out); operator runs (skipped");
    expect(text).not.toContain('$n/a');
    expect(text).not.toContain('NaN');
    expect(text).toContain('Runs / actions / real outcomes: n/a started');
  });

  it('runs in the background: the tick returns at once, one generation at a time, recovering missed hours without duplicates', async () => {
    const mod = await import('../server/services/operator/operationsReport.ts');
    mod.resetReportScheduleForTests(0);
    const t = Date.parse('2026-11-13T12:20:00.000Z');
    expect(mod.operationsReportTick(t)).toBe('STARTED');
    expect(mod.operationsReportTick(t + 1000)).toBe('IN_FLIGHT');
    await vi.waitFor(async () => expect(mod.operationsReportTick(t + 2000)).not.toBe('IN_FLIGHT'), { timeout: 20_000 });
    const ids = async () => (await getDb().all<{ entity_id: string; n: number }>(
      `SELECT entity_id, COUNT(*) AS n FROM project_events WHERE event_type = 'OWNER_OPERATIONS_REPORT' AND payload LIKE '%"status":"READY"%' GROUP BY entity_id ORDER BY entity_id DESC`, [],
    ));
    // The hour just ended, and the newest missed hour before it, recovered and marked so.
    expect((await ids()).map((x) => x.entity_id)).toEqual(['ops-report.20261113T12', 'ops-report.20261113T11']);
    const recovered = await getDb().get<{ payload: string }>(`SELECT payload FROM project_events WHERE entity_id = 'ops-report.20261113T11'`, []);
    expect(JSON.parse(recovered!.payload).text).toContain('Recovered at 2026-11-13T12:20:00.000Z after the hour was missed');
    // Later ticks keep recovering the window, one hour at a time, and never record an hour twice.
    for (let i = 0; i < 4; i += 1) {
      mod.operationsReportTick(t + 60_000 * (i + 2));
      await vi.waitFor(async () => expect(mod.operationsReportTick(t + 60_000 * (i + 2) + 1)).not.toBe('IN_FLIGHT'), { timeout: 20_000 });
    }
    const all = await ids();
    expect(all).toHaveLength(mod.REPORT_RECOVERY_HOURS);
    expect(all.every((x) => Number(x.n) === 1)).toBe(true);
    expect(mod.operationsReportTick(t + 10 * 60_000)).toBe('NOT_DUE'); // this hour is done
    // The conversation is offered the hour just ended, not the last hour recovered.
    const notices = (await tool('brain_list_projects', {}))['ownerNotices'] as { noticeId: string; kind: string }[];
    expect(notices.filter((n) => n.kind === 'REPORT').map((n) => n.noticeId)).toEqual(['ops-report.20261113T12']);
  });

  it('retries a failed generation after a pause, and never blocks Hermes while a report is slow or hung', async () => {
    const mod = await import('../server/services/operator/operationsReport.ts');
    mod.resetReportScheduleForTests(0);
    const db = getDb() as unknown as { all: (sql: string, p?: unknown[]) => Promise<unknown> };
    const all = db.all.bind(db);
    // 1. The database refuses the report's reads: the generation fails, is logged, and waits REPORT_RETRY_MS.
    db.all = (sql: string, p?: unknown[]) => (sql.includes('OWNER_OPERATIONS_REPORT') ? Promise.reject(new Error('Connection terminated due to connection timeout')) : all(sql, p));
    const t = Date.parse('2026-11-13T15:10:00.000Z');
    try {
      expect(mod.operationsReportTick(t)).toBe('STARTED');
      await vi.waitFor(() => expect(mod.operationsReportTick(t + 1000)).toBe('NOT_DUE'), { timeout: 20_000 });
      expect(mod.operationsReportTick(t + mod.REPORT_RETRY_MS - 1000)).toBe('NOT_DUE');
    } finally {
      db.all = all;
    }
    // 2. A report that hangs: Hermes' tick still completes, and no second generation piles up.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    db.all = (sql: string, p?: unknown[]) => (sql.includes('OWNER_OPERATIONS_REPORT') ? gate.then(() => all(sql, p)) : all(sql, p));
    try {
      const retryAt = t + mod.REPORT_RETRY_MS + 1000;
      expect(mod.operationsReportTick(retryAt)).toBe('STARTED');
      const { operatorTickIfDue } = await import('../server/services/operator/run.ts');
      const started = Date.now();
      await operatorTickIfDue(retryAt, {});
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(mod.operationsReportTick(retryAt + 60_000)).toBe('IN_FLIGHT');
      // Hung past REPORT_HUNG_MS, it no longer blocks the next attempt.
      expect(mod.operationsReportTick(retryAt + mod.REPORT_HUNG_MS + 1000)).toBe('STARTED');
    } finally {
      release();
      db.all = all;
    }
    await vi.waitFor(async () => {
      const rows = await getDb().all<{ n: number }>(`SELECT COUNT(*) AS n FROM project_events WHERE entity_id = 'ops-report.20261113T15' AND payload LIKE '%"status":"READY"%'`, []);
      expect(Number(rows[0]!.n)).toBe(1);
    }, { timeout: 20_000 });
  });

  it("puts the latest report's bottlenecks first in Hermes' next brief, so it acts on them", async () => {
    const { recordHourlyReport } = await import('../server/services/operator/operationsReport.ts');
    await recordHourlyReport(Date.now());
    const { engineeringBrief } = await import('../server/services/operator/director.ts');
    const brief = await engineeringBrief();
    expect(brief.startsWith('OPERATIONS REPORT — act first on what Brain may resolve itself')).toBe(true);
  });
});

describe('Hermes wakes on a changed constraint, not only on the hour', () => {
  it('a new plan reading, or a report whose main bottleneck changed, wakes the operator; an unchanged one does not', async () => {
    const { project: { id: projectId } } = await freshProject();
    const goalId = (await createWorkstream({ projectId, title: 'Collect $10,000', intent: 'Collect cash.', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
    const { changedConstraintSince } = await import('../server/services/operator/director.ts');
    const report = (hour: string, keys: string[]) => recordEvent({
      projectId, entityType: 'PROJECT', entityId: `ops-report.${hour}`, eventType: 'OWNER_OPERATIONS_REPORT',
      payload: { status: 'READY', noticeId: `ops-report.${hour}`, subject: 's', text: 't', bottleneckKeys: keys },
    });
    await report('20261113T10', ['plan:reply rate']);
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    expect(await changedConstraintSince(since)).toBe(false);
    await report('20261113T11', ['plan:reply rate', 'hermes:inactive']);
    expect(await changedConstraintSince(since)).toBe(false); // same main constraint: the hourly run is enough
    await report('20261113T12', ['factory:scheduling', 'plan:reply rate']);
    expect(await changedConstraintSince(since)).toBe(true); // the main constraint moved
    const later = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    expect(await changedConstraintSince(later)).toBe(false);
    await getDb().run(
      `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at) VALUES (?, ?, 'd', NULL, NULL, 'NEEDS_EVIDENCE', NULL, '[]', NULL, '{}', ?)`,
      ['gpr_wake', goalId, new Date().toISOString()],
    );
    expect(await changedConstraintSince(later)).toBe(true); // the plan's conclusion changed
  });
});
