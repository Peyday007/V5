/**
 * Hermes as Brain's engineering director (§109): the intervention rules, the
 * priority and routing, the outcome judgment, and the commission journey on
 * real rows — registered once in §87's register, admitted to Factory at once,
 * its waiting work re-prioritized, and its outcome delivered back.
 *
 * Factory's own submit and start are replaced at their module boundary in the
 * journey test: they reach GitHub (`deriveFromForge`), and what is under test
 * is that the director calls them, once, with the directive in the objective.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitted: Array<Record<string, unknown>> = [];
vi.mock('../server/services/factory/contract.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/contract.ts')>();
  return {
    ...actual,
    submitObjective: vi.fn(async (input: Record<string, unknown>) => {
      submitted.push(input);
      return { changeRequest: { id: `fcr_test${submitted.length}` }, created: true };
    }),
  };
});
vi.mock('../server/services/factory/start.ts', () => ({
  approveAndStartCampaign: vi.fn(async (input: { changeRequestId: string }) => ({
    ok: true,
    changeRequest: { id: input.changeRequestId, riskClass: 'LOW' },
    campaign: { id: `fcp_for_${input.changeRequestId}` },
    campaignCreated: true,
    execution: { mode: 'REMOTE', note: 'test' },
  })),
}));
vi.mock('../server/services/factory/release/grant.ts', () => ({ authorizeAutomaticRelease: vi.fn(async () => ({ ok: true })) }));

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { setProjectRepository } from '../server/repos/factory.ts';
import { getCandidate, listCandidates } from '../server/repos/improvement.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { composeObjective } from '../server/services/improvement/loop.ts';
import {
  compareGoal,
  decideIntervention,
  engineeringPriority,
  judgeEngineering,
  minimumModelClassOf,
  routeEngineering,
  ROUTING_MARKER,
  type Diagnosis,
  type GoalMark,
} from '../server/domain/engineeringDirector.ts';
import { chooseWorker, type SchedulableUnit } from '../server/services/factory/scheduler.ts';
import type { WorkerSlot } from '../server/services/factory/registry.ts';
import { operatorDue, OPERATOR_TOOL_NAMES, operatorBrief } from '../server/domain/operator.ts';
import { findTool } from '../server/mcp/tools.ts';

const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  goalId: 'wst_goal',
  deficiency: 'RECURRING_OPERATIONAL_FAILURE',
  title: 'Moot cards reopen and hold the goal on a person',
  observed: 'The goal reads BLOCKED on a person while every open card is moot.',
  evidence: 'rhr_1: mission DONE; rhr_2: mission DONE',
  cause: "answered-requests reopens a card whose mission already left NEEDS_HUMAN, so no answer can ever apply",
  ownerPaths: ['server/services/russell/needsHuman.ts'],
  recurrence: 4,
  expectedBenefit: 'The goal leads with Brain work instead of a person.',
  acceptance: 'A test shows a moot answered card is withdrawn, not reopened.',
  metric: 'OWNER_INTERVENTIONS_PER_DAY',
  blocksGoal: true,
  share: 0.3,
  proposed: null,
  ...over,
});

describe('which intervention a deficiency has earned', () => {
  it('engineers only an established, owned, recurring cause', () => {
    expect(decideIntervention(diagnosis()).intervention).toBe('ENGINEERING');
  });
  it('does not turn every problem into a coding assignment', () => {
    expect(decideIntervention(diagnosis({ cause: null })).intervention).toBe('EVIDENCE');
    expect(decideIntervention(diagnosis({ recurrence: 1 })).intervention).toBe('WATCH');
    expect(decideIntervention(diagnosis({ modelLimited: true })).intervention).toBe('MODEL');
    expect(decideIntervention(diagnosis({ personOnly: true })).intervention).toBe('PERSON');
    expect(decideIntervention(diagnosis({ capacityIdle: true })).intervention).toBe('CAPACITY');
    expect(decideIntervention(diagnosis({ capacityIdle: true, capacityTried: true })).intervention).toBe('ENGINEERING');
    expect(decideIntervention(diagnosis({ deficiency: 'REPEATED_STRATEGIC_MISTAKE', ownerPaths: [] })).intervention).toBe('STRATEGY');
  });
  it('honours a less invasive proposal and overrules engineering the rows do not support', () => {
    expect(decideIntervention(diagnosis({ proposed: 'STRATEGY' })).intervention).toBe('STRATEGY');
    const overruled = decideIntervention(diagnosis({ proposed: 'ENGINEERING', cause: null }));
    expect(overruled.intervention).toBe('EVIDENCE');
    expect(overruled.overruled).toContain('proposed ENGINEERING');
  });
});

describe('priority follows what the defect holds back', () => {
  it('ranks a defect blocking $10K in 27 days far above one on a goal with no money target', () => {
    const big = engineeringPriority({ blocksGoal: true, remainingCents: 1_000_000, daysLeft: 27, share: 0.3, recurrence: 4, deficiency: 'RECURRING_OPERATIONAL_FAILURE' });
    const small = engineeringPriority({ blocksGoal: false, remainingCents: null, daysLeft: null, share: 0.05, recurrence: 1, deficiency: 'MISSING_CAPABILITY' });
    expect(big.priority).toBeGreaterThan(small.priority);
    expect(big.urgency === 'HIGH' || big.urgency === 'IMMEDIATE').toBe(true);
    expect(small.priority).toBeGreaterThanOrEqual(1);
  });
  it('rises as the deadline approaches, and is never outside 1..9', () => {
    const far = engineeringPriority({ blocksGoal: false, remainingCents: 1_000_000, daysLeft: 300, share: 0.1, recurrence: 2, deficiency: 'BROKEN_INTEGRATION' });
    const near = engineeringPriority({ blocksGoal: false, remainingCents: 1_000_000, daysLeft: 2, share: 0.1, recurrence: 2, deficiency: 'BROKEN_INTEGRATION' });
    expect(near.priority).toBeGreaterThan(far.priority);
    const huge = engineeringPriority({ blocksGoal: true, remainingCents: 1e12, daysLeft: 1, share: 1, recurrence: 99, deficiency: 'ECONOMIC_REASONING' });
    expect(huge.priority).toBe(9);
  });
});

describe('routing: hard problems never go to weak models because they are free', () => {
  it('routes reasoning deficiencies and second attempts to STRONGEST, a bounded fix to FAST', () => {
    expect(routeEngineering({ deficiency: 'ECONOMIC_REASONING', ownerPaths: ['a/b/c.ts'], risk: 'LOW', failedAttempts: 0, urgency: 'NORMAL' }).minimumModelClass).toBe('STRONGEST');
    expect(routeEngineering({ deficiency: 'RECURRING_OPERATIONAL_FAILURE', ownerPaths: ['a/b/c.ts'], risk: 'LOW', failedAttempts: 1, urgency: 'NORMAL' }).minimumModelClass).toBe('STRONGEST');
    expect(routeEngineering({ deficiency: 'RECURRING_OPERATIONAL_FAILURE', ownerPaths: ['a/b/c.ts'], risk: 'LOW', failedAttempts: 0, urgency: 'HIGH' }).minimumModelClass).toBe('FAST');
    expect(minimumModelClassOf(`x ${ROUTING_MARKER} y`)).toBe('STRONGEST');
  });

  const unit = (over: Partial<SchedulableUnit> = {}): SchedulableUnit => ({
    id: 'u1', unitKey: 'u1', kind: 'IMPLEMENTATION', role: 'IMPLEMENTER', modelClass: 'FAST', ownedPaths: ['a.ts'],
    criticalPath: false, downstreamCount: 0, priority: 5, risk: 'LOW', attempt: 0, maxAttempts: 3, ...over,
  });
  const slot = (over: Partial<WorkerSlot>): WorkerSlot => ({
    workerId: 'w', name: 'w', kind: 'LOCAL_CLI', accountRef: 'a', model: 'm', modelClass: 'FAST', capabilities: ['IMPLEMENT'],
    freeSlots: 2, running: 0, availability: 'AVAILABLE', rateLimitedUntil: null, ...over,
  });

  it('refuses a free FAST worker for a unit routed STRONGEST, and waits with that reason', () => {
    const choice = chooseWorker(unit({ modelClass: 'STRONGEST' }), [slot({ workerId: 'cheap', name: 'cheap', freeSlots: 5 })]);
    expect(choice.slot).toBeNull();
    expect(choice.reason).toContain('STRONGEST');
    const strong = chooseWorker(unit({ modelClass: 'STRONGEST' }), [slot({ workerId: 'cheap', name: 'cheap' }), slot({ workerId: 'strong', name: 'strong', modelClass: 'STRONGEST', freeSlots: 1 })]);
    expect(strong.slot?.workerId).toBe('strong');
  });
  it('prefers the cheaper capable worker for FAST work, and the one with the better record', () => {
    const cheap = chooseWorker(unit(), [slot({ workerId: 'strong', name: 'a', modelClass: 'STRONGEST' }), slot({ workerId: 'fast', name: 'b' })]);
    expect(cheap.slot?.workerId).toBe('fast');
    const record = chooseWorker(unit(), [
      slot({ workerId: 'flaky', name: 'a', track: { finished: 1, failed: 9 } }),
      slot({ workerId: 'steady', name: 'b', track: { finished: 9, failed: 1 } }),
    ]);
    expect(record.slot?.workerId).toBe('steady');
  });
});

describe('the result: a merged pull request is not the improvement', () => {
  const unknown = { effect: 'UNKNOWN' as const, reasons: [] };
  it('reads a merge without measurement as DELIVERED_UNMEASURED', () => {
    const j = judgeEngineering({ started: true, factoryStatus: 'LIVE', merged: true, deployed: true, verified: true, measurement: null, decision: null, goal: unknown });
    expect(j.status).toBe('DELIVERED_UNMEASURED');
    expect(j.next).toBe('WAIT');
  });
  it('is RESOLVED only when the metric improved and the change was kept; a goal that did not move asks for a new strategy', () => {
    const moved = { effect: 'IMPROVED' as const, reasons: ['no longer waiting on a person'] };
    expect(judgeEngineering({ started: true, factoryStatus: 'LIVE', merged: true, deployed: true, verified: true, measurement: 'IMPROVED', decision: 'KEPT', goal: moved })).toMatchObject({ status: 'RESOLVED', next: 'DONE' });
    expect(judgeEngineering({ started: true, factoryStatus: 'LIVE', merged: true, deployed: true, verified: true, measurement: 'IMPROVED', decision: 'KEPT', goal: { effect: 'UNCHANGED', reasons: [] } }).next).toBe('CHANGE_STRATEGY');
    expect(judgeEngineering({ started: true, factoryStatus: 'LIVE', merged: true, deployed: true, verified: true, measurement: 'NO_CHANGE', decision: 'KEPT_NO_EFFECT', goal: unknown })).toMatchObject({ status: 'NOT_RESOLVED', next: 'NEW_ATTEMPT' });
  });
  it('compares the goal against the reading taken when the work was commissioned', () => {
    const mark = (over: Partial<GoalMark>): GoalMark => ({ at: 'x', state: 'BLOCKED', waitingOn: 'PERSON: decide', settledCents: 0, blockers: 66, verdict: 'NOT_VIABLE', bestReachCents: 325_000, ladderAdvanced: 1, mootRequests: 1, ...over });
    expect(compareGoal(mark({}), mark({ waitingOn: 'BRAIN: research', mootRequests: 0, state: 'ACTIVE' })).effect).toBe('IMPROVED');
    expect(compareGoal(mark({}), mark({})).effect).toBe('UNCHANGED');
    expect(compareGoal(null, mark({})).effect).toBe('UNKNOWN');
  });
});

describe('the operator is continued by an outcome, and given the tools', () => {
  it('starts early for an engineering outcome it has not seen, never inside the boot grace or a running run', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const last = new Date(now - 15 * 60_000).toISOString();
    expect(operatorDue({ lastStartedAt: last, running: false, nowMs: now, intervalMinutes: 60 })).toBe(false);
    expect(operatorDue({ lastStartedAt: last, running: false, nowMs: now, intervalMinutes: 60, outcomeWaiting: true })).toBe(true);
    expect(operatorDue({ lastStartedAt: last, running: true, nowMs: now, intervalMinutes: 60, outcomeWaiting: true })).toBe(false);
    expect(operatorDue({ lastStartedAt: last, running: false, nowMs: now, intervalMinutes: 60, outcomeWaiting: true, processStartedMs: now - 60_000 })).toBe(false);
  });
  it('offers the director tools by name, and every one is registered', () => {
    for (const name of ['brain_operator_deficiencies', 'brain_operator_commission', 'brain_operator_engineering', 'brain_operator_prioritize_engineering']) {
      expect(OPERATOR_TOOL_NAMES).toContain(name);
      expect(findTool(name)).toBeTruthy();
    }
    expect(operatorBrief({ nowIso: 'now', runId: 'opr_x', engineering: 'ENGINEERING YOU COMMISSIONED' })).toContain('ENGINEERING YOU COMMISSIONED');
  });
});

describe('commissioning on real rows', () => {
  let brainId = '';
  beforeEach(async () => {
    submitted.length = 0;
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setProjectRepository({ projectId: brainId, grantId: 'brain', repositoryId: 'peyday007/v5', scopeKind: 'WHOLE_REPOSITORY', pathScope: [], reason: 'test', setBy: 'test' });
    await setImprovementSwitch(true, 'owner@example.com', 'test');
  });

  const request = (over: Record<string, unknown> = {}) => ({
    goalId: null,
    deficiency: 'RECURRING_OPERATIONAL_FAILURE',
    title: 'Moot cards reopen and hold the goal on a person',
    observed: 'The goal reads BLOCKED on a person while every open card is moot: no answer can apply to any of them.',
    evidence: 'rhr_1: mission DONE, packet COMPLETE_WITH_GAPS; rhr_2: mission DONE',
    cause: "answered-requests reopens a card whose mission already left NEEDS_HUMAN, so no answer can ever apply",
    ownerPaths: ['server/services/russell/needsHuman.ts'],
    recurrence: 4,
    expectedBenefit: 'The goal leads with Brain work instead of a person.',
    acceptance: 'A test shows a moot answered card is withdrawn, not reopened.',
    metric: 'OWNER_INTERVENTIONS_PER_DAY',
    blocksGoal: true,
    share: 0.3,
    proposed: null,
    runId: 'opr_test',
    ...over,
  });

  it('admits engineering to Factory at once, with the directive in the objective, and once only', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const first = await commission(request());
    expect(first).toMatchObject({ ok: true, intervention: 'ENGINEERING', duplicate: false });
    expect(first.campaignId).toBe('fcp_for_fcr_test1');
    expect(first.reason).toContain('Acknowledged');
    expect(submitted).toHaveLength(1);
    const objective = String(submitted[0]!['objective']);
    expect(objective).toContain("Commissioned by Brain's operator (run opr_test)");
    expect(objective).toContain('Expected benefit');
    expect(objective).toContain('How its real effect is judged');
    expect(objective).toContain('server/services/russell/needsHuman.ts');
    const conditions = submitted[0]!['acceptanceConditions'] as { statement: string }[];
    expect(conditions.some((c) => c.statement.includes('withdrawn, not reopened'))).toBe(true);
    const candidate = (await getCandidate(first.candidateId!))!;
    expect(candidate.evidence['directive']).toMatchObject({ origin: 'OPERATOR', intervention: 'ENGINEERING', runId: 'opr_test' });
    expect(candidate.campaignId).toBe('fcp_for_fcr_test1');

    // The same defect named again reaches the same campaign: no second objective.
    const again = await commission(request({ runId: 'opr_test2' }));
    expect(again).toMatchObject({ ok: true, duplicate: true, campaignId: 'fcp_for_fcr_test1' });
    expect(submitted).toHaveLength(1);
    expect((await listCandidates()).filter((c) => c.evidence['directive'])).toHaveLength(1);
    const events = await getDb().all<{ event_type: string }>("SELECT event_type FROM project_events WHERE event_type LIKE 'OPERATOR_%'", []);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['OPERATOR_INTERVENTION_DECIDED', 'OPERATOR_ENGINEERING_COMMISSIONED']));
  });

  it('reorders only the campaign\'s waiting bins, never leased work', async () => {
    const { commission, applyPriority } = await import('../server/services/operator/director.ts');
    const first = await commission(request());
    const now = new Date().toISOString();
    const worker = await createWorker({ name: 'test-worker', displayName: 'Test', description: 'test', createdByType: 'SYSTEM', createdById: 'test' });
    for (const [id, state] of [['bin_wait', 'READY'], ['bin_busy', 'LEASED']] as const) {
      await getDb().run(
        `INSERT INTO bins (id, project_id, kind, title, objective, completion_contract, state, priority, created_by_type, created_by_id, factory_campaign_id, created_at, updated_at,
                           lease_id, worker_id, lease_expires_at)
         VALUES (?, ?, 'FACTORY_PLAN', 't', 'o', 'FACTORY_PLAN_V1', ?, 5, 'SYSTEM', 'test', ?, ?, ?, ?, ?, ?)`,
        [id, brainId, state, first.campaignId, now, now, ...(state === 'LEASED' ? ['lease_1', worker.id, now] : [null, null, null])],
      );
    }
    await applyPriority(first.campaignId!, 9);
    const after = await getDb().all<{ id: string; priority: number }>('SELECT id, priority FROM bins WHERE factory_campaign_id = ? ORDER BY id', [first.campaignId]);
    expect(after).toEqual([{ id: 'bin_busy', priority: 5 }, { id: 'bin_wait', priority: 9 }]);
  });

  it('does not send a problem without an established cause to Factory', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const result = await commission(request({ cause: null, proposed: 'ENGINEERING' }));
    expect(result.intervention).toBe('EVIDENCE');
    expect(result.overruled).toContain('proposed ENGINEERING');
    expect(submitted).toHaveLength(0);
  });

  it('records a strategy or model remedy as a lesson, not a coding assignment', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const result = await commission(request({ proposed: 'STRATEGY' }));
    expect(result).toMatchObject({ ok: true, intervention: 'STRATEGY' });
    expect(submitted).toHaveLength(0);
    const lessons = await getDb().all<{ lesson: string }>('SELECT lesson FROM operator_learnings', []);
    expect(lessons[0]?.lesson).toContain('STRATEGY');
  });

  it('delivers the outcome back, and never counts a merge as the improvement', async () => {
    const { commission, engineeringOutcomes, directorPass, unseenOutcomeSince } = await import('../server/services/operator/director.ts');
    const before = new Date(Date.now() - 1000).toISOString();
    const first = await commission(request());
    const outcomes = await engineeringOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ candidateId: first.candidateId, intervention: 'ENGINEERING' });
    const pass = await directorPass();
    expect(pass.recorded).toBe(1);
    expect((await directorPass()).recorded).toBe(0);
    // A delivered candidate is DELIVERED_UNMEASURED until the loop measures it.
    await getDb().run('UPDATE improvement_candidates SET delivered_at = ?, delivered_ref = ? WHERE id = ?', [new Date().toISOString(), 'abc123', first.candidateId]);
    const delivered = (await engineeringOutcomes())[0]!;
    expect(delivered.status).toBe('DELIVERED_UNMEASURED');
    expect(delivered.sentence).toContain('A merge is not proof');
    expect((await directorPass()).wake).toBe(1);
    expect(await unseenOutcomeSince(before)).toBe(true);
  });

  it('composes a detector\'s objective exactly as before: no directive, no routing marker', () => {
    const spec = composeObjective(
      {
        id: 'imp_1', weaknessKey: 'FREE_LANE:X', kind: 'FREE_LANE', title: 't', problem: 'p', metric: 'FREE_LANE_PASS_RATE', downstreamMetric: null,
        ownerComponent: 'server/services/freeLane/x.ts', frequency: 20, denominator: 100, scope: 'GENERAL', severity: 'HIGH', evidence: { samples: [] },
        proposal: null, dependencyCheck: null, researchGoalId: null, changeRequestId: null, campaignId: null, deliveredAt: null, deliveredRef: null,
        baseline: null, result: null, decision: null, decisionReason: null, combinedIntoId: null, heldOn: null, attempt: 1, parentId: null, createdAt: 'x', updatedAt: 'x',
      },
      { research: null, factory: null, archive: [] },
      [],
      { key: 'FREE_LANE_PASS_RATE', from: 'a', to: 'b', value: 0.5, numerator: 1, denominator: 2, status: 'MEASURED', context: {} } as never,
    );
    expect(spec.objective).not.toContain('Commissioned by');
    expect(spec.objective).not.toContain(ROUTING_MARKER);
    expect(spec.acceptanceConditions).toHaveLength(2);
  });
});
