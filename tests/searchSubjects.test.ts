import { beforeEach, describe, expect, it } from 'vitest';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { harvest, openDiscovery, SEARCH_BUCKETS, SIGNAL_LANE, subjectKindOf } from '../server/services/cash/discovery.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listLearnedSubjects, listMethodRuns, listSearchMethods } from '../server/repos/searchMethods.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import { readMethodMetrics } from '../server/services/research/searchMetrics/read.ts';
import { buildSearchReport, renderSearchReport } from '../server/services/research/searchReport/report.ts';
import {
  learnedLensesForProject, learnSubject, lensFor, subjectKeyFor, SUBJECT_LENS_PREFIX,
} from '../server/services/knowledge/subjects/subjects.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `subjects-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function activated(): Promise<void> {
  const o = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
  expect(o.ok).toBe(true);
}

describe('learned subjects as discovery lenses', () => {
  it('stores a subject with its source, merges it beside the constants and opens a round for it', async () => {
    await activated();
    const s = await learnSubject({ scope: 'PROJECT', projectId, label: 'Mobile Notary Services', origin: 'research',
      sourceRef: 'claim:clm_123', description: 'signing agents' });
    expect(s.sourceRef).toBe('claim:clm_123');

    const lenses = await learnedLensesForProject(projectId);
    expect(lenses.map((l) => l.id)).toEqual([`${SUBJECT_LENS_PREFIX}${s.id}`]);

    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 5 });
    expect(opened.map((o) => o.bucketId)).toContain(`${SUBJECT_LENS_PREFIX}${s.id}`);
    expect(opened).toHaveLength(SEARCH_BUCKETS.length + 1); // constants stay, subject is added
    expect((await listRounds(projectId)).some((r) => r.bucketId === `${SUBJECT_LENS_PREFIX}${s.id}`)).toBe(true);
  });

  it('survives a restart: it is a row, and re-learning it is one subject', async () => {
    const a = await learnSubject({ scope: 'PROJECT', projectId, label: 'Dock Leveler Repair', origin: 'research', sourceRef: 'claim:a' });
    const b = await learnSubject({ scope: 'PROJECT', projectId, label: ' dock  leveler repair ', origin: 'research', sourceRef: 'claim:b' });
    expect(b.id).toBe(a.id);
    expect(await listLearnedSubjects({ projectIds: [projectId], userId: null })).toHaveLength(1);
  });

  it('runs the same path for a non-cash target', async () => {
    const s = await learnSubject({ scope: 'PROJECT', projectId, label: 'County parcel records', kind: 'DATASET',
      origin: 'research', sourceRef: 'doc:1' });
    expect(s.subjectKey).toBe(subjectKeyFor('County parcel records', 'DATASET'));
    expect(lensFor(s).question).toMatch(/public datasets/);
  });

  it("does not offer another project's subject, but does offer a GENERAL one", async () => {
    const other = await freshProject();
    await learnSubject({ scope: 'PROJECT', projectId: other.project.id, label: 'Private thing', origin: 'research', sourceRef: 'x' });
    await learnSubject({ scope: 'GENERAL', label: 'Shared method area', origin: 'research', sourceRef: 'y' });
    const labels = (await learnedLensesForProject(projectId)).map((l) => l.title);
    expect(labels).toEqual(['Learned subject: Shared method area']);
  });

  it('refuses a subject with no source', async () => {
    await expect(learnSubject({ scope: 'PROJECT', projectId, label: 'x', origin: 'research', sourceRef: ' ' })).rejects.toThrow(/source/);
  });
});

