/**
 * A fragment that answered part of its question files what it holds.
 *
 * Production 2026-11-25 17:10Z (`planningEval stall --run all`): 103 evaluation
 * fragments ended BLOCKED with REQUIRED_LANE_EMPTY while holding 1-14 accepted,
 * sourced claims on their other lanes; 57 packets made only of such fragments
 * sat at NEEDS_HUMAN with "no fragment cleared its evidence gate", their
 * missions RUNNING and their evidence read by nothing. And the pass that parks
 * or files stopped missions read the same 59 already-decided parks first on
 * every tick, so it reached none of them.
 *
 * These pin that such a packet is decided RECORD_GAPS under the standing grant
 * and filed from its accepted claims with the empty lane recorded as a gap; that
 * a fragment blocked for anything said about its claims is not; and that a
 * decided park no longer holds the park pass's window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getOrchestration,
  laneShortFragments,
  updateFragment,
  updateOrchestration,
} from '../server/repos/research.ts';
import { advancePacket } from '../server/services/research/packetRunner.ts';
import { answerUnaskedParks, ROUTINE_DECISION_GRACE_MS } from '../server/services/russell/routineDecisions.ts';
import { packetShape, choicesFor, parkStoppedMissions } from '../server/services/russell/needsHuman.ts';
import { listWorkItemsForOrchestration } from '../server/repos/workQueue.ts';

let projectId = '';
let layerId = '';
let userId = '';
let n = 0;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  userId = (await createUser({ email: `lane-${Math.random().toString(36).slice(2, 8)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

async function grant(): Promise<void> {
  await createGoal({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'standing', allowedWork: ['RESEARCH'], maxMissions: 5, maxFragments: 5, maxConcurrent: 5, maxProbes: 1 });
}

async function claim(orchestrationId: string, fragmentId: string, lane: string, accepted: boolean): Promise<void> {
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO research_claims
       (id, orchestration_id, fragment_id, pass_id, pass_key, claim, source_url, source_title,
        source_publisher, source_date, evidence_excerpt, evidence_locator, evidence_lane,
        retrieved_at, confidence, contradiction_state, contradiction_note, validation_state,
        validation_detail, sourced, derived, derived_from, accepted, content_hash, created_at)
     VALUES (?, ?, ?, NULL, 'RESEARCH', ?, ?, 'A rate card', NULL, NULL, 'Setup is $450 per site.', NULL, ?,
             ?, 0.9, 'UNCHALLENGED', NULL, 'SOURCED', NULL, 1, 0, '[]', ?, ?, ?)`,
    [`clm_${++n}`, orchestrationId, fragmentId, 'Setup is $450 per site.', `https://example.test/rates/${n}`, lane, at, accepted ? 1 : 0, `h${n}`, at],
  );
}

/** A parked packet of one fragment, BLOCKED for `cause`, holding one accepted claim on a lane other than the empty one. */
async function parkedPacket(cause: string): Promise<string> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({ projectId, layerId, runId: run.id, title: 'Price question', assignment: 'what it costs', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'market-signal',
      question: 'Who pays, and what?',
      requiredEvidence: [
        { id: 'payer', description: 'who pays', necessity: 'REQUIRED' },
        { id: 'price_evidence', description: 'a published price', necessity: 'REQUIRED' },
      ],
      acceptableSourceTypes: ['official'], excludedSourceTypes: [], completionCriteria: ['a price'], minIndependentSources: 1,
      maxRepairs: 2, dependsOn: [], attempt: 2,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, {
    status: 'BLOCKED',
    blockCause: cause,
    blockedReason: '1 required evidence lane(s) have no accepted claim: payer',
    completedAt: new Date().toISOString(),
  });
  await claim(orchestration.id, fragment!.id, 'price_evidence', true);
  await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN', failureReason: 'No fragment cleared its evidence gate, so there is nothing to synthesize.' });
  const old = new Date(Date.now() - ROUTINE_DECISION_GRACE_MS - 60_000).toISOString();
  await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [old, orchestration.id]);
  return orchestration.id;
}

