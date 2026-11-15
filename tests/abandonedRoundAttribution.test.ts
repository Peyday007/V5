/**
 * OPERATOR:MISSING_CAPABILITY:3009514ee01322e4 — an abandoned research round
 * must be attributable to one failure point from its rows.
 *
 * Brain's operator asked for a diagnostic audit of the abandoned research
 * rounds (dfx_2b21d109a13d): did they die of an API timeout, a parser error, a
 * context overflow, an unreachable source, or round-cap logic? An audit can
 * only answer that from what the rounds recorded. A round closes ABANDONED on
 * exactly these paths (`roundOutcome` in server/services/russell/roundMissions.ts,
 * and `closeEndedRounds` in server/services/cash/discovery.ts):
 *
 *   1. its idea's latest mission FAILED            → roundOutcome ABANDONED
 *   2. its idea's latest mission was CANCELLED     → roundOutcome ABANDONED
 *   3. no mission, the archive answered (REJECTED) → roundOutcome ABANDONED
 *   4. its latest mission waits on a person        → roundOutcome null; the
 *      discovery pass closes it ABANDONED on NEEDS_HUMAN
 *   5. no mission, the idea never launched         → roundOutcome null; the
 *      discovery pass retires it after UNLAUNCHED_GOAL_ROUND_MS (round cap)
 *
 * Before the repair the CASH_DISCOVERY_ROUND_STOPPED event the operator reads
 * carried only the mission's state, so a timeout, a parser refusal and an
 * operator cancel all recorded as "failed" and no audit could tell them apart.
 * This test drives the real discovery pass (`harvest` → `closeEndedRounds`)
 * over one round per path and requires each recorded stop event to carry a
 * distinct `cause` — the mission's own `terminalReason` (or `waitingOn`)
 * verbatim, `ARCHIVE_ANSWERED`, or the unlaunched round cap — so a
 * classification of the abandoned rounds is a query over Brain's own events,
 * not a guess. It fails on the base commit, whose events have no `cause`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { roundOutcome } from '../server/services/russell/roundMissions.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import {
  abandonedRoundCause,
  harvest,
  openDiscovery,
  UNLAUNCHED_GOAL_ROUND_MS,
} from '../server/services/cash/discovery.ts';

let projectId = '';
let userId = '';
let seq = 0;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `abandoned-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const outcome = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(outcome.ok).toBe(true);
});

/** A mission for one round's idea, ended the way production ended it. */
async function ended(
  candidateId: string,
  to: 'FAILED' | 'CANCELLED' | 'NEEDS_HUMAN',
  terminalReason: string | null,
  waitingOn: string | null = null,
): Promise<void> {
  seq += 1;
  const { mission } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: 'a discovery bucket',
    whyNow: 'the sprint is active',
    idempotencyKey: `abandoned-attribution-${candidateId}-${seq}`,
    candidateId,
  });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to, terminalReason, waitingOn });
}

async function stopEvents(): Promise<Map<string, Record<string, unknown>>> {
  const events = await listCashEvents(projectId, 500);
  const byRound = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.kind !== 'CASH_DISCOVERY_ROUND_STOPPED') continue;
    const detail = event.detail as Record<string, unknown>;
    byRound.set(String(detail.roundId), detail);
  }
  return byRound;
}

describe('OPERATOR:MISSING_CAPABILITY:3009514ee01322e4 — every abandoned round records one failure point', () => {
  it('the discovery pass records a distinct, verbatim cause on each ABANDONED round it closes', async () => {
    const opened = await openDiscovery({ projectId, limit: 6 });
    expect(opened.length).toBeGreaterThanOrEqual(6);
    const [timedOut, parseFailed, cancelled, needsHuman, silent, rejected] = opened as [
      (typeof opened)[number], (typeof opened)[number], (typeof opened)[number],
      (typeof opened)[number], (typeof opened)[number], (typeof opened)[number],
    ];
    await ended(timedOut.candidateId, 'FAILED', 'worker lease expired: API timeout after 20000 ms');
    await ended(parseFailed.candidateId, 'FAILED', 'submission refused: claims JSON did not parse');
    await ended(cancelled.candidateId, 'CANCELLED', 'cancelled by operator');
    await ended(needsHuman.candidateId, 'NEEDS_HUMAN', 'No fragment cleared its evidence gate.', 'a login only the owner holds');
    await ended(silent.candidateId, 'FAILED', null);
    await getDb().run('UPDATE russell_candidates SET state = ? WHERE id = ?', ['REJECTED', rejected.candidateId]);

    await harvest({ projectId, limit: 50 });

    const rounds = await listRounds(projectId);
    const roundOf = (bucketId: string) => rounds.find((one) => one.bucketId === bucketId)!;
    const events = await stopEvents();
    const causeOf = (one: { bucketId: string }) => {
      const round = roundOf(one.bucketId);
      expect(round.state).toBe('ABANDONED');
      const detail = events.get(round.id);
      expect(detail, `no stop event for round ${round.id}`).toBeDefined();
      return detail!.cause;
    };

    expect(causeOf(timedOut)).toBe('MISSION_FAILED:worker lease expired: API timeout after 20000 ms');
    expect(causeOf(parseFailed)).toBe('MISSION_FAILED:submission refused: claims JSON did not parse');
    expect(causeOf(cancelled)).toBe('MISSION_CANCELLED:cancelled by operator');
    // Parked at a person: what it waits on is the failure point, not the gate prose.
    expect(causeOf(needsHuman)).toBe('MISSION_NEEDS_HUMAN:a login only the owner holds');
    // An unstated reason is recorded as unstated, never as a guessed cause.
    expect(causeOf(silent)).toBe('MISSION_FAILED:UNSTATED');
    expect(causeOf(rejected)).toBe('ARCHIVE_ANSWERED');

    const causes = [timedOut, parseFailed, cancelled, needsHuman, silent, rejected].map(causeOf);
    expect(new Set(causes).size).toBe(causes.length);

    // The verbatim reason is in the event's own columns too, for a query that groups by it.
    const timedOutDetail = events.get(roundOf(timedOut.bucketId).id)!;
    expect(timedOutDetail.terminalReason).toBe('worker lease expired: API timeout after 20000 ms');
    expect(events.get(roundOf(needsHuman.bucketId).id)!.waitingOn).toBe('a login only the owner holds');
  });

  it('names the unlaunched round cap distinctly from an archive answer', () => {
    expect(UNLAUNCHED_GOAL_ROUND_MS).toBe(6 * 60 * 60 * 1000);
    expect(abandonedRoundCause({ mission: null, expired: true })).toBe('ROUND_CAP_UNLAUNCHED_6H');
    expect(abandonedRoundCause({ mission: null, expired: false })).toBe('ARCHIVE_ANSWERED');
    expect(
      abandonedRoundCause({ mission: { state: 'FAILED', terminalReason: '   ', waitingOn: null }, expired: false }),
    ).toBe('MISSION_FAILED:UNSTATED');
  });

  it('the pure rule never reads an unlaunched or person-waiting round as abandoned on its own', () => {
    expect(roundOutcome({ latest: null, candidateState: 'QUEUED' })).toBeNull();
    expect(roundOutcome({ latest: null, candidateState: 'REJECTED' })).toBe('ABANDONED');
    for (const state of ['FAILED', 'CANCELLED'] as const) {
      expect(roundOutcome({ latest: { state } as never, candidateState: 'QUEUED' })).toBe('ABANDONED');
    }
    expect(roundOutcome({ latest: { state: 'NEEDS_HUMAN' } as never, candidateState: 'QUEUED' })).toBeNull();
  });
});
