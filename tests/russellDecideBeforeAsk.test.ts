/**
 * Brain decides a routine park before it would ask (§80, rule 11).
 *
 * Production, seven days to 2026-11-14: 305 of 334 Needs-You cards read
 * "Deciding whether this project accepts a report with unresolved questions in
 * it" — "The evidence bar was not met and the repair ladder is spent." The
 * project's standing grant already answers that question, and
 * `answerRoutineParks` did answer it RECORD_GAPS, but only after a grace
 * period, so every one was first raised to the owner as a card. These pin that
 * `parkStoppedMissions` now files that shape itself through the one shared
 * step, and that every other shape still parks and asks exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const judge = vi.hoisted(() => ({ resume: false }));
vi.mock('../server/services/research/judgeRound.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/research/judgeRound.ts')>();
  return {
    ...original,
    assessJudgeRound: async (orchestration: Parameters<typeof original.assessJudgeRound>[0]) =>
      judge.resume
        ? ({ kind: 'RESUME', verdict: 'PATCH', auditId: 'aud_x', round: 1, judgeSummary: '', judgeNextAction: null, corrections: [], followUps: [] } as const)
        : original.assessJudgeRound(orchestration),
  };
});

const advance = vi.hoisted(() => ({ failNext: 0, calls: [] as string[] }));
vi.mock('../server/services/research/packetRunner.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/services/research/packetRunner.ts')>();
  return {
    ...original,
    advancePacket: async (orchestrationId: string) => {
      advance.calls.push(orchestrationId);
      if (advance.failNext > 0) {
        advance.failNext -= 1;
        throw new Error('the runner could not reach the database');
      }
      return original.advancePacket(orchestrationId);
    },
  };
});

import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { listEvents } from '../server/repos/events.ts';
import { getMission, listOpenRequests } from '../server/repos/russellMissions.ts';
import { createFragments, getOrchestration, insertClaims, updateOrchestration } from '../server/repos/research.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { launch } from '../server/services/russell/launch.ts';
import { parkStoppedMissions } from '../server/services/russell/needsHuman.ts';
import { fileWithGapsUnderStandingGrant } from '../server/services/russell/routineDecisions.ts';

const ACCEPTS_A_REPORT = 'Deciding whether this project accepts a report with unresolved questions in it';
const SPENT = 'The evidence bar was not met and the repair ladder is spent.';

let projectId = '';
let layerId = '';
let userId = '';

beforeEach(async () => {
  judge.resume = false;
  advance.failNext = 0;
  advance.calls = [];
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  userId = (
    await createUser({
      email: `decide-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner',
      password: 'correct horse battery staple',
    })
  ).id;
});

async function grant(): Promise<string> {
  const goal = await createGoal({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'standing',
    allowedWork: ['RESEARCH'], maxMissions: 5, maxFragments: 5, maxConcurrent: 5, maxProbes: 1,
  });
  return goal.id;
}

/** A launched mission whose packet stopped at NEEDS_HUMAN with fragments in the given statuses. */
async function stoppedMission(statuses: readonly string[]): Promise<{ missionId: string; orchestrationId: string }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const captured = await capture({
    title: `Florida licensing ${tag}`,
    statement: `establish the Florida broker licence position from the 2026 statute (case ${tag})`,
    projectId,
    visibility: 'SHARED',
  });
  const launched = await launch({
    projectId, layerId, candidateId: captured.candidate!.id, visibility: 'SHARED',
    title: 'Florida broker licensing',
    assignment: `Under Florida law as in force in 2026, is a broker licence required (case ${tag})?`,
    objective: `Settle the Florida position (case ${tag}).`, whyNow: 'The layer names Florida as open.',
    acceptableSources: ['Florida Statutes'], excludedSources: [], evidence: ['the exact section'],
    startedBy: { kind: 'PERSON', id: userId }, envelopeId: 'RUSSELL_STATE_LICENSING_V1', authorizedBy: userId,
  });
  expect(launched.ok, launched.reason).toBe(true);
  const mission = launched.mission!;
  const orchestrationId = mission.orchestrationId!;
  await getDb().run('DELETE FROM research_fragments WHERE orchestration_id = ?', [orchestrationId]);
  await createFragments(
    statuses.map((_, index) => ({
      orchestrationId, projectId, layerId, fragmentIndex: index, fragmentKey: `f${index}`,
      question: `Question ${index}?`,
      requiredEvidence: [{ id: 'official_source', description: 'the office', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official'], excludedSourceTypes: [], completionCriteria: ['a quote'],
      minIndependentSources: 1, maxRepairs: 2, dependsOn: [], attempt: 1,
    })) as unknown as Parameters<typeof createFragments>[0],
  );
  const rows = await getDb().all<{ id: string; fragment_key: string }>(
    'SELECT id, fragment_key FROM research_fragments WHERE orchestration_id = ?', [orchestrationId],
  );
  for (const row of rows) {
    const status = statuses[Number(row.fragment_key.slice(1))]!;
    await getDb().run('UPDATE research_fragments SET status = ? WHERE id = ?', [status, row.id]);
    if (status === 'ACCEPTED') {
      // What the gate accepted: one claim, with its source.
      const [claim] = await insertClaims([{
        orchestrationId, fragmentId: row.id, passId: null, passKey: 'TARGETED',
        claim: 'Florida requires a broker licence under s. 475.42.', sourceUrl: 'https://www.flsenate.gov/Laws/Statutes/2026/475.42',
        sourceTitle: 'Florida Statutes 475.42', sourcePublisher: 'Florida Senate', sourceDate: null,
        evidenceExcerpt: 'A person may not operate as a broker without a license.', evidenceLocator: 's. 475.42(1)(a)', evidenceLane: 'official_source',
        retrievedAt: null, confidence: 0.9, validationState: 'SOURCED', validationDetail: null, sourced: true,
        accepted: true, contentHash: `hash-${row.id}`,
      }]);
      expect(claim!.accepted).toBe(true);
    }
  }
  await updateOrchestration(orchestrationId, { status: 'NEEDS_HUMAN', failureReason: SPENT });
  return { missionId: mission.id, orchestrationId };
}

async function cardFor(missionId: string) {
  return (await listOpenRequests(projectId)).find((request) => request.missionId === missionId);
}

async function decisionsFor(missionId: string) {
  return (await listEvents(projectId))
    .filter((event) => event.eventType === 'RUSSELL_ROUTINE_DECISION')
    .map((event) => event.payload as Record<string, unknown>)
    .filter((payload) => payload['missionId'] === missionId);
}

describe('parkStoppedMissions decides before it asks', () => {
  it('files an accepted-evidence, spent-ladder park under a live standing grant without opening a card, once', async () => {
    const grantId = await grant();
    const { missionId, orchestrationId } = await stoppedMission(['ACCEPTED', 'BLOCKED']);

    await parkStoppedMissions(10);

    expect(await cardFor(missionId)).toBeUndefined();
    const orchestration = (await getOrchestration(orchestrationId))!;
    expect(orchestration.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(orchestration.unresolvedGapAuthorizedBy).toBe(userId);
    const decided = (await decisionsFor(missionId)).filter((p) => p['decidedBy'] === 'BRAIN_UNDER_STANDING_AUTHORITY');
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ choice: 'RECORD_GAPS', grantId, orchestrationId });
    expect((await getMission(missionId))!.state).not.toBe('NEEDS_HUMAN');

    // Idempotent: whatever the packet did next, a second pass opens no card and decides nothing again.
    await parkStoppedMissions(10);
    expect(await cardFor(missionId)).toBeUndefined();
    expect((await decisionsFor(missionId)).filter((p) => p['decidedBy'] === 'BRAIN_UNDER_STANDING_AUTHORITY')).toHaveLength(1);
  });

  it('still parks with the card where the project holds no live standing grant, and records why Brain did not decide', async () => {
    await grant();
    const { missionId, orchestrationId } = await stoppedMission(['ACCEPTED', 'BLOCKED']);
    await getDb().run(`UPDATE russell_goals SET state = 'REVOKED' WHERE project_id = ?`, [projectId]);

    await parkStoppedMissions(10);

    const card = await cardFor(missionId);
    expect(card?.authorityNeeded).toContain(ACCEPTS_A_REPORT);
    expect(card?.choices.map((c) => c.key)).toEqual(['RECORD_GAPS', 'STOP']);
    expect((await getOrchestration(orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect((await getMission(missionId))!.state).toBe('NEEDS_HUMAN');
    const declined = await decisionsFor(missionId);
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ choice: null, declinedBecause: 'NO_LIVE_GRANT' });

    // Recorded once: the parked mission is not re-declined on the next pass.
    await parkStoppedMissions(10);
    expect(await decisionsFor(missionId)).toHaveLength(1);
  });

  it('leaves a judge round about to resume, a packet with nothing accepted, and a plan awaiting approval as before', async () => {
    await grant();

    judge.resume = true;
    const resuming = await stoppedMission(['ACCEPTED', 'BLOCKED']);
    await parkStoppedMissions(10);
    expect((await cardFor(resuming.missionId))?.authorityNeeded).toContain(ACCEPTS_A_REPORT);
    expect((await getOrchestration(resuming.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect(await decisionsFor(resuming.missionId)).toMatchObject([{ declinedBecause: 'JUDGE_ROUND_RESUMING' }]);
    judge.resume = false;

    // Researched, nothing accepted: one answer (STOP) is no decision, so it fails as before — no card, no filing.
    const nothing = await stoppedMission(['BLOCKED', 'BLOCKED']);
    await parkStoppedMissions(10);
    expect(await cardFor(nothing.missionId)).toBeUndefined();
    expect((await getMission(nothing.missionId))!.state).toBe('FAILED');
    expect((await getOrchestration(nothing.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');

    const plan = await stoppedMission(['PLANNED']);
    await parkStoppedMissions(10);
    const planCard = await cardFor(plan.missionId);
    expect(planCard?.choices.map((c) => c.key)).toEqual(['APPROVE_PLAN', 'STOP']);
    expect(await decisionsFor(plan.missionId)).toMatchObject([{ declinedBecause: 'PLAN_AWAITING_APPROVAL' }]);
  });

  it('a filing whose advance failed is advanced again on the next pass, never turned into a card', async () => {
    await grant();
    const { missionId, orchestrationId } = await stoppedMission(['ACCEPTED', 'BLOCKED']);

    // Brain decides and authorizes, but the advance that carries it out fails.
    advance.calls = [];
    advance.failNext = 1;
    await parkStoppedMissions(10);
    expect(await cardFor(missionId)).toBeUndefined();
    const stuck = (await getOrchestration(orchestrationId))!;
    expect(stuck.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(stuck.status).toBe('NEEDS_HUMAN');
    expect(advance.calls.filter((id) => id === orchestrationId)).toHaveLength(1);

    // The next pass finds the packet still stopped. It retries the advance; it does not ask the owner.
    await parkStoppedMissions(10);
    expect(await cardFor(missionId)).toBeUndefined();
    expect((await getMission(missionId))!.state).not.toBe('NEEDS_HUMAN');
    expect(advance.calls.filter((id) => id === orchestrationId)).toHaveLength(2);
    expect((await getOrchestration(orchestrationId))!.status).not.toBe('NEEDS_HUMAN');
    // One decision, recorded once; no "Brain did not decide" record either.
    const records = await decisionsFor(missionId);
    expect(records.filter((p) => p['decidedBy'] === 'BRAIN_UNDER_STANDING_AUTHORITY')).toHaveLength(1);
    expect(records.filter((p) => p['declinedBecause'])).toHaveLength(0);

    // The shared step says what it did with an already-authorized packet.
    const again = await fileWithGapsUnderStandingGrant({ orchestration: (await getOrchestration(orchestrationId))!, missionId, why: 'test' });
    expect(again).toMatchObject({ decided: false, because: 'ALREADY_FILED_WITH_GAPS' });
  });

  it('has one decide-and-file step, used by the park and by answerUnaskedParks', async () => {
    const source = readFileSync(new URL('../server/services/russell/routineDecisions.ts', import.meta.url), 'utf8');
    const unasked = source.slice(source.indexOf('export async function answerUnaskedParks'), source.indexOf('export type DeclinedBecause'));
    expect(unasked).toContain('fileWithGapsUnderStandingGrant(');
    expect(unasked).not.toContain('authorizeUnresolvedGaps');
    expect(source.match(/authorizeUnresolvedGaps\(/g)).toHaveLength(1);
    expect(typeof fileWithGapsUnderStandingGrant).toBe('function');
  });
});
