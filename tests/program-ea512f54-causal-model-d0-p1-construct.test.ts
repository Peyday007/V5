/**
 * Brain constructs the causal graph (CAUSAL-14-1): it discovers the variables a
 * graph implies and does not model, declares a type when the vocabulary has no
 * word for the role, expands to a fixpoint, and joins several graphs into a
 * portfolio where a party two businesses share is one node that constrains both.
 */
import { describe, expect, it } from 'vitest';
import {
  addAction,
  addMoneyRoute,
  addNode,
  createGraph,
  discoverMissing,
  expandGraph,
  expandToFixpoint,
  linkGraphs,
  makeFigure,
  trace,
  type CausalGraph,
  type Figure,
  type FigureInput,
} from '../server/services/quant/graph.ts';

function figure(input: FigureInput): Figure {
  const made = makeFigure(input);
  if (!made.ok) throw new Error(made.reason);
  return made.figure;
}

function business(subject: string, supplier: string, held = 0): CausalGraph {
  const graph = createGraph(subject);
  addMoneyRoute(graph, {
    id: 'sale', payer: 'Retail buyer', for: `${subject} order`, terms: 'prepaid', channel: 'storefront', invoicedAt: '2026-11-01', collectedAt: '2026-11-01',
    collectedCents: figure({ meaning: 'collected', unit: 'cents', value: 50_000, status: 'OBSERVED', source: 'processor' }),
    heldAgainstCents: figure({ meaning: 'held', unit: 'cents', value: held, status: 'CONTRACTED', source: 'refund policy' }),
    outflows: [{ to: supplier, reason: 'goods', amountCents: 20_000, at: '2026-11-03' }],
  });
  const added = addAction(graph, {
    id: 'ship', label: 'Ship order', prerequisites: [], actor: 'Ops lead', permissions: ['carrier account'], effect: 'order shipped', timing: 'same day',
    externalDependencies: ['Carrier API'], evidence: ['order row'], completionCondition: 'tracking number issued',
  });
  if (!added.ok) throw new Error(added.reason);
  return graph;
}

describe('discovery', () => {
  it('names every variable a route and an action imply, each with what implied it, and changes nothing', () => {
    const graph = business('shop', 'Mill Co', 5_000);
    const found = discoverMissing(graph);
    expect(graph.nodes.size).toBe(0);
    const nodes = found.filter((d) => d.kind === 'node').map((d) => [d.node?.type, d.node?.label]);
    expect(nodes).toEqual(expect.arrayContaining([
      ['payer', 'Retail buyer'], ['offer', 'shop order'], ['channel', 'storefront'], ['payee', 'Mill Co'],
      ['obligation', 'refund or fulfilment hold on sale'], ['workflow_step', 'action:ship'], ['actor', 'Ops lead'],
      ['approval', 'carrier account'], ['external_dependency', 'Carrier API'],
    ]));
    for (const one of found) expect(one.because.length).toBeGreaterThan(0);
  });

  it('declares a type the seed vocabulary lacks, with why, before using it', () => {
    const found = discoverMissing(business('shop', 'Mill Co'));
    const payeeType = found.findIndex((d) => d.kind === 'type' && d.type?.name === 'payee');
    const payeeNode = found.findIndex((d) => d.kind === 'node' && d.node?.type === 'payee');
    expect(payeeType).toBeGreaterThanOrEqual(0);
    expect(payeeType).toBeLessThan(payeeNode);
    expect(found[payeeType]?.type?.reason).toMatch(/no seed type/);
  });

  it('reuses a node the graph already has, by id or by name, instead of duplicating it', () => {
    const graph = business('shop', 'Mill Co');
    addNode(graph, { id: 'mill', type: 'supplier', label: 'mill co' });
    const found = discoverMissing(graph);
    expect(found.some((d) => d.kind === 'node' && d.node?.label === 'Mill Co')).toBe(false);
    expect(found.some((d) => d.kind === 'relation' && d.relation?.to === 'mill')).toBe(true);
  });

  it('a route with nothing held adds no hold; an unknown hold is a hold', () => {
    expect(discoverMissing(business('shop', 'X')).some((d) => d.node?.type === 'obligation')).toBe(false);
    const graph = business('shop', 'X');
    const route = graph.routes.get('sale');
    if (!route) throw new Error('no route');
    route.heldAgainstCents = { ...route.heldAgainstCents, value: null, status: 'UNKNOWN', source: null };
    expect(discoverMissing(graph).some((d) => d.node?.type === 'obligation')).toBe(true);
  });
});

