/**
 * A failing search method, stopped by the feed run itself.
 *
 * `decideMethod` said PAUSE in a unit test, but no production path recorded a
 * method's runs or asked it before running, so a failing method could never be
 * stopped. These tests call only `runDetectors()` — the feeds pass's entry —
 * and read the method's runs and the detections it leaves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createSearchMethod, listMethodRuns } from '../server/repos/searchMethods.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { FEED_READER } from '../server/services/feeds/learnedRun.ts';
import { FAILURE_STREAK } from '../server/services/research/searchFailures/index.ts';
import { getDb } from '../server/db/database.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
let n = 0;
const item = (title: string) => {
  n += 1;
  return { externalId: `w${n}`, url: `https://x.test/w${n}`, title, body: null, organization: null, publishedAt: null };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function methodWithDetector(key: string) {
  const method = await createSearchMethod({
    scope: 'GENERAL', methodKey: key, finds: 'employers hiring welders', sources: ['jobs'],
    checkProcedure: 'the title names welding fabrication',
  });
  const made = await createDetectorFromExamples({
    scope: 'GENERAL', methodId: method.id, detectorKey: `${key}-det`, sources: ['jobs'], positives, negatives: [], threshold: 0.8,
  });
  if (!made.ok) throw new Error('setup');
  return method;
}

describe('a failing method, walked from runDetectors()', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('records each pass over new items as a CODE run, FOUND or NOTHING_SUITABLE, and nothing when nothing is new', async () => {
    const method = await methodWithDetector('walk-found');
    await insertFeedItems('jobs', [item('Welding fabricator wanted'), item('Pastry chef')]);
    await runDetectors();
    await runDetectors(); // nothing new: nothing searched, nothing recorded
    await tick();
    await insertFeedItems('jobs', [item('Barista')]);
    await runDetectors();
    const runs = await listMethodRuns(FEED_READER, method.id);
    expect(runs.map((r) => [r.executor, r.outcome, r.examined, r.surfaced])).toEqual([
      ['CODE', 'FOUND', 2, 1],
      ['CODE', 'NOTHING_SUITABLE', 1, 0],
    ]);
  });

  it('holds the detector back once its method keeps finding nothing, instead of rerunning it', async () => {
    const method = await methodWithDetector('walk-empty');
    for (let i = 0; i < FAILURE_STREAK; i++) {
      await tick();
      await insertFeedItems('jobs', [item(`Pastry chef ${i}`)]);
      const reports = await runDetectors();
      expect(reports.some((r) => r.rule.startsWith('learned:walk-empty-det'))).toBe(true);
    }
    expect((await listMethodRuns(FEED_READER, method.id)).every((r) => r.outcome === 'NOTHING_SUITABLE')).toBe(true);

    // Paused: a matching item arrives, and the pass neither runs the detector nor records a run.
    await tick();
    await insertFeedItems('jobs', [item('Welding fabricator wanted now')]);
    const reports = await runDetectors();
    expect(reports.some((r) => r.rule.startsWith('learned:walk-empty-det'))).toBe(false);
    expect(await listMethodRuns(FEED_READER, method.id)).toHaveLength(FAILURE_STREAK);
    const detections = await getDb().get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM feed_detections WHERE rule_id = 'learned:walk-empty-det'",
    );
    expect(Number(detections?.n ?? 0)).toBe(0);
  });
});
