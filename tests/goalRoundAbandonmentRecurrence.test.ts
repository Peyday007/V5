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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { openDiscovery } from '../server/services/cash/discovery.ts';
import { missionsForRounds, roundOutcome } from '../server/services/russell/roundMissions.ts';
import {
  BARREN_ROUNDS_FOR_CAUSE,
  diagnoseGoalResearch,
  type GoalRoundOutcome,
} from '../server/services/goals/researchYield.ts';
import type { MissionState, RussellMission } from '../server/domain/types.ts';

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

    // Parked at a person: the round waits, it is not abandoned by this rule.
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
