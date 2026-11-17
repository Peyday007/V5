/**
 * KNOW-25-1, repair: a delta pass re-reads only what changed, but a changed
 * record's facts are recomputed against the stored observations of the same
 * keys — records this pass did not re-read, in its batch or from an earlier
 * pass — so a changed record is contested against an unchanged one, and a key
 * a changed record stopped stating is re-derived from what remains.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { recordFeedExtraction } from '../server/services/feeds/run.ts';
import { extractItem, extractItems, type ExtractableItem } from '../server/services/feeds/extract.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const TITLE = 'Request for quotes: 500 kg of packaging film';
function rfq(source: string, slot: string, tag: string, budget: string | null, hours: number) {
  return {
    externalId: `${source}-${slot}-${tag}`,
    url: `https://example.test/${source}/${slot}`,
    title: TITLE,
    body: `Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15.${budget ? ` Budget ${budget}.` : ''}`,
    organization: 'Acme Foods LLC',
    publishedAt: hoursAgo(hours),
  };
}

const priceKeyOf = (pass: { reconciled: { key: string }[] }) => pass.reconciled.find((r) => r.key.startsWith('price:'))?.key;

describe('a changed record is recomputed against stored observations of its keys (repair)', () => {
  it('a changed record is contested against an unchanged record from an earlier pass', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'one', 'a', '$4,000', 6), rfq(source, 'two', 'a', '$4,000', 5)]);
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    const key = priceKeyOf(first)!;
    expect(key).toBeDefined();
    expect(first.reconciled.find((r) => r.key === key)!.status).toBe('OBSERVED');
    const twoId = (await getDb().get<{ id: string }>('SELECT id FROM feed_items WHERE source = ? AND external_id = ?', [source, `${source}-two-a`]))!.id;
    expect(first.reconciled.find((r) => r.key === key)!.itemIds).toContain(twoId);
    await tick();

    // Only record "one" comes back, changed; record "two" is not in this batch at all.
    await insertFeedItems(source, [rfq(source, 'one', 'b', '$6,500', 6)]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, NEW: 0 });
    const recomputed = second.reconciled.find((r) => r.key === key)!;
    expect(recomputed.status).toBe('CONTESTED');
    expect(recomputed.itemIds).toContain(twoId);
    expect(second.delta!.reconciledAgainst).toContain(twoId);
    expect(second.delta!.recomputedKeys).toContain(key);
    // The pass's own facts are still only what it read, now carrying the contradiction.
    expect(second.facts.every((f) => f.evidence.itemId === second.delta!.changedItems[0])).toBe(true);
    expect(second.facts.find((f) => f.key === key)!.contradictionStatus).toBe('CONTESTED');
    expect(second.stageFailures).toEqual([]);
  });

  it('a changed record is contested against an unchanged record in the same batch', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'one', 'a', '$4,000', 6), rfq(source, 'two', 'a', '$4,000', 5)]);
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 });
    await tick();
    await insertFeedItems(source, [rfq(source, 'one', 'b', '$6,500', 6), rfq(source, 'two', 'b', '$4,000', 5)]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, UNCHANGED: 1 });
    const unchangedId = second.delta!.unchangedItems[0]!;
    const recomputed = second.reconciled.find((r) => r.key === priceKeyOf(second))!;
    expect(recomputed.status).toBe('CONTESTED');
    expect(recomputed.itemIds).toContain(unchangedId);
  });

  it('a key a changed record stopped stating is re-derived from the observations that remain', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'one', 'a', '$5,000', 6), rfq(source, 'two', 'a', '$4,000', 5)]);
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    const key = priceKeyOf(first)!;
    expect(first.reconciled.find((r) => r.key === key)!.status).toBe('CONTESTED');
    await tick();
    await insertFeedItems(source, [rfq(source, 'one', 'b', null, 6)]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts.CHANGED).toBe(1);
    const recomputed = second.reconciled.find((r) => r.key === key)!;
    expect(recomputed.status).toBe('OBSERVED');
    expect(recomputed.value).not.toBeNull();
    expect(recomputed.itemIds.length).toBe(1);
    expect(recomputed.itemIds).not.toContain(second.delta!.changedItems[0]);
    expect(second.facts.some((f) => f.key === key)).toBe(false);
  });

  it('a pass over unchanged records still reloads nothing and recomputes nothing', async () => {
    const source = `r${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'one', 'a', '$4,000', 6)]);
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 });
    await tick();
    await insertFeedItems(source, [rfq(source, 'one', 'b', '$4,000', 6)]);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.recomputedKeys).toEqual([]);
    expect(second.delta!.reconciledAgainst).toEqual([]);
    expect(second.reconciled).toEqual([]);
  });
});

describe('extractItems reconciles read facts with stored observations of the recomputed keys only', () => {
  const item = (id: string, body: string, title = TITLE): ExtractableItem => ({
    id, source: 's', url: `https://example.test/${id}`, title, body, organization: 'Acme Foods LLC', publishedAt: now.toISOString(), fetchedAt: now.toISOString(),
  });
  it('a stored observation contests a read one, and an unrelated stored key is not re-derived', () => {
    const read = item('a', 'Budget $6,500.');
    const storedSame = item('b', 'Budget $4,000.');
    const storedOther = item('c', 'Budget $1,000.', 'Weekly mowing service wanted');
    const run = extractItems([read], now, { items: [storedSame, storedOther] });
    const key = extractItem(read).find((f) => f.field === 'price')!.key;
    expect(run.reconciled.find((r) => r.key === key)!.status).toBe('CONTESTED');
    expect(run.facts.every((f) => f.evidence.itemId === 'a')).toBe(true);
    const otherKey = extractItem(storedOther).find((f) => f.field === 'price')!.key;
    expect(run.reconciled.some((r) => r.key === otherKey)).toBe(false);
    // Named as affected, the other key is recomputed from what remains.
    const again = extractItems([read], now, { items: [storedSame, storedOther], affectedKeys: [otherKey] });
    expect(again.reconciled.find((r) => r.key === otherKey)!.status).toBe('OBSERVED');
  });
});
