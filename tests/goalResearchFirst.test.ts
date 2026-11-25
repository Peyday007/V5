/**
 * Research serving any approved, live goal goes ahead of untargeted backlog.
 *
 * Production 2026-11-24: the goals created 11-19, each with its own project and
 * research grant, carried 13–15 research bins READY at 0/5 for five days while
 * ~914 ideas waited Brain-wide. The grants already isolate launch slots per
 * project; what starved the goals was the shared order — ideas, queue items,
 * bins and parked packets — which recognised a goal's research only when it was
 * filed under a `goal-…` round bucket (or, for bins and parks, one hard-coded
 * owner goal). Research a live goal links is now goal work in every one of
 * those orders, and a paused goal's research drops back into the ordinary one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { claimWork, enqueueWork } from '../server/repos/workQueue.ts';
import { createWorker } from '../server/repos/identity.ts';
import { createBin, listDispatchableBins } from '../server/repos/bins.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { pauseGoal } from '../server/repos/goals.ts';
import { goalFirstSql } from '../server/services/goals/goalWork.ts';
import { servesGoalSearch } from '../server/services/research/packetRunner.ts';
import { judgeParkedPacketIds } from '../server/services/research/judgeRound.ts';

let t: TestProject;
let layerId = '';
let n = 0;

beforeEach(async () => {
  t = await freshProject();
  layerId = (await t.layerByName('Discovery Logic')).id;
});

afterEach(async () => {
  await teardown();
});

/** A goal a person set with a target, as `brain_operator_create_goal` leaves it. */
async function liveGoal(): Promise<string> {
  const id = `wst_${(++n).toString(16).padStart(8, '0')}abcdef`;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO workstreams (id, project_id, title, intent, purpose, target_metric, target_amount_cents, target_currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'REVENUE_DIRECT', 'SETTLED_CASH', 500000, 'USD', ?, ?)`,
    [id, t.project.id, 'Earn 5,000 dollars', 'Earn 5,000 dollars a month', now, now],
  );
  return id;
}

async function link(goalId: string, kind: string, ref: string): Promise<void> {
  await getDb().run(
    `INSERT INTO workstream_links (id, workstream_id, kind, ref, relation, recorded_by, created_at)
     VALUES (?, ?, ?, ?, 'PURSUES', 'BRAIN', ?)`,
    [`wsl_${++n}`, goalId, kind, ref, new Date().toISOString()],
  );
}

async function packet(label: string): Promise<string> {
  const run = await createRun({ projectId: t.project.id, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: label });
  const created = await createOrchestration({ projectId: t.project.id, layerId, runId: run.id, title: label, assignment: label, provider: 'WORKER', autoApprove: false });
  return created.id;
}

async function mission(orchestrationId: string, candidateId: string | null = null): Promise<string> {
  const id = `rms_${++n}`;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO russell_missions (id, project_id, candidate_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'who pays', 'the plan needs it', 'RUNNING', ?, ?, ?, ?)`,
    [id, t.project.id, candidateId, orchestrationId, `key_${id}`, now, now],
  );
  return id;
}

async function bin(orchestrationId: string, createdAt: string): Promise<string> {
  const created = await createBin({
    projectId: t.project.id,
    layerId,
    orchestrationId,
    kind: 'RESEARCH_PACKET',
    title: 'a packet',
    objective: 'Research it.',
    manifest: {
      objective: 'Research it.',
      why: 'because',
      lineage: { projectId: t.project.id, layerId, goal: null, orchestrationId },
      units: [],
      acceptableSources: [],
      excludedSources: [],
      evidence: [],
      outputs: [],
      authorizedActions: [],
      prohibitedActions: [],
      budgetUnits: 1,
      retry: { maxAttempts: 3, backoffSeconds: 30 },
      stoppingConditions: ['filed'],
    },
    completionContract: 'DETERMINISTIC_UNITS_V1',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
    priority: 7,
  });
  await getDb().run(`UPDATE bins SET created_at = ? WHERE id = ?`, [createdAt, created.id]);
  return created.id;
}

