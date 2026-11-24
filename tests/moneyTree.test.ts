/**
 * The commercial money tree (owner's requirement, reiterated 2026-11-24).
 *
 * Proved here against real rows:
 *   * with no goal at all, the standing library pass composes arrangements from
 *     the map and stores them in the §49 ledger, so they survive every
 *     in-memory cache being cleared;
 *   * the tree reads them back under industry → sub-industry → activity →
 *     mechanism → design, with each of the owner's eleven dimensions
 *     ESTABLISHED, HYPOTHESIS or UNKNOWN — never a favourable default;
 *   * the pass runs at most once per interval per project.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createNode } from '../server/repos/industry.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { clearConstructionMemo } from '../server/services/cash/construct.ts';
import { SIGNAL_LANE } from '../server/services/cash/discovery.ts';
import { resetStandingLibrary, standingLibraryPass } from '../server/services/cash/arrangementLibrary.ts';
import { forgetKnowledge } from '../server/services/quant/knowledge.ts';
import { forgetGoalReadings } from '../server/services/goals/plan.ts';
import { listConstructedArrangements } from '../server/repos/monetization.ts';
import { dimensionsOf, MONEY_TREE_DIMENSIONS, readMechanism, readMoneyTree, type MechanismInput } from '../server/services/cash/moneyTree.ts';
import type { Layer } from '../server/domain/types.ts';

let projectId = '';
let layer: Layer;

beforeEach(async () => {
  forgetKnowledge();
  forgetGoalReadings();
  clearConstructionMemo();
  resetStandingLibrary();
  const fixture = await freshProject();
  const owner = (await createUser({ email: `tree-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId: fixture.project.id, ownerUserId: owner, actorUserId: owner, objective: 'Map how money is made.' })).ok).toBe(true);
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
});

async function gatedClaims(claims: string[]): Promise<string[]> {
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
    claims.map((claim, i) => ({
      orchestrationId: orchestration.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
      claim, sourceUrl: `https://example.test/${i}/${encodeURIComponent(claim)}`, sourceTitle: 'A directory', sourcePublisher: 'A publisher', sourceDate: '2026-11-20',
      evidenceExcerpt: claim, evidenceLocator: 'the page', evidenceLane: 'structure', opportunitySignal: null, closesOn: null,
      retrievedAt: '2026-11-21', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
      claimType: 'SOURCED_FACT' as const, contentHash: `${claim}|${i}`,
    })),
  );
  for (const claim of inserted) await decideClaim(claim.id, { accepted: true });
  return inserted.map((one) => one.id);
}

async function sector(name: string, sub: string, buyer: string, bottleneck: string, supply: string): Promise<void> {
  const [buyerClaim, needClaim, supplyClaim] = await gatedClaims([`${buyer} buy in ${name}.`, `${bottleneck} is a recurring problem.`, `${supply} serve this.`]);
  const root = await createNode({ projectId, parentId: null, kind: 'SECTOR', name, origin: 'SEED' });
  const child = await createNode({ projectId, parentId: root.node.id, kind: 'SUB_INDUSTRY', name: sub, origin: 'SEED' });
  await createNode({ projectId, parentId: child.node.id, kind: 'BUYER_TYPE', name: buyer, origin: 'DISCOVERED', sourceClaimId: buyerClaim ?? null });
  await createNode({ projectId, parentId: child.node.id, kind: 'BOTTLENECK', name: bottleneck, origin: 'DISCOVERED', sourceClaimId: needClaim ?? null });
  await createNode({ projectId, parentId: child.node.id, kind: 'FULFILMENT_SOURCE', name: supply, origin: 'DISCOVERED', sourceClaimId: supplyClaim ?? null });
}

describe('the money tree', () => {
  it('grows the library from the map with no goal, and the tree reads it back after every cache is lost', async () => {
    await sector('Construction', 'Residential remodelling', 'independent general contractors', 'permit paperwork backlog', 'permit expediting firms');

    const pass = await standingLibraryPass(projectId);
    expect(pass.skipped).toBeNull();
    expect(pass.composed).toBeGreaterThan(0);
    expect(pass.created).toBeGreaterThan(0);

    const rows = await listConstructedArrangements(projectId);
    expect(rows.length).toBe(pass.created);
    expect(rows.every((one) => one.firstGoalId === null)).toBe(true);

    // A restart: nothing held in memory survives.
    clearConstructionMemo();
    forgetKnowledge();
    const tree = await readMoneyTree(projectId);
    expect(tree.summary.mechanisms).toBe(rows.length);
    const mapped = tree.mechanisms.filter((one) => one.industry.toLowerCase().includes('construction'));
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped.some((one) => one.subIndustry.toLowerCase().includes('remodelling'))).toBe(true);
    for (const one of tree.mechanisms) {
      for (const k of MONEY_TREE_DIMENSIONS) expect(['ESTABLISHED', 'HYPOTHESIS', 'UNKNOWN']).toContain(one.dimensions[k]);
      // The buyer rests on a gated claim; no price was ever filed, so price is never established and economics are not meaningful.
      expect(one.dimensions.PRICES_COSTS_MARGINS).not.toBe('ESTABLISHED');
      expect(one.meaningful).toBe(false);
    }
    expect(tree.summary.byDimension.PAYING_CUSTOMERS.ESTABLISHED + tree.summary.byDimension.PAYING_CUSTOMERS.HYPOTHESIS).toBeGreaterThan(0);

    // Once per interval: a second tick composes nothing.
    expect((await standingLibraryPass(projectId)).skipped).toBe('composed recently');
  });

  it('skips a project with no buyer population and no payer', async () => {
    const pass = await standingLibraryPass(projectId);
    expect(pass.composed).toBe(0);
    expect(pass.skipped).toMatch(/no buyer population/);
  });

  it('reads an unknown as UNKNOWN and evidence as ESTABLISHED, never the reverse', () => {
    const bare: MechanismInput = { pathId: 'p1', projectId: 'x', method: 'BROKERAGE', signature: 's1', design: null, verdict: null, evidenceFacts: 0, evaluatedCount: 0, askedCount: 0 };
    const none = dimensionsOf(bare);
    for (const k of MONEY_TREE_DIMENSIONS) expect(none[k]).toBe('UNKNOWN');

    const evidenced: MechanismInput = {
      ...bare,
      verdict: 'CONFIRMED',
      evidenceFacts: 1,
      design: {
        version: 1,
        constraints: [{ id: 'c1', kind: 'LICENSING' }],
        arrangement: {
          structure: 'PRODUCE',
          design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE_BUYER', repeat: 'ONE_OFF' },
          demand: { name: 'dental clinics', claimId: 'cl1', from: 'INDUSTRY_MAP', path: 'BUYER_TYPE:health care>dentistry>dental clinics' },
          need: { name: 'patient recall letters', claimId: 'cl2', from: 'INDUSTRY_MAP' },
          supply: { name: 'documents', claimId: null, from: 'CAPABILITY' },
          stress: { exposure: 'SAFE' },
          buyerTerms: { timing: 'ON_DELIVERY' },
          value: { tier: 'COMPARABLE', observations: 3, sources: ['claim:a'], p50: 400 },
          conversion: { tier: 'COMPARABLE', observations: 2 },
          relatedOpenings: ['opp_1'],
          unknownParts: [],
          evidenced: 2,
        },
      },
    };
    const reading = readMechanism(evidenced);
    expect(reading.industry).toBe('health care');
    expect(reading.subIndustry).toBe('dentistry');
    expect(reading.meaningful).toBe(true);
    expect(reading.gaps).toEqual([]);
    expect(reading.dimensions.AI_AUTOMATION).toBe('ESTABLISHED');
    expect(reading.dimensions.PRICES_COSTS_MARGINS).toBe('ESTABLISHED');

    // A price read under another payment mechanism is not evidence of this one's price.
    const notEvidence = readMechanism({ ...evidenced, design: { ...evidenced.design!, arrangement: { ...evidenced.design!.arrangement!, value: { tier: 'COMPARABLE', observations: 3, notEvidence: 'paid per hour', p50: 400 } } } });
    expect(notEvidence.dimensions.PRICES_COSTS_MARGINS).toBe('HYPOTHESIS');
    expect(notEvidence.meaningful).toBe(false);
  });
});
