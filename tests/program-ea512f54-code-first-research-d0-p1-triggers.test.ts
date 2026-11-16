/**
 * A trigger's search is composed by code from what Brain already holds, and a
 * model-written prompt is used only where nothing is held. The gate and the
 * switch are untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import {
  CODE_COMPOSED_TRIGGERS,
  TRIGGER_BUCKETS,
  TRIGGER_MAX_SUBJECTS,
  composeTriggerQuestion,
  triggerBucketsFor,
  triggerQuery,
  triggersEnabled,
} from '../server/services/cash/triggers.ts';

const now = new Date();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY).toISOString();
const dayAhead = (n: number) => new Date(now.getTime() + n * DAY).toISOString().slice(0, 10);
const bucket = (id: string) => TRIGGER_BUCKETS.find((one) => one.id === id)!;

beforeEach(async () => {
  await freshProject();
});

describe('with nothing stored', () => {
  it('every trigger falls back to its own question, unchanged', async () => {
    for (const one of TRIGGER_BUCKETS) {
      const query = await triggerQuery(one, now);
      expect(query).toMatchObject({ origin: 'PROMPT', subjects: [], question: one.question });
    }
    const buckets = await triggerBucketsFor(now);
    expect(buckets).toEqual([...TRIGGER_BUCKETS]);
  });

  it('a bucket with no deterministic source keeps its question even when rows exist', async () => {
    await insertFeedItems('remoteok', [{ externalId: 'a', url: 'https://remoteok.test/a', title: 'Data Entry Clerk', body: null, organization: 'Acme', publishedAt: daysAgo(60) }]);
    expect(CODE_COMPOSED_TRIGGERS).not.toContain('trigger-review-complaint');
    expect((await triggerQuery(bucket('trigger-review-complaint'), now)).origin).toBe('PROMPT');
  });
});

describe('composed by code from stored rows', () => {
  it('a stale job post names the business, the event, its date and its source', async () => {
    await insertFeedItems('remoteok', [
      { externalId: 'a', url: 'https://remoteok.test/a', title: 'Data Entry Clerk', body: null, organization: 'Acme', publishedAt: daysAgo(60) },
      { externalId: 'b', url: 'https://remoteok.test/b', title: 'Data Entry Clerk', body: null, organization: 'Fresh Co', publishedAt: daysAgo(3) },
      { externalId: 'c', url: 'https://remoteok.test/c', title: 'Report Writer', body: null, organization: 'ACME', publishedAt: daysAgo(70) },
    ]);
    const query = await triggerQuery(bucket('trigger-stale-job-post'), now);
    expect(query.origin).toBe('CODE');
    expect(query.subjects).toHaveLength(1);
    expect(query.subjects[0]).toMatchObject({ name: 'Acme', url: 'https://remoteok.test/a', date: daysAgo(60).slice(0, 10) });
    expect(query.question).toContain('Acme');
    expect(query.question).toContain('https://remoteok.test/a');
    expect(query.question).not.toContain('Fresh Co');
    expect(query.question).not.toBe(bucket('trigger-stale-job-post').question);
  });

  it('a rule taking effect soon is named with its date; one far off or past is not', async () => {
    await insertFeedItems('federal-register-rules', [
      { externalId: 'r1', url: 'https://fr.test/r1', title: 'Labeling Rule', body: `Abstract. Effective ${dayAhead(20)}.`, organization: 'Food and Drug Administration', publishedAt: daysAgo(2) },
      { externalId: 'r2', url: 'https://fr.test/r2', title: 'Far Rule', body: `Effective ${dayAhead(300)}.`, organization: 'EPA', publishedAt: daysAgo(2) },
      { externalId: 'r3', url: 'https://fr.test/r3', title: 'No Date Rule', body: 'Abstract only.', organization: 'EPA', publishedAt: daysAgo(2) },
    ]);
    const query = await triggerQuery(bucket('trigger-new-rule'), now);
    expect(query.origin).toBe('CODE');
    expect(query.subjects.map((one) => one.name)).toEqual(['Labeling Rule']);
    expect(query.question).toContain(dayAhead(20));
    expect(query.question).toContain('Food and Drug Administration');
  });

  it('a stored sales-hiring detection seeds the funded-hiring trigger with the named employer', async () => {
    await insertFeedItems('remoteok', [{ externalId: 's1', url: 'https://remoteok.test/s1', title: 'Account Executive', body: null, organization: 'Globex Inc', publishedAt: daysAgo(2) }]);
    const item = await getDb().get<{ id: string }>(`SELECT id FROM feed_items WHERE external_id = 's1'`);
    await getDb().run(
      `INSERT INTO feed_detections (id, rule_id, rule_version, group_key, label, entity_key, category, window_from, window_to,
         member_ids, source_urls, qualifiers, hypothesis, mode, detected_at, updated_at)
       VALUES ('fdt-1', 'CONCENTRATED_HIRING', 1, 'globex|SALES|x', '3 distinct sales job titles', 'globex', 'SALES', ?, ?, ?, ?, '[]', NULL, 'ACTIVE', ?, ?)`,
      [daysAgo(5), daysAgo(1), JSON.stringify([item!.id]), JSON.stringify(['https://remoteok.test/s1']), now.toISOString(), now.toISOString()],
    );
    const query = await triggerQuery(bucket('trigger-funded-hiring-sales'), now);
    expect(query.origin).toBe('CODE');
    expect(query.subjects[0]).toMatchObject({ name: 'Globex Inc', url: 'https://remoteok.test/s1' });
  });

  it('the composed bucket keeps its id, mechanism and deliverable, so rounds and the scoreboard read it unchanged', async () => {
    await insertFeedItems('remoteok', [{ externalId: 'a', url: 'https://remoteok.test/a', title: 'Data Entry Clerk', body: null, organization: 'Acme', publishedAt: daysAgo(60) }]);
    const buckets = await triggerBucketsFor(now);
    const stale = buckets.find((one) => one.id === 'trigger-stale-job-post')!;
    const original = bucket('trigger-stale-job-post');
    expect({ ...stale, question: '' }).toEqual({ ...original, question: '' });
    expect(stale.question).toContain('Acme');
    expect(buckets.map((one) => one.id)).toEqual(TRIGGER_BUCKETS.map((one) => one.id));
  });

  it('is deterministic and bounded', () => {
    const subjects = Array.from({ length: 3 }, (_, i) => ({ name: `B${i}`, event: 'e', date: '2026-11-01', url: `https://x.test/${i}` }));
    const one = bucket('trigger-stale-job-post');
    expect(composeTriggerQuestion(one, subjects)).toBe(composeTriggerQuestion(one, subjects));
    expect(composeTriggerQuestion(one, subjects)).toMatch(/published, dated source/);
    expect(TRIGGER_MAX_SUBJECTS).toBeGreaterThan(0);
  });
});

describe('the switch is unchanged', () => {
  it('reads the same environment as before', () => {
    expect(triggersEnabled({ BRAIN_TRIGGERS: 'off', BRAIN_CHEAP_LLM_URL: 'x' })).toBe(false);
    expect(triggersEnabled({ BRAIN_TRIGGERS: 'on' })).toBe(true);
    expect(triggersEnabled({ BRAIN_CHEAP_LLM_URL: 'http://x' })).toBe(true);
    expect(triggersEnabled({})).toBe(false);
  });
});
