/**
 * GOAL_PLAN.OPENINGS.SEARCH_WIDENS (2026-11-25): a goal short of a
 * recommendable plan keeps searching when its live cap is held by rounds that
 * never launched.
 *
 * Production read 0 of 20 short goals opening a round in the window, recorded
 * as "live cap full of stalled rounds": every OPEN round whose idea never
 * became a mission counted as still researching, so the goal's lens search
 * stopped for as long as the research grant kept them queued.
 *
 * Driven through the entry points production runs, in production's order: the
 * discovery pass (`harvest` → `closeEndedRounds`) and then the goal pass
 * (`advanceGoalPlans` → `widenGoalSearch` → `openGoalDiscovery`). The research
 * grant's slots decide which state is reachable:
 *
 *   - slots free: the discovery pass retires a goal round unlaunched past
 *     `UNLAUNCHED_GOAL_ROUND_MS`, so its slot frees by the ordinary rule and
 *     no yield is involved (or allowed — review F3);
 *   - slots full: the discovery pass keeps the round OPEN (the wait is the
 *     grant's, not the idea's), which is the production reading. The grant is
 *     filled with research missions that are actually running, the goal pass
 *     still opens a lens round, and when one of those missions ends the next
 *     discovery pass retires the stalled rounds, so the yield lasts exactly as
 *     long as the grant's wait;
 *   - slots full for as long as it lasts (repair F2): past the yield the
 *     stalled round at the tail of the goal's launch queue gives its place to
 *     the next lens, so the goal keeps asking every pass, never holds more
 *     than twice its cap open, and never discards the head of its queue —
 *     the idea a freed grant slot would launch next.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createGoal, releaseReservation, reserve } from '../server/repos/russellAuthority.ts';
import { researchMissionSlots, researchMissionSlotsFull, RESEARCH_WORK_CLASS } from '../server/services/russell/launch.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { cashSpareSurfaces } from '../server/services/cash/researchRoom.ts';
import { getDb } from '../server/db/database.ts';
import {
  constructedShare,
  harvest,
  MAX_LIVE_GOAL_ROUNDS,
  openDiscovery,
  roundsHoldingSlots,
  SIGNAL_LANE,
  STALLED_ROUND_YIELDS_AFTER_MS,
  UNLAUNCHED_GOAL_ROUND_MS,
} from '../server/services/cash/discovery.ts';
import type { CashDiscoveryRound, Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;
let goalId = '';

/** The research grant's at-once ceiling in these tests. */
const GRANT_SLOTS = 2;

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
  const { forgetGoalReadings } = await import('../server/services/goals/plan.ts');
  forgetGoalReadings();
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  goalId = await shortGoal();
});

/** A live goal far short of its target, so every plan read wants more openings. */
async function shortGoal(): Promise<string> {
  const { createWorkstream, getWorkstream } = await import('../server/repos/register.ts');
  const { setTerms } = await import('../server/services/goals/decide.ts');
  const { setTarget } = await import('../server/services/goals/target.ts');
  const day = 24 * 60 * 60 * 1000;
  const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
  await setTerms(g.id, { dueAt: new Date(Date.now() + 25 * day).toISOString(), ownerUserId: userId }, `person:${userId}`);
  expect(
    (await setTarget({
      goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 100_000_000, currency: 'USD', projectId,
      capitalCeilingCents: 300_000, hoursCeiling: 200, now: new Date(Date.now() - 60_000),
    } as Parameters<typeof setTarget>[0])).ok,
  ).toBe(true);
  return g.id;
}

/** The project's standing research grant, created with `GRANT_SLOTS` at-once slots when the project has none. */
async function grant(): Promise<{ goalId: string; cap: number }> {
  const held = await researchMissionSlots(projectId);
  if (held) {
    await getDb().run('UPDATE russell_goals SET max_concurrent = ? WHERE id = ?', [GRANT_SLOTS, held.goalId]);
    return { goalId: held.goalId, cap: GRANT_SLOTS };
  }
  const made = await createGoal({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'Research grant',
    allowedWork: [RESEARCH_WORK_CLASS], maxMissions: 100, maxFragments: 1000, maxConcurrent: GRANT_SLOTS, maxProbes: 10,
  });
  return { goalId: made.id, cap: GRANT_SLOTS };
}

/** The goal's own OPEN rounds. */
async function goalRounds(): Promise<CashDiscoveryRound[]> {
  return (await listRounds(projectId)).filter((r) => r.state === 'OPEN' && r.bucketId.startsWith(`goal-${goalId}`));
}

/** Back-date rounds so their ideas have waited `hours` past both stall thresholds with no mission. */
async function age(rounds: readonly CashDiscoveryRound[], hours: number): Promise<void> {
  const at = new Date(Date.now() - Math.max(STALLED_ROUND_YIELDS_AFTER_MS, UNLAUNCHED_GOAL_ROUND_MS) - hours * 3_600_000).toISOString();
  for (const r of rounds) await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [at, r.id]);
}

