/**
 * ALGO-16-1 item 3 (program fpg_ea512f54974d4ff39a84): the relational event
 * graph. One event recomputes only its neighborhood; every rule emits a
 * hypothesis with provenance and listed missing conditions; nothing is a
 * verified opportunity.
 */
import { describe, expect, it } from 'vitest';
import {
  EventGraph,
  detectInNeighborhood,
  factFromDetection,
  neighborhoodOf,
  REPEATED_DEMAND_MIN_BUYERS,
  type GraphFact,
  type GraphHypothesis,
} from '../server/services/industry/eventGraph.ts';

let seq = 0;
function fact(over: Partial<GraphFact> & Pick<GraphFact, 'kind' | 'subject'>): GraphFact {
  seq += 1;
  const id = over.id ?? `f${String(seq).padStart(3, '0')}`;
  return {
    id,
    basis: 'STATED_REQUEST',
    actor: { key: `actor-${id}`, name: null, role: over.kind === 'WANT' ? 'BUYER' : 'SUPPLIER' },
    region: 'lancaster pa',
    quantity: null,
    unit: null,
    priceCents: null,
    currency: null,
    side: null,
    statedCostCents: null,
    window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
    channel: null,
    rights: [],
    evidence: [{ rawId: `raw-${id}`, source: 'test-feed', url: `https://example.test/${id}`, observedAt: '2026-11-10T00:00:00.000Z' }],
    ...over,
  };
}

function only(hypotheses: GraphHypothesis[], rule: GraphHypothesis['rule']): GraphHypothesis[] {
  return hypotheses.filter((h) => h.rule === rule);
}

function expectHonest(h: GraphHypothesis, facts: GraphFact[]): void {
  expect(h.status).toBe('HYPOTHESIS');
  expect(h.missingConditions.length).toBeGreaterThan(0);
  expect(h.missingConditions.some((m) => /not a verified opportunity/.test(m))).toBe(true);
  // Provenance: every fact joined, and every one of their raw records.
  expect(h.factIds).toEqual(facts.map((f) => f.id).sort());
  for (const f of facts) for (const link of f.evidence) expect(h.evidence).toContainEqual(link);
}

describe('an event recomputes only its neighborhood', () => {
  it('adding a fact recomputes its own subject and leaves every other subject untouched', () => {
    const graph = new EventGraph();
    graph.add(fact({ kind: 'WANT', subject: 'Barn roofing' }));
    graph.add(fact({ kind: 'OFFER', subject: 'Barn roofing' }));
    graph.add(fact({ kind: 'WANT', subject: 'Hay hauling' }));
    const before = graph.hypotheses().filter((h) => h.neighborhood === 'barn roofing');
    expect(before).toHaveLength(1);
    graph.recomputations.length = 0;

    const result = graph.add(fact({ kind: 'CAPACITY', subject: 'Hay hauling' }));

    expect(result.affected).toEqual(['hay hauling']);
    expect(graph.recomputations).toEqual(['hay hauling']);
    // The untouched neighborhood's hypotheses are the very objects computed before.
    expect(graph.hypotheses().filter((h) => h.neighborhood === 'barn roofing')[0]).toBe(before[0]);
  });

  it('a duplicate event recomputes nothing, and a re-read that moves subject recomputes both sides', () => {
    const graph = new EventGraph();
    const want = fact({ kind: 'WANT', subject: 'Barn roofing' });
    graph.add(want);
    graph.recomputations.length = 0;
    expect(graph.add({ ...want }).affected).toEqual([]);
    expect(graph.recomputations).toEqual([]);

    const moved = graph.add({ ...want, subject: 'Silo repair' });
    expect(moved.affected).toEqual(['barn roofing', 'silo repair']);
    expect(graph.neighborhoods()).toEqual(['silo repair']);
  });

  it('refuses a fact with no raw evidence, so every edge links back to what it was read from', () => {
    const graph = new EventGraph();
    expect(() => graph.add(fact({ kind: 'WANT', subject: 'x', evidence: [] }))).toThrow(/raw evidence/);
    graph.add(fact({ kind: 'WANT', subject: 'Barn roofing' }));
    for (const edge of graph.edges()) expect(edge.evidence.length).toBeGreaterThan(0);
  });

  it('normalizes a subject so two spellings are one neighborhood', () => {
    expect(neighborhoodOf('Barn-Roofing ')).toBe(neighborhoodOf('barn roofing'));
  });
});

