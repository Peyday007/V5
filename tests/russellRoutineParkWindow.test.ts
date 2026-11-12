/**
 * The routine-decision window must not be filled by cards Brain can never answer.
 *
 * `answerRoutineParks` takes the oldest `limit` open cards. A card that is not
 * about a mission keeps its old `created_at`, so it sat first in line on every
 * tick; past `limit` of them, a newer RECORD_GAPS card ("the evidence bar was
 * not met and the repair ladder is spent") was never reached and went to a person.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { askHuman, getHumanRequest } from '../server/repos/russellMissions.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { launch } from '../server/services/russell/launch.ts';
import { getDb } from '../server/db/database.ts';
import { NEEDS_HUMAN_CHOICES } from '../server/services/russell/needsHuman.ts';
import { answerRoutineParks, ROUTINE_DECISION_GRACE_MS } from '../server/services/russell/routineDecisions.ts';

let projectId = '';
let layerId = '';
let userId = '';
let missionId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  userId = (
    await createUser({
      email: `window-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Test person',
      password: 'correct horse battery staple',
    })
  ).id;
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'standing',
    allowedWork: ['RESEARCH'],
    maxMissions: 1,
    maxFragments: 1,
    maxConcurrent: 1,
    maxProbes: 1,
  });
  const captured = await capture({
    title: 'Florida licensing',
    statement: 'establish the Florida broker licence position from the 2026 statute',
    projectId,
    visibility: 'SHARED',
  });
  const launched = await launch({
    projectId,
    layerId,
    candidateId: captured.candidate!.id,
    visibility: 'SHARED',
    title: 'Florida broker licensing',
    assignment: 'Under Florida law as in force in 2026, is a broker licence required?',
    objective: 'Settle the Florida position.',
    whyNow: 'The layer names Florida as open.',
    acceptableSources: ['Florida Statutes'],
    excludedSources: [],
    evidence: ['the exact section'],
    startedBy: { kind: 'PERSON', id: userId },
    envelopeId: 'RUSSELL_STATE_LICENSING_V1',
    authorizedBy: userId,
  });
  missionId = launched.mission!.id;
});

async function card(resumeKey: string, ageMs: number): Promise<string> {
  const { request } = await askHuman({
    projectId,
    missionId,
    authorityNeeded: 'x',
    whyNotRussell: 'y',
    choices: [NEEDS_HUMAN_CHOICES.RECORD_GAPS, NEEDS_HUMAN_CHOICES.STOP],
    resumeKey,
  });
  const at = new Date(Date.now() - ageMs).toISOString();
  await getDb().run('UPDATE russell_human_requests SET created_at = ? WHERE id = ?', [at, request.id]);
  return request.id;
}

describe('answerRoutineParks window', () => {
  const OLD = ROUTINE_DECISION_GRACE_MS + 3_600_000;

  it('reaches an answerable card behind more than `limit` older cards that are not research parks', async () => {
    for (let i = 0; i < 3; i += 1) await card(`cash-reconsider:window-${i}`, OLD + 10_000 * (i + 1));
    const answerable = await card(`russell:needs-human:${missionId}:window`, OLD);

    const decided = await answerRoutineParks({ limit: 2 });

    expect(decided.map((d) => d.requestId)).toContain(answerable);
    const row = (await getHumanRequest(answerable))!;
    expect(row.state).not.toBe('OPEN');
    expect(row.answeredChoice).toBe('RECORD_GAPS');
    expect(row.answeredReason).toMatch(/Decided by Brain under the standing research grant/);
  });

  it('still leaves a card inside the grace period, and one with no live grant, for a person', async () => {
    const fresh = await card(`russell:needs-human:${missionId}:fresh`, 1_000);
    expect(await answerRoutineParks({ limit: 2 })).toHaveLength(0);
    expect((await getHumanRequest(fresh))!.state).toBe('OPEN');

    await getDb().run(`UPDATE russell_goals SET state = 'REVOKED' WHERE project_id = ?`, [projectId]);
    const old = await card(`russell:needs-human:${missionId}:ungranted`, OLD);
    expect(await answerRoutineParks({ limit: 2 })).toHaveLength(0);
    expect((await getHumanRequest(old))!.state).toBe('OPEN');
  });

  it('treats a bounded research goal as no standing grant, as decide does', async () => {
    await getDb().run(`UPDATE russell_goals SET purpose = 'RESEARCH_GOAL' WHERE project_id = ?`, [projectId]);
    const old = await card(`russell:needs-human:${missionId}:research-goal-only`, OLD);
    expect(await answerRoutineParks({ limit: 2 })).toHaveLength(0);
    expect((await getHumanRequest(old))!.state).toBe('OPEN');
  });
});
