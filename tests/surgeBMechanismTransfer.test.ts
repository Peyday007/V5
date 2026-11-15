/**
 * Surge B mechanism layer (W-8, W-9, K-6 of docs/intelligence-recovery).
 *
 * - W-8: one adapter between §82 designs and §92 positions, and the §82
 *   transfer runs in the standing kernel pass with no live goal, as an ask
 *   that names its material differences — never as a fact.
 * - W-9: a world-level logistics root is not given the Metro Detroit pack;
 *   goal construction naming the industry still is.
 * - K-6: a stored arrangement carries its §92 position, which round-trips and
 *   the knowledge census counts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { activate, setLifecycle } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { listNodes, listIndustryRounds } from '../server/repos/industry.ts';
import { createWorkstream, listWorkstreams } from '../server/repos/register.ts';
import { listConstructedArrangements } from '../server/repos/monetization.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { runIndustryKernel } from '../server/services/industry/kernel.ts';
import { transferOfBucket } from '../server/services/industry/transfer.ts';
import { assembleEvidence, evidenceFromMap, goalConstruction, subtreeFor } from '../server/services/industry/construction/service.ts';
import { roleLensSeedsFor } from '../server/services/cash/discovery.ts';
import { designToPosition, positionToDesign } from '../server/services/industry/construction/designs.ts';
import { coherentPosition, positionKey } from '../server/services/industry/construction/businesses.ts';
import { rememberArrangements } from '../server/services/cash/arrangementLibrary.ts';
import { TRANSFER_MATERIAL, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { allDesigns, STRUCTURE_KEYS, type Design } from '../server/services/cash/properties.ts';
import { census } from '../scripts/knowledge-census.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  userId = (await createUser({ email: `mx-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
});

describe('W-8: one adapter between a design and a position', () => {
  it('maps every coherent design to a coherent position, keeping money timing and recurrence', () => {
    for (const design of allDesigns(STRUCTURE_KEYS)) {
      for (const equipment of [false, true]) {
        const position = designToPosition(design, equipment);
        expect(coherentPosition(position, equipment)).toBe(true);
        expect(position.moneyTiming ?? 'ON_DELIVERY').toBe(design.funding);
        expect(position.recurrence ?? 'ONE_OFF').toBe(design.repeat);
        const back = positionToDesign(position);
        // The two lossy pairs: a subcontract over pooled buyers is the pool position,
        // and an introduction holds no shared capacity.
        // (a presale needs pooling, so an introduction presold has no design at all).
        if (design.base === 'SUBCONTRACT' && design.aggregation === 'POOLED_BUYERS') expect(back!.base).toBe('POOL');
        else if (design.base === 'BROKER' && design.aggregation === 'POOLED_BUYERS') expect(back === null || back.aggregation === 'SINGLE').toBe(true);
        else expect(back).toEqual(design);
      }
    }
  });

  it('keeps every earlier position key, and answers null where no design exists', () => {
    expect(positionKey({ contract: 'PRIME', supply: 'NETWORK', assets: 'NONE', aggregation: 'SINGLE', information: 'NONE' })).toBe('PRIME/NETWORK/NONE/SINGLE/NONE');
    expect(positionKey({ contract: 'PRIME', supply: 'NETWORK', assets: 'NONE', aggregation: 'POOLED', information: 'NONE', moneyTiming: 'THRESHOLD_PRESALE', recurrence: 'RECURRING_COHORT' })).toBe(
      'PRIME/NETWORK/NONE/POOLED/NONE@THRESHOLD_PRESALE~RECURRING_COHORT',
    );
    expect(positionToDesign({ contract: 'NONE', supply: 'NETWORK', assets: 'NONE', aggregation: 'SINGLE', information: 'PLATFORM', revenue: 'SUBSCRIPTION' })).toBeNull();
  });

  it('a standing kernel pass with no live goal asks to carry a held precedent design to a different population', async () => {
    // A held precedent: payer and way of being paid established by gated claims.
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
    const mode = (await getCashMode(projectId))!;
    const precedent = await createOpportunity({
      projectId, cashModeId: mode.id, ownerUserId: userId, currency: 'USD', requiredCapabilities: [],
      title: 'Dental practices outsource after-hours sterilisation audits to contractors',
      mechanism: 'SUBCONTRACTED_FULFILMENT', sourceClaimId: 'clm_precedent', source: 'A publisher',
    });
    await updateOpportunity(precedent.id, { payer: 'Dental practices', industry: 'Dentistry' });
    // Payer and price as gated claims established them (F1: the shape the deep dive writes;
    // tests/productionPrecedentAndFacts.test.ts writes it through applyValidationAnswers itself).
    for (const field of ['payer', 'revenueRange']) {
      await recordCardFact({ projectId, opportunityId: precedent.id, field, kind: 'EVIDENCE', value: field === 'payer' ? 'Dental practices' : 'Practices pay $350 per audit.', claimId: `clm_${field}`, decidedBy: 'BRAIN' });
    }
    // The sprint ends; only a standing research grant remains, and no goal is live.
    await setLifecycle({ projectId, to: 'WINDING_DOWN', actorUserId: userId, reason: 'the sprint is over' });
    await createGoal({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'Standing research', allowedWork: ['RESEARCH'], maxMissions: 0, maxFragments: 0, maxConcurrent: 6, maxProbes: 0, workPolicy: 'UNCAPPED' });
    const kitchens = await seedSubject({ projectId, name: 'Commercial kitchens', actorRef: userId });
    const restaurants = await seedSubject({ projectId, name: 'Independent restaurants', kind: 'BUYER_TYPE', parentId: kitchens.node.id, actorRef: userId });
    await seedSubject({ projectId, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: kitchens.node.id, actorRef: userId });
    expect((await listWorkstreams({ projectIds: [projectId] })).length).toBe(0);
    const factsBefore = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM construction_facts'))!.n;

    const pass = await runIndustryKernel(projectId);
    expect(pass.failures ?? []).toEqual([]);
    expect(pass.basis).toBe('STANDING');
    const transfers = pass.transfers ?? [];
    expect(transfers.length).toBeGreaterThan(0);
    // To a different population only: never to the precedent's own payer.
    for (const ask of transfers) expect(ask.nodeId).toBe(restaurants.node.id);
    const opened = pass.opened.find((one) => transferOfBucket(one.bucketId) !== null)!;
    expect(opened).toBeDefined();
    expect(opened.nodeId).toBe(restaurants.node.id);
    expect(transferOfBucket(opened.bucketId)).toMatchObject({ precedentId: precedent.id, design: { base: 'SUBCONTRACT' } });
    // An ask, naming every material difference, and saying it is a hypothesis.
    expect(opened.question).toMatch(/hypothesis, not an established fact/);
    expect(opened.question).toContain('Dental practices outsource');
    for (const difference of TRANSFER_MATERIAL) expect(opened.question).toContain(difference);
    expect(opened.question).toContain('PRIME/NETWORK');
    // Never a fact: nothing was filed about these buyers.
    expect((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM construction_facts'))!.n).toBe(factsBefore);
    const round = (await listIndustryRounds(projectId)).find((one) => one.id === opened.roundId)!;
    expect(round.cashModeId).toBeNull();

    // Asked once: the next pass does not ask the same transfer of the same population again.
    const again = await runIndustryKernel(projectId);
    expect((again.transfers ?? []).some((one) => one.bucketId === opened.bucketId && one.nodeId === opened.nodeId)).toBe(false);
  });
});

describe('W-9: a reference pack only where an operator named the industry', () => {
  it('does not give a world-level logistics root the Metro Detroit pack', async () => {
    const root = await seedSubject({ projectId, name: 'Logistics', actorRef: userId });
    await seedSubject({ projectId, name: 'Per-stop route contracts', kind: 'TRANSACTION_TYPE', parentId: root.node.id, actorRef: userId });
    const nodes = await listNodes(projectId);
    const map = evidenceFromMap(subtreeFor(nodes, 'Logistics'), []);
    expect(map.flows.length).toBeGreaterThan(0);
    // Exactly as expand.ts and cash/discovery.ts call it for a map root.
    const evidence = assembleEvidence({ text: 'Logistics', industry: 'Logistics', geography: null, map, recorded: [] });
    expect(evidence.geography).toBeNull();
    expect(JSON.stringify(evidence)).not.toMatch(/Detroit|reference pack/);
    expect(evidence.facts).toHaveLength(0);
    expect(JSON.stringify(await roleLensSeedsFor(nodes, []))).not.toMatch(/Detroit/);
  });

  it('still applies it in goal construction, where the operator named the industry', async () => {
    const goal = await createWorkstream({ projectId, title: 'Delivery', intent: 'Build a last-mile delivery business.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    const read = (await goalConstruction(goal.id))!;
    expect(read.evidenceLayers.join(' ')).toMatch(/reference pack: last-mile delivery/);
  });
});

describe('K-6: a stored arrangement carries its §92 position', () => {
  it('round-trips the position and the census counts it', async () => {
    const design: Design = { base: 'PRODUCE', funding: 'PREPAID', aggregation: 'SINGLE', repeat: 'SUBSCRIPTION' };
    const arrangement = {
      key: 'abcdef012345',
      signature: `sig-${projectId}`,
      inputsDigest: 'digest-1',
      structure: 'PRODUCE',
      design,
      origin: 'FORWARD',
      precedent: null,
      sector: null,
      label: 'Prepaid monthly bookkeeping packs',
      demand: { name: 'Independent dentists', claimId: null, from: 'REVERSE', ref: 'r-demand' },
      need: { name: 'Monthly bookkeeping', claimId: null, from: 'REVERSE', ref: 'r-need' },
      supply: null,
    } as unknown as ConstructedArrangement;
    expect(await rememberArrangements(projectId, null, [arrangement])).toEqual({ created: 1, updated: 0, unchanged: 0 });
    const [stored] = await listConstructedArrangements(projectId);
    const expected = designToPosition(design, false);
    expect(stored!.position).toEqual(expected);
    expect(stored!.positionKey).toBe(positionKey(expected));
    expect(stored!.positionKey).toBe('PRIME/EMPLOY/NONE/SINGLE/NONE@PREPAID~SUBSCRIPTION');
    expect(positionToDesign(stored!.position!)).toEqual(design);
    // Unchanged on the next pass: the position is part of what "changed" means, and it did not.
    expect(await rememberArrangements(projectId, null, [arrangement])).toEqual({ created: 0, updated: 0, unchanged: 1 });

    const lines = await census();
    const value = (key: string) => lines.find((one) => one.key === key)!;
    expect(value('commercialPositions').note).toBeUndefined();
    expect(value('commercialPositions').value).toBeGreaterThanOrEqual(1);
    expect(value('arrangementsPositioned').value).toBeGreaterThanOrEqual(1);
    expect(value('positionMoneyFlows').value).toBeGreaterThanOrEqual(1);
  });
});
