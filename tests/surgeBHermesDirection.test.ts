/**
 * Surge B, lens H: Hermes notices capability problems from rows Brain already holds (H2-3) and
 * commissions standalone research, a paused goal included (H2-6).
 *
 *   H2-3  `brain_operator_deficiencies` read only three hard-coded things. Three more detectors:
 *         (a) open inventory findings nobody owns or repairs, commissionable by id;
 *         (b) a goal plan whose missing evidence is unchanged across its last readings;
 *         (c) goal research rounds that ended without a report.
 *   H2-6  research reached Hermes only through a deficiency's EVIDENCE path and never on a paused
 *         goal. `brain_operator_commission {research_question, goal_id?}` asks it directly —
 *         research only on a paused goal, never capacity (outreach, spend).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], answer: null as null | { bucketId: string; candidateId: string; round: number } }));
vi.mock('../server/services/cash/discovery.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/cash/discovery.ts')>();
  return {
    ...original,
    openGoalDiscovery: vi.fn(async (input: Record<string, unknown>) => {
      discovery.calls.push(input);
      return discovery.answer;
    }),
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream, getWorkstream, listLinks } from '../server/repos/register.ts';
import { pause, setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { recordEvent } from '../server/repos/events.ts';
import { closeRound, openRound } from '../server/repos/cashDiscovery.ts';
import { decideCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { upsertInventory, getInventoryItem } from '../server/services/operator/inventory.ts';
import {
  commission,
  inventoryDeficiencies,
  readDeficiencies,
  readingId,
  stuckPlanDeficiencies,
  unreportedRoundDeficiencies,
} from '../server/services/operator/director.ts';
import { OPERATOR_SCOPES, type Principal } from '../server/domain/types.ts';

const uid = () => Math.random().toString(36).slice(2, 8);
const ctx = { runId: 'opr_t', actor: 'test' };

function principal(projectId: string, scopes: string[]): Principal {
  return {
    type: 'WORKER', id: 'wkr_h', handle: 'h', displayName: 'h', isBrainAdmin: false, mustChangePassword: false,
    credentialId: 'wcr_h', authMethod: 'WORKER_CREDENTIAL' as Principal['authMethod'], requestId: 'h',
    memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_h', role: null, scopes, active: true } as unknown as Principal['memberships'][number]],
  };
}

let projectId = '';
let userId = '';

async function improvementOff(): Promise<void> {
  const admin = `admin-${uid()}@example.com`;
  await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true });
  await setImprovementSwitch(false, admin, 'test: no Factory submission from this test');
}

async function cashGoal(title = 'Collect cash fast'): Promise<string> {
  const g = await createWorkstream({ projectId, title, intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId })).ok).toBe(true);
  return g.id;
}

/** A goal with no money target: the detectors read the register and the rows, not the target. */
async function plainGoal(title: string): Promise<string> {
  return (await createWorkstream({ projectId, title, intent: 'Collect settled cash within the window.', purpose: 'REVENUE_DIRECT', createdByUserId: userId })).id;
}

async function decision(): Promise<string> {
  const id = `opd_${uid()}${uid()}`;
  await recordEvent({ projectId, entityType: 'PROJECT', entityId: id, eventType: 'OPERATOR_DECISION', payload: { id, input: {}, review: {}, predictionId: 'pred_t', committedAt: new Date().toISOString() } });
  return id;
}

let readingSeq = 0;
async function planReading(goalId: string, status: string, shortfalls: string[], verdict = 'NEEDS_EVIDENCE'): Promise<void> {
  readingSeq += 1;
  const at = new Date(Date.now() - (100 - readingSeq) * 60_000).toISOString();
  await getDb().run(
    `INSERT INTO goal_plan_readings (id, workstream_id, digest, scenario_model_id, scenario_run_id, verdict, chosen_strategy, strategies, next_test, forecast, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?, NULL, '[]', NULL, ?, ?)`,
    [`gpr_t${readingSeq}${uid()}`, goalId, `d${readingSeq}`, verdict, JSON.stringify({ acceptance: { status, shortfalls, required: 0.9 } }), at],
  );
}

