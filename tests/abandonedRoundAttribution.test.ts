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
 * This test pins each path, read through the same `missionsForRounds` the
 * discovery pass reads, and requires that the rows it reads carry enough to
 * name a distinct cause for every path — including the mission's own
 * `terminalReason`, which is where a timeout or parser error is written — so a
 * classification of the abandoned rounds is a query, not a guess.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { missionsForRounds, roundOutcome, type RoundMissions } from '../server/services/russell/roundMissions.ts';
import { UNLAUNCHED_GOAL_ROUND_MS } from '../server/services/cash/discovery.ts';
import type { MissionState } from '../server/domain/types.ts';

let projectId = '';
let seq = 0;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
});

async function idea(state?: string): Promise<string> {
  seq += 1;
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    conversationId: null,
    sourceMessageId: null,
    title: `Abandoned round attribution ${seq}`,
    statement: `Abandoned round attribution ${seq}: what do the published sources say?`,
  });
  if (state) await getDb().run('UPDATE russell_candidates SET state = ? WHERE id = ?', [state, candidate.id]);
  return candidate.id;
}

async function mission(candidateId: string, state: MissionState, terminalReason: string | null, waitingOn: string | null = null): Promise<string> {
  seq += 1;
  const { mission: row } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: 'o',
    whyNow: 'w',
    idempotencyKey: `abandoned-attribution-${candidateId}-${seq}`,
    candidateId,
    attempt: 1,
  });
  await getDb().run('UPDATE russell_missions SET state = ?, terminal_reason = ?, waiting_on = ? WHERE id = ?', [state, terminalReason, waitingOn, row.id]);
  return row.id;
}

/**
 * The failure point the rows support, in the vocabulary of the operator's
 * question. Reads only what `closeEndedRounds` reads plus the mission's own
 * terminal reason; never the round's prose.
 */
function attribute(read: RoundMissions, candidateState: string | null, expired: boolean): string | null {
  const latest = read.latest;
  if (latest) {
    if (read.outcome === 'ABANDONED') return `MISSION_${latest.state}:${latest.terminalReason ?? 'UNSTATED'}`;
    if (latest.state === 'NEEDS_HUMAN') return `MISSION_NEEDS_HUMAN:${latest.waitingOn ?? latest.terminalReason ?? 'UNSTATED'}`;
    return null;
  }
  if (read.outcome === 'ABANDONED' && candidateState === 'REJECTED') return 'ARCHIVE_ANSWERED';
  if (expired) return `ROUND_CAP_UNLAUNCHED_${UNLAUNCHED_GOAL_ROUND_MS / 3_600_000}H`;
  return null;
}

describe('OPERATOR:MISSING_CAPABILITY:3009514ee01322e4 — every abandoned round names one failure point', () => {
  it('reads each ABANDONED path through missionsForRounds and attributes it distinctly', async () => {
    const timedOut = await idea();
    await mission(timedOut, 'FAILED', 'worker lease expired: API timeout after 20000 ms');
    const parseFailed = await idea();
    await mission(parseFailed, 'FAILED', 'submission refused: claims JSON did not parse');
    const cancelled = await idea();
    await mission(cancelled, 'CANCELLED', 'cancelled by operator');
    const needsHuman = await idea();
    await mission(needsHuman, 'NEEDS_HUMAN', null, 'a login only the owner holds');
    const rejected = await idea('REJECTED');
    const unlaunched = await idea();

    const ids = [timedOut, parseFailed, cancelled, needsHuman, rejected, unlaunched];
    const read = await missionsForRounds(ids);
    expect([...read.keys()].sort()).toEqual([...ids].sort());

    // The outcome rule the discovery pass consumes.
    expect(read.get(timedOut)!.outcome).toBe('ABANDONED');
    expect(read.get(parseFailed)!.outcome).toBe('ABANDONED');
    expect(read.get(cancelled)!.outcome).toBe('ABANDONED');
    expect(read.get(rejected)!.outcome).toBe('ABANDONED');
    // Not settled by the rule; the discovery pass closes these itself.
    expect(read.get(needsHuman)!.outcome).toBeNull();
    expect(read.get(needsHuman)!.latest!.state).toBe('NEEDS_HUMAN');
    expect(read.get(unlaunched)!.outcome).toBeNull();
    expect(read.get(unlaunched)!.latest).toBeNull();

    // The mission's own terminal reason survives the read — the technical failure point.
    expect(read.get(timedOut)!.latest!.terminalReason).toMatch(/timeout/i);
    expect(read.get(parseFailed)!.latest!.terminalReason).toMatch(/parse/i);

    const causes = [
      attribute(read.get(timedOut)!, null, false),
      attribute(read.get(parseFailed)!, null, false),
      attribute(read.get(cancelled)!, null, false),
      attribute(read.get(needsHuman)!, null, false),
      attribute(read.get(rejected)!, 'REJECTED', false),
      attribute(read.get(unlaunched)!, null, true),
    ];
    for (const cause of causes) expect(cause).not.toBeNull();
    expect(new Set(causes).size).toBe(causes.length);
    expect(causes[5]).toBe('ROUND_CAP_UNLAUNCHED_6H');
  });

  it('the pure rule never reads an unlaunched or person-waiting round as abandoned on its own', () => {
    expect(roundOutcome({ latest: null, candidateState: 'QUEUED' })).toBeNull();
    expect(roundOutcome({ latest: null, candidateState: 'REJECTED' })).toBe('ABANDONED');
    for (const state of ['FAILED', 'CANCELLED'] as const) {
      expect(roundOutcome({ latest: { state } as never, candidateState: 'QUEUED' })).toBe('ABANDONED');
    }
    expect(roundOutcome({ latest: { state: 'NEEDS_HUMAN' } as never, candidateState: 'QUEUED' })).toBeNull();
  });

  it('an unstated terminal reason is attributed as UNSTATED, never as a guessed cause', async () => {
    const silent = await idea();
    await mission(silent, 'FAILED', null);
    const read = await missionsForRounds([silent]);
    expect(attribute(read.get(silent)!, null, false)).toBe('MISSION_FAILED:UNSTATED');
  });
});
