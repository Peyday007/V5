/**
 * The archive check sees what the project's own gate already accepted — inside
 * a BLOCKED fragment as readily as an ACCEPTED one — and no bar moves to let it.
 *
 * What is real: the orchestration, fragment and claim rows, the gate-accepted
 * flag, `coverBeforeWork` and the unchanged `assessRequirement` behind it.
 * Nothing is simulated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createProject } from '../server/repos/projects.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  decideClaim,
  getFragment,
  insertClaims,
  ownCitableAsExisting,
  updateFragment,
} from '../server/repos/research.ts';
import { promoteEligibleClaims } from '../server/repos/sharedFindings.ts';
import { sharedClaimsForProject } from '../server/services/knowledge/shared.ts';
import {
  archiveReadCount,
  coverBeforeWork,
  currentArchiveMarker,
  resetArchiveReadCount,
  withArchiveMemo,
} from '../server/services/russell/coverage.ts';
import { projectClaims } from '../server/services/reconcile/coverage.ts';

let projectId = '';
let layerId = '';

const QUESTION = 'Employment in the outsourced telemarketing occupation during 2024';
const REQUIREMENT = {
  key: 'telemarketing-employment',
  statement: 'Employment in the outsourced telemarketing occupation during 2024',
};

async function packet(over: { projectId?: string; layerId?: string; question?: string } = {}): Promise<{
  orchestrationId: string;
  fragmentId: string;
}> {
  const pid = over.projectId ?? projectId;
  const lid = over.layerId ?? layerId;
  const run = await createRun({
    projectId: pid,
    layerId: lid,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'employment',
  });
  const orchestration = await createOrchestration({
    projectId: pid,
    layerId: lid,
    runId: run.id,
    title: 'employment',
    assignment: 'employment',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: pid,
      layerId: lid,
      fragmentIndex: 0,
      fragmentKey: 'employment',
      question: over.question ?? QUESTION,
      requiredEvidence: [{ id: 'figure', description: 'a published employment figure', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official statistics'],
      excludedSourceTypes: [],
      completionCriteria: ['a figure'],
      dependsOn: [],
      minIndependentSources: 2,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  return { orchestrationId: orchestration.id, fragmentId: fragment!.id };
}

async function acceptedClaim(input: {
  orchestrationId: string;
  fragmentId: string;
  host: string;
  suffix: string;
  accepted?: boolean;
}): Promise<string> {
  const [claim] = await insertClaims([
    {
      orchestrationId: input.orchestrationId,
      fragmentId: input.fragmentId,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: `Employment in the outsourced telemarketing occupation during 2024 was 81,580 ${input.suffix}`,
      sourceUrl: `https://${input.host}/oes/${input.suffix}`,
      sourceTitle: 'Occupational employment',
      sourcePublisher: input.host,
      sourceDate: '2025-04-01',
      evidenceExcerpt: 'Telemarketers 81,580',
      evidenceLocator: 'table 1',
      evidenceLane: 'figure',
      retrievedAt: '2026-09-12',
      confidence: 0.9,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: `h-${input.suffix}`,
    },
  ]);
  if (input.accepted !== false) await decideClaim(claim!.id, { accepted: true });
  return claim!.id;
}

async function block(fragmentId: string): Promise<void> {
  await updateFragment(fragmentId, {
    status: 'BLOCKED',
    completedAt: new Date().toISOString(),
    blockedReason: 'The accepted evidence rests on too few independent publishers.',
  });
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
  resetArchiveReadCount();
});

describe('own gate-accepted claims inside a BLOCKED fragment', () => {
  it('satisfy a requirement when two publishers agree, and the fragment stays BLOCKED', async () => {
    const { orchestrationId, fragmentId } = await packet();
    const a = await acceptedClaim({ orchestrationId, fragmentId, host: 'www.bls.gov', suffix: 'a' });
    const b = await acceptedClaim({ orchestrationId, fragmentId, host: 'census.gov', suffix: 'b' });
    await block(fragmentId);

    const coverage = await coverBeforeWork({ projectId, layerId, requirements: [REQUIREMENT] });
    expect(coverage.verdicts[0]!.status).toBe('SATISFIED');
    expect(coverage.fullyAnswered).toBe(true);
    // Provenance is the claim id itself.
    expect(coverage.verdicts[0]!.claimIds).toEqual(expect.arrayContaining([a, b]));

    // Reuse is a reading. The fragment is not treated as complete.
    expect((await getFragment(fragmentId))!.status).toBe('BLOCKED');
  });

  it('do not satisfy it with one publisher: the bar is the classifier’s, unchanged', async () => {
    const { orchestrationId, fragmentId } = await packet();
    await acceptedClaim({ orchestrationId, fragmentId, host: 'www.bls.gov', suffix: 'a' });
    await acceptedClaim({ orchestrationId, fragmentId, host: 'bls.gov', suffix: 'b' });
    await block(fragmentId);

    const coverage = await coverBeforeWork({ projectId, layerId, requirements: [REQUIREMENT] });
    expect(coverage.verdicts[0]!.status).toBe('PARTIALLY_SATISFIED');
    expect(coverage.verdicts[0]!.needsResearch).toBe(true);
    expect(coverage.fullyAnswered).toBe(false);
  });

  it('never reuse a claim the gate did not accept', async () => {
    const { orchestrationId, fragmentId } = await packet();
    await acceptedClaim({ orchestrationId, fragmentId, host: 'bls.gov', suffix: 'a' });
    await acceptedClaim({ orchestrationId, fragmentId, host: 'census.gov', suffix: 'b', accepted: false });
    await block(fragmentId);
    const own = await ownCitableAsExisting(projectId);
    expect(own).toHaveLength(1);
    expect(own[0]!.verificationState).toBe('VERIFIED');
    expect((await projectClaims(projectId)).map((claim) => claim.id)).toEqual(own.map((claim) => claim.id));
  });

  it('stay inside their project: the cross-project pool still requires an ACCEPTED fragment', async () => {
    const { orchestrationId, fragmentId } = await packet();
    await acceptedClaim({ orchestrationId, fragmentId, host: 'bls.gov', suffix: 'a' });
    await acceptedClaim({ orchestrationId, fragmentId, host: 'census.gov', suffix: 'b' });
    await block(fragmentId);
    await promoteEligibleClaims();

    const other = await createProject({ name: 'Another operation', slug: 'another-operation' });
    expect(await sharedClaimsForProject(other.id)).toEqual([]);
    expect(await ownCitableAsExisting(other.id)).toEqual([]);
  });
});

describe('the archive is read once per tick, under a marker', () => {
  it('serves every check in one scope from one read', async () => {
    const { orchestrationId, fragmentId } = await packet();
    await acceptedClaim({ orchestrationId, fragmentId, host: 'bls.gov', suffix: 'a' });
    resetArchiveReadCount();
    await withArchiveMemo(async () => {
      await coverBeforeWork({ projectId, layerId, requirements: [REQUIREMENT] });
      await coverBeforeWork({ projectId, layerId, requirements: [{ key: 'x', statement: 'Something else' }] });
      await projectClaims(projectId);
    });
    expect(archiveReadCount()).toBe(1);

    // Outside a scope, nothing is held.
    await coverBeforeWork({ projectId, layerId, requirements: [REQUIREMENT] });
    expect(archiveReadCount()).toBe(2);
  });

  it('marks an identical search on an unchanged archive as a repeat, and lets it run once facts move', async () => {
    const marker = await currentArchiveMarker(projectId);
    const { orchestrationId, fragmentId } = await packet();
    // A search that ran to the end of its ladder against this archive.
    const { getDb } = await import('../server/db/database.ts');
    await getDb().run(
      'UPDATE research_fragments SET archive_marker = ?, attempt = max_repairs WHERE id = ?',
      [marker, fragmentId],
    );
    await updateFragment(fragmentId, {
      status: 'BLOCKED',
      completedAt: new Date().toISOString(),
      verdictDetail: {
        integrity: 'FAIL',
        sufficiency: 'INSUFFICIENT',
        claims: [{ claimId: 'c1', accepted: false, failedCondition: 'SOURCE_SUPPORTS', reason: 'no' }],
        unresolvedRetrieval: [],
        acceptedClaims: 0,
        rejectedClaims: 1,
        independentSources: 0,
        coverage: [],
        duplicateSourceGroups: [],
        failedConditions: ['SOURCE_SUPPORTS'],
        reasons: ['nothing survived'],
        unresolvedGaps: [],
      },
      blockedReason: 'nothing survived',
    });
    expect((await getFragment(fragmentId))!.blockCause).toBe('NOTHING_SURVIVED');

    const first = await coverBeforeWork({ projectId, layerId, requirements: [{ key: 'q', statement: QUESTION }] });
    expect(first.archiveMarker).toBe(marker);
    expect(first.verdicts[0]!.repeats?.fragmentId).toBe(fragmentId);
    expect(first.nothingNewToSearch).toBe(true);
    // A repeat is a reading about the search, never an answer.
    expect(first.fullyAnswered).toBe(false);

    // New gated evidence moves the marker: the question is searched again.
    const fresh = await packet({ question: 'Something unrelated entirely' });
    await acceptedClaim({ orchestrationId: fresh.orchestrationId, fragmentId: fresh.fragmentId, host: 'x.gov', suffix: 'z' });
    await updateFragment(fresh.fragmentId, { status: 'ACCEPTED', completedAt: new Date().toISOString() });
    const second = await coverBeforeWork({ projectId, layerId, requirements: [{ key: 'q', statement: QUESTION }] });
    expect(second.archiveMarker).not.toBe(marker);
    expect(second.verdicts[0]!.repeats).toBeNull();
    expect(second.nothingNewToSearch).toBe(false);
    void orchestrationId;
  });
});
