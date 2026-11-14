/**
 * A routine park is decided before anyone is asked (§80, rule 11).
 *
 * Production, seven days to 2026-11-14: 305 of 334 Needs-You cards read
 * "Deciding whether this project accepts a report with unresolved questions in
 * it" — accepted evidence, repair ladder spent, in a project whose standing
 * grant already authorizes filing it with the gaps named. `answerRoutineParks`
 * answered each one only after its grace window, so every routine park reached
 * a person first. These pin that `parkStoppedMissions` decides that shape
 * itself, through the one shared step, and asks exactly as before otherwise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { getMission, listOpenRequests } from '../server/repos/russellMissions.ts';
import {
  createFragments,
  currentFragments,
  getOrchestration,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { capture } from '../server/services/russell/judgment.ts';
import { launch } from '../server/services/russell/launch.ts';
import { parkStoppedMissions } from '../server/services/russell/needsHuman.ts';
import * as routine from '../server/services/russell/routineDecisions.ts';

/** Which packets `assessJudgeRound` reports as about to run a corrected round. */
const resuming = new Set<string>();
vi.mock('../server/services/research/judgeRound.ts', async (original) => {
  const real = await original<typeof import('../server/services/research/judgeRound.ts')>();
  return {
    ...real,
    assessJudgeRound: async (orchestration: Parameters<typeof real.assessJudgeRound>[0]) =>
      resuming.has(orchestration.id) ? ({ kind: 'RESUME' } as never) : real.assessJudgeRound(orchestration),
  };
});

const ROUTINE_CARD = 'Deciding whether this project accepts a report with unresolved questions in it';

let projectId = '';
let layerId = '';
let userId = '';

