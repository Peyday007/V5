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

describe('the message', () => {
  it('carries the summary, economics, evidence, confidence, the challenge and the next steps', () => {
    const { subject, text } = planReadyNotice(facts());
    expect(subject).toMatch(/viable plan to collect \$10,000 within 30 days is ready/);
    for (const section of ['THE PLAN', 'EXPECTED ECONOMICS', 'WHY THE COMBINATION REACHES THE TARGET', 'SUPPORTING EVIDENCE', 'CONFIDENCE', "HERMES' CHALLENGE", 'NEXT EXECUTION STEPS']) {
      expect(text).toContain(section);
    }
    expect(text).toContain('Website audits for dental practices: revenue $9,000 ($6,000–$12,000), price $1,500');
    expect(text).toContain('settles $13,800 median');
    expect(text).toContain('defensible lower bound 92% (required 90%)');
    expect(text).toContain('Challenger (qwen): PROCEED');
    expect(text).toContain('Send the audit offer to the 400 verified practices');
    expect(text).toContain('Nothing has been collected by this message; execution continues automatically.');
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

describe('the owner is told once per accepted plan, through the Instantly owner channel', () => {
  const sent: Record<string, unknown>[] = [];
  let projectId = '';
  let goalId = '';

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
        limits: { target: 10000, deadlineDays: 30, startingCapital: null, perArrangement: null, spendCeiling: null, contactsPerDay: { value: 100, low: 80, high: 120, source: 'workspace' }, correlation: 0.3 },
        missing: [],
        searched: 4,
      },
      sales: [{ opportunityId: ids[0]!, title: 'Offer 1', potentialReach: 7000, test: { link: 'CONVERSION', test: 'Send the offer to the verified buyers', by: 'BRAIN', blocker: null } }],
      nextTest: null,
      target: { metric: 'COLLECTED_REVENUE', metricLabel: 'collected revenue', currency: 'USD', projectId, targetCents: 1_000_000, achievedCents: 0, remainingCents: 1_000_000, achieved: over.achieved ?? false, daysLeft: 30 },
    } as unknown as PlanReading;
  }

  async function hermesAdopts(goalId: string, chosen = 0): Promise<void> {
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: `opd_${Math.random().toString(16).slice(2, 10)}`,
      eventType: 'OPERATOR_DECISION',
      payload: {
        input: {
          kind: 'ADOPT_PLAN',
          goalId,
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

  beforeEach(async () => {
    sent.length = 0;
    ({ project: { id: projectId } } = await freshProject());
    goalId = (await createWorkstream({ projectId, title: 'Collect $10,000 in 30 days', intent: 'Collect $10,000 in 30 days', purpose: 'REVENUE_DIRECT', createdByUserId: null })).id;
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    vi.stubEnv('INSTANTLY_API_KEY', 'instantly-test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (String(url).includes('/accounts')) return json({ items: [{ email: 'sender@brain.example', status: 1, warmup_status: 1 }] });
      if (String(url).endsWith('/emails/test') && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ id: `em_${sent.length}` });
      }
      return new Response('{}', { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends nothing for a candidate, nothing before Hermes adopts it, then one message — and never twice', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    expect((await notifyPlanReady(goalId, reading({ status: 'CANDIDATE_ONLY' }))).status).toBe('NOT_READY');
    const before = await notifyPlanReady(goalId, reading());
    expect(before.status).toBe('NOT_READY');
    expect(before.detail).toMatch(/CHALLENGED_BY_HERMES/);
    await hermesAdopts(goalId, 1);
    expect((await notifyPlanReady(goalId, reading())).detail).toMatch(/not to adopt/);
    expect(sent).toHaveLength(0);

    await hermesAdopts(goalId, 0);
    const told = await notifyPlanReady(goalId, reading());
    expect(told.status).toBe('SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]!['to_address_email_list']).toBe('owner@example.com');
    expect(String(sent[0]!['subject'])).toMatch(/viable plan to collect \$10,000 within 30 days is ready/);
    const body = (sent[0]!['body'] as { text: string }).text;
    for (const section of ['EXPECTED ECONOMICS', 'SUPPORTING EVIDENCE', 'CONFIDENCE', "HERMES' CHALLENGE", 'NEXT EXECUTION STEPS']) expect(body).toContain(section);

    expect((await notifyPlanReady(goalId, reading())).status).toBe('ALREADY_SENT');
    expect(sent).toHaveLength(1);
    const rows = await getDb().all<{ payload: string }>(`SELECT payload FROM project_events WHERE event_type = 'OWNER_PLAN_READY_NOTIFIED'`, []);
    expect(rows.map((r) => (JSON.parse(r.payload) as { status: string }).status).sort()).toEqual(['INTENT', 'SENT']);
  });

  it('leaves the goal running: Brain and Hermes keep executing and improving the plan after the owner is told', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    const { getWorkstream } = await import('../server/repos/register.ts');
    const before = await getWorkstream(goalId);
    await hermesAdopts(goalId, 0);
    expect((await notifyPlanReady(goalId, reading())).status).toBe('SENT');
    const after = await getWorkstream(goalId);
    // Nothing paused, archived, cancelled or rewritten: the notice only records that the owner was told.
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    const events = await getDb().all<{ kind: string }>(`SELECT kind FROM workstream_events WHERE workstream_id = ?`, [goalId]);
    expect(events.map((e) => e.kind)).toEqual(['OWNER_NOTIFIED_PLAN_READY']);
    expect(operatorBrief({ nowIso: '2026-11-13T00:00:00Z', runId: 'opr_x' })).toContain('execution and improvement continue afterwards');
  });

  it('tells the owner again only when a different plan is accepted', async () => {
    const { notifyPlanReady } = await import('../server/services/goals/planReady.ts');
    await hermesAdopts(goalId, 0);
    await notifyPlanReady(goalId, reading());
    expect(sent).toHaveLength(1);
    await hermesAdopts(goalId, 0);
    expect((await notifyPlanReady(goalId, reading({ ids: ['opp_3', 'opp_4'] }))).status).toBe('SENT');
    expect(sent).toHaveLength(2);
  });

  it('is kept apart from the self-improvement notice: its own key and its own event', async () => {
    const { planReadyKey } = await import('../server/services/goals/planReady.ts');
    expect(planReadyKey('goal_10k', ['opp_2', 'opp_1'])).toBe(planReadyKey('goal_10k', ['opp_1', 'opp_2']));
    expect(planReadyKey('goal_10k', ['opp_1'])).toMatch(/^plan-ready\.goal_10k\.[0-9a-f]{16}$/);
  });
});
