/**
 * A constructed design takes the deliverable its buyers are shown paying for
 * (production plan reads on 91bf9ef8, 2026-11-21: goals wst_4f0c312400e1425dab2e,
 * wst_db2e2e0e5204477692d5, wst_66311cabe7e5442faa98).
 *
 * The leading designs (arr_30354053591a, arr_03e3254dced2, arr_179517d1fdc5,
 * "Constructed: homeowner: Brain produces it and charges a fee") delivered
 * "what homeowner pay for (not yet specified)" while one published homeowner
 * price (USD 6,000) was the very figure that priced them. A need was looked
 * for only in the buyer's own map sector (`forEachCandidate`), and the price
 * fact's described unit and an opening's offer — both filed against those
 * buyers — were never read as what they pay for. So `provedDeliverable`
 * refused every such design, no performer was established, and the plan's
 * best candidates could not become executable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { recordClaimFact } from '../server/repos/construction.ts';
import { seedSubject } from '../server/services/industry/seed.ts';
import {
  clearConstructionMemo,
  constructArrangements,
  forEachCandidate,
  paidForParts,
  provedDeliverable,
  unspecifiedDeliverable,
  capabilityPart,
  type Candidate,
  type ConstructionJob,
  type Primitive,
} from '../server/services/cash/construct.ts';

let projectId = '';
let ownerId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  ownerId = (await createUser({ email: `ed-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'a-long-enough-password' })).id;
  clearConstructionMemo();
});

async function price(nodeId: string, claimId: string, usd: number, measures: string): Promise<void> {
  await recordClaimFact({
    projectId, nodeId, claimId, key: 'price_per_unit', segment: `map_${nodeId}`, low: usd, high: usd, status: 'OBSERVED',
    measures, sourceTitle: 'Published price list', sourceUrl: `https://example.org/${claimId}`, sourceKind: 'PRIMARY', observedAt: '2026-11-01T00:00:00.000Z',
  });
}

describe('a design Brain produces takes the deliverable evidence names', () => {
  it('reads a price fact’s described unit as what the buyers pay for, matches it honestly, and leaves the unevidenced buyer unspecified and asked', async () => {
    const root = await seedSubject({ projectId, name: 'Unclassified', actorRef: ownerId });
    const practices = await seedSubject({ projectId, name: 'Dental practices', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    const homeowners = await seedSubject({ projectId, name: 'homeowner', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    const groomers = await seedSubject({ projectId, name: 'Dog groomers', kind: 'BUYER_TYPE', parentId: root.node.id, actorRef: ownerId });
    await price(practices.node.id, 'clm_dental', 220, 'a dental practice pays $220 per compliance report');
    await price(homeowners.node.id, 'clm_roof', 6_000, 'a homeowner pays $6,000 to replace an asphalt roof');

    const arrangements = await constructArrangements({ projectId, currency: 'USD', delivers: ['spreadsheet', 'business document', 'presentation'], capitalCeilingCents: null, daysLeft: 30 });
    const forward = arrangements.filter((one) => one.origin !== 'REVERSE');
    const of = (ref: string) => forward.filter((one) => one.demand.ref === ref);

    // The dental design names the evidenced deliverable, with its source, and it matches a proved one.
    const dental = of(practices.node.id).filter((one) => one.structure === 'PRODUCE');
    expect(dental.length).toBeGreaterThan(0);
    for (const one of dental) {
      expect(one.need?.claimId).toBe('clm_dental');
      expect(one.supply?.name).not.toContain('(not yet specified)');
      expect(provedDeliverable(one.supply)).toBe(true);
    }

    // The homeowner's evidence names physical work: never "not yet specified", and never a proved deliverable.
    const homeowner = of(homeowners.node.id);
    expect(homeowner.length).toBeGreaterThan(0);
    for (const one of homeowner) {
      expect(one.need?.claimId).toBe('clm_roof');
      expect(one.supply?.name ?? '').not.toContain('(not yet specified)');
      expect(provedDeliverable(one.supply)).toBe(false);
    }

    // Nothing names what dog groomers pay for: it stays unknown, says so, and its round asks it first.
    const groomer = of(groomers.node.id).filter((one) => one.structure === 'PRODUCE');
    expect(groomer.length).toBeGreaterThan(0);
    for (const one of groomer) {
      expect(one.need).toBeNull();
      expect(unspecifiedDeliverable(one)).toBe(true);
      expect(provedDeliverable(one.supply)).toBe(false);
      expect(one.question).toMatch(/first name what these buyers are published as paying for, each with its price, page and date/);
    }
  });
});

describe('what a population is shown paying for is read wherever it was filed', () => {
  const demand: Primitive = { name: 'homeowner', claimId: 'clm_node', from: 'INDUSTRY_MAP', ref: 'ind_home', path: 'BUYER_TYPE:unclassified>homeowner' };
  const job = (paidFor: ConstructionJob['paidFor']): ConstructionJob =>
    ({
      sectors: [{ name: 'Unclassified', demand: [demand], needs: [], supply: [] }],
      opportunities: [],
      precedent: [],
      capability: capabilityPart(['spreadsheet', 'presentation']),
      ...(paidFor ? { paidFor } : {}),
      priced: [],
      tiedUp: [],
      input: { projectId: 'prj', currency: 'USD', delivers: ['spreadsheet', 'presentation'], capitalCeilingCents: null, daysLeft: 30 },
      limits: { daysLeft: 30, remainingCents: 1, capitalCeilingCents: null, capitalBeforeProofCents: null, bestReachCents: null },
      targets: [],
      exclusions: [],
      now: new Date('2026-11-21T00:00:00Z'),
    }) as ConstructionJob;
  const candidates = (j: ConstructionJob): Candidate[] => {
    const out: Candidate[] = [];
    forEachCandidate(j, (one) => out.push(one));
    return out;
  };

  it('an opening filed under another industry gives the map buyer its need; with nothing filed the need stays null', () => {
    const opening = { id: 'cop_1', payer: 'Homeowners', offerScope: 'a household budget spreadsheet', title: 'Budget spreadsheet', industry: 'Personal finance', sourceClaimId: 'clm_open', updatedAt: '2026-11-20T00:00:00Z' };
    const paidFor = paidForParts([opening], []);
    const named = candidates(job(paidFor));
    expect(named.length).toBeGreaterThan(0);
    for (const one of named) expect(one.need).toMatchObject({ claimId: 'clm_open', from: 'OPENING', ref: 'cop_1', path: 'OPENING_NEED:personal finance>a household budget spreadsheet' });
    // Nothing filed: unknown, never invented.
    for (const one of candidates(job(undefined))) expect(one.need).toBeNull();
  });
});
