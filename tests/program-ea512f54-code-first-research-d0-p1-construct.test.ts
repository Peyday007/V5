/**
 * ALGO-16-1 item 4 / ALGO-19-4 "derive" (program fpg_ea512f54974d4ff39a84):
 * event-graph hypotheses become construction inputs, with their missing
 * conditions carried; infeasible candidates are pruned cheaply with the reason
 * recorded; near-identical designs collapse while distinct mechanisms stay;
 * every result is still a hypothesis.
 */
import { describe, expect, it } from 'vitest';
import { constructFromGraph, type GraphConstructionContext } from '../server/services/cash/construct.ts';
import { EventGraph, type GraphFact, type GraphHypothesis } from '../server/services/industry/eventGraph.ts';

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
    evidence: [{ rawId: `raw-${id}`, source: 'test-feed', url: null, observedAt: '2026-11-10T00:00:00.000Z' }],
    ...over,
  };
}

function hypothesesOf(facts: GraphFact[]): GraphHypothesis[] {
  const graph = new EventGraph();
  for (const f of facts) graph.add(f);
  return graph.hypotheses();
}

const OPEN: GraphConstructionContext = { capitalCeilingCents: null, delivers: [] };

describe('graph hypotheses become construction inputs, missing conditions carried', () => {
  it('a buyer request against a supplier is joined with each structure it can be paid through, every one a hypothesis', () => {
    const hs = hypothesesOf([fact({ kind: 'WANT', subject: 'Barn roofing' }), fact({ kind: 'OFFER', subject: 'Barn roofing' })]);
    const h = hs.find((one) => one.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER')!;
    const { kept } = constructFromGraph(hs, OPEN);
    const fromIt = kept.filter((k) => k.hypothesisKey === h.key);
    expect(fromIt.map((k) => k.structure).sort()).toEqual(['BROKER', 'REFERRAL', 'SUBCONTRACT']);
    for (const k of fromIt) {
      expect(k.status).toBe('HYPOTHESIS');
      for (const m of h.missingConditions) expect(k.missingConditions).toContain(m);
      expect(k.evidence).toEqual(h.evidence);
    }
    expect(fromIt.find((k) => k.structure === 'BROKER')!.missingConditions).toContain('the commission share the supplier would pay is not established');
  });

  it('a spread carries its margin bounds and the cost at which the margin vanishes', () => {
    const hs = hypothesesOf([
      fact({ kind: 'PRICE', subject: 'Round bales', side: 'BUY', priceCents: 9000, currency: 'USD', unit: 'bale' }),
      fact({ kind: 'PRICE', subject: 'Round bales', side: 'SELL', priceCents: 6000, currency: 'USD', unit: 'bale', statedCostCents: 1000 }),
    ]);
    const sub = constructFromGraph(hs, OPEN).kept.find((k) => k.rule === 'SPREAD_AFTER_COSTS' && k.structure === 'SUBCONTRACT')!;
    expect(sub.marginCents).toEqual({ low: 2000, high: 3000 });
    expect(sub.breakEvenCostCents).toBe(3000);
    expect(sub.missingConditions).toContain('the capital per deal is not established against any ceiling');
  });
});

describe('infeasible candidates are pruned before costly investigation, with the reason recorded', () => {
  it('a structure that commits capital is pruned when the goal allows none, and the relationship is salvaged', () => {
    const hs = hypothesesOf([fact({ kind: 'WANT', subject: 'Barn roofing' }), fact({ kind: 'OFFER', subject: 'Barn roofing' })]);
    const { kept, pruned } = constructFromGraph(hs, { capitalCeilingCents: 0, delivers: [] });
    expect(kept.some((k) => k.structure === 'SUBCONTRACT')).toBe(false);
    const p = pruned.find((one) => one.structure === 'SUBCONTRACT')!;
    expect(p.reason).toMatch(/commits capital per deal, and the goal allows none/);
    expect(p.salvage.rule).toBe('BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(p.salvage.actorKeys.length).toBe(2);
    expect(p.salvage.factIds.length).toBe(2);
    // The capital-free structures over the same relationship survive.
    expect(kept.map((k) => k.structure)).toEqual(expect.arrayContaining(['BROKER', 'REFERRAL']));
  });

  it('producing is pruned unless Brain proved the deliverable; with it proved, it is kept', () => {
    const hs = hypothesesOf([fact({ kind: 'WANT', subject: 'Barn roofing' }), fact({ kind: 'OFFER', subject: 'Barn roofing' })]);
    const without = constructFromGraph(hs, OPEN);
    expect(without.pruned.find((p) => p.structure === 'PRODUCE')!.reason).toMatch(/has not proved it can produce barn roofing/);
    const withIt = constructFromGraph(hs, { capitalCeilingCents: null, delivers: ['Barn roofing'] });
    expect(withIt.kept.some((k) => k.structure === 'PRODUCE')).toBe(true);
  });

  it('demand with no recorded supply prunes the structures that need a supplier', () => {
    const hs = hypothesesOf([1, 2, 3].map(() => fact({ kind: 'WANT', subject: 'Hay hauling', quantity: 5 })));
    const { kept, pruned } = constructFromGraph(hs, OPEN);
    expect(pruned.filter((p) => p.reason.includes('needs a supplier')).map((p) => p.structure).sort()).toEqual(['BROKER', 'POOL']);
    expect(kept.some((k) => k.structure === 'BROKER' || k.structure === 'POOL')).toBe(false);
  });
});

describe('near-identical designs collapse; distinct mechanisms are kept', () => {
  it('one buyer against two suppliers is one BROKER design standing for both, and BROKER and REFERRAL stay separate', () => {
    const want = fact({ kind: 'WANT', subject: 'Barn roofing' });
    const hs = hypothesesOf([want, fact({ kind: 'OFFER', subject: 'Barn roofing' }), fact({ kind: 'OFFER', subject: 'Barn roofing' })]);
    expect(hs.filter((h) => h.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER')).toHaveLength(2);
    const { kept } = constructFromGraph(hs, OPEN);
    const brokers = kept.filter((k) => k.structure === 'BROKER' && k.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER');
    expect(brokers).toHaveLength(1);
    expect(brokers[0]!.collapsed).toHaveLength(1);
    const structures = new Set(kept.filter((k) => k.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER').map((k) => k.structure));
    expect([...structures].sort()).toEqual(['BROKER', 'REFERRAL', 'SUBCONTRACT']);
  });

  it('ranks by what most deserves investigation, deterministically', () => {
    const hs = hypothesesOf([
      fact({ kind: 'WANT', subject: 'Barn roofing' }),
      fact({ kind: 'OFFER', subject: 'Barn roofing' }),
      fact({ kind: 'PRICE', subject: 'Round bales', side: 'BUY', priceCents: 9000, currency: 'USD', unit: 'bale' }),
      fact({ kind: 'PRICE', subject: 'Round bales', side: 'SELL', priceCents: 6000, currency: 'USD', unit: 'bale', statedCostCents: 1000 }),
    ]);
    const a = constructFromGraph(hs, OPEN).kept;
    const b = constructFromGraph([...hs].reverse(), OPEN).kept;
    expect(b).toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i - 1]!.missingConditions.length).toBeLessThanOrEqual(a[i]!.missingConditions.length);
  });
});
