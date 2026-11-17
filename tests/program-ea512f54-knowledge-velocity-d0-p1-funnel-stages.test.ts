/**
 * KNOW-25-1 "No false speed": evidence accepted and goal-impacting decisions are
 * read from their own rows, and a pass's gain is measured against the reading
 * the previous pass ended at — never against an empty reading.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems, markShortlisted } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import { recordFeedExtraction } from '../server/services/feeds/run.ts';
import { addFunnelReadings, funnelGain, readFunnel, readStoredFunnel, type FunnelRecord } from '../server/services/knowledge/funnel.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const published = new Date(Date.now() - 2 * 3_600_000).toISOString();
const rec = (id: string): FunnelRecord => ({ id, fingerprint: id });

function rfq(source: string, tag: string, budget: string) {
  return {
    externalId: `${source}-rfq-${tag}`,
    url: `https://example.test/${source}/rfq-${tag}`,
    title: `Request for quotes: packaging film lot ${tag}`,
    body: `Seeking quotes from a supplier. Delivery in Austin, TX by 2026-12-15. Budget ${budget}.`,
    organization: `Buyer ${tag} LLC`,
    publishedAt: published,
  };
}

async function itemIds(source: string): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>('SELECT id FROM feed_items WHERE source = ? ORDER BY id', [source]);
  return rows.map((r) => r.id);
}

async function screen(itemId: string, verdict: 'KEEP' | 'DROP', model: string) {
  await getDb().run(
    `INSERT INTO cheap_results (id, kind, input_hash, subject_id, model, ok, output, error, created_at)
     VALUES (?, 'SCREEN_LEAD', ?, ?, ?, 1, ?, NULL, ?)`,
    [`cr_${Math.random().toString(36).slice(2)}`, `h_${itemId}_${model}`, itemId, model, JSON.stringify({ verdict }), new Date().toISOString()],
  );
}

describe('funnel arithmetic', () => {
  it('adds readings stage by stage and re-reads a stored reading', () => {
    const a = readFunnel({ RAW_INTAKE: [rec('r1')], NORMALIZED_FACTS: [rec('n1')] });
    const b = readFunnel({ RAW_INTAKE: [rec('r2'), rec('r2')], EVIDENCE_ACCEPTED: [rec('e1')], GOAL_DECISIONS: [rec('g1')] });
    const sum = addFunnelReadings(a, b);
    expect(sum.raw).toBe(a.raw + b.raw);
    expect(sum.usableIntelligence).toBe(3);
    expect(sum.excluded.DUPLICATE).toBe(1);
    expect(readStoredFunnel(JSON.parse(JSON.stringify(sum)))).toEqual(sum);
    expect(readStoredFunnel(null)).toBeNull();
    // Against the previous total, a pass that only adds raw intake is false speed.
    const rawOnly = addFunnelReadings(sum, readFunnel({ RAW_INTAKE: [rec('r3')] }));
    expect(funnelGain(sum, rawOnly)).toEqual({ raw: 1, usableIntelligence: 0, falseSpeed: true });
  });
});

describe('recordFeedExtraction reads every funnel stage from its own rows', () => {
  it('evidence accepted and goal decisions come from screens, coverage and shortlists since the previous pass', async () => {
    const source = `f${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'a', '$4,000')]);
    const first = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(first.funnel!.reading.stages.find((s) => s.stage === 'EVIDENCE_ACCEPTED')!.raw).toBe(0);
    expect(first.funnel!.reading.stages.find((s) => s.stage === 'GOAL_DECISIONS')!.raw).toBe(0);
    await tick();

    const [itemA] = await itemIds(source);
    await screen(itemA!, 'DROP', 'm1');
    await screen(itemA!, 'KEEP', 'm2');
    await markShortlisted([itemA!], 'round_test_1');
    await insertFeedItems(source, [rfq(source, 'b', '$9,000')]);
    const itemB = (await itemIds(source)).find((id) => id !== itemA)!;
    await screen(itemB, 'DROP', 'm1');
    await tick();

    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    const stageOf = (name: string) => second.funnel!.reading.stages.find((s) => s.stage === name)!;
    // One evidence record per item: A was kept by a model, B was only dropped and is unverified.
    expect(stageOf('EVIDENCE_ACCEPTED')).toMatchObject({ raw: 2, usable: 1 });
    expect(stageOf('EVIDENCE_ACCEPTED').excluded.UNVERIFIED).toBe(1);
    expect(stageOf('GOAL_DECISIONS')).toMatchObject({ raw: 1, usable: 1 });
    expect(second.funnel!.since).toBeDefined();

    // Gain is against the previous pass's cumulative reading, and the cumulative reading carries both.
    expect(second.funnel!.cumulative.raw).toBe(first.funnel!.cumulative.raw + second.funnel!.reading.raw);
    expect(second.funnel!.gain).toEqual(funnelGain(first.funnel!.cumulative, second.funnel!.cumulative));
    expect(second.funnel!.gain.usableIntelligence).toBe(second.funnel!.reading.usableIntelligence);

    // A third pass with nothing new reads no stage twice: the window starts at the second pass.
    await tick();
    const third = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }));
    if (third) {
      expect(third.funnel!.reading.stages.find((s) => s.stage === 'EVIDENCE_ACCEPTED')!.raw).toBe(0);
      expect(third.funnel!.reading.stages.find((s) => s.stage === 'GOAL_DECISIONS')!.raw).toBe(0);
    }
  });

  it('a pass whose only gain is downstream evidence is not false speed, and raw intake without it is', async () => {
    const source = `f${Math.random().toString(36).slice(2, 8)}`;
    await insertFeedItems(source, [rfq(source, 'a', '$4,000')]);
    await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 });
    await tick();
    // The same record republished: unchanged, nothing parsed again. A screen kept the original meanwhile.
    const [itemA] = await itemIds(source);
    await screen(itemA!, 'KEEP', 'm1');
    await insertFeedItems(source, [{ ...rfq(source, 'a', '$4,000'), externalId: `${source}-rfq-again` }]);
    await tick();
    const second = (await recordFeedExtraction({ projectId, now: new Date(), capacity: 0 }))!;
    expect(second.delta!.counts.UNCHANGED).toBe(1);
    expect(second.facts).toEqual([]);
    expect(second.funnel!.gain.usableIntelligence).toBe(1);
    expect(second.funnel!.gain.falseSpeed).toBe(false);
  });
});
