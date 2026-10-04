/**
 * GOAL_BUDGET as a real approval mode on `startPacket`.
 *
 * What is held here is that every ceiling is enforced *before* anything is
 * created: a refused packet leaves no run, orchestration or fragment, a
 * repeated packet key is the same packet and charged once, the caller's own
 * account of money is never trusted, and two callers racing for one remaining
 * slot produce one packet. Races are forced rather than hoped for.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { listEvents } from '../server/repos/events.ts';
import { createResearchGoal, goalBudgetStatus } from '../server/repos/russellAuthority.ts';
import {
  GoalBudgetExhausted,
  GoalBudgetMoneyRefused,
  NoSuchTarget,
  startPacket,
  type ApprovalPolicy,
} from '../server/services/research/startPacket.ts';

let fixture: TestProject;
let layerId = '';
let userId = '';

const HOUR = 3_600_000;
const BUDGET = {
  maxPackets: 2,
  maxFragments: 10,
  deadline: null,
  externalSpendCents: 0,
  paidOveragesEnabled: false,
} as const;

beforeEach(async () => {
  fixture = await freshProject();
  layerId = (await fixture.layerByName('Discovery Logic')).id;
  userId = (
    await createUser({
      email: `gb-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

afterEach(async () => {
  await teardown();
});

async function researchGoal(over: { maxPackets?: number; deadline?: string } = {}) {
  return createResearchGoal({
    projectId: fixture.project.id,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `Goal ${Math.random().toString(36).slice(2, 8)}`,
    maxPackets: over.maxPackets ?? 2,
    maxFragments: 10,
    deadline: over.deadline ?? new Date(Date.now() + 2 * HOUR).toISOString(),
  });
}

function start(approval: ApprovalPolicy, projectId = fixture.project.id) {
  return startPacket({
    projectId,
    layerId,
    title: 'A bounded question',
    assignment: 'Which offices publish rolls, and where.',
    approval,
  });
}

function policy(goalId: string, packetKey: string, budget: unknown = BUDGET): ApprovalPolicy {
  return { mode: 'GOAL_BUDGET', goalId, packetKey, budget: budget as typeof BUDGET };
}

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [
    fixture.project.id,
  ]);
  return Number(row?.n ?? 0);
}

describe('GOAL_BUDGET packet ceiling', () => {
  it('admits two packets, refuses the third naming PACKETS, and creates nothing for it', async () => {
    const goal = await researchGoal({ maxPackets: 2 });
    const a = await start(policy(goal.id, 'a'));
    const b = await start(policy(goal.id, 'b'));
    expect(a.orchestration.goalId).toBe(goal.id);
    expect(a.orchestration.id).not.toBe(b.orchestration.id);

    const runs = await count('research_runs');
    const orchestrations = await count('research_orchestrations');
    const fragments = await count('research_fragments');

    const refused = await start(policy(goal.id, 'c')).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused).toBeInstanceOf(GoalBudgetExhausted);
    expect((refused as GoalBudgetExhausted).ceiling).toBe('PACKETS');
    expect(refused!.message).toMatch(/PACKETS/);
    expect(refused!.message).toMatch(/decision for a person/);

    expect(await count('research_orchestrations')).toBe(orchestrations);
    expect(await count('research_fragments')).toBe(fragments);
    expect(await count('research_runs')).toBe(runs);

    const stopped = (await listEvents(fixture.project.id)).filter(
      (event) => event.eventType === 'RESEARCH_GOAL_BUDGET_STOPPED',
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.payload).toMatchObject({ goalId: goal.id, ceiling: 'PACKETS' });
  });

  it('treats a repeated packet key as the same packet, charged once', async () => {
    const goal = await researchGoal({ maxPackets: 2 });
    const first = await start(policy(goal.id, 'same'));
    const orchestrations = await count('research_orchestrations');
    const again = await start(policy(goal.id, 'same'));

    expect(again.orchestration.id).toBe(first.orchestration.id);
    expect(again.run.id).toBe(first.run.id);
    expect(await count('research_orchestrations')).toBe(orchestrations);
    const status = await goalBudgetStatus(goal.id);
    expect(status?.packets.used).toBe(1);
  });

  it('refuses a new packet after the deadline, naming DEADLINE', async () => {
    const goal = await researchGoal({ deadline: new Date(Date.now() + 1500).toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 1700));
    const refused = await start(policy(goal.id, 'late')).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused).toBeInstanceOf(GoalBudgetExhausted);
    expect((refused as GoalBudgetExhausted).ceiling).toBe('DEADLINE');
    expect(await count('research_orchestrations')).toBe(0);
  });
});

describe('GOAL_BUDGET is never trusted from the caller', () => {
  it('refuses external spend and paid overages by name, creating nothing', async () => {
    const goal = await researchGoal();
    for (const budget of [
      { ...BUDGET, externalSpendCents: 500 },
      { ...BUDGET, paidOveragesEnabled: true },
    ]) {
      const refused = await start(policy(goal.id, 'money', budget)).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(refused).toBeInstanceOf(GoalBudgetMoneyRefused);
    }
    expect(await count('research_orchestrations')).toBe(0);
  });

  it('answers a goal that is not usable here exactly like a missing target', async () => {
    const refused = await start(policy('goal_nope', 'k')).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused).toBeInstanceOf(NoSuchTarget);
  });

  it('creates exactly one orchestration when two callers race for the last slot', async () => {
    const goal = await researchGoal({ maxPackets: 1 });
    const outcomes = await Promise.allSettled([
      start(policy(goal.id, 'x')),
      start(policy(goal.id, 'y')),
    ]);
    expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((one) => one.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(GoalBudgetExhausted);
    expect(await count('research_orchestrations')).toBe(1);
  });
});
