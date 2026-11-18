/**
 * A ceiling stop on Brain's own improvement research is Brain's decision.
 *
 * Recorded failure class OWNER:RAISING_THE_RESEARCH_GOALS_PACKETS_CEILING: the
 * improvement loop opens an "Improve: …" research goal in the
 * brain-architecture project with one packet and money pinned at zero. When
 * that packet ended short and the archive still did not answer it, the
 * continuation pass opened a Needs-You request asking a person to raise the
 * PACKETS ceiling — 19 of 184 requests in seven days, none of them a rule-11
 * reason.
 *
 * What this walks, on real rows: the goal, the pass (`advanceResearchGoals`),
 * the packet rows, `russell_human_requests` and `project_events`. The packet's
 * end is set by the test, as in `goalBudgetJourney.test.ts`, because how a
 * packet reaches a terminal status has its own suites.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { updateOrchestration } from '../server/repos/research.ts';
import { answerHumanRequest } from '../server/repos/russellMissions.ts';
import { advanceResearchGoals } from '../server/services/research/goalContinuation.ts';
import { ARCHITECTURE_SLUG } from '../server/services/capability/ingest.ts';
import type { Layer } from '../server/domain/types.ts';

const HOUR = 3_600_000;

let fixture: TestProject;
let layer: Layer;
let userId = '';

async function newGoal(name: string) {
  return createResearchGoal({
    projectId: fixture.project.id,
    ownerUserId: userId,
    createdByUserId: userId,
    name,
    maxPackets: 1,
    maxFragments: 4,
    deadline: new Date(Date.now() + 2 * HOUR).toISOString(),
    researchAssignment: 'Brain improvement research (not a commercial question). How should a failed work item be retried?',
    researchLayerId: layer.id,
  });
}

/** Spend the goal's one packet: the pass starts it, and it ends short. */
async function spendOnePacket(goalId: string): Promise<void> {
  await advanceResearchGoals();
  const packets = await getDb().all<{ id: string }>('SELECT id FROM research_orchestrations WHERE goal_id = ?', [goalId]);
  expect(packets).toHaveLength(1);
  await updateOrchestration(packets[0]!.id, { status: 'COMPLETE_WITH_GAPS', completedAt: new Date().toISOString() });
}

async function requestsFor(goalId: string): Promise<{ id: string; state: string; authority_needed: string }[]> {
  return getDb().all(`SELECT id, state, authority_needed FROM russell_human_requests WHERE resume_key LIKE ?`, [
    `goal-budget:${goalId}:%`,
  ]);
}

async function decisionsFor(goalId: string): Promise<{ payload: string }[]> {
  return getDb().all(
    `SELECT payload FROM project_events WHERE entity_id = ? AND event_type = 'RUSSELL_ROUTINE_DECISION'`,
    [goalId],
  );
}

async function ceilings(goalId: string): Promise<{ max_missions: number; max_fragments: number; expires_at: string | null }> {
  const row = await getDb().get<{ max_missions: number; max_fragments: number; expires_at: string | null }>(
    'SELECT max_missions, max_fragments, expires_at FROM russell_goals WHERE id = ?',
    [goalId],
  );
  return { max_missions: Number(row!.max_missions), max_fragments: Number(row!.max_fragments), expires_at: row!.expires_at };
}

