/**
 * A live goal's ideas are judged and launched in each project's turn, not in
 * the order of the Brain-wide backlog.
 *
 * Production, 2026-11-25: twelve fresh evaluation goals, each its own project
 * with its own research grant, had route deep dives started 04:00-07:04Z
 * (CASH_VALIDATION_STARTED x4-6 per project, linked to the goal as
 * CANDIDATE/PURSUES) and no research packet hours later, while RESEARCH_SLOTS
 * read "43-56 launchable idea(s) have a free slot in their own project's
 * grant" sample after sample. Judging took the oldest goal ideas Brain-wide
 * and a launch pass started the best-ranked fitting ideas Brain-wide, a few
 * per tick — so an older goal's deeper, better-ranked backlog took every turn
 * and a new goal waited for it to empty, though its own grant had room.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createProject } from '../server/repos/projects.ts';
import { createCandidate, recordJudgment } from '../server/repos/russellCandidates.ts';
import { SLOT_FILL_PER_TICK, GOAL_JUDGMENTS_PER_TICK, nextLaunchable, unjudgedGoalIdeas } from '../server/services/russell/loop.ts';

let userId = '';
let n = 0;

beforeEach(async () => {
  await freshProject();
  userId = (
    await createUser({
      email: `turns-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
});

afterEach(async () => {
  await teardown();
});

/** A project with a research grant and a live, person-set goal. */
async function goalProject(name: string, maxConcurrent: number): Promise<{ projectId: string; goalId: string }> {
  const projectId = (await createProject({ name: `${name} ${Math.random().toString(36).slice(2, 8)}` })).id;
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: `${name} research`,
    allowedWork: ['RESEARCH'],
    maxMissions: 100,
    maxFragments: 100,
    maxConcurrent,
    maxProbes: 1,
  });
  const goalId = `wst_${(++n).toString(16).padStart(8, '0')}turns`;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO workstreams (id, project_id, title, intent, purpose, target_metric, target_amount_cents, target_currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'REVENUE_DIRECT', 'SETTLED_CASH', 1000000, 'USD', ?, ?)`,
    [goalId, projectId, `Earn for ${name}`, `Earn for ${name}`, now, now],
  );
  return { projectId, goalId };
}

/** An idea the goal pursues (as `startValidations` links a route dive), created at `at`. */
async function goalIdea(
  goal: { projectId: string; goalId: string },
  title: string,
  at: string,
  judged: 'MUST_DO' | 'WORTH_DOING' | null,
): Promise<string> {
  const candidate = await createCandidate({ projectId: goal.projectId, title, statement: `establish ${title} from published sources` });
  await getDb().run(`UPDATE russell_candidates SET created_at = ? WHERE id = ?`, [at, candidate.id]);
  await getDb().run(
    `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
     VALUES (?, ?, 'CANDIDATE', ?, 'PURSUES', 'BRAIN', ?)`,
    [`wsl_${++n}`, goal.goalId, candidate.id, at],
  );
  if (judged) {
    await recordJudgment({
      candidateId: candidate.id,
      state: 'QUEUED',
      priority: judged,
      reason: 'test',
      judgment: { missionSpec: { projectId: goal.projectId, objective: title } },
    });
  }
  return candidate.id;
}

const hoursAgo = (h: number, i = 0) => new Date(Date.now() - h * 3_600_000 + i * 1000).toISOString();

describe('a fresh goal beside an older goal’s backlog', () => {
  it('gets a launch in the first tick’s fill though the older goal’s ideas rank higher', async () => {
    const older = await goalProject('older goal', 20);
    const fresh = await goalProject('fresh goal', 6);
    // More better-ranked, older ideas than a tick fills, all fitting free slots.
    for (let i = 0; i < SLOT_FILL_PER_TICK + 3; i += 1) await goalIdea(older, `older ${i}`, hoursAgo(24, i), 'MUST_DO');
    const diveA = await goalIdea(fresh, 'dive a', hoursAgo(2, 0), 'WORTH_DOING');
    const diveB = await goalIdea(fresh, 'dive b', hoursAgo(2, 1), 'WORTH_DOING');

    const window = await nextLaunchable(50);
    const fill = window.filter((entry) => entry.fitsFreeSlot).slice(0, SLOT_FILL_PER_TICK).map((entry) => entry.candidateId);
    // The fresh goal's best dive is in this tick's fill, second only to the older goal's best.
    expect(fill.slice(0, 2)).toContain(diveA);
    // Each project's second idea comes only after every project's first.
    expect(fill.slice(2, 4)).toContain(diveB);
    // Both grants still bound what fits: nothing beyond the window's free slots is marked.
    expect(window.filter((entry) => entry.fitsFreeSlot)).toHaveLength(SLOT_FILL_PER_TICK + 3 + 2);
  });

  it('is judged in the first tick though the older goal has more unjudged ideas than a tick judges', async () => {
    const older = await goalProject('older goal', 5);
    const fresh = await goalProject('fresh goal', 5);
    for (let i = 0; i < GOAL_JUDGMENTS_PER_TICK * 3; i += 1) await goalIdea(older, `older ${i}`, hoursAgo(24, i), null);
    const dive = await goalIdea(fresh, 'dive', hoursAgo(1), null);

    const picked = (await unjudgedGoalIdeas(GOAL_JUDGMENTS_PER_TICK)).map((one) => one.id);
    expect(picked).toHaveLength(GOAL_JUDGMENTS_PER_TICK);
    expect(picked).toContain(dive);
  });

  it("holds no cancelled or paused goal's backlog in the goal queue ahead of a live goal (fresh batch, 2026-11-26)", async () => {
    // The production shape: the backlog is the goal's price questions (`sendPortfolioNeeds`), matched as goal work by how they were made.
    const { sendPortfolioNeeds } = await import('../server/services/goals/portfolioNeeds.ts');
    const unpriced = [1, 2, 3].map((k) => ({ population: `pop_${k}`, buyer: `buyers number ${k}`, designs: 3, arrangementKey: `k${k}`, label: `Design ${k}`, question: `What does one buyer described as "buyers number ${k}" pay, in USD, for one purchase? Look for published price lists.` }));
    const portfolio = { best: null, causal: null, marketHistory: [], unpriced } as never;
    const stopped = await goalProject('cancelled goal', 5);
    const paused = await goalProject('paused goal', 5);
    const live = await goalProject('live goal', 5);
    await sendPortfolioNeeds({ goalId: stopped.goalId, projectId: stopped.projectId, portfolio });
    await sendPortfolioNeeds({ goalId: paused.goalId, projectId: paused.projectId, portfolio });
    const first = await goalIdea(live, 'live dive', hoursAgo(1), null);
    await getDb().run(`UPDATE workstreams SET cancelled_at = ? WHERE id = ?`, [hoursAgo(2), stopped.goalId]);
    await getDb().run(`UPDATE workstreams SET paused_at = ? WHERE id = ?`, [hoursAgo(2), paused.goalId]);
    const stoppedIdeas = (await getDb().all<{ id: string }>(`SELECT id FROM russell_candidates WHERE project_id IN (?, ?)`, [stopped.projectId, paused.projectId])).map((one) => one.id);
    expect(stoppedIdeas.length).toBeGreaterThan(0);

    const queue = (await unjudgedGoalIdeas(40)).map((one) => one.id);
    expect(queue).toContain(first);
    expect(queue.filter((id) => stoppedIdeas.includes(id))).toEqual([]);
  });
});
