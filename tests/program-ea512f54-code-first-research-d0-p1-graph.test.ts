/**
 * ALGO-16-1 item 3 (program fpg_ea512f54974d4ff39a84): the relational event
 * graph. One event recomputes only its neighborhood; every rule emits a
 * hypothesis with provenance and listed missing conditions; nothing is a
 * verified opportunity.
 */
import { describe, expect, it } from 'vitest';
import {
  EventGraph,
  currentEventGraph,
  detectInNeighborhood,
  factFromDetection,
  factsFromItem,
  resetEventGraph,
  syncEventGraph,
  neighborhoodOf,
  REPEATED_DEMAND_MIN_BUYERS,
  type GraphFact,
  type GraphHypothesis,
} from '../server/services/industry/eventGraph.ts';
import type { ExtractableItem } from '../server/services/feeds/extract.ts';
import { constructFromGraph } from '../server/services/cash/construct.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { freshProject } from './helpers.ts';
import { recordFeedExtraction } from '../server/services/feeds/run.ts';

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

describe('stored feed records reach the rules in production (repair F1)', () => {
  const at = '2026-11-10T12:00:00.000Z';
  const item = (over: Partial<ExtractableItem> & Pick<ExtractableItem, 'id' | 'title'>): ExtractableItem => ({
    source: 'rfq-board',
    url: `https://board.test/${over.id}`,
    body: null,
    organization: null,
    publishedAt: at,
    fetchedAt: at,
    ...over,
  });

  it('a record stating a request is a regioned BUYER want, with its budget as a BUY price; an advert with room is CAPACITY', () => {
    const request = factsFromItem(
      item({ id: 'r1', title: 'Request for quotes: lawn mowing', body: 'Seeking quotes from a supplier in Dallas, TX by 2026-12-15. Budget $60.', organization: 'Acme Foods LLC' }),
    );
    expect(request.map((f) => [f.kind, f.basis, f.actor.role, f.side])).toEqual([
      ['WANT', 'STATED_REQUEST', 'BUYER', null],
      ['PRICE', 'STATED_REQUEST', 'BUYER', 'BUY'],
    ]);
    expect(request[0]!.region).toBe('dallas, tx');
    expect(request[0]!.subject).toBe('lawn mowing');
    expect(request[0]!.window.to?.slice(0, 10)).toBe('2026-12-15');
    expect(request[1]!.priceCents).toBe(6000);
    expect(request.every((f) => f.evidence[0]!.rawId === 'r1')).toBe(true);

    const ad = factsFromItem(item({ id: 'a1', title: 'Lawn mowing now booking', body: 'We offer weekly mowing in Dallas, TX for $45.', organization: 'Green Co' }));
    // The advert's asked price is also a SELL price on the advert's basis (R3-F3), never an agreed one.
    expect(ad.map((f) => [f.kind, f.basis, f.actor.role, f.side])).toEqual([
      ['CAPACITY', 'SUPPLIER_AD', 'SUPPLIER', null],
      ['PRICE', 'SUPPLIER_AD', 'SUPPLIER', 'SELL'],
    ]);
    expect(ad[0]!.subject).toBe('lawn mowing');
  });

  it('a job posting stays a JOB_POSTING want, a listing a SELL price, a dated renewal a RENEWAL; news and unreadable records are not facts', () => {
    expect(factsFromItem(item({ id: 'j1', source: 'remoteok', title: 'Senior Bookkeeper', body: 'Remote. Full-time.', organization: 'Acme' }))[0]).toMatchObject({
      kind: 'WANT',
      basis: 'JOB_POSTING',
      region: 'remote',
    });
    const listing = factsFromItem(item({ id: 'p2', title: 'Round bales', body: 'Listed price $60.', organization: 'Hay Mart' }));
    expect(listing[0]).toMatchObject({ kind: 'PRICE', basis: 'PLATFORM_PRICE', side: 'SELL', priceCents: 6000, currency: 'USD' });
    const renewal = factsFromItem(
      item({ id: 'g1', source: 'county-records', title: 'Janitorial services contract', body: 'The janitorial contract is up for renewal on 2027-01-31.', organization: 'Erie County' }),
    );
    expect(renewal[0]).toMatchObject({ kind: 'RENEWAL', basis: 'PUBLIC_RECORD', window: { from: '2027-01-31T00:00:00.000Z', to: null } });
    expect(factsFromItem(item({ id: 'n1', source: 'news-x', title: 'Markets moved', body: 'Something happened.' }))).toEqual([]);
    expect(factsFromItem(item({ id: 'u1', title: 'Thoughts', body: 'Nobody knows what.' }))).toEqual([]);
  });

  it('two places stated is an ambiguity, not a region picked', () => {
    const [f] = factsFromItem(item({ id: 'r2', title: 'Request for quotes: fence repair', body: 'Seeking quotes from a supplier in York, PA or in Erie, PA.', organization: 'Farm' }));
    expect(f!.region).toBeNull();
  });

  it('a provider whose own record declares a partner arrangement is a PARTNER; a plain advert stays a SUPPLIER and a buyer seeking a subcontractor stays a BUYER (repair R3-F4)', () => {
    const partner = factsFromItem(
      item({ id: 'pa1', title: 'Fence repair: subcontract work welcome', body: 'We partner with contractors serving York, PA. Crews available now.', organization: 'York Fencing LLC' }),
    );
    expect(partner.map((f) => [f.kind, f.basis, f.actor.role])).toEqual([['CAPACITY', 'SUPPLIER_AD', 'PARTNER']]);
    expect(partner[0]!.subject).toBe('fence repair');
    expect(partner[0]!.region).toBe('york, pa');
    expect(partner[0]!.evidence[0]!.rawId).toBe('pa1');

    for (const [id, title, body] of [
      ['pa2', 'Hay bales wholesale accounts', 'Trade pricing for feed stores in Lancaster, PA.'],
      ['pa3', 'Bookkeeping white-label', 'White-label bookkeeping for agencies, remote.'],
      ['pa4', 'Snow plowing referral program', 'Referral partners welcome in Erie, PA.'],
    ] as const) {
      expect(factsFromItem(item({ id, title, body, organization: `Org ${id}` }))[0]?.actor.role).toBe('PARTNER');
    }

    // A plain advert is not a partner declaration, and a buyer asking for one is still the buyer.
    expect(factsFromItem(item({ id: 'pa5', title: 'Fence repair now booking', body: 'We offer fence repair in York, PA.', organization: 'Solo Fence' }))[0]!.actor.role).toBe('SUPPLIER');
    expect(
      factsFromItem(item({ id: 'pa6', title: 'Request for quotes: fence repair', body: 'Seeking a contractor; subcontract work welcome. In York, PA.', organization: 'Farm Co' }))[0]!.actor.role,
    ).toBe('BUYER');
  });

  it('PARTNER_SERVABLE_CONCENTRATION fires from stored feed_items alone, and construction pays it through its graph roles (repair R3-F4)', async () => {
    await freshProject();
    resetEventGraph();
    const now = new Date();
    const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
    const due = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      ...['Maple Farm', 'Oak Ridge HOA', 'Pine Dairy LLC'].map((org, n) => ({
        externalId: `r3f4-rfq-${n}`,
        url: `https://board.test/r3f4-rfq-${n}`,
        title: 'Request for quotes: fence repair',
        body: `Seeking quotes from a supplier in Lancaster, PA by ${due}.`,
        organization: org,
        publishedAt: hoursAgo(6 - n),
      })),
      {
        externalId: 'r3f4-partner',
        url: 'https://board.test/r3f4-partner',
        title: 'Fence repair: subcontract work welcome',
        body: 'We partner with contractors serving York, PA. Crews available now.',
        organization: 'York Fencing LLC',
        publishedAt: hoursAgo(2),
      },
    ]);

    const sync = await syncEventGraph(now);
    expect(sync.itemsRead).toBe(4);
    const graph = currentEventGraph();
    // The PARTNER edge was produced by the extractor from the stored row, not built by hand.
    const edge = graph.edges().find((e) => e.role === 'PARTNER');
    expect(edge).toBeDefined();
    expect(edge!.neighborhood).toBe('fence repair');
    expect(edge!.evidence.map((e) => e.url)).toEqual(['https://board.test/r3f4-partner']);

    const concentrated = only(graph.hypotheses(), 'PARTNER_SERVABLE_CONCENTRATION');
    expect(concentrated).toHaveLength(1);
    const h = concentrated[0]!;
    expect(h.status).toBe('HYPOTHESIS');
    expect(h.figures).toEqual({ buyers: 3 });
    expect(h.evidence.map((e) => e.url).sort()).toEqual([
      'https://board.test/r3f4-partner',
      'https://board.test/r3f4-rfq-0',
      'https://board.test/r3f4-rfq-1',
      'https://board.test/r3f4-rfq-2',
    ]);
    expect(h.missingConditions.join(' ')).toMatch(/no agreement with York Fencing LLC/);
    expect(h.missingConditions.join(' ')).toMatch(/recorded in york, pa, not in lancaster pa/);
    expect(h.missingConditions.join(' ')).toMatch(/advertisement is not capacity reserved/);

    const built = constructFromGraph(graph.hypotheses(), { capitalCeilingCents: null, delivers: [] });
    const structures = new Set(
      [...built.kept, ...built.pruned].filter((one) => one.hypothesisKey === h.key).map((one) => one.structure),
    );
    expect([...structures].sort()).toEqual(['BROKER', 'REFERRAL', 'SUBCONTRACT']);
    expect(built.kept.some((one) => one.hypothesisKey === h.key)).toBe(true);
    expect(built.kept.every((one) => one.status === 'HYPOTHESIS')).toBe(true);
    resetEventGraph();
  });

  it('syncEventGraph reads stored feed_items past its cursor, emits hypotheses from them, and construction keeps candidates', async () => {
    await freshProject();
    resetEventGraph();
    const now = new Date();
    const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
    const due = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      {
        externalId: 'rfq-1',
        url: 'https://board.test/rfq-1',
        title: 'Request for quotes: lawn mowing',
        body: `Seeking quotes from a supplier in Dallas, TX by ${due}. Budget $60.`,
        organization: 'Acme Foods LLC',
        publishedAt: hoursAgo(5),
      },
      {
        externalId: 'ad-1',
        url: 'https://board.test/ad-1',
        title: 'Lawn mowing now booking',
        body: 'We offer weekly mowing in Dallas, TX for $45.',
        organization: 'Green Co',
        publishedAt: hoursAgo(4),
      },
    ]);
    await insertFeedItems('remoteok', [1, 2, 3].map((n) => ({
      externalId: `job-${n}`,
      url: `https://jobs.test/${n}`,
      title: 'Bookkeeper',
      body: 'Remote. Full-time.',
      organization: `Employer ${n} Inc`,
      publishedAt: hoursAgo(3),
    })));

    const sync = await syncEventGraph(now);
    expect(sync.itemsRead).toBe(5);
    expect(sync.itemCursor).not.toBeNull();
    const hypotheses = currentEventGraph().hypotheses();
    const match = only(hypotheses, 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(match).toHaveLength(1);
    expect(match[0]!.neighborhood).toBe('lawn mowing');
    expect(match[0]!.evidence.map((e) => e.source)).toEqual(['rfq-board', 'rfq-board']);
    const repeated = only(hypotheses, 'REPEATED_DEMAND_LIMITED_SUPPLY');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]!.missingConditions.join(' ')).toMatch(/hiring, not a request to buy/);
    for (const h of hypotheses) expect(h.missingConditions.length).toBeGreaterThan(0);

    const built = constructFromGraph(hypotheses, { capitalCeilingCents: null, delivers: [] });
    expect(built.kept.length).toBeGreaterThan(0);
    expect(built.kept.every((one) => one.status === 'HYPOTHESIS')).toBe(true);

    // Incremental: nothing new stored, nothing read, nothing recomputed.
    const again = await syncEventGraph(new Date(now.getTime() + 1000));
    expect(again.itemsRead).toBe(0);
    expect(again.recomputed).toEqual([]);
    resetEventGraph();
  });
});

