/**
 * KNOW-25-1, repair "unchanged items drop from pass facts": a changed record
 * recomputes the fact keys it touches against the stored observations of the
 * same keys — the unchanged records of its batch and the records an earlier
 * pass read — so it can be CONTESTED against one it did not re-read.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { recordFeedExtraction } from '../server/services/feeds/run.ts';
import { extractItem, recomputeAffected, type ExtractableItem } from '../server/services/feeds/extract.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const rfq = (source: string, n: number, tag: string, budget: string) => ({
  externalId: `${source}-rfq${n}-${tag}`,
  url: `https://example.test/${source}/rfq${n}`,
  title: 'Request for quotes: 500 kg of packaging film',
  body: `Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget ${budget}.`,
  organization: 'Acme Foods LLC',
  publishedAt: hoursAgo(5 - n),
});

describe('a changed record is reconciled against the stored observations of its keys', () => {
  it('against a record an earlier pass read and this pass does not see', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 1, 'a', '$4,000'), rfq(source, 2, 'a', '$4,000')]);
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    const priceKey = first.reconciled.find((r) => r.key.startsWith('price:'))!;
    expect(priceKey.status).toBe('OBSERVED');
    expect(priceKey.itemIds.length).toBe(2);
    const unchangedId = priceKey.itemIds.find((id) => first.facts.some((f) => f.evidence.itemId === id && f.evidence.url.endsWith('/rfq2')))!;
    await tick();
    // Only the first record arrives again, with a different budget.
    await insertFeedItems(source, [rfq(source, 1, 'b', '$6,500')]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, NEW: 0 });
    const recomputed = second.reconciled.find((r) => r.key === priceKey.key)!;
    expect(recomputed.status).toBe('CONTESTED');
    expect(recomputed.itemIds).toContain(unchangedId);
    expect(second.delta!.recomputedAgainst).toContain(unchangedId);
    // Only what was read now is this pass's facts; the stored observation is not re-recorded.
    expect(second.facts.every((f) => f.evidence.itemId === second.delta!.changedItems[0])).toBe(true);
    expect(second.facts.find((f) => f.key === priceKey.key)!.contradictionStatus).toBe('CONTESTED');
  });

  it('against an unchanged record of the same batch, which is not re-read', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 1, 'a', '$4,000'), rfq(source, 2, 'a', '$4,000')]);
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 });
    await tick();
    await insertFeedItems(source, [rfq(source, 1, 'b', '$6,500'), rfq(source, 2, 'b', '$4,000')]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, UNCHANGED: 1 });
    const unchangedId = second.delta!.unchangedItems[0]!;
    const price = second.reconciled.find((r) => r.key.startsWith('price:'))!;
    expect(price.status).toBe('CONTESTED');
    expect(price.itemIds).toContain(unchangedId);
    expect(second.delta!.recomputedAgainst).toEqual([unchangedId]);
  });

  it('an unchanged pass recomputes nothing and reads nothing stored', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 1, 'a', '$4,000')]);
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 });
    await tick();
    await insertFeedItems(source, [rfq(source, 1, 'b', '$4,000')]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.recomputedKeys).toEqual([]);
    expect(second.delta!.recomputedAgainst).toEqual([]);
    expect(second.reconciled).toEqual([]);
  });
});

describe('recomputeAffected', () => {
  const item = (id: string, budget: string): ExtractableItem => ({
    id,
    source: 's',
    url: `https://example.test/${id}`,
    title: 'Request for quotes: 500 kg of packaging film',
    body: `Seeking quotes from a supplier. Budget ${budget}.`,
    organization: 'Acme Foods LLC',
    publishedAt: hoursAgo(2),
    fetchedAt: hoursAgo(1),
  });
  it('reconciles affected keys over read and stored observations, and leaves untouched keys alone', () => {
    const read = extractItem(item('new', '$6,500'));
    const stored = [...extractItem(item('old', '$4,000')), { ...extractItem(item('other', '$9,000'))[0]!, key: 'untouched' }];
    const out = recomputeAffected(read, stored, [], now);
    const price = out.reconciled.find((r) => r.key.startsWith('price:'))!;
    expect(price.status).toBe('CONTESTED');
    expect(out.reconciled.some((r) => r.key === 'untouched')).toBe(false);
    expect(out.facts.map((f) => f.evidence.itemId).every((id) => id === 'new')).toBe(true);
    // A stored observation of a record read now is superseded by that reading.
    expect(recomputeAffected(read, extractItem(item('new', '$4,000')), [], now).reconciled.find((r) => r.key.startsWith('price:'))!.status).toBe('OBSERVED');
  });
});
