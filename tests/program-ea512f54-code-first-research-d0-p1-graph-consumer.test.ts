/**
 * R3-F1 (program fpg_ea512f54974d4ff39a84, ALGO-16-1 item 4): a kept event-graph
 * construction is not only counted. Its buyers, need and suppliers become parts
 * of the same composition every other part goes through, so it reaches the
 * goal's constructed arrangements — and with them the portfolio and the
 * research questions asked about them (`askConstructedArrangements`). Every
 * such part carries no claim: its payer stays a question, never a fact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { addGraphParts, constructArrangements, constructFromGraph, type Primitive } from '../server/services/cash/construct.ts';
import { EventGraph, resetEventGraph, type GraphFact } from '../server/services/industry/eventGraph.ts';

function fact(over: Partial<GraphFact> & Pick<GraphFact, 'id' | 'kind' | 'subject' | 'actor'>): GraphFact {
  return {
    basis: 'STATED_REQUEST',
    region: 'austin tx',
    quantity: null,
    unit: null,
    priceCents: null,
    currency: null,
    side: null,
    statedCostCents: null,
    window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
    channel: null,
    rights: [],
    evidence: [{ rawId: `raw-${over.id}`, source: 'test-feed', url: null, observedAt: '2026-11-10T00:00:00.000Z' }],
    ...over,
  };
}

function sectors() {
  const held = new Map<string, { name: string | null; demand: Primitive[]; needs: Primitive[]; supply: Primitive[] }>();
  const sector = (name: string | null) => {
    const key = (name ?? '-').toLowerCase();
    if (!held.has(key)) held.set(key, { name, demand: [], needs: [], supply: [] });
    return held.get(key)!;
  };
  return { held, sector };
}

describe('kept graph constructions become construction parts', () => {
  it('the buyer, the need and the supplier of a kept construction are parts in its neighborhood, each traceable to the hypothesis', () => {
    const graph = new EventGraph();
    graph.add(fact({ id: 'w1', kind: 'WANT', subject: 'Office cleaning', actor: { key: 'acme', name: 'Acme Offices LLC', role: 'BUYER' } }));
    graph.add(fact({ id: 'o1', kind: 'OFFER', subject: 'Office cleaning', basis: 'SUPPLIER_AD', actor: { key: 'sparkle', name: 'Sparkle Cleaning Co', role: 'SUPPLIER' } }));
    const hypotheses = graph.hypotheses();
    expect(hypotheses.length).toBeGreaterThan(0);
    for (const h of hypotheses) expect(h.actors.map((a) => a.key)).toEqual(h.actorKeys);
    const { kept } = constructFromGraph(hypotheses, { capitalCeilingCents: null, delivers: [] });
    expect(kept.length).toBeGreaterThan(0);
    const { held, sector } = sectors();
    addGraphParts(kept, () => true, sector);
    const s = held.get('office cleaning')!;
    expect(s.demand.map((p) => p.name)).toEqual(['Acme Offices LLC']);
    expect(s.supply.map((p) => p.name)).toEqual(['Sparkle Cleaning Co']);
    expect(s.needs.map((p) => p.name)).toEqual(['office cleaning']);
    for (const p of [...s.demand, ...s.supply, ...s.needs]) {
      expect(p.from).toBe('EVENT_GRAPH');
      // No gated claim: what the records say is a question for research, never an established payer or supplier.
      expect(p.claimId).toBeNull();
      expect(hypotheses.some((h) => h.key === p.ref)).toBe(true);
    }
  });

  it('a pruned construction, an unnamed actor and an excluded class add no part', () => {
    const graph = new EventGraph();
    graph.add(fact({ id: 'w1', kind: 'WANT', subject: 'Office cleaning', actor: { key: 'item:1', name: null, role: 'BUYER' } }));
    graph.add(fact({ id: 'o1', kind: 'OFFER', subject: 'Office cleaning', basis: 'SUPPLIER_AD', actor: { key: 'sparkle', name: 'Sparkle Cleaning Co', role: 'SUPPLIER' } }));
    const { kept } = constructFromGraph(graph.hypotheses(), { capitalCeilingCents: null, delivers: [] });
    const { held, sector } = sectors();
    addGraphParts(kept, () => true, sector);
    expect(held.get('office cleaning')!.demand).toEqual([]);
    const excluded = sectors();
    addGraphParts(kept, (text) => !/cleaning/i.test(text ?? ''), excluded.sector);
    expect(excluded.held.size).toBe(0);
    const none = sectors();
    addGraphParts([], () => true, none.sector);
    expect(none.held.size).toBe(0);
  });
});

describe('stored feed records reach the constructed arrangements through the graph', () => {
  beforeEach(() => {
    resetEventGraph();
  });

  it('a stated request and a supplier advert become an arrangement whose parts came from the graph', async () => {
    const projectId = (await freshProject()).project.id;
    const source = `g${Math.random().toString(36).slice(2, 8)}`;
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await insertFeedItems(source, [
      {
        externalId: `${source}-rfq`,
        url: `https://example.test/${source}/rfq`,
        title: 'Request for quotes: office cleaning',
        body: 'Seeking quotes from a vendor for nightly office cleaning in Austin, TX.',
        organization: 'Acme Offices LLC',
        publishedAt: at,
      },
      {
        externalId: `${source}-ad`,
        url: `https://example.test/${source}/ad`,
        title: 'Office cleaning, we offer',
        body: 'We offer office cleaning in Austin, TX. Free estimates.',
        organization: 'Sparkle Cleaning Co',
        publishedAt: at,
      },
    ]);
    const built = await constructArrangements({ projectId, currency: 'USD', delivers: [], capitalCeilingCents: null, daysLeft: 30 });
    const fromGraph = built.filter((one) => one.demand.from === 'EVENT_GRAPH' || one.supply?.from === 'EVENT_GRAPH' || one.need?.from === 'EVENT_GRAPH');
    expect(fromGraph.length).toBeGreaterThan(0);
    const brokered = fromGraph.find((one) => one.demand.name === 'Acme Offices LLC' && one.supply?.name === 'Sparkle Cleaning Co');
    expect(brokered).toBeDefined();
    expect(brokered!.demand.claimId).toBeNull();
  });
});
