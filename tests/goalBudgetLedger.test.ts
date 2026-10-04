/**
 * A research goal owns a budget, and the budget is the existing ledger.
 *
 * `createResearchGoal` writes a `russell_goals` row with `purpose =
 * 'RESEARCH_GOAL'`; packets are reserved as `MISSION` and fragments as
 * `FRAGMENT` through `reserve()`, so there is one quota mechanism and this file
 * holds it to the ceilings a research goal declares: packets, fragments across
 * every packet of the goal, and a deadline on Brain's clock — with money
 * pinned at zero and the goal invisible to every standing-authority reader.
 *
 * Races are forced rather than hoped for: concurrent callers are started
 * together and the assertion is on the count of winners, which is the property
 * the rowid ranking in `reserve` exists to guarantee on either backend.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  FragmentBudgetRefused,
  currentFragments,
  getOrchestration,
} from '../server/repos/research.ts';
import {
  bindPacketToGoal,
  chargeFragments,
  chargeProbe,
  checkAuthority,
  createGoal,
  createResearchGoal,
  ensureGoal,
  getGoal,
  goalBudgetStatus,
  goalPacketKey,
  listGoals,
  listReservations,
  liveGoalNamed,
  reserveGoalPacket,
  spendTotals,
} from '../server/repos/russellAuthority.ts';
import { authorityFor } from '../server/services/russell/authority.ts';

let fixture: TestProject;
let projectId = '';
let layerId = '';
let runId = '';
let userId = '';

const HOUR = 3_600_000;

function deadlineIn(ms = 2 * HOUR): string {
  return new Date(Date.now() + ms).toISOString();
}

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  const layer = await fixture.layerByName('Discovery Logic');
  layerId = layer.id;
  await addDocument(fixture, 'Discovery Logic', 'v1B', { contents: 'Which offices publish rolls.' });
  runId = (
    await createRun({
      projectId,
      layerId,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: 'research goal budget',
    })
  ).id;
  userId = (
    await createUser({
      email: `goal-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

async function researchGoal(overrides: { maxPackets?: number; maxFragments?: number; deadline?: string } = {}) {
  return createResearchGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `Research goal ${Math.random().toString(36).slice(2, 8)}`,
    maxPackets: overrides.maxPackets ?? 2,
    maxFragments: overrides.maxFragments ?? 3,
    deadline: overrides.deadline ?? deadlineIn(),
  });
}

async function packet(goalId: string, key: string) {
  const outcome = await reserveGoalPacket({ goalId, packetKey: key, projectId });
  expect(outcome.ok).toBe(true);
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId,
    title: `Packet ${key}`,
    assignment: 'a bounded question',
    provider: 'WORKER',
    autoApprove: false,
  });
  expect(await bindPacketToGoal({ orchestrationId: orchestration.id, goalId, packetKey: key })).toBe(true);
  return orchestration;
}

function fragmentInputs(orchestrationId: string, keys: string[], indexFrom = 0) {
  return keys.map((fragmentKey, i) => ({
    orchestrationId,
    projectId,
    layerId,
    fragmentIndex: indexFrom + i,
    fragmentKey,
    question: `Question ${fragmentKey}`,
    requiredEvidence: [{ id: 'official_source', description: 'the office', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['official'],
    excludedSourceTypes: ['marketing'],
    completionCriteria: ['a quote'],
    minIndependentSources: 1,
    maxRepairs: 2,
    dependsOn: [],
    attempt: 1,
  })) as unknown as Parameters<typeof createFragments>[0];
}

async function fragmentRows(orchestrationId: string): Promise<number> {
  return (await currentFragments(orchestrationId)).length;
}

/** Push every HELD reservation of a kind past its TTL, as time would. */
async function expireHolds(goalId: string, kind: 'MISSION' | 'FRAGMENT') {
  await getDb().run(
    `UPDATE russell_budget_reservations SET expires_at = ?
      WHERE goal_id = ? AND kind = ? AND state = 'HELD'`,
    [new Date(Date.now() - HOUR).toISOString(), goalId, kind],
  );
}

