/**
 * repair-F4-2: a method names the subject it searches, so methods for one
 * subject can be compared — by a person at the terminal, and automatically on
 * identical data by the feeds pass.
 *
 * The finding: no production path set `search_methods.subject_id`, so
 * `compareMethods` refused every real method ("Every compared method must be
 * for the same subject"), and nothing compared two methods on the same data on
 * its own. These tests create methods only through the production paths —
 * `recordRoundAsRun` for a learned-subject lens, `shareAsGeneral`, and the
 * feeds pass's `methodForDetector` / `learnFromScreens` — never with a
 * hand-set subject.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  createLearnedDetector, createSearchMethod, getSearchMethod, linkMethodSubject, listMethodComparisons, recordDetectorExample,
} from '../server/repos/searchMethods.ts';
import {
  FEED_SOURCE_ORIGIN, learnedLensesForProject, learnSubject, lensFor, subjectForFeedSource, subjectIdOfBucket,
} from '../server/services/knowledge/subjects/subjects.ts';
import { methodForBucket, readerForProject, recordRoundAsRun } from '../server/services/research/searchMethods/bucketMethods.ts';
import { shareAsGeneral } from '../server/services/knowledge/scope/share.ts';
import { runSearchCli } from '../server/services/research/searchReport/cli.ts';
import { FEED_READER } from '../server/services/feeds/learnedRun.ts';
import {
  compareDetectorMethods, detectorComparison, linkDetectorMethods, methodForDetector,
} from '../server/services/feeds/learnFromScreens.ts';
import type { DetectorExample } from '../server/domain/searchIntelligence.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
});

const found = { to: 'HARVESTED' as const, missionState: null, found: 3, useful: 2, duplicates: 0 };

describe('a learned-subject lens method names its subject', () => {
  it('recordRoundAsRun links the method to the subject the lens searches', async () => {
    const subject = await learnSubject({ scope: 'PROJECT', projectId, label: 'parcel surveys', kind: 'MARKET', origin: 'harvest', sourceRef: 'claim:c1' });
    const lens = lensFor(subject);
    expect(subjectIdOfBucket(lens.id)).toBe(subject.id);
    const recorded = await recordRoundAsRun(projectId, lens, found);
    expect(recorded?.method.subjectId).toBe(subject.id);
  });

  it('a method written before it carried its subject is linked on its next run, and never re-pointed', async () => {
    const subject = await learnSubject({ scope: 'PROJECT', projectId, label: 'drone mapping', kind: 'MARKET', origin: 'harvest', sourceRef: 'claim:c2' });
    const lens = lensFor(subject);
    // The row as the earlier code wrote it: no subject.
    const legacy = await createSearchMethod({ scope: 'PROJECT', projectId, methodKey: lens.id, finds: 'x', sources: ['cash discovery round'], checkProcedure: 'c' });
    expect(legacy.subjectId).toBeNull();
    const linked = await methodForBucket(projectId, lens);
    expect(linked.id).toBe(legacy.id);
    expect(linked.subjectId).toBe(subject.id);
    // A method that names its subject is never moved to another one.
    expect(await linkMethodSubject(legacy.id, 'lsj_other')).toBe(false);
    expect((await methodForBucket(projectId, lens)).subjectId).toBe(subject.id);
  });

  it('a constant bucket names no subject', async () => {
    expect(subjectIdOfBucket('mechanism-arbitrage')).toBeNull();
    const method = await methodForBucket(projectId, { id: 'mechanism-arbitrage', title: 'Arbitrage' });
    expect(method.subjectId).toBeNull();
  });
});

describe('the terminal compares real methods for one subject', () => {
  it('compares a project lens method with its GENERAL copy and stores the comparison', async () => {
    const subject = await learnSubject({ scope: 'GENERAL', label: 'tree surveys', kind: 'MARKET', origin: 'harvest', sourceRef: 'claim:c3' });
    const lens = lensFor(subject);
    const own = (await recordRoundAsRun(projectId, lens, found))!.method;
    const shared = await shareAsGeneral(readerForProject(projectId), own.id);
    expect(shared.ok).toBe(true);
    const general = (shared as { ok: true; method: { id: string; subjectId: string | null } }).method;
    expect(general.subjectId).toBe(subject.id);

    const file = JSON.stringify({
      items: ['i1', 'i2', 'i3'],
      results: {
        [own.id]: { surfaced: ['i1', 'i2'], confirmed: ['i1'], rejected: ['i2'] },
        [general.id]: { surfaced: ['i1', 'i3'], confirmed: ['i1', 'i3'], rejected: [] },
      },
    });
    const out = await runSearchCli(['compare', '--project', projectId, '--subject', subject.id, '--file', 'r.json'], { readFile: () => file });
    expect(out.out).not.toMatch(/same subject/);
    expect(out.code).toBe(0);
    const stored = await listMethodComparisons(readerForProject(projectId), { subjectId: subject.id });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.entries[0]!.methodId).toBe(general.id);
  });

  it('a GENERAL copy of a method for a private subject does not carry that subject', async () => {
    const subject = await learnSubject({ scope: 'PROJECT', projectId, label: 'hedge trimming', kind: 'MARKET', origin: 'harvest', sourceRef: 'claim:c4' });
    const own = (await recordRoundAsRun(projectId, lensFor(subject), found))!.method;
    const shared = await shareAsGeneral(readerForProject(projectId), own.id);
    expect(shared.ok).toBe(true);
    expect((shared as { ok: true; method: { subjectId: string | null } }).method.subjectId).toBeNull();
  });
});

describe('the feeds pass compares detector methods for one source on identical items', () => {
  const def = (terms: string[]) => ({ sources: ['jobs'], terms });

  it('a detector method names its feed source subject, which is never offered as a discovery lens', async () => {
    const method = await methodForDetector('screen:jobs:survey', def(['survey']));
    const subject = await subjectForFeedSource('jobs');
    expect(method?.subjectId).toBe(subject.id);
    expect(subject.origin).toBe(FEED_SOURCE_ORIGIN);
    expect((await learnedLensesForProject(projectId)).map((l) => l.id)).not.toContain(lensFor(subject).id);
  });

  it('links the subject of a detector method written before methods carried one', async () => {
    const legacy = await createSearchMethod({ scope: 'GENERAL', methodKey: 'screen:jobs:old', finds: 'x', sources: ['jobs'], checkProcedure: 'c' });
    const detector = await createLearnedDetector({ scope: 'GENERAL', detectorKey: 'screen:jobs:old', methodId: legacy.id, definition: def(['old']), threshold: 0.8 });
    await linkDetectorMethods([detector]);
    expect((await getSearchMethod(FEED_READER, legacy.id))?.subjectId).toBe((await subjectForFeedSource('jobs')).id);
  });

  it('records one comparison on the items both were judged on, and none again until the data changes', async () => {
    const m1 = (await methodForDetector('screen:jobs:survey', def(['survey'])))!;
    const m2 = (await methodForDetector('screen:jobs:mapping', def(['mapping'])))!;
    const d1 = await createLearnedDetector({ scope: 'GENERAL', detectorKey: 'screen:jobs:survey', methodId: m1.id, definition: def(['survey']), threshold: 0.8 });
    const d2 = await createLearnedDetector({ scope: 'GENERAL', detectorKey: 'screen:jobs:mapping', methodId: m2.id, definition: def(['mapping']), threshold: 0.8 });
    const label = (detectorId: string, itemRef: string, fired: boolean, verdict: 'CONFIRMED' | 'REJECTED') =>
      recordDetectorExample({ detectorId, itemRef, fired, verdict, labelledBy: 'test' });
    await label(d1.id, 'a', true, 'CONFIRMED');
    await label(d1.id, 'b', true, 'REJECTED');
    await label(d1.id, 'c', false, 'CONFIRMED');
    await label(d1.id, 'only1', true, 'CONFIRMED'); // not judged for d2: not shared data
    await label(d2.id, 'a', true, 'CONFIRMED');
    await label(d2.id, 'b', false, 'REJECTED');
    await label(d2.id, 'c', true, 'CONFIRMED');

    expect(await compareDetectorMethods([d1, d2])).toBe(1);
    const subjectId = (await subjectForFeedSource('jobs')).id;
    const [stored] = await listMethodComparisons(FEED_READER, { subjectId });
    expect(stored!.scope).toBe('GENERAL');
    expect([...stored!.itemRefs].sort()).toEqual(['a', 'b', 'c']);
    expect(stored!.entries[0]!.methodId).toBe(m2.id); // 2/2 against 1/2
    expect(stored!.entries[0]!.precision).toBe(1);
    expect(stored!.entries[1]!.precision).toBe(0.5);

    expect(await compareDetectorMethods([d1, d2])).toBe(0);
    await label(d1.id, 'd', true, 'CONFIRMED');
    await label(d2.id, 'd', true, 'REJECTED');
    expect(await compareDetectorMethods([d1, d2])).toBe(1);
  });

  it('detectorComparison needs two methods and a shared item', () => {
    const ex = (itemRef: string): DetectorExample => ({ id: itemRef, detectorId: 'd', itemRef, fired: true, verdict: 'CONFIRMED', labelledBy: 't', createdAt: '2026-01-01' });
    expect(detectorComparison('s', new Map([['m1', [ex('a')]]]))).toBeNull();
    expect(detectorComparison('s', new Map([['m1', [ex('a')]], ['m2', [ex('b')]]]))).toBeNull();
    expect(detectorComparison('s', new Map([['m1', [ex('a')]], ['m2', [ex('a')]]]))?.items).toEqual(['a']);
  });
});
