/**
 * Process-lifetime memory is bounded (production, 2026-11-22: the app's heap sat
 * at 2.0–2.4 GB of its 2.56 GB ceiling, GC took ~15% of the CPU, and the
 * post-release check deferred for want of free memory).
 *
 *  - The process event graph let go of nothing it read: every stored item for as
 *    long as the process lived, and a log of every neighborhood recomputation it
 *    ever made (measured locally: ~0.66 KB a fact, 26.5 MB for 20,000 items).
 *    An item fetched before `EVENT_GRAPH_ITEM_WINDOW_MS` now leaves, so a
 *    long-lived process holds what a fresh one would read, and the log keeps the
 *    last `EVENT_GRAPH_RECOMPUTATIONS_KEPT`.
 *  - Memos whose stale entries are never served dropped them only when newer
 *    keys displaced them (a construction is ~8 MB on production's shape).
 */
import { describe, expect, it } from 'vitest';
import {
  EVENT_GRAPH_ITEM_WINDOW_MS,
  EVENT_GRAPH_RECOMPUTATIONS_KEPT,
  EventGraph,
  currentEventGraph,
  itemFactIds,
  factsFromItem,
  resetEventGraph,
  syncEventGraph,
  type GraphFact,
} from '../server/services/industry/eventGraph.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { dropStale } from '../server/services/cash/construct.ts';
import { KNOWLEDGE_TTL_MS, forgetKnowledge, heldKnowledge, loadCashKnowledge } from '../server/services/quant/knowledge.ts';
import { freshProject } from './helpers.ts';

const DAY = 86_400_000;

function fact(i: number, subject: string): GraphFact {
  return {
    id: `f${i}`,
    kind: i % 2 === 0 ? 'WANT' : 'CAPACITY',
    basis: 'STATED_REQUEST',
    actor: { key: `actor-${i}`, name: null, role: i % 2 === 0 ? 'BUYER' : 'SUPPLIER' },
    subject,
    region: 'york pa',
    quantity: null,
    unit: null,
    priceCents: null,
    currency: null,
    side: null,
    statedCostCents: null,
    window: { from: '2026-11-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' },
    channel: null,
    rights: [],
    evidence: [{ rawId: `raw-${i}`, source: 'test-feed', url: null, observedAt: '2026-11-10T00:00:00.000Z' }],
  };
}