describe('creating a research goal', () => {
  it('writes a capped, research-only, zero-money goal that ends at the deadline', async () => {
    const deadline = deadlineIn();
    const goal = await researchGoal({ maxPackets: 4, maxFragments: 9, deadline });
    expect(goal.purpose).toBe('RESEARCH_GOAL');
    expect(goal.workPolicy).toBe('CAPPED');
    expect(goal.maxMissions).toBe(4);
    expect(goal.maxFragments).toBe(9);
    expect(goal.maxProbes).toBe(0);
    expect(goal.maxExternalSpend).toBe(0);
    expect(goal.allowedWork).toEqual(['RESEARCH']);
    expect(goal.prohibitions).toContain('PAID_OVERAGE');
    expect(goal.expiresAt).toBe(deadline);
    expect(goal.createdByUserId).toBe(userId);
  });

  it('refuses any non-zero external spend or paid overage, and stores zero', async () => {
    const base = {
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Costly',
      maxPackets: 1,
      maxFragments: 1,
      deadline: deadlineIn(),
    };
    await expect(createResearchGoal({ ...base, ...{ maxExternalSpend: 500 } } as never)).rejects.toThrow(/spend/i);
    await expect(createResearchGoal({ ...base, paidOverages: true })).rejects.toThrow(/paid overages/i);
    const refused = await getDb().all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM russell_goals WHERE name = 'Costly'",
    );
    expect(Number(refused[0]!.n)).toBe(0);

    // An explicit zero is the same as none.
    const goal = await createResearchGoal({ ...base, ...{ maxExternalSpend: 0 } } as never);
    const row = await getDb().get<{ max_external_spend: number }>(
      'SELECT max_external_spend FROM russell_goals WHERE id = ?',
      [goal.id],
    );
    expect(row!.max_external_spend).toBe(0);
  });

  it('needs positive whole-number ceilings and a deadline that is still ahead', async () => {
    const base = {
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Bad',
      maxPackets: 1,
      maxFragments: 1,
      deadline: deadlineIn(),
    };
    await expect(createResearchGoal({ ...base, maxPackets: 0 })).rejects.toThrow(/packet/i);
    await expect(createResearchGoal({ ...base, maxPackets: 1.5 })).rejects.toThrow(/packet/i);
    await expect(createResearchGoal({ ...base, maxFragments: -2 })).rejects.toThrow(/fragment/i);
    await expect(createResearchGoal({ ...base, deadline: 'not a date' })).rejects.toThrow(/deadline/i);
    await expect(createResearchGoal({ ...base, deadline: new Date(Date.now() - HOUR).toISOString() })).rejects.toThrow(
      /deadline/i,
    );
  });
});

describe('a research goal is not the standing authority', () => {
  it('is invisible to every standing-authority reader', async () => {
    const goal = await researchGoal();

    expect((await checkAuthority({ projectId, workClass: 'RESEARCH' })).ok).toBe(false);
    expect(await listGoals(projectId)).toHaveLength(0);
    expect(await liveGoalNamed(projectId, goal.name)).toBeNull();
    const view = await authorityFor({ projectId });
    expect(view.grant).toBeNull();
    expect(JSON.stringify(view.history)).not.toContain(goal.id);

    // A probe is charged to a standing grant only; there is none to charge.
    const probe = await chargeProbe({ projectId, candidateId: 'cand-1' });
    expect(probe.ok).toBe(true);
    expect(probe.reason).toMatch(/not governed/);
    expect(await listReservations(goal.id)).toHaveLength(0);

    // The goal itself is still readable by id, and still a research goal.
    expect((await getGoal(goal.id))!.purpose).toBe('RESEARCH_GOAL');
  });

  it('does not displace or masquerade as a real standing grant', async () => {
    const standing = await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Standing',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 2,
      maxProbes: 1,
    });
    await researchGoal();
    const decision = await checkAuthority({ projectId, workClass: 'RESEARCH' });
    expect(decision.ok).toBe(true);
    expect(decision.goal!.id).toBe(standing.id);
    expect((await listGoals(projectId)).map((g) => g.id)).toEqual([standing.id]);
    expect((await authorityFor({ projectId })).grant).not.toBeNull();

    // ensureGoal's read-back never returns a research goal under a shared name.
    const named = await researchGoal();
    const ensured = await ensureGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: named.name,
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 0,
    });
    expect(ensured.goal.id).not.toBe(named.id);
    expect(ensured.goal.purpose).toBe('STANDING');
  });
});

