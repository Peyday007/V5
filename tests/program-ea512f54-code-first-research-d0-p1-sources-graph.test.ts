/**
 * R3-F3 (program fpg_ea512f54974d4ff39a84, ALGO-16-1 items 1–3): the production
 * source catalog carries a source family with both sides of one market — the
 * Hacker News freelance thread, read through its public search API — so stated
 * requests, supplier adverts, capacity and asked rates reach the event graph
 * from real feed rows, and the buyer-against-supplier and spread rules have
 * production input rather than only hand-built facts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { FEED_SOURCES, parseHnFreelance, pullUrl } from '../server/services/feeds/sources.ts';
import { recordKindOf, type ExtractableItem } from '../server/services/feeds/extract.ts';
import { EventGraph, currentEventGraph, factsFromItem, resetEventGraph, syncEventGraph } from '../server/services/industry/eventGraph.ts';

const at = new Date(Date.now() - 2 * 3_600_000);
const iso = at.toISOString();

/** The shape HN's Algolia search answers with, as the parser reads it. */
function algolia(hits: { id: string; author: string; text: string }[]): unknown {
  return {
    hits: hits.map((one) => ({
      objectID: one.id,
      author: one.author,
      comment_text: one.text,
      created_at: iso,
      created_at_i: Math.floor(at.getTime() / 1000),
      story_title: 'Ask HN: Freelancer? Seeking freelancer? (November 2026)',
    })),
    nbHits: hits.length,
  };
}

const wanted = algolia([
  { id: '9001', author: 'acmeops', text: 'SEEKING FREELANCER | Senior React Developer | Remote<p>We need help shipping a dashboard by 2026-12-20. Budget $120/hr.' },
  { id: '9002', author: 'quoter', text: '&gt; SEEKING FREELANCER quoted in a reply is not a request' },
  { id: '9003', author: 'bakery', text: 'SEEKING FREELANCER | Austin, TX | Copywriter<p>Menu and website copy, $500 total.' },
]);
const offered = algolia([
  { id: '9101', author: 'devjane', text: 'SEEKING WORK | Remote | React Developer<p>Available now for new clients. Rate: $85/hr.' },
  { id: '9102', author: 'writerbo', text: 'SEEKING WORK | Location: Austin, TX | Copywriter<p>Taking on two projects this month at $60/hr.' },
]);

function asItems(source: string, body: unknown, parse: (b: unknown) => ReturnType<ReturnType<typeof parseHnFreelance>>): ExtractableItem[] {
  return parse(body).map((one) => ({
    id: `${source}:${one.externalId}`,
    source,
    url: one.url,
    title: one.title,
    body: one.body,
    organization: one.organization,
    publishedAt: one.publishedAt,
    fetchedAt: iso,
  }));
}

describe('a source family with both sides of one market is in the production catalog', () => {
  it('both sides of the HN freelance thread are feed sources, incremental from their own last read', () => {
    const want = FEED_SOURCES.find((one) => one.id === 'hn-seeking-freelancer')!;
    const work = FEED_SOURCES.find((one) => one.id === 'hn-seeking-work')!;
    expect(want).toBeDefined();
    expect(work).toBeDefined();
    const first = pullUrl(want, null);
    expect(first.incremental).toBe(false);
    const next = pullUrl(want, '2026-11-16T12:00:00.000Z');
    expect(next.incremental).toBe(true);
    // Two hours of overlap before the last success: 10:00Z is 1794823200.
    expect(decodeURIComponent(next.url)).toContain('created_at_i>1794823200');
  });

  it('only a comment that opens with its side tag is kept, titled by the work it names and attributed to its author', () => {
    const items = parseHnFreelance('SEEKING FREELANCER')(wanted);
    expect(items.map((one) => one.externalId)).toEqual(['9001', '9003']);
    expect(items[0]!.title).toBe('Senior React Developer');
    expect(items[1]!.title).toBe('Copywriter');
    expect(items[0]!.organization).toBe('acmeops');
    expect(items[0]!.url).toBe('https://news.ycombinator.com/item?id=9001');
    expect(parseHnFreelance('SEEKING WORK')(offered).map((one) => one.title)).toEqual(['React Developer', 'Copywriter']);
  });

  it('a request is a stated request and an offer is a supplier advert, by their source', () => {
    expect(recordKindOf({ source: 'hn-seeking-freelancer', title: 'Copywriter', body: null })).toBe('STATED_REQUEST');
    expect(recordKindOf({ source: 'hn-seeking-work', title: 'Copywriter', body: null })).toBe('SUPPLIER_AD');
  });
});

