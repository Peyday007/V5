import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { recordDetectorExample } from '../server/repos/searchMethods.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { coveredItems, runDetectors } from '../server/services/feeds/detectors.ts';
import { getDb } from '../server/db/database.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

describe('a learned detector, walked from the feed run entry point', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('runDetectors() files nothing for a SHADOW detector, then covers items once measured precision promotes it', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'walk-welders', sources: ['jobs'], positives, negatives: ['Sales manager wanted'], threshold: 0.5,
    });
    if (!made.ok) throw new Error('setup');
    await insertFeedItems('jobs', [item('a', 'Welding fabricator wanted'), item('b', 'Pastry chef')]);
    const ids = (await getDb().all<{ id: string }>('SELECT id FROM feed_items')).map((r) => r.id);

    // SHADOW: measured, but nothing is covered.
    await runDetectors();
    expect((await coveredItems(ids)).size).toBe(0);

    // Judged firings accumulate; the real run settles the mode itself.
    for (let i = 0; i < 25; i++) {
      await recordDetectorExample({ detectorId: made.detector.id, itemRef: `ok${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    }
    const reports = await runDetectors();
    expect(reports.some((r) => r.rule.startsWith('learned:walk-welders'))).toBe(true);
    const covered = await coveredItems(ids);
    expect(covered.size).toBe(1); // only the welding item, handled in code
    const mode = await getDb().get<{ mode: string }>('SELECT mode FROM learned_detectors WHERE id = ?', [made.detector.id]);
    expect(mode?.mode).toBe('ACTIVE');
  });

  it("a project's private detector never files a shared detection", async () => {
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
