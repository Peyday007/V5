/**
 * ALGO-16-1 item 5, repair R3-F5: "send work to an LLM only when rules cannot
 * reliably interpret an ambiguous source ... Batch related facts when
 * practical." The extractor's needsModel batches are asked about whole — one
 * call per batch and model — not reordered and then asked record by record.
 * A batch answer is only a screen: every gate after it is the per-record one,
 * and a post a batch left unanswered is still asked on its own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { getDb } from '../server/db/database.ts';
import {
  BATCH_ROW_PREFIX,
  leadBatches,
  leadBatchPrompt,
  parseLeadBatch,
  recordFeedExtraction,
  screenFeedLeads,
  screeningEconomy,
  SCREEN_LEAD_BATCH_KIND,
} from '../server/services/feeds/run.ts';
import { MODEL_BATCH_SIZE } from '../server/services/feeds/extract.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import type { Completer, LaneConfig } from '../server/services/cheap/lane.ts';

let projectId = '';
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString();
const config: LaneConfig = { url: 'http://cheap.test/v1', key: null, models: ['m1', 'm2'], dailyBudget: 1000, timeoutMs: 1000 };
const drop = { verdict: 'DROP', window: 'UNKNOWN', deliverable: 'NONE', need: '', payer: '', reason: 'nothing to sell' };
const dropText = JSON.stringify(drop);

const vague = (i: number) => ({
  id: `v${i}`,
  source: 'any',
  url: `https://example.test/v${i}`,
  title: `Musing number ${i}`,
  body: 'Something is happening and nobody knows what.',
  organization: null,
  publishedAt: hoursAgo(2),
  fetchedAt: hoursAgo(1),
});

/** Answers a batch prompt per post, and a single prompt with one answer. */
function answering(asked: string[], skip: (title: string) => boolean = () => false): Completer {
  return async (_c, _model, _system, prompt) => {
    asked.push(prompt);
    if (!prompt.includes('{"answers"')) return dropText;
    const posts = prompt.split(/\nPost \d+:\n/).slice(1);
    return JSON.stringify({
      answers: posts.flatMap((post, i) => (skip(/Title: (.*)/.exec(post)?.[1] ?? '') ? [] : [{ post: i + 1, ...drop }])),
    });
  };
}

async function seedVague(source: string, n: number): Promise<void> {
  await insertFeedItems(
    source,
    Array.from({ length: n }, (_, i) => ({
      externalId: `${source}-${i}`,
      url: `https://example.test/${source}/${i}`,
      title: `Musing number ${i} from ${source}`,
      body: 'Something is happening and nobody knows what.',
      organization: null,
      publishedAt: hoursAgo(3),
    })),
  );
}

describe('the batch question and its answer (pure)', () => {
  it('leadBatches is the extractor needsModel batches of two or more', () => {
    const items = Array.from({ length: MODEL_BATCH_SIZE + 3 }, (_, i) => vague(i));
    expect(leadBatches(items, now).map((b) => b.length)).toEqual([MODEL_BATCH_SIZE, 3]);
    expect(leadBatches([vague(0)], now)).toEqual([]);
    const readable = { ...vague(99), title: 'Request for quotes: 500 kg of film', body: 'Seeking quotes from a supplier in Austin, TX. Budget $4,000.', organization: 'Acme' };
    expect(leadBatches([readable, vague(1), vague(2)], now).flat().map((one) => one.id)).toEqual(['v1', 'v2']);
  });

  it('asks the per-record question once, about every post, numbered', () => {
    const prompt = leadBatchPrompt([vague(1), vague(2), vague(3)]);
    expect(prompt.match(/Does this post show/g)).toHaveLength(1);
    expect(prompt).toContain('Post 1:\nSource: any\nTitle: Musing number 1');
    expect(prompt).toContain('Post 3:');
    expect(prompt).toContain('3 in all');
  });

  it('validates each post as the per-record screen does, and guesses none', () => {
    const answers = parseLeadBatch(
      JSON.stringify({
        answers: [
          { post: 1, ...drop },
          { post: 2, verdict: 'MAYBE', window: 'UNKNOWN', deliverable: 'NONE', need: '', payer: '', reason: '' },
          { post: 3, ...drop },
          { post: 3, ...drop, verdict: 'KEEP' },
          { post: 9, ...drop },
          { post: '4', ...drop, extra: 'x' },
        ],
      }),
      5,
    );
    expect([...answers.keys()]).toEqual([1]);
    expect(parseLeadBatch(dropText, 3).size).toBe(0);
    expect(parseLeadBatch('not json', 3).size).toBe(0);
  });
});

