/**
 * The operator's decisions, allocation and model choice (§108).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { reviewDecision, parseChallenge, type DecisionInput } from '../server/domain/decision.ts';
import { allocate, type Activity } from '../server/domain/allocation.ts';
import { rankOperatorModels, type OperatorModel } from '../server/domain/operator.ts';
import { decide, openDecisions, operatorCalibration, setGoalFocus, verify } from '../server/services/operator/decisions.ts';
import { activityFrom } from '../server/services/operator/allocation.ts';

const base: DecisionInput = {
  kind: 'RESEARCH',
  goalId: null,
  question: 'Which opening gets the next research round?',
  options: [
    { action: 'Price the HVAC supplier arrangement', probability: 0.3, valueUsd: 4000, costUsd: 5, evidence: ['arr_2d0bae0f1074'] },
    { action: 'Do nothing', probability: 1, valueUsd: 0, costUsd: 0, evidence: [] },
  ],
  chosen: 0,
  assumptions: ['owners answer cold email at 1%'],
  whyNotHighestEv: null,
  prediction: { outcome: 'the opening carries a price buyers are shown to pay', probability: 0.4, horizonDays: 2 },
  irreversible: false,
};

describe('decision review', () => {
  it('accepts a decision with real alternatives, assumptions and a checkable prediction', () => {
    const r = reviewDecision(base);
    expect(r.ok).toBe(true);
    expect(r.options[0]!.expectedValueUsd).toBe(1195);
    expect(r.bestByEv).toBe(0);
    expect(r.highImpact).toBe(true); // $4,000 at stake
  });
  it('refuses a choice of one, unnamed assumptions, and a lower-EV choice without a reason', () => {
    const one = reviewDecision({ ...base, options: [base.options[0]!, { ...base.options[0]!, action: 'price  the HVAC supplier arrangement' }] });
    expect(one.problems.join(' ')).toMatch(/two meaningfully different/);
    expect(reviewDecision({ ...base, assumptions: [] }).problems.join(' ')).toMatch(/assumptions/);
    const low = reviewDecision({ ...base, chosen: 1 });
    expect(low.problems.join(' ')).toMatch(/higher expected value/);
    expect(reviewDecision({ ...base, chosen: 1, whyNotHighestEv: 'the test result is worth more than the cash' }).ok).toBe(true);
  });
  it('reads a challenger answer only in its own shape', () => {
    expect(parseChallenge({ verdict: 'revise', hidden_assumptions: ['x'], stronger_alternative: 'null', reasons: 'r' }, 'm')).toMatchObject({ verdict: 'REVISE', strongerAlternative: null });
    expect(parseChallenge({ verdict: 'maybe' }, 'm')).toBeNull();
  });
});

describe('allocation by marginal value', () => {
  const act = (over: Partial<Activity>): Activity => ({
    id: 'a', title: 'a', stakeUsd: 10000, reach: 0.2, reachIsProbability: false, evidenceLevel: 1, daysToCash: null, daysLeft: 27,
    unitsUsed: 40, unitsProductive: 20, reachDelta: null, executable: true, committed: false, paused: false, ...over,
  });
  it('is not equal: the activity whose capacity buys more gets more, and a barren one is paused', () => {
    const out = allocate([
      act({ id: 'cash' }),
      act({ id: 'side', stakeUsd: null, unitsUsed: 30, unitsProductive: 0, reachDelta: 0 }),
    ]);
    expect(out[0]!.id).toBe('cash');
    expect(out[0]!.stance).toBe('EXPAND');
    expect(out.find((x) => x.id === 'side')!.stance).toBe('PAUSE');
    expect(out[0]!.share).toBeGreaterThan(0.99);
  });
  it('never pauses a committed goal, and restarts a paused one whose reading is worth it', () => {
    const out = allocate([act({ id: 'owed', committed: true, stakeUsd: null, unitsProductive: 0 }), act({ id: 'back', paused: true }), act({ id: 'cash' })]);
    expect(out.find((x) => x.id === 'owed')!.stance).toBe('REDUCE');
    expect(out.find((x) => x.id === 'back')!.stance).toBe('RESTART');
  });
  it('reads an activity from the plan reading it was given', () => {
    const a = activityFrom({
      goal: { id: 'g', title: 't', commitment: 'NONE', pausedAt: null, dueAt: null, target: null },
      latest: { forecast: { remainingCents: 1000000, reach: 0.0145, daysLeft: 27, ladder: { B_EVIDENCED: 30, C_MARKET_TEST_READY: 1 }, acceptance: { candidate: { reachBasis: 'COVERAGE' } } }, createdAt: 'x' },
      before: { forecast: { reach: 0.03 }, createdAt: 'y' },
      jobs: 76,
      productive: 81,
      executable: true,
      nowMs: 0,
    });
    expect(a).toMatchObject({ stakeUsd: 10000, evidenceLevel: 2, reachIsProbability: false, daysLeft: 27 });
    expect(a.reachDelta).toBeCloseTo(-0.0155);
  });
});

describe('operator model order', () => {
  const m = (label: string): OperatorModel => ({ label, baseUrl: 'x', model: label, apiKey: null });
  it('follows what each model did, not the list order', () => {
    const record = new Map([['free:brain-a', { runs: 9, ok: 0 }], ['gpu:x', { runs: 1, ok: 1 }]]);
    expect(rankOperatorModels([m('free:brain-a'), m('gpu:x')], record).map((x) => x.label)).toEqual(['gpu:x', 'free:brain-a']);
    expect(rankOperatorModels([m('free:brain-a'), m('gpu:x')], new Map()).map((x) => x.label)).toEqual(['free:brain-a', 'gpu:x']);
    expect(rankOperatorModels([m('free:brain-a'), m('gpu:x')], new Map(), new Map([['gpu:x', 1]])).map((x) => x.label)).toEqual(['gpu:x', 'free:brain-a']);
  });
});

describe('decide, verify, move capacity (against the database)', () => {
  let projectId: string;
  let goalId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    goalId = (await createWorkstream({ projectId, title: 'Side research goal', intent: 'x', purpose: 'LONG_TERM', createdByUserId: null })).id;
  });
  const ctx = () => ({ runId: 'opr_t', projectIds: [projectId], models: [] });

  it('commits a decision as a ledger prediction, then judges it once with its cause', async () => {
    const d = await decide({ ...base, goalId }, ctx());
    expect(d.verdict).toBe('COMMITTED');
    expect((await openDecisions()).map((x) => x.id)).toContain(d.decisionId);
    const v = await verify({ decisionId: d.decisionId!, occurred: false, evidence: 'goal_plan_readings at 2026-11-14: no price', signals: { assumptionBroke: true } }, ctx());
    expect(v).toMatchObject({ ok: true, judged: 1, comparableKey: 'operator:RESEARCH', missCauses: { CHANGED_CONDITIONS: 1 } });
    expect(String(v['reading'])).toMatch(/too few/);
    expect((await verify({ decisionId: d.decisionId!, occurred: true, evidence: 'again' }, ctx()))['ok']).toBe(false);
    expect(await openDecisions()).toHaveLength(0);
  });

  it('refuses a decision about a goal outside the projects it directs', async () => {
    const d = await decide({ ...base, goalId }, { ...ctx(), projectIds: ['prj_other'] });
    expect(d.verdict).toBe('REFUSED');
  });

  it('pauses a goal only under a PAUSE_GOAL decision, and never a committed one', async () => {
    expect((await setGoalFocus({ goalId, action: 'PAUSE', decisionId: 'opd_none', reason: 'r' }, ctx())).ok).toBe(false);
    const pauseDecision = await decide({ ...base, kind: 'PAUSE_GOAL', goalId, answeredChallenge: 'n/a' }, ctx());
    const paused = await setGoalFocus({ goalId, action: 'PAUSE', decisionId: pauseDecision.decisionId!, reason: 'no yield in 24h' }, ctx());
    expect(paused.ok).toBe(true);
    expect((await getWorkstream(goalId))!.pausedAt).not.toBeNull();
    await getDb().run(`UPDATE workstreams SET commitment = 'CUSTOMER', paused_at = NULL WHERE id = ?`, [goalId]);
    const again = await setGoalFocus({ goalId, action: 'PAUSE', decisionId: pauseDecision.decisionId!, reason: 'r' }, ctx());
    expect(again).toMatchObject({ ok: false });
    expect(again.reason).toMatch(/committed/);
  });

  it('calibration speaks only over enough comparable outcomes', () => {
    const preds = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, comparableKey: 'operator:X', probability: 0.9 }));
    const outs = preds.map((p, i) => ({ predictionId: p.id, occurred: i < 4 }));
    expect(String(operatorCalibration({ predictions: preds, outcomes: outs }, 'operator:X')['reading'])).toMatch(/overconfident/);
  });
});

describe('the brief holds the money line', () => {
  it('names settled cash as the only revenue and forbids an unshown probability', async () => {
    const { operatorBrief } = await import('../server/domain/operator.ts');
    const brief = operatorBrief({ nowIso: '2026-11-12T00:00:00Z', runId: 'opr_x' });
    expect(brief).toMatch(/Revenue is settled cash only: leads, forecasts, invoices and unpaid sales are not revenue/);
    expect(brief).toMatch(/Never claim a\nprobability of success the ledger has not shown|Never claim a/);
    for (const tool of ['brain_operator_allocation', 'brain_operator_decide', 'brain_operator_verify', 'brain_operator_set_goal_focus', 'brain_operator_submit_fix']) expect(brief).toContain(tool);
  });
});

describe('acting is gated on a committed decision', () => {
  it('refuses withdraw, commission and submit_fix without a decision id, and names the way past', async () => {
    const { OPERATOR_TOOLS } = await import('../server/mcp/operatorTools.ts');
    const { OPERATOR_SCOPES } = await import('../server/domain/types.ts');
    const { projectId } = await freshProject();
    const principal = {
      type: 'WORKER', id: 'wkr_operator', handle: 'operator', displayName: 'operator', isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'cred_x', authMethod: 'OAUTH_BEARER', requestId: 'req_x',
      memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_operator', role: 'MEMBER', scopes: OPERATOR_SCOPES, active: true }],
    } as unknown as import('../server/domain/types.ts').Principal;
    const tool = (name: string) => OPERATOR_TOOLS.find((t) => t.name === name)!;
    for (const [name, args] of [
      ['brain_operator_withdraw_moot_request', { request_id: 'rhr_none' }],
      ['brain_operator_commission', { deficiency_id: 'dfx_none' }],
      ['brain_operator_submit_fix', { title: 't', problem: 'p', evidence: 'e', owner_paths: ['a.ts'], acceptance: 'x' }],
    ] as const) {
      const out = (await tool(name).run({ ...args }, { principal } as never)).value as { refused?: boolean; reason?: string };
      expect(out.refused, name).toBe(true);
      expect(out.reason).toMatch(/brain_operator_decide/);
      const unknown = (await tool(name).run({ ...args, decision_id: 'dec_missing' }, { principal } as never)).value as { refused?: boolean; reason?: string };
      expect(unknown.refused, name).toBe(true);
      expect(unknown.reason).toMatch(/no committed decision/);
    }
  });
});