describe('each rule emits a hypothesis with provenance and missing conditions', () => {
  it('a buyer request against an available supplier, same place and window', () => {
    const want = fact({ kind: 'WANT', subject: 'Barn roofing', quantity: 3 });
    const offer = fact({ kind: 'OFFER', subject: 'Barn roofing', quantity: 1 });
    const elsewhere = fact({ kind: 'OFFER', subject: 'Barn roofing', region: 'Erie PA' });
    const later = fact({ kind: 'OFFER', subject: 'Barn roofing', window: { from: '2027-03-01T00:00:00.000Z', to: null } });
    const [h, ...rest] = only(detectInNeighborhood('barn roofing', [want, offer, elsewhere, later]), 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(rest).toHaveLength(0);
    expectHonest(h!, [want, offer]);
    expect(h!.missingConditions.join(' ')).toMatch(/below the request/);
  });

  it(`repeated regional demand (${REPEATED_DEMAND_MIN_BUYERS}+ buyers) against limited supply`, () => {
    const wants = [1, 2, 3].map(() => fact({ kind: 'WANT', subject: 'Hay hauling', quantity: 10 }));
    const cap = fact({ kind: 'CAPACITY', subject: 'Hay hauling', quantity: 12 });
    const [h] = only(detectInNeighborhood('hay hauling', [...wants, cap]), 'REPEATED_DEMAND_LIMITED_SUPPLY');
    expectHonest(h!, [...wants, cap]);
    expect(h!.figures).toEqual({ buyers: 3, demanded: 30, supplied: 12 });
    // Two buyers is not repeated demand, and ample supply is not limited.
    expect(only(detectInNeighborhood('hay hauling', [wants[0]!, wants[1]!]), 'REPEATED_DEMAND_LIMITED_SUPPLY')).toHaveLength(0);
    const ample = fact({ kind: 'CAPACITY', subject: 'Hay hauling', quantity: 100 });
    expect(only(detectInNeighborhood('hay hauling', [...wants, ample]), 'REPEATED_DEMAND_LIMITED_SUPPLY')).toHaveLength(0);
  });

  it('a contract renewal against a provider with capacity at the renewal date', () => {
    const renewal = fact({ kind: 'RENEWAL', subject: 'Feed delivery', basis: 'PUBLIC_RECORD', window: { from: '2026-12-01T00:00:00.000Z', to: null } });
    const cap = fact({ kind: 'CAPACITY', subject: 'Feed delivery' });
    const [h] = only(detectInNeighborhood('feed delivery', [renewal, cap]), 'RENEWAL_AGAINST_CAPACITY');
    expectHonest(h!, [renewal, cap]);
    expect(h!.missingConditions.join(' ')).toMatch(/open to a new provider/);
    expect(h!.missingConditions.join(' ')).toMatch(/does not state willingness to transact/);
  });

  it('a published buy/sell spread after stated costs, and a spread with no stated costs says so', () => {
    const buy = fact({ kind: 'PRICE', subject: 'Round bales', basis: 'PLATFORM_PRICE', side: 'BUY', priceCents: 9000, currency: 'USD', unit: 'bale' });
    const sell = fact({ kind: 'PRICE', subject: 'Round bales', basis: 'PLATFORM_PRICE', side: 'SELL', priceCents: 6000, currency: 'USD', unit: 'bale', statedCostCents: 1000 });
    const [h] = only(detectInNeighborhood('round bales', [buy, sell]), 'SPREAD_AFTER_COSTS');
    expectHonest(h!, [buy, sell]);
    expect(h!.figures).toEqual({ grossCents: 3000, netCents: 2000 });
    expect(h!.missingConditions.join(' ')).toMatch(/listing, not a buyer's agreed price/);

    const bare = { ...sell, id: 'bare', statedCostCents: null };
    const [g] = only(detectInNeighborhood('round bales', [buy, bare]), 'SPREAD_AFTER_COSTS');
    expect(g!.figures).toEqual({ grossCents: 3000 });
    expect(g!.missingConditions.join(' ')).toMatch(/costs .* are not stated/);

    // Costs that eat the spread leave no hypothesis; different currencies never join.
    expect(only(detectInNeighborhood('round bales', [buy, { ...sell, statedCostCents: 3500 }]), 'SPREAD_AFTER_COSTS')).toHaveLength(0);
    expect(only(detectInNeighborhood('round bales', [buy, { ...sell, currency: 'EUR' }]), 'SPREAD_AFTER_COSTS')).toHaveLength(0);
  });

  it('a concentration of buyer requests a partner could serve', () => {
    const wants = [1, 2, 3].map(() => fact({ kind: 'WANT', subject: 'Fence repair' }));
    const partner = fact({ kind: 'CAPACITY', subject: 'Fence repair', region: 'York PA', actor: { key: 'york-fencing', name: 'York Fencing', role: 'PARTNER' } });
    const [h] = only(detectInNeighborhood('fence repair', [...wants, partner]), 'PARTNER_SERVABLE_CONCENTRATION');
    expectHonest(h!, [...wants, partner]);
    expect(h!.missingConditions.join(' ')).toMatch(/no agreement with York Fencing/);
    expect(h!.missingConditions.join(' ')).toMatch(/recorded in York PA, not in lancaster pa/);
  });
});

describe('nothing becomes a verified opportunity', () => {
  it('a job posting or supplier ad keeps its limit as a missing condition rather than becoming demand', () => {
    const posting = fact({ kind: 'WANT', subject: 'Bookkeeping', basis: 'JOB_POSTING', actor: { key: 'acme', name: 'Acme Farms', role: 'UNKNOWN' } });
    const ad = fact({ kind: 'OFFER', subject: 'Bookkeeping', basis: 'SUPPLIER_AD', actor: { key: 'books', name: 'Books LLC', role: 'SUPPLIER' } });
    const [h] = only(detectInNeighborhood('bookkeeping', [posting, ad]), 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(h!.missingConditions).toContain("Acme Farms's job posting is hiring, not a request to buy from an outside provider");
    expect(h!.missingConditions).toContain("Books LLC's advertisement is not capacity reserved for any buyer");
  });

  it('every hypothesis any rule produces is typed HYPOTHESIS with at least one missing condition', () => {
    const graph = new EventGraph();
    for (const f of [
      ...[1, 2, 3].map(() => fact({ kind: 'WANT', subject: 'Barn roofing', quantity: 2 })),
      fact({ kind: 'OFFER', subject: 'Barn roofing', quantity: 1, actor: { key: 'p', name: 'P', role: 'PARTNER' } }),
      fact({ kind: 'RENEWAL', subject: 'Barn roofing' }),
      fact({ kind: 'CAPACITY', subject: 'Barn roofing', quantity: 1 }),
    ]) graph.add(f);
    const all = graph.hypotheses();
    expect(new Set(all.map((h) => h.rule)).size).toBeGreaterThanOrEqual(3);
    for (const h of all) {
      expect(h.status).toBe('HYPOTHESIS');
      expect(h.missingConditions.length).toBeGreaterThan(0);
      expect(h.evidence.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic: the same facts give the same hypotheses in the same order, whatever the arrival order', () => {
    const facts = [
      ...[1, 2, 3].map(() => fact({ kind: 'WANT', subject: 'Hay hauling', quantity: 5 })),
      fact({ kind: 'CAPACITY', subject: 'Hay hauling', quantity: 4 }),
    ];
    const a = new EventGraph();
    const b = new EventGraph();
    for (const f of facts) a.add(f);
    for (const f of [...facts].reverse()) b.add(f);
    expect(b.hypotheses()).toEqual(a.hypotheses());
  });
});

describe('a stored feed detection enters as a fact', () => {
  it('reads as a JOB_POSTING want whose members are its raw evidence, and joins the graph', () => {
    const f = factFromDetection(
      {
        groupKey: 'concentrated-hiring:v1:acme:accounting',
        label: 'Acme is hiring accountants',
        entityKey: 'acme',
        entityName: 'Acme Farms',
        category: 'Bookkeeping',
        windowFrom: '2026-11-01T00:00:00.000Z',
        windowTo: '2026-11-14T00:00:00.000Z',
        memberIds: ['fi_1', 'fi_2', 'fi_3'],
        sourceUrls: ['https://jobs.test/1', 'https://jobs.test/2', 'https://jobs.test/3'],
      },
      'remoteok',
    )!;
    expect(f.kind).toBe('WANT');
    expect(f.basis).toBe('JOB_POSTING');
    expect(f.evidence.map((e) => e.rawId)).toEqual(['fi_1', 'fi_2', 'fi_3']);
    const graph = new EventGraph();
    graph.add(f);
    graph.add(fact({ kind: 'OFFER', subject: 'bookkeeping', region: null }));
    const [h] = only(graph.hypotheses(), 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(h!.evidence.map((e) => e.rawId)).toEqual(expect.arrayContaining(['fi_1', 'fi_2', 'fi_3']));
    expect(h!.missingConditions.join(' ')).toMatch(/hiring, not a request to buy/);
  });

  it('a detection naming no entity relates to nothing and is not read', () => {
    expect(
      factFromDetection(
        { groupKey: 'g', label: 'l', entityKey: null, entityName: null, category: null, windowFrom: '2026-11-01T00:00:00.000Z', windowTo: '2026-11-02T00:00:00.000Z', memberIds: ['x'], sourceUrls: [] },
        's',
      ),
    ).toBeNull();
  });
});
