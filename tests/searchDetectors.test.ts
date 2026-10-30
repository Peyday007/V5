import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { recordDetectorExample } from '../server/repos/searchMethods.ts';
import {
  asDetector, createDetectorFromExamples, decideMode, defineFromExamples, routeRecords, settleDetectorMode,
} from '../server/services/feeds/learned.ts';
import type { DetectorRecord } from '../server/services/feeds/detectors.ts';
import type { SearchReader } from '../server/domain/searchIntelligence.ts';

const reader: SearchReader = { projectIds: [], userId: null };
const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
const negatives = ['Sales manager wanted'];
const rec = (id: string, title: string): DetectorRecord => ({
  id, source: 'jobs', url: `https://x/${id}`, title, organization: null, publishedAt: null, fetchedAt: '2026-01-01T00:00:00.000Z',
});

describe('learned detectors', () => {
  beforeEach(async () => {
    await freshProject();
  });

  it('refuses fewer than three positives, or examples that share nothing', () => {
    expect(defineFromExamples({ sources: ['jobs'], positives: positives.slice(0, 2), negatives }).ok).toBe(false);
    expect(defineFromExamples({ sources: ['jobs'], positives: ['alpha one', 'beta two', 'gamma three'], negatives: [] }).ok).toBe(false);
  });

  it('starts in SHADOW from three or more positives and a negative', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'welders', sources: ['jobs'], positives, negatives, threshold: 0.8,
    });
    expect(made.ok && made.detector.mode).toBe('SHADOW');
  });

  it('refuses promotion below the stored precision and allows it above, then demotes on a fall', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'welders2', sources: ['jobs'], positives, negatives, threshold: 0.8,
    });
    if (!made.ok) throw new Error('setup');
    const id = made.detector.id;
    for (let i = 0; i < 3; i++) await recordDetectorExample({ detectorId: id, itemRef: `ok${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    expect((await settleDetectorMode(reader, id)).change).toBe('NONE');
    for (let i = 0; i < 3; i++) await recordDetectorExample({ detectorId: id, itemRef: `bad${i}`, fired: true, verdict: 'REJECTED', labelledBy: 't' });
    const refused = await settleDetectorMode(reader, id);
    expect(refused.change).toBe('NONE');
    expect(refused.mode).toBe('SHADOW');
    expect(refused.reason).toContain('refused');
    for (let i = 0; i < 20; i++) await recordDetectorExample({ detectorId: id, itemRef: `more${i}`, fired: true, verdict: 'CONFIRMED', labelledBy: 't' });
    const promoted = await settleDetectorMode(reader, id);
    expect(promoted).toMatchObject({ change: 'PROMOTED', mode: 'ACTIVE' });
    for (let i = 0; i < 30; i++) await recordDetectorExample({ detectorId: id, itemRef: `worse${i}`, fired: true, verdict: 'REJECTED', labelledBy: 't' });
    expect(await settleDetectorMode(reader, id)).toMatchObject({ change: 'DEMOTED', mode: 'SHADOW' });
  });

  it('does not count examples that did not fire toward precision', () => {
    expect(decideMode({ mode: 'SHADOW', threshold: 0.5 }, { judged: 2, confirmed: 2, rejected: 0, precision: 1 }).change).toBe('NONE');
  });

  it('handles confident items in code, avoids AI jobs, and escalates the unsure ones', async () => {
    const made = await createDetectorFromExamples({
      scope: 'GENERAL', detectorKey: 'welders3', sources: ['jobs'], positives, negatives, threshold: 0.5,
    });
    if (!made.ok) throw new Error('setup');
    const active = { ...made.detector, mode: 'ACTIVE' as const };
    const records = [rec('a', 'Welding fabricator wanted'), rec('b', 'Welding helper'), rec('c', 'Pastry chef')];
    const routed = routeRecords([active], records);
    expect(routed.handled).toEqual(['a']);
    expect(routed.escalate).toEqual(['b']);
    expect(routed.aiJobsAvoided).toBe(1);
    expect(routeRecords([made.detector], records).handled).toEqual([]);
    const rule = asDetector(active);
    expect(rule.detect(records, new Date()).map((s) => s.memberIds[0])).toEqual(['a']);
  });
});