describe('the event graph holds a bounded amount', () => {
  it('keeps only the most recent recomputations in its log', () => {
    const graph = new EventGraph();
    const total = 3 * EVENT_GRAPH_RECOMPUTATIONS_KEPT + 17;
    for (let i = 0; i < total; i++) graph.add(fact(i, `subject ${i % 50}`));
    expect(graph.recomputations.length).toBeLessThanOrEqual(2 * EVENT_GRAPH_RECOMPUTATIONS_KEPT);
    expect(graph.recomputations.length).toBeGreaterThanOrEqual(EVENT_GRAPH_RECOMPUTATIONS_KEPT);
    // The newest is the last one made, in order.
    expect(graph.recomputations[graph.recomputations.length - 1]).toBe(`subject ${(total - 1) % 50}`);
    expect(graph.size()).toBe(total);
  });

  it('removeMany recomputes each neighborhood it empties once, and reads as removing them one by one', () => {
    const a = new EventGraph();
    const b = new EventGraph();
    for (let i = 0; i < 40; i++) {
      a.add(fact(i, `subject ${i % 4}`));
      b.add(fact(i, `subject ${i % 4}`));
    }
    a.recomputations.length = 0;
    const gone = Array.from({ length: 20 }, (_, i) => `f${i * 2}`);
    expect(a.removeMany([...gone, 'not-held']).affected).toEqual(['subject 0', 'subject 2']);
    expect(a.recomputations).toEqual(['subject 0', 'subject 2']);
    for (const id of gone) b.remove(id);
    expect(a.hypotheses()).toEqual(b.hypotheses());
    expect(a.size()).toBe(20);
  });

  it('names every id factsFromItem gives an item', () => {
    const at = new Date().toISOString();
    const due = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    const facts = factsFromItem({ id: 'x1', source: 'rfq-board', url: 'https://board.test/x1', title: 'Request for quotes: lawn mowing', body: `Seeking quotes from a supplier in Dallas, TX by ${due}. Budget $60.`, organization: 'Acme Foods LLC', publishedAt: at, fetchedAt: at });
    expect(facts.length).toBeGreaterThan(1);
    for (const one of facts) expect(itemFactIds('x1')).toContain(one.id);
  });

  it('lets an item go once it falls out of the window, and then holds what a fresh process would read', async () => {
    await freshProject();
    resetEventGraph();
    const now = new Date();
    const due = new Date(now.getTime() + 20 * DAY).toISOString().slice(0, 10);
    await insertFeedItems('rfq-board', [
      { externalId: 'rfq-1', url: 'https://board.test/rfq-1', title: 'Request for quotes: lawn mowing', body: `Seeking quotes from a supplier in Dallas, TX by ${due}. Budget $60.`, organization: 'Acme Foods LLC', publishedAt: now.toISOString() },
      { externalId: 'ad-1', url: 'https://board.test/ad-1', title: 'Lawn mowing now booking', body: 'We offer weekly mowing in Dallas, TX for $45.', organization: 'Green Co', publishedAt: now.toISOString() },
    ]);
    const first = await syncEventGraph(now);
    expect(first.itemsRead).toBe(2);
    const held = first.facts;
    expect(held).toBeGreaterThan(0);
    expect(currentEventGraph().hypotheses().length).toBeGreaterThan(0);

    // Still inside the window: nothing leaves.
    const inside = await syncEventGraph(new Date(now.getTime() + EVENT_GRAPH_ITEM_WINDOW_MS - DAY));
    expect(inside.removed).toBe(0);
    expect(inside.facts).toBe(held);

    // Past it: every fact the items gave leaves, and their neighborhoods are recomputed.
    const later = new Date(now.getTime() + EVENT_GRAPH_ITEM_WINDOW_MS + DAY);
    const past = await syncEventGraph(later);
    expect(past.removed).toBe(held);
    expect(past.facts).toBe(0);
    expect(past.recomputed).toEqual(['lawn mowing']);
    expect(currentEventGraph().hypotheses()).toEqual([]);
    const longLived = currentEventGraph().hypotheses();

    // A fresh process at the same moment reads the same (nothing).
    resetEventGraph();
    const fresh = await syncEventGraph(later);
    expect(fresh.facts).toBe(0);
    expect(currentEventGraph().hypotheses()).toEqual(longLived);
    resetEventGraph();
  });
});

describe('memos let go of entries they will never serve', () => {
  it('dropStale removes exactly the entries at or past their age', () => {
    const memo = new Map<string, { at: number; v: number }>([
      ['old', { at: 0, v: 1 }],
      ['edge', { at: 1_000, v: 2 }],
      ['young', { at: 1_500, v: 3 }],
    ]);
    dropStale(memo, 1_000, 2_000);
    expect([...memo.keys()]).toEqual(['young']);
  });

  it('a project knowledge read lets another project\'s stale knowledge go', async () => {
    const { project } = await freshProject();
    forgetKnowledge();
    const t0 = Date.now();
    await loadCashKnowledge(project.id, t0);
    await loadCashKnowledge('prj_other_for_bound', t0 + 1);
    expect(heldKnowledge()).toBe(2);
    // Past the first's freshness, a read of another project keeps only what can still be served.
    await loadCashKnowledge('prj_third_for_bound', t0 + KNOWLEDGE_TTL_MS);
    expect(heldKnowledge()).toBe(2);
    await loadCashKnowledge('prj_fourth_for_bound', t0 + 2 * KNOWLEDGE_TTL_MS + 5);
    expect(heldKnowledge()).toBe(1);
    forgetKnowledge();
  }, 60_000);
});
