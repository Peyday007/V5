/**
 * KNOW-25-1 on production rows: every deterministic-extraction pass records,
 * on its existing FEED_EXTRACTION row, the processing graph judged per source,
 * the delta against the previous pass's fingerprint index, identity resolution
 * with collisions, selective-deepening decisions and the intelligence funnel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { EXTRACTION_EVENT, recordFeedExtraction, type ExtractionPass } from '../server/services/feeds/run.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function records(source: string, tag: string) {
  return [
    {
      externalId: `${source}-rfq-${tag}`,
      url: `https://example.test/${source}/rfq`,
      title: 'Request for quotes: 500 kg of packaging film',
      body: 'Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget $4,000.',
      organization: 'Acme Foods LLC',
      publishedAt: hoursAgo(5),
    },
    {
      externalId: `${source}-ad-${tag}`,
      url: `https://example.test/${source}/ad`,
      title: 'Lawn care now booking',
      body: 'We offer weekly mowing in Portland, OR for $45.',
      organization: 'Acme Foods LLC',
      publishedAt: hoursAgo(4),
    },
    {
      externalId: `${source}-vague-${tag}`,
      url: `https://example.test/${source}/vague`,
      title: 'Thoughts on the market',
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: hoursAgo(3),
    },
  ];
}

async function rows(): Promise<ExtractionPass[]> {
  const found = await getDb().all<{ detail: string }>(
    'SELECT detail FROM cash_events WHERE project_id = ? AND kind = ? ORDER BY created_at, id',
    [projectId, EXTRACTION_EVENT],
  );
  return found.map((r) => JSON.parse(r.detail) as ExtractionPass);
}

describe('recordFeedExtraction records the processing graph, delta, identity, deepening and funnel', () => {
  it('the recorded row carries every stage', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 1 });
    const [row] = await rows();
    expect(row).toBeDefined();

    expect(row!.processingGraph!.length).toBe(1);
    const plan = row!.processingGraph![0]!;
    expect(plan.sourceId).toBe(source);
    expect(plan.status).toBe('PLANNED');
    expect(plan.stages.length).toBeGreaterThan(0);
    expect(plan.stages.every((s) => (s.executor === 'LLM') === (s.llmReason !== null))).toBe(true);

    expect(row!.delta!.counts.NEW).toBe(3);
    expect(row!.delta!.newItems.length).toBe(3);
    expect(row!.delta!.unchangedItems).toEqual([]);
    expect(row!.delta!.recomputedKeys.length).toBeGreaterThan(0);

    // Same name, different stated place: kept apart and reported, never fused.
    expect(row!.identity!.links).toEqual([]);
    expect(row!.identity!.collisions.length).toBe(1);
    expect(row!.identity!.collisions[0]!.attribute).toBe('location');

    const decided = [...row!.deepening!.promoted, ...row!.deepening!.held];
    expect(row!.deepening!.capacity).toBe(1);
    expect(decided.some((d) => d.id.startsWith('item:'))).toBe(true);
    expect(decided.every((d) => d.reasons.length > 0)).toBe(true);
    expect(row!.deepening!.promoted.length).toBeLessThanOrEqual(1);

    const stages = row!.funnel!.reading.stages.map((s) => s.stage);
    expect(stages).toEqual(['RAW_INTAKE', 'PARSED', 'NORMALIZED_FACTS', 'EVIDENCE_ACCEPTED', 'RELATIONSHIPS_UPDATED', 'GOAL_DECISIONS']);
    expect(row!.funnel!.reading.stages[0]!.raw).toBe(3);
    expect(row!.funnel!.gain.usableIntelligence).toBeGreaterThan(0);
    expect(row!.stageFailures).toEqual([]);
    expect(row!.deltaIndex).toBeDefined();
  });

  it('a second pass over unchanged records recomputes nothing and gains no usable intelligence', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 2 });
    await tick();
    // The same records republished under new ids: raw intake grows, understanding does not.
    await insertFeedItems(source, records(source, 'b'));
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 2 }))!;
    expect(second.items).toBe(3);
    expect(second.delta!.counts.UNCHANGED).toBe(3);
    expect(second.delta!.unchangedItems.length).toBe(3);
    expect(second.delta!.recomputedKeys).toEqual([]);
    expect(second.facts).toEqual([]);
    expect(second.funnel!.gain.usableIntelligence).toBe(0);
    expect(second.funnel!.gain.falseSpeed).toBe(true);
    expect(second.processingGraph![0]!.status).toBe('UNCHANGED');
    expect((await rows()).length).toBe(2);
  });

  it('a changed record is re-read and only its keys are recomputed', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    await tick();
    const changed = records(source, 'b').map((r, i) => (i === 0 ? { ...r, body: r.body!.replace('$4,000', '$6,500') } : r));
    await insertFeedItems(source, changed);
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts).toMatchObject({ CHANGED: 1, UNCHANGED: 2, NEW: 0 });
    const rfqKeys = first.facts.filter((f) => f.evidence.itemId === first.delta!.newItems.find((id) => first.facts.some((x) => x.evidence.itemId === id && x.evidence.text.includes('4,000')))).map((f) => f.key);
    for (const key of rfqKeys) expect(second.delta!.recomputedKeys).toContain(key);
    expect(second.facts.every((f) => f.evidence.itemId === second.delta!.changedItems[0])).toBe(true);
    // No capacity: nothing is promoted, and the threshold says so.
    expect(second.deepening!.promoted).toEqual([]);
  });

  it('a pass still records when one stage fails, naming the stage', async () => {
    const source = `w${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, records(source, 'a'));
    const pass = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 1, failStages: ['identity'] }))!;
    expect(pass.stageFailures!.map((f) => f.stage)).toEqual(['identity']);
    const [row] = await rows();
    expect(row!.stageFailures!.map((f) => f.stage)).toEqual(['identity']);
    expect(row!.delta!.counts.NEW).toBe(3);
    expect(row!.facts.length).toBeGreaterThan(0);
    expect(row!.funnel).toBeDefined();
    const summary = await getDb().get<{ summary: string }>('SELECT summary FROM cash_events WHERE project_id = ? AND kind = ?', [projectId, EXTRACTION_EVENT]);
    expect(summary!.summary).toContain('identity');
  });
});