async function mission(orchestrationId: string, updatedAt: string): Promise<string> {
  const id = `rms_${++n}`;
  await getDb().run(
    `INSERT INTO russell_missions (id, project_id, objective, why_now, state, orchestration_id, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 'price', 'the plan reads it', 'RUNNING', ?, ?, ?, ?)`,
    [id, projectId, orchestrationId, `key_${id}`, updatedAt, updatedAt],
  );
  return id;
}

describe('a fragment blocked only on an empty lane', () => {
  it('counts as filable evidence, and a fragment blocked over its claims does not', async () => {
    const laneShort = await parkedPacket('REQUIRED_LANE_EMPTY');
    const sourcesShort = await parkedPacket('INDEPENDENT_SOURCES_SHORT');
    expect(await laneShortFragments(laneShort)).toBe(1);
    expect(await laneShortFragments(sourcesShort)).toBe(0);
    expect(choicesFor(await packetShape(laneShort)).map((c) => c.key)).toContain('RECORD_GAPS');
    expect(choicesFor(await packetShape(sourcesShort)).map((c) => c.key)).toEqual(['STOP']);
  });

  it('is decided RECORD_GAPS under the standing grant and files from its accepted claims, with the empty lane a gap', async () => {
    await grant();
    const id = await parkedPacket('REQUIRED_LANE_EMPTY');
    const other = await parkedPacket('MOSTLY_REJECTED');
    const decided = await answerUnaskedParks({ ignoreBootGrace: true });
    expect(decided.map((d) => d.orchestrationId)).toContain(id);
    expect(decided.map((d) => d.orchestrationId)).not.toContain(other);
    const after = (await getOrchestration(id))!;
    expect(after.unresolvedGapPolicy).toBe('RECORD_GAPS');
    // Past "no fragment cleared its gate": the packet goes on to synthesis rather than parking again.
    expect(after.failureReason ?? '').not.toMatch(/No fragment cleared its evidence gate/);
    expect(after.status).toBe('SYNTHESIZING');
    expect((await listWorkItemsForOrchestration(id)).map((item) => item.workType)).toContain('RESEARCH_SYNTHESIZE');
    // The fragment stays BLOCKED: nothing was answered that was not.
    expect((await currentFragments(id))[0]!.status).toBe('BLOCKED');
  });

  it('still parks without the authorization: no person or grant decided to file short', async () => {
    const id = await parkedPacket('REQUIRED_LANE_EMPTY');
    await updateOrchestration(id, { status: 'RESEARCHING' });
    const result = await advancePacket(id);
    expect(result.waitingOn).toMatch(/no fragment cleared its gate/);
    expect(result.status).toBe('NEEDS_HUMAN');
    expect((await getOrchestration(id))!.failureReason).toMatch(/No fragment cleared its evidence gate/);
  });
});

describe('the park pass window', () => {
  it('reaches an undecided park behind decided ones that it leaves unchanged', async () => {
    await grant();
    const decidedAt = '2026-11-14T00:00:00.000Z';
    for (let i = 0; i < 3; i += 1) {
      const decided = await parkedPacket('REQUIRED_LANE_EMPTY');
      await getDb().run("UPDATE research_orchestrations SET unresolved_gap_policy = 'RECORD_GAPS' WHERE id = ?", [decided]);
      await mission(decided, decidedAt);
    }
    const undecided = await parkedPacket('INDEPENDENT_SOURCES_SHORT');
    const missionId = await mission(undecided, '2026-11-25T00:00:00.000Z');
    await parkStoppedMissions(1);
    // Nothing to file (its block is about its claims), so the mission ends rather than holding its slot.
    const row = await getDb().get<{ state: string }>('SELECT state FROM russell_missions WHERE id = ?', [missionId]);
    expect(row!.state).toBe('FAILED');
  });
});
