/**
 * Learned detectors, walked from the feed run's own entry point.
 *
 * Russell's feeds pass calls `runDetectors()` with no arguments. Before this,
 * that call ran only the code constants, so a learned detector could be
 * promoted and fire only in a test that called `settleDetectorMode` and
 * `asDetector` itself. These tests call nothing but `runDetectors()` and read
 * the rows it leaves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { recordDetectorExample } from '../server/repos/searchMethods.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { coveredItems, runDetectors } from '../server/services/feeds/detectors.ts';
import { getDb } from '../server/db/database.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

describe('a learned detector, walked from runDetectors()', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('files nothing while SHADOW, then covers items once measured precision promotes it', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'walk-welders', sources: ['jobs'], positives, negatives: ['Sales manager wanted'], threshold: 0.5,
    });
    if (!made.ok) throw new Error('setup');
    await insertFeedItems('jobs', [item('a', 'Welding fabricator wanted'), item('b', 'Pastry chef')]);
    const ids = (await getDb().all<{ id: string }>('SELECT id FROM feed_items')).map((r) => r.id);

    const shadow = await runDetectors();
    expect(shadow.some((r) => r.rule.startsWith('learned:walk-welders') && r.signals === 1)).toBe(true);
    expect((await coveredItems(ids)).size).toBe(0);

    for (let i = 0; i < 6; i++) {
      await recordDetectorExample({ detectorId: made.detector.id, itemRef: `ok${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    }
    await runDetectors();
    const mode = await getDb().get<{ mode: string }>('SELECT mode FROM learned_detectors WHERE id = ?', [made.detector.id]);
    expect(mode?.mode).toBe('ACTIVE');
    expect((await coveredItems(ids)).size).toBe(1);
  });

  it('demotes an ACTIVE detector whose judged precision falls, and stops covering', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'walk-falls', sources: ['jobs'], positives, negatives: [], threshold: 0.8,
    });
    if (!made.ok) throw new Error('setup');
    for (let i = 0; i < 5; i++) {
      await recordDetectorExample({ detectorId: made.detector.id, itemRef: `ok${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    }
    await runDetectors();
    expect((await getDb().get<{ mode: string }>('SELECT mode FROM learned_detectors WHERE id = ?', [made.detector.id]))?.mode).toBe('ACTIVE');
    for (let i = 0; i < 5; i++) {
      await recordDetectorExample({ detectorId: made.detector.id, itemRef: `bad${i}`, fired: true, verdict: 'REJECTED', labelledBy: 't' });
    }
    await insertFeedItems('jobs', [item('c', 'Welding fabricator wanted')]);
    await runDetectors();
    expect((await getDb().get<{ mode: string }>('SELECT mode FROM learned_detectors WHERE id = ?', [made.detector.id]))?.mode).toBe('SHADOW');
    const ids = (await getDb().all<{ id: string }>('SELECT id FROM feed_items')).map((r) => r.id);
    expect((await coveredItems(ids)).size).toBe(0);
  });

  it("never runs a project's private detector over shared feed items", async () => {
    const fixture = await freshProject();
    const made = await createDetectorFromExamples({
      scope: 'PROJECT', projectId: fixture.project.id, detectorKey: 'private-welders', sources: ['jobs'], positives, negatives: [], threshold: 0.5,
    });
    if (!made.ok) throw new Error('setup');
    await insertFeedItems('jobs', [item('p', 'Welding fabricator wanted')]);
    const reports = await runDetectors();
    expect(reports.some((r) => r.rule.includes('private-welders'))).toBe(false);
  });
});
