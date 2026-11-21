/**
 * Production fresh plan reads, 2026-11-21 (goals C, $100K and $5K/mo): COST
 * was the dominant lever on every one (÷2 → reach 96.2%, 84.0%, 100.0%).
 * Construction already decomposed each arrangement with the quant engine
 * (`composeArrangement` → `reconstruct`), and a MARGIN design's `a_supply_cost`
 * node read the subcontractor rates research filed for its buyers — but that
 * estimate reached only the stress check. The plan's `arrangementOpening` then
 * swept the direct cost blind, from nothing to 60% of the top price.
 *
 * Driven here end to end on a deliverable no other fixture uses — commercial
 * kitchen hood-vent cleaning for restaurants, fulfilled by a licensed
 * subcontractor: the price and the subcontractor per-job rates are filed as
 * production files them (accepted claims → `recordClaimFact`, segmented to the
 * map's buyer type), construction composes the design through the one path
 * (`composeInvented` over `inventionContext`), and the goal model reads it
 * (`estimatedFromArrangement`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, insertClaims } from '../server/repos/research.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { composeInvented, constructionObservations, inventionContext, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { estimatedFromArrangement, reconstructedSupplyCostPerDeal } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';
import type { Layer } from '../server/domain/types.ts';

const BUYERS = 'Restaurants with commercial kitchens';
const NOW = new Date('2026-11-21T12:00:00.000Z');
/** Own the restaurant, pay the licensed hood-cleaning subcontractor per job, keep the margin. */
const SPEC = { design: { base: 'SUBCONTRACT', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as const, population: BUYERS, need: 'Commercial kitchen hood and exhaust-duct cleaning to NFPA 96' };

const PRICES = [
  ['A restaurant pays $450 for one kitchen exhaust hood cleaning visit.', 450],
  ['Hood-vent cleaning for a single-hood restaurant kitchen is quoted at $600 per cleaning.', 600],
  ['Restaurants pay $750 per NFPA 96 hood and duct cleaning service.', 750],
] as const;
const RATES = [
  ['A licensed hood-cleaning subcontractor charges $250 per restaurant job.', 250],
  ['Subcontracted hood cleaning crews bill $300 per kitchen exhaust job.', 300],
  ['A certified hood cleaner takes subcontract work at $375 per job.', 375],
] as const;

let projectId = '';
let layer: Layer;
let buyerId = '';
let orchestrationId = '';
let fragmentId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Monetization Logic');
  const owner = await createUser({ email: `hood-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true });
  const started = await activate({ projectId, ownerUserId: owner.id, actorUserId: owner.id, objective: 'Collect 10000 dollars of settled cash.' });
  if (!started.ok) throw new Error('could not activate');
  const sector = await seedSubject({ projectId, name: 'Food service', actorRef: 'BRAIN' });
  buyerId = (await seedSubject({ projectId, name: BUYERS, kind: 'BUYER_TYPE', parentId: sector.node.id, actorRef: 'BRAIN' })).node.id;
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'hood' });
  const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'Hood-vent cleaning economics', assignment: 'hood', provider: 'WORKER', autoApprove: false });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id, projectId, layerId: layer.id, fragmentIndex: 0, fragmentKey: 'hood-economics',
      question: 'What do restaurants pay for hood cleaning, and what do licensed subcontractors charge per job?', geography: 'United States', timeframe: 'as at 2026', population: null, definitions: null,
      requiredEvidence: [], acceptableSourceTypes: ['a published price list'], excludedSourceTypes: [], completionCriteria: ['A price and a rate.'],
      dependsOn: [], minIndependentSources: 1, status: 'ACCEPTED',
    },
  ]);
  orchestrationId = orchestration.id;
  fragmentId = fragment!.id;
});

/** Accepted, sourced claims, each filed as one OBSERVED construction fact about these buyers. */
async function file(key: 'price_per_unit' | 'contractor_rate_per_unit', rows: readonly (readonly [string, number])[]): Promise<string[]> {
  const claims = await insertClaims(
    rows.map(([text], i) => ({
      orchestrationId, fragmentId, passId: null, passKey: 'TARGETED' as const,
      claim: text, claimType: 'SOURCED_FACT' as const, sourceUrl: `https://example.org/hood-${key}-${i}`, sourceTitle: 'Hood cleaning pricing',
      sourcePublisher: 'A hood-cleaning firm', sourceDate: '2026-11-01', evidenceExcerpt: text, evidenceLocator: 'pricing', evidenceLane: 'economics',
      retrievedAt: '2026-11-20T20:40:00.000Z', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null,
      sourced: true, accepted: true, rejectionReason: null, contentHash: `hood:${key}:${i}:${text}`,
    })),
  );
  for (const [i, claim] of claims.entries()) {
    const amount = rows[i]![1];
    await recordClaimFact({
      projectId, nodeId: buyerId, claimId: claim.id, key, segment: `map_${buyerId}`, low: amount, high: amount, status: 'OBSERVED',
      measures: rows[i]![0], sourceTitle: 'Hood cleaning pricing', sourceUrl: `https://example.org/hood-${key}-${i}`, sourceKind: 'SECONDARY', observedAt: '2026-11-01T00:00:00.000Z',
    });
  }
  return claims.map((one) => one.id);
}

