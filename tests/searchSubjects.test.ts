import { beforeEach, describe, expect, it } from 'vitest';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { harvest, openDiscovery, SEARCH_BUCKETS, SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { listLearnedSubjects, listMethodRuns, listSearchMethods } from '../server/repos/searchMethods.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { bucketGates } from '../server/services/research/searchMethods/bucketMethods.ts';
import { runSearchCli } from '../server/services/research/searchReport/cli.ts';
import {
  learnedLensesForProject, learnSubject, learnSubjectFromClaim, lensFor, subjectKeyFor, subjectKindFromClaim, SUBJECT_LENS_PREFIX,
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

/** A round's research answered with one accepted, sourced claim, the way a worker's packet lands. */
async function answerRound(candidateId: string, claim: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a lens' });
  const o = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a lens', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([{
    orchestrationId: o.id, projectId, layerId: layer.id, geography: 'the markets the sprint may look at',
    requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one dated request'],
    minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'cash-discovery',
    question: 'Which public datasets exist for this subject?', dependsOn: [], attempt: 1,
  }] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(o.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [row] = await insertClaims([{
    orchestrationId: o.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const, claim,
    sourceUrl: 'https://example.test/data/permits', sourceTitle: 'A data portal', sourcePublisher: 'A city',
    sourceDate: '2026-09-10', evidenceExcerpt: claim, evidenceLocator: 'the catalog entry', evidenceLane: SIGNAL_LANE,
    opportunitySignal: 'EXPIRING_OPENING' as OpportunitySignal, closesOn: null, retrievedAt: '2026-09-12', confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    contentHash: `${claim}|x`,
  }]);
  await decideClaim(row!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a lens', whyNow: 'active', idempotencyKey: `mission:${o.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: o.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

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

describe('the kind of a learned subject is read from its claim, not fixed as a market', () => {
  it('reads datasets, suppliers and technologies, and a plain ask stays a market', () => {
    expect(subjectKindFromClaim('The city issued a request for proposals for an open dataset of building permits, due 3 October.')).toBe('DATASET');
    expect(subjectKindFromClaim('A hospital is seeking suppliers of nitrile gloves, quotes due Friday.')).toBe('SUPPLIER');
    expect(subjectKindFromClaim('The district is looking for scheduling software for its bus fleet, bids close 1 November.')).toBe('TECHNOLOGY');
    expect(subjectKindFromClaim('A county published an RFP for parcel research, proposals due 25 September 2026.')).toBe('MARKET');
  });

  it('files a harvested dataset claim as a DATASET subject whose lens asks about datasets', async () => {
    const s = await learnSubjectFromClaim({ projectId, claimId: 'c-data',
      claim: 'The city issued a request for proposals for an open dataset of building permits, due 3 October.' });
    expect(s?.subjectKey.startsWith('dataset:')).toBe(true);
    expect(lensFor(s!).question).toMatch(/public datasets/);
    const supplier = await learnSubjectFromClaim({ projectId, claimId: 'c-supply',
      claim: 'A hospital is seeking suppliers of nitrile gloves, quotes due Friday.' });
    expect(supplier?.subjectKey.startsWith('supplier:')).toBe(true);
    expect(lensFor(supplier!).question).toMatch(/who supplies/);
  });
});

describe('a non-cash subject runs the whole subject-discovery and method path', () => {
  it('a dataset subject learned from a claim opens a round, is harvested, becomes a method with a run, is gated and is reported', async () => {
    await activated();
    // Learned from a claim, the way the harvest learns it — not handed a kind.
    const subject = await learnSubjectFromClaim({ projectId, claimId: 'c-permits',
      claim: 'The city issued a request for proposals for an open dataset of building permits, due 3 October.' });
    expect(subject?.subjectKey.startsWith('dataset:')).toBe(true);
    const lensId = `${SUBJECT_LENS_PREFIX}${subject!.id}`;

    // Discovery offers it beside the constants and opens a round asking about datasets.
    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 5 });
    const round = opened.find((o) => o.bucketId === lensId);
    expect(round).toBeDefined();
    expect((await learnedLensesForProject(projectId)).find((l) => l.id === lensId)?.question).toMatch(/public datasets/);

    // The round's research lands and the harvest closes it.
    await answerRound(round!.candidateId,
      'The county is seeking a vendor to publish its building permits dataset as a monthly bulk download, proposals due 30 September.');
    expect(await harvest({ projectId })).toHaveLength(1);

    // The lens is now a PROJECT search method, and the closed round is one recorded run of it.
    const methods = (await listSearchMethods({ projectIds: [projectId], userId: null })).filter((m) => m.methodKey === lensId);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.finds).toMatch(/public datasets/);
    const runs = await listMethodRuns({ projectIds: [projectId], userId: null }, methods[0]!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('FOUND');
    expect(runs[0]!.surfaced).toBe(1);

    // Its gate is read from that run, and the search report names it.
    const gate = (await bucketGates(projectId, [lensId], new Date().toISOString())).get(lensId);
    expect(gate?.decision).not.toBeNull();
    const report = await runSearchCli(['methods', '--project', projectId]);
    expect(report.code).toBe(0);
    expect(report.out).toContain(lensId);

    // A round asked through a learned lens teaches no further subject, so the set cannot feed on itself.
    expect((await listLearnedSubjects({ projectIds: [projectId], userId: null })).filter((s) => s.projectId === projectId)).toHaveLength(1);
  });
});