describe('those records give the graph rules production input', () => {
  const requests = asItems('hn-seeking-freelancer', wanted, parseHnFreelance('SEEKING FREELANCER'));
  const offers = asItems('hn-seeking-work', offered, parseHnFreelance('SEEKING WORK'));

  it('a request and an offer for one role in one place are a buyer request against a supplier, and their rates a spread', () => {
    const graph = new EventGraph();
    for (const item of [...requests, ...offers]) for (const f of factsFromItem(item)) graph.add(f);
    const hs = graph.hypotheses();
    const match = hs.find((h) => h.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER' && h.neighborhood === 'react developer');
    expect(match).toBeDefined();
    expect(new Set(match!.evidence.map((e) => e.source))).toEqual(new Set(['hn-seeking-freelancer', 'hn-seeking-work']));
    const spread = hs.find((h) => h.rule === 'SPREAD_AFTER_COSTS' && h.neighborhood === 'react developer');
    expect(spread).toBeDefined();
    expect(spread!.figures['grossCents']).toBe(3500);
    expect(spread!.missingConditions).toContain('the necessary costs (transport, fees, handling) are not stated, so the spread is before costs');
    // The capacity wording makes the supplier's fact CAPACITY; it is still an advert, never reserved capacity.
    const offerFacts = factsFromItem(offers[0]!);
    expect(offerFacts.find((f) => f.id === `item:${offers[0]!.id}`)!.kind).toBe('CAPACITY');
    expect(match!.missingConditions.some((m) => m.includes('advertisement is not capacity reserved'))).toBe(true);
  });

  it('a total budget is never read against an hourly rate as a spread', () => {
    const graph = new EventGraph();
    for (const item of [...requests, ...offers]) for (const f of factsFromItem(item)) graph.add(f);
    // The copywriter request states $500 total; the offer $60/hr: different units, no spread.
    expect(graph.hypotheses().some((h) => h.rule === 'SPREAD_AFTER_COSTS' && h.neighborhood === 'copywriter')).toBe(false);
    expect(graph.hypotheses().some((h) => h.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER' && h.neighborhood === 'copywriter')).toBe(true);
  });
});

describe('stored rows from the new sources reach the running graph through its own sync', () => {
  beforeEach(async () => {
    await freshProject();
    resetEventGraph();
  });

  it('the scheduled sync reads them and the buyer-against-supplier rule fires on them', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const tag = (body: unknown, side: 'SEEKING FREELANCER' | 'SEEKING WORK') =>
      parseHnFreelance(side)(body).map((one) => ({ ...one, externalId: `${one.externalId}-${suffix}`, organization: `${one.organization}-${suffix}` }));
    await insertFeedItems('hn-seeking-freelancer', tag(wanted, 'SEEKING FREELANCER'));
    await insertFeedItems('hn-seeking-work', tag(offered, 'SEEKING WORK'));
    await syncEventGraph(new Date());
    const hs = currentEventGraph().hypotheses().filter((h) => h.actorKeys.some((k) => k.includes(suffix)));
    expect(hs.some((h) => h.rule === 'BUYER_REQUEST_AGAINST_SUPPLIER')).toBe(true);
    expect(hs.some((h) => h.rule === 'SPREAD_AFTER_COSTS')).toBe(true);
  });
});
