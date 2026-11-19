/**
 * GH2 (production, 2026-11-18, goal wst_7b4fcbb5f2384f31b6c3): the plan's
 * candidate rested on arr_9c291f2760f2, "Constructed: Puzzle Society: Brain
 * produces it and charges a …", a pooled presale-produce design whose price
 * read SINGLE_COMPARABLE, p50 $500, from clm_51df38793dfe46f6b16e — "The
 * Puzzle Society … payment of $500 for each accepted puzzle", a publisher's
 * fee per accepted submission, not buyers prepaying to share a produced run —
 * transferred from an HVAC buyer with five differences unbridged. The same
 * $500 was also filed as the node's contractor_rate_per_unit
 * (cfa_e98ec0985e83), so one figure was both the price and the cost.
 *
 * A price paid under another payment mechanism, or carried across unbridged
 * differences, is no price evidence: it is ASSUMED. One fact never supplies
 * both an arrangement's value and its cost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { clearConstructionMemo, constructArrangements, priceBasisOf, withoutPriceCostOverlap, type ConstructedArrangement } from '../server/services/cash/construct.ts';
import { estimatedFromArrangement } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';

const now = new Date('2026-11-18T00:00:00Z');
const input = { projectId: 'prj_gh2', currency: 'USD', beforeProofCents: null, now };

/** Production's arr_9c291f2760f2: Brain produces puzzles for The Puzzle Society, pooled and presold, priced from one $500 figure. */
function puzzleSociety(over: Partial<ConstructedArrangement> = {}): ConstructedArrangement {
  return {
    key: '9c291f2760f2',
    structure: 'PRODUCE',
    design: { base: 'PRODUCE', funding: 'THRESHOLD_PRESALE', aggregation: 'POOLED_BUYERS', repeat: 'RECURRING_COHORT' },
    origin: 'TRANSFER',
    precedent: { opportunityId: 'opp_hvac', title: 'HVAC contractors buy produced maintenance content' },
    differences: ['legal context', 'payment terms', 'sales cycle', 'capital', 'buyer behaviour'],
    sector: 'puzzles',
    demand: { name: 'The Puzzle Society', claimId: 'clm_51df38793dfe46f6b16e', from: 'INDUSTRY_MAP', ref: 'map_puzzle_society' },
    need: null,
    supply: null,
    label: 'Puzzle Society: Brain produces it and charges a fee',
    properties: [],
    targetsMet: [],
    emergent: [],
    stress: { exposure: 'BOUNDED', worstCaseCents: null, failures: [] },
    evidenced: 1,
    value: { tier: 'COMPARABLE', p10: 500, p50: 500, p90: 500, observations: 1, sources: ['claim:clm_51df38793dfe46f6b16e'] },
    unknownParts: ['conversion'],
    relatedOpenings: [],
    question: 'Would puzzle buyers prepay to share a produced run?',
    ...over,
  } as ConstructedArrangement;
}