describe('the packet ceiling', () => {
  it('admits two distinct packet keys and refuses a third, naming PACKETS', async () => {
    const goal = await researchGoal({ maxPackets: 2 });
    const first = await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId });
    const second = await reserveGoalPacket({ goalId: goal.id, packetKey: 'b', projectId });
    const third = await reserveGoalPacket({ goalId: goal.id, packetKey: 'c', projectId });
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(third.ok).toBe(false);
    expect(third.refusedBy).toBe('PACKETS');
    expect(third.reason).toMatch(/2 packet/);
    expect(third.reservation).toBeNull();
    // The refused attempt took nothing.
    expect((await spendTotals(goal.id, 'MISSION', new Date().toISOString())).committed).toBe(2);
  });

  it('charges a replayed key once, and the replay is the same packet', async () => {
    const goal = await researchGoal({ maxPackets: 2 });
    const first = await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId });
    const again = await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId });
    expect(first.replayed).toBe(false);
    expect(again.ok).toBe(true);
    expect(again.replayed).toBe(true);
    expect(again.reservation!.id).toBe(first.reservation!.id);
    expect(first.reservation!.idempotencyKey).toBe(goalPacketKey(goal.id, 'a'));
    expect(first.reservation!.kind).toBe('MISSION');
    expect((await spendTotals(goal.id, 'MISSION', new Date().toISOString())).committed).toBe(1);
    // …which leaves a slot for a different packet.
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'b', projectId })).ok).toBe(true);
  });

  it('gives exactly one success when two reservations race for one remaining slot', async () => {
    const goal = await researchGoal({ maxPackets: 1 });
    const outcomes = await Promise.all([
      reserveGoalPacket({ goalId: goal.id, packetKey: 'left', projectId }),
      reserveGoalPacket({ goalId: goal.id, packetKey: 'right', projectId }),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const loser = outcomes.find((o) => !o.ok)!;
    expect(loser.refusedBy).toBe('PACKETS');
    expect((await spendTotals(goal.id, 'MISSION', new Date().toISOString())).committed).toBe(1);
  });

  it('names the other reasons a packet is refused', async () => {
    const goal = await researchGoal();
    const wrong = await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId: 'prj_somewhere_else' });
    expect(wrong.refusedBy).toBe('WRONG_PROJECT');

    const missing = await reserveGoalPacket({ goalId: 'rgl_nothing', packetKey: 'a', projectId });
    expect(missing.refusedBy).toBe('NOT_A_RESEARCH_GOAL');

    const standing = await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Standing',
      allowedWork: ['RESEARCH'],
      maxMissions: 5,
      maxFragments: 5,
      maxConcurrent: 2,
      maxProbes: 1,
    });
    expect((await reserveGoalPacket({ goalId: standing.id, packetKey: 'a', projectId })).refusedBy).toBe(
      'NOT_A_RESEARCH_GOAL',
    );

    await getDb().run("UPDATE russell_goals SET state = 'PAUSED' WHERE id = ?", [goal.id]);
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId })).refusedBy).toBe('PAUSED');
    await getDb().run("UPDATE russell_goals SET state = 'REVOKED' WHERE id = ?", [goal.id]);
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'a', projectId })).refusedBy).toBe('REVOKED');
  });

  it('settles a packet once its orchestration exists, and refunds one that was never created', async () => {
    const goal = await researchGoal({ maxPackets: 1 });
    const made = await packet(goal.id, 'made');
    const bound = (await getOrchestration(made.id))!;
    expect(bound.goalId).toBe(goal.id);
    expect(bound.goalPacketKey).toBe('made');
    const [settled] = await listReservations(goal.id);
    expect(settled!.state).toBe('SETTLED');

    // Settled packets stay counted past any TTL.
    await expireHolds(goal.id, 'MISSION');
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'next', projectId })).refusedBy).toBe('PACKETS');

    // A packet reserved and never created expires and refunds itself.
    const other = await researchGoal({ maxPackets: 1 });
    expect((await reserveGoalPacket({ goalId: other.id, packetKey: 'lost', projectId })).ok).toBe(true);
    expect((await reserveGoalPacket({ goalId: other.id, packetKey: 'blocked', projectId })).refusedBy).toBe(
      'PACKETS',
    );
    await expireHolds(other.id, 'MISSION');
    expect((await reserveGoalPacket({ goalId: other.id, packetKey: 'after-restart', projectId })).ok).toBe(true);
  });

  it('links one packet key to at most one orchestration', async () => {
    const goal = await researchGoal({ maxPackets: 2 });
    await packet(goal.id, 'same');
    const second = await createOrchestration({
      projectId,
      layerId,
      runId,
      title: 'Duplicate',
      assignment: 'x',
      provider: 'WORKER',
      autoApprove: false,
    });
    await expect(bindPacketToGoal({ orchestrationId: second.id, goalId: goal.id, packetKey: 'same' })).rejects.toThrow();
  });
});

