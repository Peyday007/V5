/**
 * The owner's hourly operations report (owner, 2026-11-13): built from real rows, honest about
 * what is unmeasured, ranking real bottlenecks, and delivered in the owner's conversation through
 * the existing owner-notice path — once per hour, newest only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
    },
    pipeline: { opportunitiesDiscovered: 4, opportunitiesQualified: 1, researchCompleted: 3, researchFailed: 1, strategiesConstructed: 2, evaluationsCompleted: 1, evaluationsFailed: 0, evidenceValidated: 3, planReadings: 1, plansAccepted: 0 },
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
      hourEnding: '2026-11-13T11:00:00.000Z', now: win(), prev: win({ pipeline: { ...win().pipeline, researchCompleted: 1 } }), day: win(),
      plan: plan(), planPrev: plan(), planHistory: [], hermesSummary: 'Inspected the goal; recorded a lesson.', openEngineering: [], persistence: {},
      ownerOpportunities: [], unmeasured: ['per-call token counts'],
    });
    expect(r.text.startsWith('BRAIN — $10K PLAN OPERATIONS REPORT\nHour ending: 2026-11-13T11:00:00.000Z\n\nEXECUTIVE SUMMARY')).toBe(true);
    for (const s of ['Plan readiness:', 'Progress this hour:', 'Most important improvement:', 'Biggest remaining obstacle:', 'Expected time to qualifying plan:', '$10K PLAN DEVELOPMENT', 'Pipeline (this hour', 'HERMES PERFORMANCE', 'Runs / actions / real outcomes:', 'A thought:', 'B decided:', 'C executed:', 'D improved:', 'PIPELINE PERFORMANCE', 'RESOURCE UTILIZATION', 'TOP 3 BOTTLENECKS', 'SCALING DECISIONS', 'MORE AGENTS:', 'STRONGER MODEL:', 'MORE GPU CAPACITY:', 'MORE RESEARCH CAPACITY:', 'MORE FINANCIAL CAPITAL:', "HERMES' NEXT ACTIONS", 'OWNER OPPORTUNITIES', 'NONE.', 'Not instrumented (stated, not estimated): per-call token counts']) {
      expect(r.text).toContain(s);
    }
    expect(r.text).toContain('Plan reach did not move because its binding factor (reply rate) received no new evidence');
    expect(r.text).toContain('expected revenue is not collected revenue');
    expect(r.text).toContain('coverage of assumed inputs, not a probability');
    expect(r.text).not.toContain('Nothing to announce');
    expect(r.text).toContain('research done 3 (+2)');
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
    expect(report.text).toContain('model ×1');
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

  it("puts the latest report's bottlenecks first in Hermes' next brief, so it acts on them", async () => {
    const { recordHourlyReport } = await import('../server/services/operator/operationsReport.ts');
    await recordHourlyReport(Date.now());
    const { engineeringBrief } = await import('../server/services/operator/director.ts');
    const brief = await engineeringBrief();
    expect(brief.startsWith('OPERATIONS REPORT — act first on what Brain may resolve itself')).toBe(true);
  });
});