describe('the screen pass sends needsModel batches as batches', () => {
  it('23 unreadable records cost one call per batch and model, not one per record', async () => {
    const source = `b${Math.random().toString(36).slice(2, 8)}`;
    await seedVague(source, MODEL_BATCH_SIZE + 3);
    const asked: string[] = [];
    const before = new Date(now.getTime() - 60_000).toISOString();
    const screened = await screenFeedLeads({ now, config, completer: answering(asked) });
    expect(screened).toBe(MODEL_BATCH_SIZE + 3);
    // Two batches (20 + 3), two models: four calls, every one a batch.
    expect(asked).toHaveLength(2 * config.models.length);
    expect(asked.every((p) => p.includes('{"answers"'))).toBe(true);
    // Every record has an answer from each model, under the per-record screen's own row kind.
    const rows = await getDb().all<{ id: string; subject_id: string }>(
      `SELECT r.id, r.subject_id FROM cheap_results r JOIN feed_items f ON f.id = r.subject_id
        WHERE r.kind = 'SCREEN_LEAD' AND f.source = ?`,
      [source],
    );
    expect(rows).toHaveLength((MODEL_BATCH_SIZE + 3) * config.models.length);
    expect(rows.every((row) => row.id.startsWith(BATCH_ROW_PREFIX))).toBe(true);
    // The reading counts calls actually made: a batch is one call, however many it answered.
    const reading = await screeningEconomy({ since: before, until: new Date(now.getTime() + 60_000).toISOString() });
    expect(reading.screenCalls).toBe(asked.length);
    expect(reading.batchCalls).toBe(asked.length);
    expect(reading.itemsScreened).toBeGreaterThanOrEqual(MODEL_BATCH_SIZE + 3);
    // A second pass asks nothing: they are answered.
    await screenFeedLeads({ now, config, completer: answering(asked) });
    expect(asked).toHaveLength(2 * config.models.length);
  });

  it('a post a batch left unanswered is asked on its own; nothing is dropped', async () => {
    const source = `u${Math.random().toString(36).slice(2, 8)}`;
    await seedVague(source, 4);
    const asked: string[] = [];
    await screenFeedLeads({ now, config, completer: answering(asked, (title) => title.startsWith('Musing number 2 ')) });
    const batch = asked.filter((p) => p.includes('{"answers"'));
    const single = asked.filter((p) => !p.includes('{"answers"'));
    expect(batch).toHaveLength(config.models.length);
    expect(single).toHaveLength(config.models.length);
    expect(single.every((p) => p.includes(`Musing number 2 from ${source}`))).toBe(true);
    const batchRows = await getDb().all<{ ok: number; error: string | null }>(
      `SELECT ok, error FROM cheap_results WHERE kind = ? ORDER BY created_at`,
      [SCREEN_LEAD_BATCH_KIND],
    );
    expect(batchRows.length).toBeGreaterThanOrEqual(config.models.length);
    expect(batchRows.some((row) => row.ok === 1 && (row.error ?? '').startsWith('answered 3 of 4'))).toBe(true);
  });

  it('a batch call that fails is counted as a call, and every record is still asked on its own', async () => {
    const source = `f${Math.random().toString(36).slice(2, 8)}`;
    await seedVague(source, 3);
    const asked: string[] = [];
    const before = new Date(now.getTime() - 60_000).toISOString();
    const completer: Completer = async (_c, _m, _s, prompt) => {
      asked.push(prompt);
      if (prompt.includes('{"answers"')) throw new Error('provider refused');
      return dropText;
    };
    expect(await screenFeedLeads({ now, config, completer })).toBe(3);
    expect(asked.filter((p) => p.includes('{"answers"'))).toHaveLength(config.models.length);
    expect(asked.filter((p) => !p.includes('{"answers"'))).toHaveLength(3 * config.models.length);
    const reading = await screeningEconomy({ since: before, until: new Date(now.getTime() + 60_000).toISOString() });
    expect(reading.screenCalls).toBe(asked.length);
  });

  it('the extraction row says what the screen does with its batches', async () => {
    const source = `e${Math.random().toString(36).slice(2, 8)}`;
    await seedVague(source, 3);
    const pass = await recordFeedExtraction({ projectId, now });
    expect(pass?.needsModel.flat().length).toBeGreaterThanOrEqual(3);
    const rows = await cashEventsOfKindInProject(projectId, 'FEED_EXTRACTION');
    expect(rows[0]!.summary).toContain('one call per batch and model');
    expect(rows[0]!.summary).not.toContain('sent to the free-model screen first');
  });
});