/** Goal passes from `start`, one per plan refresh, until the goal's live cap is held (no round asked). */
async function fillGoalCap(start: number): Promise<number> {
  const { advanceGoalPlans } = await import('../server/services/goals/plan.ts');
  let k = 0;
  let asked = 0;
  for (; k < 4 * MAX_LIVE_GOAL_ROUNDS; k += 1) {
    const pass = await advanceGoalPlans(new Date(start + k * 31 * 60_000));
    asked += pass.asked;
    if (k > 0 && pass.asked === 0) break;
  }
  expect(asked).toBeGreaterThanOrEqual(1);
  // Lens and constructed rounds together hold the goal's live cap.
  expect((await goalRounds()).length).toBeGreaterThanOrEqual(MAX_LIVE_GOAL_ROUNDS);
  return k + 1;
}

/** One goal pass at refresh `k`: how many lens rounds it asked through `widenGoalSearch`. */
async function goalPass(start: number, k: number): Promise<number> {
  const { advanceGoalPlans } = await import('../server/services/goals/plan.ts');
  return (await advanceGoalPlans(new Date(start + k * 31 * 60_000))).asked;
}

/** A running mission with one fragment still being researched, launched from this idea, holding one grant slot. */
async function running(candidateId: string, grantId: string | null): Promise<{ missionId: string; holdId: string | null }> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a discovery question' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a discovery question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id,
      geography: 'anywhere',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'],
      completionCriteria: ['one dated request'], minIndependentSources: 1, maxRepairs: 2,
      fragmentIndex: 0, fragmentKey: 'discovery', question: 'Who pays?', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const { mission } = await launchMission({
    projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a discovery question', whyNow: 'the sprint is live',
    idempotencyKey: `mission:${orchestration.id}`, candidateId, attempt: 1,
  } as Parameters<typeof launchMission>[0]);
  await linkMission({ missionId: mission.id, orchestrationId: orchestration.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  if (!grantId) return { missionId: mission.id, holdId: null };
  const hold = await reserve({ goalId: grantId, kind: 'MISSION', idempotencyKey: `stalled-rounds-hold:${mission.id}`, ttlMinutes: 24 * 60 });
  expect(hold.ok).toBe(true);
  return { missionId: mission.id, holdId: hold.reservation!.id };
}

/** Fill every slot of the grant with broad discovery research that is actually running. */
async function fillGrant(grantId: string, slots: number): Promise<{ missionId: string; holdId: string }[]> {
  const broad = await openDiscovery({ projectId, limit: slots });
  expect(broad.length).toBeGreaterThanOrEqual(slots);
  const out: { missionId: string; holdId: string }[] = [];
  for (const one of broad.slice(0, slots)) {
    const r = await running(one.candidateId, grantId);
    out.push({ missionId: r.missionId, holdId: r.holdId! });
  }
  expect(await researchMissionSlotsFull(projectId)).toBe(true);
  return out;
}

/**
 * The bound a full grant leaves: at most twice the live cap of lens rounds
 * open, and constructed rounds only inside their own reserved share
 * (`constructedShare`). The goal pass raises the live cap by the research
 * surfaces idle at that moment (`cashSpareSurfaces`), so the bound is read
 * against the cap the pass used.
 */
async function expectBounded(open: readonly CashDiscoveryRound[], spare: number): Promise<void> {
  const liveCap = MAX_LIVE_GOAL_ROUNDS + Math.max(0, spare, await cashSpareSurfaces(projectId));
  const lens = open.filter((r) => !r.bucketId.includes('-mx-'));
  expect(lens.length).toBeLessThanOrEqual(2 * liveCap);
  expect(open.length).toBeLessThanOrEqual(2 * liveCap + constructedShare(liveCap));
}

async function stopCauses(): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const e of await listCashEvents(projectId, 500)) {
    if (e.kind === 'CASH_DISCOVERY_ROUND_STOPPED') out.set(String((e.detail as Record<string, unknown>).roundId), (e.detail as Record<string, unknown>).cause);
  }
  return out;
}

