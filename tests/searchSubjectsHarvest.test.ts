/**
 * A harvested opening teaches a subject.
 *
 * `learnSubject` had no production caller: discovery read learned lenses and
 * nothing ever wrote one, so a subject could be learned only in a test. The
 * harvest is the caller now, and this walks it from a finished mission.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { listLearnedSubjects } from '../server/repos/searchMethods.ts';
import { learnedLensesForProject, SUBJECT_LENS_PREFIX } from '../server/services/knowledge/subjects/subjects.ts';
import { SIGNAL_LANE, harvest, openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `harvest-subj-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function oneMission(candidateId: string, claim: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a bucket' });
  const o = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a bucket', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([{
    orchestrationId: o.id, projectId, layerId: layer.id, geography: 'the markets the sprint may look at',
    requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one dated request'],
    minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'cash-discovery',
    question: 'Who is publicly asking to pay for work right now?', dependsOn: [], attempt: 1,
  }] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(o.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [row] = await insertClaims([{
    orchestrationId: o.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const, claim,
    sourceUrl: 'https://example.test/rfp/learned', sourceTitle: 'A listing', sourcePublisher: 'A marketplace',
    sourceDate: '2026-09-10', evidenceExcerpt: claim, evidenceLocator: 'the listing body', evidenceLane: SIGNAL_LANE,
    opportunitySignal: 'EXPIRING_OPENING' as OpportunitySignal, closesOn: null, retrievedAt: '2026-09-12', confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    contentHash: `${claim}|x`,
  }]);
  await decideClaim(row!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a bucket', whyNow: 'active', idempotencyKey: `mission:${o.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: o.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

describe('a harvested opening teaches a subject', () => {
  it('stores the subject with its claim and offers it as a lens on the next run', async () => {
    const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
    expect(outcome.ok).toBe(true);
    const [first] = await openDiscovery({ projectId });
    await oneMission(first!.candidateId, 'A county published an RFP for parcel research, proposals due 25 September 2026.');
    expect(await harvest({ projectId })).toHaveLength(1);
    const learned = await listLearnedSubjects({ projectIds: [projectId], userId: null });
    expect(learned).toHaveLength(1);
    expect(learned[0]!.sourceRef).toMatch(/^claim:/);
    expect(learned[0]!.origin).toBe('harvest');
    expect((await learnedLensesForProject(projectId)).map((l) => l.id)).toEqual([`${SUBJECT_LENS_PREFIX}${learned[0]!.id}`]);
  });
});
