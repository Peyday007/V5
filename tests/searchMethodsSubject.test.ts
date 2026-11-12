/**
 * A method knows which learned subject it searches for, and methods for one
 * subject are compared on the same data without anyone asking.
 *
 * Before this, no production path set `search_methods.subject_id`: a bucket's
 * method (`methodForBucket`) and its shared GENERAL copy (`shareAsGeneral`)
 * both left it empty, so `compareMethods` — and the CLI `compare` command
 * built on it — refused every real method with "Every compared method must be
 * for the same subject", and nothing compared methods automatically at all.
 * These tests create methods only through the production paths.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import {
  createSearchMethod, getSearchMethod, listMethodComparisons, recordDetectorExample,
} from '../server/repos/searchMethods.ts';
import { learnSubject, lensFor } from '../server/services/knowledge/subjects/subjects.ts';
import { methodForBucket, readerForProject, subjectOfBucket } from '../server/services/research/searchMethods/bucketMethods.ts';
import { compareMethods } from '../server/services/research/searchMethods/compare.ts';
import { shareAsGeneral } from '../server/services/knowledge/scope/share.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { FEED_READER } from '../server/services/feeds/learnedRun.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { getDb } from '../server/db/database.ts';

const item = (id: string, title: string) => ({ externalId: id, url: `https://x.test/${id}`, title, body: null, organization: null, publishedAt: null });

async function learnedLens(projectId: string) {
  const subject = await learnSubject({
    scope: 'PROJECT', projectId, label: 'welding fabricators', kind: 'SUPPLIER', origin: 'harvest', sourceRef: 'claim:test',
  });
  return { subject, bucket: lensFor(subject) };
}

describe('a method is linked to the subject it searches for', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('links a learned-subject lens method to its subject, and leaves a constant bucket unlinked', async () => {
    const { project } = await freshProject();
    const { subject, bucket } = await learnedLens(project.id);
    expect(subjectOfBucket(bucket.id)).toBe(subject.id);
    const method = await methodForBucket(project.id, bucket);
    expect(method.subjectId).toBe(subject.id);
    expect((await getSearchMethod(readerForProject(project.id), method.id))?.subjectId).toBe(subject.id);

    const constant = await methodForBucket(project.id, { id: 'gov-rfps', title: 'Government RFPs' });
    expect(subjectOfBucket('gov-rfps')).toBeNull();
    expect(constant.subjectId).toBeNull();
  });

  it('links a lens method created before methods carried a subject, and never moves a linked one', async () => {
    const { project } = await freshProject();
    const { subject, bucket } = await learnedLens(project.id);
    const old = await createSearchMethod({
      scope: 'PROJECT', projectId: project.id, methodKey: bucket.id, finds: 'x', sources: ['cash discovery round'], checkProcedure: 'c',
    });
    expect(old.subjectId).toBeNull();
    const linked = await methodForBucket(project.id, bucket);
    expect(linked.id).toBe(old.id);
    expect(linked.subjectId).toBe(subject.id);

    await getDb().run('UPDATE search_methods SET subject_id = ? WHERE id = ?', ['other-subject', old.id]);
    expect((await methodForBucket(project.id, bucket)).subjectId).toBe('other-subject');
  });

  it('keeps the subject on a shared GENERAL copy, so the CLI comparison accepts real methods', async () => {
    const { project } = await freshProject();
    const { subject, bucket } = await learnedLens(project.id);
    const reader = readerForProject(project.id);
    const method = await methodForBucket(project.id, bucket);
    const shared = await shareAsGeneral(reader, method.id, { projectIds: [project.id] });
    if (!shared.ok) throw new Error(shared.reason);
    expect(shared.method.subjectId).toBe(subject.id);

    const compared = await compareMethods(reader, {
      subjectId: subject.id,
      items: ['i1', 'i2', 'i3'],
      results: {
        [method.id]: { surfaced: ['i1', 'i2'], confirmed: ['i1'], rejected: ['i2'] },
        [shared.method.id]: { surfaced: ['i1'], confirmed: ['i1'], rejected: [] },
      },
      scope: { scope: 'PROJECT', projectId: project.id },
    });
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.comparison.ranking.map((r) => r.methodId)).toEqual([shared.method.id, method.id]);
  });
});

describe('methods for one subject are compared automatically on the same data', () => {
  beforeEach(async () => {
    await freshProject();
  });

  async function twoMethodsForOneSubject() {
    const subjectId = 'sub-welding';
    const make = (key: string) =>
      createSearchMethod({ scope: 'GENERAL', methodKey: key, subjectId, finds: 'welding fabricators', sources: ['jobs'], checkProcedure: 'judged' });
    const broad = await make('broad');
    const narrow = await make('narrow');
    const a = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'broad', methodId: broad.id, sources: ['jobs'],
      positives: ['Welding role', 'Welding job open', 'Welding position'], negatives: [], threshold: 0.9,
    });
    const b = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'narrow', methodId: narrow.id, sources: ['jobs'],
      positives: ['Welding fabricator needed', 'Fabricator welding trailers', 'Certified welding fabricator'], negatives: [], threshold: 0.9,
    });
    if (!a.ok || !b.ok) throw new Error('setup');
    return { subjectId, broad, narrow, broadDetector: a.detector, narrowDetector: b.detector };
  }

  it('records one comparison per pass with new shared items, ranked by precision, from runDetectors() alone', async () => {
    const s = await twoMethodsForOneSubject();
    await insertFeedItems('jobs', [
      item('a', 'Welding fabricator needed'),
      item('b', 'Welding role in sales'),
      item('c', 'Pastry chef'),
    ]);
    const ids = new Map((await getDb().all<{ id: string; title: string }>('SELECT id, title FROM feed_items')).map((r) => [r.title, r.id]));
    const fab = ids.get('Welding fabricator needed')!;
    const sales = ids.get('Welding role in sales')!;
    // Judged firings: the broad detector's sales hit was wrong; both fabricator hits were right.
    await recordDetectorExample({ detectorId: s.broadDetector.id, itemRef: fab, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    await recordDetectorExample({ detectorId: s.broadDetector.id, itemRef: sales, fired: true, verdict: 'REJECTED', labelledBy: 't' });
    await recordDetectorExample({ detectorId: s.narrowDetector.id, itemRef: fab, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });

    await runDetectors();
    const stored = await listMethodComparisons(FEED_READER, { subjectId: s.subjectId });
    expect(stored).toHaveLength(1);
    const c = stored[0]!;
    expect(c.scope).toBe('GENERAL');
    expect(c.items).toBe(3);
    expect(new Set(c.itemRefs)).toEqual(new Set(ids.values()));
    expect(c.entries.map((e) => e.methodId)).toEqual([s.narrow.id, s.broad.id]);
    expect(c.entries[0]!.precision).toBe(1);
    expect(c.entries[1]!.precision).toBe(0.5);

    // Nothing new: the same items are not compared twice.
    await runDetectors();
    expect(await listMethodComparisons(FEED_READER, { subjectId: s.subjectId })).toHaveLength(1);
  });

  it('compares nothing for a subject with only one method', async () => {
    const lone = await createSearchMethod({ scope: 'GENERAL', methodKey: 'lone', subjectId: 'sub-lone', finds: 'x', sources: ['jobs'], checkProcedure: 'c' });
    const other = await createSearchMethod({ scope: 'GENERAL', methodKey: 'other', subjectId: 'sub-other', finds: 'x', sources: ['jobs'], checkProcedure: 'c' });
    for (const [key, m] of [['lone', lone], ['other', other]] as const) {
      const made = await createDetectorFromExamples({
        scope: 'GENERAL', detectorKey: key, methodId: m.id, sources: ['jobs'],
        positives: ['Welding role', 'Welding job open', 'Welding position'], negatives: [], threshold: 0.9,
      });
      if (!made.ok) throw new Error('setup');
    }
    await insertFeedItems('jobs', [item('a', 'Welding role')]);
    await runDetectors();
    expect(await listMethodComparisons(FEED_READER, {})).toHaveLength(0);
  });
});