describe('the fragment ceiling', () => {
  it('is enforced across two orchestrations of one goal, and a refusal inserts nothing', async () => {
    const goal = await researchGoal({ maxPackets: 2, maxFragments: 3 });
    const one = await packet(goal.id, 'one');
    const two = await packet(goal.id, 'two');

    await createFragments(fragmentInputs(one.id, ['a', 'b']));
    expect(await fragmentRows(one.id)).toBe(2);

    // Two more would make four across the goal: refused whole, nothing written.
    await expect(createFragments(fragmentInputs(two.id, ['c', 'd']))).rejects.toBeInstanceOf(FragmentBudgetRefused);
    expect(await fragmentRows(two.id)).toBe(0);

    // The refusal charged nothing, so the one that fits still fits.
    await createFragments(fragmentInputs(two.id, ['c']));
    expect(await fragmentRows(two.id)).toBe(1);
    await expect(createFragments(fragmentInputs(two.id, ['e'], 1))).rejects.toBeInstanceOf(FragmentBudgetRefused);
    expect(await fragmentRows(two.id)).toBe(1);
    expect((await spendTotals(goal.id, 'FRAGMENT', new Date().toISOString())).committed).toBe(3);
  });

  it('cannot be overspent by concurrent charges', async () => {
    const goal = await researchGoal({ maxPackets: 2, maxFragments: 3 });
    const one = await packet(goal.id, 'one');
    const two = await packet(goal.id, 'two');
    const settled = await Promise.allSettled([
      chargeFragments({ orchestrationId: one.id, fragmentKeys: ['a', 'b'] }),
      chargeFragments({ orchestrationId: two.id, fragmentKeys: ['c', 'd'] }),
    ]);
    const outcomes = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
    expect(outcomes.every((o) => o !== null)).toBe(true);
    const held = (await spendTotals(goal.id, 'FRAGMENT', new Date().toISOString())).committed;
    expect(held).toBeLessThanOrEqual(3);
    // Two of two, or none of two: a batch is never half-charged against the ceiling.
    expect(held % 2).toBe(0);
    expect(outcomes.filter((o) => o!.ok).length).toBeLessThanOrEqual(1);
  });

  it('keeps created fragments counted after the reservation TTL has passed', async () => {
    const goal = await researchGoal({ maxFragments: 2 });
    const one = await packet(goal.id, 'one');
    await createFragments(fragmentInputs(one.id, ['a', 'b']));
    const reservations = await listReservations(goal.id);
    expect(reservations.filter((r) => r.kind === 'FRAGMENT').every((r) => r.state === 'SETTLED')).toBe(true);

    await expireHolds(goal.id, 'FRAGMENT');
    expect((await spendTotals(goal.id, 'FRAGMENT', new Date().toISOString())).committed).toBe(2);
    await expect(createFragments(fragmentInputs(one.id, ['c'], 2))).rejects.toBeInstanceOf(FragmentBudgetRefused);
  });

  it('expires and refunds a charge that was never followed by creation', async () => {
    const goal = await researchGoal({ maxFragments: 2 });
    const one = await packet(goal.id, 'one');
    const charge = await chargeFragments({ orchestrationId: one.id, fragmentKeys: ['a', 'b'] });
    expect(charge.ok).toBe(true);
    expect(charge.reservationIds).toHaveLength(2);

    // While held it counts…
    expect((await chargeFragments({ orchestrationId: one.id, fragmentKeys: ['z'] })).ok).toBe(false);
    // …and a crash before insertion leaves it to lapse.
    await expireHolds(goal.id, 'FRAGMENT');
    expect((await spendTotals(goal.id, 'FRAGMENT', new Date().toISOString())).committed).toBe(0);
    await createFragments(fragmentInputs(one.id, ['x', 'y']));
    expect(await fragmentRows(one.id)).toBe(2);
  });

  it('charges a repeated fragment key once', async () => {
    const goal = await researchGoal({ maxFragments: 2 });
    const one = await packet(goal.id, 'one');
    await createFragments(fragmentInputs(one.id, ['a']));
    await createFragments(fragmentInputs(one.id, ['a']));
    expect((await spendTotals(goal.id, 'FRAGMENT', new Date().toISOString())).committed).toBe(1);
  });

  it('leaves a packet with no goal and no mission uncharged', async () => {
    const free = await createOrchestration({
      projectId,
      layerId,
      runId,
      title: 'No goal',
      assignment: 'x',
      provider: 'WORKER',
      autoApprove: false,
    });
    const charge = await chargeFragments({ orchestrationId: free.id, fragmentKeys: ['a', 'b', 'c'] });
    expect(charge.ok).toBe(true);
    expect(charge.reservationIds).toEqual([]);
  });
});