/** One finished research mission for a round's candidate, carrying one accepted, sourced claim. */
async function finishedMission(candidateId: string, claim: string, sourceUrl: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a round' });
  const o = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a round', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([{
    orchestrationId: o.id, projectId, layerId: layer.id, geography: 'the markets the sprint may look at',
    requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one dated example'],
    minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'cash-discovery',
    question: 'What is published right now?', dependsOn: [], attempt: 1,
  }] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(o.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [row] = await insertClaims([{
    orchestrationId: o.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const, claim,
    sourceUrl, sourceTitle: 'A publication', sourcePublisher: 'A county',
    sourceDate: '2026-09-10', evidenceExcerpt: claim, evidenceLocator: 'the page body', evidenceLane: SIGNAL_LANE,
    opportunitySignal: 'EXPIRING_OPENING' as OpportunitySignal, closesOn: null, retrievedAt: '2026-09-12', confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    contentHash: `${claim}|${sourceUrl}`,
  }]);
  await decideClaim(row!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a round', whyNow: 'active', idempotencyKey: `mission:${o.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: o.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

describe('a subject that is not a market', () => {
  it('reads the kind of subject from the claim, so the harvest can teach more than markets', () => {
    expect(subjectKindOf('The county assessor publishes its parcel dataset as a weekly CSV bulk download.')).toBe('DATASET');
    expect(subjectKindOf('Three regional manufacturers publish wholesale terms for dock levelers.')).toBe('SUPPLIER');
    expect(subjectKindOf('An open-source platform for permit tracking lists paid support tiers.')).toBe('TECHNOLOGY');
    expect(subjectKindOf('A county published an RFP for parcel research, proposals due 25 September 2026.')).toBe('MARKET');
  });

  it('runs end to end for a dataset: learned by the harvest, asked as its own round, closed as a method run, measured and reported', async () => {
    await activated();
    const reader = { projectIds: [projectId], userId: null };

    // 1. A constant bucket's round finds a claim that names a public dataset; the harvest learns it as a DATASET.
    const [first] = await openDiscovery({ projectId });
    await finishedMission(first!.candidateId,
      'The county assessor publishes its parcel dataset as a weekly CSV bulk download on its open data portal.',
      'https://example.test/assessor/parcels');
    expect(await harvest({ projectId })).toHaveLength(1);
    const learned = await listLearnedSubjects(reader);
    expect(learned).toHaveLength(1);
    const subject = learned[0]!;
    expect(subject.subjectKey.startsWith('dataset:')).toBe(true);
    expect(subject.origin).toBe('harvest');
    const lensId = `${SUBJECT_LENS_PREFIX}${subject.id}`;

    // 2. The next discovery pass opens a round of that subject, asking the dataset question.
    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 5 });
    const round = opened.find((o) => o.bucketId === lensId);
    expect(round).toBeTruthy();
    const candidate = await getCandidate(round!.candidateId);
    expect(candidate?.statement).toMatch(/which public datasets exist/);

    // 3. Its research finishes with a sourced example; the harvest files it under the subject's round,
    //    closes the round, and records the round as a run of the subject's method.
    await finishedMission(round!.candidateId,
      'The state land office publishes a statewide parcel register updated monthly, free to download.',
      'https://example.test/land-office/register');
    const filed = await harvest({ projectId });
    expect(filed).toHaveLength(1);
    const rounds = (await listRounds(projectId)).filter((r) => r.bucketId === lensId);
    expect(rounds.map((r) => r.state)).toEqual(['HARVESTED']);
    expect(rounds[0]!.found).toBe(1);
    // A round asked through a learned lens does not teach another subject.
    expect(await listLearnedSubjects(reader)).toHaveLength(1);

    const method = (await listSearchMethods(reader)).find((m) => m.methodKey === lensId);
    expect(method).toBeTruthy();
    expect(method!.finds).toMatch(/public datasets/);
    expect((await listMethodRuns(reader, method!.id)).map((r) => r.outcome)).toEqual(['FOUND']);

    // 4. The method's metrics are read from that run …
    const reading = (await readMethodMetrics(reader)).find((r) => r.method.methodKey === lensId);
    expect(reading?.metrics.runs).toBe(1);
    expect(reading?.metrics.outcomes['FOUND']).toBe(1);
    expect(reading?.metrics.relevant).toBe(1);

    // 5. … and the search report carries the method and the learned subject.
    const report = await buildSearchReport(reader);
    const line = report.methods.find((m) => m.methodKey === lensId);
    expect(line?.runs).toBe(1);
    expect(line?.outcomes['FOUND']).toBe(1);
    expect(report.subjects.learned).toBe(1);
    expect(renderSearchReport(report)).toContain(lensId);

    // Another project's reader sees none of it.
    const elsewhere = await freshProject();
    const otherReader = { projectIds: [elsewhere.project.id], userId: null };
    expect((await buildSearchReport(otherReader)).methods.find((m) => m.methodKey === lensId)).toBeUndefined();
  });
});
