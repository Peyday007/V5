/**
 * Observed prices reach the goal model (production, 2026-11-15, Goals run
 * 43735731381 at 4e11ca3, goal wst_7b4fcbb5f2384f31b6c3):
 *
 *   estimated arrangements: 0 of 404 (404 cut) … nothing reconstructs its
 *   value, and no comparable price: published prices for other buyers span
 *   $15–$3M
 *
 * while construction_facts had gone 0 → 43, every one an OBSERVED price filed
 * against a buyer-population node. Root cause: `compose` attached those
 * prices to the arrangement's `a_value` node, but read values only along the
 * contribution formula's path. A FEE design (PRODUCE — 360 of production's
 * 404 — and REFERRAL) earns its fee, so `a_value` is not on that path and was
 * never reconstructed: the arrangement's value stayed UNKNOWN for the very
 * buyers the facts price, `estimatedFromArrangement` refused it, and the
 * comparable fallback refused the project's $15–$3M pool (F4). Own buyers were
 * also matched by exact normalised string, so a fact on "Dental practices"
 * never reached a demand named "Dental practice".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import { clearConstructionMemo, constructArrangements } from '../server/services/cash/construct.ts';
import { comparablePricesFor, selectEstimatedArrangements, type ComparablePrice } from '../server/services/cash/goalScenario.ts';
import { inputEvidence } from '../server/services/goals/portfolio.ts';

let projectId = '';
let ownerId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  ownerId = (await createUser({ email: `fp-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password' })).id;
  clearConstructionMemo();
});

/** Production's held prices: other buyers, no sector named, spanning $15–$3M — no comparable pool (F4). */
const held: ComparablePrice[] = [15, 120, 900, 4_000, 25_000, 300_000, 3_000_000].map((value, i) => ({ value, industry: null, payer: `Some other organisation ${i}` }));

async function observedPrice(nodeId: string, claimId: string, usd: number): Promise<void> {
  await recordClaimFact({
    projectId, nodeId, claimId, key: 'price_per_unit', segment: `map_${nodeId}`, low: usd, high: usd, status: 'OBSERVED',
    measures: `a dental practice pays $${usd} per compliance report`, sourceTitle: 'Published price list', sourceUrl: `https://example.org/${claimId}`,
    sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
  });
}

describe('observed construction facts price the arrangements for their own buyers', () => {
  it('reproduces production and admits PRODUCE designs priced from the facts, plural or singular; unpriced buyers stay out with the reason', async () => {
    // The facts are filed on the population node the back-fill made ("Dental practices"); the
    // sector the opening's industry named also holds the singular "Dental practice".
    const discovered = await seedSubject({ projectId, name: 'Unclassified', actorRef: ownerId });
    const practices = await seedSubject({ projectId, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: discovered.node.id, actorRef: ownerId });
    const dentistry = await seedSubject({ projectId, name: 'Dentistry', actorRef: ownerId });
    const practice = await seedSubject({ projectId, name: 'Dental practice', kind: 'BUYER_TYPE', parentId: dentistry.node.id, actorRef: ownerId });
    const groomers = await seedSubject({ projectId, name: 'Dog groomers', kind: 'BUYER_TYPE', parentId: dentistry.node.id, actorRef: ownerId });
    await observedPrice(practices.node.id, 'clm_dental_a', 180);
    await observedPrice(practices.node.id, 'clm_dental_b', 260);

    const arrangements = await constructArrangements({ projectId, currency: 'USD', delivers: ['compliance reports'], capitalCeilingCents: null, daysLeft: 30 });
    const forward = arrangements.filter((one) => one.origin !== 'REVERSE');
    const of = (ref: string) => forward.filter((one) => one.demand.ref === ref);
    // Production's shape: no supplier on the map, so every forward design is Brain producing it for a fee.
    expect(forward.length).toBeGreaterThan(0);
    expect(forward.every((one) => one.structure === 'PRODUCE')).toBe(true);
    for (const ref of [practices.node.id, practice.node.id]) {
      const own = of(ref);
      expect(own.length, ref).toBeGreaterThan(0);
      for (const one of own) {
        // Reconstructed from these buyers' own observed prices, with the claims as provenance.
        expect(['DIRECT', 'COMPARABLE']).toContain(one.value.tier);
        expect(one.value.observations).toBe(2);
        expect(one.value.p50).toBeGreaterThan(180);
        expect(one.value.p50).toBeLessThan(260);
        expect(one.value.sources).toEqual(['claim:clm_dental_a', 'claim:clm_dental_b']);
      }
    }
    // Never pooled onto another population.
    expect(of(groomers.node.id).every((one) => one.value.tier === 'UNKNOWN')).toBe(true);

    const got = selectEstimatedArrangements(forward, { projectId, currency: 'USD', beforeProofCents: null, remaining: 10_000, exclusions: [], daysLeft: 30, otherPrices: held });
    const admitted = new Set(got.selection.picked.map((one) => one.population));
    expect(admitted.has(practices.node.id) || admitted.has(practice.node.id)).toBe(true);
    for (const one of got.openings) {
      expect(one.estimated?.tier).not.toBe('MECHANISM');
      expect(one.price.provenance).toBe('ASSUMPTION');
      expect(one.price.value).toBeNull();
      expect(one.price.note).toMatch(/obs\. of these buyers: claim:clm_dental_a, claim:clm_dental_b/);
      // Still never certifiable: an estimate establishes no link.
      for (const field of ['price', 'close', 'respond', 'volume', 'daysToCash', 'directCost', 'capital'] as const) expect(inputEvidence(one[field], field).establishes, field).toBe(false);
    }
    // Buyers nothing prices stay out with the reason, and the wide project pool is still no comparable price (F4).
    const groomerCuts = got.selection.cut.filter((one) => one.population === groomers.node.id);
    expect(groomerCuts.length).toBeGreaterThan(0);
    for (const cut of groomerCuts) expect(cut.reason).toMatch(/nothing reconstructs its value, and no comparable price: published prices for other buyers span \$15–\$3,000,000/);
  });
});

describe('the same kind of buyer is the map’s identity, not an exact string', () => {
  it('pools prices a singular or plural payer, or a named member of the population, paid; never a qualified population or a wide pool', () => {
    const prices: ComparablePrice[] = [
      ...held,
      { value: 200, industry: null, payer: 'Dental practice' },
      { value: 320, industry: null, payer: 'The dental practices' },
      { value: 50_000, industry: null, payer: 'Dental practice chains' },
    ];
    const got = comparablePricesFor({ sector: null, demand: { name: 'Dental practices', claimId: null, from: 'INDUSTRY_MAP', ref: 'n1' } }, prices);
    expect(got).toEqual({ prices: [200, 320], scope: 'paid by the same kind of buyer (Dental practices)' });
    // A named organisation is read as the population the map files it under.
    const departments = comparablePricesFor(
      { sector: null, demand: { name: 'state agriculture departments', claimId: null, from: 'INDUSTRY_MAP', ref: 'n2' } },
      [...held, { value: 2_500, industry: null, payer: 'Pennsylvania Department of Agriculture' }, { value: 3_000, industry: null, payer: 'New Jersey Department of Agriculture' }],
    );
    expect(departments).toMatchObject({ prices: [2_500, 3_000] });
    // Nothing of the same kind: the $15–$3M project pool is refused (F4).
    expect(comparablePricesFor({ sector: null, demand: { name: 'Dog groomers', claimId: null, from: 'INDUSTRY_MAP', ref: 'n3' } }, prices)).toEqual({
      refused: 'no comparable price: published prices for other buyers span $15–$3,000,000',
    });
  });
});