beforeEach(async () => {
  fixture = await freshProject();
  layer = await fixture.layerByName('Monetization Logic');
  userId = (
    await createUser({
      email: `gc-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

afterEach(async () => {
  await teardown();
});

describe("a ceiling on Brain's own improvement research goal", () => {
  it('is decided by Brain: no Needs-You request, one recorded decision, no ceiling raised', async () => {
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [ARCHITECTURE_SLUG, fixture.project.id]);
    const goal = await newGoal('Improve: Goal research rounds end without a report');
    await spendOnePacket(goal.id);
    const before = await ceilings(goal.id);

    const report = await advanceResearchGoals();
    expect(report.stopped).toEqual([{ goalId: goal.id, ceiling: 'PACKETS', asked: false, decidedBy: 'BRAIN' }]);
    expect(await requestsFor(goal.id)).toHaveLength(0);

    const decisions = await decisionsFor(goal.id);
    expect(decisions).toHaveLength(1);
    const payload = JSON.parse(decisions[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      goalId: goal.id,
      ceiling: 'PACKETS',
      ceilingKey: `goal-budget:${goal.id}:PACKETS:1`,
      choice: 'LEAVE_STOPPED',
      decidedBy: 'BRAIN_OWN_RESEARCH_GOAL',
    });

    // Repeated ticks decide nothing new and ask nobody.
    await advanceResearchGoals();
    await advanceResearchGoals();
    expect(await decisionsFor(goal.id)).toHaveLength(1);
    expect(await requestsFor(goal.id)).toHaveLength(0);

    // Nothing was raised and no packet was added.
    expect(await ceilings(goal.id)).toEqual(before);
    const packets = await getDb().all('SELECT id FROM research_orchestrations WHERE goal_id = ?', [goal.id]);
    expect(packets).toHaveLength(1);
  });
});

describe("a ceiling request already open on Brain's own goal", () => {
  it('is withdrawn by Brain, decided once, and nothing is raised or asked again', async () => {
    // The request as production holds it: opened by the pass before Brain
    // decided its own ceilings. The goal is asked about while its project is
    // not yet Brain's, which is exactly the row the old path wrote.
    const goal = await newGoal('Improve: GOAL_PLAN capability broken: Turn a goal’s research rounds into filed openings');
    await spendOnePacket(goal.id);
    expect((await advanceResearchGoals()).stopped).toEqual([{ goalId: goal.id, ceiling: 'PACKETS', asked: true }]);
    const [open] = await requestsFor(goal.id);
    expect(open!.state).toBe('OPEN');
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [ARCHITECTURE_SLUG, fixture.project.id]);
    const before = await ceilings(goal.id);

    const report = await advanceResearchGoals();
    expect(report.withdrawn).toEqual([{ goalId: goal.id, requestIds: [open!.id] }]);
    expect(report.stopped).toEqual([{ goalId: goal.id, ceiling: 'PACKETS', asked: false, decidedBy: 'BRAIN' }]);
    const after = await requestsFor(goal.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.state).toBe('WITHDRAWN');
    expect(await decisionsFor(goal.id)).toHaveLength(1);

    // Later ticks withdraw nothing more, decide nothing new and ask nobody.
    const again = await advanceResearchGoals();
    expect(again.withdrawn).toEqual([]);
    expect((await requestsFor(goal.id)).map((r) => r.state)).toEqual(['WITHDRAWN']);
    expect(await decisionsFor(goal.id)).toHaveLength(1);
    expect(await ceilings(goal.id)).toEqual(before);
  });

  it('never reaches back through a request a person already answered', async () => {
    const goal = await newGoal('Improve: Goal research rounds end without a report');
    await spendOnePacket(goal.id);
    await advanceResearchGoals();
    const [open] = await requestsFor(goal.id);
    const answered = await answerHumanRequest({ requestId: open!.id, actorUserId: userId, choice: 'LEAVE_STOPPED' });
    expect(answered.ok).toBe(true);
    await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [ARCHITECTURE_SLUG, fixture.project.id]);

    const report = await advanceResearchGoals();
    expect(report.withdrawn).toEqual([]);
    expect((await requestsFor(goal.id)).map((r) => r.state)).toEqual(['ANSWERED']);
  });
});

describe('a ceiling on a research goal in any other project', () => {
  it('still asks a person exactly once, as before', async () => {
    const goal = await newGoal('Telemarketing employment');
    await spendOnePacket(goal.id);
    const before = await ceilings(goal.id);

    const report = await advanceResearchGoals();
    expect(report.stopped).toEqual([{ goalId: goal.id, ceiling: 'PACKETS', asked: true }]);
    expect((await advanceResearchGoals()).withdrawn).toEqual([]);

    const requests = await requestsFor(goal.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toBe('OPEN');
    expect(requests[0]!.authority_needed).toMatch(/PACKETS/);
    expect(await decisionsFor(goal.id)).toHaveLength(0);
    expect(await ceilings(goal.id)).toEqual(before);
  });
});
