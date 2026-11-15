/**
 * The census DIAG section (2026-11-15): why production holds no construction
 * fact and no researched arrangement, read from the functions the tick runs and
 * the back-fill's own selection as a dry run — and nothing written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { listProjectConstructionFacts } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { backfillClaimFacts } from '../server/services/industry/expand.ts';
import { profileFor } from '../server/services/russell/compilerProfiles.ts';
import { diagLines, diagProject, diagProjectIds } from '../scripts/knowledge-census.ts';
import type { EvidenceLane, Layer } from '../server/domain/types.ts';

const LANES: EvidenceLane[] = profileFor('RUSSELL_CASH_VALIDATION_V1')!.lanes;

let projectId = '';
let layer: Layer;
let ownerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  await getDb().run('UPDATE projects SET slug = ? WHERE id = ?', [`diag-${Math.random().toString(36).slice(2, 8)}`, projectId]);
  const owner = await createUser({ email: `d-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  ownerId = owner.id;
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!started.ok) throw new Error('could not activate');
});

/** Declared UNIT_ECONOMIC claims, one per qualifier, outside any kernel round. */
async function unitEconomicClaims(qualifiers: (string | null)[]): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'x' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'x', assignment: 'x', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    { orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'f', question: 'q', geography: null, timeframe: null, population: null, definitions: null, requiredEvidence: LANES, acceptableSourceTypes: [], excludedSourceTypes: [], completionCriteria: [], dependsOn: [], minIndependentSources: 1, status: 'QUEUED' },
  ]);
  await insertClaims(
    qualifiers.map((qualifier, i) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'TARGETED' as const,
      claim: `They pay $${300 + i} per cleaning (${i}).`, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/${i}`, sourceTitle: 'Survey',
      sourcePublisher: 'Assoc', sourceDate: '2026-09-01', evidenceExcerpt: 'x', evidenceLocator: 'x', evidenceLane: 'payer',
      retrievedAt: '2026-10-07T12:00:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `diag:${i}:${qualifier}`,
      structuralFinding: 'UNIT_ECONOMIC' as const, structuralSubject: 'price_per_unit', structuralQualifier: qualifier, structuralAmountCents: (300 + i) * 100,
    })),
  );
}

describe('census DIAG', () => {
  it('reports the back-fill pool as the writer computes it, with each rejection’s reason, and writes nothing', async () => {
    const root = await seedSubject({ projectId, name: 'Food service', actorRef: ownerId });
    await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    await unitEconomicClaims(['independent restaurant', 'independent restaurants', 'Hospitals', null]);

    expect(await diagProjectIds()).toContain(projectId);
    const diag = await diagProject(projectId);
    expect(diag.errors).toEqual([]);
    expect(diag.cashMode).toEqual({ exists: true, state: 'ACTIVE' });
    expect(diag.kernelSkips).toBeNull();
    expect(diag.kernelAuthority).toMatchObject({ allowed: true, basis: 'SPRINT' });
    expect(diag.knowledgeResearch).toMatchObject({ allowed: true, basis: 'SPRINT' });
    expect(diag.backfill).toMatchObject({ hasBuyerTypes: true, unitEconomicRead: 4, read: 4, candidates: 2, candidatesBySource: { UNIT_ECONOMIC: 2 }, rejected: 2 });
    if ('error' in diag.backfill) throw new Error(diag.backfill.error);
    expect(diag.backfill.topReasons).toEqual(
      expect.arrayContaining([
        { reason: 'UNIT_ECONOMIC: buyer qualifier matches no mapped buyer type', n: 1 },
        { reason: 'UNIT_ECONOMIC: claim names no buyer qualifier', n: 1 },
      ]),
    );
    expect(diag.backfill.topUnmatchedBuyers).toEqual([{ buyer: 'Hospitals', n: 1 }]);
    const lines = diagLines(diag);
    expect(lines.some((line) => line.includes('backfillRejected') && line.includes('matches no mapped buyer type'))).toBe(true);
    expect(lines.some((line) => line.includes('backfillUnmatchedBuyer') && line.includes('Hospitals'))).toBe(true);

    // A dry run: nothing filed — and the writer then files exactly the two candidates.
    expect(await listProjectConstructionFacts(projectId)).toHaveLength(0);
    expect((await backfillClaimFacts(projectId)).filed).toHaveLength(2);
  });

  it('names why nothing opens once the sprint is wound down with no standing grant', async () => {
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: ownerId, reason: 'the sprint is over' });
    const diag = await diagProject(projectId);
    expect(diag.cashMode.state).toBe('WINDING_DOWN');
    expect(diag.standingGrant.live).toBe(false);
    expect(diag.kernelAuthority.allowed).toBe(false);
    expect(diag.knowledgeResearch.allowed).toBe(false);
    expect(diag.knowledgeResearch.reason).toContain('No standing research grant');
    expect(diag.backfill).toMatchObject({ hasBuyerTypes: false, read: 0, candidates: 0 });
    expect(diag.constructedRounds24h).toEqual({});
    const lines = diagLines(diag);
    expect(lines).toContain(`DIAG ${projectId} cashMode WINDING_DOWN`);
    expect(lines.some((line) => line.includes('knowledgeResearch REFUSED') && line.includes('No standing research grant'))).toBe(true);
    expect(lines.some((line) => line.includes('buyerTypes=NONE'))).toBe(true);
  });
});