describe('the structure pass feeds connect and derive directly (repair F2)', () => {
  it('recordFeedExtraction hands its records to the graph construction reads, and the sync then adds no second fact', async () => {
    const { project } = await freshProject();
    resetEventGraph();
    const now = new Date();
    const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
    const due = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      {
        externalId: 'f2-rfq',
        url: 'https://board.test/f2-rfq',
        title: 'Request for quotes: gutter cleaning',
        body: `Seeking quotes from a supplier in Tulsa, OK by ${due}. Budget $300.`,
        organization: 'Maple HOA',
        publishedAt: hoursAgo(5),
      },
      {
        externalId: 'f2-ad',
        url: 'https://board.test/f2-ad',
        title: 'Gutter cleaning now booking',
        body: 'We offer gutter cleaning in Tulsa, OK for $150.',
        organization: 'Clear Gutters',
        publishedAt: hoursAgo(4),
      },
    ]);
    expect(currentEventGraph().size()).toBe(0);

    // Structure, alone: no sync has run, and the graph already holds what the pass read.
    const pass = await recordFeedExtraction({ projectId: project.id, now });
    expect(pass).not.toBeNull();
    expect(pass!.graph).not.toBeNull();
    expect(pass!.graph!.added).toBeGreaterThan(0);
    expect(pass!.graph!.affected).toContain('gutter cleaning');
    const hypotheses = currentEventGraph().hypotheses();
    const match = only(hypotheses, 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(match).toHaveLength(1);
    expect(match[0]!.evidence.map((e) => e.url).sort()).toEqual(['https://board.test/f2-ad', 'https://board.test/f2-rfq']);
    // A supplier advert stays supply, a request stays a stated request: nobody becomes a confirmed buyer.
    expect(match[0]!.status).toBe('HYPOTHESIS');
    expect(match[0]!.missingConditions.length).toBeGreaterThan(0);
    // Derive reads the same graph: construction keeps candidates from what Structure read.
    const built = constructFromGraph(hypotheses, { capitalCeilingCents: null, delivers: [] });
    expect(built.kept.some((one) => one.hypothesisKey === match[0]!.key)).toBe(true);

    // Connect after it reads the same rows and finds every fact already held: one fact per record, nothing recomputed.
    const size = currentEventGraph().size();
    const sync = await syncEventGraph(now);
    expect(sync.itemsRead).toBeGreaterThanOrEqual(2);
    expect(sync.recomputed).toEqual([]);
    expect(currentEventGraph().size()).toBe(size);
    expect(only(currentEventGraph().hypotheses(), 'BUYER_REQUEST_AGAINST_SUPPLIER')).toHaveLength(1);
    resetEventGraph();
  });
});
