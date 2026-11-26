/**
 * RC13: a goal the route proposer has read is planned over its own routes, not
 * over constructed designs that never read the owner.
 *
 * Production 2026-11-26 (dev6, 12 fresh goals): a pickup-truck owner with no
 * money was handed "Fractional ownership of aircraft" at $30M toward $2,000
 * while the towing route read off their own words sat unmodelled. Once a goal
 * has a route of its own, a constructed design stands in its plan only when it
 * transfers one of those routes; the library keeps every design.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { createWorkstream, getWorkstream } from '../server/repos/register.ts';
import { setTerms } from '../server/services/goals/decide.ts';
import { readTarget, setTarget } from '../server/services/goals/target.ts';
import { forgetGoalReadings, goalArrangements } from '../server/services/goals/plan.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { listConstructedArrangements } from '../server/repos/monetization.ts';
import { routeRecordId } from '../server/domain/routeOrigin.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let layer: Layer;
const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  const fixture = await freshProject();
  userId = (await createUser({ email: `rc13-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId: fixture.project.id, ownerUserId: userId, actorUserId: userId, objective: 'Maximize usable cash over the next few weeks.' })).ok).toBe(true);
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
});

async function gated(claims: Array<{ claim: string; sourceUrl: string }>): Promise<string[]> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a question' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a question', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: 'any market',
      requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['a directory'], excludedSourceTypes: ['a forecast'], completionCriteria: ['a dated source'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'q', question: 'q', dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(orchestration.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const inserted = await insertClaims(
    claims.map((one) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim: one.claim, sourceUrl: one.sourceUrl, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: inDays(-3).slice(0, 10),
      evidenceExcerpt: one.claim, evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
      retrievedAt: inDays(-1).slice(0, 10), confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${one.claim}|${one.sourceUrl}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return inserted.map((one) => one.id);
}

async function vetSector(): Promise<void> {
  const [, buyer, bottleneck, supply] = await gated([
    { claim: 'Veterinary care is a sector.', sourceUrl: 'https://example.test/vet' },
    { claim: 'Independent veterinary clinics buy in Veterinary care.', sourceUrl: 'https://example.test/clinics' },
    { claim: 'After-hours phone coverage is a recurring problem.', sourceUrl: 'https://example.test/after-hours' },
    { claim: 'Remote answering services serve this.', sourceUrl: 'https://example.test/answering' },
  ]);
  const node = await createNode({ projectId, parentId: null, kind: 'SECTOR', name: 'Veterinary care', origin: 'SEED' });
  await createNode({ projectId, parentId: node.node.id, kind: 'BUYER_TYPE', name: 'Independent veterinary clinics', origin: 'DISCOVERED', sourceClaimId: buyer ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'BOTTLENECK', name: 'After-hours phone coverage', origin: 'DISCOVERED', sourceClaimId: bottleneck ?? null });
  await createNode({ projectId, parentId: node.node.id, kind: 'FULFILMENT_SOURCE', name: 'Remote answering services', origin: 'DISCOVERED', sourceClaimId: supply ?? null });
}

describe('an owner-read route leads the plan over constructed designs (RC13)', () => {
  it('holds constructed designs out of a goal with a route of its own, and keeps them in the library', async () => {
    await vetSector();
    const g = await createWorkstream({ projectId, title: 'Collect cash fast', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    await setTerms(g.id, { dueAt: inDays(30), ownerUserId: userId }, `person:${userId}`);
    expect((await setTarget({ goal: (await getWorkstream(g.id))!, metric: 'SETTLED_CASH', amountCents: 600_000, currency: 'USD', projectId, capitalCeilingCents: null, hoursCeiling: 200, now: new Date(now.getTime() - 60_000) })).ok).toBe(true);
    const goal = (await getWorkstream(g.id))!;
    const target = (await readTarget(goal, now))!;

    // No route yet: the goal is planned over the constructor's designs, as before.
    const before = await goalArrangements(goal, target, now);
    expect(before.length).toBeGreaterThan(0);

    const mode = (await getCashMode(projectId))!;
    // Another goal's route does not hold this goal's designs out.
    await createOpportunity({
      projectId, cashModeId: mode.id, ownerUserId: mode.ownerUserId, title: 'Someone else\'s route', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', industry: 'Retail',
      source: 'test', externalRecordId: routeRecordId('wst_someone_else', 'other'), requiredCapabilities: [],
    });
    expect((await goalArrangements(goal, target, now)).length).toBe(before.length);

    // The route proposer files a route read off the owner's words.
    await createOpportunity({
      projectId, cashModeId: mode.id, ownerUserId: mode.ownerUserId, title: 'Towing for local mechanics', mechanism: 'PRODUCTIZED_SERVICE', currency: 'USD', industry: 'Auto repair',
      source: 'test', externalRecordId: routeRecordId(goal.id, 'towing'), requiredCapabilities: [],
    });
    expect(await goalArrangements(goal, target, now)).toEqual([]);
    // Nothing is discarded: every composed design is still a library row.
    expect((await listConstructedArrangements(projectId)).length).toBeGreaterThanOrEqual(before.length);

  }, 120_000);
});