describe('the deadline, on Brain’s clock', () => {
  async function passDeadline(goalId: string) {
    await getDb().run('UPDATE russell_goals SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      goalId,
    ]);
  }

  it('stops every packet and fragment reservation after it, and touches no earlier row', async () => {
    const goal = await researchGoal({ maxPackets: 5, maxFragments: 9 });
    const one = await packet(goal.id, 'one');
    await createFragments(fragmentInputs(one.id, ['a']));
    const before = await listReservations(goal.id);

    await passDeadline(goal.id);

    const late = await reserveGoalPacket({ goalId: goal.id, packetKey: 'late', projectId });
    expect(late.ok).toBe(false);
    expect(late.refusedBy).toBe('DEADLINE');
    await expect(createFragments(fragmentInputs(one.id, ['b'], 1))).rejects.toBeInstanceOf(FragmentBudgetRefused);
    expect(await fragmentRows(one.id)).toBe(1);

    const after = await listReservations(goal.id);
    expect(after).toEqual(before);
    expect((await goalBudgetStatus(goal.id))!.state).toBe('EXPIRED');
  });

  it('judges the deadline by the instant a reservation is asked for', async () => {
    const goal = await researchGoal({ maxPackets: 5 });
    const at = new Date(Date.parse(goal.expiresAt!) + 1000).toISOString();
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'x', projectId, at })).refusedBy).toBe('DEADLINE');
    expect((await reserveGoalPacket({ goalId: goal.id, packetKey: 'x', projectId })).ok).toBe(true);
  });
});

describe('goalBudgetStatus', () => {
  it('reports ceilings, use, deadline and who authorized it from narrow reads', async () => {
    const deadline = deadlineIn();
    const goal = await researchGoal({ maxPackets: 3, maxFragments: 5, deadline });
    const one = await packet(goal.id, 'one');
    await createFragments(fragmentInputs(one.id, ['a', 'b']));
    await reserveGoalPacket({ goalId: goal.id, packetKey: 'held-not-created', projectId });

    const status = (await goalBudgetStatus(goal.id))!;
    expect(status.state).toBe('ACTIVE');
    expect(status.packets).toEqual({ used: 1, reserved: 2, ceiling: 3 });
    expect(status.fragments).toEqual({ committed: 2, ceiling: 5 });
    expect(status.deadline).toBe(deadline);
    expect(status.authorizedBy).toBe(userId);
    expect(status.createdAt).toBe(goal.createdAt);
  });

  it('answers null for a goal that is not a research goal', async () => {
    const standing = await createGoal({
      projectId,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Standing',
      allowedWork: ['RESEARCH'],
      maxMissions: 1,
      maxFragments: 1,
      maxConcurrent: 1,
      maxProbes: 0,
    });
    expect(await goalBudgetStatus(standing.id)).toBeNull();
    expect(await goalBudgetStatus('rgl_missing')).toBeNull();
  });
});