describe('a short goal keeps searching past rounds that never launched (CAPABILITY:GOAL_PLAN.OPENINGS.SEARCH_WIDENS)', () => {
  it('grant full: the discovery pass keeps the stalled rounds OPEN, the goal pass still opens a lens round, and the yield ends with the wait', async () => {
    const g = await grant();
    const start = Date.now();
    const k = await fillGoalCap(start);
    const stalled = await goalRounds();
    expect(stalled.length).toBeGreaterThanOrEqual(MAX_LIVE_GOAL_ROUNDS);

    // Every slot of the research grant is held by research that is running: the goal's ideas are queued behind it.
    const busy = await fillGrant(g.goalId, g.cap);
    await age(stalled, 2);

    // The discovery pass runs first, as in production: with the grant full the wait is the grant's, so it retires nothing.
    await harvest({ projectId, limit: 50 });
    const after = await goalRounds();
    for (const r of stalled) expect(after.some((x) => x.id === r.id)).toBe(true);

    // The production reading: the goal's cap is full of rounds that research nothing. The goal pass still asks a lens.
    expect(await goalPass(start, k)).toBeGreaterThanOrEqual(1);
    const fresh = (await goalRounds()).filter((r) => !stalled.some((s) => s.id === r.id));
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.some((r) => !r.bucketId.includes('-mx-'))).toBe(true);

    // Research runs throughout: the grant's slots are the running broad missions, unchanged by the goal's ask.
    expect((await researchMissionSlots(projectId))!.live).toBe(g.cap);
    // One of them ends: its slot frees, and the next discovery pass retires the stalled rounds by the ordinary rule.
    await transitionMission({ missionId: busy[0]!.missionId, from: 'RUNNING', to: 'DONE' });
    expect(await releaseReservation({ reservationId: busy[0]!.holdId, reason: 'mission done' })).toBe(true);
    expect(await researchMissionSlotsFull(projectId)).toBe(false);
    await harvest({ projectId, limit: 50 });
    const causes = await stopCauses();
    const rounds = await listRounds(projectId);
    for (const r of stalled) {
      expect(rounds.find((x) => x.id === r.id)!.state).toBe('ABANDONED');
      expect(causes.get(r.id)).toBe('ROUND_CAP_UNLAUNCHED_6H');
    }
    // The fresh rounds are untouched and hold their slots; nothing yields once the grant has room.
    for (const r of fresh) expect(rounds.find((x) => x.id === r.id)!.state).toBe('OPEN');
    expect(await roundsHoldingSlots(await goalRounds(), new Date().toISOString(), MAX_LIVE_GOAL_ROUNDS)).toBe((await goalRounds()).length);
  });

  it('grant with room: the discovery pass retires the stalled rounds and the goal pass reopens with no yield', async () => {
    await grant();
    expect(await researchMissionSlotsFull(projectId)).toBe(false);
    const start = Date.now();
    const k = await fillGoalCap(start);
    const stalled = await goalRounds();
    await age(stalled, 2);
    // Before the discovery pass has run, a slot is free: nothing yields, the cap holds (production retires them next).
    const aged = await goalRounds();
    expect(aged.every((r) => Date.now() - Date.parse(r.openedAt) > STALLED_ROUND_YIELDS_AFTER_MS)).toBe(true);
    expect(await roundsHoldingSlots(aged, new Date().toISOString(), MAX_LIVE_GOAL_ROUNDS)).toBe(stalled.length);
    await harvest({ projectId, limit: 50 });
    const rounds = await listRounds(projectId);
    for (const r of stalled) expect(rounds.find((x) => x.id === r.id)!.state).toBe('ABANDONED');
    expect(await goalPass(start, k)).toBeGreaterThanOrEqual(1);
  });

  it('a round whose research is running keeps its slot however old it is, even with the grant full', async () => {
    const g = await grant();
    const start = Date.now();
    await fillGoalCap(start);
    const held = await goalRounds();
    // The goal's own missions take the grant's slots, as many as there are.
    let used = 0;
    for (const r of held) {
      await running(r.candidateId, used < g.cap ? g.goalId : null);
      used += 1;
    }
    if (used < g.cap) await fillGrant(g.goalId, g.cap - used);
    expect(await researchMissionSlotsFull(projectId)).toBe(true);
    await age(held, 2);
    await harvest({ projectId, limit: 50 });
    expect(await roundsHoldingSlots(await goalRounds(), new Date().toISOString(), MAX_LIVE_GOAL_ROUNDS)).toBe(held.length);
  });

  it('with the grant full, stalled rounds yield at most the cap, so a goal never holds more than twice its cap open', async () => {
    const g = await grant();
    const start = Date.now();
    let k = await fillGoalCap(start);
    await fillGrant(g.goalId, g.cap);
    for (let pass = 0; pass < 4 * MAX_LIVE_GOAL_ROUNDS; pass += 1) {
      await age(await goalRounds(), 2);
      await harvest({ projectId, limit: 50 });
      const spare = await cashSpareSurfaces(projectId);
      await goalPass(start, k++);
      await expectBounded(await goalRounds(), spare);
    }
    expect(await roundsHoldingSlots(await goalRounds(), new Date().toISOString(), MAX_LIVE_GOAL_ROUNDS)).toBeGreaterThanOrEqual(MAX_LIVE_GOAL_ROUNDS);
  });

  it('keeps searching however long the grant stays full: past the yield the stalled round at the tail of the launch queue gives its place to the next lens (repair F2)', async () => {
    const g = await grant();
    const start = Date.now();
    let k = await fillGoalCap(start);
    await fillGrant(g.goalId, g.cap);
    const passes = 4 * MAX_LIVE_GOAL_ROUNDS;
    const seen = new Set((await goalRounds()).map((r) => r.id));
    for (let pass = 0; pass < passes; pass += 1) {
      await age(await goalRounds(), 2);
      // Days pass: a lens retired earlier has served its cool-off and may be asked again.
      await getDb().run(
        "UPDATE cash_discovery_rounds SET harvested_at = ? WHERE project_id = ? AND state = 'ABANDONED'",
        [new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(), projectId],
      );
      // Production's order: the discovery pass (which retires nothing while the grant is full), then the goal pass.
      await harvest({ projectId, limit: 50 });
      const spare = await cashSpareSurfaces(projectId);
      // Still short, every round stalled behind a full grant: the goal asks a lens every pass, never stopping at 2x its cap.
      expect(await goalPass(start, k++)).toBeGreaterThanOrEqual(1);
      const open = await goalRounds();
      await expectBounded(open, spare);
      for (const r of open) seen.add(r.id);
      // Research runs throughout: the grant's slots stay held by the running broad missions.
      expect((await researchMissionSlots(projectId))!.live).toBe(g.cap);
    }
    // The rounds that gave their place are kept, ABANDONED, their ideas unable to launch, and each retirement recorded.
    const causes = await stopCauses();
    const retired = (await listRounds(projectId)).filter((r) => r.state === 'ABANDONED' && r.bucketId.startsWith(`goal-${goalId}`));
    expect(retired.length).toBeGreaterThanOrEqual(passes - MAX_LIVE_GOAL_ROUNDS);
    for (const r of retired) {
      expect(causes.get(r.id)).toBe('ROUND_CAP_UNLAUNCHED_6H');
      const idea = await getDb().get<{ state: string }>('SELECT state FROM russell_candidates WHERE id = ?', [r.candidateId]);
      expect(idea!.state).toBe('REJECTED');
    }
    expect(seen.size).toBeGreaterThan(2 * MAX_LIVE_GOAL_ROUNDS + passes - MAX_LIVE_GOAL_ROUNDS - 1);
  });

  it('never discards the head of the goal\'s launch queue to make room: the idea a freed slot would launch next keeps its turn (review F2)', async () => {
    const g = await grant();
    const start = Date.now();
    let k = await fillGoalCap(start);
    await fillGrant(g.goalId, g.cap);
    // The head of the goal's queue, in the launch queue's own order (`nextLaunchable`): priority, ordinal, created.
    // Only a lens round gives its place to a lens (constructed rounds keep their own share), so the head is read among them.
    const open = (await goalRounds()).filter((r) => !r.bucketId.includes('-mx-'));
    expect(open.length).toBeGreaterThanOrEqual(2);
    const ids = open.map((r) => r.candidateId);
    const head = await getDb().get<{ id: string }>(
      `SELECT id FROM russell_candidates WHERE id IN (${ids.map(() => '?').join(',')})
        ORDER BY CASE priority WHEN 'MUST_DO' THEN 0 WHEN 'BIG_MOVE' THEN 1 WHEN 'WORTH_DOING' THEN 2 WHEN 'EXPLORE' THEN 3 ELSE 4 END,
                 COALESCE(ordinal, 999), created_at, rowid LIMIT 1`,
      ids,
    );
    const headRound = open.find((r) => r.candidateId === head!.id)!;
    for (let pass = 0; pass < 2 * MAX_LIVE_GOAL_ROUNDS; pass += 1) {
      await age(await goalRounds(), 2);
      // The head has also waited longest: retiring the oldest would discard exactly the idea launched next.
      await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [new Date(Date.now() - UNLAUNCHED_GOAL_ROUND_MS - 48 * 3_600_000).toISOString(), headRound.id]);
      await harvest({ projectId, limit: 50 });
      expect(await goalPass(start, k++)).toBeGreaterThanOrEqual(1);
      expect((await listRounds(projectId)).find((r) => r.id === headRound.id)!.state).toBe('OPEN');
      const idea = await getDb().get<{ state: string }>('SELECT state FROM russell_candidates WHERE id = ?', [head!.id]);
      expect(idea!.state).not.toBe('REJECTED');
    }
    // The search still moved on: rounds behind the head gave their places.
    expect((await listRounds(projectId)).filter((r) => r.state === 'ABANDONED' && r.bucketId.startsWith(`goal-${goalId}`)).length).toBeGreaterThanOrEqual(1);
  });
});
