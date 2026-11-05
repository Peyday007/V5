/**
 * A park no card was opened for is decided under the standing grant (§80, §88).
 *
 * Production, 2026-11-05: eight packets sat at NEEDS_HUMAN after two judge
 * rounds and four had no Russell mission, so no Needs-You card existed and
 * nobody — person or Brain — was ever asked. The capability map read
 * DECISION.JOB_OUTCOME 0/6 over three hours. These pin that Brain records the
 * same RECORD_GAPS decision `answerRoutineParks` would, only where the grant
 * covers it, only with accepted evidence, and never over an open card.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, getOrchestration, updateFragment, updateOrchestration } from '../server/repos/research.ts';
import { answerUnaskedParks, ROUTINE_DECISION_GRACE_MS } from '../server/services/russell/routineDecisions.ts';

let projectId = '';
let layerId = '';
let userId = '';

async function parkedPacket(accepted: boolean): Promise<string> {
  const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p' });
  const orchestration = await createOrchestration({
    projectId, layerId, runId: run.id, title: 'Parked packet', assignment: 'a question', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId, fragmentIndex: 0, fragmentKey: 'f',
      question: 'What does the record say?', requiredEvidence: [{ id: 'official_source', description: 'the office', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official'], excludedSourceTypes: [], completionCriteria: ['a quote'], minIndependentSources: 1,
      maxRepairs: 2, dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  for (const fragment of await currentFragments(orchestration.id)) {
    await updateFragment(fragment.id, { status: accepted ? 'ACCEPTED' : 'BLOCKED', completedAt: new Date().toISOString() });
  }
  await updateOrchestration(orchestration.id, { status: 'NEEDS_HUMAN', failureReason: 'the judge still asked for more' });
  const old = new Date(Date.now() - ROUTINE_DECISION_GRACE_MS - 60_000).toISOString();
  await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [old, orchestration.id]);
  return orchestration.id;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
  userId = (await createUser({ email: `unasked-${Math.random().toString(36).slice(2, 8)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

describe('answerUnaskedParks', () => {
  it('files a card-less park with accepted evidence as RECORD_GAPS under the standing grant, once, and records who decided', async () => {
    await createGoal({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'standing', allowedWork: ['RESEARCH'], maxMissions: 1, maxFragments: 1, maxConcurrent: 1, maxProbes: 1 });
    const id = await parkedPacket(true);
    const first = await answerUnaskedParks({});
    expect(first.map((d) => [d.orchestrationId, d.decided])).toEqual([[id, true]]);
    const after = (await getOrchestration(id))!;
    expect(after.unresolvedGapPolicy).toBe('RECORD_GAPS');
    expect(after.unresolvedGapAuthorizedBy).toBe(userId);
    const event = await getDb().get<{ payload: string }>("SELECT payload FROM project_events WHERE event_type = 'RUSSELL_ROUTINE_DECISION' ORDER BY created_at DESC LIMIT 1");
    expect(event!.payload).toMatch(/Decided by Brain under the standing research grant/);
    // Authorized once: the next pass does not decide it again.
    expect((await answerUnaskedParks({})).filter((d) => d.decided)).toEqual([]);
  });

  it('leaves a park with nothing accepted, one inside the grace period, and one with no live grant', async () => {
    const nothing = await parkedPacket(false);
    expect(await answerUnaskedParks({})).toEqual([]); // no grant yet either
    await createGoal({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'standing', allowedWork: ['RESEARCH'], maxMissions: 1, maxFragments: 1, maxConcurrent: 1, maxProbes: 1 });
    expect((await answerUnaskedParks({})).map((d) => d.orchestrationId)).not.toContain(nothing);
    const fresh = await parkedPacket(true);
    await getDb().run('UPDATE research_orchestrations SET updated_at = ? WHERE id = ?', [new Date().toISOString(), fresh]);
    expect((await answerUnaskedParks({})).map((d) => d.orchestrationId)).not.toContain(fresh);
    await getDb().run(`UPDATE russell_goals SET state = 'REVOKED' WHERE project_id = ?`, [projectId]);
    const ungranted = await parkedPacket(true);
    expect((await answerUnaskedParks({})).map((d) => d.orchestrationId)).not.toContain(ungranted);
    expect((await getOrchestration(ungranted))!.unresolvedGapPolicy).not.toBe('RECORD_GAPS');
  });
});