describe('construction', () => {
  it('expands to a fixpoint through the model’s own constructors', () => {
    const graph = business('shop', 'Mill Co');
    const built = expandToFixpoint(graph);
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.length).toBeGreaterThan(0);
    expect(discoverMissing(graph)).toEqual([]);
    expect(graph.nodeTypes.get('payee')?.reason).toMatch(/outflow/);
    const causes = trace(graph, 'payee:mill-co', 'backward');
    expect(causes?.reached.map((r) => r.node.label)).toEqual(expect.arrayContaining(['shop order', 'Retail buyer']));
  });

  it('applying the same discoveries twice adds nothing the second time', () => {
    const graph = business('shop', 'Mill Co');
    const found = discoverMissing(graph);
    expect(expandGraph(graph, found).ok).toBe(true);
    const nodes = graph.nodes.size;
    expect(expandGraph(graph, found).ok).toBe(true);
    expect(graph.nodes.size).toBe(nodes);
  });
});

describe('portfolio', () => {
  const built = (subject: string, supplier: string): CausalGraph => {
    const graph = business(subject, supplier);
    const done = expandToFixpoint(graph);
    if (!done.ok) throw new Error(done.reason);
    return graph;
  };

  it('a party two businesses depend on becomes one shared node that constrains both', () => {
    const linked = linkGraphs('holdings', [built('shop', 'Mill Co'), built('wholesale', 'MILL CO')]);
    if (!linked.ok) throw new Error(linked.reason);
    const mill = linked.value.shared.find((one) => one.type === 'payee');
    expect(mill?.members.sort()).toEqual(['shop::payee:mill-co', 'wholesale::payee:mill-co']);
    const effects = trace(linked.value.graph, mill?.node ?? '', 'forward');
    expect(effects?.reached.map((r) => r.node.id)).toEqual(expect.arrayContaining(['shop::payee:mill-co', 'wholesale::payee:mill-co']));
    // A member's own offer is its own, never merged with another's.
    expect(linked.value.shared.some((one) => one.type === 'offer')).toBe(false);
    expect(linked.value.graph.nodeTypes.get('shared_dependency')?.reason).toMatch(/portfolio/);
  });

  it('keeps each member’s routes, actions and claims under its subject, so nothing collides', () => {
    const linked = linkGraphs('holdings', [built('shop', 'A'), built('wholesale', 'B')]);
    if (!linked.ok) throw new Error(linked.reason);
    expect([...linked.value.graph.routes.keys()].sort()).toEqual(['shop::sale', 'wholesale::sale']);
    expect([...linked.value.graph.actions.keys()].sort()).toEqual(['shop::ship', 'wholesale::ship']);
    expect(linked.value.shared.map((one) => one.label).sort()).toEqual(expect.arrayContaining(['Retail buyer', 'storefront', 'Ops lead']));
  });

  it('a stated link joins two members; a link to a missing node or member is refused', () => {
    const members = [built('shop', 'A'), built('wholesale', 'B')];
    const ok = linkGraphs('holdings', members, [{ from: { graph: 'wholesale', node: 'offer:wholesale-order' }, to: { graph: 'shop', node: 'offer:shop-order' }, type: 'causes' }]);
    if (!ok.ok) throw new Error(ok.reason);
    const effects = trace(ok.value.graph, 'wholesale::offer:wholesale-order', 'forward');
    expect(effects?.reached.map((r) => r.node.id)).toContain('shop::offer:shop-order');
    expect(linkGraphs('h', members, [{ from: { graph: 'shop', node: 'missing' }, to: { graph: 'wholesale', node: 'offer:wholesale-order' }, type: 'causes' }]).ok).toBe(false);
    expect(linkGraphs('h', members, [{ from: { graph: 'nobody', node: 'x' }, to: { graph: 'shop', node: 'offer:shop-order' }, type: 'causes' }]).ok).toBe(false);
    expect(linkGraphs('h', members, [{ from: { graph: 'shop', node: 'offer:shop-order' }, to: { graph: 'wholesale', node: 'offer:wholesale-order' }, type: 'undeclared_kind' }]).ok).toBe(false);
  });

  it('refuses two members with the same subject', () => {
    expect(linkGraphs('h', [built('shop', 'A'), built('shop', 'B')]).ok).toBe(false);
  });
});
