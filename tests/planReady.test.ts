/**
 * The owner is told the moment a cash goal has a viable, actionable plan (owner, 2026-11-13) —
 * never for a plan document or an optimistic forecast, and without waiting for the money.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordEvent } from '../server/repos/events.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { planReady, planReadyNotice, type PlanReadyFacts } from '../server/domain/planReady.ts';
import { HIGH_IMPACT_KINDS, DECISION_KINDS } from '../server/domain/decision.ts';
import { operatorBrief } from '../server/domain/operator.ts';
import type { PlanReading } from '../server/services/goals/plan.ts';

function facts(over: Partial<PlanReadyFacts> = {}): PlanReadyFacts {
  const member = {
    opportunityId: 'opp_1',
    title: 'Website audits for dental practices',
    revenue: { p10: 6000, p50: 9000, p90: 12000 },
    price: { p50: 1500 },
    deals: { p50: 6 },
    spend: { p50: 300 },
    days: { p50: 18, p90: 26 },
    capitalAtStart: 0,
    justified: true,
    unestablished: [],
  };
  return {
    goalId: 'goal_10k',
    goalTitle: 'Collect $10,000 in 30 days',
    targetAmount: 10000,
    remainingAmount: 10000,
    currency: 'USD',
    daysLeft: 30,
    achieved: false,
    verdict: 'RECOMMENDABLE',
    acceptance: {
      status: 'ACCEPTED',
      required: 0.9,
      probability: { value: 0.94, lowerBound: 0.92, basis: 'EVIDENCED_PORTFOLIO', sample: 2000, note: 'every input on evidence; Wilson lower bound over 2000 worlds' },
      accepted: { label: 'Dental audits + agency referrals', opportunityIds: ['opp_1', 'opp_2'] },
      sentence: 'ACCEPTED: the combination reaches the target in 94% of 2000 worlds, lower bound 92%.',
    },
    summary: 'Two evidenced offers sold through the owner’s Instantly workspace reach the target.',
    portfolio: { basis: 'PROBABILITY', worlds: 2000, reach: 0.94, settledP10: 10400, settledP50: 13800, settledP90: 17500, correlation: 0.3, missing: [] },
    members: [member, { ...member, opportunityId: 'opp_2', title: 'Agency referral retainers', revenue: { p10: 2500, p50: 4800, p90: 7000 } }],
    steps: [{ title: 'Website audits for dental practices', step: 'Send the audit offer to the 400 verified practices', by: 'BRAIN', blocker: null }],
    hermes: {
      decisionId: 'opd_1',
      committedAt: '2026-11-13T10:00:00.000Z',
      chosenAction: 'Execute the accepted plan as it stands',
      adopted: true,
      challenge: { verdict: 'PROCEED', model: 'qwen', reasons: 'Evidence holds; reply rate is measured.', hiddenAssumptions: ['buyers pay within 30 days'], missingVariables: [], strongerAlternative: null },
      answeredChallenge: null,
      prediction: { outcome: '$10,000 collected by the deadline', probability: 0.9, horizonDays: 30 },
    },
    acceptedSince: '2026-11-13T09:00:00.000Z',
    capitalCeiling: 3000,
    ...over,
  };
}

const failing = (f: PlanReadyFacts) => Object.entries(planReady(f).conditions).filter(([, why]) => why).map(([c]) => c);

describe('a plan qualifies only on every condition the owner named', () => {
  it('qualifies when the accepted, evidenced, challenged and adopted plan is complete', () => {
    expect(planReady(facts()).ready).toBe(true);
  });

  it('never on a candidate or an optimistic forecast: §95 acceptance and an evidenced probability are required', () => {
    expect(failing(facts({ verdict: 'NEEDS_EVIDENCE', acceptance: { ...facts().acceptance, status: 'CANDIDATE_ONLY' } }))).toContain('PASSED_PLANNING_AND_EVIDENCE_REQUIREMENTS');
    expect(failing(facts({ portfolio: { ...facts().portfolio!, basis: 'COVERAGE' } }))).toContain('EVIDENCE_FOR_ASSUMPTIONS');
    expect(failing(facts({ acceptance: { ...facts().acceptance, probability: { ...facts().acceptance.probability!, lowerBound: 0.85 } } }))).toContain('DEFENSIBLE_UNCERTAINTY');
    const unjustified = facts();
    unjustified.members[0] = { ...unjustified.members[0]!, justified: false, unestablished: ['close'] };
    expect(failing(unjustified)).toEqual(['EVIDENCE_FOR_ASSUMPTIONS']);
  });

  it('does not require the money to have been earned, and a target already met is not a plan to report', () => {
    expect(facts().achieved).toBe(false);
    expect(planReady(facts()).ready).toBe(true);
    expect(failing(facts({ achieved: true }))).toEqual(['PASSED_PLANNING_AND_EVIDENCE_REQUIREMENTS']);
    expect(failing(facts({ acceptance: { ...facts().acceptance, probability: { ...facts().acceptance.probability!, basis: 'TARGET_MET' } } }))).toContain('EVIDENCE_FOR_ASSUMPTIONS');
  });

  it('needs named sources, quantified economics on a realistic timeline, resources and steps, and a combination that reaches the target', () => {
    expect(failing(facts({ acceptance: { ...facts().acceptance, accepted: null } }))).toContain('STRATEGIES_AND_SOURCES');
    const late = facts();
    late.members[1] = { ...late.members[1]!, days: { p50: 41, p90: 55 } };
    expect(failing(late)).toEqual(['QUANTIFIED_ECONOMICS_AND_TIMELINES']);
    const unpriced = facts();
    unpriced.members[0] = { ...unpriced.members[0]!, price: null };
    expect(failing(unpriced)).toContain('QUANTIFIED_ECONOMICS_AND_TIMELINES');
    expect(failing(facts({ steps: [] }))).toEqual(['RESOURCES_DEPENDENCIES_STEPS']);
    expect(failing(facts({ portfolio: { ...facts().portfolio!, settledP50: 8000 } }))).toEqual(['WHY_THE_COMBINATION_REACHES_TARGET']);
  });

  it('needs Hermes to have challenged and adopted this plan, after it was accepted', () => {
    const h = facts().hermes!;
    expect(failing(facts({ hermes: null }))).toEqual(['CHALLENGED_BY_HERMES']);
    expect(failing(facts({ hermes: { ...h, challenge: null } }))).toEqual(['CHALLENGED_BY_HERMES']);
    expect(failing(facts({ hermes: { ...h, challenge: { ...h.challenge!, verdict: 'REVISE' } } }))).toEqual(['CHALLENGED_BY_HERMES']);
    expect(planReady(facts({ hermes: { ...h, challenge: { ...h.challenge!, verdict: 'REVISE' }, answeredChallenge: 'The reply rate is measured, not assumed.' } })).ready).toBe(true);
    expect(failing(facts({ hermes: { ...h, adopted: false, chosenAction: 'Keep constructing' } }))).toEqual(['CHALLENGED_BY_HERMES']);
    expect(failing(facts({ hermes: { ...h, committedAt: '2026-11-13T08:00:00.000Z' } }))).toEqual(['CHALLENGED_BY_HERMES']);
  });
});

describe('the starting capital', () => {
  it('qualifies only when the plan commits no more than $3,000 before revenue, or the goal\'s lower ceiling', () => {
    expect(planReady(facts()).ready).toBe(true); // 2 × (0 + 300) = 600
    const heavy = facts();
    heavy.members[0] = { ...heavy.members[0]!, capitalAtStart: 2800 };
    expect(failing(heavy)).toEqual(['STARTING_CAPITAL_WITHIN_LIMIT']); // 2800 + 300 + 300 = 3400
    expect(failing(facts({ capitalCeiling: 500 }))).toEqual(['STARTING_CAPITAL_WITHIN_LIMIT']);
    expect(planReady(facts({ capitalCeiling: 10_000 })).ready).toBe(true); // the owner's $3,000 still binds
  });
});

describe('the completion response', () => {
  it('begins with the owner\'s header and carries the plan, the capital, the economics, the evidence and the next steps', () => {
    const { subject, text } = planReadyNotice(facts());
    expect(subject).toBe('$10K / 30-DAY PLAN — COMPLETE');
    expect(text.startsWith('$10K / 30-DAY PLAN — COMPLETE\n')).toBe(true);
    for (const section of ['THE ACTUAL PLAN', 'HOW THE $3,000 IS ALLOCATED', 'HOW THE PLAN GENERATES $10,000', 'SUPPORTING EVIDENCE AND CONFIDENCE', 'WHAT BRAIN IS EXECUTING NEXT']) {
      expect(text).toContain(section);
    }
    expect(text).toContain('Website audits for dental practices: $0 at start + $300 median spend.');
    expect(text).toContain('Committed before revenue: $600 of $3,000; held in reserve: $2,400.');
    expect(text).toContain('Website audits for dental practices: $9,000 median ($6,000–$12,000).');
    expect(text).toContain('Combined: $13,800 median settled');
    expect(text).toContain('defensible lower bound 92% (Brain requires 90%)');
    expect(text).toContain('Challenger (qwen): PROCEED');
    expect(text).toContain('Send the audit offer to the 400 verified practices');
    expect(text).toContain('Brain and Hermes keep executing and improving the plan');
  });
});

describe('Hermes is given the means and the instruction to challenge an accepted plan', () => {
  it('ADOPT_PLAN is a decision kind the challenger always reviews, and the brief asks for it', () => {
    expect(DECISION_KINDS).toContain('ADOPT_PLAN');
    expect(HIGH_IMPACT_KINDS).toContain('ADOPT_PLAN');
    const brief = operatorBrief({ nowIso: '2026-11-13T00:00:00Z', runId: 'opr_x' });
    expect(brief).toContain('ADOPT_PLAN');
    expect(brief).toContain('forecast.acceptance.status is ACCEPTED');
  });
});

/* ------------------------------------------------------------------------- */
/* On real rows: the service, the decision record and the Instantly send      */
/* ------------------------------------------------------------------------- */