beforeEach(async () => {
  resuming.clear();
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

async function grant(): Promise<void> {
  await createGoal({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'standing',
    allowedWork: ['RESEARCH'],
    maxMissions: 5,
    maxFragments: 5,
    maxConcurrent: 5,
    maxProbes: 1,
  });
}

/** A launched mission whose packet is about to be given a shape and stopped. */
async function mission(topic = 'broker licence'): Promise<{ id: string; orchestrationId: string }> {
  const captured = await capture({
    title: `Florida ${topic}`,
    statement: `establish the Florida ${topic} position from the 2026 statute`,
    projectId,
    visibility: 'SHARED',
  });
  const launched = await launch({
    projectId,
    layerId,
    candidateId: captured.candidate!.id,
    visibility: 'SHARED',
    title: `Florida ${topic}`,
    assignment: `Under Florida law as in force in 2026, is a ${topic} required?`,
    objective: 'Settle the Florida position.',
    whyNow: 'The layer names Florida as open.',
    acceptableSources: ['Florida Statutes'],
    excludedSources: [],
    evidence: ['the exact section'],
    startedBy: { kind: 'PERSON', id: userId },
    envelopeId: 'RUSSELL_STATE_LICENSING_V1',
    authorizedBy: userId,
  });
  expect(launched.ok, launched.reason).toBe(true);
  return { id: launched.mission!.id, orchestrationId: launched.mission!.orchestrationId! };
}

/** Fragments in the given statuses, then the packet stopped for a person. */
async function stopped(orchestrationId: string, statuses: readonly string[]): Promise<void> {
  for (const fragment of await currentFragments(orchestrationId)) {
    await updateFragment(fragment.id, { status: 'BLOCKED', blockedReason: 'superseded by the test shape' });
  }
  await createFragments(
    statuses.map((_, index) => ({
      orchestrationId,
      projectId,
      layerId,
      fragmentIndex: 10 + index,
      fragmentKey: `shape-${index}`,
      question: `Question ${index}?`,
      requiredEvidence: [{ id: 'official_source', description: 'the statute', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official'],
      excludedSourceTypes: [],
      completionCriteria: ['a quote'],
      minIndependentSources: 1,
      maxRepairs: 2,
      dependsOn: [],
      attempt: 1,
    })) as unknown as Parameters<typeof createFragments>[0],
  );
  for (const fragment of await currentFragments(orchestrationId)) {
    const at = statuses[Number(fragment.fragmentKey.replace('shape-', ''))];
    if (!fragment.fragmentKey.startsWith('shape-') || !at) continue;
    await updateFragment(fragment.id, {
      status: at as never,
      ...(at === 'BLOCKED' ? { blockedReason: 'The evidence bar was not met and the repair ladder is spent.' } : {}),
    });
  }
  await updateOrchestration(orchestrationId, {
    status: 'NEEDS_HUMAN',
    failureReason: 'The evidence bar was not met and the repair ladder is spent.',
  });
}

async function decisions(orchestrationId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await getDb().all<{ payload: string }>(
    `SELECT payload FROM project_events WHERE event_type = 'RUSSELL_ROUTINE_DECISION' AND project_id = ? ORDER BY created_at, id`,
    [projectId],
  );
  return rows
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload['orchestrationId'] === orchestrationId);
}

async function cardsFor(missionId: string) {
  return (await listOpenRequests(projectId)).filter((request) => request.missionId === missionId);
}

describe('parkStoppedMissions decides a routine park before asking', () => {
  it('files accepted evidence with the gaps named under a live standing grant, and opens no card', async () => {
    await grant();
    const m = await mission();
    await stopped(m.orchestrationId, ['ACCEPTED', 'BLOCKED']);

    expect(await parkStoppedMissions(10)).toEqual([]);

    expect(await cardsFor(m.id)).toEqual([]);
    const packet = (await getOrchestration(m.orchestrationId))!;
    expect(packet.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(packet.unresolvedGapAuthorizedBy).toBe(userId);
    const recorded = await decisions(m.orchestrationId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      missionId: m.id,
      choice: 'RECORD_GAPS',
      decidedBy: 'BRAIN_UNDER_STANDING_AUTHORITY',
    });
    expect(String(recorded[0]!['reason'])).toMatch(/^Decided by Brain under the standing research grant/);
    expect((await getMission(m.id))!.state).not.toBe('NEEDS_HUMAN');

    // Idempotent: a second pass opens no card and records no second decision.
    await parkStoppedMissions(10);
    expect(await cardsFor(m.id)).toEqual([]);
    expect((await decisions(m.orchestrationId)).filter((d) => d['decidedBy'] === 'BRAIN_UNDER_STANDING_AUTHORITY')).toHaveLength(1);
  });

  it('still parks with the routine card where there is no live standing grant, and records why Brain did not decide', async () => {
    await grant();
    const m = await mission();
    await stopped(m.orchestrationId, ['ACCEPTED', 'BLOCKED']);
    await getDb().run(`UPDATE russell_goals SET state = 'REVOKED' WHERE project_id = ?`, [projectId]);

    const parked = await parkStoppedMissions(10);
    expect(parked.map((p) => p.missionId)).toEqual([m.id]);
    const [card] = await cardsFor(m.id);
    expect(card!.authorityNeeded).toContain(ROUTINE_CARD);
    expect((await getOrchestration(m.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    const recorded = await decisions(m.orchestrationId);
    expect(recorded).toEqual([
      expect.objectContaining({ missionId: m.id, decidedBy: null, declinedBecause: 'NO_LIVE_STANDING_GRANT' }),
    ]);

    // Recorded once, not on every tick.
    await parkStoppedMissions(10);
    expect(await decisions(m.orchestrationId)).toHaveLength(1);
  });

  it('asks as before about a plan awaiting approval and about a packet with nothing accepted', async () => {
    await grant();
    const plan = await mission();
    await stopped(plan.orchestrationId, ['PLANNED']);
    const nothing = await mission('surety bond');
    await stopped(nothing.orchestrationId, ['BLOCKED', 'REJECTED']);

    await parkStoppedMissions(10);

    // A plan the envelope refused is a person's card; nothing is filed.
    const [planCard] = await cardsFor(plan.id);
    expect(planCard!.choices.map((c) => c.key)).toContain('APPROVE_PLAN');
    expect((await getOrchestration(plan.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect((await decisions(plan.orchestrationId)).every((d) => d['decidedBy'] === null)).toBe(true);

    // Nothing accepted: nothing is filed in anyone's name, and the mission
    // fails rather than parking, as it always has.
    expect((await getMission(nothing.id))!.state).toBe('FAILED');
    expect((await getOrchestration(nothing.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect((await decisions(nothing.orchestrationId)).some((d) => d['decidedBy'] !== null)).toBe(false);
  });

  it('leaves a packet whose judge round is about to resume to that round, exactly as before', async () => {
    await grant();
    const m = await mission();
    await stopped(m.orchestrationId, ['ACCEPTED', 'BLOCKED']);
    resuming.add(m.orchestrationId);

    const parked = await parkStoppedMissions(10);
    expect(parked.map((p) => p.missionId)).toEqual([m.id]);
    expect((await getOrchestration(m.orchestrationId))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
    expect(await decisions(m.orchestrationId)).toEqual([
      expect.objectContaining({ decidedBy: null, declinedBecause: 'JUDGE_ROUND_RESUMING' }),
    ]);
  });

  it('has one decide-and-file step, which answerUnaskedParks uses', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../server/services/russell/routineDecisions.ts', import.meta.url), 'utf8'),
    );
    const unasked = source.slice(source.indexOf('export async function answerUnaskedParks'));
    expect(unasked.slice(0, unasked.indexOf('\n}\n'))).toContain('fileUnderStandingGrant(');
    // authorizeUnresolvedGaps is called in exactly one place in the module.
    expect(source.match(/authorizeUnresolvedGaps\(/g)).toHaveLength(1);
    const park = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../server/services/russell/needsHuman.ts', import.meta.url), 'utf8'),
    );
    expect(park).toContain('fileUnderStandingGrant(');
  });
});