describe('a price from another payment mechanism is not price evidence (GH2)', () => {
  it('reproduces production: $500 per accepted puzzle, carried to a pooled presale design across unbridged differences, is ASSUMED, not SINGLE_COMPARABLE', () => {
    const one = puzzleSociety({ value: { ...puzzleSociety().value, ...priceBasisOf(puzzleSociety().design, 1) } });
    expect(one.value.notEvidence).toMatch(/different payment mechanism/);
    const got = estimatedFromArrangement(one, input)!;
    expect(got).not.toBeNull();
    expect(got.price.provenance).toBe('ASSUMPTION');
    expect(got.price.inferred?.tier).toBe('ASSUMED');
    expect(got.estimated?.tier).toBe('ASSUMED');
    const tier = inputEvidence(got.price, 'price');
    expect(tier.tier).toBe('ASSUMED');
    expect(tier.establishes).toBe(false);
    expect(got.price.note).toMatch(/different payment mechanism/);
    expect(got.price.note).toMatch(/not bridged/);
  });

  it('an unbridged transfer alone is ASSUMED, even when its reconstruction justified a distribution', () => {
    const one = puzzleSociety({ design: { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' }, value: { ...puzzleSociety().value, evidence: { values: [480, 500, 520], low: 480, high: 520, events: 30 } as never } });
    const got = estimatedFromArrangement(one, input)!;
    expect(got.price.provenance).toBe('ASSUMPTION');
    expect(inputEvidence(got.price, 'price').tier).toBe('ASSUMED');
  });

  it('the same payer’s price for the same single-buyer design, not transferred, keeps its tier', () => {
    const design = { base: 'PRODUCE', funding: 'ON_DELIVERY', aggregation: 'SINGLE', repeat: 'ONE_OFF' } as const;
    expect(priceBasisOf(design, 1)).toEqual({});
    const got = estimatedFromArrangement(puzzleSociety({ design, origin: 'FORWARD', precedent: null, differences: undefined }), input)!;
    expect(got.price.inferred?.tier).toBe('COMPARABLE');
    expect(inputEvidence(got.price, 'price').tier).toBe('SINGLE_COMPARABLE');
  });
});

describe('one fact is never both an arrangement’s price and its cost (GH2)', () => {
  it('drops a figure filed as price_per_unit and contractor_rate_per_unit from both sides', () => {
    const same = { lineage: ['claim:clm_51df38793dfe46f6b16e'] };
    const otherPrice = { lineage: ['claim:clm_other_price'] };
    const otherCost = { lineage: ['claim:clm_other_cost'] };
    expect(withoutPriceCostOverlap({ value: [same, otherPrice], unitCost: [same, otherCost], runCost: [] })).toEqual({ value: [otherPrice], unitCost: [otherCost], runCost: [] });
    expect(withoutPriceCostOverlap({ value: [same], unitCost: [], runCost: [same] })).toEqual({ value: [], unitCost: [], runCost: [] });
    const apart = { value: [otherPrice], unitCost: [otherCost], runCost: [] };
    expect(withoutPriceCostOverlap(apart)).toBe(apart);
  });

  let projectId = '';
  let ownerId = '';
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    ownerId = (await createUser({ email: `gh2-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password' })).id;
    clearConstructionMemo();
  });

  it('reproduces production: the Puzzle Society $500 per accepted puzzle prices a pooled presale design only as an assumption', async () => {
    const puzzles = await seedSubject({ projectId, name: 'Puzzles', actorRef: ownerId });
    // A buyer population, not one organisation: since #1133 a single organisation is a payer, never a pooled population (namesOneOrganisation).
    const society = await seedSubject({ projectId, name: 'puzzle newsletters', kind: 'BUYER_TYPE', parentId: puzzles.node.id, actorRef: ownerId });
    const nodeId = society.node.id;
    const claimId = 'clm_51df38793dfe46f6b16e';
    await recordClaimFact({
      projectId, nodeId, claimId, key: 'price_per_unit', segment: `map_${nodeId}`, low: 500, high: 500, status: 'OBSERVED',
      measures: 'Puzzle newsletters make a payment of $500 for each accepted puzzle', sourceTitle: 'The Puzzle Society submissions',
      sourceUrl: 'https://example.org/puzzle-society', sourceKind: 'PRIMARY', observedAt: '2026-10-13T00:00:00.000Z',
    });
    const arrangements = await constructArrangements({ projectId, currency: 'USD', delivers: ['puzzles'], capitalCeilingCents: null, daysLeft: 30 });
    const own = arrangements.filter((one) => one.origin !== 'REVERSE' && one.demand.ref === nodeId && one.value.tier !== 'UNKNOWN');
    const pooled = own.filter((one) => one.design.aggregation === 'POOLED_BUYERS');
    const single = own.filter((one) => one.design.aggregation !== 'POOLED_BUYERS' && !one.precedent);
    expect(pooled.length).toBeGreaterThan(0);
    for (const one of pooled) {
      expect(one.value.sources).toContain(`claim:${claimId}`);
      expect(one.value.notEvidence, one.label).toMatch(/different payment mechanism/);
      const got = estimatedFromArrangement(one, { ...input, projectId });
      if (!got) continue;
      expect(got.price.provenance).toBe('ASSUMPTION');
      expect(inputEvidence(got.price, 'price').tier).toBe('ASSUMED');
    }
    // A single-buyer design for the same payer is unchanged: the figure still reads as what it is.
    for (const one of single) expect(one.value.notEvidence).toBeUndefined();
  });
});
