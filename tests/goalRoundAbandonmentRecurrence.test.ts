/**
 * OPERATOR:RECURRING_OPERATIONAL_FAILURE:b8827dc192ec553e — a goal's research
 * rounds keep ending ABANDONED, so the goal pays for searches that return
 * nothing its plan can read.
 *
 * Recorded in production: 132 rounds for one cash goal ended ABANDONED in seven
 * days; five of them (org-memory, org-world and three mx kernel rounds) closed
 * within the same second, each because its idea's mission failed, was
 * cancelled, expired unlaunched or was parked. This file pins the failure class
 * at the owners that decide it, so a repair of the cause has a reproduction to
 * pass against and a regression of the recovery path is caught:
 *
 *  - `roundOutcome` / `missionsForRounds` (server/services/russell/roundMissions.ts)
 *    decide whether a round settles HARVESTED, ABANDONED, or stays OPEN;
 *  - `diagnoseGoalResearch` (server/services/goals/researchYield.ts) is what the
 *    goal's next round is told when its recent rounds ended without a report.
 *
 * What the next round must meet to end HARVESTED with a report rather than
 * ABANDONED: its idea's latest mission — a redo after a FAILED attempt
 * included — reaches DONE. A failed first attempt is not a verdict on the
 * round while a redo is still running, and a round still being worked on is
 * never counted abandoned. No bar moves here: an abandoned round is never
 * counted as one that produced a report.
 *
 * Which upstream cause it is (finding F3). The five recorded rounds closed in
 * the same second, which reads like one upstream event — a burst of missions
 * launched or cancelled faster than capacity could finish them. The last
 * describe block below drives the production paths that end goal-round
 * research and rules that reading out at each of them:
 *
 *  - The shared second is the settlement pass, not the cause.
 *    `closeEndedRounds` (server/services/cash/discovery.ts) runs once per
 *    `harvest` and closes every live round whose research has ended, stamping
 *    each with that pass's clock. Missions that stopped hours apart close in
 *    the same second, so the timestamp carries no information about why.
 *  - The cause is per round, and it is in the mission's own row. Each stop
 *    event records `cause` (the mission's `terminalReason`/`waitingOn`
 *    verbatim) and `failureClass`. The recorded reasons split into four
 *    different classes — worker lease expiry is TRAIL_TIMEOUT, "No fragment
 *    cleared its evidence gate" is MAST_TASK_VERIFICATION, a cancel is
 *    ROUND_SETTLEMENT and an unstated failure is UNATTRIBUTED. Four classes do
 *    not come from one upstream trigger.
 *  - Not over-admission by Brain's own release path. `releaseOpportunityResearch`
 *    is the production owner that cancels research missions in bulk (marketplace
 *    retirement, the goal screen's REJECT/HOLD). It never cancels the idea
 *    behind the round that discovered the opening, so it cannot be what ends a
 *    goal round.
 *  - Not load shedding of queued work. The only path that ends a goal round
 *    with no mission is the six-hour unlaunched cap (`expireUnlaunchedGoalRound`),
 *    and it refuses to fire while every research mission slot is held. A round
 *    waiting for capacity stays OPEN. The cap retires only an idea that had a
 *    free slot and still never launched, recorded as ROUND_CAP_LOGIC.
 *
 * So the recurrence is not something capacity control can fix. Each round dies
 * of its own mission's failure, and the place to read which one is
 * `diagnoseAbandonedRounds` over the stop events these tests pin.
 *
 * The repair (finding F1). What the goal fed back to its next round ignored
 * that class. `diagnoseGoalResearch` read every ABANDONED round as "no claim
 * survived the evidence check" and asked the next round to fix its citations:
 * a round that ran out of time got the same instruction as one the gate
 * refused, and rounds Brain's own settlement ended (a cancel, a mission parked
 * at a person, the unlaunched cap) counted as research that failed. So the
 * next round was asked the same kind of question and failed the same way.
 * `recentGoalRounds` now reads each abandoned round's class from its stop
 * event. The diagnosis leaves settlement endings out, and the instruction
 * follows the most common class: a narrower question for an overrun, readable
 * sources for unreachable pages, the evidence instruction for gate refusals,
 * and nothing added to the question for an execution fault it cannot change.
 * No bar moves. The evidence gate, the round outcome rule and the cap are
 * untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { getMission, launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { openDiscovery } from '../server/services/cash/discovery.ts';
import { missionsForRounds, roundOutcome } from '../server/services/russell/roundMissions.ts';
import {
  BARREN_ROUNDS_FOR_CAUSE,
  diagnoseGoalResearch,
  diagnosisInstructions,
  recentGoalRounds,
  type GoalRoundOutcome,
} from '../server/services/goals/researchYield.ts';
import type { MissionState, RussellMission } from '../server/domain/types.ts';
import { getDb } from '../server/db/database.ts';
import { getCashMode, listCashEvents, recordCashEvent } from '../server/repos/cashMode.ts';
import { closeRound, listRounds, openRound } from '../server/repos/cashDiscovery.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { reserve, setGoalConcurrency } from '../server/repos/russellAuthority.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, readGoalPlan } from '../server/services/goals/plan.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { researchMissionSlots, researchMissionSlotsFull } from '../server/services/russell/launch.ts';
import { releaseOpportunityResearch } from '../server/services/cash/releaseResearch.ts';
import {
  diagnoseAbandonedRounds,
  GOAL_BUCKET_PREFIX,
  harvest,
  openGoalDiscovery,
  UNLAUNCHED_GOAL_ROUND_MS,
} from '../server/services/cash/discovery.ts';

const FAILURE_CLASS = 'OPERATOR:RECURRING_OPERATIONAL_FAILURE:b8827dc192ec553e';

const latest = (state: MissionState): RussellMission => ({ state }) as RussellMission;

describe(`${FAILURE_CLASS} — the rule a goal round settles by`, () => {
  it('settles ABANDONED only on a FAILED/CANCELLED latest mission or an idea the archive answered', () => {
    expect(roundOutcome({ latest: latest('DONE'), candidateState: 'LAUNCHED' })).toBe('HARVESTED');
    expect(roundOutcome({ latest: latest('FAILED'), candidateState: 'LAUNCHED' })).toBe('ABANDONED');
    expect(roundOutcome({ latest: latest('CANCELLED'), candidateState: 'LAUNCHED' })).toBe('ABANDONED');
    expect(roundOutcome({ latest: null, candidateState: 'REJECTED' })).toBe('ABANDONED');
  });

  it('never reads a round still being worked on as abandoned', () => {
    for (const state of ['PLANNED', 'RUNNING', 'WAITING', 'NEEDS_HUMAN'] as const) {
      expect(roundOutcome({ latest: latest(state), candidateState: 'LAUNCHED' }), state).toBeNull();
    }
    // No mission yet, and the idea was not answered by the archive: still OPEN.
    for (const candidateState of ['QUEUED', 'PARKED', null]) {
      expect(roundOutcome({ latest: null, candidateState }), String(candidateState)).toBeNull();
    }
  });
});

describe(`${FAILURE_CLASS} — the recorded rounds, through the real repositories`, () => {
  let projectId = '';
  let seq = 0;

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    const user = await createUser({
      email: `recurrence-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    });
    const outcome = await activate({
      projectId,
      ownerUserId: user.id,
      actorUserId: user.id,
      objective: 'Collect 10000 dollars of settled cash within 30 days using little up-front capital.',
    });
    expect(outcome.ok).toBe(true);
  });

  async function mission(
    candidateId: string,
    path: MissionState[],
    opts: { attempt?: number; supersedesMissionId?: string | null; terminalReason?: string | null; waitingOn?: string | null } = {},
  ): Promise<RussellMission> {
    seq += 1;
    const { mission: row } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'a goal research round',
      whyNow: 'the goal is active',
      idempotencyKey: `recurrence-${candidateId}-${seq}`,
      candidateId,
      attempt: opts.attempt,
      supersedesMissionId: opts.supersedesMissionId ?? null,
    });
    let from: MissionState = 'PLANNED';
    for (const to of path) {
      const terminal = to === 'FAILED' || to === 'CANCELLED' || to === 'DONE';
      const waits = to === 'WAITING' || to === 'NEEDS_HUMAN';
      const moved = await transitionMission({
        missionId: row.id,
        from,
        to,
        terminalReason: terminal ? (opts.terminalReason ?? null) : null,
        waitingOn: waits ? (opts.waitingOn ?? 'a worker slot') : null,
      });
      expect(moved, `${from} -> ${to}`).toBe(true);
      from = to;
    }
    return row;
  }

  it('the five rounds that ended in the same second each settle ABANDONED, and a redo that reaches DONE recovers its round', async () => {
    const opened = await openDiscovery({ projectId, limit: 8 });
    expect(opened.length).toBeGreaterThanOrEqual(8);
    const [orgMemory, mxA, mxB, mxC, orgWorld, redone, stillRunning, parked] = opened.map((one) => one.candidateId) as [
      string, string, string, string, string, string, string, string,
    ];

    // The recorded failure class: the latest mission of each idea ended without a report.
    await mission(orgMemory, ['RUNNING', 'FAILED'], { terminalReason: 'worker lease expired' });
    await mission(mxA, ['RUNNING', 'FAILED'], { terminalReason: 'No fragment cleared its evidence gate.' });
    await mission(mxB, ['CANCELLED'], { terminalReason: 'cancelled before launch' });
    await mission(mxC, ['RUNNING', 'CANCELLED'], { terminalReason: 'superseded' });
    await mission(orgWorld, ['RUNNING', 'FAILED'], { terminalReason: null });

    // The recovery path: a FAILED first attempt superseded by a redo that finished.
    const first = await mission(redone, ['RUNNING', 'FAILED'], { terminalReason: 'worker lease expired' });
    await mission(redone, ['RUNNING', 'DONE'], { attempt: 2, supersedesMissionId: first.id });

    // A round whose redo is still running is not abandoned for its first failure.
    const failedOnce = await mission(stillRunning, ['RUNNING', 'FAILED'], { terminalReason: 'worker lease expired' });
    await mission(stillRunning, ['RUNNING'], { attempt: 2, supersedesMissionId: failedOnce.id });

    // Parked at a person: `roundOutcome` returns no verdict on it. (The discovery
    // pass's settlement still closes it ABANDONED as ROUND_SETTLEMENT; see below.)
    await mission(parked, ['RUNNING', 'NEEDS_HUMAN'], { waitingOn: 'a login only the owner holds' });

    const read = await missionsForRounds(opened.map((one) => one.candidateId));
    const outcomeOf = (id: string) => read.get(id)?.outcome ?? null;

    for (const id of [orgMemory, mxA, mxB, mxC, orgWorld]) expect(outcomeOf(id), id).toBe('ABANDONED');
    expect(outcomeOf(redone)).toBe('HARVESTED');
    expect(read.get(redone)?.latest?.attempt).toBe(2);
    expect(outcomeOf(stillRunning)).toBeNull();
    expect(read.get(stillRunning)?.latest?.state).toBe('RUNNING');
    expect(outcomeOf(parked)).toBeNull();
  });
});

describe(`${FAILURE_CLASS} — what the goal reads from rounds that ended without a report`, () => {
  const plan = { considered: [], excludedReasons: [], remaining: 10000 };

  it('names research not finishing when the settled rounds are abandoned and none filed an opening', () => {
    const rounds: GoalRoundOutcome[] = Array.from({ length: 5 }, () => ({ state: 'ABANDONED', found: 0 }));
    const diagnosis = diagnoseGoalResearch({ ...plan, rounds });
    expect(diagnosis[0]?.cause).toBe('RESEARCH_NOT_FINISHING');
    expect(diagnosis[0]?.evidence).toContain('5 of the goal');
  });

  it('never counts an abandoned round as one that produced a report', () => {
    // Abandoned rounds beside empty harvests: the reports that exist were empty, and the abandoned ones are not reports.
    const rounds: GoalRoundOutcome[] = [
      { state: 'ABANDONED', found: 3 },
      { state: 'ABANDONED', found: 0 },
      { state: 'HARVESTED', found: 0 },
    ];
    const diagnosis = diagnoseGoalResearch({ ...plan, rounds });
    // `found` on an abandoned round does not make it fruitful.
    expect(diagnosis.map((one) => one.cause)).toContain('RESEARCH_NOT_FINISHING');
  });

  it('a harvested round with a report clears the cause, and open rounds are not counted at all', () => {
    const abandoned: GoalRoundOutcome[] = Array.from({ length: BARREN_ROUNDS_FOR_CAUSE + 3 }, () => ({ state: 'ABANDONED', found: 0 }));
    const withReport = diagnoseGoalResearch({ ...plan, rounds: [{ state: 'HARVESTED', found: 2 }, ...abandoned] });
    expect(withReport.map((one) => one.cause)).not.toContain('RESEARCH_NOT_FINISHING');

    const open: GoalRoundOutcome[] = Array.from({ length: 10 }, () => ({ state: 'OPEN', found: 0 }));
    const oneAbandoned = diagnoseGoalResearch({ ...plan, rounds: [...open, { state: 'ABANDONED', found: 0 }] });
    expect(oneAbandoned.map((one) => one.cause)).not.toContain('RESEARCH_NOT_FINISHING');
  });
});

describe(`${FAILURE_CLASS} — which upstream cause ends the rounds (finding F3)`, () => {
  let projectId = '';
  let userId = '';
  let seq = 0;

  beforeEach(async () => {
    forgetKnowledge();
    forgetGoalReadings();
    const fixture = await freshProject();
    projectId = fixture.project.id;
    userId = (
      await createUser({
        email: `upstream-${Math.random().toString(36).slice(2, 10)}@example.test`,
        displayName: 'Owner',
        password: 'correct horse battery staple',
      })
    ).id;
    const outcome = await activate({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective: 'Collect 10000 dollars of settled cash within 30 days using little up-front capital.',
    });
    expect(outcome.ok).toBe(true);
  });

  async function ended(candidateId: string, to: 'FAILED' | 'CANCELLED', terminalReason: string | null): Promise<RussellMission> {
    seq += 1;
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'a goal research round',
      whyNow: 'the goal is active',
      idempotencyKey: `upstream-${candidateId}-${seq}`,
      candidateId,
    });
    expect(await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' })).toBe(true);
    expect(await transitionMission({ missionId: mission.id, from: 'RUNNING', to, terminalReason })).toBe(true);
    return mission;
  }

  async function stopEvents(): Promise<Map<string, Record<string, unknown>>> {
    const byRound = new Map<string, Record<string, unknown>>();
    for (const event of await listCashEvents(projectId, 500)) {
      if (event.kind !== 'CASH_DISCOVERY_ROUND_STOPPED') continue;
      const detail = event.detail as Record<string, unknown>;
      byRound.set(String(detail.roundId), detail);
    }
    return byRound;
  }

  it('the shared second is the settlement pass, and the five rounds die of four different causes', async () => {
    const opened = await openDiscovery({ projectId, limit: 5 });
    expect(opened.length).toBeGreaterThanOrEqual(5);
    const [orgMemory, mxA, mxB, mxC, orgWorld] = opened.map((one) => one.candidateId) as [string, string, string, string, string];

    // The recorded reasons, as production's missions wrote them.
    const missions = [
      await ended(orgMemory, 'FAILED', 'worker lease expired'),
      await ended(mxA, 'FAILED', 'No fragment cleared its evidence gate.'),
      await ended(mxB, 'CANCELLED', 'cancelled before launch'),
      await ended(mxC, 'CANCELLED', 'superseded'),
      await ended(orgWorld, 'FAILED', null),
    ];
    // The research stopped hours apart: spread the missions' end times over a day.
    for (const [i, mission] of missions.entries()) {
      const at = new Date(Date.now() - (5 - i) * 4 * 3_600_000).toISOString();
      await getDb().run('UPDATE russell_missions SET updated_at = ? WHERE id = ?', [at, mission.id]);
    }
    const before = await listRounds(projectId);
    for (const id of [orgMemory, mxA, mxB, mxC, orgWorld]) {
      // A mission that ended does not close its round by itself: it waits for the pass.
      expect(before.find((one) => one.candidateId === id)?.state, id).toBe('OPEN');
    }

    await harvest({ projectId, limit: 50 });

    const rounds = (await listRounds(projectId)).filter((one) => [orgMemory, mxA, mxB, mxC, orgWorld].includes(one.candidateId));
    expect(rounds).toHaveLength(5);
    for (const round of rounds) expect(round.state, round.candidateId).toBe('ABANDONED');
    const closedAt = rounds.map((one) => Date.parse(one.harvestedAt!));
    // One pass, one clock: the rounds close within the same second although their research ended 16 hours apart.
    expect(Math.max(...closedAt) - Math.min(...closedAt)).toBeLessThan(1000);
    const endedAt = await Promise.all(missions.map(async (one) => Date.parse((await getMission(one.id))!.updatedAt)));
    expect(Math.max(...endedAt) - Math.min(...endedAt)).toBeGreaterThanOrEqual(16 * 3_600_000);

    // The cause is the mission's own row, carried verbatim and classified, not the timestamp.
    const events = await stopEvents();
    const recorded = (candidateId: string) => events.get(rounds.find((one) => one.candidateId === candidateId)!.id)!;
    expect(recorded(orgMemory)).toMatchObject({ cause: 'MISSION_FAILED:worker lease expired', failureClass: 'TRAIL_TIMEOUT' });
    expect(recorded(mxA)).toMatchObject({ cause: 'MISSION_FAILED:No fragment cleared its evidence gate.', failureClass: 'MAST_TASK_VERIFICATION' });
    expect(recorded(mxB)).toMatchObject({ cause: 'MISSION_CANCELLED:cancelled before launch', failureClass: 'ROUND_SETTLEMENT' });
    expect(recorded(mxC)).toMatchObject({ cause: 'MISSION_CANCELLED:superseded', failureClass: 'ROUND_SETTLEMENT' });
    expect(recorded(orgWorld)).toMatchObject({ cause: 'MISSION_FAILED:UNSTATED', failureClass: 'UNATTRIBUTED' });

    // The diagnosis the operator reads names the same split. Four classes are not one upstream event.
    const diagnosis = await diagnoseAbandonedRounds(projectId);
    expect(diagnosis.byClass).toMatchObject({ TRAIL_TIMEOUT: 1, MAST_TASK_VERIFICATION: 1, ROUND_SETTLEMENT: 2, UNATTRIBUTED: 1 });
    expect(Object.values(diagnosis.byClass).filter((count) => count > 0)).toHaveLength(4);

    // A second pass over the same rows closes nothing again and writes no second stop event.
    const stops = events.size;
    await harvest({ projectId, limit: 50 });
    expect((await stopEvents()).size).toBe(stops);
  });

  it("Brain's bulk release path never cancels the research of the round that discovered the opening", async () => {
    const opened = await openDiscovery({ projectId, limit: 1 });
    const discoverer = opened[0]!.candidateId;
    seq += 1;
    const { mission } = await launchMission({
      projectId,
      visibility: 'SHARED',
      objective: 'a goal research round',
      whyNow: 'the goal is active',
      idempotencyKey: `upstream-release-${seq}`,
      candidateId: discoverer,
    });
    expect(await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' })).toBe(true);
    const mode = (await getCashMode(projectId))!;
    const opening = await createOpportunity({
      projectId,
      cashModeId: mode.id,
      ownerUserId: userId,
      title: 'An opening the round filed',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
      discoveredByCandidateId: discoverer,
      candidateId: discoverer,
    });

    const released = await releaseOpportunityResearch({ opportunity: opening, reason: 'The goal screen rejected this opening.' });
    expect(released.released).toBe(true);
    expect(released.missionsCancelled).not.toContain(mission.id);
    expect((await getMission(mission.id))!.state).toBe('RUNNING');

    await harvest({ projectId, limit: 50 });
    const round = (await listRounds(projectId)).find((one) => one.candidateId === discoverer)!;
    // Still being researched, so still OPEN, so not one of the abandoned rounds.
    expect(round.state).toBe('OPEN');
  });

  async function goalRound(): Promise<{ candidateId: string; roundId: string }> {
    const now = new Date();
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: new Date(now.getTime() + 25 * 86_400_000).toISOString(), ownerUserId: userId }, `person:${userId}`);
    expect(
      (
        await setTarget({
          goal: (await getWorkstream(g.id))!,
          metric: 'SETTLED_CASH',
          amountCents: 1_000_000,
          currency: 'USD',
          projectId,
          capitalCeilingCents: 300_000,
          capitalBeforeProofCents: 37_500,
          hoursCeiling: 200,
          now: new Date(now.getTime() - 60_000),
        } as Parameters<typeof setTarget>[0])
      ).ok,
    ).toBe(true);
    const w = (await getWorkstream(g.id))!;
    const target = (await readGoalPlan({ goalId: g.id, evaluations: 200 }))!.target;
    const opened = await openGoalDiscovery({ goal: w, target, bestReach: null });
    expect(opened).not.toBeNull();
    const round = (await listRounds(projectId)).find((one) => one.candidateId === opened!.candidateId)!;
    expect(round.bucketId.startsWith(GOAL_BUCKET_PREFIX)).toBe(true);
    // Unlaunched for longer than the cap allows.
    const longAgo = new Date(Date.now() - UNLAUNCHED_GOAL_ROUND_MS - 60_000).toISOString();
    await getDb().run('UPDATE cash_discovery_rounds SET opened_at = ? WHERE id = ?', [longAgo, round.id]);
    return { candidateId: opened!.candidateId, roundId: round.id };
  }

  it('a goal round waiting for a research slot is not retired: the unlaunched cap never sheds queued work', async () => {
    const { roundId } = await goalRound();
    const slots = await researchMissionSlots(projectId);
    expect(slots, 'a research grant governs this project').not.toBeNull();
    // Every slot held: the wait is the grant's, not the idea's.
    expect(await setGoalConcurrency(slots!.goalId, 1)).toBe(true);
    expect((await reserve({ goalId: slots!.goalId, kind: 'MISSION', idempotencyKey: `upstream-slot-${seq}` })).ok).toBe(true);
    expect(await researchMissionSlotsFull(projectId)).toBe(true);

    await harvest({ projectId, limit: 50 });
    const round = (await listRounds(projectId)).find((one) => one.id === roundId)!;
    expect(round.state).toBe('OPEN');
    expect((await stopEvents()).has(roundId)).toBe(false);
  });

  it('with a slot free, the cap retires the unlaunched idea and names ROUND_CAP_LOGIC, not a research failure', async () => {
    const { roundId } = await goalRound();
    expect(await researchMissionSlotsFull(projectId)).not.toBe(true);

    await harvest({ projectId, limit: 50 });
    const round = (await listRounds(projectId)).find((one) => one.id === roundId)!;
    expect(round.state).toBe('ABANDONED');
    expect((await stopEvents()).get(roundId)).toMatchObject({ cause: 'ROUND_CAP_UNLAUNCHED_6H', failureClass: 'ROUND_CAP_LOGIC', missionId: null });
  });
});

describe(`${FAILURE_CLASS} — the next round is told why the rounds actually stopped (repair F1)`, () => {
  const plan = { considered: [], excludedReasons: [], remaining: 10000 };
  const rounds = (failureClass: string | null, n = 5): GoalRoundOutcome[] =>
    Array.from({ length: n }, () => ({ state: 'ABANDONED', found: 0, failureClass }));
  const EVIDENCE_TEXT = 'no claim survived the evidence check';

  it('rounds that ran out of time are asked a narrower question, not told to fix their evidence', () => {
    const [diagnosis] = diagnoseGoalResearch({ ...plan, rounds: rounds('TRAIL_TIMEOUT') });
    expect(diagnosis?.cause).toBe('RESEARCH_NOT_FINISHING');
    expect(diagnosis?.evidence).toContain('TRAIL_TIMEOUT 5');
    expect(diagnosis?.instruction).toMatch(/ran out of time/);
    expect(diagnosis?.instruction).not.toContain(EVIDENCE_TEXT);
  });

  it('rounds refused by the evidence check keep the evidence instruction, and unclassified rounds read as before', () => {
    expect(diagnoseGoalResearch({ ...plan, rounds: rounds('MAST_TASK_VERIFICATION') })[0]?.instruction).toContain(EVIDENCE_TEXT);
    expect(diagnoseGoalResearch({ ...plan, rounds: rounds(null) })[0]?.instruction).toContain(EVIDENCE_TEXT);
    expect(diagnoseGoalResearch({ ...plan, rounds: rounds('SOURCE_UNREACHABLE') })[0]?.instruction).toMatch(/could not be opened/);
  });

  it('rounds Brain\'s own settlement ended are not research that failed to finish', () => {
    for (const failureClass of ['ROUND_SETTLEMENT', 'ROUND_CAP_LOGIC']) {
      const diagnosis = diagnoseGoalResearch({ ...plan, rounds: rounds(failureClass) });
      expect(diagnosis.map((one) => one.cause), failureClass).not.toContain('RESEARCH_NOT_FINISHING');
    }
    // Settlement beside real failures: only the failures count, and they need BARREN_ROUNDS_FOR_CAUSE of their own.
    const mixed = [...rounds('ROUND_SETTLEMENT', 4), ...rounds('TRAIL_TIMEOUT', BARREN_ROUNDS_FOR_CAUSE - 1)];
    expect(diagnoseGoalResearch({ ...plan, rounds: mixed }).map((one) => one.cause)).not.toContain('RESEARCH_NOT_FINISHING');
  });

  it('an execution fault names the cause but puts nothing into the question, since asking differently cannot fix it', () => {
    const diagnosis = diagnoseGoalResearch({ ...plan, rounds: rounds('TRAIL_API_ERROR') });
    expect(diagnosis[0]?.cause).toBe('RESEARCH_NOT_FINISHING');
    expect(diagnosis[0]?.instruction).toBe('');
    expect(diagnosisInstructions(diagnosis)).toBe('');
  });

  it('the most common class decides the instruction', () => {
    const mixed = [...rounds('MAST_TASK_VERIFICATION', 2), ...rounds('TRAIL_TIMEOUT', 3)];
    const [diagnosis] = diagnoseGoalResearch({ ...plan, rounds: mixed });
    expect(diagnosis?.instruction).toMatch(/ran out of time/);
    expect(diagnosis?.evidence).toContain('MAST_TASK_VERIFICATION 2');
  });

  it('recentGoalRounds reads each abandoned round\'s class from its own stop event', async () => {
    const projectId = (await freshProject()).project.id;
    const goalId = 'wst_recurrence';
    const opened: string[] = [];
    for (const [i, failureClass] of (['TRAIL_TIMEOUT', 'ROUND_SETTLEMENT', null] as const).entries()) {
      const { round } = await openRound({ projectId, cashModeId: 'cm_test', bucketId: `goal-${goalId}-b${i}`, mechanism: 'm', round: 1, candidateId: `rcn_rec_${i}` });
      expect(await closeRound({ id: round.id, to: 'ABANDONED', found: 0 })).toBe(true);
      if (failureClass) {
        await recordCashEvent({ projectId, kind: 'CASH_DISCOVERY_ROUND_STOPPED', actorRef: 'BRAIN', summary: 'stopped', detail: { roundId: round.id, cause: 'x', failureClass } });
      }
      opened.push(round.id);
    }
    // A stop event for a round outside the goal is never read onto it.
    await recordCashEvent({ projectId, kind: 'CASH_DISCOVERY_ROUND_STOPPED', actorRef: 'BRAIN', summary: 'other', detail: { roundId: 'cdr_elsewhere', failureClass: 'TRAIL_API_ERROR' } });
    const read = await recentGoalRounds(projectId, goalId);
    expect(read).toHaveLength(3);
    expect(read.map((one) => one.failureClass).sort()).toEqual([null, 'ROUND_SETTLEMENT', 'TRAIL_TIMEOUT'].sort());
    expect(read.every((one) => one.state === 'ABANDONED' && one.found === 0)).toBe(true);
  });
});