describe('the completion response waits for the owner\'s conversation, once per accepted plan, and nothing is sent anywhere', () => {
  let projectId = '';
  let goalId = '';
  const outbound = vi.fn();

  function reading(over: { status?: string; ids?: string[]; achieved?: boolean } = {}): PlanReading {
    const f = facts();
    const ids = over.ids ?? ['opp_1', 'opp_2'];
    const spread = (p50: number) => ({ p10: p50 * 0.7, p50, p90: p50 * 1.3 });
    return {
      goalId,
      verdict: over.status && over.status !== 'ACCEPTED' ? 'NEEDS_EVIDENCE' : 'RECOMMENDABLE',
      summary: f.summary,
      acceptance: {
        status: (over.status ?? 'ACCEPTED') as 'ACCEPTED',
        required: 0.9,
        probability: over.status && over.status !== 'ACCEPTED' ? null : f.acceptance.probability,
        accepted: over.status && over.status !== 'ACCEPTED' ? null : { label: f.acceptance.accepted!.label, opportunityIds: ids },
        candidate: null,
        shortfalls: [],
        sentence: f.acceptance.sentence,
      },
      portfolio: {
        basis: 'PROBABILITY',
        worlds: 2000,
        best: { members: ids.map((id, i) => ({ opportunityId: id, title: `Offer ${i + 1}`, share: 0.5 })), reach: 0.94, settledP10: 10400, settledP50: 13800, settledP90: 17500, capitalShort: 0, overSpend: 0 },
        alternatives: [],
        demand: ids.map((id, i) => ({
          opportunityId: id, title: `Offer ${i + 1}`, repeatable: true,
          contacted: spread(400), interested: spread(20), deals: spread(4), revenue: spread(7000), spend: spread(200), days: spread(16), price: spread(1500), respond: spread(0.05), close: spread(0.2),
          capitalAtStart: 0, justified: true, unestablished: [], refused: null,
        })),
        limits: { target: 10000, deadlineDays: 30, startingCapital: 3000, perArrangement: null, spendCeiling: null, contactsPerDay: { value: 100, low: 80, high: 120, source: 'workspace' }, correlation: 0.3 },
        missing: [],
        searched: 4,
      },
      sales: [{ opportunityId: ids[0]!, title: 'Offer 1', potentialReach: 7000, test: { link: 'CONVERSION', test: 'Send the offer to the verified buyers', by: 'BRAIN', blocker: null } }],
      nextTest: null,
      target: { metric: 'COLLECTED_REVENUE', metricLabel: 'collected revenue', currency: 'USD', projectId, targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000, achieved: over.achieved ?? false, daysLeft: 30, capitalCeilingCents: 300_000 },
    } as unknown as PlanReading;
  }

  async function hermesAdopts(goal: string, chosen = 0): Promise<void> {
    // Decisions are minutes apart in production; here the next one must not share a millisecond with the last.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: `opd_${Math.random().toString(16).slice(2, 10)}`,
      eventType: 'OPERATOR_DECISION',
      payload: {
        input: {
          kind: 'ADOPT_PLAN',
          goalId: goal,
          question: 'Adopt the accepted $10K plan?',
          options: [{ action: 'Execute the accepted plan as it stands' }, { action: 'Keep constructing' }],
          chosen,
          prediction: { outcome: '$10,000 collected by the deadline', probability: 0.9, horizonDays: 30 },
        },
        challenge: { verdict: 'PROCEED', model: 'qwen', reasons: 'The evidence holds.', hiddenAssumptions: [], missingVariables: [], strongerAlternative: null },
        committedAt: new Date().toISOString(),
      },
    });
  }

  function worker(scopes: string[], project = projectId) {
    return {
      type: 'WORKER', id: 'wkr_conversation', handle: 'worker-05', displayName: 'worker-05', isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'cred_x', authMethod: 'OAUTH_BEARER', requestId: 'req_x',
      memberships: [{ projectId: project, principalType: 'WORKER', principalId: 'wkr_conversation', role: null, scopes, active: true }],
    } as unknown as import('../server/domain/types.ts').Principal;
  }

  async function tool(name: string, args: Record<string, unknown>, principal: ReturnType<typeof worker>): Promise<Record<string, unknown>> {
    const { findTool } = await import('../server/mcp/tools.ts');
    return (await findTool(name)!.run(args, { principal } as never)).value as Record<string, unknown>;
  }

  beforeEach(async () => {
    outbound.mockReset();
    ({ project: { id: projectId } } = await freshProject());
    goalId = (await createWorkstream({ projectId, title: 'Collect $10,000 in 30 days', intent: 'Collect $10,000 in 30 days', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    // Instantly stays configured for outreach; the owner's notice must never reach it or any network.
    vi.stubEnv('INSTANTLY_API_KEY', 'instantly-test-key');
    vi.stubGlobal('fetch', outbound);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('records nothing for a candidate or before Hermes adopts it, then one completion response the conversation reads and marks delivered', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    const reader = worker(['project:read', 'checkpoints:write']);
    expect((await notifyPlanReady(goalId, reading({ status: 'CANDIDATE_ONLY' }))).status).toBe('NOT_READY');
    const before = await notifyPlanReady(goalId, reading());
    expect(before.status).toBe('NOT_READY');
    expect(before.detail).toMatch(/CHALLENGED_BY_HERMES/);
    await hermesAdopts(goalId, 1);
    expect((await notifyPlanReady(goalId, reading())).detail).toMatch(/not to adopt/);
    expect(await tool('brain_owner_notices', { project_id: projectId }, reader)).toEqual({ notices: [] });

    await hermesAdopts(goalId, 0);
    expect((await notifyPlanReady(goalId, reading())).status).toBe('RECORDED');
    const { notices } = (await tool('brain_owner_notices', { project_id: projectId }, reader)) as { notices: { noticeId: string; kind: string; text: string }[] };
    expect(notices).toHaveLength(1);
    expect(notices[0]!.kind).toBe('PLAN_READY');
    expect(notices[0]!.text.startsWith('$10K / 30-DAY PLAN — COMPLETE')).toBe(true);
    for (const section of ['THE ACTUAL PLAN', 'HOW THE $3,000 IS ALLOCATED', 'HOW THE PLAN GENERATES $10,000', 'SUPPORTING EVIDENCE AND CONFIDENCE', 'WHAT BRAIN IS EXECUTING NEXT']) {
      expect(notices[0]!.text).toContain(section);
    }

    // Announced in the conversation: recorded once, and never offered again.
    const delivered = await tool('brain_owner_notice_delivered', { project_id: projectId, notice_id: notices[0]!.noticeId, where: 'session_test' }, reader);
    expect(delivered['deliveredAt']).toBeTruthy();
    expect(await tool('brain_owner_notice_delivered', { project_id: projectId, notice_id: notices[0]!.noticeId, where: 'session_test' }, reader)).toEqual(delivered);
    expect(await tool('brain_owner_notices', { project_id: projectId }, reader)).toEqual({ notices: [] });
    expect((await notifyPlanReady(goalId, reading())).status).toBe('ALREADY_RECORDED');
    expect(await tool('brain_owner_notices', { project_id: projectId }, reader)).toEqual({ notices: [] });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('refuses a reader outside the project, and a delivery receipt without checkpoints:write, as not found', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    await hermesAdopts(goalId, 0);
    await notifyPlanReady(goalId, reading());
    const { notices } = (await tool('brain_owner_notices', { project_id: projectId }, worker(['project:read']))) as { notices: { noticeId: string }[] };
    await expect(tool('brain_owner_notices', { project_id: projectId }, worker(['project:read'], 'prj_other'))).rejects.toThrow();
    await expect(tool('brain_owner_notice_delivered', { project_id: projectId, notice_id: notices[0]!.noticeId, where: 'x' }, worker(['project:read']))).rejects.toThrow();
    expect(await tool('brain_owner_notices', { project_id: projectId }, worker(['project:read']))).toEqual({ notices });
  });

  it('leaves the goal running: Brain and Hermes keep executing and improving the plan after it is announced', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    const { getWorkstream } = await import('../server/repos/register.ts');
    const before = await getWorkstream(goalId);
    await hermesAdopts(goalId, 0);
    expect((await notifyPlanReady(goalId, reading())).status).toBe('RECORDED');
    const after = await getWorkstream(goalId);
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    const events = await getDb().all<{ kind: string }>(`SELECT kind FROM workstream_events WHERE workstream_id = ?`, [goalId]);
    expect(events.map((e) => e.kind)).toEqual(['OWNER_NOTIFIED_PLAN_READY']);
    expect(operatorBrief({ nowIso: '2026-11-13T00:00:00Z', runId: 'opr_x' })).toContain('execution and improvement continue afterwards');
  });

  it('announces a different accepted plan on its own, and the self-improvement notice stays a separate kind', async () => {
    const { notifyPlanReady, planReadyKey } = await import('../server/services/goals/planReady.ts');
    await hermesAdopts(goalId, 0);
    await notifyPlanReady(goalId, reading());
    await hermesAdopts(goalId, 0);
    expect((await notifyPlanReady(goalId, reading({ ids: ['opp_3', 'opp_4'] }))).status).toBe('RECORDED');
    const { notices } = (await tool('brain_owner_notices', { project_id: projectId }, worker(['project:read']))) as { notices: { kind: string }[] };
    expect(notices.map((n) => n.kind)).toEqual(['PLAN_READY', 'PLAN_READY']);
    expect(planReadyKey(goalId, ['opp_2', 'opp_1'])).toBe(planReadyKey(goalId, ['opp_1', 'opp_2']));
    expect(planReadyKey(goalId, ['opp_1'])).toMatch(/^plan-ready\.wst_[0-9a-f]+\.[0-9a-f]{16}$/);
  });
});