async function composeIt(): Promise<ConstructedArrangement> {
  const made = composeInvented(SPEC, await inventionContext({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: 300_000, daysLeft: 22, now: NOW }));
  if ('refused' in made) throw new Error(made.refused);
  return made;
}

const model = (one: ConstructedArrangement) => estimatedFromArrangement(one, { projectId, currency: 'USD', daysLeft: 22, beforeProofCents: null, now: NOW })!;

describe('a supply cost the quant engine reconstructed from filed subcontractor rates reaches the plan', () => {
  it('construction reconstructs the per-deal supply cost, and the plan reads that range, as reconstructed and not established', async () => {
    await file('price_per_unit', PRICES);
    const rates = await file('contractor_rate_per_unit', RATES);
    const read = await constructionObservations({ projectId, currency: 'USD', daysLeft: 22 });
    expect(read.unitCost.map((one) => (one.value.kind === 'POINT' ? one.value.value : null)).sort((a, b) => a! - b!)).toEqual(RATES.map(([, v]) => v));

    const arrangement = await composeIt();
    // (1) Construction decomposed it and reconstructed the supply cost from the filed rates.
    expect(arrangement.value.tier).not.toBe('UNKNOWN');
    expect(arrangement.supplyCost).toBeDefined();
    const sc = arrangement.supplyCost!;
    expect(sc.tier).not.toBe('UNKNOWN');
    expect(sc.observations).toBe(3);
    expect(sc.sources).toEqual(rates.map((id) => `claim:${id}`).sort());
    expect(sc.p10).toBeLessThanOrEqual(sc.p50);
    expect(sc.p50).toBeLessThanOrEqual(sc.p90);
    expect(sc.p50).toBeGreaterThan(250);
    expect(sc.p50).toBeLessThan(375);
    console.log('RECONSTRUCTED supplyCost', JSON.stringify({ tier: sc.tier, p10: sc.p10, p50: sc.p50, p90: sc.p90, observations: sc.observations, evidence: !!sc.evidence }));

    // (2) The plan's direct cost is that reconstructed range, not the 0–60% sweep.
    const modelled = model(arrangement);
    const cost = modelled.directCost;
    console.log('AFTER directCost', JSON.stringify({ low: cost.low, high: cost.high, provenance: cost.provenance, tier: cost.inferred?.tier, price: [modelled.price.low, modelled.price.high] }));
    expect(cost.provenance).toBe(sc.tier === 'DIRECT' && sc.evidence ? 'EVIDENCE' : 'ASSUMPTION');
    expect(cost.low!).toBeLessThanOrEqual(sc.p10 + 1e-9);
    expect(cost.high!).toBeGreaterThanOrEqual(sc.p90 - 1e-9);
    expect(cost.low!).toBeGreaterThan(0);
    expect(cost.note).toContain('reconstructed');
    expect(cost.note).toContain(sc.tier);
    expect(cost.note).toContain(`${sc.observations} obs.`);
    expect(cost.source?.note).toContain(`claim:${rates[0]}`);
    expect(cost.note).not.toContain('nobody has established the direct cost');
    expect(cost.inferred).toMatchObject({ tier: sc.tier, observations: 3 });

    // (4) A reconstruction short of DIRECT and justified establishes nothing.
    if (!(sc.tier === 'DIRECT' && sc.evidence)) {
      expect(cost.inferred?.justified).toBe(false);
      expect(cost.distribution).toBeUndefined();
      expect(inputEvidence(cost, 'directCost').establishes).toBe(false);
    }
  });

  it('with no cost observations filed, the direct cost stays the 0–60% sweep, unchanged', async () => {
    await file('price_per_unit', PRICES);
    const arrangement = await composeIt();
    expect(arrangement.supplyCost).toBeUndefined();
    expect(reconstructedSupplyCostPerDeal(arrangement)).toBeNull();
    const modelled = model(arrangement);
    console.log('BEFORE/NO-OBS directCost', JSON.stringify({ low: modelled.directCost.low, high: modelled.directCost.high, provenance: modelled.directCost.provenance, price: [modelled.price.low, modelled.price.high] }));
    expect(modelled.directCost).toMatchObject({ provenance: 'UNKNOWN', low: 0 });
    expect(modelled.directCost.high!).toBeCloseTo(modelled.price.high! * 0.6, 6);
    expect(modelled.directCost.note).toContain('nobody has established the direct cost');
  });

  it('enters only a DIRECT, justified reconstruction as evidence, and never narrower than its p10–p90', () => {
    const base = { key: 'hood', design: SPEC.design };
    const comparable = reconstructedSupplyCostPerDeal({ ...base, supplyCost: { tier: 'COMPARABLE', p10: 200, p50: 300, p90: 420, observations: 3, sources: ['claim:a'], evidence: { values: [300], low: 190, high: 430, events: 30, populations: 3, sizedPopulations: 3 } } })!;
    expect(comparable).toMatchObject({ provenance: 'ASSUMPTION', low: 200, high: 420 });
    expect(comparable.inferred).toMatchObject({ tier: 'COMPARABLE', justified: false });
    expect(inputEvidence(comparable, 'directCost').establishes).toBe(false);
    for (const tier of ['COMPONENT', 'MECHANISM'] as const) {
      const one = reconstructedSupplyCostPerDeal({ ...base, supplyCost: { tier, p10: 200, p50: 300, p90: 420, observations: 2, sources: [] } })!;
      expect(one.provenance).toBe('ASSUMPTION');
      expect(one.note).toContain(`${tier.toLowerCase()} evidence`);
    }
    const direct = reconstructedSupplyCostPerDeal({ ...base, supplyCost: { tier: 'DIRECT', p10: 200, p50: 300, p90: 420, observations: 4, sources: ['claim:b'], evidence: { values: [210, 300, 410], low: 190, high: 430, events: 40, populations: 4, sizedPopulations: 4 } } })!;
    expect(direct.provenance).toBe('EVIDENCE');
    expect(direct.low!).toBeLessThanOrEqual(200);
    expect(direct.high!).toBeGreaterThanOrEqual(420);
    // A pooled design reads its shared run's cost (`pooledRunCostPerDeal`), never this.
    expect(reconstructedSupplyCostPerDeal({ key: 'p', design: { ...SPEC.design, aggregation: 'POOLED_BUYERS' }, supplyCost: { tier: 'COMPARABLE', p10: 1, p50: 2, p90: 3, observations: 1, sources: [] } })).toBeNull();
  });
});
