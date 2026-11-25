/**
 * GOAL_PLAN.OPENINGS.SEARCH_WIDENS (2026-11-25, attempt 1): a goal short of a
 * recommendable plan keeps searching when its live cap is held by rounds that
 * never launched.
 *
 * Production read 0 of 20 short goals opening a round in the window, recorded
 * as "live cap full of stalled rounds": every OPEN round whose idea never
 * became a mission counted as still researching, so the goal's lens search
 * stopped for as long as the research grant kept them queued. The first case
 * fails on a46ae60. The rest hold the bounds: a fresh unlaunched round and a
 * round with a running mission keep their slots, and stalled rounds yield at
 * most the cap, so a goal never holds more than twice its cap open.
 *
 * Repair F2 (steady state): at twice its cap a goal whose rounds kept stalling
 * opened nothing again, so the failure returned one burst later. Past the
 * yield the oldest stalled round is now retired for the next lens: the goal
 * keeps opening rounds for as long as it is short, never above twice its cap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { getDb } from '../server/db/database.ts';
import { MAX_LIVE_GOAL_ROUNDS, openGoalDiscovery, roundsHoldingSlots, SIGNAL_LANE, STALLED_ROUND_YIELDS_AFTER_MS } from '../server/services/cash/discovery.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `stalled-rounds-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
});

/** A live goal short of a plan, and a way to ask its next lens round at a given time. */
async function shortGoal() {
  const { createWorkstream, getWorkstream } = await import('../server/repos/register.ts');
  const { setTerms } = await import('../server/services/goals/decide.ts');
  const { setTarget } = await import('../server/services/goals/target.ts');
  const { forgetGoalReadings, readGoalPlan } = await import('../server/services/goals/plan.ts');
  const day = 24 * 60 * 60 * 1000;
  forgetGoalReadings();
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 25 * day).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 1_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, hoursCeiling: 200, now: new Date(Date.now() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  const w = (await getWorkstream(g.id))!;
  const target = (await readGoalPlan({ goalId: g.id, evaluations: 200 }))!.target;
  const ask = (now = new Date().toISOString()) => openGoalDiscovery({ goal: w, target, bestReach: null, now, liveCap: MAX_LIVE_GOAL_ROUNDS });
  const open = async () => (await listRounds(projectId)).filter((r) => r.state === 'OPEN' && r.bucketId.startsWith(`goal-${g.id}`));
  return { ask, open };
}

/** Back-date rounds so their ideas have waited `hours` past the stall threshold with no mission. */
async function age(ids: readonly string[], hours: number): Promise<void> {
  const at = new Date(Date.now() - STALLED_ROUND_YIELDS_AFTER_MS - hours * 3_600_000).toISOString();
  for (const id of ids) await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [at, id]);
}