describe('a live goal’s linked research', () => {
  it('is launched and judged in the goal tier, and leaves it when the goal is paused', async () => {
    const goal = await liveGoal();
    const backlog = await createCandidate({ title: 'untargeted discovery', statement: 'what sells in bulk somewhere', projectId: t.project.id });
    const direct = await createCandidate({ title: 'the goal’s question', statement: 'who buys this recurring service', projectId: t.project.id });
    const viaMission = await createCandidate({ title: 'the goal’s other question', statement: 'what such buyers pay a month', projectId: t.project.id });
    await link(goal, 'CANDIDATE', direct.id);
    await link(goal, 'MISSION', await mission(await packet('priced'), viaMission.id));

    const tier = async (id: string) =>
      Number((await getDb().get<{ k: number }>(`SELECT ${goalFirstSql('c')} AS k FROM russell_candidates c WHERE c.id = ?`, [id]))!.k);
    expect(await tier(backlog.id)).toBe(3);
    expect(await tier(direct.id)).toBe(2);
    expect(await tier(viaMission.id)).toBe(2);

    expect(await pauseGoal(goal, 'not now')).toBe(true);
    expect(await tier(direct.id)).toBe(3);
    expect(await tier(viaMission.id)).toBe(3);
  });

  it('is claimed from the shared queue ahead of untargeted backlog at the same priority', async () => {
    const goal = await liveGoal();
    const backlogPacket = await packet('backlog');
    const goalPacket = await packet('goal');
    await link(goal, 'PACKET', goalPacket);
    // The backlog item is older, so the old order (priority, then age) handed it out first.
    const older = await enqueueWork({ projectId: t.project.id, workType: 'RESEARCH_FRAGMENT', payload: {}, requiredScopes: ['queue:claim'], orchestrationId: backlogPacket, priority: 6, createdByType: 'SYSTEM' });
    await getDb().run(`UPDATE work_items SET available_at = '2026-11-01T00:00:00.000Z', created_at = '2026-11-01T00:00:00.000Z' WHERE id = ?`, [older.id]);
    const goals = await enqueueWork({ projectId: t.project.id, workType: 'RESEARCH_FRAGMENT', payload: {}, requiredScopes: ['queue:claim'], orchestrationId: goalPacket, priority: 6, createdByType: 'SYSTEM' });
    const worker = await createWorker({ name: `goal-first-${++n}`, displayName: 'w', createdByType: 'SYSTEM', createdById: 'test' });

    const [first] = await claimWork({ workerId: worker.id, scopes: [{ projectId: t.project.id, scopes: ['queue:claim'] }], workTypes: ['RESEARCH_FRAGMENT'] });
    expect(first?.workItemId).toBe(goals.id);
    // Within ceilings: a higher priority still wins, the goal key is only an order inside one.
    expect(await servesGoalSearch(goalPacket)).toBe(true);
    expect(await servesGoalSearch(backlogPacket)).toBe(false);
  });

  it('is offered as a bin ahead of older backlog bins at the same priority', async () => {
    const goal = await liveGoal();
    const backlogPacket = await packet('backlog');
    const goalPacket = await packet('goal');
    const backlogBin = await bin(backlogPacket, '2026-11-01T00:00:00.000Z');
    const goalBin = await bin(goalPacket, '2026-11-20T00:00:00.000Z');
    const order = async () => (await listDispatchableBins(50)).map((one) => one.id).filter((id) => id === backlogBin || id === goalBin);
    expect(await order()).toEqual([backlogBin, goalBin]);
    await link(goal, 'MISSION', await mission(goalPacket));
    expect(await order()).toEqual([goalBin, backlogBin]);
    await pauseGoal(goal, 'not now');
    // Paused: its bins are held by the pause's own machinery, and its order is ordinary again.
    expect(await servesGoalSearch(goalPacket)).toBe(false);
  });

  it('resumes a judge-parked packet of any live goal ahead of older ordinary parks', async () => {
    const goal = await liveGoal();
    const park = async (label: string, at: string) => {
      const id = await packet(label);
      const audit = `aud_${id}`;
      await getDb().run(`INSERT INTO audits (id, project_id, verdict, created_at) VALUES (?, ?, 'MORE_RESEARCH', ?)`, [audit, t.project.id, at]);
      await getDb().run(
        `UPDATE research_orchestrations SET status = 'NEEDS_HUMAN', verdict = 'MORE_RESEARCH', audit_id = ?, updated_at = ? WHERE id = ?`,
        [audit, at, id],
      );
      return id;
    };
    const oldest = await park('oldest', '2026-11-01T00:00:00.000Z');
    const goals = await park('the goal’s', '2026-11-24T00:00:00.000Z');
    expect(await judgeParkedPacketIds()).toEqual([oldest, goals]);
    await link(goal, 'PACKET', goals);
    expect(await judgeParkedPacketIds()).toEqual([goals, oldest]);
  });
});