beforeEach(async () => {
  discovery.calls.length = 0;
  discovery.answer = null;
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `own-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
});

describe('H2-3 (a): open inventory findings nobody owns or repairs are deficiencies, commissionable by id', () => {
  const finding = (id: string, over: Record<string, unknown> = {}) =>
    upsertInventory(
      {
        id,
        capability: 'operator deficiencies',
        symptom: 'Hermes notices only three hard-coded kinds of capability problem.',
        evidence: 'server/services/operator/director.ts readDeficiencies has three detectors',
        rootCause: 'readDeficiencies in server/services/operator/director.ts reads three sources only',
        severity: 'MAJOR',
        status: 'ROOT_CAUSE_CONFIRMED',
        ...over,
      },
      ctx,
    );

  it('fires on an unowned, unrepaired finding and names its owner file; silent when owned, further along, or in flight', async () => {
    expect(await inventoryDeficiencies()).toEqual([]);
    expect((await finding('T-OPEN')).ok).toBe(true);
    expect((await finding('T-OWNED', { owner: 'session X' })).ok).toBe(true);
    expect((await finding('T-INVEST', { status: 'UNDER_INVESTIGATION' })).ok).toBe(true);
    const busy = (await upsertCandidate({
      weaknessKey: `OPERATOR:T:${uid()}`, kind: 'OPERATOR:MISSING_CAPABILITY', title: 't', problem: 'p', metric: 'READY_OPPORTUNITIES_PER_DAY', downstreamMetric: null,
      ownerComponent: `server/x-${uid()}.ts`, frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    })).candidate;
    expect((await finding('T-BUSY', { linkedCandidateId: busy.id })).ok).toBe(true);

    const found = await inventoryDeficiencies();
    expect(found.map((one) => one.source?.ref)).toEqual(['T-OPEN']);
    const open = found[0]!;
    expect(readingId(open)).toBe('dfx_inv_T-OPEN');
    expect(open.diagnosis.ownerPaths).toEqual(['server/services/operator/director.ts']);
    expect(open.diagnosis.cause).toContain('three sources only');
    expect(open.intervention).toBe('ENGINEERING');

    // The repair linked to T-BUSY ends: the finding is unclaimed again.
    await decideCandidate(busy.id, 'REVERTED', 'regressed');
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref).sort()).toEqual(['T-BUSY', 'T-OPEN']);
  });

  it('is listed by brain_operator_deficiencies and commissioned by its id; the repair is linked, so it is not offered again', async () => {
    await improvementOff();
    expect((await finding('T-COMM')).ok).toBe(true);
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const listed = (await findTool('brain_operator_deficiencies')!.run({}, { principal: operator, requestId: 'r' })).value as { deficiencies: { id: string }[] };
    expect(listed.deficiencies.map((d) => d.id)).toContain('dfx_inv_T-COMM');
    const out = (await findTool('brain_operator_commission')!.run({ deficiency_id: 'dfx_inv_T-COMM', decision_id: await decision() }, { principal: operator, requestId: 'r' })).value as {
      ok: boolean; candidateId?: string; linkedFinding?: string; intervention: string;
    };
    expect(out.ok).toBe(true);
    expect(out.intervention).toBe('ENGINEERING');
    expect(out.linkedFinding).toBe('T-COMM');
    expect((await getInventoryItem('T-COMM'))!.linkedCandidates).toContain(out.candidateId);
    expect((await inventoryDeficiencies()).map((one) => one.source?.ref)).not.toContain('T-COMM');
  });
});

describe('H2-3 (b): a goal plan whose missing evidence does not change across readings', () => {
  it('fires when the last three readings are not accepted and name the same missing evidence', async () => {
    const goalId = await cashGoal();
    const missing = ['opp_1: a reachable buyer', 'opp_1: an evidenced price'];
    await planReading(goalId, 'CANDIDATE_ONLY', ['something else']);
    for (let i = 0; i < 3; i += 1) await planReading(goalId, 'CANDIDATE_ONLY', i === 1 ? [...missing].reverse() : missing);
    const found = (await stuckPlanDeficiencies()).filter((one) => one.diagnosis.goalId === goalId);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toEqual({ kind: 'STUCK_PLAN', ref: goalId });
    expect(found[0]!.diagnosis.observed).toContain('an evidenced price');
    // The cause is not established: research first, never a guess sent to Factory.
    expect(found[0]!.intervention).toBe('EVIDENCE');
    // And it reaches the operator's list.
    expect((await readDeficiencies()).some((one) => one.source?.kind === 'STUCK_PLAN' && one.source.ref === goalId)).toBe(true);
  });

  it('stays silent when the missing evidence changed, the plan is accepted, there are too few readings, or the goal is paused', async () => {
    const moving = await plainGoal('moving');
    for (const list of [['a'], ['a', 'b'], ['b']]) await planReading(moving, 'CANDIDATE_ONLY', list);
    const accepted = await plainGoal('accepted');
    await planReading(accepted, 'CANDIDATE_ONLY', ['a']);
    await planReading(accepted, 'CANDIDATE_ONLY', ['a']);
    await planReading(accepted, 'ACCEPTED', ['a'], 'RECOMMENDABLE');
    const young = await plainGoal('young');
    await planReading(young, 'CANDIDATE_ONLY', ['a']);
    await planReading(young, 'CANDIDATE_ONLY', ['a']);
    const paused = await plainGoal('paused');
    for (let i = 0; i < 3; i += 1) await planReading(paused, 'CANDIDATE_ONLY', ['a']);
    expect((await pause(paused, 'test', `person:${userId}`)).ok).toBe(true);
    expect(await stuckPlanDeficiencies()).toEqual([]);
  });
});

describe('H2-3 (c): goal research rounds that ended without a report', () => {
  async function round(goalId: string, lens: string, to: 'HARVESTED' | 'ABANDONED' | null, n: number): Promise<void> {
    const r = await openRound({ projectId, cashModeId: 'csh_t', bucketId: `goal-${goalId}-${lens}`, mechanism: 'GOAL', round: n, candidateId: `rcd_${uid()}${uid()}` });
    if (to) await closeRound({ id: r.round.id, to, found: 0 });
  }

  it('fires on a live goal with two rounds ABANDONED in the window', async () => {
    const goalId = await cashGoal();
    await round(goalId, 'remote', 'ABANDONED', 1);
    await round(goalId, 'remote', 'ABANDONED', 2);
    await round(goalId, 'local', 'HARVESTED', 1);
    const found = (await unreportedRoundDeficiencies()).filter((one) => one.diagnosis.goalId === goalId);
    expect(found).toHaveLength(1);
    expect(found[0]!.source).toEqual({ kind: 'UNREPORTED_ROUNDS', ref: goalId });
    expect(found[0]!.diagnosis.recurrence).toBe(2);
    expect(found[0]!.diagnosis.evidence).toContain(`goal-${goalId}-remote`);
  });

  it('stays silent when the rounds reported (even finding nothing), only one ended unreported, or the goal is paused', async () => {
    const reported = await plainGoal('reported');
    await round(reported, 'a', 'HARVESTED', 1);
    await round(reported, 'a', 'HARVESTED', 2);
    await round(reported, 'b', null, 1);
    const once = await plainGoal('once');
    await round(once, 'a', 'ABANDONED', 1);
    const paused = await plainGoal('paused');
    await round(paused, 'a', 'ABANDONED', 1);
    await round(paused, 'a', 'ABANDONED', 2);
    expect((await pause(paused, 'test', `person:${userId}`)).ok).toBe(true);
    expect(await unreportedRoundDeficiencies()).toEqual([]);
  });
});

describe('H2-6: standalone research through brain_operator_commission, a paused goal included', () => {
  const tool = () => findTool('brain_operator_commission')!;

  it("asks a paused goal's own search the question — research only — and links the round", async () => {
    const goalId = await cashGoal();
    expect((await pause(goalId, 'owner paused it', `person:${userId}`)).ok).toBe(true);
    discovery.answer = { bucketId: `goal-${goalId}-x`, candidateId: 'rcd_paused', round: 1 };
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const out = (await tool().run(
      { research_question: 'Which buyers publish what they pay for bookkeeping clean-ups?', goal_id: goalId, decision_id: await decision() },
      { principal: operator, requestId: 'r' },
    )).value as { ok: boolean; intervention: string; started: string[]; reason: string; roundCandidateId?: string };
    expect(out).toMatchObject({ ok: true, intervention: 'EVIDENCE', roundCandidateId: 'rcd_paused' });
    expect(out.started).toEqual(['goal research round rcd_paused']);
    expect(out.reason).toContain('paused: research only');
    expect(discovery.calls).toHaveLength(1);
    expect(String(discovery.calls[0]!['diagnosis'])).toContain('bookkeeping clean-ups');
    expect((await listLinks(goalId)).some((l) => l.ref === 'rcd_paused' && l.relation === 'PURSUES')).toBe(true);
    // The goal stays paused: research did not resume it.
    expect((await getWorkstream(goalId))!.pausedAt).not.toBeNull();
  });

  it('refuses a spend or outreach effect on a paused goal, and anything but EVIDENCE for a research question', async () => {
    const goalId = await cashGoal();
    expect((await pause(goalId, 'owner paused it', `person:${userId}`)).ok).toBe(true);
    const capacity = await commission({
      goalId,
      deficiency: 'RESOURCE_ALLOCATION',
      title: 'Waiting outreach beside idle capacity',
      observed: 'The goal has sends waiting while the free lane is idle; continuing capacity would dispatch them.',
      evidence: 'capacity reading: FREE_LANE idle, 4 sends waiting',
      cause: null,
      ownerPaths: [],
      recurrence: 2,
      expectedBenefit: 'The waiting sends go out now.',
      acceptance: 'The waiting sends leave the queue within the hour.',
      metric: null,
      blocksGoal: true,
      share: 0.3,
      proposed: 'CAPACITY',
      capacityIdle: true,
      runId: 'opr_t',
    });
    expect(capacity.ok).toBe(false);
    expect(capacity.reason).toMatch(/paused/);
    expect(capacity.started).toEqual([]);
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const viaTool = (await tool().run(
      { research_question: 'Send the waiting outreach for this goal now please.', goal_id: goalId, intervention: 'CAPACITY', decision_id: await decision() },
      { principal: operator, requestId: 'r' },
    )).value as { ok: boolean; reason: string };
    expect(viaTool.ok).toBe(false);
    expect(viaTool.reason).toMatch(/EVIDENCE/);
    expect(discovery.calls).toHaveLength(0);
  });

  it('authorizes exactly as any commission: operator:act, a decision, and a goal in a project the credential directs', async () => {
    const goalId = await cashGoal();
    const args = { research_question: 'Which buyers publish what they pay for bookkeeping clean-ups?', goal_id: goalId };
    await expect(tool().run({ ...args, decision_id: await decision() }, { principal: principal(projectId, ['project:read']), requestId: 'r' })).rejects.toThrow();
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    expect((await tool().run(args, { principal: operator, requestId: 'r' })).value).toMatchObject({ refused: true });
    const other = (await createProject({ name: `Other ${uid()}`, slug: `other-${uid()}` })).id;
    const foreign = await createWorkstream({ projectId: other, title: 'elsewhere', intent: 'x', purpose: 'REVENUE_DIRECT', createdByUserId: null });
    const forbidden = await tool().run({ ...args, goal_id: foreign.id, decision_id: await decision() }, { principal: operator, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    const absent = await tool().run({ ...args, goal_id: 'wst_nothing', decision_id: await decision() }, { principal: operator, requestId: 'r' }).then(() => null, (e: Error) => e.message);
    expect(forbidden).not.toBeNull();
    expect(forbidden).toBe(absent);
    expect(discovery.calls).toHaveLength(0);
  });

  it('a method question with no goal opens method research about Brain through the EVIDENCE path', async () => {
    const brain = (await getProjectBySlug('brain-architecture'))?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brain, name: 'Methods', orderIndex: 0 });
    await improvementOff();
    const operator = principal(projectId, [...OPERATOR_SCOPES]);
    const out = (await tool().run(
      { research_question: 'How do other agent platforms detect a plan that has stopped moving?', decision_id: await decision() },
      { principal: operator, requestId: 'r' },
    )).value as { ok: boolean; intervention: string; candidateId?: string; reason: string };
    expect(out.ok).toBe(true);
    expect(out.intervention).toBe('EVIDENCE');
    expect(out.candidateId).toMatch(/^imp_/);
    expect(out.reason).toContain('the diagnosis names no goal');
    expect(discovery.calls).toHaveLength(0);
  });
});