/** A running mission, with one fragment still being researched, launched from a round's idea. */
async function running(candidateId: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a goal lens' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a goal lens', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id,
      geography: 'anywhere',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'],
      completionCriteria: ['one dated request'], minIndependentSources: 1, maxRepairs: 2,
      fragmentIndex: 0, fragmentKey: 'goal-lens', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const { mission } = await launchMission({
    projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a goal lens', whyNow: 'the goal is live',
    idempotencyKey: `mission:${orchestration.id}`, candidateId, attempt: 1,
  } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
}

describe('a short goal keeps searching past rounds that never launched (CAPABILITY:GOAL_PLAN.OPENINGS.SEARCH_WIDENS)', () => {
  it('opens a new lens round once the rounds filling its live cap have stalled with no mission', async () => {
    const { ask, open } = await shortGoal();
    for (let i = 0; i < MAX_LIVE_GOAL_ROUNDS; i += 1) expect(await ask()).not.toBeNull();
    const held = await open();
    expect(held).toHaveLength(MAX_LIVE_GOAL_ROUNDS);
    // Just opened, they may still launch on the next tick: they hold the cap.
    expect(await ask()).toBeNull();
    // Two hours with no mission is still inside a few grant cycles: they hold it.
    const twoHours = new Date(Date.now() - 2 * 3_600_000).toISOString();
    for (const r of held) await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [twoHours, r.id]);
    expect(await ask()).toBeNull();
    // Past the stall threshold with no mission: queued for the research grant, researching nothing.
    await age(held.map((r) => r.id), 2);
    const next = await ask();
    expect(next).not.toBeNull();
    expect(next!.bucketId).not.toContain('-mx-');
    // The waiting rounds keep their rows: nothing is launched or retired for them.
    for (const r of held) expect((await listRounds(projectId)).find((x) => x.id === r.id)!.state).toBe('OPEN');
  });

  it('a round whose research is running keeps its slot however old it is', async () => {
    const { ask, open } = await shortGoal();
    for (let i = 0; i < MAX_LIVE_GOAL_ROUNDS; i += 1) expect(await ask()).not.toBeNull();
    const held = await open();
    for (const r of held) await running(r.candidateId);
    await age(held.map((r) => r.id), 2);
    expect(await roundsHoldingSlots(await open(), new Date().toISOString(), MAX_LIVE_GOAL_ROUNDS)).toBe(MAX_LIVE_GOAL_ROUNDS);
    expect(await ask()).toBeNull();
  });

  it('stalled rounds yield at most the cap, so a shut grant never lets a goal hold more than twice its cap open', async () => {
    const { ask, open } = await shortGoal();
    for (let pass = 0; pass < 4 * MAX_LIVE_GOAL_ROUNDS; pass += 1) {
      await age((await open()).map((r) => r.id), 2);
      await ask();
    }
    expect((await open()).length).toBe(2 * MAX_LIVE_GOAL_ROUNDS);
  });

  it('keeps searching however long its rounds stay stalled: past twice its cap the oldest stalled round gives its place to the next lens', async () => {
    const { ask, open } = await shortGoal();
    // A burst fills twice the cap; then the cause persists for many more stall windows.
    for (let pass = 0; pass < 2 * MAX_LIVE_GOAL_ROUNDS; pass += 1) {
      await age((await open()).map((r) => r.id), 2);
      expect(await ask()).not.toBeNull();
    }
    expect((await open()).length).toBe(2 * MAX_LIVE_GOAL_ROUNDS);
    const opened = new Set((await open()).map((r) => r.id));
    for (let pass = 0; pass < 3 * MAX_LIVE_GOAL_ROUNDS; pass += 1) {
      const before = await open();
      await age(before.map((r) => r.id), 2 + pass);
      // Days pass: lenses retired earlier have served their cool-off and may be asked again.
      await getDb().run(
        "UPDATE cash_discovery_rounds SET harvested_at = ? WHERE project_id = ? AND state = 'ABANDONED'",
        [new Date(Date.now() - 2 * 24 * 3_600_000).toISOString(), projectId],
      );
      const oldest = [...(await open())].sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id))[0]!;
      // Still short, every round stalled: the goal opens a new round rather than stopping.
      const next = await ask();
      expect(next).not.toBeNull();
      const after = await open();
      // Bounded: never more than twice its cap open.
      expect(after.length).toBe(2 * MAX_LIVE_GOAL_ROUNDS);
      for (const r of after) opened.add(r.id);
      // The oldest stalled round is retired, with its row kept, its idea unable to launch beside its replacement.
      const retired = (await listRounds(projectId)).find((x) => x.id === oldest.id)!;
      expect(retired.state).toBe('ABANDONED');
      const idea = await getDb().get<{ state: string }>('SELECT state FROM russell_candidates WHERE id = ?', [oldest.candidateId]);
      expect(idea!.state).toBe('REJECTED');
    }
    // Every pass asked a round that was not open before.
    expect(opened.size).toBe(5 * MAX_LIVE_GOAL_ROUNDS);
    // The retirement is recorded, not silent.
    const stopped = await getDb().all<{ id: string }>(
      "SELECT id FROM cash_events WHERE project_id = ? AND kind = 'CASH_DISCOVERY_ROUND_STOPPED'",
      [projectId],
    );
    expect(stopped.length).toBe(3 * MAX_LIVE_GOAL_ROUNDS);
  });

  it('fresh rounds beside the yielded stalled ones still hold the cap: only past the yield is anything retired', async () => {
    const { ask, open } = await shortGoal();
    for (let i = 0; i < MAX_LIVE_GOAL_ROUNDS; i += 1) expect(await ask()).not.toBeNull();
    await age((await open()).map((r) => r.id), 2);
    for (let i = 0; i < MAX_LIVE_GOAL_ROUNDS; i += 1) expect(await ask()).not.toBeNull();
    // Cap stalled (yielded) and cap fresh: the fresh ones may still launch, so nothing is retired.
    expect(await ask()).toBeNull();
    expect((await open()).length).toBe(2 * MAX_LIVE_GOAL_ROUNDS);
    expect((await listRounds(projectId)).filter((r) => r.state === 'ABANDONED')).toHaveLength(0);
  });
});
